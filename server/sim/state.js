// Game-state factories, respawn, and wire snapshots. No physics stepping here.
import {
    COIN_RADIUS, COIN_MASS, COIN_RESTITUTION, COIN_FRICTION,
    STRIKER_RADIUS, STRIKER_MASS, STRIKER_RESTITUTION, STRIKER_FRICTION,
    CENTER_X, CENTER_Y, BOTTOM_BASELINE_Y,
} from "./geometry.js";

export function makeCoin(id, color, x, y) {
    return {
        id,
        color, // "white" | "black" | "red"
        x,
        y,
        velocity: { x: 0, y: 0 },
        radius: COIN_RADIUS,
        coinMass: COIN_MASS,
        restitution: COIN_RESTITUTION,
        friction: COIN_FRICTION,
        pocketed: false,
    };
}

export function makeStriker(x, y) {
    return {
        x,
        y,
        velocity: { x: 0, y: 0 },
        radius: STRIKER_RADIUS,
        strikerMass: STRIKER_MASS,
        restitution: STRIKER_RESTITUTION,
        friction: STRIKER_FRICTION,
        pocketed: false,
    };
}

export function createCoinFormation() {
    const coins = [];
    let id = 1;
    let colorIndex = 1;
    const rings = [
        { count: 6, radius: 32 },
        { count: 12, radius: 62 },
    ];
    for (const ring of rings) {
        for (let i = 0; i < ring.count; i++) {
            const angle = i * ((2 * Math.PI) / ring.count);
            const x = CENTER_X + ring.radius * Math.cos(angle);
            const y = CENTER_Y + ring.radius * Math.sin(angle);
            const color = colorIndex % 2 ? "white" : "black";
            coins.push(makeCoin(id++, color, x, y));
            colorIndex++;
        }
    }
    coins.push(makeCoin(id++, "red", CENTER_X, CENTER_Y));
    return coins;
}

export function createInitialState() {
    return {
        coins: createCoinFormation(),
        striker: makeStriker(CENTER_X, BOTTOM_BASELINE_Y),
        whoseTurn: "creator",
        scores: { creator: 0, joiner: 0 },
        debts: { creator: 0, joiner: 0 },
        // pocketed pile = list of {id, color} per player; used to refund a coin on striker-foul.
        pocketedPiles: { creator: [], joiner: [] },
        // queen state machine: "on_board" | "pocketed_uncovered" | "covered"
        queenState: "on_board",
        queenPocketedBy: null,
        continuedTurnCount: 0,
        gameOver: false,
        winner: null,
    };
}

// Respawn a single coin at (or near) the centre without overlapping live coins.
// Reuses the requested id if it exists and is pocketed (e.g. queen=19), else mints one.
export function respawnAtCenter(state, color, preferredId = null) {
    const live = state.coins.filter(c => !c.pocketed);
    let cx = CENTER_X;
    let cy = CENTER_Y;
    for (let r = 0; r < 200; r += COIN_RADIUS) {
        const tries = r === 0 ? 1 : 8;
        for (let i = 0; i < tries; i++) {
            const a = (i / tries) * Math.PI * 2;
            const tx = CENTER_X + r * Math.cos(a);
            const ty = CENTER_Y + r * Math.sin(a);
            const blocked = live.some(c => Math.hypot(c.x - tx, c.y - ty) < COIN_RADIUS * 2 + 1);
            if (!blocked) { cx = tx; cy = ty; r = 9999; break; }
        }
    }

    let coin = preferredId != null ? state.coins.find(c => c.id === preferredId && c.pocketed) : null;
    if (coin) {
        coin.pocketed = false;
        coin.color = color;
        coin.x = cx;
        coin.y = cy;
        coin.velocity = { x: 0, y: 0 };
    } else {
        const newId = Math.max(0, ...state.coins.map(c => c.id)) + 1;
        coin = makeCoin(newId, color, cx, cy);
        state.coins.push(coin);
    }
    return coin;
}

// ---------- Wire snapshots ----------

export function frameSnapshot(state) {
    return {
        coins: state.coins
            .filter(c => !c.pocketed)
            .map(c => ({ id: c.id, x: c.x, y: c.y })),
        striker: state.striker.pocketed ? null : { x: state.striker.x, y: state.striker.y },
    };
}

// Streaming frame: integer-quantized + delta-encoded. Only coins whose rounded
// position changed since the previous broadcast are included (`lastSent` is
// mutated to track them); `t` is a monotonic per-flick timestamp (ms) used by
// the client's interpolation buffer. The first broadcast of a flick naturally
// includes every live coin (lastSent is empty), seeding the client.
export function buildBroadcastFrame(state, lastSent, t) {
    const coins = [];
    for (const c of state.coins) {
        if (c.pocketed) continue;
        const qx = Math.round(c.x);
        const qy = Math.round(c.y);
        const prev = lastSent.get(c.id);
        if (!prev || prev.x !== qx || prev.y !== qy) {
            coins.push({ id: c.id, x: qx, y: qy });
            lastSent.set(c.id, { x: qx, y: qy });
        }
    }
    const striker = state.striker.pocketed
        ? null
        : { x: Math.round(state.striker.x), y: Math.round(state.striker.y) };
    return { t, coins, striker };
}

export function fullStateSnapshot(state) {
    return {
        coins: state.coins.map(c => ({
            id: c.id, color: c.color, x: c.x, y: c.y, pocketed: c.pocketed,
        })),
        striker: { x: state.striker.x, y: state.striker.y },
        whoseTurn: state.whoseTurn,
        scores: { ...state.scores },
        debts: { ...state.debts },
        pocketedPiles: {
            creator: [...state.pocketedPiles.creator],
            joiner: [...state.pocketedPiles.joiner],
        },
        queenState: state.queenState,
        queenPocketedBy: state.queenPocketedBy,
        continuedTurnCount: state.continuedTurnCount,
        gameOver: state.gameOver,
        winner: state.winner,
    };
}
