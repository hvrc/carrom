// Pure physics + carrom-rule unit tests. No external deps (node:test).
//   cd server && npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    createInitialState,
    createCoinFormation,
    simulateFlickSync,
    startFlickSimulation,
    step,
    resolveTurn,
    respawnAtCenter,
    isInsidePocket,
    clampStrikerX,
    fullStateSnapshot,
    CENTER_X,
    CENTER_Y,
    SLIDER_MIN_X,
    SLIDER_MAX_X,
    POCKETS,
    overlapsAnyCoin,
    baselineYFor,
} from "../physics.js";

// ---------- initial layout ----------

test("initial state: 19 coins = 9 white + 9 black + 1 red queen", () => {
    const s = createInitialState();
    assert.equal(s.coins.length, 19);
    const by = (c) => s.coins.filter((x) => x.color === c).length;
    assert.equal(by("white"), 9);
    assert.equal(by("black"), 9);
    assert.equal(by("red"), 1);
    // queen sits at board centre
    const queen = s.coins.find((c) => c.color === "red");
    assert.equal(queen.x, CENTER_X);
    assert.equal(queen.y, CENTER_Y);
});

test("initial state: scores/debts zero, creator to act, queen on board", () => {
    const s = createInitialState();
    assert.deepEqual(s.scores, { creator: 0, joiner: 0 });
    assert.deepEqual(s.debts, { creator: 0, joiner: 0 });
    assert.equal(s.whoseTurn, "creator");
    assert.equal(s.queenState, "on_board");
    assert.equal(s.gameOver, false);
});

test("clampStrikerX clamps to the legal baseline span", () => {
    assert.equal(clampStrikerX(-9999), SLIDER_MIN_X);
    assert.equal(clampStrikerX(9999), SLIDER_MAX_X);
    const mid = (SLIDER_MIN_X + SLIDER_MAX_X) / 2;
    assert.equal(clampStrikerX(mid), mid);
});

// ---------- simulation ----------

test("a flick moves coins and settles before the safety cap", () => {
    const s = createInitialState();
    const before = createCoinFormation().map((c) => ({ x: c.x, y: c.y }));
    const r = simulateFlickSync(s, { strikerX: CENTER_X, angle: -Math.PI / 2, force: 1 }, "creator");
    assert.ok(r.ticks < 60 * 15, "should settle before MAX_TICKS");
    // at least one coin moved from its starting position
    const moved = s.coins.some((c, i) => before[i] && (Math.abs(c.x - before[i].x) > 0.5 || Math.abs(c.y - before[i].y) > 0.5));
    assert.ok(moved, "a power shot up the middle should disturb coins");
    // final velocities are at rest
    const restingStriker = Math.hypot(s.striker.velocity.x, s.striker.velocity.y) < 0.5;
    assert.ok(restingStriker);
});

test("determinism: identical input + start ⇒ byte-identical final positions", () => {
    const a = createInitialState();
    const b = createInitialState();
    const input = { strikerX: CENTER_X + 40, angle: -Math.PI / 2 + 0.2, force: 0.9 };
    const ra = simulateFlickSync(a, input, "creator");
    const rb = simulateFlickSync(b, input, "creator");
    assert.deepEqual(ra.fullState.coins, rb.fullState.coins);
    assert.deepEqual(ra.fullState.striker, rb.fullState.striker);
    assert.equal(ra.ticks, rb.ticks);
});

test("a gentle, non-scoring shot passes the turn to the opponent", () => {
    const s = createInitialState();
    // soft sideways tap that won't pocket anything
    const r = simulateFlickSync(s, { strikerX: SLIDER_MIN_X, angle: Math.PI, force: 0.15 }, "creator");
    assert.equal(r.resolution.strikerPocketed, false);
    assert.equal(s.whoseTurn, "joiner");
});

// ---------- pocket detection ----------

test("isInsidePocket: true at a pocket centre, false at board centre", () => {
    const atPocket = { x: POCKETS[0].x, y: POCKETS[0].y, radius: 15 };
    const atCentre = { x: CENTER_X, y: CENTER_Y, radius: 15 };
    assert.ok(isInsidePocket(atPocket));
    assert.equal(isInsidePocket(atCentre), null);
});

test("step() pockets a coin sitting in a pocket and reports it", () => {
    const s = createInitialState();
    // move one coin onto a pocket, freeze everything else
    s.coins.forEach((c) => (c.velocity = { x: 0, y: 0 }));
    s.striker.pocketed = true; // ignore striker
    const victim = s.coins[0];
    victim.x = POCKETS[3].x;
    victim.y = POCKETS[3].y;
    const newly = step(s);
    assert.ok(victim.pocketed, "coin in pocket should be flagged pocketed");
    assert.ok(newly.some((p) => p.kind === "coin" && p.id === victim.id));
});

// ---------- rules: resolveTurn ----------

test("respawnAtCenter always resolves to a free, in-bounds spot", () => {
    const s = createInitialState(); // a full, crowded board
    const coin = respawnAtCenter(s, "red", 19);
    assert.ok(Number.isFinite(coin.x) && Number.isFinite(coin.y));
    // not overlapping any other live coin
    const overlap = s.coins.some(
        (c) => c !== coin && !c.pocketed && Math.hypot(c.x - coin.x, c.y - coin.y) < 2 * 15,
    );
    assert.equal(overlap, false);
});

test("broadcast frames carry strictly increasing timestamps", () => {
    const s = createInitialState();
    const { frames } = simulateFlickSync(s, { strikerX: CENTER_X, angle: -Math.PI / 2, force: 1 }, "creator");
    assert.ok(frames.length > 2);
    assert.equal(typeof frames[0].t, "number");
    for (let i = 1; i < frames.length; i++) {
        assert.ok(frames[i].t > frames[i - 1].t, "t must strictly increase");
    }
});

test("delta encoding: first frame seeds all coins, settled board stops resending", () => {
    const s = createInitialState();
    const { frames } = simulateFlickSync(s, { strikerX: CENTER_X, angle: -Math.PI / 2, force: 1 }, "creator");
    assert.equal(frames[0].coins.length, 19, "first frame seeds every live coin");
    const last = frames[frames.length - 1];
    assert.ok(last.coins.length < frames[0].coins.length, "fewer coins resent once settled");
});

test("broadcast frame coordinates are integer-quantized", () => {
    const s = createInitialState();
    const { frames } = simulateFlickSync(s, { strikerX: CENTER_X + 33, angle: -Math.PI / 2 + 0.1, force: 0.8 }, "creator");
    for (const f of frames) {
        for (const c of f.coins) {
            assert.equal(c.x, Math.round(c.x));
            assert.equal(c.y, Math.round(c.y));
        }
        if (f.striker) assert.equal(f.striker.x, Math.round(f.striker.x));
    }
});

test("snapshots are JSON-serializable and structurally complete", () => {
    const s = createInitialState();
    const snap = fullStateSnapshot(s);
    const round = JSON.parse(JSON.stringify(snap));
    assert.deepEqual(round.scores, { creator: 0, joiner: 0 });
    assert.equal(round.coins.length, 19);
    assert.ok("queenState" in round && "whoseTurn" in round);
});

// ── Pocket events must be schedulable on the client (PRD F4) ─────────────────

test("a pocket event carries the sim time it happened at, and the true capture point", async () => {
    const s = createInitialState();
    // Park a coin in the mouth of the top-left pocket, then flick. It falls in
    // almost immediately, so we get a pocket event with a small, checkable `t`.
    const pocket = POCKETS[0];
    const victim = s.coins.find((c) => c.color === "white");
    victim.x = pocket.x + 2;
    victim.y = pocket.y + 2;

    const events = [];
    await new Promise((resolve) => {
        startFlickSimulation(s, { strikerX: CENTER_X, angle: -Math.PI / 2, force: 0.2 }, "creator", {
            onFrame: () => {},
            onPocket: (p) => events.push(p),
            onDone: () => resolve(),
        });
    });

    const potted = events.find((e) => e.kind === "coin" && e.id === victim.id);
    assert.ok(potted, "the coin sitting in the pocket must be pocketed");

    // `t` is what lets the client hold the drop tween until its render clock
    // (which runs INTERP_DELAY behind) actually reaches the pocket.
    assert.equal(typeof potted.t, "number");
    assert.ok(potted.t > 0, "sim time must be positive");

    // `from` is the capture position. Pocketed coins are dropped from broadcast
    // frames, so without this the client would never learn where the coin
    // actually entered the pocket and would cut the corner.
    assert.ok(potted.from && Number.isFinite(potted.from.x) && Number.isFinite(potted.from.y));
    assert.ok(
        Math.hypot(potted.from.x - pocket.x, potted.from.y - pocket.y) < 25,
        "capture point must be at the pocket, not a stale streamed position",
    );
    assert.deepEqual(potted.pocket, pocket);
});

test("every pocket event in a turn is stamped, striker included", async () => {
    const s = createInitialState();
    // Striker straight into the bottom-right pocket region: aim it at a corner.
    const events = [];
    await new Promise((resolve) => {
        startFlickSimulation(s, { strikerX: CENTER_X, angle: -Math.PI / 2, force: 1 }, "creator", {
            onFrame: () => {},
            onPocket: (p) => events.push(p),
            onDone: () => resolve(),
        });
    });
    for (const e of events) {
        assert.equal(typeof e.t, "number", `${e.kind} event is missing its sim timestamp`);
        assert.ok(e.from, `${e.kind} event is missing its capture position`);
    }
});

// ── No shot from a striker that overlaps a coin (PRD F3) ────────────────────

test("overlapsAnyCoin: exact at the touching boundary, and ignores pocketed coins", () => {
    const y = 700;
    const reach = 21 + 15; // STRIKER_RADIUS + COIN_RADIUS
    const coin = (x, pocketed = false) => ({ x, y, radius: 15, pocketed });

    assert.equal(overlapsAnyCoin([coin(400 + reach - 1)], 400, y), true, "touching → blocked");
    assert.equal(overlapsAnyCoin([coin(400 + reach + 1)], 400, y), false, "a clear gap → legal");
    assert.equal(overlapsAnyCoin([coin(400, true)], 400, y), false, "a pocketed coin is off the board");
    assert.equal(overlapsAnyCoin([], 400, y), false);
});

test("the guard the flick handler applies: a striker placed on a coin has no legal shot", () => {
    const s = createInitialState();
    // Drag a coin down onto the creator's baseline, right where the striker sits.
    const baselineY = baselineYFor("creator");
    const victim = s.coins[0];
    victim.x = CENTER_X;
    victim.y = baselineY;

    assert.equal(
        overlapsAnyCoin(s.coins, clampStrikerX(CENTER_X), baselineY),
        true,
        "the server must refuse this flick, whatever the client's button says",
    );
    // And a striker parked at the far end of the baseline is fine.
    assert.equal(overlapsAnyCoin(s.coins, SLIDER_MIN_X, baselineY), false);
});

test("the opening position is never blocked — the guard must not break normal play", () => {
    const s = createInitialState();
    for (const role of ["creator", "joiner"]) {
        for (const x of [SLIDER_MIN_X, CENTER_X, SLIDER_MAX_X]) {
            assert.equal(
                overlapsAnyCoin(s.coins, x, baselineYFor(role)),
                false,
                `a fresh rack must be flickable from ${role}'s baseline at x=${x}`,
            );
        }
    }
});
