# Youtube2Podcast (Raspberry Pi Edition)

Esta aplicación permite descargar audios de YouTube, convertirlos a video (MP4 con imagen estática) y servirlos localmente para ser consumidos como un podcast personal.

## Requisitos

- Raspberry Pi (o cualquier sistema Linux)
- Node.js 18+
- FFmpeg
- Python 3 (para yt-dlp)

## Instalación

1. Clonar el repositorio o copiar los archivos.
2. Ejecutar el script de instalación de dependencias del sistema:
   ```bash
   chmod +x scripts/install_dependencies.sh
   ./scripts/install_dependencies.sh
   ```
3. Instalar dependencias de Node:
   ```bash
   npm install
   ```
4. Construir los estilos (opcional, ya que se incluye el CSS):
   ```bash
   npm run build:css
   ```

## Ejecución

Para iniciar el servidor:

```bash
npm start
```

La aplicación estará disponible en `http://localhost:3000` (o la IP de tu Raspberry Pi).

## Uso

1. Pega una URL de YouTube en la barra de entrada.
2. Haz clic en "Agregar".
3. Espera a que se procese (puede tardar unos minutos dependiendo de la duración y la velocidad de la Raspberry Pi).
4. El episodio aparecerá en la lista y podrás reproducirlo o descargarlo.

## Administración

Puedes acceder al panel de administración en `/admin` (enlace en el pie de página).

**Credenciales por defecto:**
- Usuario: `admin`
- Contraseña: `raspberry`

Puedes cambiarlas creando un archivo `.env` basado en `.env.example`.

## Estructura de Carpetas

- `data/`: Base de datos SQLite.
- `downloads/`: Archivos MP4 generados.
- `src/`: Código fuente.

