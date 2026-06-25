#!/usr/bin/env bash
# Deploy both services to Google Cloud Run.
#
#   PROJECT_ID=carrom-2222 REGION=us-central1 ./deploy.sh
#
# Builds happen in Cloud Build (no local Docker needed). The script deploys the
# server, points the client at it, then opens the server's CORS to the client.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-us-central1}"
SERVER_SERVICE="${SERVER_SERVICE:-carrom-server}"
CLIENT_SERVICE="${CLIENT_SERVICE:-carrom-client}"

if [ -z "${PROJECT_ID}" ]; then
  echo "Set PROJECT_ID (or run: gcloud config set project <id>)"; exit 1
fi
echo "Project: ${PROJECT_ID}   Region: ${REGION}"
gcloud config set project "${PROJECT_ID}" >/dev/null

# 1) Server — pinned to one instance (in-memory rooms), always-on CPU (so the
#    physics loop ticks between requests), long timeout (WebSocket lifetime).
echo "── Deploying ${SERVER_SERVICE} ─────────────────────────────"
gcloud run deploy "${SERVER_SERVICE}" \
  --source server \
  --region "${REGION}" \
  --allow-unauthenticated \
  --min-instances 1 --max-instances 1 \
  --concurrency 200 \
  --timeout 3600 \
  --no-cpu-throttling \
  --cpu 1 --memory 512Mi \
  --port 8080
SERVER_URL="$(gcloud run services describe "${SERVER_SERVICE}" --region "${REGION}" --format='value(status.url)')"
echo "Server URL: ${SERVER_URL}"

# 2) Client — static SPA; backend URL injected at container start via SERVER_URL.
echo "── Deploying ${CLIENT_SERVICE} ─────────────────────────────"
gcloud run deploy "${CLIENT_SERVICE}" \
  --source client \
  --region "${REGION}" \
  --allow-unauthenticated \
  --min-instances 0 --max-instances 2 \
  --cpu 1 --memory 256Mi \
  --port 8080 \
  --set-env-vars "SERVER_URL=${SERVER_URL}"
CLIENT_URL="$(gcloud run services describe "${CLIENT_SERVICE}" --region "${REGION}" --format='value(status.url)')"
echo "Client URL: ${CLIENT_URL}"

# 3) Open the server's CORS to the client origin (also allow local dev).
echo "── Updating ${SERVER_SERVICE} CORS ─────────────────────────"
gcloud run services update "${SERVER_SERVICE}" \
  --region "${REGION}" \
  --update-env-vars "CORS_ORIGINS=${CLIENT_URL},http://localhost:3001"

echo ""
echo "Done."
echo "  Play:   ${CLIENT_URL}"
echo "  Server: ${SERVER_URL}"
echo "Do NOT enable end-to-end HTTP/2 on the server (breaks WebSockets)."
