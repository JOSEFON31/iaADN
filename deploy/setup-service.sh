#!/bin/bash
# ============================================================
# iaADN — Configure systemd service for auto-start
# Run as: bash deploy/setup-service.sh
# ============================================================

set -e

INSTALL_DIR="$HOME/iaADN"
USER=$(whoami)
NODE_PATH=$(which node)

echo "Creating systemd service for iaADN..."
echo "  Install dir: $INSTALL_DIR"
echo "  User: $USER"
echo "  Node: $NODE_PATH"

# Create the service file
sudo tee /etc/systemd/system/iaadn.service > /dev/null << EOF
[Unit]
Description=iaADN - Decentralized Self-Evolving AI
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE_PATH src/index.js --daemon
Restart=always
RestartSec=10

# Environment
Environment=NODE_ENV=production

# Resource limits (generous for AI inference)
LimitNOFILE=65536
MemoryMax=90%

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=iaadn

[Install]
WantedBy=multi-user.target
EOF

# Reload systemd and enable the service
sudo systemctl daemon-reload
sudo systemctl enable iaadn.service

echo ""
echo "========================================="
echo "  Service configured!"
echo "========================================="
echo ""
echo "Commands:"
echo "  sudo systemctl start iaadn     # Start"
echo "  sudo systemctl stop iaadn      # Stop"
echo "  sudo systemctl restart iaadn   # Restart"
echo "  sudo systemctl status iaadn    # Status"
echo "  journalctl -u iaadn -f         # View logs (live)"
echo ""
echo "The service will auto-start on reboot."
echo ""

# Ask to start now
read -p "Start iaADN now? (y/n): " START_NOW
if [ "$START_NOW" = "y" ] || [ "$START_NOW" = "Y" ]; then
  sudo systemctl start iaadn
  sleep 2
  sudo systemctl status iaadn --no-pager
fi
