FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY heartbeat.js ./
COPY newscat.js ./
COPY daemon.js ./
CMD ["node", "daemon.js"]
