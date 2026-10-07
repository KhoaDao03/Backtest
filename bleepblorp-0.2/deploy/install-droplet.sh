#!/usr/bin/env bash
# bleepblorp 0.2 — generic Ubuntu droplet install (Strategist / home VPS).
#
# EDUCATIONAL PAPER ASSISTANT. Not financial advice. All trading involves risk.
# You are solely responsible for how you use this software.
#
# This script does NOT place Kalshi orders. It does NOT use anyone else's server.
# Run as root on a fresh Ubuntu 24.04 droplet AFTER you have copied the project
# to /opt/bleepblorp-02 and created /opt/bleepblorp-02/.env.local with YOUR keys.
#
# Example:
#   sudo bash deploy/install-droplet.sh

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/bleepblorp-02}"
APP_USER="${APP_USER:-bleepblorp}"
PORT="${PORT:-3001}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root: sudo bash deploy/install-droplet.sh" >&2
  exit 1
fi

if [[ ! -f "$APP_DIR/package.json" ]]; then
  echo "Project not found at $APP_DIR. Copy the unzipped bleepblorp 0.2 folder there first." >&2
  exit 1
fi

if [[ ! -f "$APP_DIR/.env.local" ]]; then
  echo "Create $APP_DIR/.env.local from .env.example with YOUR Kalshi keys before running this." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl git build-essential

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"

mkdir -p "$APP_DIR/logs/trader" /var/log/bleepblorp-02
chown -R "$APP_USER:$APP_USER" "$APP_DIR" /var/log/bleepblorp-02

cd "$APP_DIR"
sudo -u "$APP_USER" npm ci
sudo -u "$APP_USER" env NODE_OPTIONS=--max-old-space-size=768 npm run build

if [[ -d "$APP_DIR/deploy" ]]; then
  # Home / Strategist unit: standalone Kalshi pacing, localhost only.
  if [[ -f "$APP_DIR/deploy/bleepblorp-02.home.service" ]]; then
    cp "$APP_DIR/deploy/bleepblorp-02.home.service" /etc/systemd/system/bleepblorp-02.service
  else
    cp "$APP_DIR/deploy/bleepblorp-02.service" /etc/systemd/system/
  fi
  cp "$APP_DIR/deploy/bleepblorp-02-exit-opt.service" /etc/systemd/system/
  cp "$APP_DIR/deploy/bleepblorp-02-exit-opt.timer" /etc/systemd/system/
fi

systemctl daemon-reload
systemctl enable --now bleepblorp-02.service
systemctl enable --now bleepblorp-02-exit-opt.timer

echo
echo "bleepblorp 0.2 is installed."
echo "The dashboard listens on 127.0.0.1:${PORT} (not the public internet)."
echo "From your home computer:"
echo "  ssh -L ${PORT}:127.0.0.1:${PORT} root@YOUR_DROPLET_IP"
echo "Then open http://127.0.0.1:${PORT}"
echo
echo "Educational paper assistant. Not financial advice. You are responsible for any use."
