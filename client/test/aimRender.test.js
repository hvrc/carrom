// Guards the fix for the strobing aim line.
//
// The bug: Board registered `onRedraw` once in a []-deps effect, so its
// createGameState closure captured the FIRST render's `handState` — where
// flick.active is false forever. Every pointer move therefore ran a synchronous
// draw that cleared the canvas and skipped the line, while a separate
// post-paint effect (keyed on handState.flick) drew the line. Two draw paths
// disagreeing, one before paint and one after → the line flickered on and off.
//
// The fix has two halves, and both are asserted here:
//   1. Behaviour — the Hand ref is the source of truth for the aim line, so any
//      draw path (even a stale closure) sees the current line.
//   2. Source    — Board must not reintroduce a state-driven draw path.
//   cd client && npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Hand } from "../scripts/Hand.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const board = readFileSync(path.join(dir, "..", "scripts", "Board.jsx"), "utf8");

const mkHand = () => {
    const hand = new Hand();
    const strikerRef = { current: { x: 400, y: 700 } };
    const calls = { redraw: 0, state: 0 };
    hand.setCallbacks({
        onRedraw: () => calls.redraw++,
        onStateChange: () => calls.state++,
        onSliderChange: () => {},
    });
    return { hand, strikerRef, calls };
};

test("the aim line lives on the Hand ref, so any draw path sees the live line", () => {
    const { hand, strikerRef, calls } = mkHand();
    hand.pointerDown(400, 700, { isMyTurn: true, isAnimating: false, strikerRef });

    hand.pointerMove(450, 760, { isMyTurn: true, strikerRef });
    const afterFirst = hand.getState().flick;
    assert.equal(afterFirst.active, true);

    hand.pointerMove(500, 800, { isMyTurn: true, strikerRef });
    const afterSecond = hand.getState().flick;

    // getState() must reflect the LATEST pointer sample — this is what the
    // canvas reads. If drawing ever goes back to React state, it lags a render
    // behind and the two paths disagree.
    assert.notDeepEqual(
        { x: afterFirst.endX, y: afterFirst.endY },
        { x: afterSecond.endX, y: afterSecond.endY },
        "flick endpoint must advance with the pointer",
    );
    assert.equal(calls.redraw, 3, "down + two moves must each request a redraw");
});

test("dragging does not re-render React: no state change on the pointer hot path", () => {
    const { hand, strikerRef, calls } = mkHand();
    hand.pointerDown(400, 700, { isMyTurn: true, isAnimating: false, strikerRef });
    const afterDown = calls.state; // isFlickerActive flipped — a state change is correct here

    for (let i = 0; i < 20; i++) {
        hand.pointerMove(400 + i, 700 + i, { isMyTurn: true, strikerRef });
    }

    // Neither isFlickerActive nor sliderValue can change during a move, so React
    // has nothing to re-render. 20 moves must cost 0 state updates and 20 draws.
    assert.equal(calls.state, afterDown, "pointerMove must not call onStateChange");
    assert.equal(calls.redraw, 1 + 20, "every move still requests exactly one redraw");
});

test("Board draws the aim line from the Hand ref, never from React state", () => {
    const createGameState = board.slice(
        board.indexOf("const createGameState"),
        board.indexOf("const handleSliderChange"),
    );
    assert.match(
        createGameState,
        /handRef\.current\.getState\(\)/,
        "createGameState must read the aim state from the Hand ref",
    );
    assert.doesNotMatch(
        createGameState,
        /handState\./,
        "createGameState must not read handState — stale closures would drop the flick line",
    );
});

test("Board has no post-paint draw keyed on the flick state", () => {
    // A useEffect depending on handState.flick / handState.isFlickerActive draws
    // AFTER paint, racing the synchronous aim draw. That race was the strobe.
    const effectDeps = [...board.matchAll(/\}, \[([^\]]*)\]\);/g)].map((m) => m[1]);
    for (const deps of effectDeps) {
        assert.doesNotMatch(
            deps,
            /handState\.flick|handState\.isFlickerActive/,
            "no effect may be keyed on the flick state (post-paint draws race the aim draw)",
        );
    }
});

test("aim redraws are coalesced to one per animation frame", () => {
    assert.match(
        board,
        /requestAnimationFrame\(\(\) => \{[\s\S]*?redrawCanvas\(\)/,
        "scheduleRedraw must defer the draw to an animation frame",
    );
    assert.match(
        board,
        /if \(aimFrameRef\.current != null\) return;/,
        "scheduleRedraw must drop duplicate requests within a frame",
    );
});
