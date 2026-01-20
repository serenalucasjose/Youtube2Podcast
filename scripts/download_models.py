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
import platform
from pathlib import Path

def is_macos():
    """Detecta si estamos en macOS"""
    return platform.system() == "Darwin"

def download_stt_model():
    """Descarga el modelo de Speech-to-Text"""
    print("\n" + "="*60)
    
    if is_macos():
        print("Descargando modelo STT (openai-whisper tiny)...")
        print("="*60)
        try:
            import whisper
            model = whisper.load_model("tiny")
            print("✓ Modelo STT (openai-whisper) descargado correctamente")
            del model
            return True
        except Exception as e:
            print(f"✗ Error descargando modelo STT: {e}")
            return False
    else:
        print("Descargando modelo STT (faster-whisper tiny)...")
        print("="*60)
        try:
            from faster_whisper import WhisperModel
            model = WhisperModel("tiny", device="cpu", compute_type="int8")
            print("✓ Modelo STT (faster-whisper) descargado correctamente")
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

def download_tts_models():
    """Descarga modelos TTS según la plataforma"""
    print("\n" + "="*60)
    
    if is_macos():
        print("Configurando pyttsx3 (voces nativas macOS)...")
        print("="*60)
        try:
            import pyttsx3
            engine = pyttsx3.init()
            voices = engine.getProperty('voices')
            spanish_voices = [v for v in voices if 'spanish' in v.name.lower() or 'español' in v.name.lower() or 'es_' in v.id.lower() or 'es-' in v.id.lower()]
            print(f"✓ pyttsx3 configurado correctamente")
            print(f"  Voces en español disponibles: {len(spanish_voices)}")
            for v in spanish_voices[:3]:
                print(f"    - {v.name}")
            print("  TTS 100% offline (usa voces del sistema)")
            engine.stop()
            return True
        except Exception as e:
            print(f"✗ Error configurando pyttsx3: {e}")
            return False
    else:
        print("Descargando modelos Piper TTS (voces en español)...")
        print("="*60)
        
        import urllib.request
        
        # Directorio de modelos Piper
        models_dir = Path(__file__).parent.parent / "models" / "piper"
        models_dir.mkdir(parents=True, exist_ok=True)
        
        # Voces a descargar
        voices = {
            "es_ES-davefx-medium": {
                "path": "es/es_ES/davefx/medium",
                "desc": "España, masculina, calidad media"
            },
            "es_ES-mls_10246-low": {
                "path": "es/es_ES/mls_10246/low",
                "desc": "España, femenina"
            },
            "es_MX-ald-medium": {
                "path": "es/es_MX/ald/medium",
                "desc": "México, masculina, calidad media"
            },
            "es_MX-claude-high": {
                "path": "es/es_MX/claude/high",
                "desc": "México, femenina, alta calidad"
            },
        }
        
        base_url = "https://huggingface.co/rhasspy/piper-voices/resolve/main"
        success_count = 0
        
        for voice_id, info in voices.items():
            onnx_file = f"{voice_id}.onnx"
            json_file = f"{voice_id}.onnx.json"
            
            onnx_dest = models_dir / onnx_file
            json_dest = models_dir / json_file
            
            if onnx_dest.exists() and json_dest.exists():
                print(f"  ✓ {voice_id} ya descargado ({info['desc']})")
                success_count += 1
                continue
            
            try:
                print(f"  Descargando {voice_id} ({info['desc']})...")
                onnx_url = f"{base_url}/{info['path']}/{onnx_file}"
                urllib.request.urlretrieve(onnx_url, onnx_dest)
                json_url = f"{base_url}/{info['path']}/{json_file}"
                urllib.request.urlretrieve(json_url, json_dest)
                print(f"  ✓ {voice_id} descargado correctamente")
                success_count += 1
            except Exception as e:
                print(f"  ✗ Error descargando {voice_id}: {e}")
        
        if success_count == len(voices):
            print(f"\n✓ Todas las voces Piper descargadas ({success_count}/{len(voices)})")
            print("  TTS 100% offline")
            return True
        elif success_count > 0:
            print(f"\n⚠ Algunas voces descargadas ({success_count}/{len(voices)})")
            return True
        else:
            print(f"\n✗ Error descargando voces Piper")
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
    
    stt_name = "STT (openai-whisper)" if is_macos() else "STT (faster-whisper)"
    tts_name = "TTS (pyttsx3 offline)" if is_macos() else "TTS (Piper offline)"
    results = {
        stt_name: download_stt_model(),
        "Traducción (Helsinki-NLP)": download_translation_model(),
        tts_name: download_tts_models(),
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
        print("El sistema TTS (Piper) funciona 100% offline.")
        print("No se requiere conexión a internet para generar audio.")
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
