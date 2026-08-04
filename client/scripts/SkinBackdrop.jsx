import { useEffect, useRef } from "react";
import Draw from "./Draw";
import { skinIsAnimated, skinSurface } from "./skins/index.js";

/**
 * The board's skin, painted across a page that has no board on it — the menu.
 *
 * The board screen paints this from its own render loop, because the pattern
 * has to stay in register with the pieces. There are no pieces here, so this
 * runs its own loop and hands the skin an imaginary board: a square the size of
 * the window, centred, which is all the transform needs to place the pattern at
 * a sensible scale.
 */
export default function SkinBackdrop() {
    const canvasRef = useRef(null);

    useEffect(() => {
        if (skinSurface() !== "canvas") return undefined;

        const canvas = canvasRef.current;
        if (!canvas) return undefined;
        const ctx = canvas.getContext("2d");
        if (!ctx) return undefined;

        let frame = 0;
        // Nothing to react to on the menu, so the pieces list is empty and the
        // field just breathes.
        const empty = { coinsRef: { current: [] }, strikerRef: { current: null } };

        const paint = () => {
            const w = Math.ceil(window.innerWidth);
            const h = Math.ceil(window.innerHeight);
            if (canvas.width !== w || canvas.height !== h) {
                canvas.width = w;
                canvas.height = h;
            }

            // A notional board, centred and sized to the window, so the pattern
            // lands at the same scale it has on the board screen.
            const side = Math.min(w, h) * 0.86;
            const rect = { left: (w - side) / 2, top: (h - side) / 2, width: side };

            Draw.drawSkinBackground(ctx, rect, { ...empty, time: performance.now() });
            frame = skinIsAnimated() ? requestAnimationFrame(paint) : 0;
        };

        paint();
        return () => { if (frame) cancelAnimationFrame(frame); };
    }, []);

    if (skinSurface() !== "canvas") return null;

    return (
        <canvas
            ref={canvasRef}
            style={{
                position: "fixed",
                inset: 0,
                width: "100%",
                height: "100%",
                pointerEvents: "none",
                zIndex: 0,
            }}
        />
    );
}
