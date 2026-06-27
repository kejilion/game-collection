#!/bin/sh
# Entrypoint: ensure the mounted data dir is writable by the node user,
# then drop privileges and start the server.
set -e

DATA_DIR="/app/server/data"
mkdir -p "$DATA_DIR"
chown -R node:node "$DATA_DIR" 2>/dev/null || true

exec su-exec node node server/index.js