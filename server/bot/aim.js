// Where a bot could aim: turning a board into a shortlist of shots worth trying.
//
// Simulating a shot costs about 4ms, and the physics loop ticks every 16ms, so
// trying every placement against every angle is not an option — a few hundred
// candidates would stall every game on the server for half a second. The way
// round it is to think geometrically first and simulate second: this module
// proposes only shots that have a reason to exist, and the planner simulates
// the handful that survive.
//
// The reason is always the same one a player would give: to send a particular
// coin into a particular pocket. For that, the striker has to arrive at the
// point where its edge touches the coin's edge along the coin-to-pocket line —
// the "ghost" position. Aim the striker at the ghost and the coin leaves along
// that line. Everything here is in service of finding those points and throwing
// out the ones that are blocked, too thin, or off the board.
//
// Nothing here decides whether a shot is GOOD — that needs the real physics,
// and lives in the planner. This only decides what is worth asking about.

import {
    POCKETS, COIN_RADIUS, STRIKER_RADIUS, SLIDER_MIN_X, SLIDER_MAX_X,
    BOARD_X, BOARD_Y, BOARD_SIZE, baselineYFor, foulsMoon, overlapsAnyCoin,
} from "../sim/geometry.js";

// How square a hit has to be. The angle between "where the striker is going"
// and "where the coin must go" — a cut. Past about 68° the contact is a graze
// that needs more precision than the shot is worth, and the coin mostly goes
// somewhere else.
const MAX_CUT = Math.cos((68 * Math.PI) / 180);

// A coin sitting this close to a line blocks it. Slightly under the true
// touching distance: a shot that shaves a coin is legitimate, and being strict
// here throws away most of the board on a crowded rack.
const BLOCK_SLACK = 0.85;

// Placements to consider along the baseline. Fine enough that the best line to
// a ghost point is available, coarse enough to stay cheap.
const PLACEMENT_SAMPLES = 33;

const norm = (x, y) => {
    const d = Math.hypot(x, y) || 1;
    return { x: x / d, y: y / d };
};

/**
 * Where the striker's CENTRE must be at the moment of contact for the coin to
 * leave along the coin-to-pocket line. One coin radius plus one striker radius
 * back from the coin, directly opposite the pocket.
 */
export function ghostPoint(coin, pocket) {
    const u = norm(pocket.x - coin.x, pocket.y - coin.y);
    return {
        x: coin.x - u.x * (STRIKER_RADIUS + COIN_RADIUS),
        y: coin.y - u.y * (STRIKER_RADIUS + COIN_RADIUS),
        u,
    };
}

/** Distance from a point to a line segment. */
export function distanceToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Is anything in the way between two points?
 * @param {number} clearance how close a coin may come before it counts as blocking
 * @param {Set} ignore coin ids that are allowed to be on the line (the target)
 */
export function pathBlocked(from, to, coins, ignore, clearance) {
    for (const c of coins) {
        if (c.pocketed || ignore.has(c.id)) continue;
        if (distanceToSegment(c.x, c.y, from.x, from.y, to.x, to.y) < clearance) return true;
    }
    return false;
}

/** Is this a legal place to put the striker down? */
export function legalPlacement(state, x, baselineY) {
    if (foulsMoon(x)) return false;
    return !overlapsAnyCoin(state.coins, x, baselineY);
}

// Which coins this player is trying to sink. Before anyone has pocketed
// anything the colours belong to nobody, so every coin is fair game and the
// first one down decides. The queen is always worth a look — the rules decide
// whether she counts, and the simulation runs the rules.
export function targetsFor(state, role) {
    const mine = state.colors[role];
    return state.coins.filter((c) => {
        if (c.pocketed) return false;
        if (c.color === "red") return true;
        return !mine || c.color === mine;
    });
}

// How hard to hit it. The striker has to reach the coin and the coin has to
// reach the pocket, so the distance that matters is both legs together. This is
// a starting guess — the planner tries a firmer version of every shot too,
// because the cost of being slightly short is missing the pocket entirely.
function forceFor(travel) {
    return Math.max(0.32, Math.min(1, 0.26 + travel / 1250));
}

const onBoard = (p) => (
    p.x > BOARD_X + STRIKER_RADIUS && p.x < BOARD_X + BOARD_SIZE - STRIKER_RADIUS &&
    p.y > BOARD_Y + STRIKER_RADIUS && p.y < BOARD_Y + BOARD_SIZE - STRIKER_RADIUS
);

/**
 * Shots that try to sink a particular coin in a particular pocket.
 *
 * On an opening rack this returns NOTHING, and correctly so: every coin in the
 * cluster is blocked by its neighbours, and there is no clean pot on the board.
 * That is what `explorationShots` is for.
 */
export function potShots(state, role, limit = 40) {
    const baselineY = baselineYFor(role);
    const targets = targetsFor(state, role);

    const placements = [];
    for (let i = 0; i < PLACEMENT_SAMPLES; i++) {
        const x = SLIDER_MIN_X + ((SLIDER_MAX_X - SLIDER_MIN_X) * i) / (PLACEMENT_SAMPLES - 1);
        if (legalPlacement(state, x, baselineY)) placements.push(x);
    }
    if (placements.length === 0) return [];

    const out = [];
    for (const coin of targets) {
        const ignore = new Set([coin.id]);
        for (const pocket of POCKETS) {
            const ghost = ghostPoint(coin, pocket);
            if (!onBoard(ghost)) continue;
            // The coin's own road to the pocket has to be clear, or the shot is
            // pointless however well it is struck.
            if (pathBlocked(coin, pocket, state.coins, ignore, COIN_RADIUS * 2 * BLOCK_SLACK)) continue;

            // The best two placements for this ghost point: the ones that hit it
            // squarest. A thinner cut on the same coin is the same shot, worse.
            const lines = [];
            for (const sx of placements) {
                const from = { x: sx, y: baselineY };
                const dir = norm(ghost.x - from.x, ghost.y - from.y);
                const cut = dir.x * ghost.u.x + dir.y * ghost.u.y;   // 1 = dead straight
                if (cut < MAX_CUT) continue;
                lines.push({ sx, from, dir, cut });
            }
            lines.sort((a, b) => b.cut - a.cut);

            for (const line of lines.slice(0, 2)) {
                if (pathBlocked(line.from, ghost, state.coins, ignore,
                    (COIN_RADIUS + STRIKER_RADIUS) * BLOCK_SLACK)) continue;

                const reach = Math.hypot(ghost.x - line.from.x, ghost.y - line.from.y);
                const roll = Math.hypot(pocket.x - coin.x, pocket.y - coin.y);
                const force = forceFor(reach + roll);
                const angle = Math.atan2(ghost.y - line.from.y, ghost.x - line.from.x);

                // What makes one candidate look better than another before any
                // of them are simulated: a square hit on a coin with a short
                // road to the pocket. Cut dominates — it is the thing that
                // decides whether the coin goes where it was sent.
                const quality = line.cut * 2 - roll / 900 - reach / 1800;
                out.push({ strikerX: line.sx, angle, force, targetId: coin.id, quality });
            }
        }
    }

    out.sort((a, b) => b.quality - a.quality);
    return out.slice(0, limit);
}

/**
 * Shots that are not pot attempts: hit that coin, and see.
 *
 * A player opening a game does not line up a pot, because there isn't one —
 * they break the rack and take what falls out. The bot needs the same move, and
 * it needs it more often than the opening: any packed cluster produces a board
 * where `potShots` is empty, and a bot with nothing to try would tap the
 * striker up the board for ever.
 *
 * These are deliberately dumb — aim at a coin, hit it — because the simulation
 * is what judges them. A break that scatters the rack and leaves three coins
 * near pockets scores well without anyone having to describe what a good break
 * looks like.
 */
export function explorationShots(state, role, limit = 20) {
    const baselineY = baselineYFor(role);
    const targets = targetsFor(state, role);

    const placements = [];
    for (let i = 0; i < PLACEMENT_SAMPLES; i++) {
        const x = SLIDER_MIN_X + ((SLIDER_MAX_X - SLIDER_MIN_X) * i) / (PLACEMENT_SAMPLES - 1);
        if (legalPlacement(state, x, baselineY)) placements.push(x);
    }
    if (placements.length === 0) return [];

    const out = [];

    // One shot straight at each coin, from wherever the line is shortest.
    for (const coin of targets) {
        let best = null;
        for (const sx of placements) {
            const d = Math.hypot(coin.x - sx, coin.y - baselineY);
            if (!best || d < best.d) best = { sx, d };
        }
        out.push({
            strikerX: best.sx,
            angle: Math.atan2(coin.y - baselineY, best.sx === coin.x ? 0 : coin.x - best.sx),
            force: forceFor(best.d * 1.7),
            targetId: coin.id,
            quality: -best.d / 900,
        });
    }

    // And a fan, hard, from three places. This is the break: it does not aim at
    // anything in particular, which is the point — on a packed rack the useful
    // shot is the one that opens it up.
    const up = role === "creator" ? -Math.PI / 2 : Math.PI / 2;
    for (const frac of [0.2, 0.5, 0.8]) {
        const sx = placements[Math.floor((placements.length - 1) * frac)];
        for (let i = -2; i <= 2; i++) {
            out.push({
                strikerX: sx,
                angle: up + i * 0.22 * (role === "creator" ? 1 : -1),
                force: 0.9,
                targetId: null,
                quality: -1 - Math.abs(i) / 10,
            });
        }
    }

    out.sort((a, b) => b.quality - a.quality);
    return out.slice(0, limit);
}

/**
 * Every shot worth simulating.
 *
 * Both kinds, always: a board with a pot on it can still have a better break
 * available, and a board with no pot on it must still produce shots. Pot
 * attempts get the larger share of the budget because they are the ones with a
 * reason attached.
 */
export function candidateShots(state, role, limit = 40) {
    const potShare = Math.max(1, Math.round(limit * 0.65));
    const pots = potShots(state, role, potShare);
    const explore = explorationShots(state, role, limit - pots.length);
    return [...pots, ...explore];
}

/**
 * When there is nothing on: a shot that does the least harm.
 *
 * Not a pot attempt. It puts the striker somewhere legal and rolls it gently up
 * the board, which keeps the turn legal and avoids handing over a foul. The
 * planner falls back to this when no candidate survives, and it is also what a
 * board with every coin snookered deserves.
 */
export function safeShot(state, role) {
    const baselineY = baselineYFor(role);
    const up = role === "creator" ? -1 : 1;
    for (let i = 0; i < PLACEMENT_SAMPLES; i++) {
        const x = SLIDER_MIN_X + ((SLIDER_MAX_X - SLIDER_MIN_X) * i) / (PLACEMENT_SAMPLES - 1);
        if (legalPlacement(state, x, baselineY)) {
            return { strikerX: x, angle: up > 0 ? Math.PI / 2 : -Math.PI / 2, force: 0.35 };
        }
    }
    // Every legal placement blocked is not a position the rules can produce —
    // the baseline would have to be packed with coins — but a shot has to be
    // returned, so return the centre and let the server refuse it.
    return { strikerX: (SLIDER_MIN_X + SLIDER_MAX_X) / 2, angle: up > 0 ? Math.PI / 2 : -Math.PI / 2, force: 0.35 };
}
