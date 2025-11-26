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

const translationEmitter = new EventEmitter();
translationEmitter.setMaxListeners(50);

const DOWNLOADS_DIR = path.join(__dirname, '../downloads');
const SCRIPTS_DIR = path.join(__dirname, '../scripts');
const VENV_PYTHON = path.join(__dirname, '../venv/bin/python3');

// Buffer de logs en memoria para cada episodio en traducción
// Estructura: { episodeId: { logs: [], lastUpdate: Date } }
const activeLogs = new Map();

// Límite de logs por episodio para evitar uso excesivo de memoria
const MAX_LOGS_PER_EPISODE = 100;
const MAX_ACTIVE_EPISODES = 20;  // Límite global para prevenir memory leaks

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
 * Implementa límite global de episodios para prevenir memory leaks.
 * @param {number} episodeId - ID del episodio.
 * @param {string} message - Mensaje de log.
 * @param {string} type - Tipo de log: 'info', 'progress', 'error'.
 */
function addLog(episodeId, message, type = 'info') {
    // Limpiar episodios antiguos si excedemos el límite global
    if (!activeLogs.has(episodeId) && activeLogs.size >= MAX_ACTIVE_EPISODES) {
        let oldestId = null;
        let oldestTime = Infinity;
        
        for (const [id, entry] of activeLogs.entries()) {
            const entryTime = entry.lastUpdate.getTime();
            if (entryTime < oldestTime) {
                oldestTime = entryTime;
                oldestId = id;
            }
        }
        
        if (oldestId) {
            activeLogs.delete(oldestId);
        }
    }
    
    if (!activeLogs.has(episodeId)) {
        activeLogs.set(episodeId, { logs: [], lastUpdate: new Date() });
    }
    
    const now = new Date();
    const logEntry = activeLogs.get(episodeId);
    logEntry.logs.push({
        timestamp: now.toISOString(),
        message,
        type
    });
    logEntry.lastUpdate = now;
    
    // Limitar cantidad de logs
    if (logEntry.logs.length > MAX_LOGS_PER_EPISODE) {
        logEntry.logs = logEntry.logs.slice(-MAX_LOGS_PER_EPISODE);
    }
}

/**
 * Obtiene los logs de un episodio.
 * @param {number} episodeId - ID del episodio.
 * @returns {Array} - Array de logs.
 */
function getLogs(episodeId) {
    const entry = activeLogs.get(episodeId);
    return entry ? entry.logs : [];
}

/**
 * Limpia los logs de un episodio.
 * @param {number} episodeId - ID del episodio.
 */
function clearLogs(episodeId) {
    activeLogs.delete(episodeId);
}

/**
 * Inicia el proceso de traducción para un episodio.
 * @param {number} episodeId - ID del episodio en la base de datos.
 * @param {string} voice - Nombre de la voz de Edge TTS (ej: es-MX-JorgeNeural).
 * @returns {Promise<object>} - Episodio actualizado.
 */
async function startTranslation(episodeId, voice = 'es-ES-AlvaroNeural') {
    const episode = db.getEpisodeById(episodeId);
    
    if (!episode) {
        throw new Error('Episodio no encontrado');
    }
    
    if (episode.status !== 'ready') {
        throw new Error('El episodio aún no está listo para traducir');
    }
    
    if (episode.translation_status === 'processing') {
        throw new Error('La traducción ya está en proceso');
    }
    
    if (episode.translation_status === 'ready' && episode.translated_file_path) {
        // Ya está traducido
        return episode;
    }
    
    // Marcar como procesando
    db.updateTranslationStatusById(episodeId, 'processing');
    
    // Inicializar buffer de logs
    clearLogs(episodeId);
    addLog(episodeId, 'Iniciando traducción...', 'info');
    
    translationEmitter.emit('progress', {
        episodeId,
        videoId: episode.youtube_id,
        translationStatus: 'processing',
        stage: 'start',
        percent: 0,
        message: 'Iniciando traducción...'
    });
    
    // Iniciar proceso en background
    performTranslation(episode, voice).catch(err => {
        logError('Error en traducción:', err);
        db.updateTranslationStatusById(episodeId, 'error');
        translationEmitter.emit('progress', {
            episodeId,
            videoId: episode.youtube_id,
            translationStatus: 'error',
            stage: 'error',
            percent: -1,
            message: err.message
        });
    });
    
    // Retornar inmediatamente con estado actualizado
    return {
        ...episode,
        translation_status: 'processing'
    };
}

/**
 * Ejecuta el pipeline de traducción (STT -> Traducción -> TTS).
 * @param {object} episode - Objeto del episodio.
 * @param {string} voice - Nombre de la voz de Edge TTS.
 */
async function performTranslation(episode, voice = 'es-ES-AlvaroNeural') {
    const inputPath = path.join(DOWNLOADS_DIR, episode.file_path);
    // OPTIMIZACIÓN: Usar MP3 directamente (sin conversión WAV)
    // Ahorra ~600MB RAM por episodio
    const outputFileName = `${episode.youtube_id}_es.mp3`;
    const outputPath = path.join(DOWNLOADS_DIR, outputFileName);
    
    // Verificar que el archivo de entrada existe (async)
    try {
        await fs.promises.access(inputPath);
    } catch {
        throw new Error(`Archivo de entrada no encontrado: ${inputPath}`);
    }
    
    // Determinar qué Python usar (async)
    let pythonPath = VENV_PYTHON;
    try {
        await fs.promises.access(pythonPath);
    } catch {
        // Fallback a python3 del sistema
        pythonPath = 'python3';
        logInfo('Usando Python del sistema (venv no encontrado)');
    }
    
    const scriptPath = path.join(SCRIPTS_DIR, 'process_translation.py');
    
    return new Promise((resolve, reject) => {
        logInfo(`Iniciando traducción: ${inputPath} -> ${outputPath}`);
        
        const pythonProcess = spawn(pythonPath, [
            scriptPath,
            inputPath,
            outputPath,
            '--voice', voice
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
                    
                    // Ignorar el JSON de resultado final (tiene campo 'success')
                    if (progress.success !== undefined) {
                        logInfo(`[Translation ${episode.youtube_id}] Resultado: ${JSON.stringify(progress)}`);
                        addLog(episode.id, `Resultado: ${progress.success ? 'Éxito' : 'Error'}`, progress.success ? 'info' : 'error');
                        continue;
                    }
                    
                    // Solo emitir si tiene los campos de progreso
                    if (progress.stage !== undefined) {
                        // Añadir al buffer de logs
                        addLog(episode.id, `[${progress.stage}] ${progress.percent}% - ${progress.message}`, 'progress');
                        
                        translationEmitter.emit('progress', {
                            episodeId: episode.id,
                            videoId: episode.youtube_id,
                            translationStatus: 'processing',
                            stage: progress.stage,
                            percent: progress.percent,
                            message: progress.message
                        });
                        
                        logInfo(`[Translation ${episode.youtube_id}] ${progress.stage}: ${progress.percent}% - ${progress.message}`);
                    }
                } catch (e) {
                    // No es JSON, puede ser output normal
                    addLog(episode.id, line, 'info');
                    logInfo(`[Translation ${episode.youtube_id}] ${line}`);
                }
            }
        });
        
        pythonProcess.stderr.on('data', (data) => {
            const stderrText = data.toString().trim();
            if (stderrText) {
                addLog(episode.id, stderrText, 'error');
            }
            logError(`[Translation ${episode.youtube_id}] stderr:`, stderrText);
        });
        
        pythonProcess.on('close', async (code) => {
            if (code === 0) {
                // Verificar que el archivo de salida existe (async)
                let outputExists = false;
                try {
                    await fs.promises.access(outputPath);
                    outputExists = true;
                } catch {}
                
                if (outputExists) {
                    // Actualizar DB con estado ready
                    db.updateTranslationStatusById(episode.id, 'ready', outputFileName);
                    
                    addLog(episode.id, 'Traducción completada exitosamente', 'info');
                    
                    translationEmitter.emit('progress', {
                        episodeId: episode.id,
                        videoId: episode.youtube_id,
                        translationStatus: 'ready',
                        stage: 'done',
                        percent: 100,
                        message: 'Traducción completada'
                    });
                    
                    logInfo(`Traducción completada: ${outputPath}`);
                    
                    // Enviar notificación push al usuario
                    sendPushNotification(episode.user_id, episode.title, true);
                    
                    // Limpiar logs después de un tiempo (mantener por 5 minutos para consulta)
                    setTimeout(() => clearLogs(episode.id), 5 * 60 * 1000);
                    
                    resolve(outputPath);
                } else {
                    const error = new Error('El archivo de salida no fue generado');
                    addLog(episode.id, 'Error: El archivo de salida no fue generado', 'error');
                    db.updateTranslationStatusById(episode.id, 'error');
                    
                    // Enviar notificación push de error
                    sendPushNotification(episode.user_id, episode.title, false);
                    
                    reject(error);
                }
            } else {
                const errorMsg = lastProgress?.message || `Proceso terminó con código ${code}`;
                const error = new Error(errorMsg);
                addLog(episode.id, `Error: ${errorMsg}`, 'error');
                db.updateTranslationStatusById(episode.id, 'error');
                
                // Enviar notificación push de error
                sendPushNotification(episode.user_id, episode.title, false);
                
                reject(error);
            }
        });
        
        pythonProcess.on('error', (err) => {
            logError('Error spawning Python process:', err);
            db.updateTranslationStatusById(episode.id, 'error');
            reject(err);
        });
    });
}

/**
 * Envía notificación push al usuario cuando finaliza la traducción.
 * @param {number} userId - ID del usuario.
 * @param {string} title - Título del episodio.
 * @param {boolean} success - Si la traducción fue exitosa.
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
            title: success ? '¡Traducción lista!' : 'Error en traducción',
            body: success 
                ? `"${title}" está listo para escuchar en español` 
                : `Error al traducir "${title}"`,
            icon: '/icons/logo.png',
            tag: 'translation-complete',
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

/**
 * Elimina el archivo traducido de un episodio.
 * Usa operación async con fire-and-forget para no bloquear.
 * @param {object} episode - Objeto del episodio.
 */
function cleanupTranslatedFile(episode) {
    if (episode.translated_file_path) {
        const filePath = path.join(DOWNLOADS_DIR, episode.translated_file_path);
        fs.promises.unlink(filePath)
            .then(() => logInfo(`Archivo traducido eliminado: ${filePath}`))
            .catch(err => {
                if (err.code !== 'ENOENT') {
                    logError(`Error eliminando archivo traducido ${filePath}:`, err);
                }
            });
    }
}

module.exports = {
    startTranslation,
    cleanupTranslatedFile,
    translationEmitter,
    getLogs,
    clearLogs
};

