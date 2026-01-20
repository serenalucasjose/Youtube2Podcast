# Modelos para el Pipeline de Traducción

Este directorio contiene (o debe contener) los modelos de IA necesarios para el pipeline de traducción.

## Modelos Requeridos

| Etapa | Modelo | Tamaño Aprox. | Descripción |
|-------|--------|---------------|-------------|
| STT (Speech-to-Text) | `faster-whisper` tiny | ~75 MB | Transcripción de audio inglés a texto |
| Traducción | `Helsinki-NLP/opus-mt-en-es` | ~200 MB | Traducción inglés → español |
| TTS (Text-to-Speech) | `piper-tts` | ~250 MB | Síntesis de voz offline (voces neurales) |

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

### 3. Piper TTS (Text-to-Speech)

Piper es un sistema TTS neural que funciona **100% offline**. Los modelos se descargan automáticamente a `models/piper/`.

**Voces disponibles en español:**

| Voz | Región | Género | Calidad | Tamaño |
|-----|--------|--------|---------|--------|
| `es_ES-davefx` | España | Masculina | Media | ~60 MB |
| `es_ES-mls_10246` | España | Femenina | Baja | ~30 MB |
| `es_MX-ald` | México | Masculina | Media | ~60 MB |
| `es_MX-claude` | México | Femenina | Alta | ~100 MB |

Los modelos se descargan desde Hugging Face:
- https://huggingface.co/rhasspy/piper-voices

## Estructura de Directorios

```
models/
├── README.md                      # Este archivo
├── piper/                         # Modelos Piper TTS
│   ├── es_ES-davefx-medium.onnx
│   ├── es_ES-davefx-medium.onnx.json
│   ├── es_ES-mls_10246-low.onnx
│   ├── es_ES-mls_10246-low.onnx.json
│   ├── es_MX-ald-medium.onnx
│   ├── es_MX-ald-medium.onnx.json
│   ├── es_MX-claude-high.onnx
│   └── es_MX-claude-high.onnx.json
└── (otros modelos se cachean en ~/.cache/huggingface/)
```

## Notas para Raspberry Pi 4

- **Memoria**: Asegúrate de tener al menos 2GB de swap habilitado.
- **Tiempo de carga**: La primera ejecución puede tardar varios minutos.
- **Modelo STT recomendado**: Usa `tiny` para mejor rendimiento en ARM.
- **TTS offline**: Piper TTS funciona sin conexión a internet.

## Configuración de Swap (Raspberry Pi)

```bash
sudo dphys-swapfile swapoff
sudo nano /etc/dphys-swapfile  # Cambiar CONF_SWAPSIZE=2048
sudo dphys-swapfile setup
sudo dphys-swapfile swapon
```

