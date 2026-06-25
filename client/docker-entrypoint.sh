#!/bin/sh
# Inject the backend URL (Cloud Run env var SERVER_URL) into the static runtime
# config, then serve the SPA. `serve -s` returns index.html for client-side
# routes (e.g. /:roomName). Listens on $PORT (Cloud Run sets it; default 8080).
set -e
echo "window.RUNTIME_CONFIG = { serverUrl: \"${SERVER_URL:-}\" };" > /app/dist/config.js
exec serve -s dist -l "${PORT:-8080}"
