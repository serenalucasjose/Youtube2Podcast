#!/usr/bin/env python3
"""
Script para pre-descargar los modelos de IA necesarios para el pipeline de traducción
y generación de podcasts IA.

Ejecutar una vez después de instalar las dependencias.

Uso:
    source venv/bin/activate
    python scripts/download_models.py
"""

import os
import sys
from pathlib import Path

def download_stt_model():
    """Descarga el modelo de Speech-to-Text (faster-whisper)"""
    print("\n" + "="*60)
    print("Descargando modelo STT (faster-whisper tiny)...")
    print("="*60)
    
    try:
        from faster_whisper import WhisperModel
        # Descargar modelo tiny (más ligero para Raspberry Pi)
        model = WhisperModel("tiny", device="cpu", compute_type="int8")
        print("✓ Modelo STT descargado correctamente")
        del model
        return True
    except Exception as e:
        print(f"✗ Error descargando modelo STT: {e}")
        return False

def download_translation_model():
    """Descarga el modelo de traducción (Helsinki-NLP)"""
    print("\n" + "="*60)
    print("Descargando modelo de traducción (Helsinki-NLP/opus-mt-en-es)...")
    print("="*60)
    
    try:
        from transformers import pipeline
        translator = pipeline("translation", model="Helsinki-NLP/opus-mt-en-es")
        # Prueba rápida
        result = translator("Hello world")
        print(f"✓ Modelo de traducción descargado. Prueba: 'Hello world' -> '{result[0]['translation_text']}'")
        del translator
        return True
    except Exception as e:
        print(f"✗ Error descargando modelo de traducción: {e}")
        return False

def test_tts():
    """Verifica que edge-tts esté instalado correctamente"""
    print("\n" + "="*60)
    print("Verificando TTS (edge-tts)...")
    print("="*60)
    
    try:
        import edge_tts
        print("✓ edge-tts instalado correctamente")
        print("  Nota: edge-tts usa servicios de Microsoft Edge y no requiere")
        print("  descarga de modelos locales. Requiere conexión a internet.")
        return True
    except Exception as e:
        print(f"✗ Error verificando edge-tts: {e}")
        return False

def download_text_generator():
    """Descarga el modelo de generación de texto (distilgpt2) para scripts de podcast"""
    print("\n" + "="*60)
    print("Descargando modelo de generación de texto (distilgpt2)...")
    print("="*60)
    
    try:
        from transformers import pipeline
        
        # Esto descargará el modelo si no existe
        generator = pipeline("text-generation", model="distilgpt2")
        
        # Quick test
        result = generator("Hello", max_length=10, num_return_sequences=1)
        print(f"✓ Modelo de texto descargado correctamente")
        del generator
        return True
    except Exception as e:
        print(f"✗ Error descargando modelo de texto: {e}")
        print("  Nota: Este modelo es opcional para Podcast IA")
        return True  # No es crítico, el script usa plantillas

def main():
    print("="*60)
    print("DESCARGA DE MODELOS PARA YOUTUBE2PODCAST")
    print("="*60)
    print("\nEste proceso puede tardar varios minutos dependiendo de")
    print("la velocidad de tu conexión a internet.\n")
    
    results = {
        "STT (faster-whisper)": download_stt_model(),
        "Traducción (Helsinki-NLP)": download_translation_model(),
        "TTS (edge-tts)": test_tts(),
        "Generador de texto (distilgpt2)": download_text_generator()
    }
    
    print("\n" + "="*60)
    print("RESUMEN")
    print("="*60)
    
    all_success = True
    for name, success in results.items():
        status = "✓" if success else "✗"
        print(f"  {status} {name}")
        if not success:
            all_success = False
    
    print("")
    if all_success:
        print("¡Todos los modelos descargados correctamente!")
        print("El pipeline de traducción y Podcast IA está listo para usar.")
        print("")
        print("Nota: edge-tts requiere conexión a internet para funcionar,")
        print("ya que usa los servicios de Microsoft Edge TTS.")
        print("")
        print("Nota: Podcast IA usa un sistema de plantillas optimizado para")
        print("dispositivos con recursos limitados (Raspberry Pi).")
        return 0
    else:
        print("Algunos modelos no se pudieron descargar.")
        print("Revisa los errores anteriores e intenta de nuevo.")
        return 1

if __name__ == "__main__":
    sys.exit(main())
