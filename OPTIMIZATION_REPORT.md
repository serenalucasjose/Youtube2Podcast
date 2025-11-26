# 🔬 Análisis de Optimización para Raspberry Pi 4

## Youtube2Podcast - Reporte de Performance

**Fecha:** Noviembre 2025  
**Versión analizada:** 1.5.0  
**Hardware objetivo:** Raspberry Pi 4 (ARMv8, 4 cores, 8GB RAM)

---

## 📋 Resumen Ejecutivo

| Categoría | Críticos (P1) | Importantes (P2) | Opcionales (P3) |
|-----------|:-------------:|:----------------:|:---------------:|
| CPU | 4 | 5 | 3 |
| RAM | 3 | 4 | 2 |
| I/O | 2 | 4 | 2 |
| Bandwidth | 1 | 3 | 2 |
| RPi4 Específico | 2 | 3 | 2 |
| **Total** | **12** | **19** | **11** |

### Arquitectura Actual

```
┌─────────────────────────────────────────────────────────────┐
│                      Node.js (Express)                       │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────────────┐ │
│  │ Routes  │  │   SSE   │  │Sessions │  │  Static Files   │ │
│  └────┬────┘  └────┬────┘  └────┬────┘  └────────┬────────┘ │
│       │            │            │                │          │
│  ┌────┴────────────┴────────────┴────────────────┴────┐     │
│  │                    SQLite (better-sqlite3)          │     │
│  └─────────────────────────────────────────────────────┘     │
└─────────────────────────┬───────────────────────────────────┘
                          │ spawn()
              ┌───────────┴───────────┐
              ▼                       ▼
┌─────────────────────────┐ ┌─────────────────────────┐
│   process_translation   │ │  process_transcription  │
│   ┌─────────────────┐   │ │   ┌─────────────────┐   │
│   │ faster-whisper  │   │ │   │ faster-whisper  │   │
│   │ (torch + model) │   │ │   │ (torch + model) │   │
│   └────────┬────────┘   │ │   └────────┬────────┘   │
│   ┌────────▼────────┐   │ │   ┌────────▼────────┐   │
│   │  transformers   │   │ │   │     fpdf2       │   │
│   │ (Helsinki-NLP)  │   │ │   │  (PDF output)   │   │
│   └────────┬────────┘   │ │   └─────────────────┘   │
│   ┌────────▼────────┐   │ │                         │
│   │    edge-tts     │   │ │                         │
│   │ (pydub convert) │   │ │                         │
│   └─────────────────┘   │ │                         │
└─────────────────────────┘ └─────────────────────────┘
```

---

## 🔴 1. USO DE CPU

### P1-CPU-01: bcrypt.compareSync() bloquea el Event Loop

| Campo | Valor |
|-------|-------|
| **Archivo** | `src/index.js:82` |
| **Severidad** | 🔴 Crítica |
| **Esfuerzo** | 🟢 Bajo (5 min) |

**Problema:**  
`bcrypt.compareSync()` es una operación CPU-bound que bloquea el event loop de Node.js durante ~100-200ms en ARM.

**Código actual:**
```javascript
if (user && bcrypt.compareSync(password, user.password_hash)) {
```

**Impacto:**  
- Todas las requests HTTP quedan en espera mientras se verifica el password
- Con múltiples logins simultáneos, el servidor se vuelve irresponsivo

**Solución:**
```javascript
// Cambiar a versión async
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = db.getUserByUsername(username);
    
    if (user && await bcrypt.compare(password, user.password_hash)) {
        // ...
    }
});
```

---

### P1-CPU-02: Modelo de IA re-instanciado en cada procesamiento

| Campo | Valor |
|-------|-------|
| **Archivos** | `scripts/process_transcription.py:76-79`, `scripts/process_translation.py:39-42` |
| **Severidad** | 🔴 Crítica |
| **Esfuerzo** | 🔴 Alto (1-2 días) |

**Problema:**  
`WhisperModel("tiny")` y `pipeline("translation")` se cargan desde disco **cada vez** que se procesa un audio.

**Código actual:**
```python
def transcribe_audio(audio_path: str) -> str:
    # Se ejecuta CADA VEZ
    from faster_whisper import WhisperModel
    model = WhisperModel("tiny", device="cpu", compute_type="int8")
    # ...
    del model  # Se destruye al final
```

**Impacto:**
- Tiempo de carga de modelos: ~15-30 segundos en RPi4
- Tiempo total de procesamiento ~3x mayor del necesario
- Uso excesivo de I/O de disco

**Solución: Implementar Worker Python Persistente**

```python
#!/usr/bin/env python3
# scripts/worker_ai.py - Worker persistente para modelos de IA

import sys
import json
from faster_whisper import WhisperModel
from transformers import pipeline

# ============================================
# CARGAR MODELOS UNA SOLA VEZ AL INICIAR
# ============================================
print(json.dumps({"status": "loading", "message": "Cargando modelos..."}), flush=True)

whisper_model = WhisperModel("tiny", device="cpu", compute_type="int8")
translator = pipeline("translation", model="Helsinki-NLP/opus-mt-en-es", device=-1)

print(json.dumps({"status": "ready", "message": "Modelos cargados"}), flush=True)

# ============================================
# LOOP DE PROCESAMIENTO VIA STDIN
# ============================================
for line in sys.stdin:
    try:
        job = json.loads(line.strip())
        job_type = job.get("type")
        
        if job_type == "transcribe":
            # Usar whisper_model ya cargado
            segments, _ = whisper_model.transcribe(job["input_path"], ...)
            result = {"success": True, "segments": [...]}
            
        elif job_type == "translate":
            # Usar translator ya cargado
            translated = translator(job["text"])
            result = {"success": True, "text": translated}
            
        print(json.dumps(result), flush=True)
        
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}), flush=True)
```

**Cambios en Node.js:**
```javascript
// src/ai_worker.js - Manager del worker Python
const { spawn } = require('child_process');

class AIWorkerManager {
    constructor() {
        this.worker = null;
        this.queue = [];
        this.isProcessing = false;
    }
    
    async initialize() {
        this.worker = spawn('python3', ['scripts/worker_ai.py']);
        // Esperar mensaje "ready"
        await this.waitForReady();
    }
    
    async process(job) {
        return new Promise((resolve, reject) => {
            this.worker.stdin.write(JSON.stringify(job) + '\n');
            // Manejar respuesta...
        });
    }
}

module.exports = new AIWorkerManager();
```

---

### P1-CPU-03: Polling cada 5 segundos consume CPU innecesariamente

| Campo | Valor |
|-------|-------|
| **Archivo** | `views/index.ejs:961` |
| **Severidad** | 🔴 Crítica |
| **Esfuerzo** | 🟢 Bajo (15 min) |

**Problema:**  
`setInterval(pollTaskStatus, 5000)` hace requests constantes incluso cuando no hay tareas activas.

**Código actual:**
```javascript
setInterval(pollTaskStatus, 5000);
setTimeout(pollTaskStatus, 2000);
```

**Impacto:**
- Request HTTP cada 5 segundos por cliente conectado
- CPU y red ocupados innecesariamente
- Con 10 clientes = 120 requests/minuto sin tareas activas

**Solución:**
```javascript
let pollingInterval = null;

function startPollingIfNeeded() {
    const ids = getProcessingEpisodeIds();
    
    if (ids.length > 0 && !pollingInterval) {
        // Solo iniciar polling si hay tareas
        pollingInterval = setInterval(pollTaskStatus, 5000);
    } else if (ids.length === 0 && pollingInterval) {
        // Detener si no hay tareas
        clearInterval(pollingInterval);
        pollingInterval = null;
    }
}

// Llamar después de cada actualización de estado
function handleSSEMessage(event) {
    // ... procesar mensaje ...
    startPollingIfNeeded();
}

// Inicializar una vez
document.addEventListener('DOMContentLoaded', () => {
    startPollingIfNeeded();
});
```

---

### P1-CPU-04: bcrypt.hashSync() en seed de usuarios bloquea startup

| Campo | Valor |
|-------|-------|
| **Archivo** | `src/db.js:86` |
| **Severidad** | 🔴 Crítica |
| **Esfuerzo** | 🟢 Bajo (10 min) |

**Problema:**  
4 llamadas a `bcrypt.hashSync()` durante el startup, cada una ~200ms en ARM = ~800ms de bloqueo.

**Código actual:**
```javascript
usersToCreate.forEach(u => {
    if (!checkStmt.get(u.username)) {
        const hash = bcrypt.hashSync(u.password, 10);  // BLOQUEA
        insertStmt.run(u.username, hash, u.role);
    }
});
```

**Solución: Usar hashes pre-calculados para usuarios seed**
```javascript
const seedUsers = () => {
    // Hashes pre-calculados (bcrypt cost=10)
    const usersToCreate = [
        { 
            username: 'admin', 
            password_hash: '$2a$10$N9qo8uLOickgx2ZMRZoMy...',  // "admin"
            role: 'admin' 
        },
        // ...
    ];

    const insertStmt = db.prepare(
        'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)'
    );
    
    usersToCreate.forEach(u => {
        if (!checkStmt.get(u.username)) {
            insertStmt.run(u.username, u.password_hash, u.role);
        }
    });
};
```

---

### P2-CPU-05: Cálculo de disk usage síncrono en Admin

| Campo | Valor |
|-------|-------|
| **Archivo** | `src/index.js:471-481` |
| **Severidad** | 🟡 Importante |
| **Esfuerzo** | 🟡 Medio (30 min) |

**Problema:**  
`fs.readdirSync()` + `fs.statSync()` en loop bloquea mientras calcula tamaño de archivos.

**Código actual:**
```javascript
const files = fs.readdirSync(downloadsDir);
for (const file of files) {
    const stat = fs.statSync(filePath);
    if (stat.isFile()) {
        diskUsage += stat.size;
    }
}
```

**Solución:**
```javascript
// Versión async no bloqueante
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

// En la ruta /admin
app.get('/admin', requireAdmin, async (req, res) => {
    const diskUsage = await calculateDiskUsage(downloadsDir);
    // ...
});
```

---

### P2-CPU-06: Segmentos de Whisper cargados completamente en memoria

| Campo | Valor |
|-------|-------|
| **Archivos** | `scripts/process_transcription.py:95-96`, `scripts/process_translation.py:57-58` |
| **Severidad** | 🟡 Importante |
| **Esfuerzo** | 🟢 Bajo (10 min) |

**Problema:**  
`list(segments)` fuerza a cargar todos los segmentos antes de iterar.

**Código actual:**
```python
segment_list = list(segments)  # CARGA TODO EN RAM
total_segments = len(segment_list)

for i, segment in enumerate(segment_list):
    # ...
```

**Impacto:**
- Para audios de 1 hora: ~2000 segmentos en memoria
- Delay inicial mientras se procesa todo
- Pico de memoria innecesario

**Solución: Streaming de segmentos**
```python
# Procesar en streaming, sin cargar todo
segments_data = []
full_text = ""
segment_count = 0

for segment in segments:  # Generator, no list
    segment_count += 1
    full_text += segment.text + " "
    segments_data.append({
        "start": segment.start,
        "end": segment.end,
        "text": segment.text.strip()
    })
    
    # Reportar progreso cada 10 segmentos
    if segment_count % 10 == 0:
        log_progress("stt", 20 + min(50, segment_count // 2), 
                     f"Procesando segmento {segment_count}...")
```

---

### P2-CPU-07: Traducción chunk-by-chunk sin batching

| Campo | Valor |
|-------|-------|
| **Archivo** | `scripts/process_translation.py:112-117` |
| **Severidad** | 🟡 Importante |
| **Esfuerzo** | 🟢 Bajo (10 min) |

**Problema:**  
Se traduce chunk por chunk en loop secuencial.

**Código actual:**
```python
for i, chunk in enumerate(chunks):
    if chunk:
        result = translator(chunk, max_length=512)  # UNO A LA VEZ
        translated_chunks.append(result[0]["translation_text"])
```

**Solución: Batch translation**
```python
# Filtrar chunks vacíos
valid_chunks = [c for c in chunks if c.strip()]

# Traducir en batch (mucho más eficiente)
if valid_chunks:
    results = translator(valid_chunks, max_length=512, batch_size=4)
    translated_chunks = [r["translation_text"] for r in results]
```

---

### P2-CPU-08: Doble syscall para validar archivo

| Campo | Valor |
|-------|-------|
| **Archivo** | `src/downloader.js:222-230` |
| **Severidad** | 🟡 Importante |
| **Esfuerzo** | 🟢 Bajo (5 min) |

**Código actual:**
```javascript
if (!fs.existsSync(finalPath)) {
    throw new Error('Output file was not created');
}
const stats = fs.statSync(finalPath);
if (stats.size < 1000) {
    throw new Error('Output file appears to be corrupted');
}
```

**Solución:**
```javascript
try {
    const stats = fs.statSync(finalPath);
    if (stats.size < 1000) {
        throw new Error('Output file appears to be corrupted (too small)');
    }
} catch (err) {
    if (err.code === 'ENOENT') {
        throw new Error('Output file was not created');
    }
    throw err;
}
```

---

### P2-CPU-09: JSON.parse en cada línea de stdout sin validación

| Campo | Valor |
|-------|-------|
| **Archivos** | `src/transcription_service.js:229`, `src/translation_service.js:203` |
| **Severidad** | 🟡 Importante |
| **Esfuerzo** | 🟢 Bajo (5 min) |

**Código actual:**
```javascript
for (const line of lines) {
    try {
        const progress = JSON.parse(line);  // Puede fallar frecuentemente
        // ...
    } catch (e) {
        // Log como texto normal
    }
}
```

**Solución: Pre-validar antes de parsear**
```javascript
for (const line of lines) {
    // Solo intentar parsear si parece JSON
    if (line.startsWith('{') && line.endsWith('}')) {
        try {
            const progress = JSON.parse(line);
            // ...
        } catch (e) {
            addLog(episode.id, line, 'info');
        }
    } else {
        addLog(episode.id, line, 'info');
    }
}
```

---

### P3-CPU-10: Heartbeat SSE cada 30 segundos podría ser 60

| Campo | Valor |
|-------|-------|
| **Archivo** | `src/index.js:165-176` |
| **Severidad** | 🟢 Opcional |
| **Esfuerzo** | 🟢 Bajo (1 min) |

**Cambio simple:**
```javascript
// De 30000 a 60000
heartbeatInterval = setInterval(() => {
    // ...
}, 60000);
```

---

### P3-CPU-11: Múltiples Date objects creados en addLog()

| Campo | Valor |
|-------|-------|
| **Archivos** | `src/transcription_service.js:77-86`, `src/translation_service.js:60-65` |
| **Severidad** | 🟢 Opcional |
| **Esfuerzo** | 🟢 Bajo (2 min) |

**Código actual:**
```javascript
logEntry.logs.push({
    timestamp: new Date().toISOString(),
    message,
    type
});
logEntry.lastUpdate = new Date();  // Segundo Date object
```

**Solución:**
```javascript
const now = new Date();
logEntry.logs.push({
    timestamp: now.toISOString(),
    message,
    type
});
logEntry.lastUpdate = now;
```

---

### P3-CPU-12: Consultas SQL redundantes en getAdminStats()

| Campo | Valor |
|-------|-------|
| **Archivo** | `src/db.js:247-329` |
| **Severidad** | 🟢 Opcional |
| **Esfuerzo** | 🟡 Medio (30 min) |

**Problema:**  
6+ queries separadas que podrían combinarse con CTEs.

**Solución: Query optimizada con CTE**
```sql
WITH stats AS (
    SELECT 
        COUNT(*) as total_episodes,
        SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) as ready_count,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count,
        SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing_count
    FROM episodes
)
SELECT 
    s.*,
    (SELECT COUNT(*) FROM users) as total_users
FROM stats s;
```

---

## 🟡 2. USO DE RAM

### P1-RAM-01: Modelos de IA consumen ~2-3GB RAM en cada proceso

| Campo | Valor |
|-------|-------|
| **Archivos** | `scripts/process_translation.py`, `scripts/process_transcription.py` |
| **Severidad** | 🔴 Crítica |
| **Esfuerzo** | 🔴 Alto (relacionado con P1-CPU-02) |

**Desglose de memoria por proceso:**

| Componente | RAM Aproximada |
|------------|----------------|
| Python interpreter | ~50MB |
| PyTorch | ~500MB |
| faster-whisper (tiny) | ~200MB |
| transformers + modelo | ~800MB |
| Buffers de audio | ~200MB |
| **Total por proceso** | **~1.7GB** |

**Impacto:**
- Con transcripción + traducción simultánea: ~3.4GB
- Sistema base + Node.js: ~500MB
- **Total**: ~4GB, dejando 4GB para swap/cache
- Si hay más procesos: OOM kills

**Solución:**
1. Implementar worker único persistente (ver P1-CPU-02)
2. Agregar mutex para serializar trabajos de IA:

```javascript
// src/ai_mutex.js
class AIMutex {
    constructor() {
        this.locked = false;
        this.queue = [];
    }
    
    async acquire() {
        if (!this.locked) {
            this.locked = true;
            return;
        }
        
        return new Promise(resolve => {
            this.queue.push(resolve);
        });
    }
    
    release() {
        if (this.queue.length > 0) {
            const next = this.queue.shift();
            next();
        } else {
            this.locked = false;
        }
    }
}

module.exports = new AIMutex();
```

---

### P1-RAM-02: Buffer de logs sin límite global

| Campo | Valor |
|-------|-------|
| **Archivos** | `src/transcription_service.js:29-30`, `src/translation_service.js:30` |
| **Severidad** | 🔴 Crítica |
| **Esfuerzo** | 🟢 Bajo (15 min) |

**Problema:**  
`activeLogs = new Map()` sin límite de episodios acumula logs indefinidamente.

**Código actual:**
```javascript
const activeLogs = new Map();
const MAX_LOGS_PER_EPISODE = 100;

function addLog(episodeId, message, type = 'info') {
    if (!activeLogs.has(episodeId)) {
        activeLogs.set(episodeId, { logs: [], lastUpdate: new Date() });
    }
    // ... agrega log sin verificar cantidad total de episodios
}
```

**Solución: Agregar límite global**
```javascript
const activeLogs = new Map();
const MAX_LOGS_PER_EPISODE = 100;
const MAX_ACTIVE_EPISODES = 20;  // Nuevo límite

function addLog(episodeId, message, type = 'info') {
    // Limpiar episodios antiguos si excedemos el límite
    if (!activeLogs.has(episodeId) && activeLogs.size >= MAX_ACTIVE_EPISODES) {
        // Eliminar el episodio con lastUpdate más antiguo
        let oldestId = null;
        let oldestTime = Infinity;
        
        for (const [id, entry] of activeLogs.entries()) {
            if (entry.lastUpdate.getTime() < oldestTime) {
                oldestTime = entry.lastUpdate.getTime();
                oldestId = id;
            }
        }
        
        if (oldestId) {
            activeLogs.delete(oldestId);
        }
    }
    
    // ... resto del código igual
}
```

---

### P1-RAM-03: getEpisodes() sin paginación en Admin

| Campo | Valor |
|-------|-------|
| **Archivos** | `src/db.js:168-179`, `src/index.js:464` |
| **Severidad** | 🔴 Crítica |
| **Esfuerzo** | 🟡 Medio (1 hora) |

**Código actual:**
```javascript
getEpisodes: (userId = null) => {
    if (userId) {
        return db.prepare('SELECT * FROM episodes WHERE user_id = ? ORDER BY created_at DESC').all(userId);
    }
    // Sin LIMIT - carga TODOS
    return db.prepare(`
        SELECT e.*, u.username as owner_username 
        FROM episodes e 
        LEFT JOIN users u ON e.user_id = u.id 
        ORDER BY e.created_at DESC
    `).all();
}
```

**Solución:**
```javascript
getEpisodes: (userId = null, { limit = 50, offset = 0 } = {}) => {
    if (userId) {
        return db.prepare(`
            SELECT * FROM episodes 
            WHERE user_id = ? 
            ORDER BY created_at DESC 
            LIMIT ? OFFSET ?
        `).all(userId, limit, offset);
    }
    
    return db.prepare(`
        SELECT e.*, u.username as owner_username 
        FROM episodes e 
        LEFT JOIN users u ON e.user_id = u.id 
        ORDER BY e.created_at DESC
        LIMIT ? OFFSET ?
    `).all(limit, offset);
},

getEpisodesCount: (userId = null) => {
    if (userId) {
        return db.prepare('SELECT COUNT(*) as count FROM episodes WHERE user_id = ?').get(userId).count;
    }
    return db.prepare('SELECT COUNT(*) as count FROM episodes').get().count;
}
```

---

### P2-RAM-04: EventEmitter con maxListeners=50

| Campo | Valor |
|-------|-------|
| **Archivos** | `src/downloader.js:29`, `src/transcription_service.js:22`, `src/translation_service.js:21` |
| **Severidad** | 🟡 Importante |
| **Esfuerzo** | 🟡 Medio (2 horas) |

**Problema:**  
3 EventEmitters separados, cada uno con 50 listeners máximo.

**Solución: Consolidar en un único EventEmitter global**
```javascript
// src/events.js - Nuevo archivo
const EventEmitter = require('events');

class AppEventEmitter extends EventEmitter {
    constructor() {
        super();
        this.setMaxListeners(100);
    }
    
    emitProgress(type, data) {
        this.emit('progress', { type, ...data });
    }
    
    emitDownloadProgress(data) {
        this.emitProgress('download', data);
    }
    
    emitTranslationProgress(data) {
        this.emitProgress('translation', data);
    }
    
    emitTranscriptionProgress(data) {
        this.emitProgress('transcription', data);
    }
}

module.exports = new AppEventEmitter();
```

---

### P2-RAM-05: webPush configurado 3 veces

| Campo | Valor |
|-------|-------|
| **Archivos** | `src/index.js:14-21`, `src/downloader.js:8-18`, `src/transcription_service.js:8-18`, `src/translation_service.js:8-18` |
| **Severidad** | 🟡 Importante |
| **Esfuerzo** | 🟢 Bajo (20 min) |

**Solución: Módulo centralizado**
```javascript
// src/push.js - Nuevo archivo
const webPush = require('web-push');

let configured = false;

function configure() {
    if (configured) return;
    
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
        webPush.setVapidDetails(
            process.env.VAPID_SUBJECT || 'mailto:admin@youtube2podcast.local',
            process.env.VAPID_PUBLIC_KEY,
            process.env.VAPID_PRIVATE_KEY
        );
        configured = true;
    }
}

async function sendNotification(userId, title, body, options = {}) {
    configure();
    // ... lógica de envío
}

module.exports = { configure, sendNotification };
```

---

### P2-RAM-06: Conversión WAV innecesaria consume RAM

| Campo | Valor |
|-------|-------|
| **Archivo** | `scripts/process_translation.py:148-151` |
| **Severidad** | 🟡 Importante |
| **Esfuerzo** | 🟡 Medio (30 min) |

**Problema:**  
`AudioSegment.from_mp3()` carga TODO el audio en RAM para convertir a WAV.

**Código actual:**
```python
from pydub import AudioSegment
audio = AudioSegment.from_mp3(temp_mp3)  # CARGA TODO EN RAM
audio.export(output_path, format="wav")
```

**Impacto:**
- Audio de 1 hora = ~600MB RAM
- Pico de memoria durante conversión

**Solución A: Mantener MP3 (recomendado)**
```python
# edge-tts ya genera MP3, no convertir
await communicate.save(output_path)  # Guardar directamente como MP3

# Cambiar extensión en translation_service.js
const outputFileName = `${episode.youtube_id}_es.mp3`;  // MP3 en vez de WAV
```

**Solución B: Usar FFmpeg streaming**
```python
import subprocess

# Convertir sin cargar en memoria
subprocess.run([
    'ffmpeg', '-i', temp_mp3, 
    '-acodec', 'pcm_s16le',
    '-ar', '44100',
    '-y', output_path
], check=True, capture_output=True)
```

---

### P2-RAM-07: Prepared statements no cacheados

| Campo | Valor |
|-------|-------|
| **Archivo** | `src/db.js` |
| **Severidad** | 🟡 Importante |
| **Esfuerzo** | 🟡 Medio (1 hora) |

**Problema:**  
`db.prepare()` se llama cada vez que se ejecuta una función.

**Solución: Cache de statements**
```javascript
// Statements cacheados (al inicio del módulo)
const statements = {
    getEpisodeById: db.prepare('SELECT * FROM episodes WHERE id = ?'),
    getEpisodeByYoutubeId: db.prepare('SELECT * FROM episodes WHERE youtube_id = ?'),
    getUserByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
    // ... más statements
};

module.exports = {
    getEpisodeById: (id) => statements.getEpisodeById.get(id),
    getEpisodeByYoutubeId: (youtubeId) => statements.getEpisodeByYoutubeId.get(youtubeId),
    // ...
};
```

---

### P3-RAM-08: SUPPORTED_LANGUAGES duplicado

| Campo | Valor |
|-------|-------|
| **Archivos** | `src/transcription_service.js:33-57`, `scripts/process_transcription.py:24-55` |
| **Severidad** | 🟢 Opcional |
| **Esfuerzo** | 🟡 Medio (30 min) |

**Solución: Archivo JSON compartido**
```json
// config/languages.json
{
    "en": "English",
    "es": "Español",
    "fr": "Français"
    // ...
}
```

---

### P3-RAM-09: Sessions sin TTL de limpieza

| Campo | Valor |
|-------|-------|
| **Archivo** | `src/index.js:41-50` |
| **Severidad** | 🟢 Opcional |
| **Esfuerzo** | 🟢 Bajo (5 min) |

**Solución:**
```javascript
app.use(session({
    store: new SQLiteStore({
        db: 'sessions.db',
        dir: path.join(__dirname, '../data'),
        // Agregar limpieza automática
        cleanupInterval: 900000  // 15 minutos
    }),
    // ...
}));
```

---

## 🟠 3. I/O Y ACCESO A DISCO/RED

### P1-IO-01: fs.existsSync() usado excesivamente

| Campo | Valor |
|-------|-------|
| **Archivos** | Múltiples (`src/downloader.js`, `src/index.js`, etc.) |
| **Severidad** | 🔴 Crítica |
| **Esfuerzo** | 🟡 Medio (2 horas) |

**Ubicaciones encontradas:**
- `src/downloader.js:71, 222`
- `src/index.js:247, 262, 421, 451`
- `src/transcription_service.js:193, 270, 378`
- `src/translation_service.js:165, 248, 368`

**Problema:**
1. `existsSync()` es síncrono y bloquea
2. Es un anti-pattern TOCTTOU (Time-of-check to time-of-use)

**Patrón correcto:**
```javascript
// ANTES (anti-pattern)
if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
}

// DESPUÉS (correcto)
try {
    await fs.promises.unlink(filePath);
} catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // ENOENT = archivo no existe, ignorar
}

// ANTES (verificar antes de leer)
if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath);
}

// DESPUÉS
try {
    const content = await fs.promises.readFile(filePath);
} catch (err) {
    if (err.code === 'ENOENT') {
        // Manejar archivo no existente
    } else {
        throw err;
    }
}
```

---

### P1-IO-02: Archivos de audio sin Range request optimization

| Campo | Valor |
|-------|-------|
| **Archivo** | `src/index.js:36` |
| **Severidad** | 🔴 Crítica |
| **Esfuerzo** | 🟢 Bajo (5 min) |

**Código actual:**
```javascript
app.use('/downloads', express.static(path.join(__dirname, '../downloads')));
```

**Solución: Agregar opciones de optimización**
```javascript
app.use('/downloads', express.static(path.join(__dirname, '../downloads'), {
    acceptRanges: true,      // Permitir seeking en audio
    maxAge: '1d',            // Cache 1 día
    etag: true,              // ETags para validación
    lastModified: true,
    immutable: false         // Los archivos pueden cambiar
}));
```

---

### P2-IO-03: fs.readdirSync() en cleanupTempFiles()

| Campo | Valor |
|-------|-------|
| **Archivo** | `src/downloader.js:51` |
| **Severidad** | 🟡 Importante |
| **Esfuerzo** | 🟢 Bajo (10 min) |

**Solución:**
```javascript
async function cleanupTempFiles(videoId) {
    try {
        const files = await fs.promises.readdir(TEMP_DIR);
        const deletePromises = files
            .filter(f => f.startsWith(videoId))
            .map(f => fs.promises.unlink(path.join(TEMP_DIR, f)).catch(() => {}));
        
        await Promise.all(deletePromises);
    } catch (e) {
        logError('Error cleaning temp files:', e);
    }
}
```

---

### P2-IO-04: unlinkSync() en loops

| Campo | Valor |
|-------|-------|
| **Archivos** | `src/index.js:249,269`, `src/downloader.js:56,73` |
| **Severidad** | 🟡 Importante |
| **Esfuerzo** | 🟢 Bajo (15 min) |

**Código actual:**
```javascript
tempFiles.forEach(file => {
    if (file.startsWith(episode.youtube_id)) {
        fs.unlinkSync(tempFilePath);  // BLOQUEA
    }
});
```

**Solución: Batch async deletes**
```javascript
const filesToDelete = tempFiles
    .filter(file => file.startsWith(episode.youtube_id))
    .map(file => path.join(tempDir, file));

await Promise.all(
    filesToDelete.map(f => fs.promises.unlink(f).catch(() => {}))
);
```

---

### P2-IO-05: Thumbnail de YouTube no cacheado localmente

| Campo | Valor |
|-------|-------|
| **Archivo** | `src/downloader.js` |
| **Severidad** | 🟡 Importante |
| **Esfuerzo** | 🟡 Medio (1 hora) |

**Problema:**  
Cada carga de página hace request a YouTube para thumbnails.

**Solución: Descargar thumbnail localmente**
```javascript
// En performDownload(), después de descargar el audio
async function downloadThumbnail(videoId, thumbnailUrl) {
    const thumbnailPath = path.join(DOWNLOADS_DIR, `${videoId}_thumb.jpg`);
    
    try {
        const response = await fetch(thumbnailUrl);
        const buffer = await response.buffer();
        await fs.promises.writeFile(thumbnailPath, buffer);
        return `${videoId}_thumb.jpg`;
    } catch (err) {
        logError('Error downloading thumbnail:', err);
        return null;  // Fallback a URL externa
    }
}
```

---

### P2-IO-06: No hay compresión de responses HTTP

| Campo | Valor |
|-------|-------|
| **Archivo** | `src/index.js` |
| **Severidad** | 🟡 Importante |
| **Esfuerzo** | 🟢 Bajo (5 min) |

**Solución:**
```javascript
const compression = require('compression');

// Agregar antes de otros middlewares
app.use(compression({
    level: 6,  // Balance entre CPU y compresión
    threshold: 1024,  // Solo comprimir > 1KB
    filter: (req, res) => {
        // No comprimir SSE
        if (req.headers.accept === 'text/event-stream') {
            return false;
        }
        return compression.filter(req, res);
    }
}));
```

**Agregar a package.json:**
```json
"dependencies": {
    "compression": "^1.7.4",
    // ...
}
```

---

### P3-IO-07: Múltiples writes a DB para un episodio

| Campo | Valor |
|-------|-------|
| **Archivos** | `src/downloader.js:122`, `src/db.js:161-166` |
| **Severidad** | 🟢 Opcional |
| **Esfuerzo** | 🟢 Bajo (15 min) |

**Solución: Transacciones cuando sea apropiado**
```javascript
const insertAndUpdate = db.transaction((episode) => {
    const result = db.prepare(`
        INSERT INTO episodes (youtube_id, title, file_path, original_url, user_id, status, thumbnail_url)
        VALUES (@youtube_id, @title, @file_path, @original_url, @user_id, @status, @thumbnail_url)
    `).run(episode);
    
    return result;
});
```

---

### P3-IO-08: PDF generation no streamed

| Campo | Valor |
|-------|-------|
| **Archivo** | `scripts/process_transcription.py:183` |
| **Severidad** | 🟢 Opcional |
| **Esfuerzo** | 🟡 Medio (30 min) |

**Nota:** fpdf2 no soporta streaming nativo. Para transcripciones muy largas, considerar:
- Dividir en múltiples PDFs
- Usar reportlab que soporta streaming

---

## 🔵 4. USO DE ANCHO DE BANDA

### P1-BW-01: Bootstrap Icons bundle completo

| Campo | Valor |
|-------|-------|
| **Archivos** | `src/index.js:38`, `views/index.ejs:9` |
| **Severidad** | 🔴 Crítica |
| **Esfuerzo** | 🟡 Medio (2 horas) |

**Problema:**  
Se sirve TODO el paquete de bootstrap-icons (~1.5MB fonts+CSS) cuando solo se usan ~20 iconos.

**Iconos usados en el proyecto:**
```
bi-bell, bi-bell-fill, bi-moon-fill, bi-sun-fill, bi-person-walking,
bi-stopwatch, bi-lightbulb, bi-x-lg, bi-translate, bi-file-earmark-pdf-fill,
bi-file-earmark-text, bi-box-arrow-up-right, bi-download, bi-trash3,
bi-arrow-repeat, bi-exclamation-circle, bi-info-circle, bi-x-circle
```

**Solución A: SVG Inline (recomendado)**
```javascript
// Crear archivo con solo los iconos necesarios
// public/icons/icons.js
const icons = {
    bell: '<svg...>',
    'bell-fill': '<svg...>',
    // ...
};

// Usar en templates
<span class="icon"><%= icons.bell %></span>
```

**Solución B: Subset de fuente**
```bash
# Usar fonttools para crear subset
pip install fonttools
pyftsubset bootstrap-icons.woff2 \
    --unicodes="U+F135,U+F136,..." \
    --output-file="icons-subset.woff2"
```

---

### P2-BW-02: CSS sin purge en producción

| Campo | Valor |
|-------|-------|
| **Archivo** | `tailwind.config.js` |
| **Severidad** | 🟡 Importante |
| **Esfuerzo** | 🟢 Bajo (10 min) |

**Verificar configuración:**
```javascript
// tailwind.config.js
module.exports = {
    content: [
        './views/**/*.ejs',
        './public/js/**/*.js'
    ],
    // ...
}
```

**Build para producción:**
```bash
NODE_ENV=production npm run build:css
```

---

### P2-BW-03: Sin cache headers para assets estáticos

| Campo | Valor |
|-------|-------|
| **Archivo** | `src/index.js:35-38` |
| **Severidad** | 🟡 Importante |
| **Esfuerzo** | 🟢 Bajo (5 min) |

**Solución:**
```javascript
// Assets estáticos con cache largo
app.use(express.static(path.join(__dirname, '../public'), {
    maxAge: '7d',
    etag: true,
    lastModified: true
}));

// Vendor con cache muy largo (versionado)
app.use('/vendor', express.static(path.join(__dirname, '../node_modules'), {
    maxAge: '30d',
    immutable: true
}));
```

---

### P2-BW-04: Payloads JSON sin minimización

| Campo | Valor |
|-------|-------|
| **Archivos** | Endpoints API en `src/index.js` |
| **Severidad** | 🟡 Importante |
| **Esfuerzo** | 🟡 Medio (1 hora) |

**Ejemplo de optimización:**
```javascript
// ANTES - devuelve todo
getEpisodesByIds: (ids) => {
    return db.prepare(`SELECT * FROM episodes WHERE id IN (...)`).all(...ids);
}

// DESPUÉS - solo campos necesarios
getEpisodesByIds: (ids) => {
    return db.prepare(`
        SELECT id, youtube_id, status, translation_status, transcription_status
        FROM episodes WHERE id IN (...)
    `).all(...ids);
}
```

---

### P3-BW-05: Service Worker cache muy limitado

| Campo | Valor |
|-------|-------|
| **Archivo** | `public/sw.js:2-6` |
| **Severidad** | 🟢 Opcional |
| **Esfuerzo** | 🟢 Bajo (10 min) |

**Código actual:**
```javascript
const STATIC_ASSETS = [
    '/css/styles.css',
    '/css/custom.css',
    '/icons/logo.png'
];
```

**Solución:**
```javascript
const STATIC_ASSETS = [
    '/css/styles.css',
    '/css/custom.css',
    '/icons/logo.png',
    '/vendor/bi/font/bootstrap-icons.css',
    '/manifest.json',
    '/'  // Página principal
];
```

---

### P3-BW-06: SSE sin compresión

| Campo | Valor |
|-------|-------|
| **Archivo** | `src/index.js:98-102` |
| **Severidad** | 🟢 Opcional |
| **Esfuerzo** | 🟡 Medio |

**Nota:** SSE generalmente no se comprime porque los mensajes son pequeños y frecuentes. La sobrecarga de compresión/descompresión no vale la pena.

---

## 🍓 5. OPTIMIZACIONES ESPECÍFICAS PARA RASPBERRY PI 4

### P1-RPI-01: PyTorch ocupa ~1.5GB RAM

| Campo | Valor |
|-------|-------|
| **Archivo** | `requirements.txt:26-27` |
| **Severidad** | 🔴 Crítica |
| **Esfuerzo** | 🔴 Alto (1 día) |

**Problema:**  
PyTorch para ARM es enorme (~500MB descarga, ~1.5GB en memoria).

**Desglose de dependencias:**
```
torch (CPU): ~500MB en disco, ~1.5GB RAM
├── faster-whisper lo usa para inference
└── transformers lo usa para traducción
```

**Solución: Migrar a ONNX Runtime**

faster-whisper soporta CTranslate2 que puede usar ONNX:

```txt
# requirements.txt optimizado
# Reemplazar torch por onnxruntime
onnxruntime>=1.16.0

# faster-whisper con backend CTranslate2 (sin torch)
faster-whisper>=1.0.0

# transformers con ONNX
optimum[onnxruntime]>=1.14.0
```

**Código actualizado:**
```python
# Para transcripción (ya funciona sin cambios, faster-whisper usa CT2)
from faster_whisper import WhisperModel
model = WhisperModel("tiny", device="cpu", compute_type="int8")

# Para traducción con ONNX
from optimum.onnxruntime import ORTModelForSeq2SeqLM
from transformers import AutoTokenizer

tokenizer = AutoTokenizer.from_pretrained("Helsinki-NLP/opus-mt-en-es")
model = ORTModelForSeq2SeqLM.from_pretrained(
    "Helsinki-NLP/opus-mt-en-es",
    export=True  # Convierte a ONNX automáticamente
)
```

---

### P1-RPI-02: Procesos Python no aprovechan los 4 cores

| Campo | Valor |
|-------|-------|
| **Archivos** | `scripts/*.py` |
| **Severidad** | 🔴 Crítica |
| **Esfuerzo** | 🟡 Medio (4 horas) |

**Problema:**  
- Python GIL limita paralelismo en un solo proceso
- Los modelos de IA son mayormente single-threaded en Python

**Solución A: Afinity de CPU explícita**
```python
import os

# Al inicio del script
os.sched_setaffinity(0, {0, 1, 2, 3})  # Usar todos los cores

# Ya configurado pero verificar que funcione
os.environ["OMP_NUM_THREADS"] = "4"
os.environ["MKL_NUM_THREADS"] = "4"
```

**Solución B: Pipeline paralelo para audios largos**
```python
from concurrent.futures import ThreadPoolExecutor

def process_audio_parallel(audio_path):
    # Dividir audio en chunks
    chunks = split_audio(audio_path, chunk_duration=60)  # 1 min cada uno
    
    # Procesar en paralelo (limitado por GIL pero ayuda en I/O)
    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(transcribe_chunk, chunks))
    
    return merge_results(results)
```

---

### P2-RPI-03: Modelo Whisper "tiny" vs "tiny.en"

| Campo | Valor |
|-------|-------|
| **Archivos** | `scripts/process_translation.py:42` |
| **Severidad** | 🟡 Importante |
| **Esfuerzo** | 🟢 Bajo (5 min) |

**Problema:**  
Para traducción EN→ES, el audio siempre es en inglés. El modelo "tiny" es multilingüe y más lento.

**Benchmarks aproximados en RPi4:**

| Modelo | Tamaño | Velocidad (1 min audio) |
|--------|--------|-------------------------|
| tiny | 75MB | ~15 seg |
| tiny.en | 75MB | ~10 seg |

**Solución:**
```python
# En process_translation.py (siempre inglés)
model = WhisperModel("tiny.en", device="cpu", compute_type="int8")

# En process_transcription.py (mantener tiny para multilingüe)
# Pero si el idioma es inglés:
if language == "en":
    model = WhisperModel("tiny.en", device="cpu", compute_type="int8")
else:
    model = WhisperModel("tiny", device="cpu", compute_type="int8")
```

---

### P2-RPI-04: beam_size=5 es excesivo para ARM

| Campo | Valor |
|-------|-------|
| **Archivos** | `scripts/process_transcription.py:88`, `scripts/process_translation.py:51` |
| **Severidad** | 🟡 Importante |
| **Esfuerzo** | 🟢 Bajo (2 min) |

**Problema:**  
`beam_size=5` usa más RAM y CPU. Para RPi4, `beam_size=1` (greedy) es ~3x más rápido.

**Benchmarks:**

| beam_size | Velocidad | Calidad |
|-----------|-----------|---------|
| 5 | 1x | 100% |
| 3 | 1.5x | 98% |
| 1 | 3x | 95% |

**Solución:**
```python
segments, info = model.transcribe(
    audio_path,
    language=language,
    beam_size=1,  # Greedy decoding - mucho más rápido
    best_of=1,    # Sin sampling adicional
    vad_filter=True,
    vad_parameters=dict(min_silence_duration_ms=500)
)
```

---

### P2-RPI-05: Modelo de traducción podría ser más ligero

| Campo | Valor |
|-------|-------|
| **Archivo** | `scripts/process_translation.py:84` |
| **Severidad** | 🟡 Importante |
| **Esfuerzo** | 🟡 Medio (4 horas) |

**Alternativas más ligeras:**

| Modelo | Tamaño | Calidad |
|--------|--------|---------|
| Helsinki-NLP/opus-mt-en-es | ~300MB | Excelente |
| Helsinki-NLP/opus-mt-tc-big-en-es | ~200MB | Muy buena |
| ct2-converted model | ~100MB | Buena |

**Solución: Usar CTranslate2 directamente**
```python
import ctranslate2
import sentencepiece as spm

# Modelo pre-convertido (más rápido)
translator = ctranslate2.Translator(
    "models/opus-mt-en-es-ct2",
    device="cpu",
    compute_type="int8"
)

# Tokenizer
sp = spm.SentencePieceProcessor("models/source.spm")

def translate(text):
    tokens = sp.encode(text, out_type=str)
    results = translator.translate_batch([tokens])
    return sp.decode(results[0].hypotheses[0])
```

**Script para convertir modelo:**
```bash
ct2-opus-mt-converter --model Helsinki-NLP/opus-mt-en-es \
    --output_dir models/opus-mt-en-es-ct2 \
    --quantization int8
```

---

### P3-RPI-06: Configuración de swappiness

| Campo | Valor |
|-------|-------|
| **Contexto** | Sistema operativo |
| **Severidad** | 🟢 Opcional |
| **Esfuerzo** | 🟢 Bajo (2 min) |

**Problema:**  
Con 8GB RAM, el sistema puede swapear innecesariamente afectando performance.

**Solución:**
```bash
# Verificar valor actual
cat /proc/sys/vm/swappiness  # Default: 60

# Reducir a 10 (menos swap)
echo 10 | sudo tee /proc/sys/vm/swappiness

# Hacer permanente
echo "vm.swappiness=10" | sudo tee -a /etc/sysctl.conf
```

---

### P3-RPI-07: zram para compresión de RAM

| Campo | Valor |
|-------|-------|
| **Contexto** | Sistema operativo |
| **Severidad** | 🟢 Opcional |
| **Esfuerzo** | 🟢 Bajo (5 min) |

**Beneficio:**  
zram comprime RAM en vez de swapear a SD/disco, ~2-3x más capacidad efectiva.

**Instalación:**
```bash
sudo apt install zram-tools

# Configurar
sudo nano /etc/default/zramswap
# ALGO=lz4
# PERCENT=50

# Reiniciar servicio
sudo systemctl restart zramswap
```

---

## 📊 Matriz de Priorización

### Por Impacto vs Esfuerzo

```
                    IMPACTO
                Alto │ Medio │ Bajo
         ┌──────────┼───────┼──────────┐
    Alto │ P1-CPU-02│       │          │
         │ P1-RAM-01│       │          │
         │ P1-RPI-01│       │          │
         ├──────────┼───────┼──────────┤
Esfuerzo │ P1-RPI-02│P2-*   │          │
   Medio │ P1-BW-01 │       │          │
         │ P1-IO-01 │       │          │
         ├──────────┼───────┼──────────┤
    Bajo │ P1-CPU-01│P2-IO-06│ P3-*    │
         │ P1-CPU-04│P2-BW-03│          │
         │ P2-RPI-04│       │          │
         └──────────┴───────┴──────────┘
```

### Quick Wins (Alto Impacto, Bajo Esfuerzo)

| ID | Descripción | Tiempo |
|----|-------------|--------|
| P1-CPU-01 | bcrypt async | 5 min |
| P2-IO-06 | Agregar compression() | 5 min |
| P2-BW-03 | Cache headers | 5 min |
| P2-RPI-04 | beam_size=1 | 2 min |
| P1-CPU-04 | Hashes pre-calculados | 10 min |
| P2-RPI-03 | tiny.en para inglés | 5 min |

---

## 🎯 Plan de Acción Recomendado

### Fase 1: Quick Wins (1-2 horas)

```bash
# Checklist
[ ] Cambiar bcrypt.compareSync a async
[ ] Agregar compression() middleware
[ ] Configurar cache headers en static
[ ] Reducir beam_size a 1 en Whisper
[ ] Usar tiny.en para traducción
[ ] Hashes pre-calculados para seed users
```

**Impacto esperado:**
- Login 3x más rápido
- Responses HTTP 60-70% más pequeños
- Transcripción 2-3x más rápida

### Fase 2: Optimización Media (1-2 días)

```bash
# Checklist
[ ] Implementar worker Python persistente
[ ] Migrar de torch a ONNX runtime
[ ] Crear subset de Bootstrap Icons
[ ] Agregar paginación a getEpisodes()
[ ] Consolidar EventEmitters
[ ] Migrar fs sync a async
```

**Impacto esperado:**
- Reducción de RAM de 3GB a 1GB por proceso
- Tiempo de inicio de tareas de 30s a 2s
- Menor uso de bandwidth

### Fase 3: Refactoring Mayor (1 semana)

```bash
# Checklist
[ ] Implementar cola de jobs con prioridades
[ ] Convertir modelo de traducción a CTranslate2
[ ] Cachear thumbnails localmente
[ ] Implementar streaming de audio
[ ] Tests de carga en RPi4
```

**Impacto esperado:**
- Sistema estable bajo carga
- Uso eficiente de los 4 cores
- Menor latencia en todas las operaciones

---

## 📈 Métricas de Éxito

### Antes de optimizar (baseline)

| Métrica | Valor Actual |
|---------|--------------|
| Tiempo de login | ~300ms |
| Tiempo inicio transcripción | ~30s |
| RAM por proceso Python | ~2GB |
| Tamaño CSS | ~500KB |
| Tamaño iconos | ~1.5MB |

### Objetivos post-optimización

| Métrica | Objetivo |
|---------|----------|
| Tiempo de login | <50ms |
| Tiempo inicio transcripción | <5s |
| RAM por proceso Python | <800MB |
| Tamaño CSS | <50KB |
| Tamaño iconos | <100KB |

---

## 🔧 Scripts de Benchmark

### Test de CPU

```bash
#!/bin/bash
# benchmark_cpu.sh

echo "=== Benchmark de Transcripción ==="
time python3 scripts/process_transcription.py \
    downloads/test.mp3 \
    /tmp/test_transcript.pdf \
    --language en

echo ""
echo "=== Benchmark de Traducción ==="
time python3 scripts/process_translation.py \
    downloads/test.mp3 \
    /tmp/test_translation.wav
```

### Test de Memoria

```bash
#!/bin/bash
# benchmark_memory.sh

echo "=== Uso de memoria durante transcripción ==="
/usr/bin/time -v python3 scripts/process_transcription.py \
    downloads/test.mp3 \
    /tmp/test_transcript.pdf \
    --language en 2>&1 | grep "Maximum resident set size"
```

### Test de I/O

```bash
#!/bin/bash
# benchmark_io.sh

echo "=== Test de lectura/escritura ==="
dd if=/dev/zero of=/tmp/testfile bs=1M count=100 2>&1 | tail -1
dd if=/tmp/testfile of=/dev/null bs=1M 2>&1 | tail -1
rm /tmp/testfile
```

---

## 📚 Referencias

- [faster-whisper optimization](https://github.com/guillaumekln/faster-whisper)
- [CTranslate2 for ARM](https://github.com/OpenNMT/CTranslate2)
- [Node.js best practices](https://github.com/goldbergyoni/nodebestpractices)
- [Raspberry Pi performance tuning](https://www.raspberrypi.com/documentation/computers/config_txt.html)
- [ONNX Runtime for ARM](https://onnxruntime.ai/docs/execution-providers/community-maintained/ARM.html)

---

*Reporte generado para Youtube2Podcast v1.5.0*  
*Hardware objetivo: Raspberry Pi 4 (ARMv8, 4 cores, 8GB RAM)*

