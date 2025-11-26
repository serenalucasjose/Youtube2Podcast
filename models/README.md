# Modelos para el Pipeline de Traducción

Este directorio contiene (o debe contener) los modelos de IA necesarios para el pipeline de traducción.

## Modelos Requeridos

| Etapa | Modelo | Tamaño Aprox. | Descripción |
|-------|--------|---------------|-------------|
| STT (Speech-to-Text) | `faster-whisper` tiny | ~75 MB | Transcripción de audio inglés a texto |
| Traducción | `Helsinki-NLP/opus-mt-en-es` | ~200 MB | Traducción inglés → español |
| TTS (Text-to-Speech) | `edge-tts` | N/A (online) | Síntesis de voz en español (Microsoft Edge) |

## Descarga Automática

Los modelos se descargan automáticamente la primera vez que se ejecuta el script de traducción. Sin embargo, esto puede tardar varios minutos.

Para pre-descargar los modelos, ejecuta:

```bash
# Activar entorno virtual
source venv/bin/activate

# Ejecutar script de descarga
python scripts/download_models.py
```

## Descarga Manual (Opcional)

Si prefieres descargar los modelos manualmente:

### 1. faster-whisper (STT)
Los modelos de faster-whisper se descargan automáticamente desde Hugging Face.
Se almacenan en `~/.cache/huggingface/hub/`.

Para usar un modelo específico, puedes descargarlo de:
- https://huggingface.co/Systran/faster-whisper-tiny
- https://huggingface.co/Systran/faster-whisper-base

### 2. Helsinki-NLP (Traducción)
```bash
# Usando transformers CLI
python -c "from transformers import pipeline; pipeline('translation', model='Helsinki-NLP/opus-mt-en-es')"
```

### 3. edge-tts (TTS)
`edge-tts` no requiere descarga de modelos locales. Usa los servicios de Microsoft Edge TTS
a través de internet. Requiere conexión a internet para funcionar.

Voces disponibles en español:
- `es-ES-AlvaroNeural` (España, masculina)
- `es-ES-ElviraNeural` (España, femenina)
- `es-MX-DaliaNeural` (México, femenina)
- `es-MX-JorgeNeural` (México, masculina)

## Estructura de Directorios

```
models/
├── README.md          # Este archivo
└── (los modelos se cachean en ~/.cache/huggingface/)
```

## Notas para Raspberry Pi 4

- **Memoria**: Asegúrate de tener al menos 2GB de swap habilitado.
- **Tiempo de carga**: La primera ejecución puede tardar varios minutos.
- **Modelo STT recomendado**: Usa `tiny` para mejor rendimiento en ARM.
- **Conexión a internet**: Requerida para el TTS (edge-tts).

## Configuración de Swap (Raspberry Pi)

```bash
sudo dphys-swapfile swapoff
sudo nano /etc/dphys-swapfile  # Cambiar CONF_SWAPSIZE=2048
sudo dphys-swapfile setup
sudo dphys-swapfile swapon
```

