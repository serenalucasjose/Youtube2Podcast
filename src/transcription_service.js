const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const EventEmitter = require('events');
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

const transcriptionEmitter = new EventEmitter();
transcriptionEmitter.setMaxListeners(50);

const DOWNLOADS_DIR = path.join(__dirname, '../downloads');
const SCRIPTS_DIR = path.join(__dirname, '../scripts');
const VENV_PYTHON = path.join(__dirname, '../venv/bin/python3');

// Buffer de logs en memoria para cada episodio en transcripción
const activeLogs = new Map();
const MAX_LOGS_PER_EPISODE = 100;

// Idiomas soportados (debe coincidir con process_transcription.py)
const SUPPORTED_LANGUAGES = {
    "en": "English",
    "es": "Español",
    "fr": "Français",
    "de": "Deutsch",
    "it": "Italiano",
    "pt": "Português",
    "nl": "Nederlands",
    "pl": "Polski",
    "ru": "Русский",
    "ja": "日本語",
    "ko": "한국어",
    "zh": "中文",
    "ar": "العربية",
    "hi": "हिन्दी",
    "tr": "Türkçe",
    "vi": "Tiếng Việt",
    "th": "ไทย",
    "id": "Bahasa Indonesia",
    "uk": "Українська",
    "sv": "Svenska",
    "da": "Dansk",
    "fi": "Suomi",
    "no": "Norsk"
};

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

/**
 * Añade un log al buffer de un episodio.
 */
function addLog(episodeId, message, type = 'info') {
    if (!activeLogs.has(episodeId)) {
        activeLogs.set(episodeId, { logs: [], lastUpdate: new Date() });
    }
    
    const logEntry = activeLogs.get(episodeId);
    logEntry.logs.push({
        timestamp: new Date().toISOString(),
        message,
        type
    });
    logEntry.lastUpdate = new Date();
    
    if (logEntry.logs.length > MAX_LOGS_PER_EPISODE) {
        logEntry.logs = logEntry.logs.slice(-MAX_LOGS_PER_EPISODE);
    }
}

/**
 * Obtiene los logs de un episodio.
 */
function getLogs(episodeId) {
    const entry = activeLogs.get(episodeId);
    return entry ? entry.logs : [];
}

/**
 * Limpia los logs de un episodio.
 */
function clearLogs(episodeId) {
    activeLogs.delete(episodeId);
}

/**
 * Inicia el proceso de transcripción para un episodio.
 * @param {number} episodeId - ID del episodio en la base de datos.
 * @param {string} language - Código de idioma (ej: 'en', 'es').
 * @param {boolean} force - Si es true, permite regenerar aunque ya exista una transcripción.
 * @returns {Promise<object>} - Episodio actualizado.
 */
async function startTranscription(episodeId, language = 'en', force = false) {
    const episode = db.getEpisodeById(episodeId);
    
    if (!episode) {
        throw new Error('Episodio no encontrado');
    }
    
    if (episode.status !== 'ready') {
        throw new Error('El episodio aún no está listo para transcribir');
    }
    
    if (episode.transcription_status === 'processing') {
        throw new Error('La transcripción ya está en proceso');
    }
    
    // Si ya está transcrito y no se fuerza, retornar el episodio existente
    if (episode.transcription_status === 'ready' && episode.transcription_file_path && !force) {
        return episode;
    }
    
    // Validar idioma
    if (!SUPPORTED_LANGUAGES[language]) {
        throw new Error(`Idioma no soportado: ${language}`);
    }
    
    // Si se fuerza regeneración, eliminar archivo anterior
    if (force && episode.transcription_file_path) {
        cleanupTranscriptionFile(episode);
        logInfo(`Archivo de transcripción anterior eliminado para regeneración: ${episode.transcription_file_path}`);
    }
    
    // Marcar como procesando
    db.updateTranscriptionStatusById(episodeId, 'processing');
    
    // Inicializar buffer de logs
    clearLogs(episodeId);
    addLog(episodeId, `Iniciando transcripción en ${SUPPORTED_LANGUAGES[language]}...`, 'info');
    
    transcriptionEmitter.emit('progress', {
        episodeId,
        videoId: episode.youtube_id,
        transcriptionStatus: 'processing',
        stage: 'start',
        percent: 0,
        message: 'Iniciando transcripción...'
    });
    
    // Iniciar proceso en background
    performTranscription(episode, language).catch(err => {
        logError('Error en transcripción:', err);
        db.updateTranscriptionStatusById(episodeId, 'error');
        transcriptionEmitter.emit('progress', {
            episodeId,
            videoId: episode.youtube_id,
            transcriptionStatus: 'error',
            stage: 'error',
            percent: -1,
            message: err.message
        });
    });
    
    // Retornar inmediatamente con estado actualizado
    return {
        ...episode,
        transcription_status: 'processing'
    };
}

/**
 * Ejecuta el pipeline de transcripción (STT -> PDF).
 */
async function performTranscription(episode, language = 'en') {
    const inputPath = path.join(DOWNLOADS_DIR, episode.file_path);
    const outputFileName = `${episode.youtube_id}_transcript_${language}.pdf`;
    const outputPath = path.join(DOWNLOADS_DIR, outputFileName);
    
    // Verificar que el archivo de entrada existe
    if (!fs.existsSync(inputPath)) {
        throw new Error(`Archivo de entrada no encontrado: ${inputPath}`);
    }
    
    // Determinar qué Python usar
    let pythonPath = VENV_PYTHON;
    if (!fs.existsSync(pythonPath)) {
        pythonPath = 'python3';
        logInfo('Usando Python del sistema (venv no encontrado)');
    }
    
    const scriptPath = path.join(SCRIPTS_DIR, 'process_transcription.py');
    
    return new Promise((resolve, reject) => {
        logInfo(`Iniciando transcripción: ${inputPath} -> ${outputPath} (${language})`);
        
        const pythonProcess = spawn(pythonPath, [
            scriptPath,
            inputPath,
            outputPath,
            '--language', language
        ], {
            cwd: path.join(__dirname, '..'),
            env: {
                ...process.env,
                OMP_NUM_THREADS: '4',
                MKL_NUM_THREADS: '4'
            }
        });
        
        let lastProgress = null;
        
        pythonProcess.stdout.on('data', (data) => {
            const lines = data.toString().split('\n').filter(l => l.trim());
            
            for (const line of lines) {
                try {
                    const progress = JSON.parse(line);
                    lastProgress = progress;
                    
                    // Ignorar el JSON de resultado final
                    if (progress.success !== undefined) {
                        logInfo(`[Transcription ${episode.youtube_id}] Resultado: ${JSON.stringify(progress)}`);
                        addLog(episode.id, `Resultado: ${progress.success ? 'Éxito' : 'Error'}`, progress.success ? 'info' : 'error');
                        continue;
                    }
                    
                    if (progress.stage !== undefined) {
                        addLog(episode.id, `[${progress.stage}] ${progress.percent}% - ${progress.message}`, 'progress');
                        
                        transcriptionEmitter.emit('progress', {
                            episodeId: episode.id,
                            videoId: episode.youtube_id,
                            transcriptionStatus: 'processing',
                            stage: progress.stage,
                            percent: progress.percent,
                            message: progress.message
                        });
                        
                        logInfo(`[Transcription ${episode.youtube_id}] ${progress.stage}: ${progress.percent}% - ${progress.message}`);
                    }
                } catch (e) {
                    addLog(episode.id, line, 'info');
                    logInfo(`[Transcription ${episode.youtube_id}] ${line}`);
                }
            }
        });
        
        pythonProcess.stderr.on('data', (data) => {
            const stderrText = data.toString().trim();
            if (stderrText) {
                addLog(episode.id, stderrText, 'error');
            }
            logError(`[Transcription ${episode.youtube_id}] stderr:`, stderrText);
        });
        
        pythonProcess.on('close', (code) => {
            if (code === 0) {
                if (fs.existsSync(outputPath)) {
                    db.updateTranscriptionStatusById(episode.id, 'ready', outputFileName);
                    
                    addLog(episode.id, 'Transcripción completada exitosamente', 'info');
                    
                    transcriptionEmitter.emit('progress', {
                        episodeId: episode.id,
                        videoId: episode.youtube_id,
                        transcriptionStatus: 'ready',
                        stage: 'done',
                        percent: 100,
                        message: 'Transcripción completada'
                    });
                    
                    logInfo(`Transcripción completada: ${outputPath}`);
                    
                    // Enviar notificación push
                    sendPushNotification(episode.user_id, episode.title, true);
                    
                    // Limpiar logs después de 5 minutos
                    setTimeout(() => clearLogs(episode.id), 5 * 60 * 1000);
                    
                    resolve(outputPath);
                } else {
                    const error = new Error('El archivo de salida no fue generado');
                    addLog(episode.id, 'Error: El archivo de salida no fue generado', 'error');
                    db.updateTranscriptionStatusById(episode.id, 'error');
                    sendPushNotification(episode.user_id, episode.title, false);
                    reject(error);
                }
            } else {
                const errorMsg = lastProgress?.message || `Proceso terminó con código ${code}`;
                const error = new Error(errorMsg);
                addLog(episode.id, `Error: ${errorMsg}`, 'error');
                db.updateTranscriptionStatusById(episode.id, 'error');
                sendPushNotification(episode.user_id, episode.title, false);
                reject(error);
            }
        });
        
        pythonProcess.on('error', (err) => {
            logError('Error spawning Python process:', err);
            db.updateTranscriptionStatusById(episode.id, 'error');
            reject(err);
        });
    });
}

/**
 * Envía notificación push al usuario cuando finaliza la transcripción.
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
            title: success ? '¡Transcripción lista!' : 'Error en transcripción',
            body: success 
                ? `La transcripción de "${title}" está lista para descargar` 
                : `Error al transcribir "${title}"`,
            icon: '/icons/logo.png',
            tag: 'transcription-complete',
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

/**
 * Elimina el archivo de transcripción de un episodio.
 */
function cleanupTranscriptionFile(episode) {
    if (episode.transcription_file_path) {
        const filePath = path.join(DOWNLOADS_DIR, episode.transcription_file_path);
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                logInfo(`Archivo de transcripción eliminado: ${filePath}`);
            }
        } catch (err) {
            logError(`Error eliminando archivo de transcripción ${filePath}:`, err);
        }
    }
}

module.exports = {
    startTranscription,
    cleanupTranscriptionFile,
    transcriptionEmitter,
    getLogs,
    clearLogs,
    SUPPORTED_LANGUAGES
};

