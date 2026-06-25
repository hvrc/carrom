# Cloud Run image for the static client. Built once; the backend URL is injected
# at container start from the SERVER_URL env var (see docker-entrypoint.sh), so
# you can repoint it at deploy time without rebuilding.
#   gcloud run deploy carrom-client --source client --set-env-vars SERVER_URL=https://<server-url>

# ---- build ----
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

# ---- serve ----
FROM node:20-slim
WORKDIR /app
RUN npm install -g serve@14 && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh
ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["/docker-entrypoint.sh"]
