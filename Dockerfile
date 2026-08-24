FROM --platform=linux/amd64 node:22-bookworm-slim AS builder
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ file \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci
RUN rm -rf node_modules/better-sqlite3/prebuilds node_modules/better-sqlite3/build \
    && npm rebuild better-sqlite3 --build-from-source --verbose \
    && test -f node_modules/better-sqlite3/build/Release/better_sqlite3.node \
    && file node_modules/better-sqlite3/build/Release/better_sqlite3.node | grep -q ELF

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM --platform=linux/amd64 node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
COPY public ./public
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# sales-recall/ is gitignored (hand-maintained business spreadsheet, kept out of
# the public repo) — its CATEGORY PRODUCT.xlsx is placed directly in the VPS's
# build context (not committed), so this only works when that file is present
# there. Read live by services/stockOpname.ts (active-item / discontinued status).
COPY sales-recall/CATEGORY\ PRODUCT.xlsx ./sales-recall/CATEGORY\ PRODUCT.xlsx

EXPOSE 8000
ENTRYPOINT ["./docker-entrypoint.sh"]
