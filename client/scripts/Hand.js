import { toCanvasCoords, flickEndpoint, flickVector, FLICK_DEAD_ZONE } from "./flickMath.js";

/**
 * Hand: aim/flick interaction + striker-placement slider state.
 *
 * Input is unified on the Pointer Events API (one path for mouse, touch, pen).
 * Board.jsx captures the pointer on down (setPointerCapture) so a drag that
 * leaves the board keeps tracking, and feeds canvas-space coords here. The
 * slingshot: press anywhere, drag to pull a line from the striker centre,
 * release to fire the striker in the OPPOSITE direction (force ∝ drag length).
 * The server is the simulation authority — we only emit { strikerX, angle, force }.
 */
export class Hand {
    static FLICK_MAX_LENGTH = 100;
    static FLICK_POWER = 0.4;

    constructor() {
        this.isFlickerActive = false;
        this.flick = { active: false, startX: 0, startY: 0, endX: 0, endY: 0, initialX: 0, initialY: 0 };
        this.flickMaxLength = Hand.FLICK_MAX_LENGTH;

        // Slider (striker placement) state, 0..100 mapped to a legal X span.
        this.sliderValue = 50;
        this.sliderMin = 0;
        this.sliderMax = 0;

        // Callbacks set by the parent component.
        this.onStateChange = null;
        this.onRedraw = null;
        this.onSliderChange = null;
    }

    setCallbacks({ onStateChange, onRedraw, onSliderChange }) {
        this.onStateChange = onStateChange;
        this.onRedraw = onRedraw;
        this.onSliderChange = onSliderChange;
    }

    _updateState(updates) {
        Object.assign(this, updates);
        if (this.onStateChange) this.onStateChange(this.getState());
    }

    // Compute the flick vector from the current line and emit it. Returns true
    // if a flick was sent. Does NOT touch striker velocity — the server sims.
    _emitFlick({ strikerRef, socket, roomName }) {
        if (!socket || !roomName || !strikerRef?.current) return false;
        const { angle, force, distance } = flickVector(
            this.flick.startX, this.flick.startY, this.flick.endX, this.flick.endY, this.flickMaxLength,
        );
        if (distance <= FLICK_DEAD_ZONE) return false;
        socket.emit("flick", { roomName, strikerX: strikerRef.current.x, angle, force });
        return true;
    }

    // ── Pointer interaction (canvas-space coords supplied by Board.jsx) ──────

    pointerDown(x, y, { isMyTurn, isAnimating, strikerRef }) {
        if (isAnimating || !isMyTurn || !strikerRef.current) return false;
        const s = strikerRef.current;
        this._updateState({
            isFlickerActive: true,
            flick: { active: true, startX: s.x, startY: s.y, endX: s.x, endY: s.y, initialX: x, initialY: y },
        });
        if (this.onRedraw) this.onRedraw();
        return true; // tell Board to capture the pointer
    }

    // Hot path: fires for every pointer sample during a drag. It mutates the aim
    // line only — `isFlickerActive` and `sliderValue` (the two things React
    // renders from) cannot change here, so it deliberately does NOT call
    // onStateChange. Doing so would re-render the component on every mouse move
    // to produce identical output. The canvas reads this.flick through the Hand
    // ref, so the redraw below sees the new line immediately.
    pointerMove(x, y, { isMyTurn, strikerRef }) {
        if (!this.flick.active || !isMyTurn || !strikerRef.current) return;
        const s = strikerRef.current;
        const end = flickEndpoint(s.x, s.y, this.flick.initialX, this.flick.initialY, x, y, this.flickMaxLength);
        this.flick = { ...this.flick, startX: s.x, startY: s.y, endX: end.x, endY: end.y };
        if (this.onRedraw) this.onRedraw();
    }

    pointerUp({ isMyTurn, strikerRef, socket, roomName }) {
        if (!this.flick.active) return;
        if (isMyTurn && strikerRef.current) {
            this._emitFlick({ strikerRef, socket, roomName });
        }
        this._resetFlick();
    }

    pointerCancel() {
        this._resetFlick();
    }

    _resetFlick() {
        this._updateState({
            isFlickerActive: false,
            flick: { active: false, startX: 0, startY: 0, endX: 0, endY: 0, initialX: 0, initialY: 0 },
        });
        if (this.onRedraw) this.onRedraw();
    }

    // ── Striker-placement slider ─────────────────────────────────────────────

    // Convenience used by Board: map a raw pointer to canvas space.
    pointerToCanvas(clientX, clientY, rect, canvasW, canvasH, playerRole) {
        return toCanvasCoords(clientX, clientY, rect, canvasW, canvasH, playerRole);
    }

    calculateSliderBoundaries(canvasRef, strikerRadius = 21) {
        if (!canvasRef.current) return;
        const ctx = canvasRef.current.getContext("2d");
        const boardX = (ctx.canvas.width - 750) / 2; // BOARD_SIZE = 750
        const baseX = boardX + (750 - 470) / 2;       // BASE_WIDTH = 470
        this.sliderMin = baseX + strikerRadius;
        this.sliderMax = baseX + 470 - strikerRadius;
    }

    sliderToX(percentage, playerRole = "creator") {
        if (this.sliderMax === 0) return 0;
        const p = playerRole === "joiner" ? 100 - percentage : percentage;
        return this.sliderMin + (this.sliderMax - this.sliderMin) * (p / 100);
    }

    xToSlider(x, playerRole = "creator") {
        if (this.sliderMax === 0) return 50;
        const p = Math.max(0, Math.min(100, ((x - this.sliderMin) / (this.sliderMax - this.sliderMin)) * 100));
        return playerRole === "joiner" ? 100 - p : p;
    }

    handleSliderChange(newValue, strikerRef, socket, roomName, playerRole) {
        this.sliderValue = Math.max(0, Math.min(100, newValue));
        if (!strikerRef.current) return;
        const newX = this.sliderToX(this.sliderValue, playerRole);
        strikerRef.current.updatePosition(newX, strikerRef.current.y);
        if (socket && roomName && this.onSliderChange) {
            this.onSliderChange({ sliderValue: this.sliderValue, strikerX: newX, playerRole });
        }
        if (this.onRedraw) this.onRedraw(); // reflect the new striker position locally
    }

    getState() {
        return {
            isFlickerActive: this.isFlickerActive,
            flick: { ...this.flick },
            flickMaxLength: this.flickMaxLength,
            sliderValue: this.sliderValue,
        };
    }

    reset() {
        this.flickMaxLength = Hand.FLICK_MAX_LENGTH;
        this._resetFlick();
    }
}

export default Hand;
