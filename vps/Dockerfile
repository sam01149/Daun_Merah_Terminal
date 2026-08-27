FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY heartbeat.js ./
COPY newscat.js ./
COPY daemon.js ./
USER node
CMD ["node", "daemon.js"]
