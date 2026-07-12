// Pure math for "a piece moves from A to B" animations — the teleports the
// server declares at the end of a turn (coin → ledge, striker → the opponent's
// baseline, a refunded coin → the centre). No DOM, no state; unit-tested in
// client/test/transfers.test.js.
//
// These are PRESENTATION ONLY. By the time a transfer plays, the authoritative
// state already has the piece at its destination; the tween just shows it
// getting there. Nothing here may ever be read back as a source of position —
// that inversion is what made the pocket animation wrong (see the PRD, §3.1).

export const TRANSFER_MS = 380;      // how long one piece takes to travel
export const TRANSFER_STAGGER_MS = 110; // gap between consecutive pieces

// Pin each transfer to a wall-clock window. Staggered so two coins pocketed on
// the same flick walk to the ledge one after the other rather than overlapping.
export function scheduleTransfers(transfers, now) {
    return transfers.map((tr, i) => ({
        ...tr,
        startAt: now + i * TRANSFER_STAGGER_MS,
        endAt: now + i * TRANSFER_STAGGER_MS + TRANSFER_MS,
    }));
}

// Ease in and out — a coin being placed on the ledge accelerates away and
// settles, rather than starting and stopping dead.
export function easeInOut(t) {
    return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
}

// The sprites to draw at `now`. A transfer that hasn't started yet is held at
// its origin (the coin sits in the pocket, waiting its turn); a finished one is
// dropped, because the authoritative state now draws it (on the ledge, or back
// on the board).
export function sampleTransfers(scheduled, now) {
    const out = [];
    for (const tr of scheduled) {
        if (now >= tr.endAt) continue;
        const span = tr.endAt - tr.startAt;
        const raw = now <= tr.startAt ? 0 : (now - tr.startAt) / span;
        const e = easeInOut(Math.max(0, Math.min(1, raw)));
        out.push({
            kind: tr.kind,
            id: tr.id,
            color: tr.color,
            x: tr.from.x + (tr.to.x - tr.from.x) * e,
            y: tr.from.y + (tr.to.y - tr.from.y) * e,
        });
    }
    return out;
}

export function transfersDone(scheduled, now) {
    return scheduled.every((tr) => now >= tr.endAt);
}
