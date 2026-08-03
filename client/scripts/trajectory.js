// Ruler mode's forecast.
//
// This is not an approximation of the shot — it IS the shot. The client runs
// the server's own simulation over a copy of the live board and records where
// everything ends up: friction and all, every collision in the chain, and any
// piece that drops into a pocket on the way.
//
// Sharing the server's physics rather than reimplementing it is the whole
// point. A second physics written to look like the first would drift from it,
// and a ruler that quietly disagrees with the game is worse than no ruler.
//
// It is a dry run: state is deep-copied, so nothing here can touch the board.

// From client/vendor/sim — a build-time copy of server/sim, made by
// tools/vendor-sim.mjs. The server's copy is the source of truth; this one
// exists because the client is built from its own folder alone.
import { step, anythingMoving } from "../vendor/sim/step.js";
import { makeCoin, makeStriker } from "../vendor/sim/state.js";
import {
    clampStrikerX, baselineYFor, MAX_VELOCITY_FROM_FLICK, POCKET_RADIUS,
} from "../vendor/sim/geometry.js";

// The same ceiling the live simulation uses. A lower one would cut the slow
// tail off a long shot, drawing a piece as stopping while it is still creeping.
const MAX_TICKS = 900;
// Every tick. Sampling every other one let a fast piece's path cut the corner
// off a bounce, which reads as reaching somewhere it never goes.
const SAMPLE_EVERY = 1;
// Below this a piece was jostled, not sent: drawing it adds noise.
const MOVED_ENOUGH = 6;

/**
 * Forecast a shot.
 *
 * @param {Array}  coins    live coins as {id, color, x, y}
 * @param {object} shot     {strikerX, angle, force} — exactly what a flick sends
 * @param {string} actor    "creator" | "joiner", for the baseline the striker sits on
 * @returns {Array<{id, kind, colour, path: Array<[number,number]>, pocketed: boolean}>}
 *          One entry per piece that actually moved, striker first.
 */
export function forecast(coins, { strikerX, angle, force }, actor = "creator") {
    // A private copy of the board. makeCoin/makeStriker give every field the
    // simulation expects (mass, restitution, friction), so this is a real state.
    const state = {
        coins: coins.filter((c) => !c.pocketed).map((c) => makeCoin(c.id, c.color, c.x, c.y)),
        striker: makeStriker(clampStrikerX(strikerX), baselineYFor(actor)),
    };

    const speed = MAX_VELOCITY_FROM_FLICK * Math.max(0, Math.min(1, force || 0));
    state.striker.velocity = {
        x: Math.cos(angle) * speed,
        y: Math.sin(angle) * speed,
    };

    const start = new Map();
    const trails = new Map();
    // The tick each piece first moves. That order IS the chain: striker, then
    // whatever it strikes, then whatever that strikes.
    const movedAt = new Map();
    const record = (key, piece) => {
        if (!trails.has(key)) {
            trails.set(key, [[piece.x, piece.y]]);
            start.set(key, { x: piece.x, y: piece.y });
        } else {
            trails.get(key).push([piece.x, piece.y]);
        }
    };

    record("striker", state.striker);
    for (const c of state.coins) record(c.id, c);

    // Pieces that go down: remember which pocket, so the path can end in it
    // rather than stopping in mid-board.
    const pocketed = new Map();

    for (let tick = 0; tick < MAX_TICKS; tick++) {
        const dropped = step(state);

        for (const c of state.coins) {
            if (movedAt.has(c.id) || c.pocketed) continue;
            if (Math.hypot(c.velocity.x, c.velocity.y) > 0.2) movedAt.set(c.id, tick);
        }

        for (const p of dropped) {
            const key = p.kind === "striker" ? "striker" : p.id;
            pocketed.set(key, p.pocket);
        }
        if (tick % SAMPLE_EVERY === 0) {
            if (!state.striker.pocketed) record("striker", state.striker);
            for (const c of state.coins) if (!c.pocketed) record(c.id, c);
        }
        if (!anythingMoving(state)) break;
    }

    // Final resting places, and the pocket for anything that went down.
    if (!state.striker.pocketed) record("striker", state.striker);
    for (const c of state.coins) if (!c.pocketed) record(c.id, c);
    for (const [key, pocket] of pocketed) {
        const trail = trails.get(key);
        if (trail) trail.push([pocket.x, pocket.y]);
    }

    const out = [];
    for (const [key, path] of trails) {
        const from = start.get(key);
        const [ex, ey] = path[path.length - 1];
        if (Math.hypot(ex - from.x, ey - from.y) < MOVED_ENOUGH) continue;

        const coin = key === "striker" ? null : state.coins.find((c) => c.id === key);
        out.push({
            id: key,
            kind: key === "striker" ? "striker" : "coin",
            colour: coin ? coin.color : null,
            path: simplify(path),
            pocketed: pocketed.has(key),
            // Where this piece sits in the chain: the striker moves first, then
            // whatever it hits, and so on.
            order: key === "striker" ? -1 : (movedAt.get(key) ?? Infinity),
        });
    }

    // Chain order: striker, then each piece in the order it was set moving.
    out.sort((a, b) => a.order - b.order);
    return out;
}

// Drop points that sit on the line between their neighbours. A shot that runs
// the length of the board is a handful of straight legs and a few bounces; this
// turns ~200 samples into a dozen or so.
function simplify(points, tolerance = 0.35) {
    if (points.length < 3) return points;
    const out = [points[0]];
    for (let i = 1; i < points.length - 1; i++) {
        const [ax, ay] = out[out.length - 1];
        const [bx, by] = points[i];
        const [cx, cy] = points[i + 1];
        // Cross product of the two legs: how far b sits off the line a→c.
        const cross = Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
        const len = Math.hypot(cx - ax, cy - ay) || 1;
        if (cross / len > tolerance) out.push(points[i]);
    }
    out.push(points[points.length - 1]);
    return out;
}

// A note on fidelity: the path is sampled once per 16ms tick, so a bounce that
// happens between two ticks is drawn as a slightly clipped corner — at most
// half a tick of travel, measured at under 6 board units on the fastest shots
// (a coin is 30 across). Reconstructing those corners by intersecting the legs
// was tried and reverted: it improved the average and badly mangled the rare
// case where a leg was too short to give a trustworthy direction, and one wild
// corner is far more misleading than a slightly rounded one.

export { POCKET_RADIUS };
export default forecast;
