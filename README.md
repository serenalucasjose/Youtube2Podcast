# Youtube2Podcast (Raspberry Pi Edition)

Esta aplicación permite descargar audios de YouTube, convertirlos a MP3 con carátula (album art) y servirlos localmente para ser consumidos como un podcast personal. Incluye pipelines de traducción automática (doblaje) y transcripción usando modelos de IA locales.

## Características

*   **Descarga y Conversión Eficiente**: Convierte videos de YouTube a **MP3** incrustando el thumbnail original como carátula. Esto reduce drásticamente el espacio ocupado en comparación con videos.
*   **Doblaje al Español**: Pipeline STT → Traducción → TTS para convertir podcasts en inglés a español (procesamiento local, sin APIs externas). **Ahora con selección de voz** (España, México, Argentina, Colombia).
*   **Transcripción a PDF**: Genera transcripciones con timestamps en formato PDF. Soporta múltiples idiomas (inglés, español, francés, alemán, italiano, portugués, y más).
*   **Notificaciones Push**: Recibe alertas cuando las descargas, doblajes o transcripciones terminan, incluso si cierras el navegador.
*   **Temporizador de Sueño (Sleep Timer)**: Programa la detención automática de la reproducción después de 15, 30, 45 o 60 minutos.
*   **Gestión de Usuarios**: Sistema de login y aislamiento de contenido por usuario.
*   **Gestión de Episodios**: Los usuarios pueden agregar y **eliminar** sus propios episodios (uno a uno o selección múltiple).
*   **Reproductor Nativo**: Opción para abrir los archivos directamente en el reproductor de audio nativo de tu dispositivo (ideal para móviles).
*   **Modo Caminata**: Bloqueo de pantalla para evitar toques accidentales mientras escuchas en movimiento.
*   **Carga Optimista**: Visualiza el episodio inmediatamente mientras se procesa en segundo plano.
*   **Panel de Administración**: Gestión de usuarios, visualización de todos los podcasts y limpieza general de datos.
*   **Modo Oscuro/Claro**: Cambia entre tema oscuro y claro según tu preferencia, con persistencia en el navegador.
*   **Iconografía Bootstrap Icons**: Interfaz consistente con iconos modernos de Bootstrap Icons.

## Requisitos

- Raspberry Pi 4 (4GB+ RAM recomendado) o cualquier sistema Linux
- Node.js 18+
- FFmpeg
- Python 3.9+ (para yt-dlp y pipeline de traducción)

## Instalación

### 1. Clonar el repositorio

```bash
git clone <url-del-repo>
cd Youtube2Podcast
```

### 2. Instalar dependencias del sistema y Python

```bash
chmod +x scripts/install_dependencies.sh
./scripts/install_dependencies.sh
```

Este script:
- Instala FFmpeg, Python, y dependencias de compilación para ARM
- Crea un entorno virtual Python (`venv/`)
- Instala las dependencias de Python para el pipeline de traducción
- Crea el directorio `models/`

### 3. Descargar modelos de IA (para traducción)

```bash
source venv/bin/activate
python scripts/download_models.py
```

> **Nota**: La primera descarga puede tardar varios minutos (~500MB en total).

Los modelos descargados son:
| Modelo | Tamaño | Función |
|--------|--------|---------|
| `faster-whisper` (tiny) | ~75 MB | Speech-to-Text (multiidioma) |
| `Helsinki-NLP/opus-mt-en-es` | ~200 MB | Traducción EN→ES |
| `edge-tts` | N/A (online) | Text-to-Speech (español, usa Microsoft Edge) |
| `fpdf2` | N/A (librería) | Generación de PDFs para transcripciones |

> **Nota**: `edge-tts` requiere conexión a internet ya que usa los servicios de Microsoft Edge TTS.

### 4. Instalar dependencias de Node.js

```bash
npm install
```

### 5. Construir estilos (opcional)

```bash
npm run build:css
```

## Configuración para Raspberry Pi 4

Para un rendimiento óptimo en Raspberry Pi 4:

### Habilitar Swap (recomendado 2GB+)

```bash
sudo dphys-swapfile swapoff
sudo nano /etc/dphys-swapfile  # Cambiar CONF_SWAPSIZE=2048
sudo dphys-swapfile setup
sudo dphys-swapfile swapon
```

### Variables de entorno

Crear un archivo `.env` (puedes copiar `.env.example` como base):

```env
PORT=3000
SESSION_SECRET=tu_secreto_seguro
ENABLE_LOGS=true

# Push Notifications (opcional pero recomendado)
VAPID_PUBLIC_KEY=tu_clave_publica
VAPID_PRIVATE_KEY=tu_clave_privada
VAPID_SUBJECT=mailto:tu-email@ejemplo.com
```

#### Configurar Notificaciones Push

Las notificaciones push permiten recibir alertas cuando las traducciones terminan, incluso si cierras la pestaña del navegador.

1. **Generar claves VAPID** (solo una vez):

```bash
npx web-push generate-vapid-keys
```

2. **Copiar las claves al archivo `.env`**:

```env
VAPID_PUBLIC_KEY=BKx-0AmSLXWHejj4WzNFXQk7KP9NpdKHoDdGWFDNk7HIjrSVOPfkGvQeKBMF3miZeAq3F_C-WbuBEDTvIw4oRuk
VAPID_PRIVATE_KEY=b9q1U6CSctYTJes3jtkurGwqCOUxgr1C-sstohXKIRo
VAPID_SUBJECT=mailto:admin@tudominio.com
```

3. **Activar en la aplicación**:
   - Inicia sesión en la aplicación
   - Haz clic en el icono de campana (🔔) en la barra de navegación
   - Acepta el permiso de notificaciones del navegador
   - El icono se pondrá verde cuando las notificaciones estén activas

> **Nota**: Las notificaciones push requieren HTTPS en producción (excepto en `localhost`). En una Raspberry Pi local, funcionan correctamente con HTTP en la red local.

## Ejecución

Para iniciar el servidor:

```bash
npm start
```

La aplicación estará disponible en `http://localhost:3000` (o la IP de tu Raspberry Pi).

## Uso

1. **Login**: Ingresa con las credenciales por defecto (ver abajo).
2. **Agregar Podcast**: Pega una URL de YouTube en la barra de entrada.
3. **Procesamiento**: El episodio aparecerá inmediatamente en estado "Procesando". 
4. **Reproducción**:
    - Usa el reproductor web integrado.
    - O haz clic en **"Abrir"** para usar tu app de música favorita.
    - O haz clic en **"Descargar"** para guardar el archivo.
5. **Doblar al Español**:
    - Una vez que el episodio esté listo, haz clic en el icono de **traducción** (🌐).
    - **Selecciona la voz** que prefieras (España, México, Argentina o Colombia, masculina o femenina).
    - El proceso de doblaje se ejecuta en segundo plano (STT → Traducción → TTS).
    - Cuando termine, aparecerá un nuevo botón para **descargar la versión en español**.
    - Si tienes las **notificaciones push activadas**, recibirás una alerta cuando termine.
6. **Obtener Transcripción**:
    - Haz clic en el icono de **documento** (📄) en cualquier episodio listo.
    - **Selecciona el idioma** del audio original para mejor precisión.
    - La transcripción se genera como **PDF con timestamps**.
    - Cuando termine, podrás descargar el PDF haciendo clic en el icono morado.
7. **Temporizador de Sueño**:
    - Haz clic en el icono de **cronómetro** (⏱️) en la barra superior.
    - Selecciona la duración: 15, 30, 45 o 60 minutos.
    - La reproducción se detendrá automáticamente al expirar el tiempo.
    - Puedes cancelar el temporizador en cualquier momento.
8. **Gestión**: Selecciona episodios con el checkbox para borrarlos en lote, o usa el icono de papelera en cada tarjeta.
9. **Modo Caminata**: Actívalo desde el menú superior para bloquear la pantalla. Mantén presionado el círculo central para desbloquear.

### Tiempos de Procesamiento (Raspberry Pi 4)

#### Doblaje (Traducción)

| Duración del audio | Tiempo aprox. |
|--------------------|---------------|
| 1 minuto | ~30 segundos |
| 10 minutos | ~5 minutos |
| 1 hora | ~30-40 minutos |

#### Transcripción

| Duración del audio | Tiempo aprox. |
|--------------------|---------------|
| 1 minuto | ~15 segundos |
| 10 minutos | ~2-3 minutos |
| 1 hora | ~15-20 minutos |

> **Nota**: Los tiempos varían según la complejidad del audio, el idioma y la carga del sistema.

## Credenciales por Defecto

El sistema crea automáticamente usuarios al iniciar si no existen:

| Rol | Usuario | Contraseña | Descripción |
|---|---|---|---|
| **Admin** | `admin` | `admin` | Acceso completo al panel de administración. |
| **Usuario** | `user` | `user` | Usuario estándar. |
| **Usuario** | `test1` | `password` | Usuario de prueba adicional. |
| **Usuario** | `test2` | `password` | Usuario de prueba adicional. |

**Nota**: Se recomienda cambiar estas contraseñas o crear nuevos usuarios desde el panel de administración (`/admin`).

## Gestión de RSS Feeds

La aplicación permite gestionar feeds RSS que se utilizan para generar podcasts IA. Puedes agregar feeds individualmente o importarlos en lote desde un archivo CSV.

### Agregar Feeds Individualmente

1. Accede al panel de administración (`/admin`)
2. Ve a la sección **"RSS Feeds"**
3. Completa el formulario con:
   - **Nombre**: Nombre del feed (ej: "TechCrunch")
   - **URL del Feed**: URL completa del feed RSS (ej: `https://techcrunch.com/feed/`)
   - **Categoría**: Categoría del feed (ej: "Tecnología", "Noticias", "Ciencia")
   - **Idioma**: Código de idioma (`es` para español, `en` para inglés)

### Importar Feeds desde CSV

Para importar múltiples feeds a la vez, puedes usar un archivo CSV con el siguiente formato:

#### Formato del CSV

El archivo CSV debe tener las siguientes columnas (en este orden):

```csv
nombre,url,categoria,idioma
TechCrunch,https://techcrunch.com/feed/,Tecnología,en
El País,https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/portada,Noticias,es
BBC News,https://feeds.bbci.co.uk/news/rss.xml,Noticias,en
```

**Columnas requeridas:**
- `nombre`: Nombre del feed RSS
- `url`: URL completa del feed RSS (debe comenzar con `http://` o `https://`)
- `categoria`: Categoría del feed
- `idioma`: Código de idioma (`es`, `en`, `fr`, `de`, `pt`, etc.)

**Notas importantes:**
- La primera fila debe contener los encabezados de las columnas
- Las URLs deben ser válidas y accesibles
- Los feeds duplicados (misma URL) serán ignorados automáticamente
- El tamaño máximo del archivo es 5MB
- Si un campo contiene comas, debe estar entre comillas dobles

#### Ejemplo de archivo CSV

```csv
nombre,url,categoria,idioma
TechCrunch,https://techcrunch.com/feed/,Tecnología,en
El País,https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/portada,Noticias,es
BBC News,https://feeds.bbci.co.uk/news/rss.xml,Noticias,en
The Verge,https://www.theverge.com/rss/index.xml,Tecnología,en
Xataka,https://feeds.weblogssl.com/xataka2,Tecnología,es
```

#### Pasos para importar

1. Accede al panel de administración (`/admin`)
2. Ve a la sección **"RSS Feeds"**
3. En el formulario **"Importar Feeds RSS desde CSV"**, haz clic en **"Elegir archivo"**
4. Selecciona tu archivo CSV
5. Haz clic en **"Subir e Importar CSV"**
6. Revisa los resultados de la importación:
   - Se mostrará cuántos feeds se importaron exitosamente
   - Si hay errores, podrás ver los detalles de cada fila que falló

**Validaciones:**
- El archivo debe ser un CSV válido
- Todas las columnas requeridas deben estar presentes
- Las URLs deben ser válidas (HTTP o HTTPS)
- Los campos requeridos (nombre, url, categoria) no pueden estar vacíos

## Estructura de Carpetas

```
Youtube2Podcast/
├── data/                  # Base de datos SQLite y sesiones
├── downloads/             # Archivos MP3 generados (originales y traducidos)
├── models/                # Directorio para modelos de IA (ver README interno)
├── scripts/
│   ├── install_dependencies.sh   # Script de instalación
│   ├── download_models.py        # Descarga de modelos de IA
│   ├── process_translation.py    # Pipeline de doblaje (Python)
│   └── process_transcription.py  # Pipeline de transcripción (Python)
├── src/
│   ├── index.js                  # Servidor Express principal
│   ├── db.js                     # Gestión de base de datos
│   ├── downloader.js             # Descarga de videos
│   ├── translation_service.js    # Servicio de doblaje (Node.js wrapper)
│   └── transcription_service.js  # Servicio de transcripción (Node.js wrapper)
├── views/                 # Plantillas EJS
├── public/                # Assets estáticos (CSS, JS, iconos)
├── requirements.txt       # Dependencias Python
└── package.json           # Dependencias Node.js
```

## Notas Técnicas

- La base de datos se migra automáticamente al iniciar.
- Las descargas continúan en segundo plano incluso si cierras la pestaña (el servidor debe seguir corriendo).
- Los archivos antiguos MP4 siguen siendo soportados y se visualizarán en el reproductor de video antiguo.
- El pipeline de traducción se ejecuta en un proceso Python separado para no bloquear el servidor Node.js.
- Los modelos de IA se cachean en `~/.cache/huggingface/` después de la primera descarga.

## Solución de Problemas

### Error: "No se pudo iniciar la traducción/transcripción"
- Verifica que el entorno virtual esté activo: `source venv/bin/activate`
- Asegúrate de que los modelos estén descargados: `python scripts/download_models.py`
- Verifica que `fpdf2` esté instalado: `pip install fpdf2`

### El doblaje o transcripción es muy lenta
- Habilita más swap (ver sección de configuración para Raspberry Pi)
- Cierra otras aplicaciones que consuman memoria
- El modelo `tiny` de Whisper es el más rápido; no cambies a `base` o `small` en Raspberry Pi

### Error de memoria (OOM)
- Aumenta el swap a 4GB si es posible
- Procesa audios más cortos (< 30 minutos)

### El temporizador de sueño no funciona
- Asegúrate de que el audio esté reproduciéndose desde el reproductor web integrado
- El temporizador solo afecta la reproducción en la pestaña actual del navegador

---

## Guía Rápida de Deploy

Copia y ejecuta estos comandos en orden para un deploy completo:

```bash
# 1. Clonar repositorio
git clone <url-del-repo>
cd Youtube2Podcast

# 2. Instalar dependencias del sistema y crear venv de Python
chmod +x scripts/install_dependencies.sh
./scripts/install_dependencies.sh

# 3. Activar entorno virtual e instalar dependencias Python adicionales
source venv/bin/activate
pip install fpdf2
python scripts/download_models.py

# 4. Instalar dependencias de Node.js
npm install

# 5. Construir CSS (opcional pero recomendado)
npm run build:css

# 6. Generar claves VAPID para notificaciones push
npx web-push generate-vapid-keys

# 7. Crear archivo .env con la configuración
cat > .env << 'EOF'
PORT=3000
SESSION_SECRET=cambia_esto_por_un_secreto_seguro
ENABLE_LOGS=true

# Pegar aquí las claves generadas en el paso 6
VAPID_PUBLIC_KEY=tu_clave_publica_aqui
VAPID_PRIVATE_KEY=tu_clave_privada_aqui
VAPID_SUBJECT=mailto:tu-email@ejemplo.com
EOF

# 8. Iniciar la aplicación
npm start
```

### Deploy con PM2 (Producción)

Para mantener la aplicación corriendo en segundo plano:

```bash
# Instalar PM2 globalmente
npm install -g pm2

# Iniciar con PM2
pm2 start src/index.js --name youtube2podcast

# Configurar inicio automático al reiniciar
pm2 startup
pm2 save

# Comandos útiles de PM2
pm2 logs youtube2podcast    # Ver logs
pm2 restart youtube2podcast # Reiniciar
pm2 stop youtube2podcast    # Detener
```

### Actualización

```bash
cd Youtube2Podcast
git pull
source venv/bin/activate
pip install -r requirements.txt
npm install
npm run build:css
pm2 restart youtube2podcast  # o: npm start
```
