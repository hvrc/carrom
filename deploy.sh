#!/usr/bin/env bash
# Deploy both services to Google Cloud Run.
#
#   ./deploy.sh                 # defaults below: hvrc-web / us-east1
#   PROJECT_ID=… REGION=… ./deploy.sh   # to target somewhere else
#
# Builds happen in Cloud Build (no local Docker needed). The script gates on the
# tests, deploys the server, points the client at it, opens the server's CORS to
# the client, then verifies the live deployment before declaring success.
#
#   SKIP_TESTS=1 ./deploy.sh    deploy without running ./run-tests.sh first
#   VERIFY_ONLY=1 ./deploy.sh   skip the deploy; just check what is live right now
set -euo pipefail

# Carrom lives in the shared hvrc-web project, alongside the other
# hvrc.place subdomains. (It used to have its own project, carrom-2222; that
# one is now DELETE_REQUESTED, and every gcloud call against it fails with
# CONSUMER_INVALID, which reads like an auth problem and is not one.)
PROJECT_ID="${PROJECT_ID:-hvrc-web}"
REGION="${REGION:-us-east1}"
SERVER_SERVICE="${SERVER_SERVICE:-carrom-server}"
CLIENT_SERVICE="${CLIENT_SERVICE:-carrom-client}"
ROOT="$(cd "$(dirname "$0")" && pwd)"

# The custom domain the client is served from, if one is mapped. It MUST be in the
# server's CORS list or every browser arriving via the custom domain is refused —
# and because step 3 rewrites CORS_ORIGINS wholesale on every deploy, forgetting it
# here would silently break the custom domain on the next deploy while the run.app
# URL kept working. Set CUSTOM_DOMAIN="" to deploy without one.
CUSTOM_DOMAIN="${CUSTOM_DOMAIN-carrom.hvrc.place}"

if [ -z "${PROJECT_ID}" ]; then
  echo "Set PROJECT_ID (or run: gcloud config set project <id>)"; exit 1
fi
echo "Project: ${PROJECT_ID}   Region: ${REGION}"
gcloud config set project "${PROJECT_ID}" >/dev/null

# Check what is actually live. A clean `gcloud` exit is not evidence: the client
# can ship a stale build, and the server can come up unreachable to browsers.
verify() {
  local server_url="$1" client_url="$2" fail=0
  echo "── Verifying ───────────────────────────────────────────────"

  # Proves the entrypoint ran and injected the backend URL into *this* build.
  if curl -fsS "${client_url}/config.js" | grep -q "${server_url}"; then
    echo "  OK   client /config.js points at the server"
  else
    echo "  FAIL client /config.js missing, or not pointing at ${server_url}"; fail=1
  fi

  # The server is WebSocket-only, so a long-polling handshake must be REJECTED.
  # Handing back a session id means an older, polling-capable build is serving.
  # No -f: the rejection *is* an HTTP 400, and -f would discard the body we grep.
  if curl -sS "${server_url}/socket.io/?EIO=4&transport=polling" | grep -q "Transport unknown"; then
    echo "  OK   server is WebSocket-only (polling rejected)"
  else
    echo "  FAIL server accepted a polling handshake — stale build?"; fail=1
  fi

  # Without the client origin in CORS, every browser connection fails.
  local cors
  cors="$(gcloud run services describe "${SERVER_SERVICE}" --region "${REGION}" \
            --format='value(spec.template.spec.containers[0].env)')"
  if grep -q "${client_url}" <<<"${cors}"; then
    echo "  OK   server CORS_ORIGINS includes the client origin"
  else
    echo "  FAIL server CORS_ORIGINS does not include ${client_url}"; fail=1
  fi

  # And the custom domain, if one is mapped. Checking only the run.app origin
  # would let a deploy "pass" while every player on carrom.hvrc.place is refused.
  if [ -n "${CUSTOM_DOMAIN}" ]; then
    if grep -q "${CUSTOM_DOMAIN}" <<<"${cors}"; then
      echo "  OK   server CORS_ORIGINS includes https://${CUSTOM_DOMAIN}"
    else
      echo "  FAIL server CORS_ORIGINS does not include https://${CUSTOM_DOMAIN}"; fail=1
    fi
  fi

  echo ""
  if [ "${fail}" -ne 0 ]; then
    echo "VERIFICATION FAILED — the game is likely broken. See above."
    return 1
  fi
  echo "Verified live."
  echo "  Play:   ${client_url}"
  echo "  Server: ${server_url}"
  echo "Do NOT enable end-to-end HTTP/2 on the server (breaks WebSockets)."
  return 0
}

if [ "${VERIFY_ONLY:-0}" = "1" ]; then
  SERVER_URL="$(gcloud run services describe "${SERVER_SERVICE}" --region "${REGION}" --format='value(status.url)')"
  CLIENT_URL="$(gcloud run services describe "${CLIENT_SERVICE}" --region "${REGION}" --format='value(status.url)')"
  verify "${SERVER_URL}" "${CLIENT_URL}"
  exit $?
fi

# 0) Gate on the tests, then ensure the required APIs are on (idempotent, so it
#    is safe to leave in — a fresh project deploys with no manual setup).
if [ "${SKIP_TESTS:-0}" != "1" ]; then
  echo "── Tests ───────────────────────────────────────────────────"
  "${ROOT}/run-tests.sh" >/dev/null || { echo "Tests failed — not deploying. Run ./run-tests.sh to see why."; exit 1; }
  echo "All tests pass."
fi
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  --project "${PROJECT_ID}" --quiet >/dev/null

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
  --port 8080 \
  --quiet
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
  --set-env-vars "SERVER_URL=${SERVER_URL}" \
  --quiet
CLIENT_URL="$(gcloud run services describe "${CLIENT_SERVICE}" --region "${REGION}" --format='value(status.url)')"
echo "Client URL: ${CLIENT_URL}"

# 3) Open the server's CORS to the client origin (also allow local dev).
#    gcloud splits env-var *pairs* on commas, so a value containing a comma needs
#    a custom delimiter: "^@^" means "@" separates the pairs, freeing the comma
#    for use inside the value. Without it, "http://localhost:3001" is read as a
#    second (unknown) flag and the command dies with a usage dump.
echo "── Updating ${SERVER_SERVICE} CORS ─────────────────────────"
ORIGINS="${CLIENT_URL},http://localhost:3001"
if [ -n "${CUSTOM_DOMAIN}" ]; then
  ORIGINS="https://${CUSTOM_DOMAIN},${ORIGINS}"
fi
gcloud run services update "${SERVER_SERVICE}" \
  --region "${REGION}" \
  --update-env-vars "^@^CORS_ORIGINS=${ORIGINS}" \
  --quiet

# 4) Verify what is actually live.
verify "${SERVER_URL}" "${CLIENT_URL}"
