// SKIN: breathing halftone — a grid of dots whose size is driven by a field of
// slow travelling waves, so the whole surface swells and settles like something
// alive under the board.
//
// The board carries two of these at once — one green, one lavender — each with
// its own phase and its own half-pitch offset across the grid, so they read as
// two screens laid over each other rather than one screen recoloured.
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

const FRAME = 900;
const BOARD = 750;
const B0 = (FRAME - BOARD) / 2;   // 75 — board's left/top edge
const CX = B0 + BOARD / 2;
const CY = CX;
const TAU = Math.PI * 2;

// Everything this skin can be told. A theme patches whichever of these it
// cares about; the rest come from here.
export const defaults = {
    grid: 15,           // pitch between dots
    dot: 13,            // diameter of a dot at full swell
    contrast: 1,        // how hard the waves bite (0..1)
    waveScale: 0.7,     // < 1 stretches the waves out: bigger patches
    floor: 0.06,        // smallest dot, as a fraction of `dot`
    minAlpha: 0.1,      // faintest a dot goes
    wellRadius: 46,     // how far a piece presses the field down
    wellDepth: 0.95,    // how far down, directly beneath a piece
    // One wave system per layer. `phase` shifts a layer's waves so no two march
    // together; `offset` shifts its dots across the grid, in pitches, so they
    // interleave rather than stack.
    //
    // A single neutral layer by default: the skin should look like something
    // without a theme, but the colours are the theme's business, not its own.
    layers: [
        { ramp: ["#F2F2F2", "#DCDCDC", "#BFBFBF"], phase: 0, offset: 0 },
    ],
};

// Colour by size: each layer walks its own ramp from the pale end for the
// smallest dots to the deep end for the fullest. Layers never blend into each
// other — they are separate wave systems that happen to share a board.
// Quantised and cached, so a frame costs a few dozen colour strings.
const SIZE_STEPS = 20;
const rampCache = new Map();

const hexToRgb = (hex) => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
];

function rampFor(stops) {
    const key = stops.join();
    const cached = rampCache.get(key);
    if (cached) return cached;

    const rgb = stops.map(hexToRgb);
    const out = [];
    for (let i = 0; i < SIZE_STEPS; i++) {
        const pos = (i / (SIZE_STEPS - 1)) * (rgb.length - 1);
        const lo = Math.min(Math.floor(pos), rgb.length - 2);
        const f = pos - lo;
        const c = rgb[lo].map((v, k) => Math.round(v + (rgb[lo + 1][k] - v) * f));
        out.push(`rgb(${c[0]},${c[1]},${c[2]})`);
    }
    rampCache.set(key, out);
    return out;
}

// The wave field at a point, in 0..1.
//
// Flowing bands rather than concentric rings. Three ideas, each doing a job:
//
//   domain warp   the coordinates are bent by slow sines BEFORE anything is
//                 sampled, which is what makes the bands snake rather than run
//                 dead straight
//   ridge         1 - |sin| has a sharp crest and broad troughs, so the dense
//                 seams read as edges instead of gentle swells
//   drift         a slow radial term, so the field is never quite still
//
// `phase` offsets all three, which is what makes each layer its own system
// rather than a tinted copy. The periods are unrelated, so nothing loops.
function amplitude(x, y, t, s, phase = 0, k = 1) {
    // `k` scales every spatial frequency at once: smaller k, longer waves,
    // bigger patches. Time is left alone, so the pattern keeps its pace.
    // Bend the plane before sampling it.
    const wx = x + (64 / k) * Math.sin(y * 0.0068 * k + t * 0.21 + phase);
    const wy = y + (64 / k) * Math.sin(x * 0.0057 * k - t * 0.17 + phase * 1.7);

    const band = Math.sin((wx + wy) * 0.0062 * k - t * 0.44 + phase);
    const ridge = 1 - Math.abs(Math.sin((wx - wy) * 0.0039 * k + t * 0.29 - phase));
    const drift = Math.sin(Math.hypot(x - CX, y - CY) * 0.013 * k - t * 0.36 + phase * 0.5);

    // Ridge is 0..1 and the others -1..1; recentre it before mixing. Divided by
    // less than the sum of the weights ON PURPOSE: the three rarely peak
    // together, so normalising properly would leave every crest at half
    // strength and the whole field grey.
    const v = (band * 0.44 + (ridge * 2 - 1) * 0.5 + drift * 0.22) / 0.82;
    return Math.max(0, Math.min(1, 0.5 + 0.5 * v * s));
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
function draw(ctx, { time = 0, pieces = [], bounds = null, settings = defaults } = {}) {
    const c = settings;
    const t = time / 1000;
    const wells = wellsFrom(pieces, c);
    // Default to the playing surface; a caller drawing the page behind the
    // board passes its own rectangle, in the same board coordinates, so the
    // pattern and the pieces stay in register wherever it is painted.
    const area = bounds || { x0: B0, y0: B0, x1: B0 + BOARD, y1: B0 + BOARD };

    ctx.save();
    // Each layer is its own wave system in its own colour, drawn over its own
    // grid. They are offset from each other in phase and across the grid — two
    // halftone screens laid at different angles rather than one screen printed
    // twice — so their dots interleave and sit close together.
    for (const layer of c.layers) {
        drawLayer(ctx, c, layer, t, wells, area);
    }
    ctx.restore();
}

function drawLayer(ctx, c, layer, t, wells, area) {
    const pitch = c.grid;
    const maxR = c.dot / 2;
    const ramp = rampFor(layer.ramp);
    const shift = (layer.offset || 0) * pitch;

    // Snap the start to the pitch so the lattice is continuous no matter which
    // rectangle is being filled — otherwise a redraw at a different size would
    // shift every dot.
    const startX = Math.ceil((area.x0 - shift) / pitch) * pitch + shift;
    const startY = Math.ceil((area.y0 - shift) / pitch) * pitch + shift;

    for (let y = startY; y < area.y1; y += pitch) {
        for (let x = startX; x < area.x1; x += pitch) {
            const a = amplitude(x, y, t, c.contrast, layer.phase || 0, c.waveScale);

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
                const k = 1 - d2 / r2;              // smooth to nothing at the rim
                press = Math.max(press, w.depth * k * k);
            }
            if (press >= 0.995) continue;

            const swell = c.floor + (1 - c.floor) * a * a;
            const size = swell * (1 - press);
            const r = maxR * size;
            if (r < 0.25) continue;

            ctx.fillStyle = ramp[Math.min(SIZE_STEPS - 1, Math.round(size * (SIZE_STEPS - 1)))];
            // Opacity leans on the crests too: a^0.75 lifts the mid-range so a
            // dense seam reads as solid rather than as a grey suggestion.
            ctx.globalAlpha = (c.minAlpha + (1 - c.minAlpha) * Math.pow(a, 0.75)) * (1 - press * 0.8);
            ctx.beginPath();
            ctx.arc(x, y, r, 0, TAU);
            ctx.fill();
        }
    }
}

export default { name: "halftone", animated: true, defaults, draw };
