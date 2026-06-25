// Pure physics + carrom-rule unit tests. No external deps (node:test).
//   cd server && npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    createInitialState,
    createCoinFormation,
    simulateFlickSync,
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

test("score goes to the colour's owner regardless of who potted", () => {
    const s = createInitialState();
    // creator pots a white (their colour)
    let r = resolveTurn(s, [{ kind: "coin", id: 1, color: "white" }], "creator");
    assert.equal(s.scores.creator, 1);
    assert.equal(r.continuedTurn, true, "potting own colour continues the turn");
    assert.equal(s.whoseTurn, "creator");

    // creator pots a black (opponent colour) → joiner scores, turn passes
    const s2 = createInitialState();
    r = resolveTurn(s2, [{ kind: "coin", id: 2, color: "black" }], "creator");
    assert.equal(s2.scores.joiner, 1);
    assert.equal(s2.scores.creator, 0);
    assert.equal(r.continuedTurn, false);
    assert.equal(s2.whoseTurn, "joiner");
});

test("queen alone ⇒ pocketed_uncovered, actor keeps a cover turn", () => {
    const s = createInitialState();
    const r = resolveTurn(s, [{ kind: "coin", id: 19, color: "red" }], "creator");
    assert.equal(s.queenState, "pocketed_uncovered");
    assert.equal(s.queenPocketedBy, "creator");
    assert.equal(r.continuedTurn, true, "cover turn keeps the actor on");
});

test("queen + own coin same stroke ⇒ covered + queen bonus", () => {
    const s = createInitialState();
    resolveTurn(
        s,
        [
            { kind: "coin", id: 19, color: "red" },
            { kind: "coin", id: 1, color: "white" },
        ],
        "creator",
    );
    assert.equal(s.queenState, "covered");
    // +1 white +5 queen bonus
    assert.equal(s.scores.creator, 6);
});

test("cover turn: potting own colour next stroke covers the queen", () => {
    const s = createInitialState();
    s.queenState = "pocketed_uncovered";
    s.queenPocketedBy = "creator";
    resolveTurn(s, [{ kind: "coin", id: 1, color: "white" }], "creator");
    assert.equal(s.queenState, "covered");
    assert.equal(s.scores.creator, 6, "+1 white +5 queen");
});

test("failed cover returns the queen to the board", () => {
    const s = createInitialState();
    const queen = s.coins.find((c) => c.color === "red");
    queen.pocketed = true; // queen currently off the board
    s.queenState = "pocketed_uncovered";
    s.queenPocketedBy = "creator";
    const before = s.coins.filter((c) => c.color === "red" && !c.pocketed).length;
    resolveTurn(s, [], "creator"); // potted nothing
    assert.equal(s.queenState, "on_board");
    const after = s.coins.filter((c) => c.color === "red" && !c.pocketed).length;
    assert.equal(after, before + 1, "a live red queen is back on the board");
});

test("striker foul with empty pile accrues a due and passes the turn", () => {
    const s = createInitialState();
    s.striker.pocketed = true;
    const r = resolveTurn(s, [], "creator");
    assert.equal(s.debts.creator, 1);
    assert.equal(r.strikerPocketed, true);
    assert.equal(r.continuedTurn, false);
    assert.equal(s.whoseTurn, "joiner");
    assert.equal(s.striker.pocketed, false, "striker is reset for next turn");
});

test("striker foul refunds a coin from the pile and removes its point", () => {
    const s = createInitialState();
    s.scores.creator = 1;
    s.pocketedPiles.creator = [{ id: 7, color: "white" }];
    s.striker.pocketed = true;
    const liveBefore = s.coins.filter((c) => !c.pocketed).length;
    resolveTurn(s, [], "creator");
    assert.equal(s.scores.creator, 0, "refunded own coin loses its point");
    assert.equal(s.debts.creator, 0, "pile had a coin, so no due");
    assert.equal(s.coins.filter((c) => !c.pocketed).length, liveBefore + 1, "coin respawned");
});

test("outstanding due is auto-settled against new score", () => {
    const s = createInitialState();
    s.debts.creator = 2;
    // creator pots two whites
    resolveTurn(
        s,
        [
            { kind: "coin", id: 1, color: "white" },
            { kind: "coin", id: 3, color: "white" },
        ],
        "creator",
    );
    // 2 scored, 2 settled against the due
    assert.equal(s.scores.creator, 0);
    assert.equal(s.debts.creator, 0);
});

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

test("fouling on the stroke that pots the queen voids the cover", () => {
    const s = createInitialState();
    s.striker.pocketed = true; // foul on this stroke
    resolveTurn(
        s,
        [
            { kind: "coin", id: 19, color: "red" },
            { kind: "coin", id: 1, color: "white" },
        ],
        "creator",
    );
    assert.equal(s.queenState, "on_board", "queen returns to board on a foul");
    assert.notEqual(s.queenState, "covered");
});

test("game over when a colour is cleared and the queen is settled", () => {
    const s = createInitialState();
    s.coins.filter((c) => c.color === "white").forEach((c) => (c.pocketed = true));
    s.queenState = "covered";
    s.scores.creator = 9;
    s.scores.joiner = 3;
    const r = resolveTurn(s, [], "creator");
    assert.equal(r.gameOver, true);
    assert.equal(r.winner, "creator");
    assert.equal(s.gameOver, true);
});

test("no game over while the queen is still pending a cover", () => {
    const s = createInitialState();
    s.coins.filter((c) => c.color === "white").forEach((c) => (c.pocketed = true)); // white cleared
    // queen potted alone on this very stroke ⇒ becomes pending-cover, not settled
    const queen = s.coins.find((c) => c.color === "red");
    queen.pocketed = true;
    const r = resolveTurn(s, [{ kind: "coin", id: 19, color: "red" }], "creator");
    assert.equal(s.queenState, "pocketed_uncovered");
    assert.equal(r.gameOver, false, "queen pending a cover blocks game over");
    assert.equal(r.continuedTurn, true, "actor gets the cover turn");
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
