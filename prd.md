# Carrom Multiplayer — Product Requirements & Phase Plan

> Derived from [research.md](research.md). Objective: a **fast, smooth, robust, elegant** version of the existing
> game — **no visual/UX redesign** — optimized for **Google Cloud Run** (server + client). Focus areas (user-stated):
> **lobby, touch screen, multiplayer sync, lag.**
>
> Working rules for execution:
> - Every phase ends with **measurable milestones runnable locally** (`npm test` and scripted checks), plus a
>   **strawman gap-review** that either fixes gaps or files them into a later phase.
> - **The test harness (Phase 1) lands first** and every subsequent phase re-runs the full suite (no regressions).
> - Keep the **server-authoritative** model and the **pure physics module**. No DB, no Redis, no Phaser, no UI redesign.
> - "No bugs" is a hard gate: a phase is only complete when all its milestones pass _and_ all prior milestones still pass.

## How to test locally (one-time setup)

```bash
# server unit + integration tests (node:test, no extra deps)
cd server && npm test
# client pure-logic tests (interpolation, flick math, geometry)
cd client && npm test
# full build still works
cd client && npm run build
# manual 2-player smoke: run server + client, open two browser windows
cd server && npm run dev          # :3000
cd client && npm run dev          # :3001  → open two tabs at http://localhost:3001
```

A convenience root script `./run-tests.sh` runs server tests, client tests, and the client build in sequence and
prints a PASS/FAIL summary (added in Phase 1).

---

## Phase 1 — Test harness + transport & deploy foundation

**Goal:** put a safety net under everything, and land the single biggest latency win (kill HTTP long-polling) plus a
Cloud Run-correct deployment, all behind tests.

**Scope / changes:**
- Add `node:test` suites with **zero new runtime deps**:
  - `server/test/physics.test.js` — pure physics/rules unit tests (initial layout, a flick mutates state, friction
    settles, pockets detected, turn switches, queen FSM, striker foul/debt). This **surfaces** the rule edge cases in
    research §B6 (fixes land in Phase 2).
  - `server/test/integration.test.js` — boot the real server on an ephemeral port, connect **two** `socket.io-client`
    sockets, and assert the lobby + flick + sync flow end-to-end.
- Add `server`/`client` `"test"` npm scripts and a root `run-tests.sh`.
- **Force WebSocket-only transport** on both ends: server `transports:['websocket']`, client
  `io(url,{transports:['websocket'], ...})`. (Removes long-polling latency and the sticky-session requirement.)
- **Env-driven config**: server reads `PORT`, `CORS_ORIGINS` (comma-separated) from env (keep current appspot +
  localhost as defaults); client reads server URL from a Vite env var (`VITE_SERVER_URL`) with the current production
  URL as fallback. No more hardcoded origins inline.
- **Cloud Run artifacts** (deliverables; the user deploys): `server/Dockerfile`, `server/.dockerignore`, a documented
  `gcloud run deploy` command block (in `prd.md`/README) with `--no-cpu-throttling --timeout=3600 --min-instances=1
  --max-instances=1 --concurrency=200`, and notes that HTTP/2 must stay off. Keep `app.yaml` working as a fallback.
- Server boots cleanly with production-like env (`NODE_ENV=production PORT=8080`).

**Milestones (measurable, local):**
1. `cd server && npm test` → **physics suite ≥ 10 assertions, all pass.** (Reproduce: command exits 0.)
2. Integration: two clients `createRoom`/`joinRoom` → **both receive `gameInit` with 19 coins at byte-identical
   positions.** (Assert deep-equal of sorted coin arrays.)
3. Integration: actor emits `flick` → **both clients receive ≥1 `physicsFrame` and exactly one `turnResolved`**, and
   `turnResolved.state.whoseTurn` flips to the other role on a non-scoring shot. (Assert counts + value.)
4. Integration: a non-actor emitting `flick` is rejected (server `error` "Not your turn"); the actor's identity is
   resolved from the persistent `clientId`, not `socket.id`. (Assert error received by wrong sender, no frames.)
5. Both clients negotiate **`socket.conn.transport.name === 'websocket'`** (no polling). (Assert in integration.)
6. Server starts with `CORS_ORIGINS`/`PORT` from env and serves `/`; `docker build` of `server/Dockerfile` succeeds
   **if Docker is available** (else: documented + skipped, image instructions verified by inspection).
7. `cd client && npm run build` succeeds; `run-tests.sh` prints an overall PASS.

**Exit criteria:** milestones 1–7 green; no behavior change visible to a player except lower latency.

**Strawman review (done):**
- ✅ Delivered: 24 passing tests (18 physics/rules + 6 two-client integration), `transports:['websocket']` on both
  ends, env-driven `CORS_ORIGINS`/`PORT`/`SOCKET_TRANSPORTS` (server) and `VITE_SERVER_URL`/`VITE_SOCKET_TRANSPORTS`
  (client), `server/Dockerfile` + `.dockerignore`, `run-tests.sh`. All milestones green.
- 🔎 **Footgun found & fixed:** WebSocket-only bricks the app on the _current_ App Engine **standard** backend (no WS,
  no polling fallback). Added a `SOCKET_TRANSPORTS`/`VITE_SOCKET_TRANSPORTS` escape hatch (default `websocket`) and a
  loud warning + `max_instances:1` in `app.yaml`. Correct target remains Cloud Run.
- 🔎 **Determinism is already satisfied** at the step level: `step()` advances exactly one fixed tick and ignores
  wall-clock, so outcomes are reproducible (proven by the determinism test). Phase 2's "fixed timestep" is therefore
  reframed: the real value is **client render/network decoupling**, not server determinism (which we already have).
- 🔎 Docker daemon (colima) was not running locally, so the image build is verified by inspection + a production-env
  boot smoke test rather than an actual `docker build`. User can run `docker build server/` when their daemon is up.
- ⏭️ Deferred (correctly, per plan): broken reconnect path & 5-min heartbeat → **Phase 3**; `error`-handler ejecting
  on any error → **Phase 3**; `simCancel` re-entrancy test → **Phase 2**; missing game-over/play-again flow (server
  emits `gameOver` in `turnResolved` but client ignores it, and `gameReset` is never triggered) → noted as a
  **functional gap** to weigh in **Phase 4** (it needs a button = minimal UI, within "feature" scope, not redesign).

---

## Phase 2 — Deterministic simulation + smooth netcode + rule correctness

**Goal:** make motion buttery (the headline "sync/lag/jitter" fix) and the sim reproducible; fix the rule edge cases
surfaced in Phase 1.

**Scope / changes:**
- **Fixed-timestep accumulator** server-side: every `step()` integrates a constant `dt`; the broadcast cadence is
  derived from sim ticks, not wall-clock. Result: identical flick input → identical final state across runs.
- **Timestamp every snapshot**: `physicsFrame` and `gameInit`/`turnResolved` carry a monotonic sim time/tick `t`.
- **Client interpolation buffer + `requestAnimationFrame` render loop**: socket handlers become _producers_ that push
  timestamped snapshots into a ref-held buffer; a single rAF loop renders at display rate by sampling
  `renderTime = now − INTERP_DELAY (~100 ms)` and lerping the two bracketing snapshots. **On a gap, hold last
  position (no extrapolation).** Extract the bracket+lerp logic into a **pure module** (`client/scripts/interpolate.js`)
  so it is unit-testable in node.
- **Delta-encode `physicsFrame`**: include only coins whose position changed since the last broadcast (+ striker);
  optional integer quantization of coordinates. Client merges deltas into its buffer.
- **Rule-correctness fixes** (from §B6), each with a test: foul-on-same-stroke-as-cover should fail the cover;
  game-over detection robust across foul/switch/3-in-a-row; `respawnAtCenter` always resolves.

**Milestones (measurable, local):**
1. **Determinism:** run the same flick twice from a fresh state → **final coin/striker positions deep-equal** (and a
   known fixed seed flick produces a recorded golden snapshot). (`server/test`.)
2. **Timestamps:** every emitted `physicsFrame` has a strictly increasing numeric `t`. (Integration assert.)
3. **Delta encoding:** after the board settles mid-stream, a `physicsFrame` **omits coins that didn't move**; a fully
   static object is never resent. (Assert a frame's coin count < total when only the striker moves.)
4. **Interpolation purity:** `interpolate.js` unit tests — exact lerp at α=0/0.5/1, correct bracket selection, and
   **hold** (returns newest) when `renderTime` exceeds the buffer. (`client/test`.)
5. **No-regression:** all Phase 1 milestones still pass; `turnResolved` still reconciles client to authoritative
   final positions.
6. **Rule fixes:** dedicated tests for foul-on-cover and end-of-game pass.
7. **Manual smoke (user):** in two windows, a flick animates **smoothly at ~60 fps on both screens** with no visible
   stutter; coins on both screens come to rest in the same place. (Checklist in §Manual.)

**Exit criteria:** 1–6 green; manual smoke confirms smoothness. Bundle size noted.

**Strawman review (done):**
- ✅ Delivered: server stamps each frame with a monotonic `t` and **delta+integer-quantizes** the stream
  (`buildBroadcastFrame`); client `physicsFrame` is now a pure producer that reconstructs full positions and buffers
  them; a single `requestAnimationFrame` loop interpolates ~100 ms in the past (`interpolate.js`, 10 unit tests) and
  also drives pocket tweens; rule fixes (foul-voids-cover, colour-cleared game-over) landed with tests. Tests: 31
  server + 10 client, all green; build 74.7 KB gzip.
- 🔁 **Scope reframed (justified):** I did **not** convert the server's `setInterval(16)` to a fixed-timestep
  accumulator. Reason: `step()` already advances exactly one fixed tick irrespective of wall-clock, so determinism
  (M1) is already satisfied; and each frame carries an *ideal* sim-time `t` (`tick*16`), while the client re-anchors
  its render clock to `(latestT, arrivalTime)` every frame — so server pacing jitter is fully absorbed by the
  interpolation buffer. Adding an accumulator would be risk with no behavioural gain. Documented here rather than
  done.
- 🔎 **Browser visual check could not be automated in this sandbox** (the Preview MCP cannot launch vite here — no
  bind, no logs; no Chrome extension connected). Mitigated by: full **delta→reconstruction round-trip** integration
  test (peer rebuilds authoritative positions within ±1.5 px), 10 interpolation unit tests, a clean production build
  (all rewritten modules parse/bundle), and a code audit for crash risks (none found). Visual smoothness remains the
  user's manual milestone (M7). Added a dev-only `window.__socket` hook (stripped from prod) to aid manual debugging.
- ⏭️ Minor polish noted, not blocking: (a) `turnResolved` snaps the last ~100 ms of motion (coins are at rest by
  then — imperceptible; could ease later); (b) a pocket tween can begin ~100 ms "early" relative to the interpolated
  position (starts from the current visual spot, so still smooth). Both are cosmetic and acceptable for v1.

---

## Phase 3 — Robust lobby, presence & reconnection

**Goal:** make rooms behave correctly under disconnects, refreshes, and rage-quits — a user-stated focus ("lobby").

**Scope / changes:**
- **Delete the custom 5-minute heartbeat**; rely on Socket.IO Engine.IO ping/pong with tuned
  `pingInterval/pingTimeout` (~10 s/10 s → ~20 s dead-peer detection).
- **Enable Connection State Recovery** (`maxDisconnectionDuration` ~2 min) so a refresh/brief drop restores the
  session + missed events; handle the `socket.recovered === false` fresh path.
- **Disconnect grace period**: on `disconnect`, start a ~30 s timer; destroy the room only if the player doesn't
  return; clear the timer on reconnect/rejoin. Notify the opponent on real teardown.
- **Fix reconnect path**: client uses `rejoinRoom` (not `createRoom`/`joinRoom`) on socket reconnect; reconnect/rejoin
  **must not re-deal** an in-progress game; preserve scores/turn/board.
- **Fix the dead `disconnect` cleanup** to key off the persistent `clientId`, not `socket.id`.
- Opponent-disconnected signal to the client (uses existing `roomClosed`/a new `opponentLeft` status) so the board can
  show the existing leave behavior gracefully (no UI redesign — reuse current overlay/return-to-menu).

**Milestones (measurable, local — all via the 2-client integration harness):**
1. **Refresh-safe:** actor disconnects and reconnects within grace with the same `clientId` → **rejoins the same room,
   board/scores/turn preserved (not re-dealt).** (Assert state equal pre/post.)
2. **Grace teardown:** a player disconnects and does **not** return → after the grace window the room is deleted and
   the opponent receives a teardown event. (Assert timing + event.)
3. **Fast dead-peer detection:** a hard-killed socket is detected in **≤ ~20 s** (not minutes). (Assert via tuned ping
   or a forced `disconnect`.)
4. **Both leave → room gone:** explicit `leaveRoom` by both removes the room from the server `Map`. (Assert `/` shows
   no rooms.)
5. **Room full:** a third `clientId` joining a 2-player room is rejected with "Room is full". (Assert.)
6. **No-regression:** all Phase 1–2 milestones still pass.
7. **Manual (user):** refresh a tab mid-game → you land back in the same game; close a tab → opponent is informed
   within seconds.

**Exit criteria:** 1–6 green; manual confirms refresh + leave behavior.

**Strawman review (done):**
- ✅ Delivered: removed the 5-min custom heartbeat (client + server) in favour of Socket.IO ping/pong
  (`pingInterval/pingTimeout` 10s/10s ≈ 20s detection); enabled Connection State Recovery (2-min window); added a
  `clientId`-keyed disconnect **grace window** (`DISCONNECT_GRACE_MS`, default 30s) so a refresh/drop doesn't destroy
  the room; fixed the dead `socket.id`-based disconnect cleanup; fixed the client reconnect path to use `rejoinRoom`
  (no re-deal); simplified `leaveRoom` to a clean teardown; made the client error handler ignore transient gameplay
  errors. Tests: 34 server (incl. refresh-resume, grace-teardown, explicit-leave) + 10 client, all green.
- 🔎 **Connect/disconnect race fixed proactively:** a refresh's new socket can connect *before* the old socket's
  `disconnect` fires. A per-`clientId` live-connection counter (`liveConnections`) makes the grace timer start only
  when the client truly has no live connection — robust to either event ordering. (This was a real latent bug the
  naive grace implementation would have shipped.)
- 🔎 M3 (≤20s dead-peer detection) is satisfied by the ping config; not unit-tested directly (a silent-death test
  would take ~20s). The disconnect→grace→teardown path *is* tested via an explicit disconnect (fires at ~614ms with
  the 600ms test grace). CSR is enabled as a bonus layer; the *tested* resume path is `rejoinRoom` + `requestRoomData`
  (the primary mechanism), which is what a real refresh uses.
- ⏭️ Noted, not blocking: refreshing *during the opponent's in-flight flick* resyncs via a mid-sim `gameInit`
  snapshot then resumes interpolation — recovers cleanly at `turnResolved`, possibly a tiny visual hitch. Acceptable
  edge. The "one player leaves, room stays open for a new player" alternative (an old todo) was intentionally **not**
  built — explicit leave ends the match for both (simpler, predictable); a fresh room covers that need.

---

## Phase 4 — Architecture cleanup & elegance (lightweight, reusable)

**Goal:** make the code lighter, DRY, and drift-proof — without changing behavior. Tests from Phases 1–3 guard it.

**Scope / changes:**
- **Shared module** (`shared/`, npm workspaces): hoist all duplicated geometry/physics constants and the pure
  simulation into a frozen, dependency-free ESM package imported by **both** server and client (Vite bundles the
  workspace). Removes the "keep 5 files in sync by hand" hazard; prerequisite for Phase 6.
- **Shared protocol constants** (`shared/protocol.js`): event-name strings imported by both ends.
- **Delete dead code**: client listeners for `scoreUpdate`/`debtUpdate`/`debtScoreUpdate`/`debtPaid`/`gameReset`;
  client `strikerCollisionUpdate` emit; unused `Hand.handlePlace`/`handleFlick`; stray `server/netstat`, `client/npm`;
  commented-out blocks. Add a `favicon.ico` (or drop the link).
- **`Board.jsx` decomposition**: extract `useGameSocket` (listeners→buffer), `useGameInput` (pointer handlers),
  `useGameRenderer` (rAF loop), move the 170-line inline `<style>` to `Board.css`. Target a much smaller `Board.jsx`.
- **`Hand.js` dedupe**: collapse the duplicated global-listener mouse logic into one path.
- **Contract audit**: every client `socket.on` has a server emitter and vice-versa (enforced by a test/grep).

**Milestones (measurable, local):**
1. **Shared module:** server and client both `import` from `shared/` and `npm run build` (client) + `npm test`
   (server+client) all pass; the browser bundle contains the shared physics (build succeeds, no node-only APIs).
2. **Contract parity:** an automated check (test or `run-tests.sh` step) confirms **no client listener lacks a server
   emitter** and no emit lacks a handler. (Assert the dead events are gone.)
3. **Dead-code gone:** grep shows `scoreUpdate|debtUpdate|debtScoreUpdate|debtPaid|strikerCollisionUpdate` absent from
   the codebase; stray files removed; no `favicon.ico` 404 (file present or link removed).
4. **Size discipline:** `Board.jsx` reduced substantially (target < ~350 lines) and CSS externalized; record
   before/after line counts and bundle size.
5. **No-regression:** **all Phase 1–3 milestones still pass unchanged.** (This is the key gate for a pure refactor.)

**Exit criteria:** 1–5 green; behavior identical; code lighter.

**Strawman review:** _(filled during implementation)_

---

## Phase 5 — Touch, mobile & canvas rendering

**Goal:** first-class touch (user-stated focus) and crisp, efficient rendering on mobile — no visual redesign.

**Scope / changes:**
- **Unified Pointer Events**: replace mouse + synthetic-touch handling with `pointerdown/move/up/cancel` +
  `setPointerCapture(pointerId)` + CSS `touch-action:none`. One input path; flick keeps tracking when the drag leaves
  the board. Extract the flick-vector math (`angle`,`force` from pull vector) into a **pure module**
  (`shared/flick.js` or `client/scripts/flickMath.js`) for unit testing.
- **devicePixelRatio**: size the canvas backing store to `cssSize * dpr` and `ctx.scale(dpr,dpr)` on resize for sharp
  HiDPI/mobile rendering.
- **Static-board layer**: paint the unchanging board (frame, pockets, baselines, centre circle) **once** to a
  background canvas (`{alpha:false}`); render only coins + striker on a transparent foreground layer each frame.
- **Mobile slider polish**: keep the placement mechanic but ensure the (invisible) slider / placement drag works
  cleanly by touch and the buttons are tappable; no layout/visual redesign.

**Milestones (measurable, local):**
1. **Flick math purity:** unit tests for the pull-vector → `{angle, force}` conversion (direction sign, force clamp to
   [0,1], dead-zone < 5 px). (`client`/`shared` test.)
2. **One input path:** mouse and touch both drive the same `pointer*` handlers (no `MouseEvent` synthesis remains in
   the source). (Grep + manual.)
3. **Static layer:** the board is drawn once (assert `drawBoard` is not called inside the per-frame loop; the
   foreground redraw touches only coins/striker). Record draw-call reduction.
4. **DPR:** on a HiDPI window the canvas backing store is `>1×` CSS size. (Manual + a small assertion where possible.)
5. **No-regression:** all Phase 1–4 milestones still pass; client build succeeds.
6. **Manual (user):** on a phone/emulated touch — placement drag, aim, and flick all work by finger; release outside
   the board still flicks; pinch/scroll doesn't hijack the gesture; rendering is sharp and smooth.

**Exit criteria:** 1–5 green; manual touch checklist passes.

**Strawman review:** _(filled during implementation)_

---

## Phase 6 — (Optional) Client-side prediction for the acting player

**Goal:** remove the acting player's start-of-shot round-trip delay. **Gated** — only ship if it is provably stable
(research: interpolation alone is sufficient for v1; prediction is polish that must not introduce pops/bugs). If
stability can't be guaranteed within scope, this stays a documented spec and is **not** shipped (respecting the
"no bugs" gate).

**Scope / changes (only with the shared deterministic sim from P2+P4):**
- On flick, the acting client runs the shared `step()` simulation locally for **immediate** feedback; the opponent
  continues via interpolation (P2).
- Reconcile to the server's authoritative `turnResolved` final positions by **snap or short ease (~100–150 ms)** —
  never a hard teleport.
- Feature-flagged so it can be disabled instantly.

**Milestones (measurable, local):**
1. **Determinism check:** client-local and server simulations of the same flick produce final positions within a tiny
   epsilon for a battery of inputs (both run V8). (Shared-module test comparing two runs.)
2. **Zero-latency feel (manual):** the acting player sees the striker move **on the same frame** they release, with no
   perceptible wait; the opponent's view is unchanged from P2.
3. **No pop (manual + tolerance test):** reconciliation correction at `turnResolved` is below a visible threshold for
   normal shots; if exceeded, the ease (not snap) hides it.
4. **No-regression:** all Phase 1–5 milestones pass with prediction both ON and OFF.

**Exit criteria:** all green AND no instability → ship enabled. Otherwise: ship disabled, document as future work.

**Strawman review:** _(filled during implementation)_

---

## Manual test checklist (for the user, after wake-up)

1. `cd server && npm install && npm run dev`; `cd client && npm install && npm run dev`; open two tabs at
   `http://localhost:3001`.
2. **Lobby:** create a room in tab A, join it in tab B → both land on the board; a 3rd tab joining is refused.
3. **Sync/lag:** flick in the active tab → both tabs animate the **same** shot smoothly to the **same** resting
   positions; turn passes (or continues on a pot).
4. **Refresh:** refresh the active tab mid-game → you return to the **same** game (board/score/turn intact).
5. **Leave:** close one tab → the other is told the opponent left within seconds.
6. **Touch:** open on a phone (or DevTools touch emulation) → place/aim/flick all by finger; releasing off-board still
   flicks; the page doesn't scroll/zoom while aiming; board looks sharp.
7. **Build:** `cd client && npm run build` succeeds; run `./run-tests.sh` → overall PASS.

## Deployment (Cloud Run — the user runs these)

```bash
# Server (authoritative socket game loop). Build container, then:
gcloud run deploy carrom-server \
  --source server \
  --region <REGION> \
  --min-instances 1 --max-instances 1 \   # pin: in-memory rooms stay correct
  --concurrency 200 \
  --timeout 3600 \                         # 60-min max WebSocket lifetime (default 5m)
  --no-cpu-throttling \                    # keep the physics tick alive between requests
  --cpu 1 --memory 512Mi --port 8080
# Do NOT enable end-to-end HTTP/2. Set CORS_ORIGINS to the client URL.

# Client (static). Build then serve from Cloud Run (nginx/static) or any static host:
cd client && VITE_SERVER_URL=https://<carrom-server-url> npm run build
```

## Out of scope (explicit non-goals)

No UI/visual redesign; no 4-player; no AI; no DB/accounts/leaderboard; no Redis (until one instance is CPU-bound); no
binary serialization; no server-side lag compensation; no tournament-rule scoring rewrite. These are recorded in
research §E.
