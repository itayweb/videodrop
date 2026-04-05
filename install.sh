#!/usr/bin/env bash
# VideoDrop install script — run as root inside your Proxmox LXC
set -euo pipefail

INSTALL_DIR="/opt/videodrop"
SERVICE_USER="videodrop"

echo "==> Creating user $SERVICE_USER"
id -u "$SERVICE_USER" &>/dev/null || useradd -r -s /bin/false "$SERVICE_USER"

echo "==> Copying app to $INSTALL_DIR"
rsync -a --exclude '.git' --exclude 'frontend/node_modules' "$(dirname "$0")/" "$INSTALL_DIR/"

echo "==> Installing Python dependencies"
python3 -m venv "$INSTALL_DIR/venv"
"$INSTALL_DIR/venv/bin/pip" install --quiet -r "$INSTALL_DIR/requirements.txt"

echo "==> Building frontend"
cd "$INSTALL_DIR/frontend"
npm ci --silent
npm run build

echo "==> Installing systemd service"
cp "$INSTALL_DIR/systemd/videodrop.service" /etc/systemd/system/videodrop.service
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"
systemctl daemon-reload
systemctl enable videodrop
systemctl restart videodrop

echo ""
echo "Done! VideoDrop is running on http://0.0.0.0:8080"
echo "Edit $INSTALL_DIR/config.yaml to set your password and mount paths."
echo "Then: systemctl restart videodrop"
