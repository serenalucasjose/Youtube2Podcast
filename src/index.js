require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const bcrypt = require('bcryptjs');
const webPush = require('web-push');
const db = require('./db');
const downloader = require('./downloader');
const translationService = require('./translation_service');
const transcriptionService = require('./transcription_service');

// Configure web-push with VAPID keys
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webPush.setVapidDetails(
        process.env.VAPID_SUBJECT || 'mailto:admin@youtube2podcast.local',
        process.env.VAPID_PUBLIC_KEY,
        process.env.VAPID_PRIVATE_KEY
    );
}

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
// Serve Bootstrap Icons from node_modules
app.use('/vendor/bi', express.static(path.join(__dirname, '../node_modules/bootstrap-icons')));

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

    let isAlive = true;
    let heartbeatInterval = null;

    const cleanup = () => {
        if (!isAlive) return; // Already cleaned up
        isAlive = false;
        
        // Clear heartbeat first
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
        }
        
        // Remove listeners - wrapped in try/catch for safety
        try {
            downloader.progressEmitter.removeListener('progress', onProgress);
        } catch (e) { /* ignore */ }
        
        try {
            translationService.translationEmitter.removeListener('progress', onTranslationProgress);
        } catch (e) { /* ignore */ }
        
        try {
            transcriptionService.transcriptionEmitter.removeListener('progress', onTranscriptionProgress);
        } catch (e) { /* ignore */ }
    };

    const onProgress = (data) => {
        if (!isAlive) return;
        try {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        } catch (err) {
            cleanup();
        }
    };

    const onTranslationProgress = (data) => {
        if (!isAlive) return;
        try {
            res.write(`data: ${JSON.stringify({ ...data, type: 'translation' })}\n\n`);
        } catch (err) {
            cleanup();
        }
    };

    const onTranscriptionProgress = (data) => {
        if (!isAlive) return;
        try {
            res.write(`data: ${JSON.stringify({ ...data, type: 'transcription' })}\n\n`);
        } catch (err) {
            cleanup();
        }
    };

    // Register cleanup handlers BEFORE adding listeners
    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('error', cleanup);
    res.on('close', cleanup);

    // Heartbeat every 30 seconds to detect dead connections
    heartbeatInterval = setInterval(() => {
        if (!isAlive) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
            return;
        }
        try {
            res.write(': heartbeat\n\n');
        } catch (err) {
            cleanup();
        }
    }, 30000);

    // Add listeners AFTER registering cleanup
    downloader.progressEmitter.on('progress', onProgress);
    translationService.translationEmitter.on('progress', onTranslationProgress);
    transcriptionService.transcriptionEmitter.on('progress', onTranscriptionProgress);
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
                
                // Delete translated file if exists
                translationService.cleanupTranslatedFile(episode);
                
                // Delete transcription file if exists
                transcriptionService.cleanupTranscriptionFile(episode);
                
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

// Translate Episode (Manual trigger)
app.post('/translate/:id', requireAuth, async (req, res) => {
    const episode = db.getEpisodeById(req.params.id);
    
    if (!episode) {
        return res.status(404).json({ error: 'Episodio no encontrado' });
    }
    
    // Check ownership
    if (episode.user_id !== req.session.userId && req.session.role !== 'admin') {
        return res.status(403).json({ error: 'No autorizado' });
    }

    if (episode.status !== 'ready') {
        return res.status(400).json({ error: 'El video aún no está listo' });
    }

    // Obtener voz seleccionada (default: es-ES-AlvaroNeural)
    const voice = req.body.voice || 'es-ES-AlvaroNeural';

    try {
        const updatedEpisode = await translationService.startTranslation(episode.id, voice);
        res.json({ 
            success: true, 
            message: 'Traducción iniciada',
            episode: updatedEpisode
        });
    } catch (error) {
        console.error('Error starting translation:', error);
        res.status(500).json({ error: error.message });
    }
});

// Transcribe Episode (Manual trigger)
app.post('/transcribe/:id', requireAuth, async (req, res) => {
    const episode = db.getEpisodeById(req.params.id);
    
    if (!episode) {
        return res.status(404).json({ error: 'Episodio no encontrado' });
    }
    
    // Check ownership
    if (episode.user_id !== req.session.userId && req.session.role !== 'admin') {
        return res.status(403).json({ error: 'No autorizado' });
    }

    if (episode.status !== 'ready') {
        return res.status(400).json({ error: 'El video aún no está listo' });
    }

    // Obtener idioma seleccionado (default: en)
    const language = req.body.language || 'en';
    // Flag para forzar regeneración (default: false)
    const force = req.body.force === true || req.body.force === 'true';

    try {
        const updatedEpisode = await transcriptionService.startTranscription(episode.id, language, force);
        res.json({ 
            success: true, 
            message: 'Transcripción iniciada',
            episode: updatedEpisode
        });
    } catch (error) {
        console.error('Error starting transcription:', error);
        res.status(500).json({ error: error.message });
    }
});

// Admin: Regenerate Transcription (with force flag)
app.post('/admin/episodes/:id/transcribe', requireAdmin, async (req, res) => {
    const episode = db.getEpisodeById(req.params.id);
    
    if (!episode) {
        return res.status(404).json({ error: 'Episodio no encontrado' });
    }

    if (episode.status !== 'ready') {
        return res.status(400).json({ error: 'El video aún no está listo' });
    }

    const language = req.body.language || 'en';

    try {
        // Siempre forzar regeneración desde el admin
        const updatedEpisode = await transcriptionService.startTranscription(episode.id, language, true);
        res.json({ 
            success: true, 
            message: `Transcripción en ${transcriptionService.SUPPORTED_LANGUAGES[language] || language} iniciada`,
            episode: updatedEpisode
        });
    } catch (error) {
        console.error('Error starting transcription from admin:', error);
        res.status(500).json({ error: error.message });
    }
});

// Download Transcription PDF
app.get('/download-transcription/:id', requireAuth, (req, res) => {
    const episode = db.getEpisodeById(req.params.id);
    
    if (!episode) {
        return res.status(404).send('Episodio no encontrado');
    }
    
    // Check ownership
    if (episode.user_id !== req.session.userId && req.session.role !== 'admin') {
        return res.status(403).send('No autorizado');
    }

    if (episode.transcription_status !== 'ready' || !episode.transcription_file_path) {
        return res.status(400).send('Transcripción no disponible');
    }

    const filePath = path.join(__dirname, '../downloads', episode.transcription_file_path);
    
    if (!fs.existsSync(filePath)) {
        return res.status(404).send('Archivo no encontrado');
    }
    
    res.download(filePath, `${episode.title} - Transcripción.pdf`);
});

// Get supported transcription languages
app.get('/api/transcription-languages', requireAuth, (req, res) => {
    res.json(transcriptionService.SUPPORTED_LANGUAGES);
});

// Download Translated Episode
app.get('/download-translated/:id', requireAuth, (req, res) => {
    const episode = db.getEpisodeById(req.params.id);
    
    if (!episode) {
        return res.status(404).send('Episodio no encontrado');
    }
    
    // Check ownership
    if (episode.user_id !== req.session.userId && req.session.role !== 'admin') {
        return res.status(403).send('No autorizado');
    }

    if (episode.translation_status !== 'ready' || !episode.translated_file_path) {
        return res.status(400).send('Traducción no disponible');
    }

    const filePath = path.join(__dirname, '../downloads', episode.translated_file_path);
    
    if (!fs.existsSync(filePath)) {
        return res.status(404).send('Archivo no encontrado');
    }
    
    const ext = path.extname(episode.translated_file_path);
    res.download(filePath, `${episode.title} (Español)${ext}`);
});

// Admin Panel
app.get('/admin', requireAdmin, (req, res) => {
    const users = db.getAllUsers();
    const allEpisodes = db.getEpisodes(); // Get all episodes (no user filter)
    const stats = db.getAdminStats();
    const error = req.query.error || null;
    
    // Calculate disk usage
    const downloadsDir = path.join(__dirname, '../downloads');
    let diskUsage = 0;
    try {
        const files = fs.readdirSync(downloadsDir);
        for (const file of files) {
            const filePath = path.join(downloadsDir, file);
            const stat = fs.statSync(filePath);
            if (stat.isFile()) {
                diskUsage += stat.size;
            }
        }
    } catch (err) {
        console.error('Error calculating disk usage:', err);
    }
    
    res.render('admin', { 
        users,
        episodes: allEpisodes,
        stats: {
            ...stats,
            diskUsage
        },
        supportedLanguages: transcriptionService.SUPPORTED_LANGUAGES,
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

// API: Get Episode Card HTML (for AJAX updates without full page reload)
app.get('/api/episode/:id/card', requireAuth, (req, res) => {
    const episode = db.getEpisodeById(req.params.id);
    
    if (!episode) {
        return res.status(404).json({ error: 'Episodio no encontrado' });
    }
    
    // Check ownership
    if (episode.user_id !== req.session.userId && req.session.role !== 'admin') {
        return res.status(403).json({ error: 'No autorizado' });
    }
    
    // Render the partial template
    res.render('partials/episode_card', { episode }, (err, html) => {
        if (err) {
            console.error('Error rendering episode card:', err);
            return res.status(500).json({ error: 'Error al renderizar tarjeta' });
        }
        res.json({ html, episode: { 
            id: episode.id,
            status: episode.status,
            translation_status: episode.translation_status
        }});
    });
});

// API: Get Episode Logs (for translation progress)
app.get('/api/episode/:id/logs', requireAuth, (req, res) => {
    const episode = db.getEpisodeById(req.params.id);
    
    if (!episode) {
        return res.status(404).json({ error: 'Episodio no encontrado' });
    }
    
    // Check ownership
    if (episode.user_id !== req.session.userId && req.session.role !== 'admin') {
        return res.status(403).json({ error: 'No autorizado' });
    }
    
    const logs = translationService.getLogs(episode.id);
    res.json({ 
        logs,
        status: episode.translation_status,
        episodeId: episode.id
    });
});

// --- Push Notifications API ---

// Get VAPID public key
app.get('/api/vapid-public-key', requireAuth, (req, res) => {
    if (!process.env.VAPID_PUBLIC_KEY) {
        return res.status(500).json({ error: 'Push notifications not configured' });
    }
    res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// Subscribe to push notifications
app.post('/api/push/subscribe', requireAuth, (req, res) => {
    const subscription = req.body;
    
    if (!subscription || !subscription.endpoint || !subscription.keys) {
        return res.status(400).json({ error: 'Invalid subscription' });
    }
    
    try {
        db.savePushSubscription(req.session.userId, subscription);
        res.json({ success: true, message: 'Subscripción guardada' });
    } catch (error) {
        console.error('Error saving push subscription:', error);
        res.status(500).json({ error: 'Error al guardar suscripción' });
    }
});

// Unsubscribe from push notifications
app.post('/api/push/unsubscribe', requireAuth, (req, res) => {
    const { endpoint } = req.body;
    
    if (!endpoint) {
        return res.status(400).json({ error: 'Endpoint required' });
    }
    
    try {
        db.deletePushSubscription(endpoint);
        res.json({ success: true, message: 'Suscripción eliminada' });
    } catch (error) {
        console.error('Error deleting push subscription:', error);
        res.status(500).json({ error: 'Error al eliminar suscripción' });
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
