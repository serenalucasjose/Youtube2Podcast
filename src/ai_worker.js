/**
 * AI Worker Manager
 * 
 * Gestiona un proceso Python persistente que mantiene los modelos de IA
 * cargados en memoria. Esto elimina el tiempo de carga de ~20-30s por tarea.
 * 
 * Uso:
 *   const aiWorker = require('./ai_worker');
 *   await aiWorker.initialize();
 *   const result = await aiWorker.transcribe(inputPath, language);
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');

const SCRIPTS_DIR = path.join(__dirname, '../scripts');
const VENV_PYTHON = path.join(__dirname, '../venv/bin/python3');

class AIWorkerManager extends EventEmitter {
    constructor() {
        super();
        this.worker = null;
        this.isReady = false;
        this.pendingRequests = new Map();
        this.requestId = 0;
        this.buffer = '';
    }

    /**
     * Inicializa el worker Python.
     * @returns {Promise<void>}
     */
    async initialize() {
        if (this.worker) {
            console.log('[AIWorker] Worker ya inicializado');
            return;
        }

        // Determinar qué Python usar
        let pythonPath = VENV_PYTHON;
        try {
            await fs.promises.access(pythonPath);
        } catch {
            pythonPath = 'python3';
            console.log('[AIWorker] Usando Python del sistema');
        }

        const scriptPath = path.join(SCRIPTS_DIR, 'worker_ai.py');

        return new Promise((resolve, reject) => {
            console.log('[AIWorker] Iniciando worker Python...');

            this.worker = spawn(pythonPath, [scriptPath], {
                cwd: path.join(__dirname, '..'),
                env: {
                    ...process.env,
                    OMP_NUM_THREADS: '4',
                    MKL_NUM_THREADS: '4'
                },
                stdio: ['pipe', 'pipe', 'pipe']
            });

            this.worker.stdout.on('data', (data) => {
                this.handleOutput(data.toString());
            });

            this.worker.stderr.on('data', (data) => {
                console.error('[AIWorker] stderr:', data.toString().trim());
            });

            this.worker.on('close', (code) => {
                console.log(`[AIWorker] Worker cerrado con código ${code}`);
                this.isReady = false;
                this.worker = null;
                
                // Rechazar todas las solicitudes pendientes
                for (const [id, { reject }] of this.pendingRequests) {
                    reject(new Error('Worker cerrado inesperadamente'));
                }
                this.pendingRequests.clear();
            });

            this.worker.on('error', (err) => {
                console.error('[AIWorker] Error:', err);
                reject(err);
            });

            // Esperar mensaje "ready"
            const readyHandler = (status, message) => {
                if (status === 'ready') {
                    this.isReady = true;
                    this.removeListener('status', readyHandler);
                    console.log('[AIWorker] Worker listo');
                    resolve();
                } else if (status === 'error') {
                    this.removeListener('status', readyHandler);
                    reject(new Error(message));
                }
            };

            this.on('status', readyHandler);

            // Timeout de inicialización (2 minutos para cargar modelos)
            setTimeout(() => {
                if (!this.isReady) {
                    this.removeListener('status', readyHandler);
                    reject(new Error('Timeout esperando que el worker esté listo'));
                }
            }, 120000);
        });
    }

    /**
     * Procesa la salida del worker.
     */
    handleOutput(data) {
        this.buffer += data;
        
        // Procesar líneas completas
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop(); // Mantener línea incompleta en buffer

        for (const line of lines) {
            if (!line.trim()) continue;

            try {
                const json = JSON.parse(line);

                // Mensaje de estado
                if (json.status) {
                    this.emit('status', json.status, json.message);
                    continue;
                }

                // Mensaje de progreso
                if (json.stage !== undefined) {
                    this.emit('progress', json);
                    continue;
                }

                // Respuesta a solicitud
                if (json.success !== undefined) {
                    // Buscar solicitud pendiente más antigua
                    const [id, handler] = this.pendingRequests.entries().next().value || [];
                    if (id !== undefined) {
                        this.pendingRequests.delete(id);
                        if (json.success) {
                            handler.resolve(json.result);
                        } else {
                            handler.reject(new Error(json.error));
                        }
                    }
                }
            } catch (e) {
                // No es JSON válido, ignorar
                console.log('[AIWorker] Output:', line);
            }
        }
    }

    /**
     * Envía un trabajo al worker.
     */
    async sendJob(job) {
        if (!this.worker || !this.isReady) {
            throw new Error('Worker no está listo');
        }

        const id = ++this.requestId;

        return new Promise((resolve, reject) => {
            this.pendingRequests.set(id, { resolve, reject });
            this.worker.stdin.write(JSON.stringify(job) + '\n');
        });
    }

    /**
     * Transcribe audio.
     * @param {string} inputPath - Ruta al archivo de audio.
     * @param {string} language - Código de idioma.
     * @returns {Promise<object>} - Resultado de transcripción.
     */
    async transcribe(inputPath, language = 'en') {
        return this.sendJob({
            type: 'transcribe',
            input_path: inputPath,
            language
        });
    }

    /**
     * Traduce audio (transcribe + traduce + TTS).
     * @param {string} inputPath - Ruta al audio de entrada.
     * @param {string} outputPath - Ruta al audio de salida.
     * @param {string} voice - Voz de Edge TTS.
     * @returns {Promise<object>} - Resultado de traducción.
     */
    async translate(inputPath, outputPath, voice = 'es-ES-AlvaroNeural') {
        return this.sendJob({
            type: 'translate',
            input_path: inputPath,
            output_path: outputPath,
            voice
        });
    }

    /**
     * Verifica si el worker está funcionando.
     */
    async ping() {
        return this.sendJob({ type: 'ping' });
    }

    /**
     * Genera un guion de podcast a partir de artículos.
     * @param {Array} articles - Lista de artículos con title y summary.
     * @returns {Promise<object>} - Resultado con el script generado.
     */
    async generateScript(articles) {
        return this.sendJob({
            type: 'generate_script',
            articles
        });
    }

    /**
     * Genera un podcast completo (guion + audio) a partir de artículos.
     * @param {Array} articles - Lista de artículos con title y summary.
     * @param {string} outputPath - Ruta al archivo de audio de salida.
     * @param {string} voice - Voz de Edge TTS.
     * @returns {Promise<object>} - Resultado con script y ruta del audio.
     */
    async generatePodcast(articles, outputPath, voice = 'es-ES-AlvaroNeural') {
        return this.sendJob({
            type: 'generate_podcast',
            articles,
            output_path: outputPath,
            voice
        });
    }

    /**
     * Traduce texto de inglés a español.
     * @param {string} text - Texto a traducir.
     * @returns {Promise<object>} - Resultado con texto traducido.
     */
    async translateText(text) {
        return this.sendJob({
            type: 'translate_text',
            text
        });
    }

    /**
     * Cierra el worker de forma limpia.
     */
    async shutdown() {
        if (!this.worker) return;

        try {
            await this.sendJob({ type: 'shutdown' });
        } catch {
            // Ignorar errores al cerrar
        }

        this.worker.kill();
        this.worker = null;
        this.isReady = false;
    }

    /**
     * Obtiene el estado del worker.
     */
    getStatus() {
        return {
            running: !!this.worker,
            ready: this.isReady,
            pendingRequests: this.pendingRequests.size
        };
    }
}

// Singleton
const instance = new AIWorkerManager();

// Limpiar al cerrar la aplicación
process.on('SIGINT', async () => {
    console.log('[AIWorker] Cerrando worker...');
    await instance.shutdown();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('[AIWorker] Cerrando worker...');
    await instance.shutdown();
    process.exit(0);
});

module.exports = instance;

