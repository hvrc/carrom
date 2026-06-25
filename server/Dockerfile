# Cloud Run image for the authoritative carrom socket.io server.
# Build:  gcloud run deploy carrom-server --source server  (or docker build -t carrom-server server)
FROM node:20-slim

WORKDIR /app

# Install production dependencies only (layer-cached on package.json changes).
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# App source (test/ and node_modules excluded via .dockerignore).
COPY . .

ENV NODE_ENV=production
# Cloud Run injects PORT (default 8080); index.js reads process.env.PORT.
ENV PORT=8080
EXPOSE 8080

CMD ["node", "index.js"]
