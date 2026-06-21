# ---- Arena Brawl 大乱斗 server image ----
FROM node:20-alpine

WORKDIR /app

# install production deps first (better layer caching)
COPY package.json ./
RUN npm install --omit=dev

# app source
COPY server ./server
COPY public ./public

# persisted leaderboard lives here — mount a volume to keep it
RUN mkdir -p /app/data
VOLUME ["/app/data"]

ENV PORT=3000
EXPOSE 3000

# basic container healthcheck
HEALTHCHECK --interval=30s --timeout=4s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

CMD ["node", "server/index.js"]
