const youtubedl = require('youtube-dl-exec');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const db = require('./db');

const DOWNLOADS_DIR = path.join(__dirname, '../downloads');
const TEMP_DIR = path.join(DOWNLOADS_DIR, 'temp');

// Ensure directories exist
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR);
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

const EventEmitter = require('events');
const progressEmitter = new EventEmitter();

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

async function processVideo(url, userId) {
  // 1. Get Metadata (Blocking part - fast)
  let metadata;
  try {
    progressEmitter.emit('progress', { status: 'fetching_metadata', percent: 10 });
    logInfo(`Processing URL: ${url}`);

    // const existing = db.getEpisodeByYoutubeId(metadata?.id); 
    // We can't check here because we don't have metadata yet
    
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

    // Start background process
    performDownload(url, videoId, userId).catch(err => {
        logError('Background download failed:', err);
        db.updateEpisodeStatus(videoId, 'error');
        progressEmitter.emit('progress', { videoId, status: 'error', message: err.message });
    });

    // Return immediately so UI can show the card
    return episode;

  } catch (error) {
    logError('Error fetching metadata:', error);
    // We might not have a videoId here if metadata fetch failed
    progressEmitter.emit('progress', { status: 'global_error', message: error.message });
    throw error;
  }
}

async function performDownload(url, videoId) {
    const outputTemplate = path.join(TEMP_DIR, videoId); // Use videoId directly to avoid confusion

    try {
        progressEmitter.emit('progress', { videoId, status: 'downloading_audio', percent: 30 });
        
        // Cleanup previous temp files
        const existingFiles = fs.readdirSync(TEMP_DIR);
        existingFiles.forEach(f => {
            if (f.startsWith(videoId + '.')) {
                fs.unlinkSync(path.join(TEMP_DIR, f));
            }
        });

        // Download audio
        await youtubedl(url, {
            extractAudio: true,
            audioFormat: 'mp3',
            output: `${outputTemplate}.%(ext)s`,
            noCheckCertificates: true,
            // Adding force-ipv4 to resolve [Errno 101] Network is unreachable on some networks
            forceIpv4: true 
        });

        // Download thumbnail
        await youtubedl(url, {
            writeThumbnail: true,
            skipDownload: true,
            output: `${outputTemplate}`,
            noCheckCertificates: true,
             // Adding force-ipv4 here as well
            forceIpv4: true
        });

        // Find files
        const files = fs.readdirSync(TEMP_DIR);
        const audioFile = files.find(f => f.startsWith(videoId) && (f.endsWith('.m4a') || f.endsWith('.mp3') || f.endsWith('.webm')));
        const thumbFile = files.find(f => f.startsWith(videoId) && (f.endsWith('.jpg') || f.endsWith('.webp') || f.endsWith('.png')));

        if (!audioFile || !thumbFile) {
             throw new Error('Failed to download audio or thumbnail files');
        }

        const audioPath = path.join(TEMP_DIR, audioFile);
        let thumbPath = path.join(TEMP_DIR, thumbFile);
        const outputFileName = `${videoId}.mp3`;
        const finalPath = path.join(DOWNLOADS_DIR, outputFileName);

        // Convert WebP thumbnail to JPEG (MP3 ID3 tags don't support WebP)
        if (thumbPath.endsWith('.webp')) {
            const jpegThumbPath = path.join(TEMP_DIR, `${videoId}.jpg`);
            await new Promise((resolve, reject) => {
                ffmpeg(thumbPath)
                    .output(jpegThumbPath)
                    .on('end', resolve)
                    .on('error', reject)
                    .run();
            });
            // Remove the original webp and use jpeg
            fs.unlinkSync(thumbPath);
            thumbPath = jpegThumbPath;
        }

        // Convert / Add Metadata
        progressEmitter.emit('progress', { videoId, status: 'converting', percent: 60 });
        await new Promise((resolve, reject) => {
            const command = ffmpeg();
            
            // Input 0: Audio
            command.input(audioPath);
            
            // Input 1: Thumbnail (now guaranteed to be JPEG or PNG)
            command.input(thumbPath);
            
            // Use multiple arguments to avoid fluent-ffmpeg's auto-splitting behavior on arrays
            command.outputOptions(
                '-map', '0:a',
                '-map', '1:v',
                '-c:v', 'mjpeg',
                '-disposition:v:0', 'attached_pic',
                '-id3v2_version', '3',
                '-metadata:s:v', 'title=Album cover',
                '-metadata:s:v', 'comment=Cover (front)'
            );

            if (audioPath.endsWith('.mp3')) {
                 command.outputOptions('-c:a', 'copy');
            } else {
                 command.outputOptions('-c:a', 'libmp3lame', '-q:a', '2');
            }
                
            command
                .on('start', (cmdLine) => {
                     logInfo('Spawned Ffmpeg with command: ' + cmdLine);
                })
                .save(finalPath)
                .on('end', resolve)
                .on('error', (err) => {
                    logError('FFmpeg Error:', err);
                    reject(err);
                });
        });

        // Cleanup
        if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
        if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);

        // Update DB
        db.updateEpisodeStatus(videoId, 'ready', outputFileName);
        progressEmitter.emit('progress', { videoId, status: 'done', percent: 100 });
        logInfo(`Download and conversion complete for ${videoId}`);

    } catch (error) {
        logError(`Error in background task for ${videoId}:`, error);
        db.updateEpisodeStatus(videoId, 'error');
        progressEmitter.emit('progress', { videoId, status: 'error', message: error.message });
        throw error;
    }
}

module.exports = {
    processVideo,
    progressEmitter
};
