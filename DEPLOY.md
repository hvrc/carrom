# Deploying to Google Cloud Run

**Live** in GCP project `carrom-2222`, region `us-central1`:

| | URL |
|---|---|
| **Play** | https://carrom-client-23xhui47pq-uc.a.run.app |
| Server | https://carrom-server-23xhui47pq-uc.a.run.app |

Two services: **`carrom-server`** (the authoritative Socket.IO game server) and **`carrom-client`** (the static Vite
SPA). Both build in Cloud Build — **no local Docker required**.

## Deploy

```bash
PROJECT_ID=carrom-2222 REGION=us-central1 ./deploy.sh
```

That's the whole thing. `deploy.sh` runs the tests, enables the required APIs, deploys the server, deploys the client
pointed at it, opens the server's CORS to the client origin, and then **verifies what is actually live**: that the
client serves a `config.js` naming the server, that the server *rejects* a long-polling handshake (i.e. it really is the
WebSocket-only build, not a stale one), and that CORS names the client origin. It exits non-zero if any of those fail —
a clean `gcloud` exit is not evidence that the game works.

`SKIP_TESTS=1 ./deploy.sh` skips the test gate. On a brand-new project you need `gcloud auth login` first; the script
handles the rest.

## How config flows (so you can change things)

- **Client → server URL**: injected at container start from the `SERVER_URL` env var into `/config.js`
  (`client/docker-entrypoint.sh`), read by `client/scripts/socket.js`. To repoint the client at a different server,
  just update the env var — no rebuild:
  ```bash
  gcloud run services update carrom-client --region us-central1 --update-env-vars SERVER_URL=<new-url>
  ```
- **Server → allowed origins**: the `CORS_ORIGINS` env var (comma-separated). Update it whenever the client URL
  changes.
- **Transport**: WebSocket-only by default. Cloud Run supports WebSockets natively — leave it. (Only set
  `SOCKET_TRANSPORTS=polling,websocket` on the server **and** `VITE_SOCKET_TRANSPORTS` on the client if you ever
  target a host without WebSocket support.)

## Gotchas

- **A comma inside an env-var value needs a custom delimiter.** `gcloud` splits env-var *pairs* on commas, so
  `--update-env-vars "CORS_ORIGINS=$CLIENT_URL,http://localhost:3001"` fails — it reads the second URL as another
  flag and dies with a usage dump. Write `--update-env-vars "^@^CORS_ORIGINS=$CLIENT_URL,http://localhost:3001"`,
  where the leading `^@^` makes `@` the pair separator and frees the comma for the value. `deploy.sh` does this; if you
  run the command by hand, remember it.
- **Do NOT enable end-to-end HTTP/2** on the server — it breaks WebSockets. (Default is off; just don't pass
  `--use-http2`.)
- **Single server instance is required** for correctness: room state is in-memory. Don't raise `--max-instances`
  above 1 without adding Redis (`@socket.io/redis-streams-adapter`) + shared state — see research.md §C2.
- **`--no-cpu-throttling` matters**: without it Cloud Run throttles CPU between requests and the physics
  `setInterval` would stall mid-flick.
- **Custom domain**: map one to `carrom-client` (and optionally `carrom-server`), then update `SERVER_URL` /
  `CORS_ORIGINS` to the custom hostnames.

## App Engine — retired, do not deploy there

`server/app.yaml` and `client/app.yaml` survive from the original App Engine deployment
(`carrom-2222.el.r.appspot.com`, plus a `backend` service). **That path is dead for this codebase.** App Engine
*standard* has no WebSocket support and the server is now WebSocket-only, so `gcloud app deploy` would give you a
service that starts cleanly and then refuses every connection. The old version still sitting there predates the netcode
work and only functions because it long-polls.

If you ever must go back: use App Engine *flexible*, or set `SOCKET_TRANSPORTS=polling,websocket` on the server plus
`VITE_SOCKET_TRANSPORTS` on the client plus session affinity — and accept long-polling latency in a real-time physics
game. Prefer Cloud Run.

## Verify before deploying

```bash
./run-tests.sh        # 35 server + 23 client tests + client build → ALL PASS
```

`deploy.sh` runs this for you unless `SKIP_TESTS=1`.
