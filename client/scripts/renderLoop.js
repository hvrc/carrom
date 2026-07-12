// A self-stopping animation loop with one invariant: the handle means "a frame
// is scheduled", and nothing else.
//
// This exists because getting that invariant wrong froze the game. The loop used
// to be inline in useGameSync, and the end-of-turn path `return`ed straight out of
// the tick — skipping the bookkeeping at the bottom that nulls the handle. After
// one completed turn the handle held a dead frame id forever, so `ensure()`
// believed a loop was already running and never started another. The next flick
// buffered frames that nothing drew, and the input gate never re-opened.
//
// Here the handle is released the moment we enter a frame, so every exit — an
// early return, a thrown error, or a tick that reports "done" — leaves it honest,
// and the next event can always restart the loop.
//
// `tick()` returns whether there is more to do. Truthy → schedule another frame.
export function createRenderLoop(tick, {
    raf = (fn) => requestAnimationFrame(fn),
    caf = (h) => cancelAnimationFrame(h),
} = {}) {
    let handle = null;

    const frame = () => {
        handle = null; // we're inside the frame now — the id is spent
        if (tick()) handle = raf(frame);
    };

    return {
        // Start the loop if it isn't already running. Safe to call on every event.
        ensure() {
            if (handle == null) handle = raf(frame);
        },
        stop() {
            if (handle != null) caf(handle);
            handle = null;
        },
        get scheduled() {
            return handle != null;
        },
    };
}
