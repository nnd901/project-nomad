#!/bin/sh
set -eu

if [ -z "${TRANSMISSION_RPC_PASSWORD:-}" ]; then
  echo "TRANSMISSION_RPC_PASSWORD is required" >&2
  exit 1
fi

mkdir -p /app/storage/transmission /app/storage/torrents/files

cat > /app/storage/transmission/settings.json << EOF
{
  "dht-enabled": true,
  "download-dir": "/app/storage/torrents/files",
  "incomplete-dir-enabled": false,
  "lpd-enabled": true,
  "message-level": 2,
  "peer-port": 6881,
  "pex-enabled": true,
  "port-forwarding-enabled": true,
  "rpc-authentication-required": true,
  "rpc-bind-address": "0.0.0.0",
  "rpc-enabled": true,
  "rpc-host-whitelist-enabled": false,
  "rpc-password": "${TRANSMISSION_RPC_PASSWORD}",
  "rpc-port": 9091,
  "rpc-url": "/transmission/",
  "rpc-username": "nomad",
  "rpc-whitelist": "*.*.*.*",
  "rpc-whitelist-enabled": false,
  "seed-ratio-limit": 0,
  "seed-ratio-limited": true,
  "utp-enabled": true
}
EOF

exec transmission-daemon \
  --foreground \
  --config-dir /app/storage/transmission \
  --allowed '*.*.*.*' \
  --auth \
  --username nomad \
  --password "$TRANSMISSION_RPC_PASSWORD" \
  --port 9091 \
  --rpc-bind-address 0.0.0.0 \
  --peerport 6881 \
  --portmap \
  --dht \
  --utp \
  --download-dir /app/storage/torrents/files \
  --no-incomplete-dir \
  --global-seedratio 0 \
  --log-level info
