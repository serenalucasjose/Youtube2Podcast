#!/usr/bin/env python3
"""
Script para pre-descargar los modelos de IA necesarios para el pipeline de traducción.
Ejecutar una vez después de instalar las dependencias.

Uso:
    source venv/bin/activate
    python scripts/download_models.py
"""

import os
import sys

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

def main():
    print("="*60)
    print("DESCARGA DE MODELOS PARA PIPELINE DE TRADUCCIÓN")
    print("="*60)
    print("\nEste proceso puede tardar varios minutos dependiendo de")
    print("la velocidad de tu conexión a internet.\n")
    
    results = {
        "STT (faster-whisper)": download_stt_model(),
        "Traducción (Helsinki-NLP)": download_translation_model(),
        "TTS (edge-tts)": test_tts()
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
        print("El pipeline de traducción está listo para usar.")
        print("")
        print("Nota: edge-tts requiere conexión a internet para funcionar,")
        print("ya que usa los servicios de Microsoft Edge TTS.")
        return 0
    else:
        print("Algunos modelos no se pudieron descargar.")
        print("Revisa los errores anteriores e intenta de nuevo.")
        return 1

if __name__ == "__main__":
    sys.exit(main())
