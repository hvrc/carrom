// Pure aim/flick math — no DOM. Unit-tested in client/test/flickMath.test.js.
// Shared by mouse and touch (one Pointer Events path in Board.jsx).

export const FLICK_DEAD_ZONE = 5; // px (canvas space); shorter drags don't flick

// Map a pointer's client coords to canvas (900-space) coords. Corrects for CSS
// scaling — getBoundingClientRect is the post-transform size, so we rescale by
// canvasW/rect.width — and applies the joiner's 180° board rotation.
export function toCanvasCoords(clientX, clientY, rect, canvasW, canvasH, playerRole) {
    const sx = rect.width ? canvasW / rect.width : 1;
    const sy = rect.height ? canvasH / rect.height : 1;
    let x = (clientX - rect.left) * sx;
    let y = (clientY - rect.top) * sy;
    if (playerRole === "joiner") {
        x = canvasW - x;
        y = canvasH - y;
    }
    return { x, y };
}

// Flick line END point = striker centre + (current pointer − initial pointer),
// capped to maxLength. All coords in canvas space.
export function flickEndpoint(strikerX, strikerY, initialX, initialY, curX, curY, maxLength) {
    const ex = strikerX + (curX - initialX);
    const ey = strikerY + (curY - initialY);
    const dx = ex - strikerX;
    const dy = ey - strikerY;
    const dist = Math.hypot(dx, dy);
    if (dist > maxLength) {
        const k = maxLength / dist;
        return { x: strikerX + dx * k, y: strikerY + dy * k };
    }
    return { x: ex, y: ey };
}

// Slingshot vector from the flick line (start = striker centre, end = dragged
// point). Direction is OPPOSITE the drag (pull-back/release); force ∝ distance.
export function flickVector(startX, startY, endX, endY, maxLength) {
    const dx = startX - endX;
    const dy = startY - endY;
    const distance = Math.hypot(dx, dy);
    return {
        angle: Math.atan2(dy, dx),
        force: Math.min(distance / maxLength, 1),
        distance,
    };
}

// --- Board bounds, placement clamp, overlap ---------------------------------
// Mirrors server/sim/geometry.js (constants-drift test).

// The racks on offer, by total coins including the queen. Mirrors
// server/sim/state.js (constants-drift test).
export const COIN_COUNTS = [5, 11, 19];
export const DEFAULT_COIN_COUNT = 19;

export const FRAME_SIZE = 900;
export const BOARD_SIZE = 750;
export const BOARD_X = (FRAME_SIZE - BOARD_SIZE) / 2; // 75
export const BOARD_Y = BOARD_X;
export const BASE_WIDTH = 470;
export const BASE_HEIGHT = 32;
export const STRIKER_RADIUS = 21;
export const COIN_RADIUS = 15;

// The two circles ("moons") at the ends of a baseline. Both horizontal baselines
// share these x's, and the striker always sits on one of them, so the placement
// test below only needs x.
export const MOON_RADIUS = BASE_HEIGHT / 2;
export const MOON_LEFT_X = BOARD_X + (BOARD_SIZE - BASE_WIDTH) / 2 + MOON_RADIUS;
export const MOON_RIGHT_X = BOARD_X + (BOARD_SIZE - BASE_WIDTH) / 2 + BASE_WIDTH - MOON_RADIUS;

export const SLIDER_MIN_X = BOARD_X + (BOARD_SIZE - BASE_WIDTH) / 2 + STRIKER_RADIUS;
export const SLIDER_MAX_X = BOARD_X + (BOARD_SIZE - BASE_WIDTH) / 2 + BASE_WIDTH - STRIKER_RADIUS;

// Is this point on the playing surface? The 75px band around it is the wooden
// frame, and a press there is not an input — dragging "outside the board" no
// longer moves anything (PRD F1).
export function isOnBoard(x, y) {
    return (
        x >= BOARD_X && x <= BOARD_X + BOARD_SIZE &&
        y >= BOARD_Y && y <= BOARD_Y + BOARD_SIZE
    );
}

// The striker slides along its baseline, between the two base-line ends.
export function clampStrikerX(x) {
    return Math.max(SLIDER_MIN_X, Math.min(SLIDER_MAX_X, x));
}

// A striker sitting on top of a coin has no legal shot: it would begin the
// simulation already interpenetrating. Both the UI (grey striker, dead FLICK
// button) and the server refuse it.
export function strikerOverlapsCoin(striker, coins) {
    if (!striker) return false;
    const reach = STRIKER_RADIUS + COIN_RADIUS;
    for (const coin of coins) {
        if (coin.pocketed) continue;
        if (Math.hypot(coin.x - striker.x, coin.y - striker.y) < reach) return true;
    }
    return false;
}

// The real-board rule for the end circles: the striker must either cover a moon
// completely or stay clear of it. Sitting half on one is a foul placement, so it
// greys out exactly like a striker on a coin. Covered means the moon is entirely
// inside the striker (d + MOON_RADIUS <= STRIKER_RADIUS); clear means they don't
// touch at all (d >= STRIKER_RADIUS + MOON_RADIUS). Anything between is a foul.
export function strikerFoulsMoon(x) {
    for (const cx of [MOON_LEFT_X, MOON_RIGHT_X]) {
        const d = Math.abs(x - cx);
        if (d > STRIKER_RADIUS - MOON_RADIUS && d < STRIKER_RADIUS + MOON_RADIUS) return true;
    }
    return false;
}
