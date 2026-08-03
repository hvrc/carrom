// Coin: pure render-side data object. Server owns physics + pocket detection
// (see server/physics.js); the client only mirrors authoritative position
// snapshots received via the `physicsFrame` / `gameInit` / `turnResolved`
// socket events.
//
// The one piece of pure-presentation logic the client owns is the pocket-drop
// animation: when a `pocketEvent` arrives, the coin is flagged with
// `beingPocketed` + a target pocket position + a start timestamp, and `draw()`
// interpolates a shrink-and-translate tween. The coin is removed from the
// render list once `_pocketProgress() >= 1`.

import { pieceStyle } from "./theme/index.js";

export default class Coin {
    static POCKET_ANIM_MS = 250;

    constructor({ id, color = "white", radius = 15, x = 0, y = 0 }) {
        this.id = id;
        this.color = color;
        this.radius = radius;
        this.x = x;
        this.y = y;
        this.beingPocketed = false;
        this.pocketTarget = null;
        this.pocketStartX = 0;
        this.pocketStartY = 0;
        this.pocketStartTime = 0;
    }

    // (fromX, fromY) is the coin's exact position at capture, which the server
    // sends: pocketed coins are dropped from broadcast frames, so the client's
    // last streamed position for the coin is short of the pocket. Starting the
    // tween from the server's `from` makes the coin finish its real path.
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
        return Math.min(1, (now - this.pocketStartTime) / Coin.POCKET_ANIM_MS);
    }

    resetPocketAnim() {
        this.beingPocketed = false;
        this.pocketTarget = null;
    }

    draw(ctx) {
        let drawX = this.x;
        let drawY = this.y;
        let drawRadius = this.radius;

        if (this.beingPocketed && this.pocketTarget) {
            const t = this.pocketProgress();
            if (t >= 1) return;
            // Ease-in (t^2) so the coin accelerates into the pocket.
            const e = t * t;
            drawX = this.pocketStartX + (this.pocketTarget.x - this.pocketStartX) * e;
            drawY = this.pocketStartY + (this.pocketTarget.y - this.pocketStartY) * e;
            drawRadius = this.radius * (1 - t);
        }

        ctx.save();
        ctx.beginPath();
        ctx.arc(drawX, drawY, drawRadius, 0, Math.PI * 2);
        const style = pieceStyle(this.color);
        ctx.fillStyle = style.fill;
        ctx.strokeStyle = style.border;
        ctx.fill();
        ctx.stroke();
        ctx.restore();
    }
}
