FROM node:22-slim

# better-sqlite3 needs build toolchain on slim images
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install server deps (workspace root has the shared lockfile)
COPY package.json package-lock.json* ./
COPY server/package.json ./server/package.json
RUN npm install --no-audit --no-fund || npm install --no-audit --no-fund

COPY server ./server
COPY drizzle ./drizzle
COPY client/dist ./client/dist
COPY tsconfig.base.json ./

ENV PORT=8787 \
    FGAME_DB=/data/fgame.db \
    FGAME_BLOBS_DIR=/data/blobs \
    FGAME_DRIZZLE_DIR=/app/drizzle \
    FGAME_WEB_DIR=/app/client/dist \
    FGAME_AUTO_REFRESH=1

RUN mkdir -p /data
EXPOSE 8787

CMD ["npx", "tsx", "server/src/index.ts"]
