#!/usr/bin/env bash
set -Eeuo pipefail
# Persistent internal-auth key; never print it or regenerate it on restart.
key=/data/keyfile/keyfile
if [ ! -s "$key" ]; then
  umask 077
  openssl rand -base64 756 > "$key.tmp"
  chown mongodb:mongodb "$key.tmp"
  chmod 400 "$key.tmp"
  mv "$key.tmp" "$key"
fi
chown mongodb:mongodb "$key"
chmod 400 "$key"
exec /usr/local/bin/docker-entrypoint.sh mongod --replSet rs0 --keyFile "$key" --bind_ip_all --oplogSize 256
