import { useEffect, useRef, useState } from "react";
import Draw from "./Draw";
import Hand from "./Hand";
import * as Events from "./Events";
import { toCanvasCoords } from "./flickMath.js";
import useResponsiveScale from "./hooks/useResponsiveScale.js";
import useGameSync from "./hooks/useGameSync.js";
import "./Board.css";

// A player in the info bar: NAME, then games won (bold), then the score.
// The wins column is omitted entirely until they've won one, so a first game
// reads "ALICE 0   BOB 0" and afterwards "ALICE 1 0   BOB 0 0".
function PlayerTag({ name, data }) {
    const wins = data?.wins || 0;
    const score = data?.score ?? 0;
    return (
        <span>
            {name ? name.toUpperCase() : "?"}
            {wins > 0 && <>&nbsp; <b>{wins}</b></>}
            &nbsp; {score}
        </span>
    );
}

// GameCanvas: presentation + input. The canvas/striker/coins/hand state live in
// refs; server sync and the render loop are in useGameSync; responsive scale in
// useResponsiveScale. React state is reserved for discrete UI.
function GameCanvas({isMyTurn = true, socket, playerRole, roomName, manager, onLeaveRoom, creatorUsername = "", joinerUsername = ""}) {
    const [showHelp, setShowHelp] = useState(false);
    const handleHelpToggle = () => {
        setShowHelp(prev => !prev);
    };

    // Refs hold all 60fps game state (canvas, striker, coins). React state is
    // reserved for discrete UI: handState (mode/cursor) and isAnimating
    // (input gating). The canvas is drawn from refs by the rAF loop, never from
    // a React re-render.
    const canvasRef = useRef(null);
    const strikerRef = useRef(null);
    const handRef = useRef(new Hand());
    const [handState, setHandState] = useState(handRef.current.getState());
    const [isAnimating, setIsAnimating] = useState(false);
    const [isStrikerColliding] = useState(false);
    const coinsRef = useRef([]);
    // Coins currently playing the shrink-into-pocket tween. Lives outside
    // coinsRef so it survives applyServerCoins() rebuilds in useGameSync.
    const pocketingCoinsRef = useRef([]);
    // The opponent's relayed aim line, drawn as a faded ghost while they aim.
    const peerAimRef = useRef({ active: false });
    // Pocketed coins, per player, in the order they were pocketed — drawn on the
    // wooden ledge. Authoritative: comes from the server's snapshots.
    const pilesRef = useRef({ creator: [], joiner: [] });
    // Pieces currently travelling between two places (see transfers.js).
    const flyingRef = useRef([]);
    // True while the striker overlaps a coin: it cannot be flicked from there.
    const strikerBlockedRef = useRef(false);

    useEffect(() => {
        // Coins are seeded from the server's `gameInit` event (see the dedicated
        // useEffect below). We start empty; the first gameInit/turnResolved
        // snapshot populates coinsRef and triggers a redraw. The striker is
        // auto-instantiated on first draw by Draw.drawBoard.
        coinsRef.current = [];

        handRef.current.setCallbacks({
            onStateChange: (newState) => setHandState(newState),
            // Redraw when the aim line or the striker's placement changes. Goes
            // through scheduleRedraw so a burst of pointer moves costs one draw.
            onRedraw: () => scheduleRedraw(),
            // Placement preview: the opponent watches the striker being scrubbed.
            onPlace: ({ strikerX }) => {
                if (socket && roomName) {
                    socket.emit("strikerPlaceUpdate", { roomName, playerRole, strikerX });
                }
            },
        });
    }, []);

    // helper function to create game state object for drawing
    // why have we chosen these values? are all these values used?
    // is it optiam to have these values and not any other?
    // is there a better way to create, store and reference a game state?

    // Read the aim state from the Hand ref, never from `handState`. React state
    // lags a render behind the pointer, and callbacks registered once (onRedraw,
    // the socket effects) would otherwise close over the first render's value
    // forever and draw the board with no flick line — erasing the line that the
    // post-paint effect had just drawn. Refs make every draw path agree.
    const createGameState = () => {
        const hand = handRef.current.getState();
        return {
            strikerRef,
            coinsRef,
            pocketingCoinsRef,
            isStrikerColliding,
            isFlickerActive: hand.isFlickerActive,
            flick: hand.flick,
            flickMaxLength: hand.flickMaxLength,
            peerAim: peerAimRef.current,
            piles: pilesRef.current,
            flying: flyingRef.current,
            strikerBlocked: strikerBlockedRef.current,
        };
    };
    
    // Unified pointer input (mouse + touch + pen). On down we capture the pointer
    // so a drag that leaves the board keeps delivering move/up events — but only
    // the pointer that STARTED the gesture drives it; a second one cancels.
    const activePointerRef = useRef(null);
    const lastPointerTypeRef = useRef("mouse");

    const pointerToCanvas = (e) => {
        const c = canvasRef.current;
        return toCanvasCoords(
            e.clientX, e.clientY, c.getBoundingClientRect(), c.width, c.height, playerRole,
        );
    };

    const handlePointerDown = (e) => {
        lastPointerTypeRef.current = e.pointerType || "mouse";

        // TOUCH CANCEL (F2): one finger is dragging the slingshot and a second one
        // taps. That's the "undo" — the shot is called off and we drop back to
        // placing. Nothing is fired.
        if (handRef.current.flick.active && activePointerRef.current !== null &&
            e.pointerId !== activePointerRef.current) {
            handRef.current.cancelFlick();
            return;
        }

        const { x, y } = pointerToCanvas(e);
        const started = handRef.current.pointerDown(x, y, { isMyTurn, isAnimating, strikerRef });
        if (started) {
            activePointerRef.current = e.pointerId;
            try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* unsupported */ }
        }
    };

    const handlePointerMove = (e) => {
        if (activePointerRef.current !== null && e.pointerId !== activePointerRef.current) return;
        const { x, y } = pointerToCanvas(e);
        handRef.current.pointerMove(x, y, { isMyTurn, strikerRef });
    };

    const handlePointerUp = (e) => {
        if (activePointerRef.current !== null && e.pointerId !== activePointerRef.current) return;
        handRef.current.pointerUp({ isMyTurn, strikerRef, socket, roomName });
        activePointerRef.current = null;
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* unsupported */ }
    };

    const handlePointerCancel = () => {
        activePointerRef.current = null;
        handRef.current.pointerCancel();
    };

    // Double-click arms the slingshot — DESKTOP ONLY (Q14). On touch a double-tap
    // is far too easy to trigger while scrubbing the striker into place, so there
    // the FLICK button is the only way to arm.
    const handleDoubleClick = () => {
        if (lastPointerTypeRef.current !== "mouse") return;
        if (!isMyTurn || isAnimating) return;
        handRef.current.armFlick();
    };

    // Right-click cancels an in-progress flick (F2), and never opens a context
    // menu over the board.
    const handleContextMenu = (e) => {
        e.preventDefault();
        handRef.current.cancelFlick();
    };

    // Escape cancels an in-progress flick. In place mode it does nothing.
    useEffect(() => {
        const onKeyDown = (e) => {
            if (e.key === "Escape") handRef.current.cancelFlick();
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, []);

    const redrawCanvas = () => {
        const ctx = canvasRef.current?.getContext("2d");
        if (!ctx) return;

        // F3: is the striker sitting on a coin? Recomputed every draw, because it
        // changes as you scrub the striker along the baseline. Cheap — at most 19
        // coins. The result greys the striker, kills the FLICK button, and (via
        // Hand) disarms you if you were already aiming when it became true.
        const blocked = !!strikerRef.current &&
            Hand.overlapsCoin(strikerRef.current, coinsRef.current);
        strikerBlockedRef.current = blocked;
        handRef.current.setBlocked(blocked); // no-op unless it actually changed

        Draw.drawBoard(ctx, createGameState(), playerRole);
    };

    // Mirror my aim line to the opponent. Called from the same animation frame
    // as the redraw, so it is frame-throttled for free (~60/s, ~60-byte payload)
    // instead of firing once per raw pointer sample. The dedupe means a held-
    // still pointer costs nothing, and the final active:false (sent on release
    // via _resetFlick -> onRedraw) clears their ghost line exactly once.
    // isMyTurn flips during the room's life, and broadcastAim is reached from the
    // once-registered onRedraw callback — so read it through a ref, or that
    // closure would keep answering with whatever the turn was at mount.
    const isMyTurnRef = useRef(isMyTurn);
    isMyTurnRef.current = isMyTurn;

    const lastAimSentRef = useRef("");
    const broadcastAim = () => {
        if (!socket || !roomName || !isMyTurnRef.current) return;
        const { flick } = handRef.current.getState();
        const aim = flick.active
            ? { active: true, startX: flick.startX, startY: flick.startY, endX: flick.endX, endY: flick.endY }
            : { active: false };
        const key = JSON.stringify(aim);
        if (key === lastAimSentRef.current) return;
        lastAimSentRef.current = key;
        socket.emit("aimUpdate", { roomName, playerRole, ...aim });
    };

    // Pointer events arrive faster than the display refreshes (and browsers
    // coalesce them unevenly), so drawing once per event both wastes work and
    // lets a half-finished burst decide what the next paint shows. Collapse any
    // number of aim updates into a single draw on the next frame.
    const aimFrameRef = useRef(null);
    const scheduleRedraw = () => {
        if (aimFrameRef.current != null) return;
        aimFrameRef.current = requestAnimationFrame(() => {
            aimFrameRef.current = null;
            redrawCanvas();
            broadcastAim();
        });
    };
    useEffect(() => () => {
        if (aimFrameRef.current != null) cancelAnimationFrame(aimFrameRef.current);
    }, []);

    // Server-authoritative sync + the single render loop (gameInit / physicsFrame
    // / pocketEvent / turnResolved / roomClosed). Owns the interpolation buffer
    // and the rAF loop; draws via redrawCanvas above.
    useGameSync({
        socket, roomName, playerRole,
        isAnimating, setIsAnimating, setHandState,
        handRef, strikerRef, coinsRef, pocketingCoinsRef, pilesRef, flyingRef,
        redrawCanvas, onLeaveRoom,
    });

    // Relay-only: the opponent's aim line while they line up a shot. Lives in a
    // ref (not state) for the same reason the local flick line does — it changes
    // at pointer rate and must never drive a React re-render.
    useEffect(() => {
        if (!socket || !roomName) return;

        const handleAimUpdate = (data) => {
            if (data.roomName !== roomName || data.playerRole === playerRole) return;
            peerAimRef.current = data.active
                ? { active: true, startX: data.startX, startY: data.startY, endX: data.endX, endY: data.endY }
                : { active: false };
            scheduleRedraw();
        };

        // Belt and braces: if the opponent flicks, disconnects, or the game
        // resets mid-aim, their last aim frame would otherwise stay painted.
        const clearPeerAim = () => {
            if (!peerAimRef.current.active) return;
            peerAimRef.current = { active: false };
            scheduleRedraw();
        };

        socket.on("aimUpdate", handleAimUpdate);
        socket.on("turnResolved", clearPeerAim);
        socket.on("gameInit", clearPeerAim);
        return () => {
            socket.off("aimUpdate", handleAimUpdate);
            socket.off("turnResolved", clearPeerAim);
            socket.off("gameInit", clearPeerAim);
        };
    }, [socket, roomName, playerRole]);

    // Relay-only: the opponent scrubbing their striker into place.
    useEffect(() => {
        if (!socket || !roomName) return;

        const handleStrikerPlaceUpdate = (data) => {
            Events.handleStrikerPlaceUpdate(data, {
                roomName,
                strikerRef,
                canvasRef,
                playerRole,
                createGameState,
            });
        };

        socket.on("strikerPlaceUpdate", handleStrikerPlaceUpdate);
        return () => socket.off("strikerPlaceUpdate", handleStrikerPlaceUpdate);
    }, [socket, roomName]);

    // Initial canvas draw, and a redraw when the turn flips (the board renders
    // differently when it is not your turn). Deliberately NOT keyed on the flick
    // state: aim drawing is driven from the Hand ref via scheduleRedraw, and a
    // post-paint draw here would race that one and make the line strobe.
    useEffect(() => {
        const canvas = canvasRef.current;
        const ctx = canvas.getContext("2d");
        Draw.drawBoard(ctx, createGameState(), playerRole);
    }, [isMyTurn]);

    const scale = useResponsiveScale();

    return (
        <div style={{ 
            display: 'flex', 
            flexDirection: 'column', 
            alignItems: 'center', 
            justifyContent: 'center', 
            width: '100vw',
            height: '100vh',
            position: 'fixed',
            top: 0,
            left: 0,
            backgroundColor: '#fff'
        }}>
            <div style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                transformOrigin: 'center center',
                transform: `scale(${scale})`,
            }}>
                <div style={{
                    position: 'relative',
                    width: '900px',
                    marginBottom: '10px',
                    height: '40px'
                }}>
                    {/* Help toggle button */}
                    <button
                        onClick={handleHelpToggle}
                        style={{
                            position: 'absolute',
                            left: '0',
                            width: '40px',
                            height: '40px',
                            backgroundColor: 'white',
                            border: '2px solid black',
                            cursor: 'pointer',
                            fontWeight: 'bold',
                            fontFamily: 'Helvetica, Arial, sans-serif',
                            fontSize: '24px'
                        }}
                    >{showHelp ? 'X' : '?'}</button>

                    {/* Info bar */}
                    <div style={{
                        position: 'absolute',
                        left: '50%',
                        transform: 'translateX(-50%)',
                        display: 'flex',
                        gap: '20px',
                        alignItems: 'center',
                        fontFamily: 'Helvetica, Arial, sans-serif',
                        fontSize: '20px'
                    }}>
                        <span style={{ fontWeight: 'bold' }}>{roomName.toUpperCase()}</span>
                        <PlayerTag name={creatorUsername} data={manager?.getPlayerData("creator")} />
                        <PlayerTag name={joinerUsername} data={manager?.getPlayerData("joiner")} />
                    </div>

                    {/* Exit button */}
                    {onLeaveRoom && (
                        <button onClick={onLeaveRoom} style={{
                            position: 'absolute',
                            right: '0',
                            width: '100px',
                            height: '40px',
                            backgroundColor: 'white',
                            border: '2px solid black',
                            cursor: 'pointer',
                            fontWeight: 'bold',
                            fontFamily: 'Helvetica, Arial, sans-serif',
                            fontSize: '20px'
                        }}>
                            EXIT
                        </button>
                    )}
                </div>

                <canvas
                    ref={canvasRef}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    onPointerCancel={handlePointerCancel}
                    onDoubleClick={handleDoubleClick}
                    onContextMenu={handleContextMenu}
                    width={900}
                    height={900}
                    style={{
                        backgroundColor: "#fff",
                        cursor: isAnimating
                            ? "not-allowed"
                            : !isMyTurn
                                ? "default"
                                : handState.mode === "flick"
                                    ? "crosshair"          // armed: drag to pull back
                                    : handState.isPlacing
                                        ? "grabbing"
                                        : "grab",          // placing: the board scrubs
                        border: "1px solid black",
                        borderRadius: "0",
                        touchAction: "none"
                    }}
                />

                {/* Help text box */}
                {showHelp && (
                    <div style={{
                        width: '855px',
                        padding: '20px',
                        backgroundColor: 'white',
                        border: '2px solid black',
                        fontFamily: 'Helvetica, Arial, sans-serif',
                        fontSize: '20px',
                        position: 'absolute',
                        top: '50%',
                        left: '50%',
                        transform: 'translate(-50%, -50%)',
                        pointerEvents: 'none',
                        zIndex: 2,
                        textTransform: 'uppercase',
                        textAlign: 'center'
                    }}>
                        PLACE MODE: DRAG ANYWHERE ON THE BOARD TO MOVE THE STRIKER <br />
                        HIT FLICK (OR DOUBLE-CLICK THE BOARD) TO AIM <br />
                        DRAG TO PULL BACK, RELEASE TO SHOOT — FURTHER IS HARDER <br />
                        ESCAPE, RIGHT-CLICK, OR A SECOND FINGER CANCELS THE SHOT
                    </div>
                )}

                {/* PLACE / FLICK. Active mode is black, the other is grey.
                    FLICK is dead while the striker overlaps a coin — there is no
                    legal shot from there. */}
                <div className="mode-buttons">
                    <button
                        type="button"
                        className={`mode-button${handState.mode === "place" ? " mode-button-active" : ""}`}
                        onClick={() => handRef.current.armPlace()}
                        disabled={!isMyTurn || isAnimating}
                    >
                        PLACE
                    </button>
                    <button
                        type="button"
                        className={`mode-button${handState.mode === "flick" ? " mode-button-active" : ""}`}
                        onClick={() => handRef.current.armFlick()}
                        disabled={!isMyTurn || isAnimating || handState.blocked}
                        title={handState.blocked ? "The striker is touching a coin — move it first" : undefined}
                    >
                        FLICK
                    </button>
                </div>

            </div>
        </div>
    );
}

export default GameCanvas;
