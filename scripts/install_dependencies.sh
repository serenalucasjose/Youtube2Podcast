#!/bin/bash

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

print_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Detect operating system
detect_os() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        echo "macos"
    elif [[ -f /etc/debian_version ]]; then
        echo "debian"
    elif [[ -f /etc/fedora-release ]]; then
        echo "fedora"
    elif [[ -f /etc/arch-release ]]; then
        echo "arch"
    elif [[ -f /etc/redhat-release ]]; then
        echo "rhel"
    else
        echo "unknown"
    fi
}

# Install dependencies based on OS
install_system_dependencies() {
    local os=$(detect_os)
    print_info "Detected OS: $os"

    case $os in
        macos)
            print_info "Installing dependencies via Homebrew..."
            
            if ! command -v brew &> /dev/null; then
                print_error "Homebrew is not installed. Please install it first:"
                echo '  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
                exit 1
            fi
            
            brew install ffmpeg python3 atomicparsley pkg-config rust || true
            ;;
            
        debian)
            print_info "Installing dependencies via apt-get..."
            sudo apt-get update
            sudo apt-get install -y ffmpeg python3 python3-pip python3-venv atomicparsley
            sudo apt-get install -y build-essential pkg-config rustc cargo
            ;;
            
        fedora)
            print_info "Installing dependencies via dnf..."
            sudo dnf install -y ffmpeg python3 python3-pip atomicparsley
            sudo dnf install -y gcc gcc-c++ python3-virtualenv pkgconfig rust cargo
            ;;
            
        rhel)
            print_info "Installing dependencies via yum..."
            sudo yum install -y epel-release
            sudo yum install -y ffmpeg python3 python3-pip
            sudo yum install -y gcc gcc-c++ python3-virtualenv pkgconfig rust cargo
            print_warn "atomicparsley may need to be installed manually on RHEL"
            ;;
            
        arch)
            print_info "Installing dependencies via pacman..."
            sudo pacman -Syu --noconfirm ffmpeg python python-pip atomicparsley
            sudo pacman -S --noconfirm base-devel python-virtualenv pkgconf rust
            ;;
            
        *)
            print_warn "Unknown OS - skipping system package installation"
            print_info "Please ensure you have installed: ffmpeg, python3, pip, pkg-config, rust"
            ;;
    esac
}

# Parse arguments
CLEAN_INSTALL=false
SKIP_SYSTEM=false

for arg in "$@"; do
    case $arg in
        --clean)
            CLEAN_INSTALL=true
            ;;
        --skip-system)
            SKIP_SYSTEM=true
            ;;
        --help|-h)
            echo "Usage: $0 [options]"
            echo ""
            echo "Options:"
            echo "  --clean        Remove existing venv and start fresh"
            echo "  --skip-system  Skip system package installation"
            echo "  --help, -h     Show this help message"
            exit 0
            ;;
    esac
done

# Main script
print_info "Starting dependency installation..."

# Set up directories
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
VENV_DIR="$PROJECT_DIR/venv"

# Install system dependencies
if [ "$SKIP_SYSTEM" = false ]; then
    install_system_dependencies
else
    print_info "Skipping system package installation"
fi

# Clean install if requested
if [ "$CLEAN_INSTALL" = true ] && [ -d "$VENV_DIR" ]; then
    print_info "Removing existing virtual environment..."
    rm -rf "$VENV_DIR"
fi

# Create Python virtual environment
if [ ! -d "$VENV_DIR" ]; then
    print_info "Creating Python virtual environment..."
    python3 -m venv "$VENV_DIR"
else
    print_info "Using existing virtual environment at $VENV_DIR"
fi

# Activate virtual environment
source "$VENV_DIR/bin/activate"

# Upgrade pip first
print_info "Upgrading pip..."
pip install --upgrade pip wheel setuptools

# Install Python dependencies based on platform
OS_TYPE=$(detect_os)
if [[ "$OS_TYPE" == "macos" ]]; then
    print_info "Installing Python dependencies (macOS)..."
    pip install -r "$PROJECT_DIR/requirements-macos.txt"
else
    print_info "Installing Python dependencies (Linux)..."
    pip install -r "$PROJECT_DIR/requirements-linux.txt"
fi

# Create models directory if it doesn't exist
MODELS_DIR="$PROJECT_DIR/models"
if [ ! -d "$MODELS_DIR" ]; then
    mkdir -p "$MODELS_DIR"
    print_info "Created models directory at $MODELS_DIR"
fi

# Verify installations
echo ""
print_info "Verifying installations..."
echo ""

command -v ffmpeg &> /dev/null && echo "✓ ffmpeg installed" || print_warn "ffmpeg not found"
command -v python3 &> /dev/null && echo "✓ python3: $(python3 --version 2>&1 | cut -d' ' -f2)" || print_warn "python3 not found"

# Check packages based on platform
if [[ "$OS_TYPE" == "macos" ]]; then
    python -c "import whisper" 2>/dev/null && echo "✓ openai-whisper installed" || print_warn "openai-whisper not installed"
    python -c "import pyttsx3" 2>/dev/null && echo "✓ pyttsx3 installed (offline TTS)" || print_warn "pyttsx3 not installed"
else
    python -c "import faster_whisper" 2>/dev/null && echo "✓ faster-whisper installed" || print_warn "faster-whisper not installed"
    python -c "import piper" 2>/dev/null && echo "✓ piper-tts installed" || print_warn "piper-tts not installed"
fi

python -c "import transformers" 2>/dev/null && echo "✓ transformers installed" || print_warn "transformers not installed"
python -c "import torch" 2>/dev/null && echo "✓ torch installed" || print_warn "torch not installed"

echo ""
print_info "Installation complete!"
echo ""
echo "Next steps:"
echo "  1. Activate the environment: source venv/bin/activate"
echo "  2. Download AI models: python scripts/download_models.py"
echo ""
