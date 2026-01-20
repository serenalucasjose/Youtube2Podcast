#!/usr/bin/env python3
"""
Utilidad de Text-to-Speech multiplataforma.

Usa piper-tts en Linux/Raspberry Pi (modelos ONNX offline)
Usa pyttsx3 en macOS (voces nativas del sistema)
"""

import platform
import os
import tempfile
import wave
from pathlib import Path

# Directorio de modelos Piper (Linux)
PIPER_MODELS_DIR = Path(__file__).parent.parent / "models" / "piper"

# Voces Piper disponibles (Linux)
PIPER_VOICES = {
    "es_ES-davefx": "es_ES-davefx-medium.onnx",
    "es_ES-mls_10246": "es_ES-mls_10246-low.onnx",
    "es_MX-ald": "es_MX-ald-medium.onnx",
    "es_MX-claude": "es_MX-claude-high.onnx",
}

# Mapeo de voces antiguas (edge-tts) a nuevas
VOICE_MIGRATION = {
    "es-ES-AlvaroNeural": "es_ES-davefx",
    "es-ES-ElviraNeural": "es_ES-mls_10246",
    "es-MX-JorgeNeural": "es_MX-ald",
    "es-MX-DaliaNeural": "es_MX-claude",
    "es-AR-TomasNeural": "es_ES-davefx",
    "es-AR-ElenaNeural": "es_ES-mls_10246",
    "es-CO-GonzaloNeural": "es_ES-davefx",
    "es-CO-SalomeNeural": "es_ES-mls_10246",
}

DEFAULT_VOICE = "es_ES-davefx"


def is_macos():
    """Detecta si estamos en macOS"""
    return platform.system() == "Darwin"


def is_piper_available():
    """Verifica si piper-tts está disponible"""
    try:
        import piper
        return True
    except ImportError:
        return False


def is_espeak_available():
    """Verifica si espeak está disponible en el sistema"""
    import shutil
    return shutil.which("espeak-ng") is not None or shutil.which("espeak") is not None


def get_tts_backend():
    """Retorna el nombre del backend TTS disponible"""
    if is_macos():
        return "pyttsx3"
    elif is_piper_available():
        return "piper-tts"
    elif is_espeak_available():
        return "espeak"
    else:
        return "none"


def normalize_voice(voice: str) -> str:
    """Normaliza el nombre de voz, migrando voces antiguas si es necesario"""
    voice_id = VOICE_MIGRATION.get(voice, voice)
    if voice_id not in PIPER_VOICES:
        voice_id = DEFAULT_VOICE
    return voice_id


class TextToSpeech:
    """
    Wrapper unificado para Text-to-Speech.
    Usa piper-tts en Linux y pyttsx3 en macOS.
    """
    
    def __init__(self, voice: str = DEFAULT_VOICE):
        """
        Inicializa el motor TTS.
        
        Args:
            voice: Identificador de voz (se normaliza automáticamente)
        """
        self.voice = normalize_voice(voice)
        self._backend = get_tts_backend()
        self._engine = None
        self._piper_voice = None
        self._espeak_cmd = None
        
    def load(self):
        """Carga el motor TTS"""
        if is_macos():
            self._load_pyttsx3()
        elif is_piper_available():
            self._load_piper()
        elif is_espeak_available():
            self._load_espeak()
        else:
            raise RuntimeError(
                "No hay backend TTS disponible. Instala piper-tts o espeak:\n"
                "  pip install piper-tts\n"
                "  -- o --\n"
                "  sudo apt-get install espeak-ng"
            )
        return self
    
    def _load_pyttsx3(self):
        """Carga pyttsx3 para macOS"""
        import pyttsx3
        self._engine = pyttsx3.init()
        
        # Configurar propiedades de voz
        self._engine.setProperty('rate', 175)  # Velocidad (palabras por minuto)
        self._engine.setProperty('volume', 1.0)
        
        # Intentar seleccionar una voz en español
        voices = self._engine.getProperty('voices')
        spanish_voice = None
        for v in voices:
            # Buscar voces en español
            if 'spanish' in v.name.lower() or 'español' in v.name.lower() or \
               'es_' in v.id.lower() or 'es-' in v.id.lower():
                spanish_voice = v.id
                break
        
        if spanish_voice:
            self._engine.setProperty('voice', spanish_voice)
    
    def _load_piper(self):
        """Carga Piper TTS para Linux"""
        from piper import PiperVoice
        
        model_path = PIPER_MODELS_DIR / PIPER_VOICES.get(self.voice, PIPER_VOICES[DEFAULT_VOICE])
        
        if not model_path.exists():
            # Intentar con voz por defecto
            model_path = PIPER_MODELS_DIR / PIPER_VOICES[DEFAULT_VOICE]
            
        if not model_path.exists():
            raise FileNotFoundError(
                f"No se encontró modelo Piper en {model_path}. "
                f"Ejecuta: python scripts/download_models.py"
            )
        
        self._piper_voice = PiperVoice.load(str(model_path))
    
    def _load_espeak(self):
        """Configura espeak como backend TTS (fallback para Linux/ARM)"""
        import shutil
        self._espeak_cmd = shutil.which("espeak-ng") or shutil.which("espeak")
        if not self._espeak_cmd:
            raise RuntimeError("espeak no está instalado")
    
    def synthesize(self, text: str, output_path: str, progress_callback=None) -> bool:
        """
        Sintetiza texto a audio MP3.
        
        Args:
            text: Texto a sintetizar
            output_path: Ruta del archivo MP3 de salida
            progress_callback: Función opcional para reportar progreso (percent, message)
            
        Returns:
            True si fue exitoso
        """
        if is_macos():
            return self._synthesize_pyttsx3(text, output_path, progress_callback)
        elif self._piper_voice is not None:
            return self._synthesize_piper(text, output_path, progress_callback)
        elif hasattr(self, '_espeak_cmd') and self._espeak_cmd:
            return self._synthesize_espeak(text, output_path, progress_callback)
        else:
            raise RuntimeError("No hay backend TTS cargado")
    
    def _synthesize_pyttsx3(self, text: str, output_path: str, progress_callback=None) -> bool:
        """Síntesis usando pyttsx3 (macOS)"""
        from pydub import AudioSegment
        
        if progress_callback:
            progress_callback(70, "Iniciando síntesis de voz (macOS)...")
        
        # Dividir texto largo en chunks
        MAX_CHARS = 2000
        chunks = self._split_text(text, MAX_CHARS)
        
        if progress_callback:
            progress_callback(72, f"Sintetizando {len(chunks)} segmento(s)...")
        
        combined = AudioSegment.empty()
        
        for i, chunk in enumerate(chunks):
            if not chunk.strip():
                continue
            
            # pyttsx3 en macOS guarda como AIFF, luego convertimos
            with tempfile.NamedTemporaryFile(suffix='.aiff', delete=False) as tmp:
                tmp_path = tmp.name
            
            try:
                # Importante: say() antes de save_to_file para que funcione en macOS
                self._engine.say(" ")
                self._engine.save_to_file(chunk, tmp_path)
                self._engine.runAndWait()
                
                # Verificar que se creó el archivo
                if os.path.exists(tmp_path) and os.path.getsize(tmp_path) > 0:
                    combined += AudioSegment.from_file(tmp_path)
                else:
                    # Fallback: si falla save_to_file, usar espeak o similar
                    raise Exception("pyttsx3 no generó audio")
                    
            finally:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
            
            if progress_callback:
                progress = 72 + int((i + 1) / len(chunks) * 20)
                progress_callback(progress, f"Segmento {i+1}/{len(chunks)}")
        
        # Exportar a MP3
        if progress_callback:
            progress_callback(94, "Exportando MP3...")
        
        combined.export(output_path, format="mp3", bitrate="128k")
        
        if progress_callback:
            progress_callback(98, "Audio generado correctamente")
        
        return True
    
    def _synthesize_piper(self, text: str, output_path: str, progress_callback=None) -> bool:
        """Síntesis usando Piper TTS (Linux)"""
        from pydub import AudioSegment
        
        if progress_callback:
            progress_callback(70, "Iniciando síntesis de voz (Piper)...")
        
        # Dividir texto largo en chunks
        MAX_CHARS = 2000
        chunks = self._split_text(text, MAX_CHARS)
        
        if progress_callback:
            progress_callback(72, f"Sintetizando {len(chunks)} segmento(s)...")
        
        combined = AudioSegment.empty()
        
        for i, chunk in enumerate(chunks):
            if not chunk.strip():
                continue
            
            with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp:
                tmp_path = tmp.name
            
            try:
                with wave.open(tmp_path, 'wb') as wav_file:
                    self._piper_voice.synthesize(chunk, wav_file)
                
                combined += AudioSegment.from_wav(tmp_path)
            finally:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
            
            if progress_callback:
                progress = 72 + int((i + 1) / len(chunks) * 20)
                progress_callback(progress, f"Segmento {i+1}/{len(chunks)}")
        
        # Exportar a MP3
        if progress_callback:
            progress_callback(94, "Exportando MP3...")
        
        combined.export(output_path, format="mp3", bitrate="128k")
        
        if progress_callback:
            progress_callback(98, "Audio generado correctamente")
        
        return True
    
    def _synthesize_espeak(self, text: str, output_path: str, progress_callback=None) -> bool:
        """Síntesis usando espeak (fallback para Linux/ARM)"""
        import subprocess
        from pydub import AudioSegment
        
        if progress_callback:
            progress_callback(70, "Iniciando síntesis de voz (espeak)...")
        
        # Dividir texto largo en chunks
        MAX_CHARS = 2000
        chunks = self._split_text(text, MAX_CHARS)
        
        if progress_callback:
            progress_callback(72, f"Sintetizando {len(chunks)} segmento(s)...")
        
        combined = AudioSegment.empty()
        
        for i, chunk in enumerate(chunks):
            if not chunk.strip():
                continue
            
            with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp:
                tmp_path = tmp.name
            
            try:
                # Usar espeak para generar WAV
                # -v es+f3 = voz en español femenina variante 3
                # -s 150 = velocidad 150 palabras por minuto
                cmd = [
                    self._espeak_cmd,
                    '-v', 'es',
                    '-s', '150',
                    '-w', tmp_path,
                    chunk
                ]
                
                result = subprocess.run(cmd, capture_output=True, text=True)
                
                if result.returncode != 0:
                    raise RuntimeError(f"espeak falló: {result.stderr}")
                
                if os.path.exists(tmp_path) and os.path.getsize(tmp_path) > 0:
                    combined += AudioSegment.from_wav(tmp_path)
                    
            finally:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
            
            if progress_callback:
                progress = 72 + int((i + 1) / len(chunks) * 20)
                progress_callback(progress, f"Segmento {i+1}/{len(chunks)}")
        
        # Exportar a MP3
        if progress_callback:
            progress_callback(94, "Exportando MP3...")
        
        combined.export(output_path, format="mp3", bitrate="128k")
        
        if progress_callback:
            progress_callback(98, "Audio generado correctamente")
        
        return True
    
    def _split_text(self, text: str, max_chars: int) -> list:
        """Divide texto largo en chunks respetando oraciones"""
        if len(text) <= max_chars:
            return [text]
        
        sentences = text.replace('. ', '.|').split('|')
        chunks = []
        current = ""
        
        for s in sentences:
            if len(current) + len(s) < max_chars:
                current += s + " "
            else:
                if current:
                    chunks.append(current.strip())
                current = s + " "
        
        if current:
            chunks.append(current.strip())
        
        return chunks
    
    def __del__(self):
        """Libera recursos"""
        if self._engine is not None:
            try:
                self._engine.stop()
            except:
                pass
            self._engine = None
        self._piper_voice = None


# Variable global para TTS cargado (singleton)
_tts_instance = None


def get_tts(voice: str = DEFAULT_VOICE) -> TextToSpeech:
    """
    Obtiene una instancia del TTS (singleton).
    
    Args:
        voice: Voz a usar
        
    Returns:
        Instancia de TextToSpeech cargada
    """
    global _tts_instance
    
    if _tts_instance is None:
        _tts_instance = TextToSpeech(voice)
        _tts_instance.load()
    
    return _tts_instance


def synthesize_speech(text: str, output_path: str, voice: str = DEFAULT_VOICE, 
                      progress_callback=None) -> bool:
    """
    Función de conveniencia para sintetizar voz.
    
    Args:
        text: Texto a sintetizar
        output_path: Ruta del archivo MP3 de salida
        voice: Voz a usar
        progress_callback: Función para reportar progreso
        
    Returns:
        True si fue exitoso
    """
    tts = get_tts(voice)
    return tts.synthesize(text, output_path, progress_callback)
