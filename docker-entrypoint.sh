#!/bin/sh
set -e

mkdir -p /app/data

DB_SIZE=$(stat -c%s /app/data/gozasync.db 2>/dev/null || echo 0)
if [ "$DB_SIZE" -lt 1000000 ] && [ -n "$DB_SEED_TOKEN" ]; then
  echo "[entrypoint] No real database found (size=$DB_SIZE), downloading initial seed..."
  curl -sSfL -H "Authorization: token $DB_SEED_TOKEN" \
    -o /app/data/gozasync.db \
    https://raw.githubusercontent.com/AxelBastiaan/goza-sync-data/master/gozasync.db
  echo "[entrypoint] Seed downloaded: $(ls -la /app/data/gozasync.db)"
fi

exec node dist/server.js
