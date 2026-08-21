# Givebar — Production Container Build (wavedepth Dokploy)
FROM oven/bun:1-slim AS base
WORKDIR /app

# Copy dependency manifests
COPY package.json tsconfig.json ./

# Install dependencies if any
RUN bun install --production

# Copy source code and client assets
COPY server/ ./server/
COPY client/ ./client/

# Ensure SQLite data volume directory exists
RUN mkdir -p /app/data

# Environment configuration
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV GIVEBAR_DB_PATH=/app/data/givebar.sqlite

EXPOSE 3000

# Mountable SQLite persistent volume
VOLUME ["/app/data"]

CMD ["bun", "run", "server/src/index.ts"]
