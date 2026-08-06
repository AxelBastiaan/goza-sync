#!/bin/sh
set -e

mkdir -p /app/data

echo "[entrypoint] node version: $(node --version)"
echo "[entrypoint] uname: $(uname -m)"
echo "[entrypoint] locating better-sqlite3 native addon(s):"
find /app/node_modules/better-sqlite3 -name "*.node" 2>&1 | while read -r f; do
  echo "[entrypoint]   found: $f"
  ls -la "$f" 2>&1
  file "$f" 2>&1
  ldd "$f" 2>&1
done
echo "[entrypoint] probing native modules..."
node -e "console.log('[probe] node ok'); const D=require('better-sqlite3'); console.log('[probe] better-sqlite3 required ok'); const db=new D('/tmp/probe.db'); console.log('[probe] better-sqlite3 opened db ok'); db.close();"
echo "[entrypoint] probe passed, starting server"

exec node dist/server.js
