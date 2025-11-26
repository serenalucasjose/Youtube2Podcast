#!/bin/bash

#######################################################################
# YouTube2Podcast - Script de Inicialización
# 
# Este script guía paso a paso la instalación y configuración de la
# aplicación. Cada paso requiere confirmación del usuario.
#######################################################################

# Colores para mensajes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # Sin color

# Directorio del proyecto (donde está este script)
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$PROJECT_DIR/venv"

#######################################################################
# Funciones auxiliares
#######################################################################

print_header() {
    echo ""
    echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${BOLD}${CYAN}  $1${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
    echo ""
}

print_step() {
    echo -e "${YELLOW}▶${NC} ${BOLD}$1${NC}"
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

print_info() {
    echo -e "${CYAN}ℹ${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

# Función para solicitar confirmación del usuario
# Retorna 0 si el usuario confirma, 1 si rechaza
confirm() {
    local prompt="$1"
    local default="${2:-s}"
    
    if [[ "$default" == "s" ]]; then
        prompt_text="${prompt} [${GREEN}S${NC}/n]: "
    else
        prompt_text="${prompt} [s/${GREEN}N${NC}]: "
    fi
    
    echo -ne "$prompt_text"
    read -r response
    
    # Si la respuesta está vacía, usar el valor por defecto
    if [[ -z "$response" ]]; then
        response="$default"
    fi
    
    # Convertir a minúsculas
    response=$(echo "$response" | tr '[:upper:]' '[:lower:]')
    
    if [[ "$response" == "s" || "$response" == "si" || "$response" == "sí" || "$response" == "y" || "$response" == "yes" ]]; then
        return 0
    else
        return 1
    fi
}

# Verificar si un comando existe
command_exists() {
    command -v "$1" &> /dev/null
}

#######################################################################
# Pasos de instalación
#######################################################################

step_system_dependencies() {
    print_header "PASO 1: Dependencias del Sistema y Python"
    
    print_info "Este paso instalará:"
    echo "  • FFmpeg (procesamiento de audio/video)"
    echo "  • Python 3 y herramientas de desarrollo"
    echo "  • Creará el entorno virtual de Python (venv/)"
    echo ""
    print_warning "Requiere permisos de administrador (sudo)"
    echo ""
    
    if confirm "¿Ejecutar instalación de dependencias del sistema?"; then
        print_step "Ejecutando scripts/install_dependencies.sh..."
        echo ""
        
        chmod +x "$PROJECT_DIR/scripts/install_dependencies.sh"
        if "$PROJECT_DIR/scripts/install_dependencies.sh"; then
            echo ""
            print_success "Dependencias del sistema instaladas correctamente"
            return 0
        else
            print_error "Error instalando dependencias del sistema"
            return 1
        fi
    else
        print_info "Paso omitido por el usuario"
        return 0
    fi
}

step_python_dependencies() {
    print_header "PASO 2: Dependencias del Entorno Virtual Python"
    
    print_info "Este paso actualizará las dependencias de Python:"
    echo "  • Activará el entorno virtual (venv/)"
    echo "  • Ejecutará: pip install -r requirements.txt"
    echo ""
    print_info "Útil después de un 'git pull' si requirements.txt cambió"
    echo ""
    
    # Verificar que existe el entorno virtual
    if [[ ! -d "$VENV_DIR" ]]; then
        print_warning "El entorno virtual no existe. Ejecuta primero el Paso 1."
        return 1
    fi
    
    if confirm "¿Actualizar dependencias de Python?"; then
        print_step "Activando entorno virtual e instalando dependencias..."
        echo ""
        
        # Usar subshell para activar venv y ejecutar pip
        (
            source "$VENV_DIR/bin/activate"
            pip install --upgrade pip
            pip install -r "$PROJECT_DIR/requirements.txt"
        )
        
        if [[ $? -eq 0 ]]; then
            echo ""
            print_success "Dependencias de Python actualizadas correctamente"
            return 0
        else
            print_error "Error actualizando dependencias de Python"
            return 1
        fi
    else
        print_info "Paso omitido por el usuario"
        return 0
    fi
}

step_node_dependencies() {
    print_header "PASO 3: Dependencias de Node.js"
    
    print_info "Este paso instalará los paquetes de Node.js:"
    echo "  • Ejecutará: npm install"
    echo "  • Instalará Express, yt-dlp, better-sqlite3, etc."
    echo ""
    
    if confirm "¿Instalar dependencias de Node.js?"; then
        print_step "Ejecutando npm install..."
        echo ""
        
        cd "$PROJECT_DIR"
        if npm install; then
            echo ""
            print_success "Dependencias de Node.js instaladas correctamente"
            return 0
        else
            print_error "Error instalando dependencias de Node.js"
            return 1
        fi
    else
        print_info "Paso omitido por el usuario"
        return 0
    fi
}

step_env_configuration() {
    print_header "PASO 4: Configuración del Entorno (.env)"
    
    ENV_FILE="$PROJECT_DIR/.env"
    ENV_EXAMPLE="$PROJECT_DIR/.env.example"
    
    # Verificar si .env ya existe
    if [[ -f "$ENV_FILE" ]]; then
        print_info "El archivo .env ya existe."
        echo ""
        cat "$ENV_FILE"
        echo ""
        print_success "Configuración existente detectada. Omitiendo este paso."
        return 0
    fi
    
    print_info "Este paso creará el archivo .env con:"
    echo "  • SESSION_SECRET generado automáticamente"
    echo "  • Claves VAPID para notificaciones push"
    echo "  • Configuración base desde .env.example"
    echo ""
    
    if confirm "¿Generar archivo de configuración .env?"; then
        print_step "Generando configuración..."
        echo ""
        
        # Generar SESSION_SECRET aleatorio
        print_info "Generando SESSION_SECRET..."
        SESSION_SECRET=$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)
        
        # Generar claves VAPID
        print_info "Generando claves VAPID para notificaciones push..."
        cd "$PROJECT_DIR"
        VAPID_OUTPUT=$(npx --yes web-push generate-vapid-keys 2>/dev/null)
        
        if [[ $? -ne 0 ]]; then
            print_error "Error generando claves VAPID"
            print_info "Puedes generarlas manualmente con: npx web-push generate-vapid-keys"
            return 1
        fi
        
        # Extraer claves VAPID de la salida
        VAPID_PUBLIC=$(echo "$VAPID_OUTPUT" | grep "Public Key:" | sed 's/Public Key: *//')
        VAPID_PRIVATE=$(echo "$VAPID_OUTPUT" | grep "Private Key:" | sed 's/Private Key: *//')
        
        if [[ -z "$VAPID_PUBLIC" || -z "$VAPID_PRIVATE" ]]; then
            print_error "No se pudieron extraer las claves VAPID"
            echo "Salida recibida:"
            echo "$VAPID_OUTPUT"
            return 1
        fi
        
        # Crear archivo .env
        cat > "$ENV_FILE" << EOF
# Session secret (generado automáticamente)
SESSION_SECRET=$SESSION_SECRET

# Enable debug logs
ENABLE_LOGS=true

# VAPID Keys for Web Push Notifications (generadas automáticamente)
VAPID_PUBLIC_KEY=$VAPID_PUBLIC
VAPID_PRIVATE_KEY=$VAPID_PRIVATE
VAPID_SUBJECT=mailto:admin@youtube2podcast.local
EOF
        
        echo ""
        print_success "Archivo .env creado correctamente"
        echo ""
        print_info "Contenido generado:"
        echo -e "${CYAN}"
        cat "$ENV_FILE"
        echo -e "${NC}"
        
        print_warning "Recuerda cambiar VAPID_SUBJECT por tu email real si usas notificaciones push"
        return 0
    else
        print_info "Paso omitido por el usuario"
        print_warning "Deberás crear el archivo .env manualmente antes de ejecutar la aplicación"
        return 0
    fi
}

step_build_css() {
    print_header "PASO 5: Construcción de Assets (CSS)"
    
    print_info "Este paso compilará los estilos de Tailwind CSS:"
    echo "  • Ejecutará: npm run build:css"
    echo "  • Generará: public/css/styles.css"
    echo ""
    
    if confirm "¿Compilar estilos CSS?"; then
        print_step "Ejecutando npm run build:css..."
        echo ""
        
        cd "$PROJECT_DIR"
        if npm run build:css; then
            echo ""
            print_success "Estilos CSS compilados correctamente"
            return 0
        else
            print_error "Error compilando estilos CSS"
            return 1
        fi
    else
        print_info "Paso omitido por el usuario"
        return 0
    fi
}

step_download_models() {
    print_header "PASO 6: Modelos de IA"
    
    print_info "Este paso descargará los modelos de IA para traducción:"
    echo "  • faster-whisper (tiny): ~75 MB - Speech-to-Text"
    echo "  • Helsinki-NLP/opus-mt-en-es: ~200 MB - Traducción EN→ES"
    echo "  • Verificará edge-tts para Text-to-Speech"
    echo ""
    print_warning "La descarga puede tardar varios minutos (~500MB total)"
    echo ""
    
    # Verificar que existe el entorno virtual
    if [[ ! -d "$VENV_DIR" ]]; then
        print_warning "El entorno virtual no existe. Ejecuta primero el Paso 1."
        return 1
    fi
    
    if confirm "¿Descargar modelos de IA?"; then
        print_step "Descargando modelos..."
        echo ""
        
        # Usar subshell para activar venv y ejecutar script
        (
            source "$VENV_DIR/bin/activate"
            python "$PROJECT_DIR/scripts/download_models.py"
        )
        
        if [[ $? -eq 0 ]]; then
            echo ""
            print_success "Modelos de IA descargados correctamente"
            return 0
        else
            print_error "Error descargando modelos de IA"
            return 1
        fi
    else
        print_info "Paso omitido por el usuario"
        print_warning "Podrás descargar los modelos más tarde ejecutando:"
        echo "  source venv/bin/activate"
        echo "  python scripts/download_models.py"
        return 0
    fi
}

step_start_server() {
    print_header "PASO 7: Iniciar Servidor"
    
    print_info "La aplicación está lista para ejecutarse."
    echo ""
    echo "  • Puerto: ${CYAN}3000${NC} (o el configurado en .env)"
    echo "  • URL: ${CYAN}http://localhost:3000${NC}"
    echo ""
    print_info "Credenciales por defecto:"
    echo "  • Admin: admin / admin"
    echo "  • Usuario: user / user"
    echo ""
    
    if confirm "¿Iniciar el servidor ahora?"; then
        print_step "Iniciando servidor con npm start..."
        echo ""
        print_info "Presiona Ctrl+C para detener el servidor"
        echo ""
        
        cd "$PROJECT_DIR"
        npm start
    else
        print_info "Servidor no iniciado"
        echo ""
        print_info "Para iniciar el servidor más tarde, ejecuta:"
        echo "  cd $PROJECT_DIR"
        echo "  npm start"
        echo ""
        print_info "Para ejecutar en segundo plano con PM2:"
        echo "  npm install -g pm2"
        echo "  pm2 start src/index.js --name youtube2podcast"
    fi
}

#######################################################################
# Función principal
#######################################################################

main() {
    clear
    
    echo -e "${BOLD}${CYAN}"
    echo "  ╔═══════════════════════════════════════════════════════════╗"
    echo "  ║                                                           ║"
    echo "  ║           🎧  YouTube2Podcast  🎧                         ║"
    echo "  ║                                                           ║"
    echo "  ║           Script de Inicialización                        ║"
    echo "  ║                                                           ║"
    echo "  ╚═══════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
    
    echo ""
    print_info "Este script te guiará paso a paso por la instalación."
    print_info "Cada paso requiere tu confirmación antes de ejecutarse."
    print_info "Puedes omitir pasos que ya hayas completado anteriormente."
    echo ""
    
    # Verificar requisitos mínimos
    print_step "Verificando requisitos mínimos..."
    echo ""
    
    if ! command_exists node; then
        print_error "Node.js no está instalado"
        print_info "Instala Node.js 18+ antes de continuar"
        exit 1
    else
        NODE_VERSION=$(node --version)
        print_success "Node.js instalado: $NODE_VERSION"
    fi
    
    if ! command_exists npm; then
        print_error "npm no está instalado"
        exit 1
    else
        NPM_VERSION=$(npm --version)
        print_success "npm instalado: $NPM_VERSION"
    fi
    
    if command_exists python3; then
        PYTHON_VERSION=$(python3 --version)
        print_success "Python instalado: $PYTHON_VERSION"
    else
        print_warning "Python 3 no detectado (se instalará en el Paso 1)"
    fi
    
    if command_exists ffmpeg; then
        FFMPEG_VERSION=$(ffmpeg -version 2>&1 | head -n1)
        print_success "FFmpeg instalado: $FFMPEG_VERSION"
    else
        print_warning "FFmpeg no detectado (se instalará en el Paso 1)"
    fi
    
    echo ""
    echo -e "${YELLOW}────────────────────────────────────────────────────────────────${NC}"
    echo ""
    
    if ! confirm "¿Continuar con la instalación?"; then
        echo ""
        print_info "Instalación cancelada por el usuario"
        exit 0
    fi
    
    # Ejecutar pasos
    step_system_dependencies
    step_python_dependencies
    step_node_dependencies
    step_env_configuration
    step_build_css
    step_download_models
    
    # Resumen final
    print_header "INSTALACIÓN COMPLETADA"
    
    print_success "YouTube2Podcast está configurado y listo para usar"
    echo ""
    
    # Último paso: iniciar servidor
    step_start_server
    
    echo ""
    print_info "¡Gracias por usar YouTube2Podcast!"
    echo ""
}

# Ejecutar función principal
main "$@"

