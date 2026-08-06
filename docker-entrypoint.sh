#!/bin/sh
set -e

mkdir -p /app/data

exec node dist/server.js
