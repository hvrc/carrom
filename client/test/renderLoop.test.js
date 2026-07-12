// The render loop's one invariant: the handle means "a frame is scheduled".
// Breaking it froze the game — after one completed turn the loop believed it was
// still running, so it never restarted, the next flick drew nothing, and the
// input gate never re-opened.  cd client && npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRenderLoop } from "../scripts/renderLoop.js";

// A hand-cranked requestAnimationFrame: frames only happen when we say so.
const fakeRaf = () => {
    let next = 1;
    const queued = new Map();
    return {
        raf: (fn) => { const id = next++; queued.set(id, fn); return id; },
        caf: (id) => queued.delete(id),
        // Run every frame currently queued (a frame may queue the next one).
        flush() {
            const now = [...queued.entries()];
            queued.clear();
            for (const [, fn] of now) fn();
            return now.length;
        },
        get pending() { return queued.size; },
    };
};

test("keeps running while there is work, and stops when there isn't", () => {
    const clock = fakeRaf();
    let work = 3;
    const loop = createRenderLoop(() => --work > 0, clock);

    loop.ensure();
    assert.equal(loop.scheduled, true);

    clock.flush(); // work 3 -> 2, busy
    assert.equal(loop.scheduled, true);
    clock.flush(); // work 2 -> 1, busy
    clock.flush(); // work 1 -> 0, done
    assert.equal(loop.scheduled, false, "a loop with nothing to do must stop");
    assert.equal(clock.pending, 0);
});

test("a stopped loop can be restarted — THE FREEZE", () => {
    // The turn ends: the tick reports "nothing more to do" and the loop stops.
    // The next flick then calls ensure(). If the handle were left dangling from
    // the finished turn, ensure() would see a loop already running and do nothing
    // — no frames, no draws, and the input gate stuck closed. That was the freeze,
    // and it appeared on the SECOND flick of a game, because the first turn is
    // what left the handle dangling.
    const clock = fakeRaf();
    let busy = true;
    const loop = createRenderLoop(() => busy, clock);

    loop.ensure();
    clock.flush();
    assert.equal(loop.scheduled, true, "turn 1 is animating");

    busy = false;
    clock.flush();                                   // turn 1 settles
    assert.equal(loop.scheduled, false, "the loop stopped, as it should");

    busy = true;
    loop.ensure();                                   // turn 2 arrives
    assert.equal(loop.scheduled, true, "and the loop MUST come back to life");
    assert.equal(clock.flush(), 1, "frames are running again");
});

test("ensure() is idempotent — one loop, not five", () => {
    const clock = fakeRaf();
    const loop = createRenderLoop(() => true, clock);
    loop.ensure();
    loop.ensure();
    loop.ensure();
    assert.equal(clock.pending, 1, "calling ensure on every socket event must not stack loops");
});

test("a tick that throws does not wedge the loop forever", () => {
    // Defensive: the handle is released on entry, so even a crashing frame leaves
    // the loop restartable rather than permanently 'running'.
    const clock = fakeRaf();
    let boom = true;
    const loop = createRenderLoop(() => {
        if (boom) throw new Error("bad frame");
        return false;
    }, clock);

    loop.ensure();
    assert.throws(() => clock.flush(), /bad frame/);
    assert.equal(loop.scheduled, false, "the dead frame's handle was released");

    boom = false;
    loop.ensure();
    assert.equal(loop.scheduled, true, "and the loop can be restarted");
});

test("stop() cancels a pending frame and leaves the loop restartable", () => {
    const clock = fakeRaf();
    const loop = createRenderLoop(() => true, clock);
    loop.ensure();
    loop.stop();
    assert.equal(loop.scheduled, false);
    assert.equal(clock.pending, 0, "the queued frame is cancelled (unmount)");
    loop.ensure();
    assert.equal(loop.scheduled, true);
});

test("the tick's own frame handle is spent before it runs", () => {
    // Inside a frame, `scheduled` must be false: that frame is happening now. If a
    // tick observed itself as 'scheduled' it could skip re-arming the loop.
    const clock = fakeRaf();
    let seenInside = null;
    const loop = createRenderLoop(() => {
        seenInside = loop.scheduled;
        return false;
    }, clock);
    loop.ensure();
    clock.flush();
    assert.equal(seenInside, false);
});
