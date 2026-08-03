// Collision + integration math (mirrors the client's former Physics.js).
// Pure functions over {x,y,velocity,radius,restitution,mass...} objects.
import {
    BOARD_X, BOARD_Y, BOARD_SIZE, MOVEMENT_THRESHOLD,
    CCD_SPEED_THRESHOLD, CCD_MAX_SUB_STEPS, CCD_SPEED_DIVISOR, CCD_MIN_REMAINING_TIME,
} from "./geometry.js";

// Returns the impact: the closing speed along the line of centres, before the
// bounce. 0 when nothing was resolved. The client turns it into a sound, so it
// has to be the speed at the moment of contact, not afterwards.
export function resolveCircleCollision(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) return 0;
    const overlap = a.radius + b.radius - dist;
    if (overlap <= 0) return 0;

    const nx = dx / dist;
    const ny = dy / dist;
    const aMass = a.strikerMass || a.coinMass;
    const bMass = b.strikerMass || b.coinMass;
    const totalMass = aMass + bMass;

    a.x -= nx * (overlap * (bMass / totalMass));
    a.y -= ny * (overlap * (bMass / totalMass));
    b.x += nx * (overlap * (aMass / totalMass));
    b.y += ny * (overlap * (aMass / totalMass));

    const dvx = b.velocity.x - a.velocity.x;
    const dvy = b.velocity.y - a.velocity.y;
    const vn = dvx * nx + dvy * ny;
    if (vn >= 0) return 0;

    const restitution = Math.min(a.restitution, b.restitution);
    const impulse = (-(1 + restitution) * vn) / (1 / aMass + 1 / bMass);
    const ix = impulse * nx;
    const iy = impulse * ny;
    a.velocity.x -= ix / aMass;
    a.velocity.y -= iy / aMass;
    b.velocity.x += ix / bMass;
    b.velocity.y += iy / bMass;

    return -vn;
}

export function areCirclesColliding(a, b) {
    return Math.hypot(b.x - a.x, b.y - a.y) < a.radius + b.radius;
}

// Returns the impact — the speed into the cushion, before the bounce — or 0 if
// the piece never reached one. Callers that only care whether it hit can still
// read it as a boolean.
export function handleBorderCollision(obj) {
    const minX = BOARD_X + obj.radius;
    const maxX = BOARD_X + BOARD_SIZE - obj.radius;
    const minY = BOARD_Y + obj.radius;
    const maxY = BOARD_Y + BOARD_SIZE - obj.radius;
    let impact = 0;
    if (obj.x < minX) { impact = Math.abs(obj.velocity.x); obj.x = minX; obj.velocity.x = Math.abs(obj.velocity.x) * obj.restitution; }
    else if (obj.x > maxX) { impact = Math.abs(obj.velocity.x); obj.x = maxX; obj.velocity.x = -Math.abs(obj.velocity.x) * obj.restitution; }
    if (obj.y < minY) { impact = Math.max(impact, Math.abs(obj.velocity.y)); obj.y = minY; obj.velocity.y = Math.abs(obj.velocity.y) * obj.restitution; }
    else if (obj.y > maxY) { impact = Math.max(impact, Math.abs(obj.velocity.y)); obj.y = maxY; obj.velocity.y = -Math.abs(obj.velocity.y) * obj.restitution; }
    return impact;
}

export function continuousCircleCollision(a, b) {
    const relPosX = a.x - b.x;
    const relPosY = a.y - b.y;
    const relVelX = a.velocity.x - b.velocity.x;
    const relVelY = a.velocity.y - b.velocity.y;
    const collisionDist = a.radius + b.radius;
    const A = relVelX * relVelX + relVelY * relVelY;
    const B = 2 * (relPosX * relVelX + relPosY * relVelY);
    const C = relPosX * relPosX + relPosY * relPosY - collisionDist * collisionDist;
    if (Math.abs(A) < 1e-10) return null;
    const disc = B * B - 4 * A * C;
    if (disc < 0) return null;
    const sq = Math.sqrt(disc);
    const t = Math.min((-B - sq) / (2 * A), (-B + sq) / (2 * A));
    return t >= 0 && t <= 1 ? t : null;
}

export function updateWithCCD(obj, others, onImpact = null) {
    const vx = obj.velocity.x;
    const vy = obj.velocity.y;
    const speed = Math.hypot(vx, vy);

    if (speed < CCD_SPEED_THRESHOLD) {
        obj.x += vx;
        obj.y += vy;
        const wall = handleBorderCollision(obj);
        if (wall > 0 && onImpact) onImpact({ x: obj.x, y: obj.y, speed: wall, kind: "wall" });
        return;
    }

    const subSteps = Math.min(Math.ceil(speed / CCD_SPEED_DIVISOR), CCD_MAX_SUB_STEPS);
    const stepSize = 1.0 / subSteps;

    for (let s = 0; s < subSteps; s++) {
        const sx = vx * stepSize;
        const sy = vy * stepSize;
        const startX = obj.x;
        const startY = obj.y;

        let earliest = 1.0;
        let hit = null;
        for (const other of others) {
            if (other === obj) continue;
            const saveVx = obj.velocity.x;
            const saveVy = obj.velocity.y;
            obj.velocity.x = sx;
            obj.velocity.y = sy;
            const t = continuousCircleCollision(obj, other);
            obj.velocity.x = saveVx;
            obj.velocity.y = saveVy;
            if (t !== null && t < earliest) {
                earliest = t;
                hit = other;
            }
        }

        obj.x = startX + sx * earliest;
        obj.y = startY + sy * earliest;
        const borderCollided = handleBorderCollision(obj);
        if (borderCollided > 0 && onImpact) {
            onImpact({ x: obj.x, y: obj.y, speed: borderCollided, kind: "wall" });
        }

        if (hit && earliest < 1.0) {
            const impact = resolveCircleCollision(obj, hit);
            if (impact > 0 && onImpact) {
                onImpact({
                    x: (obj.x + hit.x) / 2,
                    y: (obj.y + hit.y) / 2,
                    speed: impact,
                    // The queen gets her own sound, so the client has to know
                    // she was in it. She is the only red piece on the board.
                    kind: (obj.color === "red" || hit.color === "red") ? "queen" : "piece",
                });
            }
            const remaining = 1.0 - earliest;
            if (remaining > CCD_MIN_REMAINING_TIME) {
                obj.x += obj.velocity.x * stepSize * remaining;
                obj.y += obj.velocity.y * stepSize * remaining;
            }
        } else if (!borderCollided) {
            obj.x = startX + sx;
            obj.y = startY + sy;
        }
    }
}

export function isMoving(obj) {
    if (obj.pocketed) return false;
    return Math.abs(obj.velocity.x) > MOVEMENT_THRESHOLD ||
           Math.abs(obj.velocity.y) > MOVEMENT_THRESHOLD;
}

export function applyFrictionAndStop(obj) {
    obj.velocity.x *= obj.friction;
    obj.velocity.y *= obj.friction;
    if (Math.abs(obj.velocity.x) <= MOVEMENT_THRESHOLD &&
        Math.abs(obj.velocity.y) <= MOVEMENT_THRESHOLD) {
        obj.velocity.x = 0;
        obj.velocity.y = 0;
    }
}
