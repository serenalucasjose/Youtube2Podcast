#!/usr/bin/env python3
"""
Worker persistente para modelos de IA.

Este script mantiene los modelos cargados en memoria y procesa trabajos
recibidos via stdin en formato JSON. Esto elimina el tiempo de carga
de modelos (~20-30s) en cada tarea.

Uso:
    El script se ejecuta como proceso hijo de Node.js y se comunica via stdin/stdout.
    
Protocolo:
    - Input (stdin): JSON con { "type": "transcribe"|"translate", "input_path": "...", ... }
    - Output (stdout): JSON con { "success": true|false, "result": {...} | "error": "..." }
"""

import sys
import os
import json
import asyncio
from pathlib import Path

# Configuración de hilos para CPU (optimizado para Raspberry Pi 4 con 4 cores)
os.environ.setdefault("OMP_NUM_THREADS", "4")
os.environ.setdefault("MKL_NUM_THREADS", "4")

# ============================================
# ESTADO GLOBAL - Modelos cargados una sola vez
# ============================================
whisper_model = None
whisper_model_en = None
translator = None

def log_status(status: str, message: str = ""):
    """Emite mensaje de estado en formato JSON."""
    output = {"status": status, "message": message}
    print(json.dumps(output), flush=True)

def log_progress(stage: str, percent: int, message: str = ""):
    """Emite progreso en formato JSON."""
    progress = {"stage": stage, "percent": percent, "message": message}
    print(json.dumps(progress), flush=True)

def load_models():
    """Carga todos los modelos de IA al iniciar el worker."""
    global whisper_model, whisper_model_en, translator
    
    log_status("loading", "Cargando modelos de IA...")
    
    try:
        from faster_whisper import WhisperModel
        
        # Modelo multilingüe para idiomas no-inglés
        log_status("loading", "Cargando Whisper tiny (multilingüe)...")
        whisper_model = WhisperModel("tiny", device="cpu", compute_type="int8")
        
        # Modelo optimizado para inglés
        log_status("loading", "Cargando Whisper tiny.en...")
        whisper_model_en = WhisperModel("tiny.en", device="cpu", compute_type="int8")
        
        # Modelo de traducción EN->ES
        log_status("loading", "Cargando modelo de traducción EN->ES...")
        from transformers import pipeline
        translator = pipeline(
            "translation",
            model="Helsinki-NLP/opus-mt-en-es",
            device=-1  # CPU
        )
        
        log_status("ready", "Todos los modelos cargados correctamente")
        return True
        
    except Exception as e:
        log_status("error", f"Error cargando modelos: {str(e)}")
        return False

def transcribe_audio(input_path: str, language: str = "en") -> dict:
    """Transcribe audio usando el modelo Whisper apropiado."""
    global whisper_model, whisper_model_en
    
    log_progress("stt", 10, "Iniciando transcripción...")
    
    # Seleccionar modelo según idioma
    model = whisper_model_en if language == "en" else whisper_model
    
    log_progress("stt", 20, f"Transcribiendo en {language}...")
    
    # Transcribir con beam_size=1 para máxima velocidad
    segments, info = model.transcribe(
        input_path,
        language=language,
        beam_size=1,
        best_of=1,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=500)
    )
    
    # Procesar segmentos en streaming
    full_text = ""
    segments_data = []
    segment_count = 0
    
    for segment in segments:
        segment_count += 1
        full_text += segment.text + " "
        segments_data.append({
            "start": segment.start,
            "end": segment.end,
            "text": segment.text.strip()
        })
        if segment_count % 10 == 0:
            progress = 20 + min(50, segment_count // 2)
            log_progress("stt", progress, f"Procesando segmento {segment_count}...")
    
    full_text = full_text.strip()
    log_progress("stt", 70, f"Transcripción completada: {len(full_text)} caracteres")
    
    return {
        "text": full_text,
        "segments": segments_data,
        "language": language
    }

def translate_text(text: str) -> str:
    """Traduce texto de inglés a español."""
    global translator
    
    log_progress("translation", 45, "Iniciando traducción...")
    
    # Dividir texto largo en chunks
    max_chunk_length = 400
    sentences = text.replace(". ", ".|").split("|")
    
    chunks = []
    current_chunk = ""
    
    for sentence in sentences:
        if len(current_chunk) + len(sentence) < max_chunk_length:
            current_chunk += sentence + " "
        else:
            if current_chunk:
                chunks.append(current_chunk.strip())
            current_chunk = sentence + " "
    
    if current_chunk:
        chunks.append(current_chunk.strip())
    
    # Traducir en batch
    valid_chunks = [c for c in chunks if c.strip()]
    
    if valid_chunks:
        log_progress("translation", 52, f"Traduciendo {len(valid_chunks)} chunks...")
        results = translator(valid_chunks, max_length=512, batch_size=4)
        translated_chunks = [r["translation_text"] for r in results]
    else:
        translated_chunks = []
    
    text_es = " ".join(translated_chunks)
    log_progress("translation", 65, f"Traducción completada: {len(text_es)} caracteres")
    
    return text_es

async def synthesize_speech(text: str, output_path: str, voice: str = "es-ES-AlvaroNeural") -> bool:
    """Sintetiza voz usando edge-tts."""
    import edge_tts
    
    log_progress("tts", 70, "Iniciando síntesis de voz...")
    
    communicate = edge_tts.Communicate(text, voice)
    
    log_progress("tts", 75, f"Generando audio con voz {voice}...")
    await communicate.save(output_path)
    
    log_progress("tts", 98, "Audio generado correctamente")
    return True

def process_job(job: dict) -> dict:
    """Procesa un trabajo recibido."""
    job_type = job.get("type")
    
    try:
        if job_type == "transcribe":
            input_path = job.get("input_path")
            language = job.get("language", "en")
            
            result = transcribe_audio(input_path, language)
            return {"success": True, "result": result}
            
        elif job_type == "translate":
            input_path = job.get("input_path")
            output_path = job.get("output_path")
            voice = job.get("voice", "es-ES-AlvaroNeural")
            
            # Paso 1: Transcribir
            transcription = transcribe_audio(input_path, "en")
            
            # Paso 2: Traducir
            text_es = translate_text(transcription["text"])
            
            # Paso 3: Sintetizar voz
            asyncio.run(synthesize_speech(text_es, output_path, voice))
            
            return {
                "success": True,
                "result": {
                    "text_en": transcription["text"],
                    "text_es": text_es,
                    "output_path": output_path
                }
            }
            
        elif job_type == "ping":
            return {"success": True, "result": "pong"}
            
        elif job_type == "shutdown":
            return {"success": True, "result": "shutting_down"}
            
        else:
            return {"success": False, "error": f"Tipo de trabajo desconocido: {job_type}"}
            
    except Exception as e:
        return {"success": False, "error": str(e)}

def main():
    """Loop principal del worker."""
    
    # Cargar modelos al iniciar
    if not load_models():
        sys.exit(1)
    
    # Loop de procesamiento via stdin
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
            
        try:
            job = json.loads(line)
            result = process_job(job)
            
            # Enviar resultado
            print(json.dumps(result), flush=True)
            
            # Verificar si debemos terminar
            if job.get("type") == "shutdown":
                break
                
        except json.JSONDecodeError as e:
            print(json.dumps({"success": False, "error": f"JSON inválido: {str(e)}"}), flush=True)
        except Exception as e:
            print(json.dumps({"success": False, "error": str(e)}), flush=True)

if __name__ == "__main__":
    main()

