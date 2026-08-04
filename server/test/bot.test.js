// The computer player: the geometry it aims with, what it values, and what
// difficulty actually changes.
//
// The bot judges shots by running the real simulation, so most of what could go
// wrong is not "does it play well" but "does it play LEGALLY and does it leave
// the board alone while thinking". Those are the ones worth pinning.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
    ghostPoint, distanceToSegment, pathBlocked, legalPlacement,
    potShots, explorationShots, candidateShots, safeShot, targetsFor,
} from "../bot/aim.js";
import { scoreOutcome, nearness } from "../bot/score.js";
import { planShot, MEDIUM } from "../bot/index.js";
import { createInitialState } from "../sim/state.js";
import {
    POCKETS, COIN_RADIUS, STRIKER_RADIUS, SLIDER_MIN_X, SLIDER_MAX_X,
    baselineYFor, foulsMoon, overlapsAnyCoin,
} from "../sim/geometry.js";

// A deterministic random, so a failing test fails the same way twice.
function rng(seed = 1) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// A board with the coins pushed out of the middle, so clean pots exist.
function openBoard() {
    const state = createInitialState(19);
    state.coins.forEach((c, i) => {
        c.x = 200 + ((i * 137) % 500);
        c.y = 200 + ((i * 241) % 460);
    });
    return state;
}

describe("aiming geometry", () => {
    test("the ghost point sits behind the coin, on the pocket's line", () => {
        const coin = { x: 450, y: 450 };
        const pocket = POCKETS[0];
        const g = ghostPoint(coin, pocket);

        // Exactly one coin radius plus one striker radius from the coin...
        assert.ok(Math.abs(Math.hypot(g.x - coin.x, g.y - coin.y) - (COIN_RADIUS + STRIKER_RADIUS)) < 1e-9);
        // ...and on the opposite side from the pocket, so hitting it sends the
        // coin towards the pocket rather than away.
        assert.ok(Math.hypot(g.x - pocket.x, g.y - pocket.y) > Math.hypot(coin.x - pocket.x, coin.y - pocket.y));
    });

    test("distance to a segment uses the ends, not the infinite line", () => {
        // Straight out from the middle of the segment.
        assert.equal(distanceToSegment(0, 5, -10, 0, 10, 0), 5);
        // Off the end: measured to the end point, not to the line's projection.
        assert.equal(distanceToSegment(20, 0, -10, 0, 10, 0), 10);
    });

    test("a coin in the way blocks the line, and the target itself does not", () => {
        const coins = [{ id: 1, x: 450, y: 300, pocketed: false }];
        const from = { x: 450, y: 600 };
        const to = { x: 450, y: 100 };
        assert.equal(pathBlocked(from, to, coins, new Set(), 30), true);
        assert.equal(pathBlocked(from, to, coins, new Set([1]), 30), false, "the target is allowed on its own line");
    });

    test("a pocketed coin is not in the way", () => {
        const coins = [{ id: 1, x: 450, y: 300, pocketed: true }];
        assert.equal(pathBlocked({ x: 450, y: 600 }, { x: 450, y: 100 }, coins, new Set(), 30), false);
    });
});

describe("what the bot may shoot at", () => {
    test("before any colour is claimed, every coin is a target", () => {
        const state = createInitialState(19);
        assert.equal(targetsFor(state, "creator").length, 19);
    });

    test("once colours are claimed it goes for its own, plus the queen", () => {
        const state = createInitialState(19);
        state.colors = { creator: "white", joiner: "black" };
        const targets = targetsFor(state, "creator");
        assert.ok(targets.every((c) => c.color === "white" || c.color === "red"));
        assert.ok(targets.some((c) => c.color === "red"), "the queen is always worth a look");
    });
});

describe("proposing shots", () => {
    test("an opening rack offers no clean pot at all", () => {
        // Every coin in the cluster is blocked by its neighbours. This is the
        // reason the bot needs break shots: without them it has nothing to play.
        assert.equal(potShots(createInitialState(19), "creator", 40).length, 0);
    });

    test("an open board does offer pots", () => {
        assert.ok(potShots(openBoard(), "creator", 40).length > 0);
    });

    test("but there is ALWAYS something to play", () => {
        for (const state of [createInitialState(19), createInitialState(3), openBoard()]) {
            for (const role of ["creator", "joiner"]) {
                assert.ok(candidateShots(state, role, 40).length > 0,
                    "a board with no shot on it would stall the game");
            }
        }
    });

    test("every proposed shot is a legal placement", () => {
        // The server refuses a striker that overlaps a coin or sits half on an
        // end circle. A bot that proposes one would simply lose its turn.
        for (const state of [createInitialState(19), openBoard()]) {
            for (const role of ["creator", "joiner"]) {
                const y = baselineYFor(role);
                for (const shot of candidateShots(state, role, 40)) {
                    assert.ok(shot.strikerX >= SLIDER_MIN_X - 1e-9 && shot.strikerX <= SLIDER_MAX_X + 1e-9,
                        `striker off the baseline at ${shot.strikerX}`);
                    assert.equal(foulsMoon(shot.strikerX), false, "half on an end circle");
                    assert.equal(overlapsAnyCoin(state.coins, shot.strikerX, y), false, "on top of a coin");
                    assert.ok(Number.isFinite(shot.angle) && shot.force > 0 && shot.force <= 1);
                }
            }
        }
    });

    test("the fallback shot is legal too", () => {
        const state = createInitialState(19);
        const shot = safeShot(state, "creator");
        assert.equal(legalPlacement(state, shot.strikerX, baselineYFor("creator")), true);
    });
});

describe("judging the result", () => {
    const before = { scores: { creator: 0, joiner: 0 }, colors: { creator: null, joiner: null } };
    const board = (scores, coins = []) => ({
        scores, coins, colors: { creator: "white", joiner: "black" },
    });
    const nothing = { strikerPocketed: false, continuedTurn: false, gameOver: false, winner: null };

    test("a point for me beats a quiet turn", () => {
        const quiet = scoreOutcome(before, board({ creator: 0, joiner: 0 }), nothing, "creator");
        const potted = scoreOutcome(before, board({ creator: 1, joiner: 0 }), nothing, "creator");
        assert.ok(potted > quiet);
    });

    test("a point for them is nearly as bad as one for me is good", () => {
        const theirs = scoreOutcome(before, board({ creator: 0, joiner: 1 }), nothing, "creator");
        assert.ok(theirs < 0);
    });

    test("a foul costs more than a pot gains", () => {
        // So the bot will not gamble the striker for a single coin.
        const potNoFoul = scoreOutcome(before, board({ creator: 1, joiner: 0 }), nothing, "creator");
        const potAndFoul = scoreOutcome(
            before, board({ creator: 0, joiner: 0 }),   // the rules already took the point back
            { ...nothing, strikerPocketed: true }, "creator",
        );
        assert.ok(potAndFoul < potNoFoul);
        assert.ok(potAndFoul < 0);
    });

    test("winning dominates everything else", () => {
        const win = scoreOutcome(before, board({ creator: 1, joiner: 0 }),
            { ...nothing, gameOver: true, winner: "creator" }, "creator");
        const lose = scoreOutcome(before, board({ creator: 9, joiner: 0 }),
            { ...nothing, gameOver: true, winner: "joiner" }, "creator");
        assert.ok(win > 100);
        assert.ok(lose < -100, "and losing is not worth any number of points");
    });

    test("a coin near a pocket is worth more than one in open board", () => {
        const near = nearness([{ x: POCKETS[0].x + 20, y: POCKETS[0].y + 20, color: "white", pocketed: false }], "white");
        const far = nearness([{ x: 450, y: 450, color: "white", pocketed: false }], "white");
        assert.ok(near > far);
        assert.equal(far, 0, "the middle of the board is not near anything");
    });

    test("a pocketed coin is not on the board any more", () => {
        assert.equal(nearness([{ x: POCKETS[0].x, y: POCKETS[0].y, color: "white", pocketed: true }], "white"), 0);
    });
});

describe("planning a shot", () => {
    test("it returns a legal, playable shot", async () => {
        const state = createInitialState(19);
        const { shot } = await planShot(state, "creator", { difficulty: MEDIUM, random: rng(3) });
        assert.ok(shot.strikerX >= SLIDER_MIN_X && shot.strikerX <= SLIDER_MAX_X);
        assert.equal(foulsMoon(shot.strikerX), false);
        assert.ok(shot.force > 0 && shot.force <= 1);
        assert.ok(Number.isFinite(shot.angle));
    });

    test("it never touches the board it is thinking about", async () => {
        // It simulates dozens of shots; every one of them must be on a copy.
        const state = createInitialState(19);
        const before = JSON.stringify(state);
        await planShot(state, "creator", { difficulty: MEDIUM, random: rng(4) });
        assert.equal(JSON.stringify(state), before);
    });

    test("the same board and the same rolls give the same shot", async () => {
        const a = await planShot(createInitialState(19), "creator", { difficulty: MEDIUM, random: rng(9) });
        const b = await planShot(createInitialState(19), "creator", { difficulty: MEDIUM, random: rng(9) });
        assert.deepEqual(a.shot, b.shot);
    });

    test("at full difficulty it plays exactly what it intended", async () => {
        const { shot, intended } = await planShot(openBoard(), "creator", { difficulty: 1, random: rng(5) });
        assert.deepEqual(shot, intended, "a perfect bot does not miss");
    });

    test("below full difficulty it misses by some amount", async () => {
        const { shot, intended } = await planShot(openBoard(), "creator", { difficulty: 0, random: rng(6) });
        assert.notEqual(shot.angle, intended.angle);
    });

    test("a weaker bot misses by more", async () => {
        // Averaged: a single pair of draws proves nothing about a distribution.
        const spread = async (difficulty) => {
            let total = 0;
            for (let i = 0; i < 12; i++) {
                const p = await planShot(openBoard(), "creator", { difficulty, random: rng(100 + i) });
                total += Math.abs(p.shot.angle - p.intended.angle);
            }
            return total / 12;
        };
        assert.ok(await spread(0) > await spread(MEDIUM));
        assert.ok(await spread(MEDIUM) > await spread(0.9));
    });

    test("a harder bot looks at more shots", async () => {
        const easy = await planShot(openBoard(), "creator", { difficulty: 0, random: rng(7) });
        const hard = await planShot(openBoard(), "creator", { difficulty: 1, random: rng(7) });
        assert.ok(hard.considered > easy.considered);
    });

    test("it copes with a board it cannot pot anything on", async () => {
        // Only the opponent's coins left, all in a corner: no target of its own.
        const state = createInitialState(19);
        state.colors = { creator: "white", joiner: "black" };
        state.coins.forEach((c) => {
            c.pocketed = c.color !== "black";
            c.x = 200; c.y = 200;
        });
        const { shot } = await planShot(state, "creator", { difficulty: MEDIUM, random: rng(8) });
        assert.ok(Number.isFinite(shot.angle) && shot.force > 0, "it still plays something");
    });
});
