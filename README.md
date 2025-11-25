# Youtube2Podcast (Raspberry Pi Edition)

Esta aplicación permite descargar audios de YouTube, convertirlos a MP3 con carátula (album art) y servirlos localmente para ser consumidos como un podcast personal.

## Características

*   **Descarga y Conversión Eficiente**: Convierte videos de YouTube a **MP3** incrustando el thumbnail original como carátula. Esto reduce drásticamente el espacio ocupado en comparación con videos.
*   **Gestión de Usuarios**: Sistema de login y aislamiento de contenido por usuario.
*   **Gestión de Episodios**: Los usuarios pueden agregar y **eliminar** sus propios episodios (uno a uno o selección múltiple).
*   **Reproductor Nativo**: Opción para abrir los archivos directamente en el reproductor de audio nativo de tu dispositivo (ideal para móviles).
*   **Modo Caminata**: Bloqueo de pantalla para evitar toques accidentales mientras escuchas en movimiento.
*   **Carga Optimista**: Visualiza el episodio inmediatamente mientras se procesa en segundo plano.
*   **Panel de Administración**: Gestión de usuarios y limpieza general de datos.

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

1. **Login**: Ingresa con las credenciales por defecto (ver abajo).
2. **Agregar Podcast**: Pega una URL de YouTube en la barra de entrada.
3. **Procesamiento**: El episodio aparecerá inmediatamente en estado "Procesando". 
4. **Reproducción**:
    - Usa el reproductor web integrado.
    - O haz clic en **"Abrir"** para usar tu app de música favorita.
    - O haz clic en **"Descargar"** para guardar el archivo.
5. **Gestión**: Selecciona episodios con el checkbox para borrarlos en lote, o usa el icono de papelera en cada tarjeta.
6. **Modo Caminata**: Actívalo desde el menú superior para bloquear la pantalla. Mantén presionado el círculo central para desbloquear.

## Credenciales por Defecto

El sistema crea automáticamente usuarios al iniciar si no existen:

| Rol | Usuario | Contraseña | Descripción |
|---|---|---|---|
| **Admin** | `admin` | `admin` | Acceso completo al panel de administración. |
| **Usuario** | `user` | `user` | Usuario estándar. |
| **Usuario** | `test1` | `password` | Usuario de prueba adicional. |
| **Usuario** | `test2` | `password` | Usuario de prueba adicional. |

**Nota**: Se recomienda cambiar estas contraseñas o crear nuevos usuarios desde el panel de administración (`/admin`).

## Estructura de Carpetas

- `data/`: Base de datos SQLite (`youtube2podcast.db`) y Sesiones.
- `downloads/`: Archivos MP3 generados.
- `src/`: Código fuente.
- `views/`: Plantillas EJS.

## Notas Técnicas

- La base de datos se migra automáticamente al iniciar.
- Las descargas continúan en segundo plano incluso si cierras la pestaña (el servidor debe seguir corriendo).
- Los archivos antiguos MP4 siguen siendo soportados y se visualizarán en el reproductor de video antiguo.
