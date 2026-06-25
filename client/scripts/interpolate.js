// Pure snapshot-interpolation helpers — no DOM, unit-tested in client/test.
// Decouples rendering from network arrival: the render loop samples a buffer of
// timestamped snapshots at `now - INTERP_DELAY`, lerping the two snapshots that
// bracket that time. On a gap (render time past the newest snapshot) it HOLDS
// the newest rather than extrapolating — rigid-body coins change direction on
// every collision, so extrapolation would shoot them through cushions.
// (research §C1)
//
// A snapshot: { t:number, coins:[{id,x,y}], striker:{x,y}|null }

export const INTERP_DELAY = 100; // ms behind the newest snapshot

// Return interpolated positions { coins:[{id,x,y}], striker } at renderTime.
// null if the buffer is empty.
export function sampleBuffer(buffer, renderTime) {
    if (!buffer || buffer.length === 0) return null;
    if (buffer.length === 1) return positionsOf(buffer[0]);

    const first = buffer[0];
    const last = buffer[buffer.length - 1];
    if (renderTime <= first.t) return positionsOf(first);
    if (renderTime >= last.t) return positionsOf(last); // hold, don't extrapolate

    let s0 = first;
    let s1 = buffer[1];
    for (let i = 0; i < buffer.length - 1; i++) {
        if (buffer[i].t <= renderTime && renderTime <= buffer[i + 1].t) {
            s0 = buffer[i];
            s1 = buffer[i + 1];
            break;
        }
    }
    const span = s1.t - s0.t;
    const alpha = span > 0 ? (renderTime - s0.t) / span : 0;
    return lerpSnapshots(s0, s1, alpha);
}

// Linear interpolation between two snapshots. Coins present in s0 are matched to
// s1 by id; a coin missing from s1 holds its s0 position.
export function lerpSnapshots(s0, s1, alpha) {
    const a = clamp01(alpha);
    const s1ById = new Map(s1.coins.map((c) => [c.id, c]));
    const coins = s0.coins.map((c) => {
        const c1 = s1ById.get(c.id);
        if (!c1) return { id: c.id, x: c.x, y: c.y };
        return { id: c.id, x: c.x + (c1.x - c.x) * a, y: c.y + (c1.y - c.y) * a };
    });
    let striker = null;
    if (s0.striker && s1.striker) {
        striker = {
            x: s0.striker.x + (s1.striker.x - s0.striker.x) * a,
            y: s0.striker.y + (s1.striker.y - s0.striker.y) * a,
        };
    } else {
        striker = s1.striker || s0.striker || null;
    }
    return { coins, striker };
}

// Drop snapshots we no longer need: keep the latest one at-or-before renderTime
// (it's still a bracket endpoint) and everything after it. Mutates + returns.
export function pruneBuffer(buffer, renderTime) {
    let keepFrom = 0;
    for (let i = 0; i < buffer.length - 1; i++) {
        if (buffer[i + 1].t <= renderTime) keepFrom = i + 1;
        else break;
    }
    if (keepFrom > 0) buffer.splice(0, keepFrom);
    return buffer;
}

function positionsOf(s) {
    return {
        coins: s.coins.map((c) => ({ id: c.id, x: c.x, y: c.y })),
        striker: s.striker ? { x: s.striker.x, y: s.striker.y } : null,
    };
}

function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}
