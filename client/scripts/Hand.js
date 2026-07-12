import {
    toCanvasCoords, flickEndpoint, flickVector, FLICK_DEAD_ZONE,
    clampStrikerX, isOnBoard, strikerOverlapsCoin,
} from "./flickMath.js";

/**
 * Hand: the two-mode input model (PRD F1–F3).
 *
 *   PLACE  — the default on your turn. The WHOLE BOARD is a scrub bar: press
 *            anywhere and the striker snaps to that x (clamped to your baseline)
 *            and tracks your pointer. Pressing outside the board does nothing.
 *   FLICK  — armed by the FLICK button (or a double-click on desktop). Now a drag
 *            pulls the slingshot line and releasing fires.
 *
 * Cancelling a flick returns you to PLACE mode and never fires: Escape or
 * right-click on desktop, a second finger on touch, or simply a drag shorter than
 * the dead zone.
 *
 * The striker cannot be flicked while it overlaps a coin — it renders greyed out
 * and both arming and firing are refused. The server enforces this too; this is
 * only the feedback.
 *
 * Input is unified on Pointer Events (one path for mouse, touch, pen). The server
 * is the simulation authority — a flick only ever sends { strikerX, angle, force }.
 */
export class Hand {
    static FLICK_MAX_LENGTH = 100;
    static FLICK_POWER = 0.4;

    constructor() {
        this.mode = "place";
        this.isFlickerActive = false;
        this.isPlacing = false;
        this.blocked = false; // striker overlaps a coin → cannot flick
        this.flick = { active: false, startX: 0, startY: 0, endX: 0, endY: 0, initialX: 0, initialY: 0 };
        this.flickMaxLength = Hand.FLICK_MAX_LENGTH;

        // Callbacks set by the parent component.
        this.onStateChange = null;
        this.onRedraw = null;
        this.onPlace = null;
    }

    setCallbacks({ onStateChange, onRedraw, onPlace }) {
        this.onStateChange = onStateChange;
        this.onRedraw = onRedraw;
        this.onPlace = onPlace;
    }

    _updateState(updates) {
        Object.assign(this, updates);
        if (this.onStateChange) this.onStateChange(this.getState());
    }

    // ── Modes ───────────────────────────────────────────────────────────────

    // Arm the slingshot. Refused while the striker is overlapping a coin: there is
    // no legal shot from there, so the mode would be a lie.
    armFlick() {
        if (this.blocked || this.mode === "flick") return false;
        this._updateState({ mode: "flick" });
        if (this.onRedraw) this.onRedraw();
        return true;
    }

    armPlace() {
        if (this.mode === "place" && !this.flick.active) return;
        this._resetFlick({ mode: "place" });
    }

    // Escape / right-click / a second finger / a drag under the dead zone. Never
    // fires; always lands you back in place mode.
    cancelFlick() {
        if (this.mode !== "flick" && !this.flick.active) return false;
        this._resetFlick({ mode: "place" });
        return true;
    }

    // Called by Board every frame with the live overlap test.
    setBlocked(blocked) {
        if (this.blocked === blocked) return false;
        // Losing your legal shot mid-aim disarms you rather than leaving a line
        // hanging over a shot that can no longer be taken.
        if (blocked && this.mode === "flick") {
            this._resetFlick({ blocked, mode: "place" });
            return true;
        }
        this._updateState({ blocked });
        return true;
    }

    // ── Pointer interaction (canvas-space coords supplied by Board.jsx) ──────

    pointerDown(x, y, { isMyTurn, isAnimating, strikerRef }) {
        if (isAnimating || !isMyTurn || !strikerRef.current) return false;
        // The board is the playfield. A press on the wooden frame (or off-canvas)
        // is not an input — this is what "not outside the board anymore" means.
        if (!isOnBoard(x, y)) return false;

        if (this.mode === "flick") {
            if (this.blocked) return false;
            const s = strikerRef.current;
            this._updateState({
                isFlickerActive: true,
                flick: { active: true, startX: s.x, startY: s.y, endX: s.x, endY: s.y, initialX: x, initialY: y },
            });
            if (this.onRedraw) this.onRedraw();
            return true; // capture the pointer
        }

        // Place mode: the whole board scrubs. Snap to the press, then track it.
        this._updateState({ isPlacing: true });
        this._placeAt(x, strikerRef);
        return true;
    }

    pointerMove(x, y, { isMyTurn, strikerRef }) {
        if (!isMyTurn || !strikerRef.current) return;

        if (this.mode === "flick") {
            if (!this.flick.active) return;
            const s = strikerRef.current;
            const end = flickEndpoint(s.x, s.y, this.flick.initialX, this.flick.initialY, x, y, this.flickMaxLength);
            // Hot path: fires per pointer sample. Mutates the aim line only —
            // nothing React renders can change here, so no onStateChange. The
            // canvas reads this.flick through the Hand ref.
            this.flick = { ...this.flick, startX: s.x, startY: s.y, endX: end.x, endY: end.y };
            if (this.onRedraw) this.onRedraw();
            return;
        }

        if (this.isPlacing) this._placeAt(x, strikerRef);
    }

    pointerUp({ isMyTurn, strikerRef, socket, roomName }) {
        if (this.mode === "place") {
            if (!this.isPlacing) return;
            this._updateState({ isPlacing: false });
            if (this.onPlace && strikerRef.current) {
                this.onPlace({ strikerX: strikerRef.current.x });
            }
            return;
        }

        if (!this.flick.active) return;
        const fired = isMyTurn && strikerRef.current && !this.blocked
            ? this._emitFlick({ strikerRef, socket, roomName })
            : false;
        // A drag too short to fire is a cancel, not a zero-force flick (Q4).
        this._resetFlick({ mode: "place" });
        return fired;
    }

    pointerCancel() {
        this._resetFlick({ mode: "place" });
        this._updateState({ isPlacing: false });
    }

    // Move the striker along the baseline. y is fixed — the striker only ever
    // slides left and right on the line the server put it on.
    _placeAt(x, strikerRef) {
        const s = strikerRef.current;
        s.updatePosition(clampStrikerX(x), s.y);
        if (this.onRedraw) this.onRedraw();
    }

    // Compute the flick vector from the current line and emit it. Returns true if
    // a flick was sent. Does NOT touch striker velocity — the server simulates.
    _emitFlick({ strikerRef, socket, roomName }) {
        if (!socket || !roomName || !strikerRef?.current) return false;
        const { angle, force, distance } = flickVector(
            this.flick.startX, this.flick.startY, this.flick.endX, this.flick.endY, this.flickMaxLength,
        );
        if (distance <= FLICK_DEAD_ZONE) return false;
        socket.emit("flick", { roomName, strikerX: strikerRef.current.x, angle, force });
        return true;
    }

    _resetFlick(extra = {}) {
        this._updateState({
            isFlickerActive: false,
            flick: { active: false, startX: 0, startY: 0, endX: 0, endY: 0, initialX: 0, initialY: 0 },
            ...extra,
        });
        if (this.onRedraw) this.onRedraw();
    }

    // Is the striker sitting on top of a coin? No legal shot from there.
    static overlapsCoin(striker, coins) {
        return strikerOverlapsCoin(striker, coins);
    }

    getState() {
        return {
            mode: this.mode,
            isFlickerActive: this.isFlickerActive,
            isPlacing: this.isPlacing,
            blocked: this.blocked,
            flick: { ...this.flick },
            flickMaxLength: this.flickMaxLength,
        };
    }

    // New turn / new game: back to placing, nothing armed.
    reset() {
        this.flickMaxLength = Hand.FLICK_MAX_LENGTH;
        this.blocked = false;
        this.isPlacing = false;
        this._resetFlick({ mode: "place" });
    }
}

export default Hand;
