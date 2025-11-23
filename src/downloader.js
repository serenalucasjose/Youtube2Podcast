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

async function processVideo(url) {
  try {
    progressEmitter.emit('progress', { status: 'fetching_metadata', percent: 10 });
    console.log(`Processing URL: ${url}`);

    // 1. Get Metadata
    const outputTemplate = path.join(TEMP_DIR, '%(id)s');
    // Prevent double extensions or weird naming
    
    const metadata = await youtubedl(url, {
      dumpSingleJson: true,
      noCheckCertificates: true,
      noWarnings: true,
      preferFreeFormats: true,
      addHeader: ['referer:youtube.com', 'user-agent:googlebot'],
      // Fix for warning about deprecated extraction
      extractorArgs: 'youtube:player_client=android', 
    });

    const videoId = metadata.id;
    const title = metadata.title;
    
    // Check if already exists
    const existing = db.getEpisodeByYoutubeId(videoId);
    if (existing) {
        progressEmitter.emit('progress', { status: 'done', percent: 100 });
        console.log('Video already processed');
        return existing;
    }

    console.log(`Video ID: ${videoId}, Title: ${title}`);

    // Cleanup previous temp files for this ID
    const existingFiles = fs.readdirSync(TEMP_DIR);
    existingFiles.forEach(f => {
        // Match files starting with videoId followed by a dot (to avoid partial matches like videoId + 'extra')
        if (f.startsWith(videoId + '.')) {
            fs.unlinkSync(path.join(TEMP_DIR, f));
        }
    });

    // 2. Download Audio and Thumbnail
    progressEmitter.emit('progress', { status: 'downloading_audio', percent: 30 });
    // Download audio
    await youtubedl(url, {
        extractAudio: true,
        audioFormat: 'm4a',
        output: `${outputTemplate}.%(ext)s`,
        noCheckCertificates: true,
        extractorArgs: 'youtube:player_client=android',
    });

    // Download thumbnail
    await youtubedl(url, {
        writeThumbnail: true,
        skipDownload: true,
        output: `${outputTemplate}`, // youtube-dl adds extension automatically
        noCheckCertificates: true,
        extractorArgs: 'youtube:player_client=android',
    });
    
    // Find the downloaded files
    const files = fs.readdirSync(TEMP_DIR);
    const audioFile = files.find(f => f.startsWith(videoId) && (f.endsWith('.m4a') || f.endsWith('.mp3') || f.endsWith('.webm')));
    // Thumbnail can be jpg, webp, png.
    const thumbFile = files.find(f => f.startsWith(videoId) && (f.endsWith('.jpg') || f.endsWith('.webp') || f.endsWith('.png')));

    if (!audioFile || !thumbFile) {
        // Fallback: try to match by files containing the videoId, but exclude the ones we already know aren't it
        // This is tricky because yt-dlp output names can be complex
        
        // Debug info
        console.log('Files in temp:', files);
        console.log('Looking for ID:', videoId);
        
        throw new Error('Failed to download audio or thumbnail');
    }

    const audioPath = path.join(TEMP_DIR, audioFile);
    const thumbPath = path.join(TEMP_DIR, thumbFile);
    const outputFileName = `${videoId}.mp4`;
    const finalPath = path.join(DOWNLOADS_DIR, outputFileName);

    console.log(`Audio: ${audioPath}, Thumb: ${thumbPath}`);

    // 3. Convert using ffmpeg
    progressEmitter.emit('progress', { status: 'converting', percent: 60 });
    await new Promise((resolve, reject) => {
        ffmpeg()
            .input(thumbPath)
            .inputOptions([
                '-loop 1',
                '-framerate 1'
            ])
            .input(audioPath)
            .outputOptions([
                '-c:v libx264',
                '-tune stillimage',
                '-c:a copy',
                '-shortest',
                '-pix_fmt yuv420p' // Ensure compatibility
            ])
            .save(finalPath)
            .on('end', resolve)
            .on('error', reject);
    });

    console.log(`Conversion complete: ${finalPath}`);

    // 4. Cleanup Temp Files
    fs.unlinkSync(audioPath);
    fs.unlinkSync(thumbPath);

    // 5. Save to DB
    const episode = {
        youtube_id: videoId,
        title: title,
        file_path: outputFileName, // Relative to downloads/
        original_url: url
    };
    db.addEpisode(episode);

    progressEmitter.emit('progress', { status: 'done', percent: 100 });
    return episode;

  } catch (error) {
    console.error('Error processing video:', error);
    progressEmitter.emit('progress', { status: 'error', message: error.message });
    throw error;
  }
}

module.exports = {
    processVideo,
    progressEmitter
};

