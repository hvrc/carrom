import { useEffect, useRef } from "react";
import Coin from "../Coin";
import { sampleBuffer, pruneBuffer, INTERP_DELAY } from "../interpolate.js";
import { scheduleTransfers, sampleTransfers, transfersDone } from "../transfers.js";
import { createRenderLoop } from "../renderLoop.js";

// Server-authoritative sync + the single render loop.
//
// The whole hook obeys one rule: **the server's simulation clock decides when
// things happen, and wall-clock only decides how smoothly they're drawn.**
//
// `physicsFrame` events are PRODUCERS — reconstruct full positions from the
// server's delta, buffer a timestamped snapshot. The rAF loop is the CONSUMER:
// it samples the buffer at `renderTime`, which is deliberately INTERP_DELAY ms
// behind the newest snapshot, lerps, and draws. That delay is what makes motion
// smooth under jitter — and it is why every other event has to be scheduled
// against `renderTime` too:
//
//   * pocketEvent carries `t` (sim ms). We hold it until renderTime reaches `t`,
//     THEN start the drop tween and pull the coin out of the live set. Applying
//     it on arrival — which is what the old code did — starts the tween while the
//     coin is still ~100 ms short of the pocket, by a different amount on each
//     client. That was the "coin disappears before it gets there" bug.
//   * turnResolved is not applied on arrival either. It waits until playback has
//     caught up to the final frame, the pocket tweens have finished, and the
//     end-of-turn transfers (coin → ledge, striker → opponent) have played out.
//     Snapping on arrival also threw away the last INTERP_DELAY ms of motion.
//
// Caller owns the canvas/striker/coins/piles/flying refs and `redrawCanvas`.
export default function useGameSync({
    keepAnimating = false,
    socket, roomName, playerRole,
    isAnimating, setIsAnimating, setHandState,
    handRef, strikerRef, coinsRef, pocketingCoinsRef, pilesRef, flyingRef,
    redrawCanvas, onLeaveRoom,
}) {
    const frameBufferRef = useRef([]);          // [{t, coins:[{id,x,y}], striker}]
    const wireFullRef = useRef(new Map());      // id -> {x,y}: last full positions (delta reconstruction)
    const latestTRef = useRef(0);               // newest snapshot's server time
    const latestArrivalRef = useRef(0);         // local time that snapshot arrived
    const animatingRef = useRef(false);         // a flick is streaming / still playing out
    const loopRef = useRef(null);               // the render loop (owns the rAF handle)
    const tickRef = useRef(null);               // latest renderTick, called by the loop
    const pendingPocketsRef = useRef([]);       // pocket events awaiting their sim time
    const pendingResolveRef = useRef(null);     // turnResolved payload awaiting settle
    const activeTransfersRef = useRef(null);    // scheduled end-of-turn transfers

    // Rebuild local Coin objects from a server snapshot + reseed the delta map.
    const applyServerCoins = (serverCoins) => {
        const next = serverCoins
            .filter((c) => !c.pocketed)
            .map((c) => new Coin({ id: c.id, color: c.color, x: c.x, y: c.y }));
        coinsRef.current = next;
        const full = new Map();
        for (const c of next) full.set(c.id, { x: c.x, y: c.y });
        wireFullRef.current = full;
    };

    // Where the render clock is: INTERP_DELAY behind the newest frame, advancing
    // with wall time since that frame landed. Before any frame arrives there is
    // no clock, and callers fall back to "apply immediately".
    const renderTimeAt = (now) =>
        latestArrivalRef.current === 0
            ? Infinity
            : latestTRef.current - INTERP_DELAY + (now - latestArrivalRef.current);

    // A pocket comes due when the render clock reaches the sim time it happened.
    const drainDuePockets = (renderTime, now) => {
        const pending = pendingPocketsRef.current;
        if (pending.length === 0) return;

        const due = pending.filter((p) => p.t == null || p.t <= renderTime);
        if (due.length === 0) return;
        pendingPocketsRef.current = pending.filter((p) => !(p.t == null || p.t <= renderTime));

        for (const p of due) {
            if (p.kind === "striker") {
                const striker = strikerRef.current;
                if (striker && p.pocket && p.from) {
                    striker.startPocketAnim(p.from.x, p.from.y, p.pocket.x, p.pocket.y, now);
                    striker.isStrikerMoving = false;
                }
                continue;
            }
            const idx = coinsRef.current.findIndex((c) => c.id === p.id);
            if (idx !== -1) {
                const coin = coinsRef.current[idx];
                if (p.pocket && p.from) {
                    coin.startPocketAnim(p.from.x, p.from.y, p.pocket.x, p.pocket.y, now);
                    pocketingCoinsRef.current.push(coin);
                }
                coinsRef.current = [
                    ...coinsRef.current.slice(0, idx),
                    ...coinsRef.current.slice(idx + 1),
                ];
            }
            wireFullRef.current.delete(p.id);
        }
    };

    // The turn is over and everything has played out: adopt the authoritative state.
    const applyResolved = (payload) => {
        const state = payload.state;
        applyServerCoins(state.coins);
        if (state.pocketedPiles && pilesRef) pilesRef.current = state.pocketedPiles;

        const striker = strikerRef.current;
        if (striker) {
            striker.resetPocketAnim();
            striker.x = state.striker.x;
            striker.y = state.striker.y;
            striker.velocity = { x: 0, y: 0 };
            striker.isStrikerMoving = false;
        }

        handRef.current.reset();
        setHandState(handRef.current.getState());

        frameBufferRef.current = [];
        pocketingCoinsRef.current = [];
        if (flyingRef) flyingRef.current = [];
        activeTransfersRef.current = null;
        pendingResolveRef.current = null;
        pendingPocketsRef.current = [];
        latestArrivalRef.current = 0;
        animatingRef.current = false;
        setIsAnimating(false);
        redrawCanvas();
    };

    // One frame: interpolate, release due pockets, advance tweens, settle, draw.
    // Returns whether there is more to do — the loop (renderLoop.js) owns the
    // scheduling, so this function can never leave a dead frame handle behind.
    const renderTick = () => {
        const now = performance.now();
        const striker = strikerRef.current;
        const renderTime = renderTimeAt(now);

        const buf = frameBufferRef.current;
        if (buf.length > 0) {
            const sample = sampleBuffer(buf, renderTime);
            if (sample) {
                const byId = new Map(coinsRef.current.map((c) => [c.id, c]));
                for (const sc of sample.coins) {
                    const c = byId.get(sc.id);
                    if (c && !c.beingPocketed) { c.x = sc.x; c.y = sc.y; }
                }
                if (sample.striker && striker && !striker.beingPocketed) {
                    striker.x = sample.striker.x;
                    striker.y = sample.striker.y;
                    striker.isStrikerMoving = true;
                }
            }
            pruneBuffer(buf, renderTime);
        }

        drainDuePockets(renderTime, now);

        pocketingCoinsRef.current = pocketingCoinsRef.current.filter(
            (c) => c.pocketProgress(now) < 1,
        );
        const strikerTweening =
            striker && striker.beingPocketed && striker.pocketProgress(now) < 1;

        // Playback is finished once the render clock has consumed the final frame.
        const playedOut =
            latestArrivalRef.current === 0 || renderTime >= latestTRef.current;
        const pocketsQuiet =
            pendingPocketsRef.current.length === 0 &&
            pocketingCoinsRef.current.length === 0 &&
            !strikerTweening;

        // End-of-turn: play the declared transfers, then adopt the final state.
        // Single exit — no `return` from inside here, so the loop bookkeeping at
        // the bottom always runs.
        let settled = false;
        if (pendingResolveRef.current && playedOut && pocketsQuiet) {
            const declared = pendingResolveRef.current.transfers || [];
            if (declared.length > 0 && activeTransfersRef.current === null) {
                activeTransfersRef.current = scheduleTransfers(declared, now);
            }
            const scheduled = activeTransfersRef.current;

            if (!scheduled || scheduled.length === 0) {
                applyResolved(pendingResolveRef.current); // nothing to animate
                settled = true;
            } else {
                if (flyingRef) flyingRef.current = sampleTransfers(scheduled, now);
                if (transfersDone(scheduled, now)) {
                    applyResolved(pendingResolveRef.current);
                    settled = true;
                }
            }
        }

        if (!settled) redrawCanvas(); // applyResolved already drew the final frame

        // An animated skin keeps the loop alive on its own; everything else
        // below is about the game having something left to play out.
        const busy = keepAnimating || (
            !settled && (
                animatingRef.current ||
                pendingPocketsRef.current.length > 0 ||
                pocketingCoinsRef.current.length > 0 ||
                strikerTweening ||
                pendingResolveRef.current != null
            ));

        return busy;
    };

    // The loop is created once and always calls the LATEST renderTick (which
    // closes over this render's props). Keeping the loop itself stable is what
    // lets ensureRenderLoop be safe to call from any event handler.
    tickRef.current = renderTick;
    if (loopRef.current === null) {
        loopRef.current = createRenderLoop(() => tickRef.current());
    }
    const ensureRenderLoop = () => loopRef.current.ensure();

    // gameInit (start / reset / reconnect): adopt full state, reset the burst.
    useEffect(() => {
        if (!socket || !roomName) return;
        const handleGameInit = (state) => {
            applyServerCoins(state.coins);
            if (state.pocketedPiles && pilesRef) pilesRef.current = state.pocketedPiles;
            if (strikerRef.current) {
                strikerRef.current.resetPocketAnim();
                strikerRef.current.x = state.striker.x;
                strikerRef.current.y = state.striker.y;
                strikerRef.current.velocity = { x: 0, y: 0 };
                strikerRef.current.isStrikerMoving = false;
            }
            pocketingCoinsRef.current = [];
            if (flyingRef) flyingRef.current = [];
            pendingPocketsRef.current = [];
            pendingResolveRef.current = null;
            activeTransfersRef.current = null;
            frameBufferRef.current = [];
            latestTRef.current = 0;
            latestArrivalRef.current = 0;
            animatingRef.current = false;
            handRef.current.reset();
            setHandState(handRef.current.getState());
            setIsAnimating(false);
            redrawCanvas();
        };
        socket.on("gameInit", handleGameInit);
        return () => socket.off("gameInit", handleGameInit);
    }, [socket, roomName, playerRole]);

    // physicsFrame (~30Hz during a flick): producer only — reconstruct + buffer.
    useEffect(() => {
        if (!socket || !roomName) return;
        const handlePhysicsFrame = (frame) => {
            const full = wireFullRef.current;
            for (const c of frame.coins) full.set(c.id, { x: c.x, y: c.y });
            const coins = [];
            for (const c of coinsRef.current) {
                const p = full.get(c.id);
                if (p) coins.push({ id: c.id, x: p.x, y: p.y });
            }
            frameBufferRef.current.push({
                t: frame.t,
                coins,
                striker: frame.striker ? { x: frame.striker.x, y: frame.striker.y } : null,
            });
            latestTRef.current = frame.t;
            latestArrivalRef.current = performance.now();
            animatingRef.current = true;
            if (!isAnimating) setIsAnimating(true);
            ensureRenderLoop();
        };
        socket.on("physicsFrame", handlePhysicsFrame);
        return () => socket.off("physicsFrame", handlePhysicsFrame);
    }, [socket, roomName, playerRole]);

    // pocketEvent: QUEUE it. The render loop releases it when the render clock
    // reaches `t` — see the header. Applying it here is the bug we fixed.
    useEffect(() => {
        if (!socket || !roomName) return;
        const handlePocketEvent = (p) => {
            pendingPocketsRef.current.push(p);
            ensureRenderLoop();
        };
        socket.on("pocketEvent", handlePocketEvent);
        return () => socket.off("pocketEvent", handlePocketEvent);
    }, [socket, roomName]);

    // turnResolved: hold it. The render loop applies it once playback, the pocket
    // tweens, and the transfers have all finished.
    useEffect(() => {
        if (!socket || !roomName) return;
        const handleTurnResolved = (payload) => {
            animatingRef.current = false; // no more frames are coming
            pendingResolveRef.current = payload;
            setIsAnimating(true);         // stay locked until it actually settles
            ensureRenderLoop();
        };
        socket.on("turnResolved", handleTurnResolved);
        return () => socket.off("turnResolved", handleTurnResolved);
    }, [socket, roomName, playerRole]);

    // roomClosed: any player left / room torn down → back to menu.
    useEffect(() => {
        if (!socket || !onLeaveRoom) return;
        const handleRoomClosed = () => onLeaveRoom();
        socket.on("roomClosed", handleRoomClosed);
        return () => socket.off("roomClosed", handleRoomClosed);
    }, [socket, onLeaveRoom]);

    // Ask for the authoritative snapshot now that THIS component's listeners are
    // live. Room asks too, but its request is answered before the board exists:
    // the reply is `roomUpdate` — which is what finally mounts the board — and
    // then `gameInit` immediately behind it. Delivered in the same tick, that
    // snapshot lands with nobody subscribed and is gone for good: an empty board
    // that only a refresh can fix. A request made from here cannot be answered
    // too early, so the coins can no longer be missed.
    //
    // Declared last on purpose — effects run in order, so every listener above is
    // already attached by the time this fires.
    useEffect(() => {
        if (!socket || !roomName) return;
        socket.emit("requestRoomData", { roomName });

        // Backstop for any other way of ending up with nothing on the board: if
        // there are still no coins a moment later and nothing is in flight to
        // explain it, ask once more.
        const retry = setTimeout(() => {
            const idle = !animatingRef.current && pendingResolveRef.current === null;
            if (coinsRef.current.length === 0 && idle) {
                socket.emit("requestRoomData", { roomName });
            }
        }, 2000);
        return () => clearTimeout(retry);
    }, [socket, roomName]);

    // An animated skin has to be kicked off once; after that the loop keeps
    // itself going because renderTick always reports itself busy.
    useEffect(() => {
        if (keepAnimating) ensureRenderLoop();
    }, [keepAnimating]);

    // Cancel the render loop on unmount.
    useEffect(() => () => loopRef.current?.stop(), []);
}
