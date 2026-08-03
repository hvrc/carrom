# Deploying to Google Cloud Run

**Live** in GCP project `hvrc-web`, region `us-east1` — the shared project that
serves every `hvrc.place` subdomain:

| | URL |
|---|---|
| **Play** | https://carrom.hvrc.place |
| Client | https://carrom-client-em6d5d3fha-ue.a.run.app |
| Server | https://carrom-server-em6d5d3fha-ue.a.run.app (mapped to marroc.hvrc.place) |

Two services: **`carrom-server`** (the authoritative Socket.IO game server) and **`carrom-client`** (the static Vite
SPA). Both build in Cloud Build — **no local Docker required**.

## Deploy

```bash
./deploy.sh
```

`PROJECT_ID` and `REGION` default to `hvrc-web` and `us-east1`; pass them only to
target somewhere else.

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
  gcloud run services update carrom-client --region us-east1 --update-env-vars SERVER_URL=<new-url>
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

## App Engine — gone

## Where this used to live

Two moves, both done:

1. App Engine → Cloud Run, in a project of its own (`carrom-2222`).
2. `carrom-2222` → `hvrc-web`, consolidating with the other `hvrc.place` services.

`carrom-2222` is now `DELETE_REQUESTED`. Anything still pointed at it fails with
`CONSUMER_INVALID` — a project-lifecycle error that looks exactly like a
permissions problem, so check `gcloud projects describe <id>` before assuming
you are logged in as the wrong person.

The original deployment lived on App Engine (`carrom-2222.el.r.appspot.com`, plus a `backend` service). **It has been
retired**: the `app.yaml` files are deleted and the App Engine app is disabled. App Engine *standard* has no WebSocket
support and this server is WebSocket-only, so `gcloud app deploy` would have produced a service that starts cleanly and
then refuses every connection. The old version that sat there predated the netcode work and only functioned because it
long-polled.

## Custom domain

The client is mapped to **carrom.hvrc.place** (DNS at Squarespace). The server stays on its run.app URL — only the
client ever talks to it.

```bash
gcloud run domain-mappings create --service carrom-client --domain carrom.hvrc.place --region us-east1
```

That prints a DNS record (a CNAME to `ghs.googlehosted.com`) to add at the registrar. Google issues and renews the TLS
certificate; WebSockets are unaffected.

**The trap:** the custom domain must be in the server's `CORS_ORIGINS`, and step 3 above rewrites that variable
wholesale on every deploy. `deploy.sh` therefore knows the domain (`CUSTOM_DOMAIN`, defaulting to `carrom.hvrc.place`)
and both sets *and verifies* it. Without that, a deploy would quietly break every player arriving via the custom domain
while the run.app URL kept working — and the old verification would still have passed, because it only checked the
run.app origin.

## Verify before deploying

```bash
./run-tests.sh        # 72 server + 51 client tests + client build → ALL PASS
```

`deploy.sh` runs this for you unless `SKIP_TESTS=1`.
