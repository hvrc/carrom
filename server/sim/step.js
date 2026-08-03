// The physics step + flick simulation loops (live timer-driven and synchronous).
import { isInsidePocket, clampStrikerX, baselineYFor, MAX_VELOCITY_FROM_FLICK } from "./geometry.js";
import {
    updateWithCCD, applyFrictionAndStop, areCirclesColliding, resolveCircleCollision, isMoving,
} from "./collision.js";
import { fullStateSnapshot, buildBroadcastFrame } from "./state.js";
import { resolveTurn } from "./rules.js";

// Below this closing speed an impact is a nudge, not a click: two coins
// settling against each other would otherwise chatter every tick.
const AUDIBLE_IMPACT = 0.9;

const TICK_MS = 16;             // 60Hz simulation
const TICK_BROADCAST_EVERY = 2; // → 30Hz frame stream
const MAX_TICKS = 60 * 15;      // hard safety cap (~15s)

// One 16ms tick: CCD integrate, friction/stop, overlap cleanup, pocket detect.
// Returns the coins/striker newly pocketed this tick.
export function step(state) {
    const { striker, coins } = state;
    const live = coins.filter(c => !c.pocketed);
    const all = striker.pocketed ? live : [striker, ...live];

    // Everything that makes a noise: pieces meeting pieces, and pieces meeting
    // the cushions. Sliding is silent because nothing is struck.
    const impacts = [];
    const onImpact = (hit) => {
        if (hit.speed < AUDIBLE_IMPACT) return;
        impacts.push(hit);
    };

    if (!striker.pocketed) updateWithCCD(striker, live, onImpact);
    for (const coin of live) {
        const others = all.filter(o => o !== coin);
        updateWithCCD(coin, others, onImpact);
    }

    if (!striker.pocketed) applyFrictionAndStop(striker);
    for (const coin of live) applyFrictionAndStop(coin);

    // overlap cleanup
    for (const coin of live) {
        if (!striker.pocketed && areCirclesColliding(striker, coin)) {
            resolveCircleCollision(striker, coin);
        }
    }
    for (let i = 0; i < live.length; i++) {
        for (let j = i + 1; j < live.length; j++) {
            if (areCirclesColliding(live[i], live[j])) {
                resolveCircleCollision(live[i], live[j]);
            }
        }
    }

    // pocket detection
    const newlyPocketed = [];
    if (!striker.pocketed) {
        const p = isInsidePocket(striker);
        if (p) {
            striker.pocketed = true;
            striker.velocity.x = 0;
            striker.velocity.y = 0;
            newlyPocketed.push({ kind: "striker", pocket: p, from: { x: striker.x, y: striker.y } });
        }
    }
    for (const coin of live) {
        const p = isInsidePocket(coin);
        if (p) {
            coin.pocketed = true;
            coin.velocity.x = 0;
            coin.velocity.y = 0;
            // `from` is the coin's exact position at capture. It matters: pocketed
            // coins are dropped from broadcast frames, so this position is never
            // streamed — without it the client would tween from a stale frame and
            // the coin would visibly cut a corner into the pocket.
            newlyPocketed.push({
                kind: "coin", id: coin.id, color: coin.color,
                pocket: p, from: { x: coin.x, y: coin.y },
            });
        }
    }

    state.lastImpacts = impacts;
    return newlyPocketed;
}

export function anythingMoving(state) {
    if (!state.striker.pocketed && isMoving(state.striker)) return true;
    for (const c of state.coins) if (!c.pocketed && isMoving(c)) return true;
    return false;
}

// Place the striker per input and apply launch velocity. Shared by the live and
// synchronous runners so they can never diverge.
function launchStriker(state, flickInput, actor) {
    state.striker.pocketed = false;
    state.striker.x = clampStrikerX(flickInput.strikerX);
    state.striker.y = baselineYFor(actor);
    const force = Math.max(0, Math.min(1, flickInput.force || 0));
    const speed = MAX_VELOCITY_FROM_FLICK * force;
    state.striker.velocity = {
        x: Math.cos(flickInput.angle) * speed,
        y: Math.sin(flickInput.angle) * speed,
    };
}

// Live, timer-driven simulation: streams frames + per-pocket events, then a
// final turnResolved. Returns a cancel handle.
export function startFlickSimulation(state, flickInput, actor, { onFrame, onPocket, onImpacts, onDone, solo = false }) {
    launchStriker(state, flickInput, actor);

    const pocketedThisTurn = [];
    const lastSent = new Map();
    let tick = 0;

    const interval = setInterval(() => {
        const newlyPocketed = step(state);
        tick += 1;

        // Stamp each pocket with the simulation time it happened at — the same
        // clock the frames carry. The client renders INTERP_DELAY ms in the past,
        // so an unstamped pocket event would start its drop tween while the coin
        // is still visibly short of the pocket (and by a different amount on each
        // client, since the error tracks latency). With `t`, the client can hold
        // the event until its render clock reaches it.
        for (const p of newlyPocketed) {
            const stamped = { ...p, t: tick * TICK_MS };
            pocketedThisTurn.push(stamped);
            onPocket && onPocket(stamped);
        }

        // Impacts carry the same sim clock as the frames, so the client can hold
        // each one until its own render clock reaches it — otherwise the sound
        // arrives before the coins are seen to touch.
        if (onImpacts && state.lastImpacts && state.lastImpacts.length > 0) {
            onImpacts({ t: tick * TICK_MS, hits: state.lastImpacts });
        }

        if (tick % TICK_BROADCAST_EVERY === 0) {
            onFrame && onFrame(buildBroadcastFrame(state, lastSent, tick * TICK_MS));
        }

        const stillMoving = anythingMoving(state);
        if (!stillMoving || tick >= MAX_TICKS) {
            clearInterval(interval);
            onFrame && onFrame(buildBroadcastFrame(state, lastSent, tick * TICK_MS));
            const resolution = resolveTurn(state, pocketedThisTurn, actor, { solo });
            onDone && onDone({ ...resolution, pocketedThisTurn }, fullStateSnapshot(state));
        }
    }, TICK_MS);

    return () => clearInterval(interval);
}

// Synchronous twin of startFlickSimulation: runs the identical loop with no
// timers. Used by tests and as a determinism oracle.
export function simulateFlickSync(state, flickInput, actor, { solo = false } = {}) {
    launchStriker(state, flickInput, actor);
    const pocketedThisTurn = [];
    const frames = [];
    const lastSent = new Map();
    let tick = 0;
    while (true) {
        const newlyPocketed = step(state);
        for (const p of newlyPocketed) pocketedThisTurn.push(p);
        tick += 1;
        if (tick % TICK_BROADCAST_EVERY === 0) frames.push(buildBroadcastFrame(state, lastSent, tick * TICK_MS));
        if (!anythingMoving(state) || tick >= MAX_TICKS) {
            frames.push(buildBroadcastFrame(state, lastSent, tick * TICK_MS));
            const resolution = resolveTurn(state, pocketedThisTurn, actor, { solo });
            return {
                frames,
                pocketedThisTurn,
                resolution: { ...resolution, pocketedThisTurn },
                fullState: fullStateSnapshot(state),
                ticks: tick,
            };
        }
    }
}
