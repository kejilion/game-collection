FROM node:20-alpine

WORKDIR /app

# 先装生产依赖（利用镜像层缓存）
COPY package.json ./
RUN npm install --omit=dev

# 应用源码
COPY server ./server
COPY public ./public

# 排行榜/玩家档案持久化目录 —— 挂载卷以在重启后保留
RUN mkdir -p /app/data
VOLUME ["/app/data"]

ENV PORT=3000
ENV DATA_DIR=/app/data
EXPOSE 3000

# 容器健康检查
HEALTHCHECK --interval=30s --timeout=4s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

CMD ["node", "server/index.js"]
