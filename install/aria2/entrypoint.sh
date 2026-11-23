#!/bin/sh
set -eu

if [ -z "${ARIA2_RPC_SECRET:-}" ]; then
  echo "ARIA2_RPC_SECRET is required" >&2
  exit 1
fi

mkdir -p /app/storage/aria2
# The first version of this container kept its table next to the field manuals.
if [ ! -s /app/storage/aria2/dht.dat ] && [ -s /app/storage/field-manuals/dht.dat ]; then
  cp /app/storage/field-manuals/dht.dat /app/storage/aria2/dht.dat
fi
session=/app/storage/aria2/aria2.session
if [ ! -s "$session" ] && [ -s /app/storage/field-manuals/aria2.session ]; then
  cp /app/storage/field-manuals/aria2.session "$session"
fi

set -- \
  --enable-rpc=true \
  --rpc-listen-all=true \
  --rpc-listen-port=6800 \
  --rpc-secret="$ARIA2_RPC_SECRET" \
  --disable-ipv6=true \
  --enable-dht=true \
  --bt-enable-lpd=true \
  --listen-port=6881 \
  --dht-listen-port=6881 \
  --dht-entry-point=router.bittorrent.com:6881 \
  --dht-entry-point=dht.transmissionbt.com:6881 \
  --dht-file-path=/app/storage/aria2/dht.dat \
  --seed-time=0 \
  --file-allocation=none \
  --auto-file-renaming=false \
  --allow-overwrite=true \
  --continue=true \
  --max-concurrent-downloads=5 \
  --force-save=true \
  --save-session="$session" \
  --save-session-interval=30 \
  --console-log-level=notice

if [ -s "$session" ]; then
  set -- "$@" --input-file="$session"
fi

exec aria2c "$@"
