// The input model: PLACE / FLICK modes, the board as a scrub bar, cancelling a
// shot, and the overlap lockout (PRD F1–F3). Also guards the fix for the
// strobing aim line.  cd client && npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Hand } from "../scripts/Hand.js";
import Striker from "../scripts/Striker.js";
import Coin from "../scripts/Coin.js";
import {
    SLIDER_MIN_X, SLIDER_MAX_X, BOARD_X, BOARD_SIZE, FLICK_DEAD_ZONE, isOnBoard,
    MOON_LEFT_X, MOON_RIGHT_X, MOON_RADIUS, STRIKER_RADIUS, strikerFoulsMoon, clampStrikerX,
} from "../scripts/flickMath.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const board = readFileSync(path.join(dir, "..", "scripts", "Board.jsx"), "utf8");

const BASELINE_Y = 762;
const MID = (SLIDER_MIN_X + SLIDER_MAX_X) / 2;

const setup = ({ coins = [] } = {}) => {
    const hand = new Hand();
    const strikerRef = { current: new Striker(MID, BASELINE_Y) };
    const emitted = [];
    const socket = { emit: (event, payload) => emitted.push({ event, payload }) };
    const calls = { redraw: 0, state: 0, place: 0 };
    hand.setCallbacks({
        onRedraw: () => calls.redraw++,
        onStateChange: () => calls.state++,
        onPlace: () => calls.place++,
    });
    const ctx = { isMyTurn: true, isAnimating: false, strikerRef, socket, roomName: "r" };
    return { hand, strikerRef, socket, emitted, calls, ctx, coins };
};

// ── PLACE mode: the whole board is a scrub bar (Q13) ────────────────────────

test("the game starts in place mode, not aiming", () => {
    const { hand } = setup();
    assert.equal(hand.getState().mode, "place");
    assert.equal(hand.flick.active, false);
});

test("pressing anywhere on the board snaps the striker to that x", () => {
    const { hand, strikerRef, ctx } = setup();
    // Press far from the striker, high up the board — nowhere near the baseline.
    hand.pointerDown(SLIDER_MIN_X + 40, BOARD_X + 100, ctx);
    assert.equal(strikerRef.current.x, SLIDER_MIN_X + 40, "the striker jumps straight to the press");
    assert.equal(strikerRef.current.y, BASELINE_Y, "but never leaves its baseline");
});

test("the striker tracks the pointer and stays inside the baseline span", () => {
    const { hand, strikerRef, ctx } = setup();
    hand.pointerDown(MID, BOARD_X + 200, ctx);
    hand.pointerMove(SLIDER_MIN_X - 9999, BOARD_X + 200, ctx);
    assert.equal(strikerRef.current.x, SLIDER_MIN_X, "clamped at the left end");
    hand.pointerMove(SLIDER_MAX_X + 9999, BOARD_X + 200, ctx);
    assert.equal(strikerRef.current.x, SLIDER_MAX_X, "and the right");
});

test("a press outside the board does nothing at all", () => {
    const { hand, strikerRef, ctx } = setup();
    const before = strikerRef.current.x;
    // On the wooden frame, not the playing surface.
    assert.equal(isOnBoard(BOARD_X - 20, BOARD_X - 20), false);
    const started = hand.pointerDown(BOARD_X - 20, BOARD_X - 20, ctx);
    assert.equal(started, false, "the gesture never starts");
    assert.equal(strikerRef.current.x, before, "and the striker doesn't move");
});

test("releasing after a placement tells the opponent where the striker ended up", () => {
    const { hand, ctx, calls } = setup();
    hand.pointerDown(MID + 30, BOARD_X + 300, ctx);
    hand.pointerMove(MID + 60, BOARD_X + 300, ctx);
    assert.equal(calls.place, 0, "not spammed mid-drag");
    hand.pointerUp(ctx);
    assert.equal(calls.place, 1, "relayed once, on release");
});

// ── Arming (F1) ────────────────────────────────────────────────────────────

test("arming switches to flick mode; a drag then aims instead of placing", () => {
    const { hand, strikerRef, ctx } = setup();
    hand.armFlick();
    assert.equal(hand.getState().mode, "flick");

    const x = strikerRef.current.x;
    hand.pointerDown(MID, BASELINE_Y, ctx);
    hand.pointerMove(MID + 50, BASELINE_Y + 40, ctx);
    assert.equal(hand.flick.active, true, "we're aiming");
    assert.equal(strikerRef.current.x, x, "and the striker no longer follows the pointer");
});

test("a full shot: pull back, release, one flick emitted", () => {
    const { hand, ctx, emitted } = setup();
    hand.armFlick();
    hand.pointerDown(MID, BASELINE_Y, ctx);
    hand.pointerMove(MID, BASELINE_Y + 60, ctx); // pull straight back
    hand.pointerUp(ctx);

    const flicks = emitted.filter((e) => e.event === "flick");
    assert.equal(flicks.length, 1);
    assert.ok(flicks[0].payload.force > 0);
    assert.equal(hand.getState().mode, "place", "and we're back to placing for next time");
});

// ── Cancelling (F2) ────────────────────────────────────────────────────────

test("cancelling mid-drag fires nothing and returns to place mode", () => {
    const { hand, ctx, emitted } = setup();
    hand.armFlick();
    hand.pointerDown(MID, BASELINE_Y, ctx);
    hand.pointerMove(MID, BASELINE_Y + 80, ctx); // a big, committed pull-back

    assert.equal(hand.cancelFlick(), true);
    assert.equal(hand.flick.active, false, "the line is gone");
    assert.equal(hand.getState().mode, "place");

    hand.pointerUp(ctx); // the finger/mouse still has to come up
    assert.deepEqual(emitted.filter((e) => e.event === "flick"), [], "nothing was shot");
});

test("a drag shorter than the dead zone throws the shot away but stays armed (Q4)", () => {
    const { hand, ctx, emitted } = setup();
    hand.armFlick();
    hand.pointerDown(MID, BASELINE_Y, ctx);
    hand.pointerMove(MID + FLICK_DEAD_ZONE - 1, BASELINE_Y, ctx); // barely moved
    hand.pointerUp(ctx);

    assert.deepEqual(emitted.filter((e) => e.event === "flick"), [], "no limp shot");
    assert.equal(hand.getState().flick.active, false, "the aim line is cleared");
    // Disarming is a double-click, never a single one — same gesture both ways.
    assert.equal(hand.getState().mode, "flick", "a plain click must not disarm");
});

test("a flick that actually fires drops back to place mode", () => {
    const { hand, ctx, emitted } = setup();
    hand.armFlick();
    hand.pointerDown(MID, BASELINE_Y, ctx);
    hand.pointerMove(MID + 60, BASELINE_Y, ctx);
    hand.pointerUp(ctx);

    assert.equal(emitted.filter((e) => e.event === "flick").length, 1, "the shot went out");
    assert.equal(hand.getState().mode, "place");
});

test("escape in place mode does nothing (Q3)", () => {
    const { hand } = setup();
    assert.equal(hand.cancelFlick(), false, "there is nothing to cancel");
    assert.equal(hand.getState().mode, "place");
});

// ── Baseline-circle placement rule ─────────────────────────────────────────

test("half on a baseline moon is an illegal placement; fully on or fully off is fine", () => {
    const { strikerRef } = setup();
    const at = (x) => {
        strikerRef.current.updatePosition(x, BASELINE_Y);
        return Hand.illegalPlacement(strikerRef.current, []);
    };

    // Dead centre on the moon: the moon is entirely under the striker — legal.
    assert.equal(at(MOON_LEFT_X), false, "fully covering the left moon is legal");
    assert.equal(at(MOON_RIGHT_X), false, "fully covering the right moon is legal");

    // Just off centre: touching it without covering it — foul.
    const partial = STRIKER_RADIUS - MOON_RADIUS + 1; // 6px off centre
    assert.equal(at(MOON_LEFT_X + partial), true, "half on the left moon is a foul");
    assert.equal(at(MOON_RIGHT_X - partial), true, "half on the right moon is a foul");

    // Well clear of both — legal.
    assert.equal(at(MID), false, "the middle of the baseline is legal");
    assert.equal(at(MOON_LEFT_X + STRIKER_RADIUS + MOON_RADIUS), false, "just clear is legal");
});

test("the clamped ends of the baseline are legal placements", () => {
    // Scrubbing to either extreme must not leave you stuck on a foul: the clamp
    // has to land where the striker fully covers the end moon.
    assert.equal(strikerFoulsMoon(clampStrikerX(-9999)), false, "the left end is shootable");
    assert.equal(strikerFoulsMoon(clampStrikerX(9999)), false, "the right end is shootable");
});

test("a striker half on a moon greys out and refuses to arm", () => {
    const { hand, strikerRef } = setup();
    strikerRef.current.updatePosition(MOON_LEFT_X + STRIKER_RADIUS - MOON_RADIUS + 1, BASELINE_Y);
    hand.setBlocked(Hand.illegalPlacement(strikerRef.current, []));

    assert.equal(hand.getState().blocked, true, "the striker renders greyed out");
    assert.equal(hand.armFlick(), false, "and FLICK is refused");
});

// ── Overlap lockout (F3) ───────────────────────────────────────────────────

test("a striker sitting on a coin cannot be armed or fired", () => {
    const { hand, strikerRef, ctx, emitted } = setup();
    const coin = new Coin({ id: 1, color: "white", x: strikerRef.current.x + 5, y: BASELINE_Y });
    assert.equal(Hand.overlapsCoin(strikerRef.current, [coin]), true);

    hand.setBlocked(true);
    assert.equal(hand.armFlick(), false, "FLICK is refused");
    assert.equal(hand.getState().mode, "place");

    // And even if a flick were somehow started, nothing goes out.
    hand.pointerDown(MID, BASELINE_Y, ctx);
    hand.pointerUp(ctx);
    assert.deepEqual(emitted.filter((e) => e.event === "flick"), []);
});

test("becoming blocked mid-aim disarms you rather than leaving a dead line", () => {
    const { hand } = setup();
    hand.armFlick();
    assert.equal(hand.getState().mode, "flick");
    hand.setBlocked(true); // the striker was scrubbed onto a coin
    assert.equal(hand.getState().mode, "place", "the aim is dropped");
    assert.equal(hand.flick.active, false);
});

test("overlap is exact: touching counts, a clear gap does not", () => {
    const striker = new Striker(400, BASELINE_Y);
    const reach = Striker.RADIUS + 15; // striker + coin radius
    const touching = new Coin({ id: 1, x: 400 + reach - 1, y: BASELINE_Y });
    const clear = new Coin({ id: 2, x: 400 + reach + 1, y: BASELINE_Y });
    assert.equal(Hand.overlapsCoin(striker, [touching]), true);
    assert.equal(Hand.overlapsCoin(striker, [clear]), false);
    // A pocketed coin isn't on the board any more, so it can't block anything.
    const pocketed = new Coin({ id: 3, x: 400, y: BASELINE_Y });
    pocketed.pocketed = true;
    assert.equal(Hand.overlapsCoin(striker, [pocketed]), false);
});

// ── The aim line must not strobe (regression guard) ────────────────────────

test("the aim line lives on the Hand ref, so every draw path sees the live line", () => {
    const { hand, ctx, calls } = setup();
    hand.armFlick();
    hand.pointerDown(MID, BASELINE_Y, ctx);

    hand.pointerMove(MID + 20, BASELINE_Y + 20, ctx);
    const first = { ...hand.getState().flick };
    hand.pointerMove(MID + 40, BASELINE_Y + 40, ctx);
    const second = hand.getState().flick;

    assert.notDeepEqual(
        { x: first.endX, y: first.endY },
        { x: second.endX, y: second.endY },
        "getState() must reflect the latest pointer sample — the canvas reads this",
    );
    assert.ok(calls.redraw >= 3, "and every change asks for a redraw");
});

test("dragging the aim line does not re-render React", () => {
    const { hand, ctx, calls } = setup();
    hand.armFlick();
    hand.pointerDown(MID, BASELINE_Y, ctx);
    const afterDown = calls.state;
    for (let i = 0; i < 20; i++) hand.pointerMove(MID + i, BASELINE_Y + i, ctx);
    assert.equal(calls.state, afterDown, "nothing React renders can change mid-drag");
});

test("Board draws from the Hand ref, never from React state", () => {
    const createGameState = board.slice(
        board.indexOf("const createGameState"),
        board.indexOf("const activePointerRef"),
    );
    assert.ok(createGameState.length > 0, "createGameState must still exist");
    assert.match(createGameState, /handRef\.current\.getState\(\)/);
    assert.doesNotMatch(
        createGameState,
        /handState\./,
        "reading handState here would drop the flick line from stale-closure draws",
    );
});

test("Board has no post-paint draw keyed on the flick state", () => {
    // A useEffect on handState.flick draws AFTER paint, racing the synchronous aim
    // draw. That race was the strobe.
    for (const deps of [...board.matchAll(/\}, \[([^\]]*)\]\);/g)].map((m) => m[1])) {
        assert.doesNotMatch(deps, /handState\.flick|handState\.isFlickerActive/);
    }
});

test("aim redraws are coalesced to one per animation frame", () => {
    assert.match(board, /requestAnimationFrame\(\(\) => \{[\s\S]*?redrawCanvas\(\)/);
    assert.match(board, /if \(aimFrameRef\.current != null\) return;/);
});

test("the slider is gone: placement is pointer-driven", () => {
    assert.doesNotMatch(board, /type="range"/, "the invisible range input must be gone");
    assert.doesNotMatch(board, /strikerSliderUpdate/, "and its relay event with it");
    assert.match(board, /strikerPlaceUpdate/, "replaced by a board-space X relay");
});

// ── Double-clicking the striker toggles the mode ───────────────────────────

test("setMode toggles both ways", () => {
    const { hand } = setup();
    assert.equal(hand.setMode("flick"), "flick");
    assert.equal(hand.getState().mode, "flick");
    assert.equal(hand.setMode("place"), "place");
    assert.equal(hand.getState().mode, "place");
});

test("you cannot toggle into flick while the striker is on a coin", () => {
    const { hand } = setup();
    hand.setBlocked(true);
    assert.equal(hand.setMode("flick"), "place", "there is no legal shot to arm");
    assert.equal(hand.getState().mode, "place");
});

test("a double-click in flick mode disarms — the clicks inside it do not", () => {
    // Both directions of the toggle are a double-click. The two clicks that make
    // one up land as sub-dead-zone drags first; those must leave the mode alone,
    // or the dblclick would be toggling off a mode that already flipped.
    const { hand, ctx } = setup();
    hand.armFlick();

    const modeBeforeClicks = hand.getState().mode;      // what Board records on pointerdown
    assert.equal(modeBeforeClicks, "flick");

    hand.pointerDown(MID, BASELINE_Y, ctx);             // click 1 of the double-click
    hand.pointerUp(ctx);
    hand.pointerDown(MID, BASELINE_Y, ctx);             // click 2
    hand.pointerUp(ctx);
    assert.equal(hand.getState().mode, "flick", "the clicks alone leave you armed");

    // Board toggles from the REMEMBERED mode, so we end up disarmed, as intended.
    const next = modeBeforeClicks === "flick" ? "place" : "flick";
    assert.equal(hand.setMode(next), "place");
    assert.equal(hand.getState().mode, "place");
});

test("Board only toggles when the double-click lands on the striker", () => {
    const dbl = board.slice(board.indexOf("const handleDoubleClick"), board.indexOf("const handleContextMenu"));
    assert.match(dbl, /isPointInside/, "a double-click anywhere else on the board must do nothing");
    assert.match(dbl, /modeBeforeClickRef/, "and it must toggle from the pre-click mode");
});
