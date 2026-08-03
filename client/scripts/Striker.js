// Striker: pure render-side data object. Server owns physics + pocket
// detection. The client mirrors server snapshots and only tracks placement
// (`isPlacing`) and a derived `isStrikerMoving` flag for cursor/UI gating.
//
// Pocket-drop tween (presentation-only, mirrors `Coin`): when the server
// emits a `pocketEvent` with `kind: "striker"`, the client snapshots the
// striker's pre-capture position via `startPocketAnim` and `draw()`
// interpolates a shrink + ease-in slide into the pocket. While the tween is
// running, incoming `physicsFrame` updates with `striker: null` are ignored
// for position so the animation can complete.

import { theme } from "./theme.js";

export default class Striker {
    static POCKET_ANIM_MS = 250;
    static RADIUS = 21; // mirrors server STRIKER_RADIUS (constants-drift test)

    constructor(x, y) {
        this.radius = Striker.RADIUS;
        this.x = x;
        this.y = y;
        this.velocity = { x: 0, y: 0 };
        this.isPlacing = false;
        this.isStrikerMoving = false;
        this.beingPocketed = false;
        this.pocketTarget = null;
        this.pocketStartX = 0;
        this.pocketStartY = 0;
        this.pocketStartTime = 0;
    }

    startPocketAnim(fromX, fromY, targetX, targetY, now = performance.now()) {
        this.x = fromX;
        this.y = fromY;
        this.beingPocketed = true;
        this.pocketTarget = { x: targetX, y: targetY };
        this.pocketStartX = fromX;
        this.pocketStartY = fromY;
        this.pocketStartTime = now;
    }

    pocketProgress(now = performance.now()) {
        if (!this.beingPocketed) return 0;
        return Math.min(1, (now - this.pocketStartTime) / Striker.POCKET_ANIM_MS);
    }

    resetPocketAnim() {
        this.beingPocketed = false;
        this.pocketTarget = null;
    }

    // A filled disc with its own border, both from the theme. Pass a colour to
    // override the fill (the greyed-out blocked state).
    draw(ctx, color = theme.striker.fill, lineWidth = 1) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
        ctx.strokeStyle = theme.striker.border;
        ctx.lineWidth = lineWidth;
        if (color && color !== "transparent") {
            ctx.fillStyle = color;
            ctx.fill();
        }
        ctx.stroke();
        ctx.restore();
    }

    isPointInside(x, y) {
        return Math.hypot(this.x - x, this.y - y) <= this.radius;
    }

    updatePosition(x, y) {
        this.x = x;
        this.y = y;
    }
}
