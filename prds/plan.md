# Carrom Multiplayer — Development Plan

## Decisions & Ground Rules

| Topic | Decision |
|---|---|
| Physics authority | **Server-authoritative** — client sends flick input, server runs physics, streams animation frames |
| Sync model | **Frame streaming** — server broadcasts ~30–60 fps frames during a flick so both clients see the same animation |
| Client preview | **None** — pure server-render, accept latency. Add optimism later only if needed |
| Flick payload | **`{ strikerX, angle, force }`** — server validates striker placement, computes velocity, simulates |
| Anti-cheat | **Trust clients** — friends-only game, no turn-ownership validation needed |
| Queen rules | **Standard** — pocket queen, then must cover (pocket another coin same/next turn) or queen returns |
| Debt model | **Auto-settle** — server settles debts automatically at end of each turn during scoring; no separate `payDebt` event |
| Player count | **2-player only** — polish before expanding |
| Rendering | **Raw Canvas2D** — Phaser already removed |
| Mobile | **Nice to have** — desktop first |
| Persistence | **In-memory** — no database |

---

## Phase 0 — Critical Bug Fixes
> Status verified by codebase audit.

- [x] Fix typo: `room.debs` → `room.debts` in [server/index.js](server/index.js) `payDebt` handler — verified
- [x] Re-enable all server-side room validation (`if (!rooms.has(roomName))`) — all 18+ blocks active
- [x] Remove `coinsMove` socket listener on server — verified absent
- [x] Remove `phaser` from [client/package.json](client/package.json) — verified absent
- [x] Remove Lorem ipsum block from [Board.jsx](client/scripts/Board.jsx) style block (was being injected as CSS textContent — invalid)
- [x] Remove dead client `coinsMove` emits ([Animation.js](client/scripts/Animation.js), [Board.jsx](client/scripts/Board.jsx)) and matching `Events.handleCoinsMove` listener — server never relayed them
- [~] ~~Remove `sliderValue`, `sliderMin`, `sliderMax` from `Hand.js`~~ — **CANCELLED**: these are NOT unused. They power `sliderToX`/`xToSlider` which sync striker placement between clients ([Hand.js#L785](client/scripts/Hand.js#L785), [Board.jsx#L372](client/scripts/Board.jsx#L372), [Events.js#L469](client/scripts/Events.js#L469)). Original plan was wrong.

**Phase 0 complete.** Note: `Events.handleCoinsMove` function body still exists in [Events.js](client/scripts/Events.js) but is no longer wired up — leave for now, gets deleted with all client physics in Phase 1.

---

## Phase 1 — Server-Authoritative Physics
> **Status: complete and validated end-to-end in browser** (2 clients, full flick → frames → resolve → turn-switch loop verified). The most important architectural change. Fixes the core multiplayer sync problem.

### Problem
Both clients independently ran physics in [Animation.js](client/scripts/Animation.js) + [Physics.js](client/scripts/Physics.js). Floating-point divergence + network jitter meant coins ended up in different positions on each screen.

### Final Architecture (as shipped)

```
Client A                    Server                            Client B
--------                    ------                            --------
User flicks
→ emit "flick" { roomName, strikerX, angle, force }
                    Validate room, game-started, sim-not-running, actor-turn
                    startFlickSimulation(state, input, actor, callbacks):
                      setInterval @ 16ms (60Hz):
                        step(state)                    // CCD, friction, pocket detect
                        every 2nd tick:
                          → broadcast "physicsFrame" { coins:[{id,x,y}], striker:{x,y}|null }
                        on pocket:
                          → broadcast "pocketEvent" { id, color, pocket:{x,y} }
                        when nothing moves:
                          resolveTurn() — score, queen FSM, striker foul,
                                         debt accrue/settle, continue vs switch, win check
                          placeStrikerForNextTurn()
                          → broadcast "turnResolved" { ...resolution, state: fullState }
                          → broadcast "roomUpdate" (mirrors scores/debts/turn)
Render frames as they arrive                       Render frames as they arrive
(no local physics)                                 (no local physics)
```

### Implementation

**[server/physics.js](server/physics.js)** (~500 lines, ESM, pure module — no DOM, no socket, no logging):
- Geometry / coin / striker / pocket constants mirror client `Draw.js`, `Coin.js`, `Striker.js`, `Pocket.js`, `Hand.js` (`FLICK_POWER = 0.4`, `MAX_VELOCITY_FROM_FLICK = 40`).
- Exports: `createInitialState`, `startFlickSimulation`, `fullStateSnapshot`, `frameSnapshot`, `clampStrikerX`, `baselineYFor`, plus geometry constants.
- `step(state)` — one 16ms tick: CCD per object (`updateWithCCD` w/ sub-stepping by speed), friction, threshold-stop, overlap cleanup, pocket detection. Returns newly-pocketed coins.
- `resolveTurn(state, pocketedThisTurn, actor)` — full carrom rules:
  - Score by coin color (white→creator, black→joiner, red→queen FSM).
  - Queen FSM: `on_board` → `pocketed_uncovered` → `covered` (own-color same flick OR cover-turn) / back to `on_board` (failed cover or foul).
  - Striker foul: refund last coin from actor's pocketed-pile to center (or `debt += 1` if pile empty); auto-settle debt against score (`min(score, debt)` subtracted from both).
  - Continue-turn cap: `MAX_TURNS_IN_A_ROW = 3`.
  - Game-over check.
- `respawnAtCenter` jiggles outward in a spiral if center is blocked.

**[server/index.js](server/index.js)** (cut from 1223 → ~700 lines):
- Imports `createInitialState`, `fullStateSnapshot`, `startFlickSimulation` from `./physics.js`.
- Helpers: `createRoom`, `startGame` (broadcasts `gameInit`), `syncRoomFromGame`, `broadcastRoomUpdate`.
- `joinRoom` triggers `startGame` after the second player joins.
- `requestRoomData` re-sends `gameInit` if a game is in progress (reconnects).
- `flick` handler: validates `actor === room.game.whoseTurn` using **persistent `clientId` from handshake query** (NOT `socket.id` — earlier bug fixed), runs `startFlickSimulation`, wires `onFrame`/`onPocket`/`onDone` to broadcasts.
- `gameReset` re-deals.
- `strikerSliderUpdate` is relay-only (placement preview).

**Client [Hand.js](client/scripts/Hand.js)** — `_emitFlick({strikerRef, socket, roomName})`:
- `dx = startX - endX, dy = startY - endY`
- `force = min(distance / flickMaxLength, 1)`, `angle = atan2(dy, dx)`
- Emits `socket.emit("flick", {roomName, strikerX, angle, force})`.
- No local velocity assignment; no `onAnimationStart`; `handleFlickMouseUp` and `handleMouseUp` simplified.

**Client [Board.jsx](client/scripts/Board.jsx)** — pure renderer, 4 server-driven listeners:
- `gameInit` → `applyServerCoins` rebuilds `coinsRef` from snapshot, syncs striker, resets pocketed sets.
- `physicsFrame` → in-place coin position update by id, striker update (or hide if mid-flick pocketed), `isAnimating = true`, redraw.
- `pocketEvent` → filter coin from `coinsRef`, append to `pocketedThisTurnRef`.
- `turnResolved` → re-apply full state (coins, striker, scores via `roomUpdate`, turn), reset `isAnimating`, sync slider preview to server-chosen baseline.
- `strikerSliderUpdate` relay listener kept for placement preview.
- Removed: animation loop useEffect, all old `strikerMove`/`strikerAnimation`/`strikerFlicked`/`coinsPocketed`/`turnSwitched`/`turnContinued`/`debtPaid`/`queen*`/`coverTurnUpdate`/`movementStop*` listeners and the 16ms collision-check interval.

### Socket Event Contract (final, documented in [server/index.js](server/index.js#L13-L40))

Gameplay (C→S):
- `flick` — `{ roomName, strikerX, angle, force }` — `strikerX` clamped server-side; `angle` in radians; `force` ∈ [0, 1].
- `strikerSliderUpdate` — `{ roomName, playerRole, sliderValue, strikerX }` — placement preview, relayed as-is.
- `gameReset` — `{ roomName }` — re-deal request.

Gameplay (S→C):
- `gameInit` — full state snapshot (sent on join / reset / start).
- `physicsFrame` — `{ coins:[{id,x,y}], striker:{x,y}|null }` — broadcast every 2nd 16ms tick (~30Hz).
- `pocketEvent` — `{ id, color, pocket:{x,y} }` — one per pocket.
- `turnResolved` — `{ ...resolution, state: fullState }` where `resolution = { strikerPocketed, pocketedThisTurn, continuedTurn, gameOver, winner }`.
- `strikerSliderUpdate` — relayed unchanged.
- `roomUpdate` — mirrors scores/debts/turn via the existing channel for `Manager.js`.

### Bug Fixes During Validation
- **Actor mismatch**: `flick` handler was comparing `socket.id` (per-connection id) against `room.creator.clientId` (persistent UUID). Fixed to compare against the persistent `clientId` from `socket.handshake.query`. Symptom: server emitted `"Not your turn"` on every flick → client `Room.jsx` error-listener kicked the player out.
- **`frameLogCount` ReferenceError**: instrumentation `let` was scoped to the `physicsFrame` useEffect but read from the `turnResolved` useEffect. Removed the cross-effect reset. Symptom: `turnResolved` handler aborted mid-execution → striker never re-synced, `isAnimating` stuck true, both clients eventually disconnected.

### Diagnostic Logging (kept in for now)
- Server `[flick]` logs: incoming payload, resolved actor vs `whoseTurn`, every `pocketEvent`, and a `done` summary.
- Client `[flick] emit ->` in `Hand._emitFlick`.
- Client `[net]` logs in `Board.jsx` for `gameInit`, throttled `physicsFrame` (#0/#1/#2 then every 15th), `pocketEvent`, `turnResolved`.
- Client `[net] server error — leaving room:` and `[net] roomClosed:` in `Room.jsx`.

### Deferred to Phase 1.1 / Phase 2
- [x] Strip diagnostic `console.log`s once Phase 2 is also stable. *(done in Phase 2 cleanup pass)*
- [ ] Bandwidth check — frame is ~20 coin records × `{id,x,y}` + striker; never measured.
- [ ] Pocket animation (currently coin just disappears on `pocketEvent`).
- [ ] Striker visibility during mid-flick pocket (server sends `striker: null` in those frames; client hides — confirm UX is acceptable).
- [ ] Cross-player debt auto-settle: today only the *actor's* debt is settled at end of turn. If P2 has debt and P1 pockets P2's coin (P2 is the actor's opponent), P2's debt is not auto-applied to that scoring event. Confirm this is the intended rule before Phase 2.

---

## Phase 2 — Game Flow Correctness
> Server owns all rules. Client only displays.

### Status: server-side rules already shipped in Phase 1 (`server/physics.js`). Phase 2 executed as a **client cleanup pass** — client now actually *only* displays.

### Cleanup pass (executed)
- [x] Deleted dead client modules: `Physics.js`, `Animation.js`, `Player.js`.
- [x] Reduced `Coin.js` / `Striker.js` to render-only data + `draw()` (no `update`, no `handleBorderCollision`, no pocket animation methods).
- [x] Reduced `Pocket.js` to the `POCKET_DIAMETER` constant.
- [x] Reduced `Events.js` to just `handleStrikerSliderUpdate` (the only relay listener still wired).
- [x] Reduced `Manager.js` to a thin `playerData` container (no `switchTurn`, `payDebt`, `canPayDebt`, `updateScore`, `updateDebt`, `resetGame` — server is sole authority via `roomUpdate` / `turnResolved`).
- [x] Replaced `Board.jsx`'s `animationRef` + `animationState` with a plain `useState(false)` `isAnimating` flag.
- [x] Stripped Phase 1 diagnostic `[flick]` / `[net]` `console.log`s from server `flick` handler, `Hand._emitFlick`, and the four Board.jsx server-listener `useEffect`s. Kept the `[net] roomClosed` / `[net] server error` warnings in `Room.jsx`.
- [x] Validated with `vite build` (73 modules, 237 kB, no errors).

### Original Phase 2 server-rule items (already done in Phase 1)
- [x] Turn race condition fix: `movementStopConfirmed` handshake removed; turn comes from server `turnResolved.state.whoseTurn`.
- [x] Queen FSM (`on_board` → `pocketed_uncovered` → `covered` / `on_board`) lives in `server/physics.js` `resolveTurn`.
- [x] Debt auto-settle in `resolveTurn` (no `payDebt` event).
- [x] Striker foul: refund last pocketed coin to center (or accrue debt if pile empty), handled server-side.

### Still open (intentionally deferred out of Phase 2)
- [ ] **Pocket animation** — currently coin just disappears on `pocketEvent`. Server emits `pocketEvent { id, color, pocket:{x,y} }` so the client has all data to play a shrink/fade-into-pocket tween before removing the coin from `coinsRef`.
- [ ] **Cross-player debt auto-settle** — confirm intended rule before implementing.
- [ ] **`Room.jsx` GameInfoTable** still reads `isCoverTurn` / `hasPocketedQueen` / `hasCoveredQueen` from `Manager.playerData`; `Manager` no longer carries those fields and the server doesn't broadcast them, so those cells render "No" forever. If the table matters, surface queen state from `turnResolved.state.queen` instead.

---

## Phase 3 — Code Cleanup & Refactor

### Board.jsx (currently **751 lines** → target ~200)
- [ ] Extract `useGameCanvas()` — canvas setup, scaling, pocket array
- [ ] Extract `useGameSocket()` — all `socket.on` listeners (currently 40+ `useEffect`s)
- [ ] Extract `useGameInput()` — mouse + touch handlers
- [ ] Move the 170-line inline `<style>` block to a CSS file (`Board.css`)

### Naming & Clarity
- [ ] Rename `handRef` → `handManagerRef`
- [ ] Rename `animationRef` → `gameLoopRef` (or delete after Phase 1 if no longer needed)
- [ ] Rename `continuedTurnsRef` → `turnsInARowRef`

### Socket Event Audit
- [ ] After Phase 1+2, list every remaining `socket.on`/`socket.emit`
- [ ] Remove any with no corresponding sender/receiver
- [ ] Document event contract in a comment block at top of [server/index.js](server/index.js)

### Dead Code Removal
- [ ] Remove commented-out `switchTurn`/`continueTurn` blocks at end of [server/index.js](server/index.js) (~L1107–L1142)
- [ ] Delete unused `Events.handleCoinsMove` function body (left over from Phase 0)
- [ ] Remove inline debug `console.log`s
- [ ] Strip [Manager.js](client/scripts/Manager.js) and [Player.js](client/scripts/Player.js) of fields the server now owns

---

## Phase 4 — UI/UX Polish

- [ ] **Turn indicator** — highlight active player's side, not just text
- [ ] **Pocketed pile display** — show counts of pocketed white/black/queen per player
- [ ] **Score / debt / target** — current score, debt owed, max score to win
- [ ] **Game over screen** — winner, final scores, "play again" button
- [ ] **Error boundary** — catch canvas errors, show "Something went wrong — refresh"
- [ ] **Disconnect UI** — "Opponent disconnected" overlay with wait/exit options
- [ ] **Mid-game join** — if a player joins a room mid-game, show waiting screen rather than broken board

---

## Phase 5 — Mobile Support *(Nice to Have)*

- [ ] Replace invisible slider with visible arc-based power selector on mobile
- [ ] Add `touchstart`/`touchmove`/`touchend` handlers to flick mechanic
- [ ] Test iOS Safari + Android Chrome
- [ ] Lock landscape or adapt portrait layout
- [ ] Increase tap target sizes

---

## Backlog / Not Planned
- 4-player mode
- Phaser migration
- Database / persistence
- AI opponent
- Leaderboard / accounts
- Sound effects (revisit after Phase 4)
- Talc powder particle effects

---

## Open Questions / To Decide Later
- **Frame format**: send full coin array each frame, or only moving coins? Decide after measuring bandwidth in Phase 1
- **Disconnect mid-flick**: if a client drops while server is simulating, do we pause or finish the turn? (Probably: finish turn, queue `turnResolved` for reconnect)
- **Determinism**: do we need the server sim to be deterministic for replays? (Probably no for now)
