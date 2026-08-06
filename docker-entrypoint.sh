#!/bin/sh
set -e

mkdir -p /app/data

echo "[entrypoint] node version: $(node --version)"
echo "[entrypoint] uname: $(uname -m)"
NODE_ADDON="/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
echo "[entrypoint] addon file: $(ls -la "$NODE_ADDON" 2>&1)"
echo "[entrypoint] addon file type: $(file "$NODE_ADDON" 2>&1)"
echo "[entrypoint] addon ldd:"
ldd "$NODE_ADDON" 2>&1 || true
echo "[entrypoint] probing native modules..."
node -e "console.log('[probe] node ok'); const D=require('better-sqlite3'); console.log('[probe] better-sqlite3 required ok'); const db=new D('/tmp/probe.db'); console.log('[probe] better-sqlite3 opened db ok'); db.close();"
echo "[entrypoint] probe passed, starting server"

exec node dist/server.js
