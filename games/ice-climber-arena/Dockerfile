# ---- Ice-Climber Arena / ice-climber-arena ----------------------------------------
# Small production image: install only runtime deps, run as non-root.
FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

# su-exec lets the entrypoint fix the mounted data dir ownership as root,
# then drop privileges to the node user before starting the server.
RUN apk add --no-cache su-exec

# install dependencies first (better layer caching)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# app source
COPY server ./server
COPY public ./public

# leaderboard is written here at runtime -> mount as a volume to persist.
# The entrypoint re-chowns this dir on every start so the node user can write
# even when the host mount resets ownership to root.
RUN chmod +x server/docker-entrypoint.sh && mkdir -p server/data && chown -R node:node /app

EXPOSE 3000
CMD ["./server/docker-entrypoint.sh"]