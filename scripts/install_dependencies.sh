#!/bin/bash

# Install system dependencies
sudo apt-get update
sudo apt-get install -y ffmpeg python3 python3-pip atomicparsley

# Additional dependencies for translation pipeline (ARM/Raspberry Pi compatible)
sudo apt-get install -y build-essential libopenblas-dev libblas-dev python3-venv

# Create Python virtual environment for translation pipeline
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
VENV_DIR="$PROJECT_DIR/venv"

if [ ! -d "$VENV_DIR" ]; then
    echo "Creating Python virtual environment..."
    python3 -m venv "$VENV_DIR"
fi

# Activate virtual environment and install Python dependencies
source "$VENV_DIR/bin/activate"

echo "Installing Python dependencies for translation pipeline..."
pip install --upgrade pip
pip install -r "$PROJECT_DIR/requirements.txt"

# Create models directory if it doesn't exist
MODELS_DIR="$PROJECT_DIR/models"
if [ ! -d "$MODELS_DIR" ]; then
    mkdir -p "$MODELS_DIR"
    echo "Created models directory at $MODELS_DIR"
fi

# Verify installations
ffmpeg -version
python3 --version

echo ""
echo "System dependencies installed successfully."
echo ""
echo "IMPORTANT: To download the required AI models, run:"
echo "  source venv/bin/activate"
echo "  python scripts/download_models.py"
echo ""
echo "Or see models/README.md for manual download instructions."
