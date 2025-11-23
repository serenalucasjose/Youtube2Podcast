#!/bin/bash

# Install system dependencies
sudo apt-get update
sudo apt-get install -y ffmpeg python3 python3-pip atomicparsley

# Verify installations
ffmpeg -version
python3 --version

echo "System dependencies installed successfully."

