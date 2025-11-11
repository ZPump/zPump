#!/usr/bin/env bash
set -euo pipefail

FAUCET_MODE=${FAUCET_MODE:-local}
PM2_USER=${PM2_USER:-$(whoami)}
PM2_HOME_DIR=${PM2_HOME_DIR:-$HOME}
NODE_VERSION=${NODE_VERSION:-18}

log() {
  printf '\n[setup] %s\n' "$1"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    return 1
  fi
  return 0
}

log "Updating apt package index"
echo 'Country1!' | sudo -S apt-get update -y

echo 'Country1!' | sudo -S apt-get install -y build-essential curl git

if ! require_command node; then
  log "Installing Node.js ${NODE_VERSION}.x"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | sudo -E bash -
  echo 'Country1!' | sudo -S apt-get install -y nodejs
fi

log "Installing PM2 globally"
echo 'Country1!' | sudo -S npm install -g pm2

log "Installing project dependencies (web/app)"
cd "$PM2_HOME_DIR/zPump/web/app"
npm install

log "Building Next.js application"
npm run build

cd "$PM2_HOME_DIR/zPump"

if [ ! -f ecosystem.config.js ]; then
  log "Creating PM2 ecosystem file"
  cat <<'EOC' > ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'ptf-web',
      cwd: './web/app',
      script: 'npm',
      args: 'run start',
      env: {
        NODE_ENV: 'production'
      },
      env_local: {
        NEXT_PUBLIC_FAUCET_MODE: 'local'
      },
      autorestart: true,
      watch: false,
      max_memory_restart: '512M'
    }
  ]
};
EOC
fi

log "Starting application with PM2"
pm2 start ecosystem.config.js || pm2 restart ecosystem.config.js

log "Saving PM2 process list"
pm2 save

log "Configuring PM2 to launch on boot"
echo 'Country1!' | sudo -S pm2 startup systemd -u "$PM2_USER" --hp "$PM2_HOME_DIR"

log "Setup complete. Use 'pm2 status' to view running processes."
