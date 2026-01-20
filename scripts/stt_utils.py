#!/usr/bin/env python3
"""
Utilidad de Speech-to-Text multiplataforma.

Usa faster-whisper en Linux/Raspberry Pi (más rápido)
Usa openai-whisper en macOS (mejor compatibilidad)
"""

import platform
import os

# Configuración de hilos para CPU
os.environ.setdefault("OMP_NUM_THREADS", "4")
os.environ.setdefault("MKL_NUM_THREADS", "4")

def is_macos():
    """Detecta si estamos en macOS"""
    return platform.system() == "Darwin"

def get_stt_backend():
    """Retorna el nombre del backend STT disponible"""
    return "openai-whisper" if is_macos() else "faster-whisper"


class WhisperSTT:
    """
    Wrapper unificado para Speech-to-Text.
    Usa faster-whisper en Linux y openai-whisper en macOS.
    """
    
    def __init__(self, model_name="tiny", language=None):
        """
        Inicializa el modelo Whisper.
        
        Args:
            model_name: Nombre del modelo ("tiny", "base", "small", etc.)
                       Para inglés se puede usar "tiny.en", "base.en", etc.
            language: Código de idioma (ej: "en", "es"). None para autodetección.
        """
        self.model_name = model_name
        self.language = language
        self.model = None
        self._backend = get_stt_backend()
        
    def load(self):
        """Carga el modelo en memoria"""
        if is_macos():
            import whisper
            # openai-whisper no soporta modelos .en específicos de la misma forma
            # Usar el modelo base si se pidió un modelo .en
            model_to_load = self.model_name.replace(".en", "")
            self.model = whisper.load_model(model_to_load)
        else:
            from faster_whisper import WhisperModel
            self.model = WhisperModel(
                self.model_name, 
                device="cpu", 
                compute_type="int8"
            )
        return self
    
    def transcribe(self, audio_path, language=None, **kwargs):
        """
        Transcribe un archivo de audio.
        
        Args:
            audio_path: Ruta al archivo de audio
            language: Código de idioma (opcional, override del constructor)
            **kwargs: Argumentos adicionales específicos del backend
            
        Returns:
            dict con:
                - text: Texto completo transcrito
                - segments: Lista de segmentos con timestamps
                - language: Idioma detectado/usado
        """
        lang = language or self.language
        
        if is_macos():
            return self._transcribe_openai(audio_path, lang, **kwargs)
        else:
            return self._transcribe_faster(audio_path, lang, **kwargs)
    
    def _transcribe_openai(self, audio_path, language, **kwargs):
        """Transcripción usando openai-whisper"""
        options = {"language": language} if language else {}
        
        # openai-whisper devuelve un dict directamente
        result = self.model.transcribe(audio_path, **options)
        
        segments = []
        for seg in result.get("segments", []):
            segments.append({
                "start": seg["start"],
                "end": seg["end"],
                "text": seg["text"].strip()
            })
        
        return {
            "text": result["text"].strip(),
            "segments": segments,
            "language": result.get("language", language)
        }
    
    def _transcribe_faster(self, audio_path, language, **kwargs):
        """Transcripción usando faster-whisper"""
        # Parámetros optimizados para Raspberry Pi
        transcribe_options = {
            "language": language,
            "beam_size": kwargs.get("beam_size", 1),
            "best_of": kwargs.get("best_of", 1),
            "vad_filter": kwargs.get("vad_filter", True),
        }
        
        if transcribe_options["vad_filter"]:
            transcribe_options["vad_parameters"] = dict(
                min_silence_duration_ms=kwargs.get("min_silence_duration_ms", 500)
            )
        
        # faster-whisper devuelve un generator
        segments_gen, info = self.model.transcribe(audio_path, **transcribe_options)
        
        full_text = ""
        segments = []
        
        for seg in segments_gen:
            full_text += seg.text + " "
            segments.append({
                "start": seg.start,
                "end": seg.end,
                "text": seg.text.strip()
            })
        
        return {
            "text": full_text.strip(),
            "segments": segments,
            "language": info.language if hasattr(info, 'language') else language
        }
    
    def __del__(self):
        """Libera el modelo de memoria"""
        if self.model is not None:
            del self.model
            self.model = None


def transcribe_audio(audio_path, model_name="tiny", language=None):
    """
    Función de conveniencia para transcribir audio.
    
    Args:
        audio_path: Ruta al archivo de audio
        model_name: Modelo whisper a usar
        language: Código de idioma (None para autodetección)
        
    Returns:
        dict con text, segments y language
    """
    stt = WhisperSTT(model_name=model_name, language=language)
    stt.load()
    result = stt.transcribe(audio_path)
    del stt
    return result
