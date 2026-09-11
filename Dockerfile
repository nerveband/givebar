# Givebar production container (wavedepth, Dokploy host)
FROM oven/bun:1-slim
WORKDIR /app

COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile --production

COPY server/ ./server/
COPY client/ ./client/

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV GIVEBAR_DB_PATH=/app/data/givebar.sqlite

EXPOSE 3000
# The SQLite database and its automatic snapshots live on this volume.
VOLUME ["/app/data"]

CMD ["bun", "run", "server/src/index.ts"]
