// Transfer (teleport) animation math.  cd client && npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    scheduleTransfers, sampleTransfers, transfersDone, easeInOut,
    TRANSFER_MS, TRANSFER_STAGGER_MS,
} from "../scripts/transfers.js";

const mk = (n) =>
    Array.from({ length: n }, (_, i) => ({
        kind: "coin", id: i + 1, color: "white",
        from: { x: 0, y: 0 }, to: { x: 100, y: 0 },
    }));

test("transfers are staggered, not simultaneous", () => {
    const s = scheduleTransfers(mk(3), 1000);
    assert.equal(s[0].startAt, 1000);
    assert.equal(s[1].startAt, 1000 + TRANSFER_STAGGER_MS);
    assert.equal(s[2].startAt, 1000 + 2 * TRANSFER_STAGGER_MS);
    assert.equal(s[0].endAt, 1000 + TRANSFER_MS);
});

test("a piece waiting its turn is held at its origin, not teleported", () => {
    const s = scheduleTransfers(mk(2), 1000);
    // At t=1000 the second coin has not started: it must still be sitting in the
    // pocket, not already partway to the ledge.
    const at = sampleTransfers(s, 1000);
    assert.equal(at.length, 2);
    assert.deepEqual({ x: at[1].x, y: at[1].y }, { x: 0, y: 0 });
});

test("a piece travels from its origin to its destination", () => {
    const s = scheduleTransfers(mk(1), 0);
    assert.equal(sampleTransfers(s, 0)[0].x, 0);
    const mid = sampleTransfers(s, TRANSFER_MS / 2)[0].x;
    assert.ok(mid > 0 && mid < 100, `midpoint should be in transit, got ${mid}`);
    // Finished transfers are dropped — the authoritative state draws them now.
    assert.deepEqual(sampleTransfers(s, TRANSFER_MS), []);
});

test("easing is smooth and pinned at both ends", () => {
    assert.equal(easeInOut(0), 0);
    assert.equal(easeInOut(1), 1);
    assert.ok(Math.abs(easeInOut(0.5) - 0.5) < 1e-9);
    // Monotonic — a coin must never visibly reverse.
    let prev = -1;
    for (let t = 0; t <= 1; t += 0.05) {
        const v = easeInOut(t);
        assert.ok(v >= prev, `easing went backwards at t=${t}`);
        prev = v;
    }
});

test("done only once the last staggered piece has landed", () => {
    const s = scheduleTransfers(mk(3), 0);
    assert.equal(transfersDone(s, TRANSFER_MS), false, "later pieces are still flying");
    assert.equal(transfersDone(s, 2 * TRANSFER_STAGGER_MS + TRANSFER_MS), true);
});

test("sprites carry the colour and kind the server declared", () => {
    const s = scheduleTransfers([{
        kind: "striker", id: null, color: null,
        from: { x: 10, y: 10 }, to: { x: 20, y: 20 },
    }], 0);
    const sprite = sampleTransfers(s, 10)[0];
    assert.equal(sprite.kind, "striker");
});
