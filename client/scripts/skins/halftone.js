// SKIN: breathing halftone — a grid of dots whose size is driven by a field of
// slow travelling waves, so the whole surface swells and settles like something
// alive under the board.
//
// Dots are coloured by their own size, palest when small and deepest when full,
// so the swells read as depth in colour as well as in scale.
//
// The field is three sine waves layered on top of each other: two long diagonal
// swells running in opposite directions, and a slow radial pulse out of the
// centre. Their phases are deliberately not multiples of one another, so the
// pattern never visibly repeats — it drifts.
//
// The pieces press into it. Every live coin and the striker carry a well that
// pushes the dots under them down towards nothing, and the faster a piece is
// travelling the wider its well opens — so a hard shot tears a visible channel
// across the field and the surface closes again behind it.
//
// Cheap by construction: one arc per cell, and the only state is last frame's
// positions, kept so speed can be derived without the physics telling us.

import { theme } from "../theme.js";

const FRAME = 900;
const BOARD = 750;
const B0 = (FRAME - BOARD) / 2;   // 75 — board's left/top edge
const CX = B0 + BOARD / 2;
const CY = CX;
const TAU = Math.PI * 2;

const cfg = () => theme.skin.halftone;

// Colour by size: the ramp is walked from the pale end for the smallest dots to
// the deep end for the fullest. Quantised into steps and cached, so a frame
// costs a handful of colour strings instead of one per dot.
const RAMP_STEPS = 24;
let rampKey = null;
let rampCache = [];

const hexToRgb = (hex) => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
];

function rampFor(stops) {
    const key = stops.join();
    if (key === rampKey) return rampCache;

    const rgb = stops.map(hexToRgb);
    const out = [];
    for (let i = 0; i < RAMP_STEPS; i++) {
        // Where this step falls along the ramp, and between which two stops.
        const t = (i / (RAMP_STEPS - 1)) * (rgb.length - 1);
        const lo = Math.min(Math.floor(t), rgb.length - 2);
        const f = t - lo;
        const c = rgb[lo].map((v, k) => Math.round(v + (rgb[lo + 1][k] - v) * f));
        out.push(`rgb(${c[0]},${c[1]},${c[2]})`);
    }
    rampKey = key;
    rampCache = out;
    return out;
}

// The wave field at a point, in 0..1. Everything about the movement lives here:
// `speed` scales time, the three terms are the two swells and the pulse.
function amplitude(x, y, t, s) {
    const dx = x - CX;
    const dy = y - CY;
    const d = Math.hypot(dx, dy);

    const swellA = Math.sin((dx + dy) * 0.0075 - t * 0.45);
    const swellB = Math.sin((dx - dy) * 0.0058 + t * 0.31);
    const pulse = Math.sin(d * 0.019 - t * 0.62);

    // Weighted so no single wave dominates, then folded into 0..1.
    const v = (swellA * 0.42 + swellB * 0.34 + pulse * 0.5) / 1.26;
    return 0.5 + 0.5 * v * s;
}

// Last frame's positions, so a piece's speed can be derived here rather than
// plumbed through from the physics.
let lastSeen = new Map();

// Turn the live pieces into wells: a centre, a radius, and a depth. A still
// piece presses a small dimple; a fast one opens a wide, deep well.
function wellsFrom(pieces, c) {
    const wells = [];
    const seen = new Map();

    for (const p of pieces) {
        const before = lastSeen.get(p.id);
        const speed = before ? Math.hypot(p.x - before.x, p.y - before.y) : 0;
        seen.set(p.id, { x: p.x, y: p.y });

        // Speed is per frame; a hard shot moves tens of pixels a frame.
        const rush = Math.min(1, speed / 22);
        wells.push({
            x: p.x,
            y: p.y,
            radius: c.wellRadius * (1 + rush * 1.6),
            depth: Math.min(1, c.wellDepth * (1 + rush * 0.5)),
        });
    }

    lastSeen = seen;
    return wells;
}

/**
 * The skin contract: draw(ctx, { time, pieces }) into board space, beneath the
 * pieces themselves. `time` is milliseconds; `pieces` is every live coin and the
 * striker, as { id, x, y }.
 */
function draw(ctx, { time = 0, pieces = [] } = {}) {
    const c = cfg();
    const t = time / 1000;
    const pitch = c.grid;
    const maxR = c.dot / 2;
    const wells = wellsFrom(pieces, c);
    const ramp = rampFor(c.ramp);

    ctx.save();

    // Inset by half a pitch so the grid sits evenly inside the playing surface.
    for (let y = B0 + pitch / 2; y < B0 + BOARD; y += pitch) {
        for (let x = B0 + pitch / 2; x < B0 + BOARD; x += pitch) {
            const a = amplitude(x, y, t, c.contrast);

            // How far down the pieces press this dot: the deepest well wins,
            // rather than summing, so a cluster of coins does not punch a hole
            // bigger than the coins themselves.
            let press = 0;
            for (const w of wells) {
                const dx = x - w.x;
                const dy = y - w.y;
                const d2 = dx * dx + dy * dy;
                const r2 = w.radius * w.radius;
                if (d2 >= r2) continue;
                // Smooth falloff to nothing at the rim, so there is no hard edge.
                const k = 1 - d2 / r2;
                press = Math.max(press, w.depth * k * k);
            }
            if (press >= 0.995) continue;

            const swell = c.floor + (1 - c.floor) * a * a;
            const size = swell * (1 - press);      // 0..1, and the ramp's index
            const r = maxR * size;
            if (r < 0.25) continue;
            ctx.fillStyle = ramp[Math.min(RAMP_STEPS - 1, Math.round(size * (RAMP_STEPS - 1)))];
            ctx.globalAlpha = (c.minAlpha + (1 - c.minAlpha) * a) * (1 - press * 0.8);
            ctx.beginPath();
            ctx.arc(x, y, r, 0, TAU);
            ctx.fill();
        }
    }

    ctx.restore();
}

export default { name: "halftone", animated: true, draw };
