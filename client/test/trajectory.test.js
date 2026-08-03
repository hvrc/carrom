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

test("a shot stops where friction stops it, not at the cushion", () => {
    // Softly, into an empty board: the striker must come to rest short of the
    // far cushion rather than running on for ever.
    const paths = forecast([], { strikerX: 450, angle: UP, force: 0.25 });
    const [ex, ey] = strikerOf(paths).path.slice(-1)[0];
    assert.ok(ey > 200, `stopped short, at y=${Math.round(ey)}`);
    assert.ok(ey < 707, "and it did move");
    assert.ok(Math.abs(ex - 450) < 2, "straight up");
});

test("harder shots reach further", () => {
    const soft = strikerOf(forecast([], { strikerX: 450, angle: UP, force: 0.3 })).path.slice(-1)[0][1];
    const hard = strikerOf(forecast([], { strikerX: 450, angle: UP, force: 0.9 })).path.slice(-1)[0][1];
    assert.ok(hard < soft, `hard shot travelled further (${Math.round(hard)} vs ${Math.round(soft)})`);
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
