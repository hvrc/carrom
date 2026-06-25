import { useEffect, useRef } from "react";
import Coin from "../Coin";
import { sampleBuffer, pruneBuffer, INTERP_DELAY } from "../interpolate.js";

// Server-authoritative sync + the single render loop.
//
// Owns the snapshot-interpolation state and the requestAnimationFrame loop, and
// installs the four gameplay socket listeners (gameInit / physicsFrame /
// pocketEvent / turnResolved) plus roomClosed. physicsFrame events are PRODUCERS
// (reconstruct full positions from the server's delta → buffer a timestamped
// snapshot); the rAF loop is the CONSUMER (samples the buffer ~INTERP_DELAY ms
// in the past, lerps, and draws), so motion stays smooth regardless of network
// jitter. The loop also drives pocket-drop tweens and stops when idle.
//
// Caller owns the canvas/striker/coins/hand refs and the `redrawCanvas` drawer;
// they're passed in so the caller's createGameState (and slider preview) keep
// working off the same refs.
export default function useGameSync({
    socket, roomName, playerRole,
    isAnimating, setIsAnimating, setHandState,
    handRef, strikerRef, coinsRef, pocketingCoinsRef,
    redrawCanvas, onLeaveRoom,
}) {
    const frameBufferRef = useRef([]);          // [{t, coins:[{id,x,y}], striker}]
    const wireFullRef = useRef(new Map());      // id -> {x,y}: last full positions (delta reconstruction)
    const latestTRef = useRef(0);               // newest snapshot's server time
    const latestArrivalRef = useRef(0);         // local time that snapshot arrived
    const animatingRef = useRef(false);         // a flick is streaming
    const renderLoopRef = useRef(null);         // rAF handle
    const pendingStrikerSyncRef = useRef(null); // deferred striker re-placement (after a pocket tween)
    const pocketedThisTurnRef = useRef([]);

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

    // One frame: interpolate from the buffer, advance tweens, draw; self-stop when idle.
    const renderTick = () => {
        const now = performance.now();
        const striker = strikerRef.current;

        const buf = frameBufferRef.current;
        if (animatingRef.current && buf.length > 0) {
            const renderTime = latestTRef.current - INTERP_DELAY + (now - latestArrivalRef.current);
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

        pocketingCoinsRef.current = pocketingCoinsRef.current.filter(
            (c) => c.pocketProgress(now) < 1,
        );
        const strikerTweening =
            striker && striker.beingPocketed && striker.pocketProgress(now) < 1;
        if (striker && striker.beingPocketed && !strikerTweening) {
            striker.resetPocketAnim();
            const pending = pendingStrikerSyncRef.current;
            if (pending) {
                striker.x = pending.x;
                striker.y = pending.y;
                striker.velocity = { x: 0, y: 0 };
                striker.isStrikerMoving = false;
                pendingStrikerSyncRef.current = null;
            }
        }

        redrawCanvas();

        if (animatingRef.current || pocketingCoinsRef.current.length > 0 || strikerTweening) {
            renderLoopRef.current = requestAnimationFrame(renderTick);
        } else {
            renderLoopRef.current = null;
            redrawCanvas(); // settle on the final authoritative frame
        }
    };

    const ensureRenderLoop = () => {
        if (renderLoopRef.current == null) {
            renderLoopRef.current = requestAnimationFrame(renderTick);
        }
    };

    // gameInit (start / reset / reconnect): adopt full state, reset the burst.
    useEffect(() => {
        if (!socket || !roomName) return;
        const handleGameInit = (state) => {
            applyServerCoins(state.coins);
            if (strikerRef.current) {
                strikerRef.current.resetPocketAnim();
                strikerRef.current.x = state.striker.x;
                strikerRef.current.y = state.striker.y;
                strikerRef.current.velocity = { x: 0, y: 0 };
                strikerRef.current.isStrikerMoving = false;
            }
            pocketingCoinsRef.current = [];
            pocketedThisTurnRef.current = [];
            frameBufferRef.current = [];
            latestTRef.current = 0;
            animatingRef.current = false;
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
            if (strikerRef.current && !frame.striker) {
                strikerRef.current.isStrikerMoving = false; // pocketed mid-flick
            }
            animatingRef.current = true;
            if (!isAnimating) setIsAnimating(true);
            ensureRenderLoop();
        };
        socket.on("physicsFrame", handlePhysicsFrame);
        return () => socket.off("physicsFrame", handlePhysicsFrame);
    }, [socket, roomName, playerRole]);

    // pocketEvent: start the drop tween + remove the coin from the live set.
    useEffect(() => {
        if (!socket || !roomName) return;
        const handlePocketEvent = (p) => {
            if (p.kind === "striker") {
                const striker = strikerRef.current;
                if (striker && p.pocket && p.from) {
                    striker.startPocketAnim(p.from.x, p.from.y, p.pocket.x, p.pocket.y);
                    striker.isStrikerMoving = false;
                    ensureRenderLoop();
                }
                pocketedThisTurnRef.current.push(p);
                return;
            }
            const idx = coinsRef.current.findIndex((c) => c.id === p.id);
            if (idx !== -1) {
                const coin = coinsRef.current[idx];
                if (p.pocket) {
                    coin.startPocketAnim(p.pocket.x, p.pocket.y);
                    pocketingCoinsRef.current.push(coin);
                    ensureRenderLoop();
                }
                coinsRef.current = [
                    ...coinsRef.current.slice(0, idx),
                    ...coinsRef.current.slice(idx + 1),
                ];
            }
            wireFullRef.current.delete(p.id);
            pocketedThisTurnRef.current.push(p);
        };
        socket.on("pocketEvent", handlePocketEvent);
        return () => socket.off("pocketEvent", handlePocketEvent);
    }, [socket, roomName]);

    // turnResolved: end the burst, snap to authoritative state, sync slider.
    useEffect(() => {
        if (!socket || !roomName) return;
        const handleTurnResolved = (payload) => {
            const state = payload.state;
            frameBufferRef.current = [];
            animatingRef.current = false;
            applyServerCoins(state.coins);
            const striker = strikerRef.current;
            if (striker) {
                if (striker.beingPocketed) {
                    pendingStrikerSyncRef.current = { x: state.striker.x, y: state.striker.y };
                } else {
                    striker.resetPocketAnim();
                    striker.x = state.striker.x;
                    striker.y = state.striker.y;
                    striker.velocity = { x: 0, y: 0 };
                    striker.isStrikerMoving = false;
                }
            }
            handRef.current.sliderValue = handRef.current.xToSlider(state.striker.x, playerRole);
            setHandState(handRef.current.getState());
            pocketedThisTurnRef.current = [];
            setIsAnimating(false);
            redrawCanvas();
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

    // Cancel the render loop on unmount.
    useEffect(() => {
        return () => {
            if (renderLoopRef.current != null) {
                cancelAnimationFrame(renderLoopRef.current);
                renderLoopRef.current = null;
            }
        };
    }, []);
}
