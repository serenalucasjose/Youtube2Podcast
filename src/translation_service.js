const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const EventEmitter = require('events');

const translationEmitter = new EventEmitter();

const DOWNLOADS_DIR = path.join(__dirname, '../downloads');
const SCRIPTS_DIR = path.join(__dirname, '../scripts');
const VENV_PYTHON = path.join(__dirname, '../venv/bin/python3');

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
 * Inicia el proceso de traducción para un episodio.
 * @param {number} episodeId - ID del episodio en la base de datos.
 * @returns {Promise<object>} - Episodio actualizado.
 */
async function startTranslation(episodeId) {
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
    translationEmitter.emit('progress', {
        episodeId,
        videoId: episode.youtube_id,
        translationStatus: 'processing',
        stage: 'start',
        percent: 0,
        message: 'Iniciando traducción...'
    });
    
    // Iniciar proceso en background
    performTranslation(episode).catch(err => {
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
 */
async function performTranslation(episode) {
    const inputPath = path.join(DOWNLOADS_DIR, episode.file_path);
    const outputFileName = `${episode.youtube_id}_es.wav`;
    const outputPath = path.join(DOWNLOADS_DIR, outputFileName);
    
    // Verificar que el archivo de entrada existe
    if (!fs.existsSync(inputPath)) {
        throw new Error(`Archivo de entrada no encontrado: ${inputPath}`);
    }
    
    // Determinar qué Python usar
    let pythonPath = VENV_PYTHON;
    if (!fs.existsSync(pythonPath)) {
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
            outputPath
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
                        continue;
                    }
                    
                    // Solo emitir si tiene los campos de progreso
                    if (progress.stage !== undefined) {
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
                    logInfo(`[Translation ${episode.youtube_id}] ${line}`);
                }
            }
        });
        
        pythonProcess.stderr.on('data', (data) => {
            logError(`[Translation ${episode.youtube_id}] stderr:`, data.toString());
        });
        
        pythonProcess.on('close', (code) => {
            if (code === 0) {
                // Verificar que el archivo de salida existe
                if (fs.existsSync(outputPath)) {
                    // Actualizar DB con estado ready
                    db.updateTranslationStatusById(episode.id, 'ready', outputFileName);
                    
                    translationEmitter.emit('progress', {
                        episodeId: episode.id,
                        videoId: episode.youtube_id,
                        translationStatus: 'ready',
                        stage: 'done',
                        percent: 100,
                        message: 'Traducción completada'
                    });
                    
                    logInfo(`Traducción completada: ${outputPath}`);
                    resolve(outputPath);
                } else {
                    const error = new Error('El archivo de salida no fue generado');
                    db.updateTranslationStatusById(episode.id, 'error');
                    reject(error);
                }
            } else {
                const errorMsg = lastProgress?.message || `Proceso terminó con código ${code}`;
                const error = new Error(errorMsg);
                db.updateTranslationStatusById(episode.id, 'error');
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
 * Elimina el archivo traducido de un episodio.
 * @param {object} episode - Objeto del episodio.
 */
function cleanupTranslatedFile(episode) {
    if (episode.translated_file_path) {
        const filePath = path.join(DOWNLOADS_DIR, episode.translated_file_path);
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                logInfo(`Archivo traducido eliminado: ${filePath}`);
            }
        } catch (err) {
            logError(`Error eliminando archivo traducido ${filePath}:`, err);
        }
    }
}

module.exports = {
    startTranslation,
    cleanupTranslatedFile,
    translationEmitter
};

