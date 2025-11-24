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
    res.render('index', { 
        episodes, 
        user: req.session.username,
        isAdmin: req.session.role === 'admin'
    });
});

// Add Episode
app.post('/add', requireAuth, async (req, res) => {
    const url = req.body.url;
    if (!url) {
        return res.status(400).send('URL is required');
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
    res.download(filePath, `${episode.title}.mp4`);
});

// Admin Panel
app.get('/admin', requireAdmin, (req, res) => {
    const users = db.getAllUsers();
    res.render('admin', { 
        users,
        user: {
            id: req.session.userId,
            username: req.session.username,
            role: req.session.role
        }
    });
});

app.post('/admin/users/delete/:id', requireAdmin, (req, res) => {
    const id = req.params.id;
    if (parseInt(id) === req.session.userId) {
        return res.status(400).send('Cannot delete yourself');
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
