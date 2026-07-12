# PRD — Gameplay rules, input model, identity, and hosting

**Date:** 2026-07-12
**Repo:** `hvrc/carrom` · **Live:** https://carrom-client-23xhui47pq-uc.a.run.app (Cloud Run, project `carrom-2222`)
**Status:** All questions answered (§7). Ready to implement — nothing in here is built yet. Sequencing in §5.

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

**Decision (Q1).** Move identity to `localStorage` so it is stable per browser profile; enforce *one client → at most one room*; and make a second tab with the same identity **take over** the existing seat (a reconnect) rather than being offered a new one.

No testing escape hatch is needed: **a normal Chrome window and an incognito window keep separate `localStorage`**, so they remain two distinct players. (Incognito is a separate storage partition, not a shared one — this is a guarantee of the storage spec, not an accident.) Chrome + Safari likewise. What stops working is *two tabs in the same profile*, which is exactly the case that produced the bug.

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

- **Place mode.** Click/drag the striker — *or anywhere on the board* — to move it along your baseline. **The whole board is a scrub bar** (Q13): pressing down anywhere snaps the striker straight to that X, clamped to the legal baseline span (`SLIDER_MIN_X`..`SLIDER_MAX_X`), and it then tracks the pointer. No relative-grab offset. Dragging **outside the board no longer does anything** (today the drag is captured globally).
- **Arming flick.** Click the `FLICK` button, **or double-click anywhere on the board — desktop only**. On touch, **only the FLICK button arms** (Q14): a double-*tap* is too easy to trigger by accident while scrubbing the striker into place. `FLICK` goes black, `PLACE` goes grey.
- **Flick mode.** Drag to pull the slingshot line (today's behaviour); release to flick.
- The existing invisible range-slider is removed; placement becomes a normal pointer drag.
- It is not your turn → both buttons are grey and inert.

The relayed placement preview (`strikerSliderUpdate`) must keep working — the opponent still sees the striker move as you place it. It should now carry an X position rather than a slider percentage.

**Acceptance:** a press anywhere on the board snaps the striker to that X and never lets it leave the baseline; a drag that starts outside the board does nothing; the FLICK button arms on every device and double-click arms on desktop only; flicking still emits exactly `{ strikerX, angle, force }`.

### F2 — Cancelling a flick

Once you are dragging the slingshot, you need a way out.

- **Desktop:** `Escape` **or right-click** while dragging cancels the line and returns to **place mode**. Escape does nothing in place mode. (Right-click must `preventDefault` so the context menu never appears over the board.)
- **Touch:** while one finger drags, a **second finger tapping anywhere on the board (or the PLACE button)** cancels the drag and returns to place mode.
- **A drag shorter than the 5 px dead zone is a cancel, not a zero-force flick.** So lifting the finger without really dragging simply does nothing and leaves you in place mode.
- Cancelling emits `aimUpdate { active: false }` so the opponent's ghost line disappears too.
- Cancelling must never emit a `flick`.

**Acceptance:** a cancelled drag produces no `flick` event, restores place mode, and clears the aim line on both screens; a sub-dead-zone drag is treated identically to a cancel; right-click never opens a context menu on the board.

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

**Each player sees their own pile on the ledge nearest them** (Q5) — and this falls out for free. Piles are stored per player in the shared 900-space (creator's ledge = the bottom band, joiner's = the top band), and the canvas is already rotated 180° for the joiner. So the joiner's own pile renders at the bottom *of their screen* and the creator's at the top, with no per-viewer special-casing. Both piles are always visible; each player's own is simply the near one.

- Coins stay there for the rest of the game (they are the pile a striker foul refunds from — §3.3, teleport 3).
- The queen sits in the same row (it is just a coin now — F8), and leaves the ledge again if it has to return to the centre uncovered.
- Overflow: 9 coins + queen at radius 15 fit comfortably along a 750 px edge.

**Acceptance:** each pocket lands a coin on the pocketer's ledge, in pocket order, left to right; each player sees their own pile nearest them; both clients agree on the arrangement.

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

`state.scores[actor] += 5` → `+= 1`. **Covering keeps today's meaning** (Q6): pocket the queen, then pocket one of your own coins — on the same turn, or on the next one (the existing `pocketed_uncovered` cover-turn FSM). An uncovered queen returns to the centre.

### F9 — The last coin needs the queen covered

If a player pockets their **final** coin while the queen is **not covered**, the coin is **not** pocketed: it returns to the centre (animated, F6) and **no point is scored**. The game does not end. They must pocket and cover the queen to finish.

The queen counts as covered **whoever covered it** (Q6) — so if your opponent covered the queen earlier, you may still finish by clearing your colour, and you win.

**Acceptance:** clearing your colour with the queen uncovered returns the coin to the centre, scores nothing, and does not end the game; with the queen covered by *either* player, it ends the game and the finisher wins.

### F10 — Score can go negative

Today the score floors at 0 (`Math.max(0, ...)`) and a foul with an empty pile becomes an invisible `debt` ([rules.js](../server/sim/rules.js)).

- A foul with an empty pile now takes the displayed score to **−1**, and a further one to **−2**, and so on (Q7) — there is no floor.
- **A foul costs exactly one point, never two** (Q11). The negative score *is* the debt made visible: one foul = −1, whether that lands at 3 → 2 or at 0 → −1. Concretely, remove the `Math.max(0, ...)` floor **and** remove the "settle outstanding debt against current score" block that currently deducts a second time when the player next scores.
- `debt` survives in the state (Q7) purely as the count of **coins owed back to the board** — the pieces a fouling player must give up from their ledge. It no longer touches the score.

**Acceptance:** a player at 0 who fouls with an empty pile shows −1, not −2; scoring a coin afterwards takes them to 0, not back to −1; a player at 3 who fouls shows 2 and surrenders a coin from the ledge.

### F11 — Games-won counter

A bold **wins** count next to the player's name. Format is `NAME <wins> <score>` (Q2) — wins first, bold; score second. Hidden entirely while zero, so a first game reads `PLAYER1 0  PLAYER2 0` and after one win becomes `PLAYER1 1 0  PLAYER2 0 0`.

Wins are **per-room and in-memory** (Q8): they are kept on the room object and vanish when the room closes or the server restarts. No persistence layer.

**When a game ends, the game just resets** (Q12): the server increments the winner's win count and re-deals — the existing `gameReset` path, which today is never called on a win. Scores, piles, ledges, queen state and claimed colours all reset for the new rack; only the win counts carry over. Both clients must adopt the fresh `gameInit` (they already do). Give the result a beat on screen before the re-deal so the winner is actually seen, rather than the board blinking straight into a new rack.

**Acceptance:** clearing your colour with the queen covered increments your wins, and the board re-deals into a fresh game with scores at 0 and wins preserved; the wins number stays hidden until someone has at least one.

### F12 — One human, one seat

Per §3.2, and blocked on Q1.

Whatever we pick must hold for: a second tab, a refresh mid-game, a browser restart, and two genuinely different people on the same network.

**Acceptance:** the reproduction in §3.2 (`harsh vs harsh`) becomes impossible; a client cannot be in two rooms; a refresh still reconnects into the same seat and the same game.

### F13 — Menu polish

- A plain `ROOMS` label above the room list.
- `JOIN ROOM` and `CREATE ROOM` are **greyed out and unclickable** until their inputs are valid — join needs a username *and* a room name; create needs a username (the room name is optional and generated when blank).

### F14 — Hosting

**Retire App Engine** (Q10, approved): disable the App Engine app in `carrom-2222` and delete its `backend` service — which is what stops the always-on `min_instances: 1` billing. The appspot URL stops serving. Delete the now-dead `client/app.yaml` and `server/app.yaml` from the repo, and drop the "App Engine fallback" section of `DEPLOY.md`.

**Map `carrom.hvrc.place` → `carrom-client`** (Q9): **client only** for now; the server stays on its run.app URL, since only the client ever talks to it. DNS is at **Squarespace** (which is where Google Domains registrations ended up), so the flow is: verify domain ownership, `gcloud run domain-mappings create --service carrom-client --domain carrom.hvrc.place`, then add the CNAME it prints (→ `ghs.googlehosted.com`) in the Squarespace DNS panel. Google issues and renews the TLS certificate; WebSockets are unaffected.

Then `CORS_ORIGINS` on `carrom-server` must include `https://carrom.hvrc.place`, and **`deploy.sh` has to learn the custom domain** — otherwise its CORS step resets the allowed origins to the run.app URL on the next deploy and the custom domain silently breaks. That is a real trap: the verification step in `deploy.sh` would still pass, because it only checks that the *run.app* client origin is present.

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

## 7. Decisions (answered 2026-07-12)

| Q | Decision |
|---|---|
| Q1 Identity | One identity per browser profile (`localStorage`), one seat per client, second tab **takes over** the seat. No test escape hatch needed — Chrome-normal vs incognito (or Chrome vs Safari) remain separate identities. |
| Q2 Score display | `NAME <wins, bold> <score>` — wins first. |
| Q3 Desktop cancel | `Escape` **and** right-click cancel a flick. Escape does nothing in place mode. |
| Q4 Touch cancel | Second-finger tap cancels. A drag under the 5 px dead zone is also a **cancel**, never a zero-force flick. |
| Q5 Ledge | Each player's pile sits on the ledge nearest them. Falls out of the existing 180° board rotation for free. |
| Q6 Queen | Covering = pocket the queen, then pocket one of your own coins (same or next turn). For the endgame the queen counts as covered **whoever covered it**. |
| Q7 Negative score | No floor: −1, −2, and beyond. Internal `debt` stays for now — but see Q11. |
| Q8 Wins | Per-room, in-memory. Lost when the room closes. No persistence. |
| Q9 Domain | DNS is at **Squarespace**. Map the **client only**; the server stays on run.app. |
| Q10 App Engine | Approved: disable the app, delete the `backend` service. |

## 8. Follow-up decisions (answered 2026-07-12)

| Q | Decision |
|---|---|
| Q11 Double punishment | **A foul costs one point, never two.** The negative score *is* the debt made visible. Drop the score floor *and* drop the "settle debt against score" deduction. `debt` remains only as the count of coins owed back to the board. |
| Q12 End of game | **Just reset.** On a win, increment the winner's count and re-deal (the existing `gameReset` path). Only win counts carry over. Hold the result on screen briefly first. |
| Q13 Placing | **The whole board is a scrub bar.** Pressing anywhere snaps the striker to that X (clamped to the baseline) and tracks the pointer. No relative-grab offset. |
| Q14 Arming on touch | **FLICK button only on touch.** Double-click arms on desktop; a double-tap is too easy to trigger while scrubbing the striker. |

## 9. Definition of done

- Every acceptance criterion in §4 met, with tests for the rule changes (F7–F11) and the two bug fixes (F4, F12).
- `./run-tests.sh` green; `deploy.sh` verification green against the live services.
- The §3.2 reproduction (`harsh vs harsh`) is impossible, and one client cannot hold two seats.
- No piece jumps discontinuously in normal play (F6).
- The appspot deployment no longer serves, and `carrom.hvrc.place` does (F14).
