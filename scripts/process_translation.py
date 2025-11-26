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
import asyncio
import argparse
from pathlib import Path

# Configuración de hilos para CPU (optimizado para Raspberry Pi 4 con 4 cores)
os.environ.setdefault("OMP_NUM_THREADS", "4")
os.environ.setdefault("MKL_NUM_THREADS", "4")

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
    Etapa 1: Speech-to-Text usando faster-whisper.
    Transcribe el audio en inglés a texto.
    """
    log_progress("stt", 10, "Cargando modelo de transcripción...")
    
    from faster_whisper import WhisperModel
    
    # Usar modelo tiny con cuantización int8 para mejor rendimiento en CPU
    model = WhisperModel("tiny", device="cpu", compute_type="int8")
    
    log_progress("stt", 20, "Transcribiendo audio...")
    
    # Transcribir (asumimos que el audio está en inglés)
    segments, info = model.transcribe(
        audio_path,
        language="en",
        beam_size=5,
        vad_filter=True,  # Filtrar silencios para mejor rendimiento
        vad_parameters=dict(min_silence_duration_ms=500)
    )
    
    # Concatenar todos los segmentos
    full_text = ""
    segment_list = list(segments)
    total_segments = len(segment_list)
    
    for i, segment in enumerate(segment_list):
        full_text += segment.text + " "
        progress = 20 + int((i / max(total_segments, 1)) * 20)
        log_progress("stt", progress, f"Procesando segmento {i+1}/{total_segments}")
    
    full_text = full_text.strip()
    log_progress("stt", 40, f"Transcripción completada: {len(full_text)} caracteres")
    
    # Liberar memoria
    del model
    
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
    
    # Traducir cada chunk
    translated_chunks = []
    total_chunks = len(chunks)
    
    for i, chunk in enumerate(chunks):
        if chunk:
            result = translator(chunk, max_length=512)
            translated_chunks.append(result[0]["translation_text"])
        progress = 50 + int((i / max(total_chunks, 1)) * 15)
        log_progress("translation", progress, f"Traduciendo chunk {i+1}/{total_chunks}")
    
    text_es = " ".join(translated_chunks)
    log_progress("translation", 65, f"Traducción completada: {len(text_es)} caracteres")
    
    # Liberar memoria
    del translator
    
    return text_es

async def synthesize_speech_async(text_es: str, output_path: str, voice: str = "es-ES-AlvaroNeural") -> None:
    """
    Etapa 3: Text-to-Speech usando edge-tts (Microsoft Edge TTS).
    Genera audio en español a partir del texto traducido.
    """
    log_progress("tts", 70, "Iniciando síntesis de voz...")
    
    import edge_tts
    
    log_progress("tts", 75, f"Generando audio con voz {voice}...")
    
    # Dividir texto largo en partes si es necesario
    # edge-tts maneja bien textos largos, pero para progreso lo dividimos
    communicate = edge_tts.Communicate(text_es, voice)
    
    # Generar audio
    temp_mp3 = output_path.replace('.wav', '_temp.mp3')
    await communicate.save(temp_mp3)
    
    log_progress("tts", 90, "Convirtiendo formato de audio...")
    
    # Convertir MP3 a WAV usando pydub
    from pydub import AudioSegment
    audio = AudioSegment.from_mp3(temp_mp3)
    audio.export(output_path, format="wav")
    
    # Limpiar archivo temporal
    try:
        os.unlink(temp_mp3)
    except:
        pass
    
    log_progress("tts", 98, "Audio generado correctamente")

def synthesize_speech(text_es: str, output_path: str, voice: str = "es-ES-AlvaroNeural") -> None:
    """Wrapper síncrono para la función async de TTS."""
    asyncio.run(synthesize_speech_async(text_es, output_path, voice))

def main():
    parser = argparse.ArgumentParser(
        description="Pipeline de traducción: Audio EN -> Audio ES"
    )
    parser.add_argument("input_audio", help="Ruta al archivo de audio de entrada (MP3/WAV)")
    parser.add_argument("output_audio", help="Ruta al archivo de audio de salida (WAV)")
    parser.add_argument("--voice", default="es-ES-AlvaroNeural", 
                        help="Voz de Edge TTS a usar (ej: es-MX-JorgeNeural)")
    
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
