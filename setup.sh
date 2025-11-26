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
    
    # Verificar si .env ya existe
    if [[ -f "$ENV_FILE" ]]; then
        print_info "El archivo .env ya existe."
        echo ""
        cat "$ENV_FILE"
        echo ""
        
        # Verificar si tiene NODE_ENV configurado
        if ! grep -q "^NODE_ENV=" "$ENV_FILE"; then
            print_warning "NODE_ENV no está configurado en .env"
            if confirm "¿Agregar NODE_ENV=production al archivo existente?"; then
                echo "" >> "$ENV_FILE"
                echo "# Entorno de ejecución (production para HTTPS/proxy)" >> "$ENV_FILE"
                echo "NODE_ENV=production" >> "$ENV_FILE"
                print_success "NODE_ENV=production agregado al .env"
            fi
        fi
        
        print_success "Configuración existente detectada."
        return 0
    fi
    
    print_info "Este paso creará el archivo .env con:"
    echo "  • NODE_ENV para entorno de producción"
    echo "  • PORT para el servidor"
    echo "  • SESSION_SECRET generado automáticamente"
    echo "  • Claves VAPID para notificaciones push"
    echo ""
    
    # Preguntar por el entorno
    echo -ne "${CYAN}¿Es un entorno de producción (con HTTPS/proxy)? [S/n]: ${NC}"
    read -r is_production
    is_production=$(echo "$is_production" | tr '[:upper:]' '[:lower:]')
    
    if [[ -z "$is_production" || "$is_production" == "s" || "$is_production" == "si" || "$is_production" == "y" ]]; then
        NODE_ENV="production"
    else
        NODE_ENV="development"
    fi
    
    # Preguntar por el puerto
    echo -ne "${CYAN}Puerto del servidor [3000]: ${NC}"
    read -r server_port
    if [[ -z "$server_port" ]]; then
        server_port="3000"
    fi
    
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
# Entorno de ejecución
# production: activa cookies seguras, trust proxy para HTTPS
# development: para desarrollo local sin HTTPS
NODE_ENV=$NODE_ENV

# Puerto del servidor
PORT=$server_port

# Session secret (generado automáticamente - NO COMPARTIR)
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
        
        if [[ "$NODE_ENV" == "production" ]]; then
            print_success "Configurado para producción con HTTPS"
            print_info "Las cookies de sesión serán seguras (solo HTTPS)"
        else
            print_warning "Configurado para desarrollo local"
            print_info "Cambia NODE_ENV=production cuando despliegues con HTTPS"
        fi
        
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
    print_header "PASO 7: Configurar Servicio con PM2"
    
    print_info "La aplicación se ejecutará como servicio con PM2."
    echo ""
    echo "  • Puerto: ${CYAN}3000${NC} (o el configurado en .env)"
    echo ""
    print_info "Credenciales por defecto:"
    echo "  • Admin: admin / admin"
    echo "  • Usuario: user / user"
    echo ""
    
    # Verificar si PM2 está instalado
    if ! command_exists pm2; then
        print_warning "PM2 no está instalado."
        if confirm "¿Instalar PM2 globalmente?"; then
            print_step "Instalando PM2..."
            npm install -g pm2
            if [[ $? -ne 0 ]]; then
                print_error "Error instalando PM2"
                return 1
            fi
            print_success "PM2 instalado correctamente"
        else
            print_info "Paso omitido por el usuario"
            print_warning "Instala PM2 manualmente con: npm install -g pm2"
            return 0
        fi
    else
        print_success "PM2 ya está instalado"
    fi
    
    echo ""
    if confirm "¿Iniciar el servicio con PM2 ahora?"; then
        echo ""
        echo -ne "${CYAN}Nombre del servicio PM2 [youtube2podcast]: ${NC}"
        read -r service_name
        
        # Usar nombre por defecto si está vacío
        if [[ -z "$service_name" ]]; then
            service_name="youtube2podcast"
        fi
        
        print_step "Iniciando servicio '$service_name' con PM2..."
        echo ""
        
        cd "$PROJECT_DIR"
        
        # Eliminar proceso existente con el mismo nombre (si existe)
        pm2 delete "$service_name" 2>/dev/null
        
        # Detectar NODE_ENV desde .env si existe
        ENV_FILE="$PROJECT_DIR/.env"
        if [[ -f "$ENV_FILE" ]] && grep -q "^NODE_ENV=production" "$ENV_FILE"; then
            print_info "Detectado NODE_ENV=production en .env"
            print_info "Iniciando en modo producción (cookies seguras, trust proxy)..."
            pm2 start src/index.js --name "$service_name" --env production
        else
            pm2 start src/index.js --name "$service_name"
        fi
        
        if [[ $? -eq 0 ]]; then
            echo ""
            print_success "Servicio '$service_name' iniciado correctamente"
            echo ""
            print_info "Comandos útiles de PM2:"
            echo "  • Ver estado:    pm2 status"
            echo "  • Ver logs:      pm2 logs $service_name"
            echo "  • Reiniciar:     pm2 restart $service_name"
            echo "  • Detener:       pm2 stop $service_name"
            echo "  • Eliminar:      pm2 delete $service_name"
            echo ""
            print_info "Para que PM2 inicie automáticamente con el sistema:"
            echo "  pm2 save"
            echo "  pm2 startup"
        else
            print_error "Error iniciando el servicio con PM2"
            return 1
        fi
    else
        print_info "Servicio no iniciado"
        echo ""
        print_info "Para iniciar el servicio más tarde, ejecuta:"
        echo "  cd $PROJECT_DIR"
        echo "  pm2 start src/index.js --name <nombre-servicio>"
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

