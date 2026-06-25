// Pure interpolation unit tests.  cd client && npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { sampleBuffer, lerpSnapshots, pruneBuffer, INTERP_DELAY } from "../scripts/interpolate.js";

const snap = (t, x, sx) => ({ t, coins: [{ id: 1, x, y: x }], striker: { x: sx, y: sx } });

test("INTERP_DELAY is a sane positive value", () => {
    assert.ok(INTERP_DELAY > 0 && INTERP_DELAY <= 250);
});

test("lerpSnapshots is exact at alpha 0, 0.5, 1", () => {
    const s0 = snap(0, 0, 10);
    const s1 = snap(100, 100, 30);
    assert.deepEqual(lerpSnapshots(s0, s1, 0).coins[0], { id: 1, x: 0, y: 0 });
    assert.deepEqual(lerpSnapshots(s0, s1, 1).coins[0], { id: 1, x: 100, y: 100 });
    const mid = lerpSnapshots(s0, s1, 0.5);
    assert.equal(mid.coins[0].x, 50);
    assert.equal(mid.striker.x, 20);
});

test("lerpSnapshots clamps alpha to [0,1]", () => {
    const s0 = snap(0, 0, 0);
    const s1 = snap(100, 100, 100);
    assert.equal(lerpSnapshots(s0, s1, -1).coins[0].x, 0);
    assert.equal(lerpSnapshots(s0, s1, 2).coins[0].x, 100);
});

test("sampleBuffer picks the bracketing pair and interpolates", () => {
    const buf = [snap(0, 0, 0), snap(100, 100, 100), snap(200, 200, 200)];
    const r = sampleBuffer(buf, 150); // between 100 and 200 → 150
    assert.equal(r.coins[0].x, 150);
    assert.equal(r.striker.x, 150);
});

test("sampleBuffer holds the newest snapshot past the end (no extrapolation)", () => {
    const buf = [snap(0, 0, 0), snap(100, 100, 100)];
    const r = sampleBuffer(buf, 500); // way past newest
    assert.equal(r.coins[0].x, 100, "held at newest, not extrapolated past it");
    assert.equal(r.striker.x, 100);
});

test("sampleBuffer returns the oldest snapshot before the start", () => {
    const buf = [snap(100, 100, 100), snap(200, 200, 200)];
    const r = sampleBuffer(buf, 0);
    assert.equal(r.coins[0].x, 100);
});

test("sampleBuffer handles empty and single-element buffers", () => {
    assert.equal(sampleBuffer([], 10), null);
    const r = sampleBuffer([snap(5, 7, 9)], 999);
    assert.equal(r.coins[0].x, 7);
    assert.equal(r.striker.x, 9);
});

test("a coin missing from the later snapshot holds its earlier position", () => {
    const s0 = { t: 0, coins: [{ id: 1, x: 0, y: 0 }, { id: 2, x: 50, y: 50 }], striker: null };
    const s1 = { t: 100, coins: [{ id: 1, x: 100, y: 100 }], striker: null };
    const r = lerpSnapshots(s0, s1, 0.5);
    const c2 = r.coins.find((c) => c.id === 2);
    assert.deepEqual(c2, { id: 2, x: 50, y: 50 });
});

test("pruneBuffer keeps the bracket endpoint and everything after", () => {
    const buf = [snap(0, 0, 0), snap(100, 0, 0), snap(200, 0, 0), snap(300, 0, 0)];
    pruneBuffer(buf, 250); // newest <=250 is t=200 → keep [200,300]
    assert.deepEqual(buf.map((s) => s.t), [200, 300]);
});

test("pruneBuffer never empties the buffer", () => {
    const buf = [snap(0, 0, 0), snap(100, 0, 0)];
    pruneBuffer(buf, 99999);
    assert.ok(buf.length >= 1);
});
