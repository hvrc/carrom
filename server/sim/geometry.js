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

export const COIN_RADIUS = 15;
export const COIN_MASS = 0.5;
export const COIN_RESTITUTION = 0.6;
export const COIN_FRICTION = 0.97;

export const STRIKER_RADIUS = 21;
export const STRIKER_MASS = 1;
export const STRIKER_RESTITUTION = 0.6;
export const STRIKER_FRICTION = 0.97;

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
export const LEDGE_SPACING = 34;
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

// Spatial query: which pocket (if any) an object's centre has fallen into.
export function isInsidePocket(obj) {
    for (const p of POCKETS) {
        const d = Math.hypot(obj.x - p.x, obj.y - p.y);
        if (d < POCKET_RADIUS - obj.radius / 2) return p;
    }
    return null;
}
