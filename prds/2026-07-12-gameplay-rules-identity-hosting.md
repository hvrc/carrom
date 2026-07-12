# PRD — Gameplay rules, input model, identity, and hosting

**Date:** 2026-07-12
**Repo:** `hvrc/carrom` · **Live:** https://carrom-client-23xhui47pq-uc.a.run.app (Cloud Run, project `carrom-2222`)
**Status:** Draft — blocked on the open questions in §7. Nothing in here is implemented yet.

---

## 1. Summary

Fourteen changes across four areas:

| # | Area | Item | Depends on |
|---|---|---|---|
| F1 | Input | PLACE / FLICK mode buttons, drag-to-place, double-click to arm | — |
| F2 | Input | Cancel an in-progress flick (Escape on desktop, second finger on touch) | F1 |
| F3 | Input | Striker cannot be flicked while overlapping a coin (greyed out) | F1 |
| F4 | Render | **Fix the premature pocket animation** (root cause found, §3.1) | — |
| F5 | Render | Pocketed coins rest on the wooden ledge, left → right | — |
| F6 | Render | Animate every teleport (coin → ledge, striker → opponent, respawns) | F5 |
| F7 | Rules | Colours are claimed by first pocket, not assigned by seat | — |
| F8 | Rules | Queen is worth 1 point, not 5 | — |
| F9 | Rules | Last coin is refused (returned to centre) if the queen is uncovered | F8 |
| F10 | Rules | Score displays −1 when a foul is owed with nothing to pay it | — |
| F11 | Rules | Games-won counter, bold, next to the name; hidden at zero | F9 |
| F12 | Identity | **Stop one person occupying both seats** (bug reproduced, §3.2) | — |
| F13 | Menu | `ROOMS` label; JOIN/CREATE greyed out until inputs are valid | — |
| F14 | Hosting | Retire the appspot deployment; map `carrom.hvrc.place` | — |

F4 and F12 are bug fixes with confirmed root causes. The rest are new behaviour.

---

## 2. Current state (what exists today)

- **Server is authoritative.** The client sends only `{ strikerX, angle, force }`; the server simulates and streams `physicsFrame` deltas, `pocketEvent`s, and a final `turnResolved`.
- **The client renders 100 ms in the past** (`INTERP_DELAY`, [interpolate.js:11](../client/scripts/interpolate.js#L11)) and lerps between timestamped snapshots. This is what makes motion smooth, and it is central to the F4 bug.
- **Striker placement** is an invisible `<input type="range">` overlaid below the board ([Board.css](../client/scripts/Board.css)); flicking is a pointer drag anywhere on the canvas.
- **Colours are assigned by seat**: `colorForRole()` hardcodes creator = white, joiner = black ([rules.js:7](../server/sim/rules.js#L7)).
- **The queen is worth 5** ([rules.js:50](../server/sim/rules.js#L50)) and uses a three-state FSM (`on_board` → `pocketed_uncovered` → `covered`).
- **Identity is per browser tab** — `clientId` lives in `sessionStorage` ([socket.js](../client/scripts/socket.js)).
- **Geometry**: 900×900 canvas, 750×750 board inset at (75, 75). That 75 px band around the board **is** the wooden frame — F5's ledge lives there. Coin radius 15, striker radius 21, pocket radius 22.5.

---

## 3. Investigation findings

### 3.1 Why the pocket animation fires early (F4)

**This is a client scheduling bug, not a physics or detection bug.** Three facts:

1. **Detection is conservative, not premature.** `isInsidePocket` requires the piece's centre to be within `POCKET_RADIUS - radius/2` of the pocket centre ([geometry.js](../server/sim/geometry.js)) — for a coin that is 15 px from the pocket's centre, i.e. the coin is already well inside. The server is *not* firing early.
2. **`pocketEvent` carries no timestamp.** Frames do: `onFrame(buildBroadcastFrame(state, lastSent, tick * TICK_MS))` ([step.js:105](../server/sim/step.js#L105)). But the pocket event is emitted bare — `{ kind, id, color, pocket, from }` ([step.js:100](../server/sim/step.js#L100) → [socketHandlers.js:176](../server/socketHandlers.js#L176)).
3. **The client starts the tween the instant the event lands**, using `performance.now()` ([useGameSync.js](../client/scripts/hooks/useGameSync.js), `handlePocketEvent`).

Put together: at the moment the event arrives, the coin *being drawn* is still ~100 ms of simulation behind (`INTERP_DELAY`), plus network latency, plus up to one broadcast interval. So the tween begins while the rendered coin is still short of the pocket — it starts shrinking and sliding from wherever it happens to be drawn. That is exactly the reported "the coin starts disappearing before it reaches the pocket".

It is made worse by the second half of `handlePocketEvent`: the coin is moved out of `coinsRef` (the live, interpolated set) into `pocketingCoinsRef`. From that moment it is **no longer interpolated**, so it freezes at its lagged position and then eases to the pocket from there. The coin never actually travels the last stretch of its real path.

And because the error is proportional to each client's latency, **the two players see it differently** — which is why the fix has to be scheduled on simulation time, not wall-clock.

**Fix.** Stamp `pocketEvent` with the simulation time it happened at (`tick * TICK_MS` — the clock already exists and frames already use it). On the client, hold arriving pocket events in a pending queue and start the tween only when the interpolated `renderTime` reaches that timestamp; keep the coin in the interpolated live set until then. This is the same producer/consumer discipline `physicsFrame` already follows — `pocketEvent` is simply the one event that skipped it. It makes the drop start at the same simulated instant on both clients, at any latency.

Once scheduled correctly, the coin will *reach* the pocket before shrinking, which is the requested behaviour. The tween itself (250 ms, ease-in, shrink to zero) needs no change beyond F6.

### 3.2 How one person occupied both seats (F12)

**Reproduced locally.** Driving the real server:

```
S1  same clientId rejoins the room it created  ->  "Client already in room"   (correctly blocked)
S2  NEW TAB (fresh clientId), same username    ->  JOINED as second player
    room now: harsh vs harsh                                    <-- the reported bug
S3  one clientId creates a second room         ->  IN TWO ROOMS
```

Two distinct holes:

- **Identity is per-tab.** `clientId` is generated into **`sessionStorage`**, which is scoped to a single tab. Open the room in another tab (or restore/duplicate the tab) and the browser mints a *brand-new* `clientId`. The server has no way to know it is the same human, and usernames are never checked for uniqueness — so the second tab is admitted as the opponent. The existing `"Client already in room"` guard only catches the *same tab* rejoining the *same room*.
- **A client can occupy several rooms at once.** Neither `createRoom` nor `joinRoom` checks whether the client is already seated somewhere ([socketHandlers.js:61,70](../server/socketHandlers.js#L61)), yet `findRoomByClientId` — which drives reconnect — assumes at most one and returns the *first* match. So a client in two rooms reconnects into an arbitrary one.

**Direction (needs Q1 answered).** Move identity to `localStorage` so it is stable per browser profile; enforce *one client → at most one room*; and make a second tab with the same identity **take over** the existing seat (a reconnect) rather than being offered a new one. The cost is that two tabs in one browser can no longer play each other, which is presumably how you have been testing — see Q1 for the escape hatch.

### 3.3 Every "teleport" in the game (F6)

Found in [rules.js](../server/sim/rules.js) and [state.js](../server/sim/state.js):

| # | Teleport | Today | Wanted |
|---|---|---|---|
| 1 | Coin pocketed | vanishes from the board | travels to the pocketer's ledge (F5) |
| 2 | Striker after every turn | jumps to `CENTER_X` at the next player's baseline | glides to the opponent's baseline |
| 3 | Striker foul refund | `pile.pop()` → `respawnAtCenter` | coin glides **from the ledge** back to the centre |
| 4 | Queen not covered / foul | `respawnAtCenter(state, "red", 19)` | glides from pocket/ledge back to the centre |
| 5 | Last coin refused (new, F9) | — | glides back to the centre |
| 6 | `gameInit` / `turnResolved` snapshot adoption | positions snap | usually invisible; leave as a snap |
| 7 | Opponent's slider preview | striker jumps as `strikerSliderUpdate` relays | smooth (nice-to-have, low priority) |

All of 1–5 should share **one** animation primitive: a server-declared move (`from`, `to`, `duration`, `what`) that both clients tween identically. Doing it per-case invites the same drift that caused F4. The server must remain the source of truth for the *end* state; the tween is presentation only.

### 3.4 Hosting — why `carrom-2222.el.r.appspot.com` still exists (F14)

Because App Engine and Cloud Run are different products in the same project. The App Engine app in `carrom-2222` still has **SERVING** versions (13 on `default`, 12 on `backend`) from the pre-June deployments, and nothing has told it to stop. It is serving the **April build** of the game, and its `backend` runs with `min_instances: 1`, so it is billing you for an always-on instance to serve a version nobody should be using.

**It can be retired, but not literally deleted.** GCP does not let you delete the `default` App Engine service, and the App Engine *application* itself cannot be removed without deleting the whole project (which we do not want — Cloud Run lives there). The realistic options, in order of thoroughness:

1. **Disable the application** (`servingStatus: USER_DISABLED`, via Console → App Engine → Settings, or the Admin API). The appspot URL stops serving entirely. Cleanest.
2. **Delete the `backend` service** (non-default services *can* be deleted — this kills the always-on billing) and **stop/delete all `default` versions**, leaving the URL serving nothing.

Either way the appspot hostname keeps *existing* as a name; it just stops responding. I recommend (1) plus deleting `backend`, and removing the now-misleading `client/app.yaml` and `server/app.yaml` from the repo.

### 3.5 Domain — `carrom.hvrc.place` (F14)

Feasible. `carrom.hvrc.place` does not resolve today. `hvrc.place` is on **Google Cloud DNS nameservers** (`ns-cloud-e{1..4}.googledomains.com`) and its apex currently points at `216.239.3x.21`.

Two ways to attach it to the Cloud Run client:

- **Cloud Run domain mapping** — free, simple: verify the domain, `gcloud run domain-mappings create --service carrom-client --domain carrom.hvrc.place`, then add the CNAME it prints (to `ghs.googlehosted.com`). Google manages the TLS cert. This is the recommended path for a single subdomain.
- **External HTTPS load balancer + serverless NEG** — more control (and the standard path if you later want a CDN or multiple backends), but it costs roughly $18/month for the forwarding rule alone. Overkill here.

Both terminate TLS at Google's frontend and support WebSockets, so the game keeps working. **Blocker:** I could not find the Cloud DNS managed zone for `hvrc.place` in any of your 12 projects (the DNS API is disabled on `hvrc-web`, and `tripsit-10082022` is suspended), so I don't know where to add the record — see Q9.

If we do this, `CORS_ORIGINS` on `carrom-server` must gain `https://carrom.hvrc.place`, and `deploy.sh` should learn the custom domain so it stops resetting CORS to run.app-only on the next deploy. (Optionally the server gets `api.carrom.hvrc.place` too — Q9.)

---

## 4. Feature specs

### F1 — PLACE / FLICK modes

Two word-buttons: **PLACE** and **FLICK**. On your turn the game starts in **place mode**: `PLACE` is black (active), `FLICK` is grey.

- **Place mode.** Click/drag the striker — *or anywhere on the board* — to move it along your baseline. The striker follows the pointer's X, clamped to the legal baseline span (`SLIDER_MIN_X`..`SLIDER_MAX_X`). Dragging **outside the board no longer does anything** (today the drag is captured globally).
- **Arming flick.** Click `FLICK`, **or double-click anywhere on the board**. `FLICK` goes black, `PLACE` goes grey.
- **Flick mode.** Drag to pull the slingshot line (today's behaviour); release to flick.
- The existing invisible range-slider is removed; placement becomes a normal pointer drag.
- It is not your turn → both buttons are grey and inert.

The relayed placement preview (`strikerSliderUpdate`) must keep working — the opponent still sees the striker move as you place it. It should now carry an X position rather than a slider percentage.

**Acceptance:** place mode moves the striker on drag and never lets it leave the baseline; a drag that starts outside the board does nothing; double-click and the FLICK button both arm flick mode; flicking still emits exactly `{ strikerX, angle, force }`.

### F2 — Cancelling a flick

Once you are dragging the slingshot, you need a way out.

- **Desktop:** `Escape` while dragging cancels the line and returns to **place mode**.
- **Touch:** while one finger drags, a **second finger tapping anywhere on the board (or the PLACE button)** cancels the drag and returns to place mode. (This is what pointer capture + a second `pointerdown` gives us; the mechanism is sound — the open edge cases are in Q3/Q4.)
- Cancelling emits `aimUpdate { active: false }` so the opponent's ghost line disappears too.
- Cancelling must never emit a `flick`.

**Acceptance:** a cancelled drag produces no `flick` event, restores place mode, and clears the aim line on both screens.

### F3 — No flicking from an overlapping striker

While placing, if the striker overlaps any live coin, it renders **greyed out** and the flick cannot be armed or fired.

- Overlap = `distance(striker, coin) < STRIKER_RADIUS + COIN_RADIUS`.
- **Enforce on the server too.** Today the server only clamps `strikerX`; it would happily simulate a flick from an illegal, overlapping position. Reject such a flick with an error rather than trusting the client.

**Acceptance:** the striker is visibly grey and unflickable while overlapping; a hand-crafted overlapping `flick` is rejected server-side.

### F4 — Fix the pocket animation

As diagnosed in §3.1.

- Add the simulation timestamp to `pocketEvent`.
- Client queues pocket events and starts each tween when `renderTime` reaches its timestamp; the piece stays in the interpolated set until then, so it visibly *reaches* the pocket first.
- Applies identically to coins and the striker.

**Acceptance:** at 0 ms, 100 ms and 300 ms of simulated latency, the piece crosses the pocket boundary *before* the shrink begins, and both clients begin the tween at the same simulated instant. Regression test: a pocket event that arrives early must not mutate the render set before its due time.

### F5 — Pocketed coins rest on the ledge

The 75 px wooden frame around the board is the ledge. When a coin is pocketed it comes to rest on the ledge **of the player who pocketed it**, laid out **left → right** with even spacing.

- Coins stay there for the rest of the game (they are the pile a striker foul refunds from — §3.3, teleport 3).
- The queen sits in the same row (it is just a coin now — F8).
- Overflow: 9 coins + queen at radius 15 fit comfortably along a 750 px edge.

**Acceptance:** each pocket lands a coin on the correct player's ledge, in pocket order, left to right; both clients agree on the arrangement.

### F6 — Animate the teleports

Introduce one shared "piece moves from A to B" animation and use it for every case in §3.3 (coin → ledge, striker → opponent's baseline, refund ledge → centre, queen → centre, refused last coin → centre).

- The server declares the move (what, from, to, when, duration); clients tween it. No client-side invention of destinations, or the two screens will drift.
- Input stays locked until the animation settles.

**Acceptance:** no piece ever jumps discontinuously during normal play; both clients show the same motion; the authoritative end state is unchanged.

### F7 — Colours are claimed, not assigned

Remove `colorForRole()`. Colours are unowned at the start.

- The **first player to pocket a coin claims that colour**; the opponent gets the other.
- If a player's first pocket is the **queen**, no colour is claimed by it; they may cover with *any* coin, and **that coin's colour becomes theirs**.
- Until a colour is claimed, "pocketed your own colour" (which drives continued turns and scoring) resolves against the claim made *this* turn.

**Acceptance:** the first coin pocketed sets the pocketer's colour; the opponent is bound to the other colour; a queen-first pocket defers the claim to the covering coin.

### F8 — Queen is worth 1

`state.scores[actor] += 5` → `+= 1`. Covering is still required (Q6 confirms the semantics).

### F9 — The last coin needs the queen covered

If a player pockets their **final** coin while the queen is **not covered**, the coin is **not** pocketed: it returns to the centre (animated, F6) and **no point is scored**. The game does not end. They must pocket and cover the queen to finish.

Once the queen is covered (by *either* player — Q6), clearing your colour ends the game and you win.

**Acceptance:** clearing your colour with the queen uncovered returns the coin to the centre and does not score or end the game; with the queen covered, it ends the game.

### F10 — Score can show −1

Today the score floors at 0 and a foul with an empty pile becomes an invisible `debt` ([rules.js](../server/sim/rules.js)). A player who fouls with nothing to give should **display −1**.

Needs Q7: whether −1 is a floor or the score keeps descending, and whether `debt` survives as a separate concept.

### F11 — Games-won counter

A bold number next to the player's name, showing games won in this room. Hidden while zero, so a first game reads `PLAYER1 0  PLAYER2 0` and after one win becomes `PLAYER1 1 0  PLAYER2 0 0`.

Needs Q2 (which number is which) and Q8 (how long wins persist).

### F12 — One human, one seat

Per §3.2, and blocked on Q1.

Whatever we pick must hold for: a second tab, a refresh mid-game, a browser restart, and two genuinely different people on the same network.

**Acceptance:** the reproduction in §3.2 (`harsh vs harsh`) becomes impossible; a client cannot be in two rooms; a refresh still reconnects into the same seat and the same game.

### F13 — Menu polish

- A plain `ROOMS` label above the room list.
- `JOIN ROOM` and `CREATE ROOM` are **greyed out and unclickable** until their inputs are valid — join needs a username *and* a room name; create needs a username (the room name is optional and generated when blank).

### F14 — Hosting

Per §3.4 and §3.5: retire App Engine, map `carrom.hvrc.place` to `carrom-client`, add the new origin to `CORS_ORIGINS`, teach `deploy.sh` about the custom domain, and delete the dead `app.yaml` files.

---

## 5. Sequencing

1. **F4** (pocket animation) — a bug on the live game, and F5/F6 build directly on its scheduling model.
2. **F12** (identity) — the other live bug; cheap to fix, and it distorts every play-test until it is fixed.
3. **F1 → F3 → F2** (input model) — F2's cancel semantics only make sense once modes exist.
4. **F7 → F8 → F9 → F10 → F11** (rules) — one coherent pass over `rules.js`, in dependency order.
5. **F5**, then **F6** — explicitly in this order, as requested: the ledge is where most teleports now *land*, so it must exist before we animate travel to it.
6. **F13**, **F14** — independent; can land any time.

---

## 6. Risks

- **F6 is the riskiest.** Animating server-declared moves means the client is briefly showing a piece that the authoritative state has already relocated. If a reconnect or a `turnResolved` snapshot lands mid-animation, the piece must snap to truth rather than fight it. Design the tween as *presentation over an already-settled state*, never as a source of position.
- **F1 removes the range-slider**, which is also the mechanism for the opponent's placement preview. Both paths must be re-pointed at the new drag input or the preview silently dies.
- **F7 + F9 + F11 together rewrite `resolveTurn`**, the most rule-dense function in the codebase, currently guarded by 35 server tests. Expect to rewrite a chunk of those tests, and treat any test you have to *delete* as a red flag.
- **F12 will change how you test.** See Q1.

---

## 7. Open questions

**Q1 — Identity.** How should the same browser be treated?
  (a) *Recommended:* one identity per browser profile (`localStorage`), a client may hold at most one seat, and a second tab **takes over** the existing seat. Clean, matches how players think — but you can no longer play yourself across two tabs.
  (b) Same as (a), plus an explicit escape hatch for testing (e.g. `?seat=2` in the URL mints a separate identity).
  (c) Keep per-tab identity and just reject a duplicate *username* within a room. Weakest — two tabs with different names still let one person hold both seats.
  Which? (If you test two-tabs-in-one-browser regularly, say so and I will spec (b).)

**Q2 — Score display.** You wrote `PLAYER1 1 0`. Which number is which — is it `NAME <wins, bold> <score>`, or `NAME <score> <wins, bold>`?

**Q3 — Desktop cancel.** Escape only, or should right-click also cancel? And should Escape do anything in *place* mode (nothing? deselect?).

**Q4 — Touch cancel.** Confirm: while finger 1 drags the slingshot, a tap from finger 2 anywhere on the board (or on PLACE) cancels. What should happen if the player instead just **lifts finger 1 without moving** (a zero-length drag)? Fire a zero-force flick (bad), or treat it as a cancel? I would treat any drag under the dead-zone (5 px) as a cancel.

**Q5 — Ledge orientation.** Each player has a ledge. Do you want **each viewer to see their own coins on the ledge nearest them** (i.e. mirrored per client, so "my pile is always at the bottom"), or an **absolute** arrangement where creator = bottom and joiner = top for everyone? The board already rotates 180° for the joiner, which makes the mirrored reading the natural one.

**Q6 — Queen.** (i) Does covering still work as it does today — pocket the queen, then pocket one of your own coins on the same *or* the next turn? (ii) For the endgame rule, the queen must be *covered* — by **anyone**, or by the player who is finishing? Your example ("user 1 covered the queen, user 2 clears their coins → user 2 wins") implies **anyone**; confirm.

**Q7 — Negative score.** A foul with an empty pile shows −1. Does a *second* such foul take it to −2, or does it floor at −1? And should the internal `debt` concept disappear entirely, folded into a signed score?

**Q8 — Wins counter.** Wins are per-room and in-memory, so they vanish when the room closes (both players leave / server restarts). Acceptable, or do you want them to survive a room closing — which means real persistence (Redis or a DB) and a durable player identity?

**Q9 — DNS.** Where is `hvrc.place`'s DNS actually managed? It is on Cloud DNS nameservers, but I could not find the managed zone in any of your projects. Also: do you want the **server** on a subdomain too (`api.carrom.hvrc.place`), or is leaving it on the run.app URL fine (it is only ever spoken to by the client)?

**Q10 — App Engine.** Confirm I may **disable the App Engine app** in `carrom-2222` and delete its `backend` service. The appspot URL stops serving (it cannot be truly deleted without deleting the project). The old April build there is superseded and nothing links to it.
