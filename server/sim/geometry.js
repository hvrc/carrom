// Board geometry + physical constants (canvas-space, 900x900 frame, board
// centered at offset 75). Pure values + spatial helpers, no state. These are
// mirrored on the client (Draw/Coin/Striker/Pocket) and guarded by the
// client constants-drift test.

export const FRAME_SIZE = 900;
export const BOARD_SIZE = 750;
export const BOARD_X = (FRAME_SIZE - BOARD_SIZE) / 2; // 75
export const BOARD_Y = (FRAME_SIZE - BOARD_SIZE) / 2; // 75

export const BASE_DISTANCE = 102;
export const BASE_HEIGHT = 32;
export const BASE_WIDTH = 470;

export const POCKET_DIAMETER = 45;
export const POCKET_RADIUS = POCKET_DIAMETER / 2;

// --- How the board plays ------------------------------------------------------
//
// FRICTION is the fraction of speed a piece keeps each 16ms tick, so small
// changes compound hard: 0.97 loses half a piece's speed in 23 ticks, 0.985 in
// 46. It is the single number that decides whether the board feels like waxed
// wood or like a carpet.
//
// It was 0.97, which was too dead — a full-power shot barely crossed the board
// once. The carrom-design prototype uses 0.994 at the other extreme, and that
// is too slow to play: measured over 45 shots per setting, on this board,
//
//   friction   full-power travel   turn settles in   worst turn
//   0.970          1.22 boards          2.2s            2.5s
//   0.985          1.82 boards          3.9s            4.5s
//   0.994          2.57 boards          8.0s            9.5s
//
// 0.994 buys another board of travel and costs four extra seconds of watching
// coins creep before anyone can take their turn, every turn. 0.985 is where the
// glide arrives and the waiting has not yet: half again the travel of the old
// value, with a turn that still settles inside four seconds.
// RESTITUTION is how lively the cushions are: the fraction of speed kept in a
// bounce. Raised from 0.6 alongside the friction, because the two work together
// — a longer glide is wasted if the first cushion eats half of it. Worth 13%
// more travel for a third of a second, and it makes a rebound off the back
// cushion a real option rather than a way to hand over your turn.
export const COIN_RADIUS = 15;
export const COIN_MASS = 0.5;
export const COIN_RESTITUTION = 0.7;
export const COIN_FRICTION = 0.985;

export const STRIKER_RADIUS = 21;
export const STRIKER_MASS = 1;
export const STRIKER_RESTITUTION = 0.7;
export const STRIKER_FRICTION = 0.985;

// The speed below which a piece is treated as stopped. This is what bounds a
// turn: without it the tail of an exponential decay creeps for ever. It is left
// where it was — the friction change lengthens the glide, and this keeps the
// end of it from becoming a wait.
export const MOVEMENT_THRESHOLD = 0.21;
export const FLICK_POWER = 0.4; // matches Hand.FLICK_POWER
export const MAX_VELOCITY_FROM_FLICK = FLICK_POWER * 100; // 40 px/tick at force=1

// CCD config
export const CCD_SPEED_THRESHOLD = 2;
export const CCD_MAX_SUB_STEPS = 4;
export const CCD_SPEED_DIVISOR = 5;
export const CCD_MIN_REMAINING_TIME = 0.01;

// Game rule tuning
export const MAX_TURNS_IN_A_ROW = 3; // cap on continued turns

export const POCKETS = [
    { x: BOARD_X + POCKET_RADIUS, y: BOARD_Y + POCKET_RADIUS },
    { x: BOARD_X + BOARD_SIZE - POCKET_RADIUS, y: BOARD_Y + POCKET_RADIUS },
    { x: BOARD_X + POCKET_RADIUS, y: BOARD_Y + BOARD_SIZE - POCKET_RADIUS },
    { x: BOARD_X + BOARD_SIZE - POCKET_RADIUS, y: BOARD_Y + BOARD_SIZE - POCKET_RADIUS },
];

export const CENTER_X = BOARD_X + BOARD_SIZE / 2; // 450
export const CENTER_Y = BOARD_Y + BOARD_SIZE / 2; // 450

// --- Ledge -------------------------------------------------------------------
// The 75px band between the board and the edge of the frame is the wooden ledge
// real carrom boards have, and it is where players park the coins they've
// pocketed. Each player's pile sits on their own side.
//
// The creator's ledge (bottom band) fills left → right. The joiner's (top band)
// fills right → left *in board space* — which, because their canvas is rotated
// 180°, renders as left → right on their screen. So both players see their own
// pile fill left to right, with no per-viewer special-casing.
export const LEDGE_SPACING = 44; // coins are 30 across, so this leaves a clear gap
export const LEDGE_INSET = 24; // from the board's left/right edge
export const LEDGE_Y_CREATOR = BOARD_Y + BOARD_SIZE + (FRAME_SIZE - BOARD_Y - BOARD_SIZE) / 2; // 862.5
export const LEDGE_Y_JOINER = BOARD_Y / 2; // 37.5

export function ledgeSlot(role, index) {
    if (role === "creator") {
        return { x: BOARD_X + LEDGE_INSET + index * LEDGE_SPACING, y: LEDGE_Y_CREATOR };
    }
    return { x: BOARD_X + BOARD_SIZE - LEDGE_INSET - index * LEDGE_SPACING, y: LEDGE_Y_JOINER };
}

export const TOP_BASELINE_Y = BOARD_Y + BASE_DISTANCE + BASE_HEIGHT / 2;
export const BOTTOM_BASELINE_Y = BOARD_Y + BOARD_SIZE - BASE_DISTANCE - BASE_HEIGHT / 2;

export const SLIDER_MIN_X = BOARD_X + (BOARD_SIZE - BASE_WIDTH) / 2 + STRIKER_RADIUS;
export const SLIDER_MAX_X = BOARD_X + (BOARD_SIZE - BASE_WIDTH) / 2 + BASE_WIDTH - STRIKER_RADIUS;

// creator plays the bottom baseline by convention; joiner plays the top.
export function baselineYFor(role) {
    return role === "creator" ? BOTTOM_BASELINE_Y : TOP_BASELINE_Y;
}

export function clampStrikerX(x) {
    return Math.max(SLIDER_MIN_X, Math.min(SLIDER_MAX_X, x));
}

// Would a striker placed here be sitting on top of a coin? There is no legal
// shot from such a position — the simulation would start with two bodies already
// interpenetrating — so the server refuses the flick outright rather than
// trusting the client's own greyed-out button (PRD F3).
export function overlapsAnyCoin(coins, x, y) {
    const reach = STRIKER_RADIUS + COIN_RADIUS;
    return coins.some(
        (c) => !c.pocketed && Math.hypot(c.x - x, c.y - y) < reach,
    );
}

// The circles at the ends of a baseline. Both horizontal baselines share these
// x's, and the striker always sits on one of them, so only x matters.
export const MOON_RADIUS = BASE_HEIGHT / 2;
export const MOON_LEFT_X = BOARD_X + (BOARD_SIZE - BASE_WIDTH) / 2 + MOON_RADIUS;
export const MOON_RIGHT_X = BOARD_X + (BOARD_SIZE - BASE_WIDTH) / 2 + BASE_WIDTH - MOON_RADIUS;

// Real-board placement rule: the striker either covers an end circle completely
// or keeps clear of it. Half on one is a foul placement and cannot be shot from.
// Mirrored in client/scripts/flickMath.js (constants-drift test).
export function foulsMoon(x) {
    return [MOON_LEFT_X, MOON_RIGHT_X].some((cx) => {
        const d = Math.abs(x - cx);
        return d > STRIKER_RADIUS - MOON_RADIUS && d < STRIKER_RADIUS + MOON_RADIUS;
    });
}

// Spatial query: which pocket (if any) an object's centre has fallen into.
export function isInsidePocket(obj) {
    for (const p of POCKETS) {
        const d = Math.hypot(obj.x - p.x, obj.y - p.y);
        if (d < POCKET_RADIUS - obj.radius / 2) return p;
    }
    return null;
}
