# Youtube2Podcast (Raspberry Pi Edition)

Esta aplicación permite descargar audios de YouTube, convertirlos a video (MP4 con imagen estática) y servirlos localmente para ser consumidos como un podcast personal.

## Características

*   **Descarga y Conversión**: Convierte videos de YouTube a MP4 optimizados para audio.
*   **Gestión de Usuarios**: Sistema de login y aislamiento de contenido por usuario.
*   **Modo Caminata**: Bloqueo de pantalla para evitar toques accidentales mientras escuchas en movimiento.
*   **Carga Optimista**: Visualiza el episodio inmediatamente mientras se procesa en segundo plano.
*   **Panel de Administración**: Gestión de usuarios y limpieza de datos.

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
3. **Procesamiento**: El episodio aparecerá inmediatamente en estado "Procesando". Podrás reproducirlo una vez finalice la descarga y conversión.
4. **Modo Caminata**: Actívalo desde el menú superior para bloquear la pantalla. Mantén presionado el círculo central para desbloquear.

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
- `downloads/`: Archivos MP4 generados.
- `src/`: Código fuente.
- `views/`: Plantillas EJS.

## Notas Técnicas

- La base de datos se migra automáticamente al iniciar.
- Las descargas continúan en segundo plano incluso si cierras la pestaña (el servidor debe seguir corriendo).
