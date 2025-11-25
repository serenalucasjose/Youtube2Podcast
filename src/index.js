require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const bcrypt = require('bcryptjs');
const db = require('./db');
const downloader = require('./downloader');

const app = express();
const PORT = process.env.PORT || 3000;

// Cleanup stale processing episodes on startup (handles server crashes/restarts)
const staleReset = db.resetStaleProcessingEpisodes();
if (staleReset.changes > 0) {
    console.log(`[Startup] Reset ${staleReset.changes} stale processing episode(s) to error state.`);
}

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
app.use('/downloads', express.static(path.join(__dirname, '../downloads')));

// Session Setup
app.use(session({
    store: new SQLiteStore({
        db: 'sessions.db',
        dir: path.join(__dirname, '../data')
    }),
    secret: process.env.SESSION_SECRET || 'secret_key_change_me',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } // 1 week
}));

// View Engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));

// Auth Middleware
const requireAuth = (req, res, next) => {
    if (!req.session.userId) {
        return res.redirect('/login');
    }
    next();
};

const requireAdmin = (req, res, next) => {
    if (!req.session.userId || req.session.role !== 'admin') {
        return res.status(403).send('Forbidden');
    }
    next();
};

// --- Routes ---

// Login
app.get('/login', (req, res) => {
    res.render('login');
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const user = db.getUserByUsername(username);
    
    if (user && bcrypt.compareSync(password, user.password_hash)) {
        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.role = user.role;
        return res.redirect('/');
    }
    
    res.render('login', { error: 'Usuario o contraseña inválidos' });
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// SSE Endpoint for progress (Global for now, could be scoped by user/video)
app.get('/progress', requireAuth, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const onProgress = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    downloader.progressEmitter.on('progress', onProgress);

    req.on('close', () => {
        downloader.progressEmitter.off('progress', onProgress);
    });
});

// Home: List episodes
app.get('/', requireAuth, (req, res) => {
    const episodes = db.getEpisodes(req.session.userId);
    const error = req.query.error || null;
    const quotaLimit = 3;
    res.render('index', { 
        episodes, 
        user: req.session.username,
        isAdmin: req.session.role === 'admin',
        error,
        episodeCount: episodes.length,
        quotaLimit
    });
});

// Add Episode
app.post('/add', requireAuth, async (req, res) => {
    const url = req.body.url;
    if (!url) {
        return res.status(400).send('URL is required');
    }

    // Check quota (max 3 videos per user)
    const userEpisodes = db.getEpisodes(req.session.userId);
    if (userEpisodes.length >= 3) {
        return res.redirect('/?error=' + encodeURIComponent('Has alcanzado el límite de 3 videos.'));
    }

    try {
        // This now returns quickly after fetching metadata
        // The heavy lifting happens in background
        await downloader.processVideo(url, req.session.userId);
        res.redirect('/');
    } catch (error) {
        console.error(error);
        res.status(500).send('Error processing video: ' + error.message);
    }
});

// Delete Episodes
app.post('/delete', requireAuth, (req, res) => {
    let ids = req.body.ids;
    if (!ids) {
        return res.status(400).send('No IDs provided');
    }
    
    // Ensure ids is an array
    if (!Array.isArray(ids)) {
        ids = [ids];
    }

    const downloadsDir = path.join(__dirname, '../downloads');
    const tempDir = path.join(downloadsDir, 'temp');

    ids.forEach(id => {
        const episode = db.getEpisodeById(id);
        if (episode) {
            // Check ownership or admin
            if (episode.user_id === req.session.userId || req.session.role === 'admin') {
                // Delete main file
                if (episode.file_path) {
                    const filePath = path.join(downloadsDir, episode.file_path);
                    try {
                        if (fs.existsSync(filePath)) {
                            fs.unlinkSync(filePath);
                        }
                    } catch (err) {
                        console.error(`Error deleting file ${filePath}:`, err);
                    }
                }
                
                // Delete any temp files associated with this episode (by youtube_id)
                if (episode.youtube_id && fs.existsSync(tempDir)) {
                    try {
                        const tempFiles = fs.readdirSync(tempDir);
                        tempFiles.forEach(file => {
                            if (file.startsWith(episode.youtube_id)) {
                                const tempFilePath = path.join(tempDir, file);
                                fs.unlinkSync(tempFilePath);
                            }
                        });
                    } catch (err) {
                        console.error(`Error cleaning temp files for ${episode.youtube_id}:`, err);
                    }
                }
                
                // Delete from DB
                db.deleteEpisode(id);
            }
        }
    });

    res.redirect('/');
});

// Download Episode
app.get('/download/:id', requireAuth, (req, res) => {
    const episode = db.getEpisodeById(req.params.id);
    
    if (!episode) {
        return res.status(404).send('Episode not found');
    }
    
    // Check ownership
    if (episode.user_id !== req.session.userId) {
        return res.status(403).send('Forbidden');
    }

    if (episode.status !== 'ready') {
        return res.status(400).send('Video not ready yet');
    }

    const filePath = path.join(__dirname, '../downloads', episode.file_path);
    const ext = path.extname(episode.file_path);
    res.download(filePath, `${episode.title}${ext}`);
});

// Admin Panel
app.get('/admin', requireAdmin, (req, res) => {
    const users = db.getAllUsers();
    const error = req.query.error || null;
    res.render('admin', { 
        users,
        user: {
            id: req.session.userId,
            username: req.session.username,
            role: req.session.role
        },
        error
    });
});

app.post('/admin/users/delete/:id', requireAdmin, (req, res) => {
    const id = req.params.id;
    if (parseInt(id) === req.session.userId) {
        return res.redirect('/admin?error=' + encodeURIComponent('No puedes borrarte a ti mismo.'));
    }
    db.deleteUser(id);
    res.redirect('/admin');
});

app.post('/admin/users/add', requireAdmin, (req, res) => {
    const { username, password, role } = req.body;
    try {
        db.createUser(username, password, role);
        res.redirect('/admin');
    } catch (error) {
        res.status(400).send(error.message);
    }
});

app.post('/admin/users/update/:id', requireAdmin, (req, res) => {
    const id = req.params.id;
    const { username, password, role } = req.body;
    try {
        db.updateUser(id, { username, password, role });
        res.redirect('/admin');
    } catch (error) {
        res.status(400).send(error.message);
    }
});

// API: Task Status Polling (for frontend fallback when SSE fails)
app.get('/api/task-status', requireAuth, (req, res) => {
    const idsParam = req.query.ids;
    if (!idsParam) {
        return res.json({ episodes: [] });
    }
    
    // Parse comma-separated IDs
    const ids = idsParam.split(',').map(id => parseInt(id.trim(), 10)).filter(id => !isNaN(id));
    if (ids.length === 0) {
        return res.json({ episodes: [] });
    }
    
    const episodes = db.getEpisodesByIds(ids);
    // Filter to only user's episodes (or all if admin)
    const filtered = episodes.filter(ep => 
        ep.user_id === req.session.userId || req.session.role === 'admin'
    );
    
    res.json({ episodes: filtered });
});

// Admin: Clear All Episodes
app.post('/api/clear-all', requireAdmin, (req, res) => {
    try {
        db.deleteAllEpisodes();
        const downloadsDir = path.join(__dirname, '../downloads');
        const files = fs.readdirSync(downloadsDir);
        for (const file of files) {
            if (file !== 'temp') {
                fs.unlinkSync(path.join(downloadsDir, file));
            }
        }
        res.redirect('/admin');
    } catch (error) {
        console.error(error);
        res.status(500).send('Error clearing data');
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
