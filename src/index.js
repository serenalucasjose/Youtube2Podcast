require('dotenv').config();
const express = require('express');
const compression = require('compression');
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
const rssService = require('./rss_service');
const aiWorker = require('./ai_worker');
const packageJson = require('../package.json');


// Configure web-push with VAPID keys
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webPush.setVapidDetails(
        process.env.VAPID_SUBJECT || 'mailto:admin@youtube2podcast.local',
        process.env.VAPID_PUBLIC_KEY,
        process.env.VAPID_PRIVATE_KEY
    );
}

const app = express();

// Make version available to all views
app.locals.appVersion = packageJson.version;

const PORT = process.env.PORT || 3000;

// Trust proxy when behind reverse proxy (Nginx, Cloudflare, etc.)
// This is required for secure cookies and correct IP detection
if (process.env.NODE_ENV === 'production') {
    app.set('trust proxy', 1);
}

// Cleanup stale processing episodes on startup (handles server crashes/restarts)
const staleReset = db.resetStaleProcessingEpisodes();
if (staleReset.changes > 0) {
    console.log(`[Startup] Reset ${staleReset.changes} stale processing episode(s) to error state.`);
}

// Middleware
// Compresión HTTP (excluir SSE)
app.use(compression({
    level: 6,
    threshold: 1024,
    filter: (req, res) => {
        if (req.headers.accept === 'text/event-stream') {
            return false;
        }
        return compression.filter(req, res);
    }
}));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Assets estáticos con cache optimizado
app.use(express.static(path.join(__dirname, '../public'), {
    maxAge: '7d',
    etag: true,
    lastModified: true
}));

// Downloads con soporte para Range requests (seeking en audio)
app.use('/downloads', express.static(path.join(__dirname, '../downloads'), {
    acceptRanges: true,
    maxAge: '1d',
    etag: true,
    lastModified: true
}));

// Vendor con cache largo (versionado por npm)
app.use('/vendor/bi', express.static(path.join(__dirname, '../node_modules/bootstrap-icons'), {
    maxAge: '30d',
    immutable: true
}));

// Session Setup
const isProduction = process.env.NODE_ENV === 'production';
app.use(session({
    store: new SQLiteStore({
        db: 'sessions.db',
        dir: path.join(__dirname, '../data')
    }),
    secret: process.env.SESSION_SECRET || 'secret_key_change_me',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        maxAge: 7 * 24 * 60 * 60 * 1000, // 1 week
        secure: isProduction, // Use secure cookies in production (HTTPS)
        httpOnly: true,
        sameSite: isProduction ? 'lax' : 'lax' // Prevent CSRF
    }
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

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = db.getUserByUsername(username);
    
    // Usar bcrypt async para no bloquear el event loop
    if (user && await bcrypt.compare(password, user.password_hash)) {
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
        // Handle duplicate video errors gracefully
        if (error.name === 'DuplicateVideoError') {
            return res.redirect('/?error=' + encodeURIComponent(error.message));
        }
        console.error(error);
        res.status(500).send('Error processing video: ' + error.message);
    }
});

// Delete Episodes (async para no bloquear I/O)
app.post('/delete', requireAuth, async (req, res) => {
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

    for (const id of ids) {
        const episode = db.getEpisodeById(id);
        if (episode) {
            // Check ownership or admin
            if (episode.user_id === req.session.userId || req.session.role === 'admin') {
                // Delete main file (async)
                if (episode.file_path) {
                    const filePath = path.join(downloadsDir, episode.file_path);
                    try {
                        await fs.promises.unlink(filePath);
                    } catch (err) {
                        if (err.code !== 'ENOENT') {
                            console.error(`Error deleting file ${filePath}:`, err);
                        }
                    }
                }
                
                // Delete translated file if exists
                translationService.cleanupTranslatedFile(episode);
                
                // Delete transcription file if exists
                transcriptionService.cleanupTranscriptionFile(episode);
                
                // Delete any temp files associated with this episode (async batch)
                if (episode.youtube_id) {
                    try {
                        const tempFiles = await fs.promises.readdir(tempDir);
                        const deletePromises = tempFiles
                            .filter(file => file.startsWith(episode.youtube_id))
                            .map(file => fs.promises.unlink(path.join(tempDir, file)).catch(() => {}));
                        await Promise.all(deletePromises);
                    } catch (err) {
                        // tempDir might not exist, that's fine
                    }
                }
                
                // Delete from DB
                db.deleteEpisode(id);
            }
        }
    }

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
app.get('/download-transcription/:id', requireAuth, async (req, res) => {
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
    
    try {
        await fs.promises.access(filePath);
        res.download(filePath, `${episode.title} - Transcripción.pdf`);
    } catch {
        return res.status(404).send('Archivo no encontrado');
    }
});

// Get supported transcription languages
app.get('/api/transcription-languages', requireAuth, (req, res) => {
    res.json(transcriptionService.SUPPORTED_LANGUAGES);
});

// Download Translated Episode
app.get('/download-translated/:id', requireAuth, async (req, res) => {
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
    
    try {
        await fs.promises.access(filePath);
        const ext = path.extname(episode.translated_file_path);
        res.download(filePath, `${episode.title} (Español)${ext}`);
    } catch {
        return res.status(404).send('Archivo no encontrado');
    }
});

// Helper: Calcula uso de disco de forma asíncrona
async function calculateDiskUsage(dir) {
    try {
        const files = await fs.promises.readdir(dir);
        const stats = await Promise.all(
            files.map(async (file) => {
                const filePath = path.join(dir, file);
                try {
                    const stat = await fs.promises.stat(filePath);
                    return stat.isFile() ? stat.size : 0;
                } catch {
                    return 0;
                }
            })
        );
        return stats.reduce((sum, size) => sum + size, 0);
    } catch {
        return 0;
    }
}

// Admin Panel
app.get('/admin', requireAdmin, async (req, res) => {
    const users = db.getAllUsers();
    const allEpisodes = db.getEpisodes(); // Get all episodes (no user filter)
    const stats = db.getAdminStats();
    const error = req.query.error || null;
    
    // Calculate disk usage asíncronamente
    const downloadsDir = path.join(__dirname, '../downloads');
    const diskUsage = await calculateDiskUsage(downloadsDir);
    
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

// Admin: Clear All Episodes (async)
app.post('/api/clear-all', requireAdmin, async (req, res) => {
    try {
        db.deleteAllEpisodes();
        const downloadsDir = path.join(__dirname, '../downloads');
        const files = await fs.promises.readdir(downloadsDir);
        
        // Delete all files in parallel except 'temp' directory
        const deletePromises = files
            .filter(file => file !== 'temp')
            .map(file => fs.promises.unlink(path.join(downloadsDir, file)).catch(() => {}));
        
        await Promise.all(deletePromises);
        res.redirect('/admin');
    } catch (error) {
        console.error(error);
        res.status(500).send('Error clearing data');
    }
});

// ===============================
// PODCAST IA ROUTES
// ===============================

// Podcast IA: Main page
app.get('/podcast-ia', requireAuth, (req, res) => {
    const categories = rssService.getCategories();
    const userPodcasts = db.getGeneratedPodcastsByUserId(req.session.userId);
    const podcastCount = db.countGeneratedPodcastsByUserId(req.session.userId);
    const podcastLimit = 3;
    
    res.render('podcast_ia', {
        user: req.session.username,
        isAdmin: req.session.role === 'admin',
        categories,
        podcasts: userPodcasts,
        podcastCount,
        podcastLimit,
        error: req.query.error || null,
        success: req.query.success || null
    });
});

// Podcast IA: Generate new podcast
app.post('/podcast-ia/generate', requireAuth, async (req, res) => {
    const { category, voice } = req.body;
    
    if (!category) {
        return res.redirect('/podcast-ia?error=' + encodeURIComponent('Debes seleccionar una categoría'));
    }
    
    // Check quota (max 3 podcasts per user)
    const podcastCount = db.countGeneratedPodcastsByUserId(req.session.userId);
    if (podcastCount >= 3) {
        return res.redirect('/podcast-ia?error=' + encodeURIComponent('Has alcanzado el límite de 3 podcasts IA'));
    }
    
    try {
        // Create DB entry with processing status
        const title = `Noticias de ${category} - ${new Date().toLocaleDateString('es-ES')}`;
        const result = db.addGeneratedPodcast({
            user_id: req.session.userId,
            topic: category,
            title,
            status: 'processing'
        });
        
        const podcastId = result.lastInsertRowid;
        
        // Start generation in background
        generatePodcastInBackground(podcastId, category, voice || 'es-ES-AlvaroNeural', req.session.userId);
        
        res.redirect('/podcast-ia?success=' + encodeURIComponent('Podcast en generación. Esto puede tardar unos minutos.'));
    } catch (error) {
        console.error('Error creating podcast:', error);
        res.redirect('/podcast-ia?error=' + encodeURIComponent('Error al iniciar la generación: ' + error.message));
    }
});

// Helper function to wait for AI worker to be ready
async function waitForAIWorkerReady(maxWaitTime = 120000) {
    const startTime = Date.now();
    const checkInterval = 1000; // Check every second
    
    while (Date.now() - startTime < maxWaitTime) {
        const status = aiWorker.getStatus();
        if (status.ready) {
            return true;
        }
        
        // If worker is not running, try to initialize it
        if (!status.running) {
            try {
                console.log('[Podcast IA] Worker not running, initializing...');
                await aiWorker.initialize();
                return true;
            } catch (error) {
                console.error('[Podcast IA] Failed to initialize worker:', error);
                throw new Error('No se pudo inicializar el worker de IA');
            }
        }
        
        // Wait before checking again
        await new Promise(resolve => setTimeout(resolve, checkInterval));
    }
    
    throw new Error('Timeout esperando que el worker de IA esté listo');
}

// Background podcast generation function
async function generatePodcastInBackground(podcastId, category, voice, userId) {
    const downloadsDir = path.join(__dirname, '../downloads');
    const outputFileName = `podcast_ia_${podcastId}.mp3`;
    const outputPath = path.join(downloadsDir, outputFileName);
    
    try {
        console.log(`[Podcast IA] Starting generation for podcast ${podcastId}, category: ${category}`);
        
        // Wait for AI worker to be ready
        await waitForAIWorkerReady();
        
        // 1. Fetch articles from RSS feeds
        const articles = await rssService.prepareArticlesForPodcast(category, aiWorker, 5);
        
        if (articles.length === 0) {
            throw new Error('No se encontraron artículos en los feeds de esta categoría');
        }
        
        console.log(`[Podcast IA] Fetched ${articles.length} articles`);
        
        // 2. Generate podcast (script + audio) using AI worker
        const result = await aiWorker.generatePodcast(articles, outputPath, voice);
        
        console.log(`[Podcast IA] Generated podcast: ${result.output_path}`);
        
        // 3. Update DB with success
        db.updateGeneratedPodcastStatus(podcastId, 'ready', outputFileName, result.script);
        
        // 4. Send push notification
        sendPodcastReadyNotification(userId, podcastId);
        
    } catch (error) {
        console.error(`[Podcast IA] Error generating podcast ${podcastId}:`, error);
        db.updateGeneratedPodcastStatus(podcastId, 'error');
    }
}

// Send push notification when podcast is ready
async function sendPodcastReadyNotification(userId, podcastId) {
    if (!process.env.VAPID_PUBLIC_KEY) return;
    
    const subscriptions = db.getPushSubscriptionsByUserId(userId);
    const podcast = db.getGeneratedPodcastById(podcastId);
    
    if (!podcast || subscriptions.length === 0) return;
    
    const payload = JSON.stringify({
        title: '🎙️ Podcast IA Listo',
        body: `Tu podcast "${podcast.title}" está listo para escuchar`,
        url: '/podcast-ia'
    });
    
    for (const sub of subscriptions) {
        try {
            await webPush.sendNotification({
                endpoint: sub.endpoint,
                keys: {
                    auth: sub.keys_auth,
                    p256dh: sub.keys_p256dh
                }
            }, payload);
        } catch (error) {
            if (error.statusCode === 410) {
                db.deletePushSubscription(sub.endpoint);
            }
        }
    }
}

// Podcast IA: Delete podcast
app.post('/podcast-ia/delete/:id', requireAuth, async (req, res) => {
    const podcast = db.getGeneratedPodcastById(req.params.id);
    
    if (!podcast) {
        return res.redirect('/podcast-ia?error=' + encodeURIComponent('Podcast no encontrado'));
    }
    
    // Check ownership
    if (podcast.user_id !== req.session.userId && req.session.role !== 'admin') {
        return res.redirect('/podcast-ia?error=' + encodeURIComponent('No autorizado'));
    }
    
    // Delete file if exists
    if (podcast.file_path) {
        const filePath = path.join(__dirname, '../downloads', podcast.file_path);
        try {
            await fs.promises.unlink(filePath);
        } catch (err) {
            if (err.code !== 'ENOENT') {
                console.error(`Error deleting podcast file ${filePath}:`, err);
            }
        }
    }
    
    // Delete from DB
    db.deleteGeneratedPodcast(podcast.id);
    
    res.redirect('/podcast-ia');
});

// Podcast IA: Download podcast
app.get('/podcast-ia/download/:id', requireAuth, async (req, res) => {
    const podcast = db.getGeneratedPodcastById(req.params.id);
    
    if (!podcast) {
        return res.status(404).send('Podcast no encontrado');
    }
    
    // Check ownership
    if (podcast.user_id !== req.session.userId && req.session.role !== 'admin') {
        return res.status(403).send('No autorizado');
    }
    
    if (podcast.status !== 'ready' || !podcast.file_path) {
        return res.status(400).send('Podcast no disponible');
    }
    
    const filePath = path.join(__dirname, '../downloads', podcast.file_path);
    
    try {
        await fs.promises.access(filePath);
        res.download(filePath, `${podcast.title}.mp3`);
    } catch {
        return res.status(404).send('Archivo no encontrado');
    }
});

// ===============================
// ADMIN: RSS FEEDS MANAGEMENT
// ===============================

// Admin: Get all RSS feeds
app.get('/admin/feeds', requireAdmin, (req, res) => {
    const feeds = db.getAllRssFeeds();
    const categories = db.getRssFeedCategories();
    const generatedPodcasts = db.getAllGeneratedPodcasts();
    
    res.json({
        feeds,
        categories,
        generatedPodcasts
    });
});

// Admin: Add RSS feed
app.post('/admin/feeds', requireAdmin, (req, res) => {
    const { name, url, category, language } = req.body;
    
    if (!name || !url || !category) {
        return res.status(400).json({ error: 'Nombre, URL y categoría son requeridos' });
    }
    
    try {
        db.addRssFeed({ name, url, category, language: language || 'en' });
        res.json({ success: true, message: 'Feed agregado correctamente' });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Admin: Delete RSS feed
app.post('/admin/feeds/delete/:id', requireAdmin, (req, res) => {
    try {
        db.deleteRssFeed(req.params.id);
        res.json({ success: true, message: 'Feed eliminado correctamente' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Admin: Delete generated podcast
app.post('/admin/podcasts/delete/:id', requireAdmin, async (req, res) => {
    const podcast = db.getGeneratedPodcastById(req.params.id);
    
    if (!podcast) {
        return res.status(404).json({ error: 'Podcast no encontrado' });
    }
    
    // Delete file if exists
    if (podcast.file_path) {
        const filePath = path.join(__dirname, '../downloads', podcast.file_path);
        try {
            await fs.promises.unlink(filePath);
        } catch (err) {
            if (err.code !== 'ENOENT') {
                console.error(`Error deleting podcast file:`, err);
            }
        }
    }
    
    db.deleteGeneratedPodcast(podcast.id);
    res.json({ success: true, message: 'Podcast eliminado correctamente' });
});

app.listen(PORT, async () => {
    console.log(`Server running on http://localhost:${PORT}`);
    
    // Initialize AI worker in background
    try {
        console.log('[Startup] Initializing AI worker...');
        await aiWorker.initialize();
        console.log('[Startup] AI worker initialized successfully');
    } catch (error) {
        console.error('[Startup] Failed to initialize AI worker:', error);
        console.error('[Startup] AI features will not be available until worker is initialized');
    }
});
