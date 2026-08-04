// Ruler mode's forecast. It runs the SERVER'S simulation over a copy of the
// board, so these tests are as much about that contract — same physics, no
// side effects — as about the shapes that come out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { forecast } from "../scripts/trajectory.js";
import { createInitialState, simulateFlickSync } from "../../server/physics.js";

const rack = () => createInitialState(19).coins.map((c) => ({
    id: c.id, color: c.color, x: c.x, y: c.y, pocketed: false,
}));
const UP = -Math.PI / 2;
const strikerOf = (paths) => paths.find((p) => p.kind === "striker");

test("it agrees with the simulation it forecasts", () => {
    // The whole promise of ruler mode: what it draws is what will happen.
    const coins = rack();
    const paths = forecast(coins, { strikerX: 450, angle: UP, force: 1 });

    const state = createInitialState(19);
    const { fullState } = simulateFlickSync(state, { strikerX: 450, angle: UP, force: 1 }, "creator");

    for (const piece of paths) {
        if (piece.kind !== "coin" || piece.pocketed) continue;
        const actual = fullState.coins.find((c) => c.id === piece.id);
        const [px, py] = piece.path[piece.path.length - 1];
        assert.ok(Math.hypot(actual.x - px, actual.y - py) < 1,
            `coin ${piece.id} forecast (${Math.round(px)},${Math.round(py)}) vs actual (${Math.round(actual.x)},${Math.round(actual.y)})`);
    }
});

test("the forecast never touches the board it was given", () => {
    const coins = rack();
    const before = JSON.stringify(coins);
    forecast(coins, { strikerX: 450, angle: UP, force: 1 });
    assert.equal(JSON.stringify(coins), before, "the live coins were mutated");
});

test("a gentle shot stops where friction stops it, not at a cushion", () => {
    // Softly, into an empty board: the striker must come to rest in open board
    // rather than running on for ever. The top cushion is at y=96.
    const paths = forecast([], { strikerX: 450, angle: UP, force: 0.15 });
    const [ex, ey] = strikerOf(paths).path.slice(-1)[0];
    assert.ok(ey > 200, `stopped short of the cushion, at y=${Math.round(ey)}`);
    assert.ok(ey < 707, "and it did move");
    assert.ok(Math.abs(ex - 450) < 2, "straight up");
});

test("harder shots reach further, up to the first cushion", () => {
    // Only up to the cushion, and deliberately so: past that point a bounce
    // costs 30% of the speed, so a shot that arrives at the cushion hard can
    // finish nearer home than one that barely gets there. Comparing shots that
    // never touch a cushion is the part that must hold monotonically.
    let last = 750;
    for (const force of [0.05, 0.08, 0.1, 0.12, 0.15]) {
        const [, ey] = strikerOf(forecast([], { strikerX: 450, angle: UP, force })).path.slice(-1)[0];
        assert.ok(ey > 96, `force ${force} stayed off the cushion (y=${Math.round(ey)})`);
        assert.ok(ey < last, `force ${force} reached further than the shot before it`);
        last = ey;
    }
});

test("a shot that rebounds is drawn coming back", () => {
    // A straight-on bounce doubles back along its own line, so the path
    // simplifier used to drop the turning point as collinear and draw the shot
    // stopping in mid-board — a ruler that disagrees with the board it forecasts.
    const path = strikerOf(forecast([], { strikerX: 450, angle: UP, force: 1 })).path;
    const ys = path.map(([, y]) => y);
    const top = Math.min(...ys);
    assert.ok(top < 110, `it reached the far cushion (nearest approach y=${Math.round(top)})`);
    assert.ok(ys[ys.length - 1] > top + 100, "and the path shows it coming back");
});

test("a chain of collisions is followed, not just the first", () => {
    // Striker into a coin, which is lined up on a second coin.
    const coins = [
        { id: 1, color: "white", x: 450, y: 400, pocketed: false },
        { id: 2, color: "black", x: 450, y: 330, pocketed: false },
    ];
    const paths = forecast(coins, { strikerX: 450, angle: UP, force: 1 });
    const moved = paths.filter((p) => p.kind === "coin").map((p) => p.id).sort();
    assert.deepEqual(moved, [1, 2], "both coins in the chain were forecast");
});

test("a piece that goes down is marked, and its path ends in the pocket", () => {
    // Straight at the top-left pocket from the baseline.
    const coins = [];
    const paths = forecast(coins, { strikerX: 450, angle: Math.atan2(97.5 - 707, 97.5 - 450), force: 1 });
    const striker = strikerOf(paths);
    assert.equal(striker.pocketed, true, "the striker was forecast into the pocket");
    const [ex, ey] = striker.path.slice(-1)[0];
    assert.ok(Math.hypot(ex - 97.5, ey - 97.5) < 1, "and the path ends at that pocket");
});

test("pieces that were only jostled are left out", () => {
    const paths = forecast(rack(), { strikerX: 450, angle: UP, force: 0.02 });
    assert.ok(paths.length <= 1, `a feather-touch moves nothing much, got ${paths.length}`);
});
