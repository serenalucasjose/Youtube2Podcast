#!/usr/bin/env python3
"""
Pipeline de traducción: STT (EN) -> Traducción (EN→ES) -> TTS (ES)

Uso:
    python scripts/process_translation.py <input_audio> <output_audio>

Ejemplo:
    python scripts/process_translation.py downloads/abc123.mp3 downloads/abc123_es.mp3
"""

import sys
import os
import json
import argparse
from pathlib import Path

# Configuración de hilos para CPU (optimizado para Raspberry Pi 4 con 4 cores)
os.environ.setdefault("OMP_NUM_THREADS", "4")
os.environ.setdefault("MKL_NUM_THREADS", "4")

# Importar utilidades TTS multiplataforma
from tts_utils import (
    get_tts_backend, synthesize_speech as tts_synthesize,
    DEFAULT_VOICE, normalize_voice
)

def log_progress(stage: str, percent: int, message: str = ""):
    """Emite progreso en formato JSON para que Node.js lo capture."""
    progress = {
        "stage": stage,
        "percent": percent,
        "message": message
    }
    print(json.dumps(progress), flush=True)

def transcribe_audio(audio_path: str) -> str:
    """
    Etapa 1: Speech-to-Text usando faster-whisper (Linux) o openai-whisper (macOS).
    Transcribe el audio en inglés a texto.
    """
    from stt_utils import WhisperSTT, get_stt_backend
    
    log_progress("stt", 10, f"Cargando modelo de transcripción ({get_stt_backend()})...")
    
    # Usar modelo tiny.en (optimizado para inglés)
    stt = WhisperSTT(model_name="tiny.en", language="en")
    stt.load()
    
    log_progress("stt", 20, "Transcribiendo audio...")
    
    result = stt.transcribe(audio_path)
    full_text = result["text"]
    
    log_progress("stt", 40, f"Transcripción completada: {len(full_text)} caracteres")
    
    # Liberar memoria
    del stt
    
    return full_text

def translate_text(text_en: str) -> str:
    """
    Etapa 2: Traducción usando Helsinki-NLP/opus-mt-en-es.
    Traduce el texto de inglés a español.
    """
    log_progress("translation", 45, "Cargando modelo de traducción...")
    
    from transformers import pipeline
    
    translator = pipeline(
        "translation",
        model="Helsinki-NLP/opus-mt-en-es",
        device=-1  # CPU
    )
    
    log_progress("translation", 50, "Traduciendo texto...")
    
    # Dividir texto largo en chunks para evitar límites del modelo
    max_chunk_length = 400  # Caracteres aproximados por chunk
    sentences = text_en.replace(". ", ".|").split("|")
    
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
    
    # Traducir en batch para mayor eficiencia
    valid_chunks = [c for c in chunks if c.strip()]
    total_chunks = len(valid_chunks)
    
    if valid_chunks:
        log_progress("translation", 52, f"Traduciendo {total_chunks} chunks en batch...")
        # Batch translation (mucho más eficiente que uno por uno)
        results = translator(valid_chunks, max_length=512, batch_size=4)
        translated_chunks = [r["translation_text"] for r in results]
        log_progress("translation", 63, f"Batch completado: {total_chunks} chunks traducidos")
    else:
        translated_chunks = []
    
    text_es = " ".join(translated_chunks)
    log_progress("translation", 65, f"Traducción completada: {len(text_es)} caracteres")
    
    # Liberar memoria
    del translator
    
    return text_es

def synthesize_speech(text_es: str, output_path: str, voice: str = DEFAULT_VOICE) -> None:
    """
    Etapa 3: Text-to-Speech usando motor apropiado según plataforma.
    - macOS: pyttsx3 (voces nativas del sistema)
    - Linux: Piper TTS (modelos ONNX offline)
    
    Funciona 100% offline - no requiere conexión a internet.
    """
    # Callback para reportar progreso
    def progress_callback(percent: int, message: str):
        log_progress("tts", percent, message)
    
    # Normalizar voz
    voice_id = normalize_voice(voice)
    log_progress("tts", 70, f"Iniciando síntesis ({get_tts_backend()})...")
    
    # Usar el módulo TTS unificado
    tts_synthesize(text_es, output_path, voice_id, progress_callback)

def main():
    parser = argparse.ArgumentParser(
        description="Pipeline de traducción: Audio EN -> Audio ES"
    )
    parser.add_argument("input_audio", help="Ruta al archivo de audio de entrada (MP3/WAV)")
    parser.add_argument("output_audio", help="Ruta al archivo de audio de salida (MP3)")
    parser.add_argument("--voice", default=DEFAULT_VOICE, 
                        help="Voz TTS a usar (ej: es_MX-ald, es_ES-davefx)")
    
    args = parser.parse_args()
    
    input_path = args.input_audio
    output_path = args.output_audio
    
    # Validar entrada
    if not os.path.exists(input_path):
        log_progress("error", 0, f"Archivo de entrada no encontrado: {input_path}")
        sys.exit(1)
    
    try:
        log_progress("start", 0, "Iniciando pipeline de traducción...")
        
        # Etapa 1: STT
        text_en = transcribe_audio(input_path)
        
        if not text_en:
            log_progress("error", 40, "No se pudo transcribir el audio")
            sys.exit(1)
        
        # Etapa 2: Traducción
        text_es = translate_text(text_en)
        
        if not text_es:
            log_progress("error", 65, "No se pudo traducir el texto")
            sys.exit(1)
        
        # Etapa 3: TTS
        synthesize_speech(text_es, output_path, args.voice)
        
        # Verificar salida
        if not os.path.exists(output_path):
            log_progress("error", 99, "No se generó el archivo de salida")
            sys.exit(1)
        
        log_progress("done", 100, "Pipeline completado exitosamente")
        
        # Imprimir resultado final
        result = {
            "success": True,
            "input": input_path,
            "output": output_path,
            "text_en_length": len(text_en),
            "text_es_length": len(text_es)
        }
        print(json.dumps(result), flush=True)
        
    except Exception as e:
        log_progress("error", -1, str(e))
        sys.exit(1)

if __name__ == "__main__":
    main()
