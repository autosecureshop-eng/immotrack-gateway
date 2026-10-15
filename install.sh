#!/usr/bin/env bash
# IMMOTRACK gateway — one-shot installer / updater for a fresh Ubuntu VPS.
#
#   curl -fsSL https://raw.githubusercontent.com/autosecureshop-eng/immotrack-gateway/main/install.sh | sudo bash
#
# Re-running it later = update (git pull, tests, restart). Safe to repeat.
# It never prints or overwrites an existing .env; the gateway key is generated
# once and shown at the end so you can paste it into Supabase.
set -euo pipefail

REPO="${REPO:-https://github.com/autosecureshop-eng/immotrack-gateway.git}"
DIR="${DIR:-/opt/immotrack}"
SERVICE=immotrack-gw
SUPABASE_URL_DEFAULT="https://quscysqdzhgpmcdjxowm.supabase.co"
SUPABASE_ANON_DEFAULT="sb_publishable_77zqX9PNGgL5_OOP1cHCww_c07hANwm"

say() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo bash install.sh)"; exit 1; }

say "Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y -qq
apt-get install -y -qq curl git ufw ca-certificates openssl >/dev/null

# Node 20 (Ubuntu's own nodejs package is too old on 22.04).
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 18 ]; then
  say "Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "node $(node -v)"

say "Gateway code -> $DIR"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only
else
  if ! git clone "$REPO" "$DIR" 2>/tmp/clone.err; then
    cat /tmp/clone.err
    echo
    echo "Clone failed. If the repo is private, give this server read access:"
    echo "  1) ssh-keygen -t ed25519 -N '' -f /root/.ssh/id_ed25519 && cat /root/.ssh/id_ed25519.pub"
    echo "  2) GitHub -> repo -> Settings -> Deploy keys -> Add (read-only), paste that key"
    echo "  3) REPO=git@github.com:autosecureshop-eng/immotrack-gateway.git bash install.sh"
    exit 1
  fi
fi
cd "$DIR"

say "Tests"
npm test

if [ ! -f .env ]; then
  say "First run: creating .env"
  cp .env.example .env
  KEY="$(openssl rand -hex 24)"
  sed -i "s|^SUPABASE_URL=.*|SUPABASE_URL=${SUPABASE_URL_DEFAULT}|" .env
  sed -i "s|^SUPABASE_ANON_KEY=.*|SUPABASE_ANON_KEY=${SUPABASE_ANON_DEFAULT}|" .env
  sed -i "s|^TRACKER_GATEWAY_KEY=.*|TRACKER_GATEWAY_KEY=${KEY}|" .env
  grep -q '^SUPABASE_URL=' .env || echo "SUPABASE_URL=${SUPABASE_URL_DEFAULT}" >> .env
  grep -q '^SUPABASE_ANON_KEY=' .env || echo "SUPABASE_ANON_KEY=${SUPABASE_ANON_DEFAULT}" >> .env
  grep -q '^TRACKER_GATEWAY_KEY=' .env || echo "TRACKER_GATEWAY_KEY=${KEY}" >> .env
  chmod 600 .env
  NEW_KEY="$KEY"
fi

say "systemd service"
cat > /etc/systemd/system/${SERVICE}.service <<EOF
[Unit]
Description=IMMOTRACK tracker gateway
After=network-online.target
Wants=network-online.target
[Service]
WorkingDirectory=${DIR}
ExecStart=/usr/bin/node src/server.js
EnvironmentFile=${DIR}/.env
Restart=always
RestartSec=3
User=root
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now ${SERVICE}
systemctl restart ${SERVICE}

say "Firewall (SSH + tracker ports)"
ufw allow 22/tcp >/dev/null
ufw allow 5023/tcp >/dev/null   # GT06 / Concox
ufw allow 5027/tcp >/dev/null   # Teltonika
ufw --force enable >/dev/null

sleep 1
IP="$(curl -fsS -4 https://api.ipify.org || hostname -I | awk '{print $1}')"
say "Done"
systemctl --no-pager --lines=3 status ${SERVICE} | sed -n '1,6p'
echo
echo "Gateway host : ${IP}"
echo "GT06 port    : 5023      Teltonika port: 5027"
if [ -n "${NEW_KEY:-}" ]; then
  echo
  echo "NEW GATEWAY KEY (shown once):  ${NEW_KEY}"
  echo "-> Supabase -> Edge Functions -> Secrets -> add TRACKER_GATEWAY_KEY with exactly this value."
fi
echo "-> IMMOTRACK portal -> Settings: Gateway host = ${IP}, plus your SIM APN."
echo "Logs: journalctl -u ${SERVICE} -f"
