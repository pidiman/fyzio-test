FROM node:22-alpine

ENV NODE_ENV=production \
    DATA_DIR=/app/data
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .
RUN mkdir -p /app/data && chown -R node:node /app/data

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/info >/dev/null || exit 1

CMD ["node", "server.js"]
