FROM node:20-alpine

WORKDIR /app

# 先拷贝依赖清单，利用 Docker 层缓存安装依赖
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 再拷贝应用代码
COPY server.js ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
