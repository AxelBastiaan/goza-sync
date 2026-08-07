#!/bin/sh
set -e

mkdir -p /app/data

if [ ! -f /app/data/gozasync.db ] && [ -n "$DB_SEED_TOKEN" ]; then
  echo "[entrypoint] No existing database found, downloading initial seed..."
  curl -sSfL -H "Authorization: token $DB_SEED_TOKEN" \
    -o /app/data/gozasync.db \
    https://raw.githubusercontent.com/AxelBastiaan/goza-sync-data/master/gozasync.db
  echo "[entrypoint] Seed downloaded: $(ls -la /app/data/gozasync.db)"
fi

exec node dist/server.js
