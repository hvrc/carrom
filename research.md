# Carrom Multiplayer — Research & Technical Strategy

> Goal of this document: build a deep, evidence-based understanding of the application and of how comparable
> real-time multiplayer browser games are built, so we can make this one **fast, smooth, robust, elegant, and
> well-scoped** without changing the visual design. Everything here feeds directly into [prd.md](prd.md).
>
> Target production environment: **Google Cloud serverless** (currently App Engine standard; migrating to **Cloud
> Run** — both server and client). All recommendations are tuned for that environment.

---

## 0. Executive summary — the six highest-leverage findings

1. **The server runs on App Engine _standard_, which does not support WebSockets.** Socket.IO is therefore silently
   running on **HTTP long-polling** in production — high latency, clumpy delivery of the 30 Hz frame stream, and
   broken sessions the moment it scales past one instance (no session affinity is configured). This is the single
   biggest cause of perceived lag. **Fix: move the server to Cloud Run (native WebSocket), force
   `transports:['websocket']`, pin to one instance.** (§B1, §C2)

2. **Rendering is coupled to packet arrival.** The client redraws inside each `physicsFrame` socket handler, so the
   on-screen frame rate equals the (jittery, long-polled) network rate. **Fix: decouple — buffer timestamped
   snapshots and render in a `requestAnimationFrame` loop that interpolates ~100 ms in the past.** This one change
   turns a 30 Hz jittery stream into buttery 60 fps motion and is the highest smoothness-per-effort win. (§C1)

3. **Disconnect/reconnect/heartbeat are broken.** The `disconnect` handler compares a persistent `clientId` against
   `socket.id` (never equal → dead code), the client's reconnect path emits `createRoom`/`joinRoom` (which error and
   eject the player), and a custom **5-minute** application heartbeat holds dead rooms open for minutes. **Fix:
   lean on Socket.IO's built-in ping/pong + Connection State Recovery + a short disconnect grace period.** (§B2, §C2)

4. **Server compute and bandwidth are _not_ the bottleneck.** Measured: ~100 µs per physics step (~0.6 % of one
   core per active flick), ~1 KB JSON per frame. The problems are transport and client rendering, not CPU. So we
   should spend effort on transport/render, and treat physics micro-optimization as low-priority cleanup. (§B5)

5. **The codebase carries significant dead weight and contract drift.** The client listens for five events the
   server never emits (`scoreUpdate`, `debtUpdate`, `debtScoreUpdate`, `debtPaid`, `gameReset`) and emits one the
   server ignores (`strikerCollisionUpdate`); `Board.jsx` is ~900 lines with a 170-line inline `<style>`; `Hand.js`
   duplicates its entire mouse-handling logic for a "global listener" path. Cleanup will make it lighter and safer
   without behavior change. (§B3)

6. **The physics simulation is non-deterministic** (`setInterval(step, 16)` drifts) — fine for a server-only
   authority today, but it must become a **fixed-timestep accumulator** before any client-side prediction is
   possible, and it makes results reproducible for testing. (§C1)

The **biggest bang for the buck**, in order: Cloud Run + WebSocket-only transport → client interpolation/render-loop
decoupling → robust disconnect/reconnect → fixed timestep → code cleanup → (optional) client-side prediction.

---

## Part A — What the application is and how it works

### A1. Product

A 2-player, real-time, online **Carrom** board game (the South-Asian flick/strike tabletop game — a striker
slingshots into a cluster of 19 coins to pocket them in corner pockets). Two friends create/join a named room, take
turns aiming and flicking the striker, and score by pocketing their colour's coins plus the red "queen." Minimal
black-and-white line-art aesthetic rendered on an HTML canvas. No accounts, no persistence, no AI — friends only.

### A2. Architecture (as built)

```
┌────────────────────── client (React + Vite, static) ──────────────────────┐
│  main.jsx → App.jsx (router)                                               │
│     ├── /            Menu.jsx     create/join room                         │
│     └── /:roomName   Room.jsx     socket lifecycle + <Board>               │
│                         └── Board.jsx (GameCanvas)                         │
│                               canvas render + socket game listeners        │
│                               ├── Hand.js   input → flick {x,angle,force}   │
│                               ├── Draw.js   all canvas drawing (static)     │
│                               ├── Coin.js / Striker.js / Pocket.js  render  │
│                               ├── Events.js slider-preview relay           │
│                               └── Manager.js thin score/turn mirror        │
│  socket.js  singleton socket.io-client (clientId in handshake query)      │
└───────────────────────────────────────────────────────────────────────────┘
                    ▲  socket.io events  ▼   (long-polling in prod today!)
┌────────────────────── server (Node + Express + Socket.IO) ────────────────┐
│  index.js    room lifecycle, turn validation, flick orchestration         │
│  physics.js  PURE authoritative sim: geometry, CCD collisions, friction,  │
│              pocket detection, carrom rule resolution, snapshots          │
│  in-memory `rooms` Map  (no database)                                      │
└───────────────────────────────────────────────────────────────────────────┘
```

- **Client**: React 18 + react-router + Vite. Rendering is raw **Canvas2D** (Phaser was removed earlier). The
  canvas is a fixed 900×900 logical surface, CSS-scaled to fit the viewport. The joiner's canvas is rotated 180° so
  each player sees their baseline at the bottom.
- **Server**: Express (for a tiny status page + CORS) + Socket.IO v4. **Authoritative physics** lives in a pure,
  dependency-free ESM module ([server/physics.js](server/physics.js)) with no DOM/socket/logging — good separation.
- **Deploy**: Google App Engine standard `nodejs20`. Two services: `default` (client static files from `dist/`) and
  `backend` (the socket server). Client talks to `https://backend-dot-carrom-2222.el.r.appspot.com`. The backend has
  `min_instances:1, max_instances:10, target_cpu_utilization:0.65`. **No `session_affinity`, no shared adapter.**

### A3. The core gameplay loop (server-authoritative)

This is the heart of the app and was a deliberate, correct architectural choice (avoids floating-point divergence
between two independently-simulating clients):

```
Acting client                 Server (physics.js)                 Both clients
─────────────                 ───────────────────                 ────────────
Hand._emitFlick:
  dx,dy = start-end
  force = min(dist/100, 1)
  angle = atan2(dy,dx)
  emit "flick"{roomName,strikerX,angle,force} ─►
                              validate room/game/sim-idle/turn
                              (actor from persistent clientId,
                               NOT socket.id)
                              startFlickSimulation():
                                place + launch striker
                                setInterval(16ms) 60 Hz:
                                  step(): CCD, friction, stop,
                                          overlap fix, pocket detect
                                  every 2nd tick ──► emit "physicsFrame"
                                  on pocket      ──► emit "pocketEvent"
                                  when settled:
                                    resolveTurn(): score, queen FSM,
                                      striker foul, debt settle,
                                      continue-vs-switch, win check
                                    ──► emit "turnResolved" + "roomUpdate"
                                                                  render frames as they arrive
                                                                  (no local physics)
```

`step()` integrates each object with **continuous collision detection** (sub-stepping fast objects to avoid
tunnelling), applies friction (×0.97/tick), snaps to rest below a velocity threshold, fixes residual overlaps, and
detects pockets. `resolveTurn()` implements the carrom rules once the board settles.

### A4. Actual socket event contract (audited from source)

| Direction | Event | Payload | Notes |
|---|---|---|---|
| C→S | `createRoom` / `joinRoom` | `{roomName, username, clientId}` | join triggers `startGame` on 2nd player |
| C→S | `checkRoomAccess` / `rejoinRoom` / `requestRoomData` / `leaveRoom` | room + clientId | lobby/reconnect |
| C→S | `heartbeat` | `{clientId}` | **redundant 5-min app heartbeat (anti-pattern)** |
| C→S | `flick` | `{roomName, strikerX, angle, force}` | the only gameplay input |
| C→S | `strikerSliderUpdate` | `{roomName, playerRole, sliderValue, strikerX}` | placement preview, relayed |
| C→S | `gameReset` | `{roomName}` | re-deal |
| C→S | `strikerCollisionUpdate` | — | **DEAD: server has no handler** |
| S→C | `playerJoined`, `roomUpdate`, `roomClosed`, `accessGranted`, `error` | — | lobby/state mirror |
| S→C | `gameInit` | full snapshot | start / reset / reconnect |
| S→C | `physicsFrame` | `{coins:[{id,x,y}], striker:{x,y}|null}` | ~30 Hz, **no timestamp** |
| S→C | `pocketEvent` | `{kind,id?,color?,pocket:{x,y},from?}` | one per pocket |
| S→C | `turnResolved` | `{...resolution, state: fullSnapshot}` | once per flick |
| S→C(dead) | `scoreUpdate`, `debtUpdate`, `debtScoreUpdate`, `debtPaid`, `gameReset` | — | **DEAD: client listens, server never emits** |

### A5. Game rules as implemented vs. official carrom

The implementation is a reasonable **arcade approximation**, not tournament rules — and that's a fine design choice
for a casual friends game. Confirmed against canonical sources (Masters of Games, Indian Carrom Federation):

- **Scoring**: arcade per-coin model — each coin you pocket of your colour = +1, queen = +5. (Tournament carrom
  instead scores opponent's _remaining_ pieces at game end. We keep the arcade model — simpler, already built.)
- **Queen + cover**: pocket the queen, then cover it by pocketing one of your own coins on the same or the
  immediately following stroke; otherwise the queen returns to centre. ✔ Implemented as a 3-state FSM
  (`on_board → pocketed_uncovered → covered`/back).
- **Striker foul ("due")**: pocketing the striker returns one of your pocketed coins to the board and ends your
  turn; if you have none, you owe a "due"/debt settled against future scoring. ✔ Implemented (auto-settle).
- **Continue turn**: pocket your own coin (no foul) → shoot again (capped at 3 in a row as a safety valve). ✔

Minor rule edge cases to verify with tests (see §B6) — e.g. fouling on the same stroke that pockets+covers the
queen, and the game-over detection keying off "whose turn is next." These are correctness-test targets, not
redesigns.

---

## Part B — Current-state audit (grounded findings)

Each finding cites the file and is classified by severity. Measurements are from instrumenting the actual code.

### B1. 🔴 Deployment & transport — the dominant latency source

- **App Engine standard has no WebSocket support** ([Google Group thread](https://groups.google.com/g/google-appengine/c/cDR1Ru2ak88),
  [App Engine flexible WS announcement](https://cloud.google.com/blog/products/application-development/introducing-websockets-support-for-app-engine-flexible-environment)).
  `server/app.yaml` declares `env: standard`, so in production Socket.IO **falls back to HTTP long-polling**. Long-
  polling delivers server→client messages only when a poll request is open, batching the 30 Hz stream into clumps —
  precisely the stutter/lag described. (Locally, dev uses WebSocket, so the problem is invisible in development.)
- **No session affinity + `max_instances:10`.** With long-polling, a session's sequential requests must hit the same
  instance or you get `HTTP 400 "Session ID unknown"` ([Socket.IO multi-node](https://socket.io/docs/v4/using-multiple-nodes/)).
  Nothing in `app.yaml` enables `network.session_affinity`. Today `min_instances:1` masks this most of the time, but
  any scale-up at 65 % CPU breaks live games.
- **No shared adapter + in-memory `rooms`.** Even with affinity, two players routed to different instances would run
  two divergent simulations of "the same" room — the in-memory `Map` is per-heap and the default adapter can't
  broadcast across instances ([Socket.IO adapter](https://socket.io/docs/v4/adapter/)).
- **CORS is hardcoded** to the appspot URLs in [server/index.js](server/index.js:55) — brittle across environments;
  should be env-driven.

### B2. 🔴 Disconnect / reconnect / presence — broken and slow

- **Dead disconnect cleanup**: [server/index.js](server/index.js:570) compares `room.creator.clientId === socket.id`.
  `clientId` is the persistent UUID from the handshake query; `socket.id` is the per-connection id. They are never
  equal, so the `disconnect` handler's room teardown is **dead code** — rooms are only ever cleaned by the 5-minute
  heartbeat sweep or explicit `leaveRoom`.
- **Broken reconnect**: [client/scripts/socket.js](client/scripts/socket.js:92) re-emits `createRoom`/`joinRoom` on
  reconnect. The server replies `"Room already exists"` / `"Client already in room"`, and `Room.jsx`'s error handler
  then runs `localStorage.clear(); navigate("/")` — i.e. a transient drop **ejects the player to the menu**. There is
  a correct `rejoinRoom` handler on the server, but the client doesn't use it on reconnect. Worse, `joinRoom` would
  re-trigger `startGame` and **re-deal the board** mid-game.
- **5-minute custom heartbeat is an anti-pattern** ([server/index.js](server/index.js:83)): Socket.IO already does
  liveness via Engine.IO ping/pong (default 25 s interval / 20 s timeout ≈ 45 s detection,
  [docs](https://socket.io/docs/v4/how-it-works/)). A 5-minute app-level heartbeat duplicates it and keeps a
  rage-quit/dead opponent "alive" for up to 5 minutes, freezing the other player.
- **No disconnect grace window**: a page refresh (an explicit todo item) should not destroy the room; there should be
  a short grace period to allow reconnection.

### B3. 🟠 Dead code & event-contract drift

- **Client listens for 5 events the server never emits** (`scoreUpdate`, `debtUpdate`, `debtScoreUpdate`,
  `debtPaid`, `gameReset`) — all in [Room.jsx](client/scripts/Room.jsx) (≈150 lines of dead `useEffect`s) that call
  `manager.updateScore/updateDebt/resetGame`, methods that **no longer exist** on `Manager` (would throw if the
  events ever fired). Pure dead weight.
- **Client emits `strikerCollisionUpdate`** in [Hand.handlePlace](client/scripts/Hand.js:137) — server has no
  handler. `handlePlace`/`handleFlick` appear unused entirely.
- **`Board.jsx` ≈ 900 lines**, including a **170-line inline `<style>`** string injected via
  `document.createElement('style')` for the invisible range-input slider — should be a static CSS file.
- **`Hand.js` duplicates its mouse logic**: `handleMouseMove`/`handleMouseUp` each contain a near-identical second
  copy for the "global listener" (`_lastContext`) path. ~200 lines collapsible to one.
- **`Room.jsx` `GameInfoTable`** reads queen fields (`isCoverTurn`, `hasPocketedQueen`, `hasCoveredQueen`) that
  `Manager` no longer carries; it's also commented out of the render. Decide: surface from `turnResolved.state.queen`
  or delete.
- **`favicon.ico` 404s on every load** — `index.html` references `/favicon.ico` but no file exists.
- **`server/netstat` and `client/npm`** are stray empty files committed by accident.

### B4. 🟠 Rendering jitter & input model

- **Render driven by the socket, not a render loop**: [Board.jsx](client/scripts/Board.jsx:559) redraws inside
  `handlePhysicsFrame`. On-screen smoothness is hostage to network arrival timing. No interpolation buffer; frames
  are applied raw. (Fix in §C1.)
- **No `devicePixelRatio` handling** — the 900×900 canvas is CSS-scaled, so on HiDPI/mobile it can look soft.
- **Touch via synthetic `MouseEvent`s** ([Board.jsx](client/scripts/Board.jsx:381)): touch handlers construct fake
  mouse events. This works but is fragile (manual `offsetX` patching, `screenX` plumbing). The modern, simpler path
  is the unified **Pointer Events API** (one code path for mouse + touch + stylus). The user explicitly wants touch
  to be first-class. (Fix in §C3.)
- **The slider is an invisible 0-opacity `<input type=range>`** overlaid below the board for striker placement; all
  its appearance is nuked by the 170-line style block. Works, but opaque and mobile-awkward.

### B5. 🟢 Physics performance — fine, with cheap cleanups available

- **Measured**: ~99 µs compute per `step()`; one full power flick ≈ 141 ticks ≈ **14 ms total CPU**; at 60 Hz a
  single active flick is **~0.6 % of one core**. Frame payload ≈ **1.08 KB JSON**; full snapshot ≈ 1.9 KB. So a
  single small instance can host **dozens–hundreds of concurrent rooms** before CPU matters, and bandwidth is a
  non-issue at this object count.
- **Per-tick allocation churn** is the one smell: `step()` does `coins.filter(...)` and, per coin,
  `all.filter(o => o !== coin)` every tick — O(n) array allocations × 60 Hz × rooms. Easy to hoist out of the hot
  loop (reuse arrays). Low priority given the CPU headroom, but trivially elegant.
- **`setInterval(16)` drift**: non-deterministic dt (see §C1, §B6). Acceptable for server-only authority now; must
  change before prediction and for reproducible tests.

### B6. 🟡 Game-rule correctness (test targets, not redesigns)

- **Foul-on-cover**: the same-stroke cover path (`queenPocketedThisTurn && ownColorPocketedThisTurn`) awards the
  queen +5 **without checking `strikerFoul`** ([physics.js](server/physics.js:450)). If you sink queen + own coin +
  striker in one stroke, you currently still cover. Likely should fail the cover on a foul. Verify with a test.
- **Game-over keys off the _next_ player's colour** ([physics.js](server/physics.js:523)) — works in the common
  "pocket your last coin → continue turn" path but is fragile around foul/switch and the 3-in-a-row cap. Needs
  explicit tests around end-of-game.
- **`respawnAtCenter` spiral** could, in a pathological full board, fail to find a free spot within 200 px; verify it
  always resolves.
- These are **correctness-test milestones**, captured in the PRD's test harness — the rules are kept as designed.

### B7. 🟢 What's already good (keep it)

- Server-authoritative model with a **pure, isolated physics module** — exactly right; don't undo it.
- Persistent `clientId` in the handshake query for actor identification across reconnects.
- CCD sub-stepping to prevent tunnelling at high striker speed.
- The flick contract `{strikerX, angle, force}` is minimal and good.
- Pocket-drop tween (`Coin`/`Striker` `startPocketAnim`) is a tasteful presentation-only touch.

---

## Part C — External research & best practices

Three canonical bodies of knowledge apply: (C1) real-time game **netcode**, (C2) **Socket.IO on cloud serverless**,
and (C3) **architecture/rendering conventions** for `.io`-style canvas games. Citations inline.

### C1. Netcode — interpolation, fixed timestep, (optional) prediction

Built on the field's canonical sources: Gabriel Gambetta's
[Fast-Paced Multiplayer](https://www.gabrielgambetta.com/client-server-game-architecture.html) series, Valve's
[Source Multiplayer Networking](https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking), and Glenn
Fiedler's [Fix Your Timestep!](https://gafferongames.com/post/fix_your_timestep/) /
[Snapshot Interpolation](https://gafferongames.com/post/snapshot_interpolation/).

**(1) Entity / snapshot interpolation — the #1 technique for this game.** Don't render a snapshot the instant it
arrives; render the world **slightly in the past** and interpolate between the two snapshots bracketing that render
time. The render clock advances continuously at 60 fps and just _samples_ the buffer, so jittery/bunched packet
arrival becomes invisible ([Gambetta, Entity Interpolation](https://www.gabrielgambetta.com/entity-interpolation.html)).
- **Delay math**: Valve's Source defaults to `cl_interp = 100 ms`, chosen so that "even if one snapshot is lost there
  are always two valid snapshots to interpolate between"; the rule is **≥ ~2 update intervals** of buffer
  ([Valve](https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking)). Fiedler cites ~150 ms at 30 pps.
  **For our 30 Hz stream: ~100 ms delay** (≈3 frames of buffer; survives one dropped snapshot comfortably).
- **Formula**: `renderTime = now − 100ms`; find buffered `S0 (t0≤renderTime)` and `S1 (t1≥renderTime)`;
  `α = (renderTime−t0)/(t1−t0)`; `pos = S0.pos + (S1.pos−S0.pos)·α`.
- **Prerequisite**: snapshots must carry a **timestamp** (a monotonic sim-tick is enough — no cross-machine clock
  sync needed since the client builds its render clock from arrival). Our `physicsFrame` has none today.
- **On a gap, _hold_ the last position — do NOT extrapolate.** Carrom coins change direction sharply on every
  collision; linear extrapolation would shoot a coin through a cushion and snap it back. Fiedler: "you simply can't
  accurately match a physics simulation with an approximation"
  ([Snapshot Interpolation](https://gafferongames.com/post/snapshot_interpolation/)). Hold is strictly less wrong for
  rigid-body motion.
- Linear interpolation between position-only snapshots is fine at 30 Hz. Hermite (velocity-aware) splines are a later
  option only if fast shots look faceted — and bumping send-rate is a better first lever than adding Hermite.

**(2) Decouple render from network** — the structural fix behind (1):
```js
const buffer = [];                                   // timestamped snapshots
socket.on('physicsFrame', s => buffer.push(s));      // PRODUCER only — never draws
function renderLoop() {                              // CONSUMER — 60fps, network-independent
  const renderTime = clientClock() - INTERP_DELAY;   // −100ms
  const [s0, s1] = bracket(buffer, renderTime);
  if (s0 && s1) draw(lerp(s0, s1, (renderTime-s0.t)/(s1.t-s0.t)));
  else if (s0)  draw(s0);                            // hold, don't extrapolate
  prune(buffer, renderTime);
  requestAnimationFrame(renderLoop);
}
```
This is the change that makes 30 Hz network data look like 60 fps motion. It replaces the per-`physicsFrame` redraw.

**(3) Fixed-timestep accumulator** ([Fiedler](https://gafferongames.com/post/fix_your_timestep/)). `setInterval(16)`
fires at variable real intervals, so each `step()` advances physics by a _variable_ amount → non-reproducible results
and (later) client/server divergence. Use an accumulator that always integrates a constant `dt = 1/60`, and **clamp**
frame time to ≤ 0.25 s to avoid the "spiral of death":
```js
const dt = 1/60; let acc = 0, prev = now();
function tick() {
  let frame = (now() - prev)/1000; if (frame > 0.25) frame = 0.25; prev = now();
  acc += frame;
  while (acc >= dt) { step(state, dt); acc -= dt; }   // step() ALWAYS gets dt
}
```
For the **server** authority, the key property is simply that every `step()` uses a **constant dt** — that alone gives
reproducibility for tests and the determinism prediction would later need.

**(4) Client-side prediction for the acting player — _optional polish, do last._** Prediction is the only thing that
removes the acting player's start-of-shot round-trip delay: run the same `startFlickSimulation` locally the instant
they flick, then reconcile to the server's `turnResolved` rest positions
([Gambetta, Prediction & Reconciliation](https://www.gabrielgambetta.com/client-side-prediction-server-reconciliation.html)).
Carrom simplifies this hugely: a turn is **one discrete input then a deterministic settle**, so there is no input
stream to replay — just "predict the whole settle, then snap-or-ease (~100–150 ms) to the authoritative final
positions." Caveats: needs the fixed timestep (3) and shared physics; both ends are V8 so `Math.sin/cos` agree in
practice, but a tiny launch difference compounds over a multi-second settle into a visible end-of-shot "pop," so the
reconciliation must ease, not teleport. **Recommendation: interpolation alone (1–2) is enough for v1.** Add
prediction only after the sim is deterministic, and gate it as a final phase.

**(5) Bandwidth — mostly a non-problem at ~20 objects.** The one optimization worth doing is **delta encoding: send
only coins that moved** (most are stationary; payload shrinks dramatically late in a settle, and it doubles as the
"is-anything-moving" signal). Quantizing coordinates to integers is a free minor win. Binary/msgpack is **premature**
at this scale (Socket.IO's own guidance: binary helps for _large_ payloads; for small messages it may not be
necessary — [perf tuning](https://socket.io/docs/v4/performance-tuning/)). **Skip lag-compensation/server-rewind
entirely** — it exists for instant-hit weapons against moving targets; carrom aims at _stationary_ coins on _your
own_ turn, so there is no "where was the target 100 ms ago" problem to solve
([Gambetta, Lag Compensation](https://www.gabrielgambetta.com/lag-compensation.html)).

### C2. Socket.IO on Google Cloud serverless

**The multi-instance problem** has three independent failure modes, each with a different fix
([Socket.IO multi-node](https://socket.io/docs/v4/using-multiple-nodes/),
[adapter](https://socket.io/docs/v4/adapter/), [Cloud Run WebSockets](https://docs.cloud.google.com/run/docs/triggering/websockets)):
1. **Long-polling handshake** needs a session's requests to hit the same instance → **sticky sessions**, else
   `HTTP 400 "Session ID unknown"`.
2. **Cross-instance broadcast**: `io.to(room).emit` only reaches sockets on the local instance → needs a **shared
   adapter** (Redis). _Independent of transport._
3. **In-memory game state** is per-heap → needs **shared state** or a guarantee both players land on one instance.

**WebSocket-only transport dissolves #1.** A WebSocket is one long-lived connection, so there are no follow-up HTTP
requests to misroute; the Socket.IO maintainer confirms WebSocket-only needs **no sticky sessions**
([discussion #4687](https://github.com/socketio/socket.io/discussions/4687)). Cost: no long-polling fallback for
locked-down networks (acceptable for a friends game).

**The pragmatic, recommended design for this app: Cloud Run, pinned to one instance, WebSocket-only.** Pinning to a
single instance eliminates #2 and #3 entirely — the in-memory `Map` and default adapter are simply correct, no Redis
needed. Cloud Run specifics that matter:
- **Native WebSocket support**, timeout configurable up to 60 min (default only 5 min → must raise `--timeout=3600`).
- **`--no-cpu-throttling`** is **required**: by default Cloud Run throttles CPU to ~zero between requests, which would
  freeze the `setInterval` physics tick. Always-on CPU keeps the loop ticking
  ([always-on CPU](https://cloud.google.com/blog/topics/developers-practitioners/use-cloud-run-always-cpu-allocation-background-work)).
- **`--min-instances=1 --max-instances=1`**, **raise `--concurrency`** (default 80; ceiling ~1000 WebSockets/instance).
- **Do not enable end-to-end HTTP/2** for WebSockets; don't bother with `--session-affinity` at one instance.
- Trade-off: single point of failure — a deploy/crash drops active games. Mitigate with Connection State Recovery +
  a disconnect grace period (below). For 2 friends this is the right, cheap trade. Cost ≈ a few $/month for one warm
  instance ([Cloud Run pricing](https://cloud.google.com/run/pricing)).

**Connection State Recovery (Socket.IO 4.6+)** backs up a socket's id, rooms, `socket.data`, and missed packets and
**replays them on reconnect within a window** — purpose-built for refresh/brief-drop resume. Works with the in-memory
adapter (our single-instance case) after enabling:
```js
new Server(httpServer, {
  transports: ['websocket'],
  connectionStateRecovery: { maxDisconnectionDuration: 2*60*1000, skipMiddlewares: false },
  pingInterval: 10000, pingTimeout: 10000,   // ~20s dead-peer detection (vs custom 5-min anti-pattern)
});
```
([connection-state-recovery](https://socket.io/docs/v4/connection-state-recovery),
[server-options](https://socket.io/docs/v4/server-options/)). Always handle the `socket.recovered === false` (fresh
session) path.

**Disconnect grace period** (don't tear down the room on `disconnect`; destroy only if the player doesn't return):
```js
socket.on('disconnect', () => {
  room.disconnectTimer = setTimeout(() => { rooms.delete(roomId); notifyOpponent(); }, 30_000);
});
// on (re)join: clearTimeout(room.disconnectTimer)
```
CSR restores the _socket_; the grace timer keeps the _game state_ alive during the gap.

**Heartbeat**: use Socket.IO's built-in ping/pong; **delete the custom 5-minute heartbeat**. Ensure any proxy read
timeout exceeds `pingInterval + pingTimeout`.

**Verdict — Cloud Run over App Engine** for a stateful WebSocket game server: App Engine _standard_ can't do
WebSockets at all; _flexible_ can but never scales to zero and caps connections at 1 hour; Cloud Run has native
WebSockets, scale-to-one warm instance, always-on CPU, and full container control. _If only multi-instance scale is
ever needed_, the documented path is Memorystore Redis + `@socket.io/redis-streams-adapter` (streams, so CSR keeps
working) + WebSocket-only — but that's over-engineering until one instance's CPU is genuinely saturated.

### C3. Architecture, rendering & input conventions for `.io`-style canvas games

Two reference projects are close analogues and were studied directly:
- **[vzhou842/example-.io-game](https://github.com/vzhou842/example-.io-game)** (Victor Zhou's
  [part 1](https://victorzhou.com/blog/build-an-io-game-part-1/) / [part 2](https://victorzhou.com/blog/build-an-io-game-part-2/))
  — the gold-standard _small_ authoritative-server canvas-game layout: `shared/` constants imported by both sides,
  a single 60 Hz server `Game` loop broadcasting every 2nd tick (30 Hz), and a client split into four tiny modules
  (`networking` / `state` / `render` / `input`) with a 100 ms interpolation buffer.
- **[piqnt/polymatic-example-eight-ball](https://github.com/piqnt/polymatic-example-eight-ball)** — multiplayer
  8-ball pool, Socket.IO + authoritative server, **turn-based with continue-on-pot** (the exact carrom rule). Its
  core idea: physics is a **shared module that runs on both client and server**; only rendering and room-transport
  differ by environment. Its `TurnBased` module deliberately keeps _settle-detection_ separate from _turn-rules_.

The consensus is a **three-zone split — `shared / server / client`** — where `shared` is dependency-free and imported
by both. Concretely for this app:

- **Shared module kills the #1 liability: duplicated constants.** `server/physics.js`'s own header lists five client
  files (`Draw.js`, `Coin.js`, `Striker.js`, `Hand.js`, `Pocket.js`) it must be "kept in sync with by hand" — exactly
  the drift a shared module prevents. Move geometry/physics constants + `step()` + rules into a frozen, DOM-free ESM
  `shared/` package, wired via **npm workspaces** (Vite bundles the symlinked workspace automatically; keep it
  dependency-free so it resolves in the browser without a build step
  — [guide](https://soledadpenades.com/posts/2024/multirepo-monorepo-npm-workspaces-vite/)). This is also the
  prerequisite for client-side prediction (C1.4).
- **Promote socket event names to `shared/protocol.js`** so both ends import identical strings (Zhou's `MSG_TYPES`
  pattern) — the contract is already documented in `index.js`; this makes it typo-proof.
- **Static board on its own canvas layer — the biggest single rendering win.** The board frame, pockets, baselines,
  and centre circle never change within a game, yet `Draw.drawBoard()` re-rasterizes all of them every frame. Paint
  them **once** to a background canvas (`getContext('2d',{alpha:false})`) and stack a transparent foreground canvas
  for the ~20 coins + striker. Handle `devicePixelRatio` once on resize (`canvas.width = cssW*dpr; ctx.scale(dpr,dpr)`)
  for crisp HiDPI/mobile ([MDN: Optimizing canvas](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas)).
- **Positional state in refs, never React state.** React re-renders must not drive the 60 fps canvas; socket handlers
  write snapshots into a ref-held buffer and the rAF loop reads it. Reserve `useState` for discrete UI only (turn,
  score, game-over, connection) ([CSS-Tricks: rAF with hooks](https://css-tricks.com/using-requestanimationframe-with-react-hooks/)).
  The code mostly does this — formalize it as a rule and audit that no coin/striker position lives in `useState`.
- **Unified Pointer Events** (`pointerdown/move/up` + **`setPointerCapture(pointerId)`** + CSS `touch-action:none`)
  replace the mouse/touch duplication and the synthetic-`MouseEvent` hack with one input path for mouse, touch, and
  stylus. `setPointerCapture` is the key to a flick that keeps tracking when the drag leaves the board edge
  ([MDN: Using Pointer Events](https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events/Using_Pointer_Events)).
- **Split `server/index.js`** into socket-wiring vs a `GameRoom` class that owns one match's state + settle-detection
  + broadcast (Zhou's `server.js`/`game.js`; the pool game's `RoomServer` + shared logic).
- **Keep what already matches the references**: server-authoritative pure physics, _event-driven_ (not constant-rate)
  broadcasting — even leaner than a steady-state `.io` game — thin `{id,x,y}` payloads, and the minimal event set.

---

## Part D — Synthesis: prioritized roadmap (feeds the PRD)

Ranked by **(impact on the user's stated goals: lobby, touch, sync, lag) ÷ effort/risk**:

| # | Change | Impact | Effort | Risk | Phase |
|---|---|---|---|---|---|
| 1 | **WebSocket-only transport** (client+server) + Cloud Run config (Dockerfile, `--no-cpu-throttling`, `--timeout`, pin to 1 instance) | 🔥 kills long-polling lag | low | low | P1 |
| 2 | **Test harness** (node:test for physics/rules + 2-client socket integration) | enables every milestone | med | low | P1 |
| 3 | **Timestamp snapshots + client interpolation buffer + rAF render loop** | 🔥 smooth 60 fps, jitter-immune | med | med | P2 |
| 4 | **Fix disconnect/reconnect/heartbeat**: built-in ping, CSR, grace period, `rejoinRoom` on reconnect, kill 5-min heartbeat | 🔥 refresh-safe, no frozen rooms | med | med | P3 |
| 5 | **Fixed-timestep accumulator** on server sim | reproducible + prediction-ready | low | low | P2 |
| 6 | **Delta-encode snapshots** (moving coins only) + quantize | bandwidth/clarity | low | low | P2 |
| 7 | **Code cleanup**: delete dead events/handlers, split `Board.jsx`, extract CSS, dedupe `Hand.js`, shared geometry module, remove stray files, favicon | 🔥 elegance/lightness/maintainability | med | low | P4 |
| 8 | **Touch/mobile**: unified Pointer Events, `devicePixelRatio`, larger targets, mobile slider polish | 🔥 user-stated focus | med | med | P4 |
| 9 | **Rule-correctness fixes** surfaced by tests (foul-on-cover, game-over) | correctness | low | low | P3 |
| 10 | **Static-board offscreen layer** + hoist per-tick allocations | minor perf/elegance | low | low | P5 |
| 11 | **Client-side prediction** for acting player (predict settle → ease to authority) | removes own-shot delay | high | high | P6 (optional) |

This becomes the phase plan in [prd.md](prd.md). Each phase ends with locally-runnable, measurable milestones and a
strawman gap-review.

---

## Part E — Non-goals, constraints, and risks

**Non-goals (explicitly out of scope):** no visual/UI redesign (user directive); no 4-player mode; no AI opponent; no
database/accounts/leaderboard; no Phaser; no tournament-accurate scoring rewrite; no server-side lag compensation; no
binary serialization; no Redis (until one instance is genuinely CPU-bound).

**Constraints:** keep the server-authoritative model; keep physics in a pure module; preserve the existing look and
controls; everything must be testable locally without cloud deploys; the user deploys to Cloud Run themselves.

**Risks & mitigations:**
- _Interpolation changes how motion looks_ → keep the existing draw code; only change _when/where_ positions come
  from; add a feature flag and validate against recorded snapshots.
- _Determinism for prediction is hard across engines_ → gate prediction as the last, optional phase; rely on
  interpolation for the guaranteed win.
- _Single-instance is a SPOF_ → CSR + grace period + a warm min-instance; acceptable for friends-scale.
- _Refactors risk regressions_ → land the test harness (P1) before the big cleanups (P4); every phase re-runs all
  milestones.

---

## Appendix — Sources

**Netcode**: Gambetta —
[Architecture](https://www.gabrielgambetta.com/client-server-game-architecture.html),
[Prediction & Reconciliation](https://www.gabrielgambetta.com/client-side-prediction-server-reconciliation.html),
[Entity Interpolation](https://www.gabrielgambetta.com/entity-interpolation.html),
[Lag Compensation](https://www.gabrielgambetta.com/lag-compensation.html);
Valve [Source Multiplayer Networking](https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking);
Fiedler [Fix Your Timestep!](https://gafferongames.com/post/fix_your_timestep/),
[Snapshot Interpolation](https://gafferongames.com/post/snapshot_interpolation/).
**Socket.IO**: [multiple nodes](https://socket.io/docs/v4/using-multiple-nodes/),
[adapter](https://socket.io/docs/v4/adapter/), [redis-streams-adapter](https://socket.io/docs/v4/redis-streams-adapter/),
[connection state recovery](https://socket.io/docs/v4/connection-state-recovery),
[server options](https://socket.io/docs/v4/server-options/), [how it works](https://socket.io/docs/v4/how-it-works/),
[performance tuning](https://socket.io/docs/v4/performance-tuning/),
[discussion #4687](https://github.com/socketio/socket.io/discussions/4687).
**Google Cloud**: [Cloud Run WebSockets](https://docs.cloud.google.com/run/docs/triggering/websockets),
[session affinity](https://docs.cloud.google.com/run/docs/configuring/session-affinity),
[min instances](https://docs.cloud.google.com/run/docs/configuring/min-instances),
[always-on CPU](https://cloud.google.com/blog/topics/developers-practitioners/use-cloud-run-always-cpu-allocation-background-work),
[App Engine flexible WebSockets](https://docs.cloud.google.com/appengine/docs/flexible/using-websockets-and-session-affinity),
[App Engine standard WS thread](https://groups.google.com/g/google-appengine/c/cDR1Ru2ak88).
**Carrom rules**: [Masters of Games](https://www.mastersofgames.com/rules/carrom-rules.htm),
[Indian Carrom Federation](https://www.indiancarrom.co.in/laws-of-carrom/).
**Measurements**: instrumented from this repo's `server/physics.js` (compute/payload), June 2026.
