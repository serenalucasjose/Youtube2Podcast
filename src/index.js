require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const basicAuth = require('express-basic-auth');
const db = require('./db');
const downloader = require('./downloader');

const app = express();
const PORT = process.env.PORT || 3000;

// Auth Middleware
const adminAuth = basicAuth({
    users: { [process.env.ADMIN_USER || 'admin']: process.env.ADMIN_PASS || 'admin' },
    challenge: true,
    realm: 'Youtube2Podcast Admin Area'
});

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
app.use('/downloads', express.static(path.join(__dirname, '../downloads')));

// View Engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));

// Routes

let isProcessing = false;

// SSE Endpoint for progress
app.get('/progress', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Send initial status immediately upon connection
    if (isProcessing) {
        res.write(`data: ${JSON.stringify({ status: 'resumed', percent: 10 })}\n\n`);
    }

    const onProgress = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
        if (data.status === 'done' || data.status === 'error') {
             isProcessing = false;
        }
    };

    downloader.progressEmitter.on('progress', onProgress);

    req.on('close', () => {
        downloader.progressEmitter.off('progress', onProgress);
    });
});

// Home: List episodes
app.get('/', (req, res) => {
    const episodes = db.getEpisodes();
    res.render('index', { episodes, isProcessing });
});

// Add Episode
app.post('/add', async (req, res) => {
    const url = req.body.url;
    if (!url) {
        return res.status(400).send('URL is required');
    }
    
    if (isProcessing) {
        return res.redirect('/?processing=true');
    }

    isProcessing = true;

    // Don't await here, let it run in background
    downloader.processVideo(url)
        .then(() => { isProcessing = false; })
        .catch(err => { 
            console.error(err); 
            isProcessing = false; 
        });
    
    // Redirect to home with a query param to trigger overlay
    res.redirect('/?processing=true');
});

// Download Episode
app.get('/download/:id', (req, res) => {
    const episode = db.getEpisodeById(req.params.id);
    if (!episode) {
        return res.status(404).send('Episode not found');
    }
    const filePath = path.join(__dirname, '../downloads', episode.file_path);
    res.download(filePath, `${episode.title}.mp4`);
});

// Admin Panel
app.get('/admin', adminAuth, (req, res) => {
    res.render('admin');
});

// Admin: Clear All
app.post('/api/clear-all', adminAuth, (req, res) => {
    try {
        // 1. Clear DB
        db.deleteAllEpisodes();

        // 2. Clear Downloads folder (keep temp)
        const downloadsDir = path.join(__dirname, '../downloads');
        const files = fs.readdirSync(downloadsDir);
        for (const file of files) {
            if (file !== 'temp') {
                fs.unlinkSync(path.join(downloadsDir, file));
            }
        }
        
        // Also clear temp? maybe safer to clear temp too if things got stuck
        // const tempDir = path.join(downloadsDir, 'temp');
        // ... (optional)

        res.redirect('/admin');
    } catch (error) {
        console.error(error);
        res.status(500).send('Error clearing data');
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

