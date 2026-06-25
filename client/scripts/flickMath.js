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
