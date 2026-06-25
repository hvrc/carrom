# Deploying to Google Cloud Run

Two services: **`carrom-server`** (the authoritative Socket.IO game server) and **`carrom-client`** (the static Vite
SPA). Both build in Cloud Build — **no local Docker required**.

## Prerequisites (one-time)

```bash
gcloud auth login
gcloud config set project <YOUR_PROJECT_ID>          # e.g. carrom-2222
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
```

## Option A — one command (recommended)

```bash
PROJECT_ID=<YOUR_PROJECT_ID> REGION=us-central1 ./deploy.sh
```

It deploys the server, deploys the client pointed at the server, then opens the server's CORS to the client URL, and
prints the play URL. That's it.

## Option B — manual, step by step

```bash
REGION=us-central1

# 1) Server. Single instance (in-memory rooms must not be split), always-on CPU
#    (so the physics loop ticks between requests), 60-min WebSocket timeout.
gcloud run deploy carrom-server \
  --source server --region $REGION --allow-unauthenticated \
  --min-instances 1 --max-instances 1 \
  --concurrency 200 --timeout 3600 \
  --no-cpu-throttling --cpu 1 --memory 512Mi --port 8080
SERVER_URL=$(gcloud run services describe carrom-server --region $REGION --format='value(status.url)')

# 2) Client. Static SPA; the backend URL is injected at container start from
#    SERVER_URL (no rebuild needed to repoint it later).
gcloud run deploy carrom-client \
  --source client --region $REGION --allow-unauthenticated \
  --port 8080 --set-env-vars SERVER_URL=$SERVER_URL
CLIENT_URL=$(gcloud run services describe carrom-client --region $REGION --format='value(status.url)')

# 3) Let the server accept the client's origin (CORS).
gcloud run services update carrom-server --region $REGION \
  --update-env-vars CORS_ORIGINS=$CLIENT_URL,http://localhost:3001

echo "Play at: $CLIENT_URL"
```

## How config flows (so you can change things)

- **Client → server URL**: injected at container start from the `SERVER_URL` env var into `/config.js`
  (`client/docker-entrypoint.sh`), read by `client/scripts/socket.js`. To repoint the client at a different server,
  just update the env var — no rebuild:
  ```bash
  gcloud run services update carrom-client --region $REGION --update-env-vars SERVER_URL=<new-url>
  ```
- **Server → allowed origins**: the `CORS_ORIGINS` env var (comma-separated). Update it whenever the client URL
  changes.
- **Transport**: WebSocket-only by default. Cloud Run supports WebSockets natively — leave it. (Only set
  `SOCKET_TRANSPORTS=polling,websocket` on the server **and** `VITE_SOCKET_TRANSPORTS` on the client if you ever
  target a host without WebSocket support.)

## Gotchas

- **Do NOT enable end-to-end HTTP/2** on the server — it breaks WebSockets. (Default is off; just don't pass
  `--use-http2`.)
- **Single server instance is required** for correctness: room state is in-memory. Don't raise `--max-instances`
  above 1 without adding Redis (`@socket.io/redis-streams-adapter`) + shared state — see research.md §C2.
- **`--no-cpu-throttling` matters**: without it Cloud Run throttles CPU between requests and the physics
  `setInterval` would stall mid-flick.
- **Custom domain**: map one to `carrom-client` (and optionally `carrom-server`), then update `SERVER_URL` /
  `CORS_ORIGINS` to the custom hostnames.
- **App Engine** (`server/app.yaml`, `client/app.yaml`) is the older path and stays in the repo as a fallback, but
  App Engine **standard has no WebSocket support** — prefer Cloud Run (or App Engine *flexible*).

## Verify before deploying

```bash
./run-tests.sh        # 35 server + 23 client tests + client build → ALL PASS
```
