#!/usr/bin/env python3
"""
Pipeline de transcripción: Audio -> Texto -> PDF

Uso:
    python scripts/process_transcription.py <input_audio> <output_pdf> --language <lang_code>

Ejemplo:
    python scripts/process_transcription.py downloads/abc123.mp3 downloads/abc123_transcript.pdf --language es
"""

import sys
import os
import json
import argparse
from pathlib import Path
from datetime import datetime

# Configuración de hilos para CPU (optimizado para Raspberry Pi 4 con 4 cores)
os.environ.setdefault("OMP_NUM_THREADS", "4")
os.environ.setdefault("MKL_NUM_THREADS", "4")

# Idiomas soportados por Whisper
SUPPORTED_LANGUAGES = {
    "en": "English",
    "es": "Spanish",
    "fr": "French",
    "de": "German",
    "it": "Italian",
    "pt": "Portuguese",
    "nl": "Dutch",
    "pl": "Polish",
    "ru": "Russian",
    "ja": "Japanese",
    "ko": "Korean",
    "zh": "Chinese",
    "ar": "Arabic",
    "hi": "Hindi",
    "tr": "Turkish",
    "vi": "Vietnamese",
    "th": "Thai",
    "id": "Indonesian",
    "ms": "Malay",
    "tl": "Tagalog",
    "uk": "Ukrainian",
    "cs": "Czech",
    "ro": "Romanian",
    "hu": "Hungarian",
    "el": "Greek",
    "he": "Hebrew",
    "sv": "Swedish",
    "da": "Danish",
    "fi": "Finnish",
    "no": "Norwegian",
}

def log_progress(stage: str, percent: int, message: str = ""):
    """Emite progreso en formato JSON para que Node.js lo capture."""
    progress = {
        "stage": stage,
        "percent": percent,
        "message": message
    }
    print(json.dumps(progress), flush=True)

def transcribe_audio(audio_path: str, language: str) -> tuple[str, list]:
    """
    Etapa 1: Speech-to-Text usando faster-whisper.
    Transcribe el audio al idioma especificado.
    
    Returns:
        tuple: (full_text, segments_with_timestamps)
    """
    log_progress("stt", 10, f"Cargando modelo de transcripción...")
    
    from faster_whisper import WhisperModel
    
    # Usar modelo tiny con cuantización int8 para mejor rendimiento en CPU
    model = WhisperModel("tiny", device="cpu", compute_type="int8")
    
    log_progress("stt", 20, f"Transcribiendo audio en {SUPPORTED_LANGUAGES.get(language, language)}...")
    
    # Transcribir con el idioma especificado
    segments, info = model.transcribe(
        audio_path,
        language=language,
        beam_size=5,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=500)
    )
    
    # Recolectar segmentos con timestamps
    full_text = ""
    segments_data = []
    segment_list = list(segments)
    total_segments = len(segment_list)
    
    for i, segment in enumerate(segment_list):
        full_text += segment.text + " "
        segments_data.append({
            "start": segment.start,
            "end": segment.end,
            "text": segment.text.strip()
        })
        progress = 20 + int((i / max(total_segments, 1)) * 50)
        log_progress("stt", progress, f"Procesando segmento {i+1}/{total_segments}")
    
    full_text = full_text.strip()
    log_progress("stt", 70, f"Transcripción completada: {len(full_text)} caracteres, {len(segments_data)} segmentos")
    
    # Liberar memoria
    del model
    
    return full_text, segments_data

def format_timestamp(seconds: float) -> str:
    """Convierte segundos a formato HH:MM:SS o MM:SS."""
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    
    if hours > 0:
        return f"{hours:02d}:{minutes:02d}:{secs:02d}"
    else:
        return f"{minutes:02d}:{secs:02d}"

def generate_pdf(segments: list, output_path: str, language: str, audio_filename: str) -> None:
    """
    Etapa 2: Genera PDF con la transcripción.
    Incluye timestamps para cada segmento.
    """
    log_progress("pdf", 75, "Generando documento PDF...")
    
    from fpdf import FPDF
    
    class TranscriptPDF(FPDF):
        def header(self):
            self.set_font('Helvetica', 'B', 14)
            self.cell(0, 10, 'Transcripción de Audio', 0, 1, 'C')
            self.ln(5)
        
        def footer(self):
            self.set_y(-15)
            self.set_font('Helvetica', 'I', 8)
            self.cell(0, 10, f'Página {self.page_no()}', 0, 0, 'C')
    
    pdf = TranscriptPDF()
    pdf.set_auto_page_break(auto=True, margin=15)
    pdf.add_page()
    
    # Metadatos
    pdf.set_font('Helvetica', 'I', 10)
    pdf.set_text_color(100, 100, 100)
    pdf.cell(0, 6, f'Archivo: {audio_filename}', 0, 1)
    pdf.cell(0, 6, f'Idioma: {SUPPORTED_LANGUAGES.get(language, language)}', 0, 1)
    pdf.cell(0, 6, f'Fecha: {datetime.now().strftime("%Y-%m-%d %H:%M")}', 0, 1)
    pdf.cell(0, 6, f'Segmentos: {len(segments)}', 0, 1)
    pdf.ln(10)
    
    # Contenido
    pdf.set_text_color(0, 0, 0)
    total_segments = len(segments)
    
    for i, seg in enumerate(segments):
        # Timestamp
        timestamp = f"[{format_timestamp(seg['start'])} - {format_timestamp(seg['end'])}]"
        pdf.set_font('Helvetica', 'B', 9)
        pdf.set_text_color(80, 80, 80)
        pdf.cell(0, 5, timestamp, 0, 1)
        
        # Texto del segmento
        pdf.set_font('Helvetica', '', 11)
        pdf.set_text_color(0, 0, 0)
        # multi_cell para texto largo con word wrap
        pdf.multi_cell(0, 6, seg['text'])
        pdf.ln(3)
        
        if (i + 1) % 20 == 0:
            progress = 75 + int((i / max(total_segments, 1)) * 20)
            log_progress("pdf", progress, f"Escribiendo segmento {i+1}/{total_segments}")
    
    log_progress("pdf", 95, "Guardando PDF...")
    pdf.output(output_path)
    log_progress("pdf", 98, "PDF generado correctamente")

def main():
    parser = argparse.ArgumentParser(
        description="Pipeline de transcripción: Audio -> PDF"
    )
    parser.add_argument("input_audio", help="Ruta al archivo de audio de entrada (MP3/WAV)")
    parser.add_argument("output_pdf", help="Ruta al archivo PDF de salida")
    parser.add_argument("--language", default="en", 
                        help=f"Código de idioma para transcripción. Soportados: {', '.join(SUPPORTED_LANGUAGES.keys())}")
    
    args = parser.parse_args()
    
    input_path = args.input_audio
    output_path = args.output_pdf
    language = args.language.lower()
    
    # Validar idioma
    if language not in SUPPORTED_LANGUAGES:
        log_progress("error", 0, f"Idioma no soportado: {language}. Use uno de: {', '.join(SUPPORTED_LANGUAGES.keys())}")
        sys.exit(1)
    
    # Validar entrada
    if not os.path.exists(input_path):
        log_progress("error", 0, f"Archivo de entrada no encontrado: {input_path}")
        sys.exit(1)
    
    try:
        log_progress("start", 0, "Iniciando pipeline de transcripción...")
        
        # Etapa 1: STT
        full_text, segments = transcribe_audio(input_path, language)
        
        if not full_text or len(segments) == 0:
            log_progress("error", 70, "No se pudo transcribir el audio")
            sys.exit(1)
        
        # Etapa 2: Generar PDF
        audio_filename = os.path.basename(input_path)
        generate_pdf(segments, output_path, language, audio_filename)
        
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
            "language": language,
            "segments_count": len(segments),
            "text_length": len(full_text)
        }
        print(json.dumps(result), flush=True)
        
    except Exception as e:
        log_progress("error", -1, str(e))
        sys.exit(1)

if __name__ == "__main__":
    main()

