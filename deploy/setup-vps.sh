#!/bin/bash
# ============================================================
# iaADN — Deploy script for Oracle Cloud Free Tier (ARM/Ubuntu)
# Run as: bash setup-vps.sh
# ============================================================

set -e

echo "========================================="
echo "  iaADN — VPS Deployment Script"
echo "========================================="

# 1. Update system
echo "[1/7] Updating system..."
sudo apt update && sudo apt upgrade -y

# 2. Install Node.js 20 LTS
echo "[2/7] Installing Node.js 20..."
if ! command -v node &> /dev/null || [[ $(node -v | cut -d'.' -f1 | tr -d 'v') -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt install -y nodejs
fi
echo "Node.js version: $(node -v)"
echo "npm version: $(npm -v)"

# 3. Install build tools (needed for node-llama-cpp native compilation)
echo "[3/7] Installing build tools..."
sudo apt install -y build-essential cmake git

# 4. Clone or update the project
echo "[4/7] Setting up iaADN..."
INSTALL_DIR="$HOME/iaADN"

if [ -d "$INSTALL_DIR" ]; then
  echo "Directory exists, pulling latest..."
  cd "$INSTALL_DIR"
  git pull
else
  echo "Enter your git repo URL (or press Enter to skip and upload manually):"
  read -r REPO_URL
  if [ -n "$REPO_URL" ]; then
    git clone "$REPO_URL" "$INSTALL_DIR"
  else
    mkdir -p "$INSTALL_DIR"
    echo "Upload your project files to $INSTALL_DIR and re-run this script"
    exit 0
  fi
fi

cd "$INSTALL_DIR"

# 5. Install dependencies
echo "[5/7] Installing npm dependencies..."
npm install

# 6. Create data directories
echo "[6/7] Creating data directories..."
mkdir -p data/models data/adapters data/genomes data/training data/snapshots data/audit

# 7. Download the Llama model
MODEL_PATH="data/models/llama-3.2-1b-instruct-q4_k_m.gguf"
if [ ! -f "$MODEL_PATH" ]; then
  echo "[7/7] Downloading Llama 3.2 1B model (770MB)..."
  echo "This may take a few minutes..."
  curl -L -o "$MODEL_PATH" \
    "https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf"
  echo "Model downloaded: $(du -h $MODEL_PATH | cut -f1)"
else
  echo "[7/7] Model already exists, skipping download"
fi

echo ""
echo "========================================="
echo "  Setup complete!"
echo "========================================="
echo ""
echo "Test it with:  node src/index.js"
echo "Run daemon:    node src/index.js --daemon"
echo ""
echo "Next: run 'bash deploy/setup-service.sh' to configure auto-start"
