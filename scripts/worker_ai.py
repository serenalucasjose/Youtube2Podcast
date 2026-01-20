#!/usr/bin/env python3
"""
Worker persistente para modelos de IA.

Este script mantiene los modelos cargados en memoria y procesa trabajos
recibidos via stdin en formato JSON. Esto elimina el tiempo de carga
de modelos (~20-30s) en cada tarea.

Uso:
    El script se ejecuta como proceso hijo de Node.js y se comunica via stdin/stdout.
    
Protocolo:
    - Input (stdin): JSON con { "type": "transcribe"|"translate"|"generate_script"|"generate_podcast", ... }
    - Output (stdout): JSON con { "success": true|false, "result": {...} | "error": "..." }
"""

import sys
import os
import json
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
text_generator = None  # For script generation
tts_engine = None  # TTS engine (pyttsx3 en macOS, piper en Linux)

# Importar utilidades TTS multiplataforma
from tts_utils import (
    get_tts_backend, get_tts, synthesize_speech as tts_synthesize,
    DEFAULT_VOICE, normalize_voice
)

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
    global whisper_model, whisper_model_en, translator, text_generator, tts_engine
    
    log_status("loading", "Cargando modelos de IA...")
    
    try:
        from stt_utils import WhisperSTT, get_stt_backend
        
        backend = get_stt_backend()
        
        # Modelo multilingüe para idiomas no-inglés
        log_status("loading", f"Cargando Whisper tiny ({backend})...")
        whisper_model = WhisperSTT(model_name="tiny")
        whisper_model.load()
        
        # Modelo optimizado para inglés
        log_status("loading", f"Cargando Whisper tiny.en ({backend})...")
        whisper_model_en = WhisperSTT(model_name="tiny.en", language="en")
        whisper_model_en.load()
        
        # Modelo de traducción EN->ES
        log_status("loading", "Cargando modelo de traducción EN->ES...")
        from transformers import pipeline
        translator = pipeline(
            "translation",
            model="Helsinki-NLP/opus-mt-en-es",
            device=-1  # CPU
        )
        
        # Modelo de generación de texto para scripts de podcast
        # Usamos un modelo pequeño que ya viene con transformers
        log_status("loading", "Cargando modelo de generación de texto...")
        try:
            text_generator = pipeline(
                "text-generation",
                model="distilgpt2",
                device=-1  # CPU
            )
            log_status("loading", "Modelo de texto cargado correctamente")
        except Exception as e:
            log_status("loading", f"Generador de texto no disponible: {str(e)}")
            text_generator = None
        
        # Cargar motor TTS multiplataforma (pyttsx3 en macOS, piper en Linux)
        tts_backend = get_tts_backend()
        log_status("loading", f"Cargando motor TTS ({tts_backend})...")
        try:
            tts_engine = get_tts(DEFAULT_VOICE)
            log_status("loading", f"Motor TTS cargado: {tts_backend}")
        except Exception as e:
            log_status("loading", f"Error cargando TTS: {str(e)}")
            tts_engine = None
        
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
    
    # El wrapper WhisperSTT maneja las diferencias entre backends
    result = model.transcribe(input_path, language=language)
    
    log_progress("stt", 70, f"Transcripción completada: {len(result['text'])} caracteres")
    
    return result

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

def synthesize_speech(text: str, output_path: str, voice: str = DEFAULT_VOICE) -> bool:
    """Sintetiza voz usando el motor TTS apropiado (pyttsx3 en macOS, piper en Linux)."""
    
    # Callback para reportar progreso
    def progress_callback(percent: int, message: str):
        log_progress("tts", percent, message)
    
    # Normalizar voz
    voice_id = normalize_voice(voice)
    log_progress("tts", 70, f"Usando voz: {voice_id} ({get_tts_backend()})")
    
    # Usar el módulo TTS unificado
    return tts_synthesize(text, output_path, voice_id, progress_callback)

def generate_podcast_script(articles: list) -> str:
    """
    Genera un guion de podcast coherente a partir de una lista de artículos.
    Usa un enfoque de plantilla estructurada para crear texto con tono de locutor de radio.
    
    Este enfoque es más confiable en dispositivos con recursos limitados (Raspberry Pi)
    y produce resultados consistentes sin depender de un LLM grande.
    """
    global text_generator
    
    log_progress("script", 10, "Preparando guion de podcast...")
    
    # Limitar a 5 artículos
    articles = articles[:5]
    
    if not articles:
        raise Exception("No hay artículos para generar el podcast")
    
    log_progress("script", 30, f"Procesando {len(articles)} noticias...")
    
    # Construir el guion con un formato de radio profesional
    intro = "¡Buenos días a todos los oyentes! Bienvenidos a su resumen de noticias del día. Hoy les traemos las historias más relevantes. Comencemos."
    
    news_segments = []
    transitions = [
        "Continuando con las noticias,",
        "En otras noticias,",
        "También les informamos que",
        "Pasando a otro tema,",
        "Y finalmente,"
    ]
    
    for i, article in enumerate(articles):
        title = article.get('title', 'Sin título').strip()
        summary = article.get('summary', article.get('description', '')).strip()
        
        # Limpiar el resumen (quitar HTML, limitar longitud)
        summary = summary.replace('<p>', '').replace('</p>', '').replace('<br>', ' ')
        summary = ' '.join(summary.split())  # Normalizar espacios
        
        # Limitar longitud del resumen para mantener podcast breve
        if len(summary) > 300:
            summary = summary[:297] + "..."
        
        # Construir segmento de noticia
        if i == 0:
            segment = f"Nuestra primera noticia: {title}. {summary}"
        elif i == len(articles) - 1:
            segment = f"Y para cerrar: {title}. {summary}"
        else:
            transition = transitions[min(i, len(transitions)-1)]
            segment = f"{transition} {title}. {summary}"
        
        news_segments.append(segment)
        log_progress("script", 30 + (i+1) * 10, f"Procesada noticia {i+1}/{len(articles)}")
    
    # Construir cierre
    outro = "Y eso es todo por hoy. Gracias por acompañarnos en este resumen informativo. Les deseamos un excelente día y recuerden mantenerse informados. ¡Hasta la próxima!"
    
    # Unir todo el guion
    script = intro + " " + " ".join(news_segments) + " " + outro
    
    log_progress("script", 90, f"Guion generado: {len(script)} caracteres")
    
    return script

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
            voice = job.get("voice", DEFAULT_VOICE)
            
            # Paso 1: Transcribir
            transcription = transcribe_audio(input_path, "en")
            
            # Paso 2: Traducir
            text_es = translate_text(transcription["text"])
            
            # Paso 3: Sintetizar voz (Piper TTS - offline)
            synthesize_speech(text_es, output_path, voice)
            
            return {
                "success": True,
                "result": {
                    "text_en": transcription["text"],
                    "text_es": text_es,
                    "output_path": output_path
                }
            }
        
        elif job_type == "generate_script":
            # Generar guion de podcast a partir de artículos
            articles = job.get("articles", [])
            
            if not articles:
                return {"success": False, "error": "No se proporcionaron artículos"}
            
            script = generate_podcast_script(articles)
            
            return {
                "success": True,
                "result": {
                    "script": script,
                    "article_count": len(articles)
                }
            }
        
        elif job_type == "generate_podcast":
            # Pipeline completo: artículos -> guion -> audio
            articles = job.get("articles", [])
            output_path = job.get("output_path")
            voice = job.get("voice", DEFAULT_VOICE)
            
            if not articles:
                return {"success": False, "error": "No se proporcionaron artículos"}
            
            if not output_path:
                return {"success": False, "error": "No se proporcionó ruta de salida"}
            
            log_progress("podcast", 5, "Iniciando generación de podcast IA...")
            
            # Paso 1: Generar guion con LLM
            log_progress("podcast", 10, "Generando guion...")
            script = generate_podcast_script(articles)
            
            # Paso 2: Sintetizar voz (Piper TTS - offline)
            log_progress("podcast", 60, "Sintetizando audio...")
            synthesize_speech(script, output_path, voice)
            
            log_progress("podcast", 100, "Podcast generado correctamente")
            
            return {
                "success": True,
                "result": {
                    "script": script,
                    "output_path": output_path,
                    "article_count": len(articles)
                }
            }
            
        elif job_type == "translate_text":
            # Traducir solo texto (sin audio)
            text = job.get("text", "")
            
            if not text:
                return {"success": False, "error": "No se proporcionó texto"}
            
            translated = translate_text(text)
            
            return {
                "success": True,
                "result": {
                    "original": text,
                    "translated": translated
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

