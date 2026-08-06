#!/bin/sh
set -e

mkdir -p /app/data

echo "[entrypoint] node version: $(node --version)"
echo "[entrypoint] uname: $(uname -m)"
echo "[entrypoint] probing native modules..."
node -e "console.log('[probe] node ok'); const D=require('better-sqlite3'); console.log('[probe] better-sqlite3 required ok'); const db=new D('/tmp/probe.db'); console.log('[probe] better-sqlite3 opened db ok'); db.close();"
echo "[entrypoint] probe passed, starting server"

exec node dist/server.js
