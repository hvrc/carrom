// Pure flick/aim math tests.  cd client && npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { toCanvasCoords, flickEndpoint, flickVector, FLICK_DEAD_ZONE } from "../scripts/flickMath.js";

const rect = (left, top, w, h) => ({ left, top, width: w, height: h });

test("toCanvasCoords corrects for CSS scaling", () => {
    // canvas is 900x900 but displayed at 450x450 (scale 0.5) at origin
    const p = toCanvasCoords(225, 225, rect(0, 0, 450, 450), 900, 900, "creator");
    assert.equal(p.x, 450);
    assert.equal(p.y, 450);
});

test("toCanvasCoords accounts for the rect offset", () => {
    const p = toCanvasCoords(110, 60, rect(10, 10, 900, 900), 900, 900, "creator");
    assert.equal(p.x, 100);
    assert.equal(p.y, 50);
});

test("toCanvasCoords flips 180° for the joiner", () => {
    const p = toCanvasCoords(100, 50, rect(0, 0, 900, 900), 900, 900, "joiner");
    assert.equal(p.x, 800);
    assert.equal(p.y, 850);
});

test("flickEndpoint applies drag delta from the striker centre", () => {
    // striker at (450,700), pointer down at (450,700), moved to (470,760)
    const e = flickEndpoint(450, 700, 450, 700, 470, 760, 100);
    assert.equal(e.x, 470);
    assert.equal(e.y, 760);
});

test("flickEndpoint caps the line at maxLength", () => {
    // drag delta (300,0) but maxLength 100 → capped to 100 along x
    const e = flickEndpoint(450, 700, 0, 0, 300, 0, 100);
    assert.equal(Math.round(Math.hypot(e.x - 450, e.y - 700)), 100);
    assert.equal(e.x, 550);
});

test("flickVector points OPPOSITE the drag (slingshot) and clamps force", () => {
    // flick line from striker (450,700) dragged DOWN to (450,800):
    // release should fire UP (negative y), full force at maxLength 100.
    const v = flickVector(450, 700, 450, 800, 100);
    assert.equal(v.force, 1);
    // angle pointing up: dy = start-end = -100 → atan2(-100,0) = -PI/2
    assert.ok(Math.abs(v.angle + Math.PI / 2) < 1e-9);
});

test("flickVector force is proportional and clamped to 1", () => {
    assert.equal(flickVector(0, 0, 0, 50, 100).force, 0.5);
    assert.equal(flickVector(0, 0, 0, 500, 100).force, 1);
    assert.equal(flickVector(0, 0, 0, 0, 100).force, 0);
});

test("dead zone is a small positive threshold", () => {
    assert.ok(FLICK_DEAD_ZONE > 0 && FLICK_DEAD_ZONE < 20);
});
