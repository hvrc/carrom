// The board's decoration, worked in dots.
//
// The technique: every motif is a curve, resampled at even arc length and set
// with a round dot at each step. Even spacing is what makes it read as an
// embroidered or plotted line rather than as pixels — the dots stay the same
// distance apart through a tight curl and a long sweep alike.
//
// Two touches do most of the rest. Dots TAPER towards the end of a stroke, so
// stems and curls trail off instead of stopping dead. And a deterministic hash
// works the occasional smaller dot in an accent colour into the run, the way a
// sampler has a contrast thread run through it.
//
// The composition is radial: one motif, repeated around the centre, never
// closed into a continuous ring. Rings are the enemy of this style — the
// reference is a set of separate flourishes with air between them, so the
// arcs here are drawn as broken segments with deliberate gaps.
//
// The vocabulary is small on purpose: a stem, a curl, a leaf, a flower head.
// Everything on the board is those four, turned about the middle.
//
// Decoration only: drawn beneath the baselines and the pieces, and nothing in
// the game reads it.

import { theme } from "./theme.js";

const FRAME = 900;
const BOARD = 750;
const B0 = (FRAME - BOARD) / 2;   // 75 — board's left/top edge
const CX = B0 + BOARD / 2;        // 450
const CY = CX;

const cfg = () => theme.ornament;
const TAU = Math.PI * 2;

// Deterministic per-cell noise, and the reason the glyph mix looks *woven*
// rather than random: the cell is first folded into the dihedral canonical
// position about the centre — |dx|, |dy|, larger first — so all eight cells of
// a symmetry orbit hash alike. Two motifs that are reflections of each other
// therefore get the same marks in the same places, and the four pocket lines
// come out identical instead of merely parallel.
function hash(x, y) {
    const a = Math.abs(x - CX);
    const b = Math.abs(y - CY);
    const u = Math.round(Math.max(a, b) * 4);
    const v = Math.round(Math.min(a, b) * 4);
    return (((u * 73856093) ^ (v * 19349663)) >>> 0) / 4294967295;
}

// Rounding that is symmetric about zero. Math.round breaks ties upwards, so
// round(-2.5) is -2 while round(2.5) is 3 — under a quarter turn that shifts
// half the cells by one and the symmetry falls apart.
const rnd = (v) => (v < 0 ? -Math.round(-v) : Math.round(v));

// ── laying dots along a path ───────────────────────────────────────────────

// Walk a polyline and emit a point every `spacing` of arc length, so curvature
// never changes the rhythm. Returns [x, y, t] with t the fraction travelled,
// which is what the taper reads.
function resample(pts, spacing) {
    const out = [];
    if (pts.length < 2) return out;

    const seg = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
        const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        seg.push(d);
        total += d;
    }
    if (total === 0) return out;

    let travelled = 0;
    let next = 0;
    for (let i = 1; i < pts.length; i++) {
        const d = seg[i - 1];
        while (d > 0 && next <= travelled + d) {
            const f = (next - travelled) / d;
            out.push([
                pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f,
                pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f,
                next / total,
            ]);
            next += spacing;
        }
        travelled += d;
    }
    return out;
}

// One mark. Mostly a pixel square — that is what gives the cross-stitch read —
// with the odd small square, plus, triangle or round worked in. Which lands
// where is hashed off the position, so it is stable frame to frame.
function mark(ctx, x, y, size, colour, h) {
    const r = size / 2;
    ctx.fillStyle = colour;

    if (h > 0.965) {                       // plus
        const t = size * 0.34;
        ctx.fillRect(x - r, y - t / 2, size, t);
        ctx.fillRect(x - t / 2, y - r, t, size);
    } else if (h > 0.925) {                // triangle
        ctx.beginPath();
        ctx.moveTo(x, y - r);
        ctx.lineTo(x + r, y + r * 0.8);
        ctx.lineTo(x - r, y + r * 0.8);
        ctx.closePath();
        ctx.fill();
    } else if (h > 0.90) {                 // round
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.fill();
    } else if (h > 0.82) {                 // small square
        ctx.fillRect(x - r * 0.62, y - r * 0.62, size * 0.62, size * 0.62);
    } else {                               // pixel
        ctx.fillRect(x - r, y - r, size, size);
    }
}

// Every mark on the board is snapped to ONE lattice, in board coordinates.
// Motifs drawn inside a rotation therefore still land on the same grid as
// everything else — which is what makes separate flourishes read as one piece
// of stitching rather than as unrelated dotted lines. `laid` remembers the
// cells already used so crossing strokes never double up.
let laid = new Set();

// Set a run of marks along a path: resample it finely, snap each sample to the
// lattice, drop repeats, stamp what is left. `taper` shrinks the marks towards
// the end of the stroke ("out"), the start ("in"), or both ends.
function dots(ctx, pts, o = {}) {
    const c = cfg();
    const g = c.grid;
    const base = o.size || c.dot;
    const taper = o.taper || "none";
    // Sample well under the grid pitch so a snapped run comes out contiguous.
    const step = (o.spacing || g) * 0.55;

    // Snapping happens in board space, so read the live transform and undo it.
    const m = ctx.getTransform();
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    for (const [x, y, t] of resample(pts, step)) {
        const wx = m.a * x + m.c * y + m.e;
        const wy = m.b * x + m.d * y + m.f;
        // Snap RELATIVE TO THE CENTRE, so the lattice turns with the board.
        const gx = CX + rnd((wx - CX) / g) * g;
        const gy = CY + rnd((wy - CY) / g) * g;
        const key = `${gx},${gy}`;
        if (laid.has(key)) continue;
        laid.add(key);

        let k = 1;
        if (taper === "out") k = 1 - 0.42 * t;
        else if (taper === "in") k = 0.58 + 0.42 * t;
        else if (taper === "both") k = 1 - 0.38 * Math.abs(t * 2 - 1);

        const h = hash(gx, gy);
        let colour = o.colour || c.primary;
        let size = base * k;

        if (o.accent !== false && h > 0.965) { colour = c.accentA; size *= 0.85; }
        else if (o.accent !== false && h > 0.925) { colour = c.accentB; size *= 0.8; }

        if (size < 1) continue;
        mark(ctx, gx, gy, size, colour, o.accent === false ? Math.min(h, 0.81) : h);
    }
    ctx.restore();
}

// ── curves ─────────────────────────────────────────────────────────────────

const bezier = (p0, p1, p2, p3, n = 160) => {
    const out = [];
    for (let i = 0; i <= n; i++) {
        const t = i / n, u = 1 - t;
        out.push([
            u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
            u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
        ]);
    }
    return out;
};

const spiralPts = (cx, cy, r0, r1, a0, turns, dir = 1, n = 150) => {
    const out = [];
    for (let i = 0; i <= n; i++) {
        const t = i / n;
        const a = a0 + dir * t * turns * TAU;
        const r = r0 + (r1 - r0) * t;
        out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return out;
};

const arcPts = (cx, cy, r, a0, a1, n = 200) => {
    const out = [];
    for (let i = 0; i <= n; i++) {
        const a = a0 + (a1 - a0) * (i / n);
        out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return out;
};

// ── motifs ─────────────────────────────────────────────────────────────────

// A curl that unwinds outwards and thins as it goes — the terminal of nearly
// every scroll in this style.
const curl = (ctx, cx, cy, r, a0, dir, o = {}) =>
    dots(ctx, spiralPts(cx, cy, r * 0.08, r, a0, 0.9, dir), { taper: "in", ...o });

// A leaf: two arcs meeting at the tips, hollow, with a finer midrib.
function leaf(ctx, x0, y0, x1, y1, bulge, o = {}) {
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    for (const s of [1, -1]) {
        dots(ctx, bezier([x0, y0],
            [mx + nx * bulge * s, my + ny * bulge * s],
            [mx + nx * bulge * s, my + ny * bulge * s],
            [x1, y1], 80), { taper: "both", ...o });
    }
    dots(ctx, [[x0, y0], [x1, y1]],
        { size: cfg().dot * 0.55, spacing: cfg().spacing * 1.6, ...o });
}

// A flower head: a solid eye, a ring of petals, a halo of fine dots. The step
// from solid to fine is what gives the reference its depth.
function flower(ctx, cx, cy, r, petals = 8) {
    const c = cfg();
    for (let rr = r * 0.26; rr > 0.5; rr -= c.spacing * 0.95) {
        dots(ctx, arcPts(cx, cy, rr, 0, TAU, 140), { spacing: c.spacing * 0.78, accent: false });
    }
    for (let i = 0; i < petals; i++) {
        const a = (i / petals) * TAU;
        dots(ctx, arcPts(cx + r * 0.62 * Math.cos(a), cy + r * 0.62 * Math.sin(a), r * 0.22, 0, TAU, 70),
            { spacing: c.spacing * 0.85 });
    }
    dots(ctx, arcPts(cx, cy, r * 1.05, 0, TAU, 180),
        { size: c.dot * 0.6, spacing: c.spacing * 1.4 });
}

// ── gothic vocabulary ──────────────────────────────────────────────────────

// A lancet: the pointed arch of a window light. Two flanks rising to a point.
function lancet(ctx, cx, cy, w, h, rot = 0) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    for (const s of [1, -1]) {
        dots(ctx, bezier([s * w, h * 0.5], [s * w, -h * 0.15], [s * w * 0.62, -h * 0.55], [0, -h * 0.5], 140));
    }
    dots(ctx, [[-w, h * 0.5], [w, h * 0.5]]);
    ctx.restore();
}

// A foil: `lobes` circles set around a point — the trefoil and quatrefoil that
// fill the head of every gothic window.
function foil(ctx, cx, cy, r, lobes = 4, rot = 0) {
    for (let i = 0; i < lobes; i++) {
        const a = rot + (i / lobes) * TAU;
        dots(ctx, arcPts(cx + r * 0.62 * Math.cos(a), cy + r * 0.62 * Math.sin(a), r * 0.46, 0, TAU, 90));
    }
    dots(ctx, arcPts(cx, cy, r * 0.18, 0, TAU, 40));
}

// A star polygon: `points` on a circle, each joined to the one `skip` along.
// Overlapping squares and hexagrams are how rose-window tracery is set out.
function starPolygon(ctx, r, points, skip) {
    for (let i = 0; i < points; i++) {
        const a0 = (i / points) * TAU - Math.PI / 2;
        const a1 = ((i + skip) / points) * TAU - Math.PI / 2;
        dots(ctx, [[CX + r * Math.cos(a0), CY + r * Math.sin(a0)],
                   [CX + r * Math.cos(a1), CY + r * Math.sin(a1)]], { taper: "both" });
    }
}

// A moth, seen from above: a pair of wings, a body, two antennae. The insect
// detail the style is fond of, and the one motif here that is not symmetrical
// about every axis — only about its own.
function moth(ctx, cx, cy, s, rot = 0) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    for (const side of [1, -1]) {
        // Forewing, then hindwing, each an outline with a fold line inside it.
        dots(ctx, bezier([0, -s * 0.5], [side * s * 1.15, -s * 1.0],
            [side * s * 1.3, s * 0.05], [0, s * 0.1], 180));
        dots(ctx, bezier([0, s * 0.05], [side * s * 0.95, s * 0.25],
            [side * s * 0.8, s * 0.95], [0, s * 0.62], 160));
        dots(ctx, bezier([0, -s * 0.3], [side * s * 0.55, -s * 0.4],
            [side * s * 0.75, -s * 0.05], [side * s * 0.5, s * 0.02], 110),
            { size: cfg().dot * 0.72 });
        dots(ctx, bezier([0, -s * 0.62], [side * s * 0.3, -s * 0.9],
            [side * s * 0.5, -s * 1.05], [side * s * 0.62, -s * 1.25], 90), { taper: "out" });
    }
    dots(ctx, arcPts(0, s * 0.05, s * 0.16, 0, TAU, 70));      // thorax
    dots(ctx, bezier([0, -s * 0.5], [0, -s * 0.1], [0, s * 0.3], [0, s * 0.72], 90));
    ctx.restore();
}

// A broken ring: `count` arcs with a gap left between each, so the eye reads a
// rhythm of separate strokes rather than one closed loop.
function brokenRing(ctx, r, count, coverage, o = {}) {
    const stepA = TAU / count;
    const span = stepA * coverage;
    for (let i = 0; i < count; i++) {
        const a0 = i * stepA + (stepA - span) / 2 + (o.phase || 0);
        dots(ctx, arcPts(CX, CY, r, a0, a0 + span, 160), { taper: "both", ...o });
    }
}

// ── composition ────────────────────────────────────────────────────────────

// Repeat a motif `count` times about the centre. Everything on the board is
// laid out with this, which is where the radial symmetry comes from.
function radial(ctx, count, fn, phase = 0) {
    for (let i = 0; i < count; i++) {
        ctx.save();
        ctx.translate(CX, CY);
        ctx.rotate(phase + (i / count) * TAU);
        ctx.translate(-CX, -CY);
        fn(i);
        ctx.restore();
    }
}

// The centre: eight flourishes turned about the middle, each a stem with a pair
// of curled leaves and a flower at its head, sitting just outside the rack.
// Between them, two broken rings for rhythm.
function crown(ctx) {
    brokenRing(ctx, 112, 8, 0.62, { size: cfg().dot * 0.8 });

    radial(ctx, 8, () => {
        // Local frame: straight up from the centre.
        const y0 = CY - 118;
        dots(ctx, bezier([CX, y0], [CX - 5, y0 - 18], [CX + 5, y0 - 34], [CX, y0 - 52], 160),
            { taper: "out" });
        for (const s of [1, -1]) {
            leaf(ctx, CX, y0 - 8, CX + s * 30, y0 - 34, 9);
            curl(ctx, CX + s * 34, y0 - 38, 12, s > 0 ? 0 : Math.PI, s);
        }
        flower(ctx, CX, y0 - 60, 14, 8);
    });

    brokenRing(ctx, 196, 8, 0.42, { size: cfg().dot * 0.62, phase: Math.PI / 8 });
}

// Eight fine sprays, set squarely between the crown flourishes so the middle
// distance has rhythm rather than speckle, inside a broken outer ring.
function sprays(ctx) {
    radial(ctx, 8, () => {
        const y0 = CY - 226;
        dots(ctx, bezier([CX, y0], [CX - 4, y0 - 16], [CX + 4, y0 - 30], [CX, y0 - 44], 140),
            { taper: "out" });
        for (const s of [1, -1]) {
            leaf(ctx, CX, y0 - 10, CX + s * 22, y0 - 32, 7, { size: cfg().dot * 0.9 });
        }
        dots(ctx, arcPts(CX, y0 - 51, 4.5, 0, TAU, 30), { spacing: cfg().spacing * 0.8 });
    }, Math.PI / 8);

    brokenRing(ctx, 300, 12, 0.44, { size: cfg().dot * 0.6, spacing: cfg().spacing * 1.15 });
}

// The corners: a flower with two scrolls running out along the edges, tapering
// away into nothing. Deliberately not joined to anything.
function corners(ctx) {
    const inset = 62;
    const spots = [
        [B0 + inset, B0 + inset, 0],
        [B0 + BOARD - inset, B0 + inset, Math.PI / 2],
        [B0 + BOARD - inset, B0 + BOARD - inset, Math.PI],
        [B0 + inset, B0 + BOARD - inset, -Math.PI / 2],
    ];

    for (const [x, y, rot] of spots) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(rot);
        for (const flip of [false, true]) {
            ctx.save();
            if (flip) { ctx.rotate(Math.PI / 2); ctx.scale(1, -1); }
            dots(ctx, bezier([8, 8], [40, 2], [72, 16], [92, 50], 200), { taper: "out" });
            curl(ctx, 90, 54, 15, -Math.PI / 2, 1);
            leaf(ctx, 24, 8, 58, 18, 10);
            ctx.restore();
        }
        flower(ctx, 18, 18, 20, 8);
        ctx.restore();
    }
}

// One flourish centred on each side, mirrored about its axis, with clear air
// between it and the corners.
function sideMotifs(ctx) {
    const y = B0 + 58;
    for (let side = 0; side < 4; side++) {
        ctx.save();
        ctx.translate(CX, CY);
        ctx.rotate((side * Math.PI) / 2);
        ctx.translate(-CX, -CY);

        flower(ctx, CX, y, 17, 8);
        for (const s of [1, -1]) {
            dots(ctx, bezier([CX + s * 22, y], [CX + s * 62, y - 16],
                [CX + s * 104, y + 18], [CX + s * 140, y - 4], 220), { taper: "out" });
            curl(ctx, CX + s * 146, y - 6, 14, s > 0 ? -0.4 : Math.PI + 0.4, s);
            leaf(ctx, CX + s * 44, y + 4, CX + s * 78, y + 22, 9);
            dots(ctx, arcPts(CX + s * 112, y + 14, 4, 0, TAU, 30), { spacing: cfg().spacing * 0.8 });
        }
        ctx.restore();
    }
}

// ── layout two: tracery ────────────────────────────────────────────────────
// A rose window rather than a garden. Lancets and foils turned twelve ways
// about the middle, star tracery struck across them, a diaper of crosses over
// the open ground, and a moth resting on each side.

// The rose: broken rings, a ring of lancets, foils in the gaps, and two star
// polygons struck across the whole thing.
function rose(ctx) {
    brokenRing(ctx, 104, 12, 0.66, { size: cfg().dot * 0.8 });
    starPolygon(ctx, 150, 12, 5);
    starPolygon(ctx, 150, 12, 4);

    radial(ctx, 12, () => lancet(ctx, CX, CY - 150, 15, 52));
    radial(ctx, 12, () => foil(ctx, CX, CY - 190, 17, 4, Math.PI / 4), Math.PI / 12);
    brokenRing(ctx, 214, 12, 0.4, { size: cfg().dot * 0.62, phase: Math.PI / 12 });
}

// A diaper of small crosses over the open ground — the repeating field pattern
// behind medieval ornament. Laid on the ornament's own lattice, and cut out
// around the rose and outside the border so it never crowds either.
function diaper(ctx) {
    const c = cfg();
    const pitch = c.grid * 7;
    const arm = c.grid;
    for (let y = B0 + 96; y <= B0 + BOARD - 96; y += pitch) {
        for (let x = B0 + 96; x <= B0 + BOARD - 96; x += pitch) {
            const d = Math.hypot(x - CX, y - CY);
            if (d < 244 || d > 336) continue;
            dots(ctx, [[x - arm, y], [x + arm, y]], { size: c.dot * 0.7 });
            dots(ctx, [[x, y - arm], [x, y + arm]], { size: c.dot * 0.7 });
        }
    }
}

// The corners: a quatrefoil with a lancet either side of it, facing in.
function traceryCorners(ctx) {
    const inset = 74;
    const spots = [
        [B0 + inset, B0 + inset, Math.PI / 4],
        [B0 + BOARD - inset, B0 + inset, Math.PI * 0.75],
        [B0 + BOARD - inset, B0 + BOARD - inset, Math.PI * 1.25],
        [B0 + inset, B0 + BOARD - inset, Math.PI * 1.75],
    ];
    for (const [x, y, rot] of spots) {
        foil(ctx, x, y, 30, 4, rot);
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(rot);
        lancet(ctx, 0, 52, 13, 40, Math.PI);
        for (const s of [1, -1]) {
            dots(ctx, bezier([s * 34, -20], [s * 62, -14], [s * 78, 6], [s * 84, 34], 160),
                { taper: "out" });
        }
        ctx.restore();
    }
}

// A moth on each side, wings up, resting between the border and the field.
function moths(ctx) {
    for (let side = 0; side < 4; side++) {
        ctx.save();
        ctx.translate(CX, CY);
        ctx.rotate((side * Math.PI) / 2);
        ctx.translate(-CX, -CY);
        moth(ctx, CX, B0 + 88, 46, Math.PI);
        for (const s of [1, -1]) {
            foil(ctx, CX + s * 108, B0 + 76, 17, 3, -Math.PI / 2);
            dots(ctx, bezier([CX + s * 132, B0 + 76], [CX + s * 162, B0 + 66],
                [CX + s * 186, B0 + 84], [CX + s * 208, B0 + 62], 180), { taper: "out" });
        }
        ctx.restore();
    }
}

// ── layout three: classic ──────────────────────────────────────────────────
// What a carrom board actually has: a line from each pocket to the middle, and
// a flower where they meet. Nothing else — the board is for playing on.

// The four diagonals, pocket to centre, each with an arrow head pointing in.
//
// Drawn as one line turned four times rather than as four separate lines. The
// lattice pitch divides the distance from the centre to the edge exactly, so a
// quarter turn about the centre maps the lattice onto itself and all four come
// out identical. Laying them out by hand instead gives each line a different
// sub-grid offset, and two of the four visibly snap differently.
function pocketLines(ctx) {
    const g = cfg().grid;
    const from = Math.round(306 / g) * g;   // per-axis distance from the centre
    const to = Math.round(112 / g) * g;     // stops at the edge of the flower

    radial(ctx, 4, () => {
        const x0 = CX - from, y0 = CY - from;
        const x1 = CX - to, y1 = CY - to;
        dots(ctx, [[x0, y0], [x1, y1]], { taper: "in" });

        // Arrow head, three quarters of the way along, aimed at the middle.
        const ang = Math.PI / 4;
        const ax = x0 + (x1 - x0) * 0.78;
        const ay = y0 + (y1 - y0) * 0.78;
        for (const side of [1, -1]) {
            const a2 = ang + side * 2.45;
            dots(ctx, [[ax, ay], [ax + Math.cos(a2) * 15, ay + Math.sin(a2) * 15]],
                { taper: "out" });
        }
        // A vine weaving along the line, crossing it twice, with a curl at each
        // end. Drawn in a frame turned onto the diagonal so the wave rides the
        // line rather than the axes.
        ctx.save();
        ctx.translate(x0, y0);
        ctx.rotate(ang);
        const run = Math.hypot(x1 - x0, y1 - y0);
        dots(ctx, bezier([run * 0.06, 0], [run * 0.28, -26],
            [run * 0.52, 26], [run * 0.74, -6], 220), { size: cfg().dot * 0.82 });
        dots(ctx, bezier([run * 0.06, 0], [run * 0.3, 22],
            [run * 0.5, -22], [run * 0.72, 8], 220), { size: cfg().dot * 0.7 });
        curl(ctx, run * 0.8, -10, 13, -Math.PI / 2, 1, { size: cfg().dot * 0.8 });
        curl(ctx, run * 0.78, 12, 11, Math.PI / 2, -1, { size: cfg().dot * 0.7 });
        leaf(ctx, run * 0.34, -4, run * 0.5, -22, 7, { size: cfg().dot * 0.8 });
        leaf(ctx, run * 0.36, 6, run * 0.52, 20, 7, { size: cfg().dot * 0.8 });
        ctx.restore();

        // A small foil at the pocket end, where the line begins.
        foil(ctx, x0, y0, 13, 3, ang + Math.PI);
    });
}

// The flower in the middle: eight petals opening from a broken ring, with buds
// in the gaps. Sized to sit outside the rack so the break never hides it.
function centreFlower(ctx) {
    brokenRing(ctx, 96, 8, 0.66, { size: cfg().dot * 0.78 });

    radial(ctx, 8, () => {
        const tip = CY - 152;
        const base = CY - 100;
        leaf(ctx, CX, base, CX, tip, 21);                       // the petal
        dots(ctx, [[CX, base + 4], [CX, tip + 8]], { size: cfg().dot * 0.6 });
        for (const s of [1, -1]) {
            curl(ctx, CX + s * 20, base - 6, 11, s > 0 ? 0 : Math.PI, s);
        }
    });

    // Buds standing between the petals, each on a pair of curling tendrils.
    radial(ctx, 8, () => {
        dots(ctx, arcPts(CX, CY - 118, 7, 0, TAU, 60));
        dots(ctx, [[CX, CY - 108], [CX, CY - 99]], { size: cfg().dot * 0.6 });
        for (const s of [1, -1]) {
            dots(ctx, bezier([CX, CY - 100], [CX + s * 16, CY - 112],
                [CX + s * 34, CY - 128], [CX + s * 40, CY - 150], 160),
                { size: cfg().dot * 0.75, taper: "out" });
            curl(ctx, CX + s * 44, CY - 156, 12, s > 0 ? 0 : Math.PI, s,
                { size: cfg().dot * 0.75 });
        }
    }, Math.PI / 8);
}

// A quiet run of ornament along each edge: a small flower on the centre line,
// a scroll either side of it curling back in, and a broken rule reaching out
// towards the corners. Drawn as one edge turned four times, so it inherits the
// same symmetry as everything else.
function edgeMotifs(ctx) {
    const y = B0 + 38;   // outside the baselines, inside the board edge
    const c = cfg();

    radial(ctx, 4, () => {
        flower(ctx, CX, y, 13, 6);

        for (const s of [1, -1]) {
            // The scroll: out along the edge, then curling back towards the board.
            dots(ctx, bezier([CX + s * 22, y], [CX + s * 54, y + 10],
                [CX + s * 86, y - 12], [CX + s * 112, y + 4], 180), { taper: "out" });
            curl(ctx, CX + s * 118, y + 8, 11, s > 0 ? -0.5 : Math.PI + 0.5, s);
            leaf(ctx, CX + s * 40, y + 2, CX + s * 68, y + 16, 7, { size: c.dot * 0.85 });

            // An undulating vine running on towards the corner, in two lengths,
            // and a swag hanging below it.
            dots(ctx, bezier([CX + s * 140, y], [CX + s * 166, y - 16],
                [CX + s * 192, y + 16], [CX + s * 216, y], 200),
                { size: c.dot * 0.72, taper: "both" });
            dots(ctx, bezier([CX + s * 238, y], [CX + s * 258, y - 13],
                [CX + s * 278, y + 13], [CX + s * 296, y], 180),
                { size: c.dot * 0.62, taper: "both" });
            foil(ctx, CX + s * 227, y, 9, 3, -Math.PI / 2);
            dots(ctx, bezier([CX + s * 30, y + 20], [CX + s * 110, y + 52],
                [CX + s * 200, y + 52], [CX + s * 280, y + 16], 260),
                { size: c.dot * 0.6, taper: "out" });
        }
    });
}

const LAYOUTS = {
    // The traditional board: pocket lines and a flower in the middle.
    classic: (ctx) => {
        pocketLines(ctx);
        centreFlower(ctx);
        edgeMotifs(ctx);
    },
    // The garden: stems, leaves and flower heads, eight ways about the middle.
    botanical: (ctx) => {
        crown(ctx);
        sprays(ctx);
        sideMotifs(ctx);
        corners(ctx);
    },
    // The rose window: lancets, foils, star tracery, a diaper field, and moths.
    tracery: (ctx) => {
        rose(ctx);
        diaper(ctx);
        moths(ctx);
        traceryCorners(ctx);
    },
};

/**
 * Set the whole board. Called by Draw between the surface and the pieces, so
 * the coins and the striker always sit on top.
 */
export function drawOrnament(ctx) {
    const o = cfg();
    if (!o || !o.primary || o.primary === "none") return;

    ctx.save();
    laid = new Set();
    (LAYOUTS[o.layout] || LAYOUTS.botanical)(ctx);
    ctx.restore();
}

export default drawOrnament;
