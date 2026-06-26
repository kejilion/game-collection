# ---- Ice-Climber Arena / 敲冰块大逃杀 ----------------------------------------
# Small production image: install only runtime deps, run as non-root.
FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

# install dependencies first (better layer caching)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# app source
COPY server ./server
COPY public ./public

# leaderboard is written here at runtime — mount as a volume to persist
RUN mkdir -p server/data && chown -R node:node /app
USER node

EXPOSE 3000
CMD ["node", "server/index.js"]
