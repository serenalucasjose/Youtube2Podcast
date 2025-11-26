const youtubedl = require('youtube-dl-exec');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const webPush = require('web-push');

// Configure web-push (may already be configured in index.js, but safe to set again)
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    try {
        webPush.setVapidDetails(
            process.env.VAPID_SUBJECT || 'mailto:admin@youtube2podcast.local',
            process.env.VAPID_PUBLIC_KEY,
            process.env.VAPID_PRIVATE_KEY
        );
    } catch (e) {
        // Already configured, ignore
    }
}

const DOWNLOADS_DIR = path.join(__dirname, '../downloads');
const TEMP_DIR = path.join(DOWNLOADS_DIR, 'temp');

// Ensure directories exist
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR);
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

const EventEmitter = require('events');
const progressEmitter = new EventEmitter();
progressEmitter.setMaxListeners(50);

// Configuration
const MAX_RETRIES = 1;
const RETRY_DELAY_MS = 2000;

// Helper for logs
const logError = (message, error) => {
    if (process.env.ENABLE_LOGS === 'true') {
        console.error(message, error);
    }
};

const logInfo = (message) => {
    if (process.env.ENABLE_LOGS === 'true') {
        console.log(message);
    }
};

// Cleanup temp files for a specific videoId (async version)
async function cleanupTempFiles(videoId) {
    try {
        const files = await fs.promises.readdir(TEMP_DIR);
        const deletePromises = files
            .filter(f => f.startsWith(videoId))
            .map(async f => {
                const filePath = path.join(TEMP_DIR, f);
                try {
                    await fs.promises.unlink(filePath);
                    logInfo(`Cleaned up temp file: ${filePath}`);
                } catch (e) {
                    logError(`Failed to delete temp file ${filePath}:`, e);
                }
            });
        await Promise.all(deletePromises);
    } catch (e) {
        logError('Error reading temp directory for cleanup:', e);
    }
}

// Cleanup final output file if it exists (partial/corrupted) - async version
async function cleanupOutputFile(videoId) {
    const outputPath = path.join(DOWNLOADS_DIR, `${videoId}.mp3`);
    try {
        await fs.promises.unlink(outputPath);
        logInfo(`Cleaned up output file: ${outputPath}`);
    } catch (e) {
        if (e.code !== 'ENOENT') {
            logError(`Failed to delete output file ${outputPath}:`, e);
        }
        // ENOENT = file doesn't exist, which is fine
    }
}

// Sleep helper for retry delay
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function processVideo(url, userId) {
    // 1. Get Metadata (Blocking part - fast)
    let metadata;
    try {
        progressEmitter.emit('progress', { status: 'fetching_metadata', percent: 10 });
        logInfo(`Processing URL: ${url}`);

        metadata = await youtubedl(url, {
            dumpSingleJson: true,
            noCheckCertificates: true,
            noWarnings: true,
            preferFreeFormats: true,
            addHeader: ['referer:youtube.com', 'user-agent:googlebot'],
        });

        const videoId = metadata.id;
        const title = metadata.title;
        const thumbnail_url = metadata.thumbnail;

        // Check if exists
        const existingEpisode = db.getEpisodeByYoutubeId(videoId);
        if (existingEpisode) {
            progressEmitter.emit('progress', { status: 'done', percent: 100 });
            return existingEpisode;
        }

        // Insert into DB immediately as 'processing'
        const episode = {
            youtube_id: videoId,
            title: title,
            file_path: null, // Not ready yet
            original_url: url,
            user_id: userId,
            status: 'processing',
            thumbnail_url: thumbnail_url
        };

        try {
            db.addEpisode(episode);
        } catch (e) {
            const e2 = db.getEpisodeByYoutubeId(videoId);
            if (e2) return e2;
            throw e;
        }

        // Start background process with retry logic
        performDownloadWithRetry(url, videoId).catch(async err => {
            logError('Background download failed after retries:', err);
            // Final cleanup on complete failure (async)
            await cleanupTempFiles(videoId);
            await cleanupOutputFile(videoId);
            db.updateEpisodeStatus(videoId, 'error');
            progressEmitter.emit('progress', { videoId, status: 'error', message: err.message });
            
            // Send push notification for error
            const failedEpisode = db.getEpisodeByYoutubeId(videoId);
            if (failedEpisode && failedEpisode.user_id) {
                sendPushNotification(failedEpisode.user_id, failedEpisode.title || 'Video', false);
            }
        });

        // Return immediately so UI can show the card
        return episode;

    } catch (error) {
        logError('Error fetching metadata:', error);
        progressEmitter.emit('progress', { status: 'global_error', message: error.message });
        throw error;
    }
}

async function performDownloadWithRetry(url, videoId) {
    let lastError;
    
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            if (attempt > 0) {
                logInfo(`Retry attempt ${attempt} for ${videoId}`);
                progressEmitter.emit('progress', { 
                    videoId, 
                    status: 'retrying', 
                    attempt, 
                    percent: 25 
                });
                await sleep(RETRY_DELAY_MS);
            }
            
            await performDownload(url, videoId);
            return; // Success, exit retry loop
            
        } catch (error) {
            lastError = error;
            logError(`Download attempt ${attempt + 1} failed for ${videoId}:`, error);
            
            // Cleanup before retry or final failure (async)
            await cleanupTempFiles(videoId);
            await cleanupOutputFile(videoId);
        }
    }
    
    // All retries exhausted
    throw lastError;
}

async function performDownload(url, videoId) {
    const outputFileName = `${videoId}.mp3`;
    const finalPath = path.join(DOWNLOADS_DIR, outputFileName);

    progressEmitter.emit('progress', { videoId, status: 'downloading_audio', percent: 30 });
    
    // Cleanup any previous temp files for this video (async)
    await cleanupTempFiles(videoId);

    // Use yt-dlp's native capabilities for optimal performance:
    // - Extract audio directly to MP3
    // - Embed thumbnail automatically (yt-dlp handles WebP conversion internally)
    // - Add metadata
    // - Use concurrent fragments for faster downloads (especially for long videos)
    await youtubedl(url, {
        extractAudio: true,
        audioFormat: 'mp3',
        audioQuality: 2, // VBR quality (0=best, 9=worst), 2 is good balance
        output: finalPath,
        noCheckCertificates: true,
        forceIpv4: true,
        // Embed thumbnail directly into the MP3 (yt-dlp handles format conversion)
        embedThumbnail: true,
        // Add metadata (title, artist, etc.)
        addMetadata: true,
        // Concurrent fragment downloads for faster speed on long videos
        concurrentFragments: 4,
        // Convert thumbnail to jpg for ID3 compatibility (yt-dlp feature)
        convertThumbnails: 'jpg',
        // Postprocessor args to ensure proper ID3 tags
        postprocessorArgs: 'ffmpeg:-id3v2_version 3',
    });

    // Verify the file was created and has content (single stat call)
    try {
        const stats = await fs.promises.stat(finalPath);
        if (stats.size < 1000) { // Less than 1KB is suspicious
            throw new Error('Output file appears to be corrupted (too small)');
        }
    } catch (err) {
        if (err.code === 'ENOENT') {
            throw new Error('Output file was not created');
        }
        throw err;
    }

    // Update DB
    db.updateEpisodeStatus(videoId, 'ready', outputFileName);
    progressEmitter.emit('progress', { videoId, status: 'done', percent: 100 });
    logInfo(`Download and conversion complete for ${videoId}`);
    
    // Send push notification
    const episode = db.getEpisodeByYoutubeId(videoId);
    if (episode && episode.user_id) {
        sendPushNotification(episode.user_id, episode.title, true);
    }
}

/**
 * Envía notificación push al usuario cuando finaliza la descarga.
 * @param {number} userId - ID del usuario.
 * @param {string} title - Título del episodio.
 * @param {boolean} success - Si la descarga fue exitosa.
 */
async function sendPushNotification(userId, title, success) {
    if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
        logInfo('Push notifications not configured, skipping...');
        return;
    }
    
    try {
        const subscriptions = db.getPushSubscriptionsByUserId(userId);
        
        if (!subscriptions || subscriptions.length === 0) {
            logInfo(`No push subscriptions for user ${userId}`);
            return;
        }
        
        const payload = JSON.stringify({
            title: success ? '¡Podcast listo!' : 'Error en descarga',
            body: success 
                ? `"${title}" está listo para escuchar` 
                : `Error al procesar "${title}"`,
            icon: '/icons/logo.png',
            tag: 'download-complete',
            url: '/'
        });
        
        for (const sub of subscriptions) {
            const pushSubscription = {
                endpoint: sub.endpoint,
                keys: {
                    auth: sub.keys_auth,
                    p256dh: sub.keys_p256dh
                }
            };
            
            try {
                await webPush.sendNotification(pushSubscription, payload);
                logInfo(`Push notification sent to user ${userId}`);
            } catch (err) {
                if (err.statusCode === 410 || err.statusCode === 404) {
                    // Subscription expired or invalid, remove it
                    db.deletePushSubscription(sub.endpoint);
                    logInfo(`Removed expired subscription for user ${userId}`);
                } else {
                    logError(`Error sending push notification:`, err);
                }
            }
        }
    } catch (err) {
        logError('Error in sendPushNotification:', err);
    }
}

module.exports = {
    processVideo,
    progressEmitter
};
