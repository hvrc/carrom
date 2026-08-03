import { useEffect, useRef, useState } from "react";
import Draw from "./Draw";
import Hand from "./Hand";
import * as Events from "./Events";
import { toCanvasCoords } from "./flickMath.js";
import { theme } from "./theme/index.js";
import Clock from "./Clock.jsx";
import { setAudioEnabled } from "./audio.js";
import useResponsiveScale from "./hooks/useResponsiveScale.js";
import useGameSync from "./hooks/useGameSync.js";
import { skinIsAnimated, skinSurface } from "./skins/index.js";
import "./Board.css";

// A player in the info bar: NAME, then games won (bold), then the score.
// The wins column is omitted entirely until they've won one, so a first game
// reads "ALICE 0   BOB 0" and afterwards "ALICE 1 0   BOB 0 0".
function PlayerTag({ name, data, isTurn = false }) {
    const wins = data?.wins || 0;
    const score = data?.score ?? 0;
    return (
        <span>
            {/* The turn indicator: whoever is on strike is named in colour, the
                other player greys back. */}
            <span style={{ color: isTurn ? theme.ui.turnName : theme.ui.idleName }}>
                {name ? name.toUpperCase() : "?"}
            </span>
            {wins > 0 && <>&nbsp; <b>{wins}</b></>}
            &nbsp; {score}
        </span>
    );
}

// A ruler, drawn rather than typed: a rectangle with graduations down one edge.
function RulerIcon({ colour }) {
    return (
        <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
            <g transform="rotate(-45 11 11)" fill="none" stroke={colour} strokeWidth="1.6">
                <rect x="1.5" y="7.5" width="19" height="7" />
                <path d="M5 7.5v3M8 7.5v2M11 7.5v3M14 7.5v2M17 7.5v3" />
            </g>
        </svg>
    );
}

// A speaker, with waves when sound is on and a cross when it is off.
function SpeakerIcon({ colour, on }) {
    return (
        <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
            <g fill="none" stroke={colour} strokeWidth="1.6" strokeLinejoin="round">
                <path d="M4 8.5h3l4-3.5v12l-4-3.5H4z" />
                {on
                    ? <><path d="M14 8a4 4 0 0 1 0 6" /><path d="M16.5 6a7 7 0 0 1 0 10" /></>
                    : <path d="M14.5 8.5l5 5M19.5 8.5l-5 5" />}
            </g>
        </svg>
    );
}

// GameCanvas: presentation + input. The canvas/striker/coins/hand state live in
// refs; server sync and the render loop are in useGameSync; responsive scale in
// useResponsiveScale. React state is reserved for discrete UI.
function GameCanvas({isMyTurn = true, socket, playerRole, roomName, manager, onLeaveRoom, creatorUsername = "", joinerUsername = "", whoseTurn = "", solo = false, title = "", startedAt = null}) {
    const [showHelp, setShowHelp] = useState(false);
    // Ruler mode: my own forecast overlay. Announced to the opponent so they
    // know I am aiming with help, but it is drawn only on my screen.
    const [ruler, setRuler] = useState(false);
    const [peerRuler, setPeerRuler] = useState(false);
    // Sound. The AudioContext can only be created inside a user gesture, which
    // is exactly what this toggle is.
    const [audio, setAudio] = useState(false);
    const handleHelpToggle = () => {
        setShowHelp(prev => !prev);
    };

    const handleAudioToggle = () => {
        setAudio(setAudioEnabled(!audio));
    };

    const handleRulerToggle = () => {
        const next = !rulerRef.current;
        rulerRef.current = next;
        setRuler(next);
        if (socket && roomName) {
            socket.emit("rulerUpdate", { roomName, playerRole, ruler: next });
        }
        scheduleRedraw();
    };

    // Refs hold all 60fps game state (canvas, striker, coins). React state is
    // reserved for discrete UI: handState (mode/cursor) and isAnimating
    // (input gating). The canvas is drawn from refs by the rAF loop, never from
    // a React re-render.
    const canvasRef = useRef(null);
    // The page behind the board. Only used when the skin paints "canvas"; it is
    // sized to the viewport and drawn from the same redraw as the board, which
    // is what keeps the pattern in register with the pieces.
    const bgCanvasRef = useRef(null);
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
    // Ruler mode, read by the draw loop (which never re-reads React state).
    const rulerRef = useRef(false);

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
            // The skin's clock. Read per draw so an animated skin advances even
            // when the game itself is idle.
            time: performance.now(),
            ruler: rulerRef.current,
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

    // The mode as it was when a double-click STARTED. The two clicks have already
    // had their own effects by the time dblclick fires, so we toggle from the
    // remembered mode rather than the live one — that keeps the toggle honest no
    // matter what those clicks did to the aim line.
    const modeBeforeClickRef = useRef("place");

    const handlePointerDown = (e) => {
        lastPointerTypeRef.current = e.pointerType || "mouse";
        if ((e.detail ?? 1) <= 1) modeBeforeClickRef.current = handRef.current.mode;

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

    // Double-clicking THE STRIKER toggles the mode: place → flick, flick → place.
    // Double-clicking anywhere else on the board does nothing — the board is the
    // scrub bar, and a stray double-click there should not arm a shot.
    //
    // Desktop only (Q14): on touch, the FLICK button is the only way to arm.
    const handleDoubleClick = (e) => {
        if (lastPointerTypeRef.current !== "mouse") return;
        if (!isMyTurn || isAnimating || !strikerRef.current) return;

        const { x, y } = pointerToCanvas(e);
        if (!strikerRef.current.isPointInside(x, y)) return; // not on the striker

        // Toggle from where we were before the clicks landed, not from the live
        // mode (see modeBeforeClickRef).
        const next = modeBeforeClickRef.current === "flick" ? "place" : "flick";
        handRef.current.setMode(next);
    };

    // Right-click cancels an in-progress flick (F2), and never opens a context
    // menu over the board.
    const handleContextMenu = (e) => {
        e.preventDefault();
        handRef.current.cancelFlick();
    };

    // The opponent's ruler state, so nobody is aiming with help unannounced.
    useEffect(() => {
        if (!socket || !roomName) return undefined;
        const onPeerRuler = (data) => {
            if (data.roomName !== roomName || data.playerRole === playerRole) return;
            setPeerRuler(!!data.ruler);
        };
        socket.on("rulerUpdate", onPeerRuler);
        return () => socket.off("rulerUpdate", onPeerRuler);
    }, [socket, roomName, playerRole]);

    // Escape cancels an in-progress flick. In place mode it does nothing.
    useEffect(() => {
        const onKeyDown = (e) => {
            if (e.key === "Escape") handRef.current.cancelFlick();
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, []);

    // Is the striker under this player's hand right now? A ref, not the props
    // themselves, because the render loop can hold a draw callback from an
    // earlier render and would otherwise read a stale turn.
    const canPlaceRef = useRef(false);
    canPlaceRef.current = isMyTurn && !isAnimating;

    const redrawCanvas = () => {
        const ctx = canvasRef.current?.getContext("2d");
        if (!ctx) return;

        // F3: is this a legal place to shoot from — clear of the coins, and either
        // fully on or fully off a baseline moon? Recomputed every draw, because it
        // changes as you scrub the striker along the baseline. Cheap — at most 19
        // coins. The result greys the striker, kills the FLICK button, and (via
        // Hand) disarms you if you were already aiming when it became true.
        //
        // Only asked while the striker is actually yours to place. A striker in
        // flight ploughs straight through the pack and would otherwise grey out
        // for the whole shot — the greyed state means "you cannot flick from
        // here", not "this piece is touching something".
        const blocked = canPlaceRef.current &&
            Hand.illegalPlacement(strikerRef.current, coinsRef.current);
        strikerBlockedRef.current = blocked;
        handRef.current.setBlocked(blocked); // no-op unless it actually changed

        const state = createGameState();
        Draw.drawBoard(ctx, state, playerRole);

        if (skinSurface() === "canvas" && bgCanvasRef.current && canvasRef.current) {
            const bg = bgCanvasRef.current;
            // Match the backing store to the viewport, in device pixels.
            const w = Math.ceil(window.innerWidth);
            const h = Math.ceil(window.innerHeight);
            if (bg.width !== w || bg.height !== h) { bg.width = w; bg.height = h; }
            const bgCtx = bg.getContext("2d");
            if (bgCtx) {
                Draw.drawSkinBackground(bgCtx, canvasRef.current.getBoundingClientRect(), state);
            }
        }
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
        // An animated skin needs a frame every tick, whether or not a piece is
        // moving, so the render loop must not be allowed to go idle.
        keepAnimating: skinIsAnimated(),
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
            backgroundColor: theme.page.background,
            color: theme.page.text,
        }}>
            {/* The skin's page layer, behind everything and never interactive. */}
            <canvas
                ref={bgCanvasRef}
                style={{
                    position: 'fixed',
                    inset: 0,
                    width: '100%',
                    height: '100%',
                    pointerEvents: 'none',
                    zIndex: 0,
                }}
            />
            <div style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                transformOrigin: 'center center',
                transform: `scale(${scale})`,
                position: 'relative',
                zIndex: 1,
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
                            backgroundColor: theme.ui.buttonBackground,
                            color: theme.ui.helpText,
                            border: `2px solid ${theme.ui.helpBorder}`,
                            cursor: 'pointer',
                            fontWeight: 'bold',
                            fontFamily: 'Helvetica, Arial, sans-serif',
                            fontSize: '24px'
                        }}
                    >{showHelp ? 'X' : '?'}</button>

                    {/* Ruler mode. Lit when it is on; the opponent is told. */}
                    <button
                        onClick={handleRulerToggle}
                        title={ruler ? "Ruler on: aim shows the forecast" : "Ruler: show the forecast while aiming"}
                        style={{
                            position: 'absolute',
                            left: '48px',
                            width: '40px',
                            height: '40px',
                            backgroundColor: theme.ui.buttonBackground,
                            color: ruler ? theme.ui.rulerText : theme.ui.modeInactive,
                            border: `2px solid ${ruler ? theme.ui.rulerText : theme.ui.modeInactive}`,
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            padding: 0,
                        }}
                    >
                        <RulerIcon colour={ruler ? theme.ui.rulerText : theme.ui.modeInactive} />
                    </button>

                    {/* Sound: windchimes when coins meet. */}
                    <button
                        onClick={handleAudioToggle}
                        title={audio ? "Sound on" : "Sound off"}
                        style={{
                            position: 'absolute',
                            left: '96px',
                            width: '40px',
                            height: '40px',
                            backgroundColor: theme.ui.buttonBackground,
                            color: audio ? theme.ui.audioText : theme.ui.modeInactive,
                            border: `2px solid ${audio ? theme.ui.audioText : theme.ui.modeInactive}`,
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            padding: 0,
                        }}
                    >
                        <SpeakerIcon colour={audio ? theme.ui.audioText : theme.ui.modeInactive} on={audio} />
                    </button>

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
                        <span style={{ fontWeight: 'bold' }}>{(title || roomName).toUpperCase()}</span>
                        <PlayerTag name={creatorUsername} data={manager?.getPlayerData("creator")} isTurn={whoseTurn === "creator"} />
                        {/* Nobody sits opposite in the practice room. */}
                        {!solo && (
                            <PlayerTag name={joinerUsername} data={manager?.getPlayerData("joiner")} isTurn={whoseTurn === "joiner"} />
                        )}
                        <Clock startedAt={startedAt} />
                        {/* Nobody aims with help unannounced. */}
                        {peerRuler && (
                            <span style={{ color: theme.ui.rulerText, fontSize: '14px', letterSpacing: '1px' }}>
                                RULER
                            </span>
                        )}
                    </div>

                    {/* Exit button */}
                    {onLeaveRoom && (
                        <button onClick={onLeaveRoom} style={{
                            position: 'absolute',
                            right: '0',
                            width: '100px',
                            height: '40px',
                            backgroundColor: theme.ui.buttonBackground,
                            color: theme.ui.exitText,
                            border: `2px solid ${theme.ui.exitBorder}`,
                            cursor: 'pointer',
                            fontWeight: 'bold',
                            fontFamily: 'Helvetica, Arial, sans-serif',
                            fontSize: '20px'
                        }}>
                            ROOMS
                        </button>
                    )}
                </div>

                {/* The board and anything overlaid on it. Positioned, so the help
                    box centres on the board itself rather than on the viewport. */}
                <div style={{ position: 'relative', lineHeight: 0 }}>
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
                        backgroundColor: theme.page.background,
                        cursor: isAnimating
                            ? "not-allowed"
                            : !isMyTurn
                                ? "default"
                                : handState.mode === "flick"
                                    ? "crosshair"          // armed: drag to pull back
                                    : handState.isPlacing
                                        ? "grabbing"
                                        : "grab",          // placing: the board scrubs
                        border: `1px solid ${theme.frame.border}`,
                        borderRadius: "0",
                        touchAction: "none"
                    }}
                />

                {/* Help text box, centred on the board */}
                {showHelp && (
                    <div style={{
                        width: '600px',
                        padding: '24px',
                        backgroundColor: theme.ui.panelBackground,
                        color: theme.ui.helpText,
                        border: `2px solid ${theme.ui.helpBorder}`,
                        fontFamily: 'Helvetica, Arial, sans-serif',
                        fontSize: '20px',
                        lineHeight: 1.6,
                        position: 'absolute',
                        top: '50%',
                        left: '50%',
                        transform: 'translate(-50%, -50%)',
                        pointerEvents: 'none',
                        zIndex: 2,
                        textAlign: 'center'
                    }}>
                        In place mode, drag anywhere to move the striker <br />
                        Double click the striker to aim in flick mode <br />
                        Drag back and release to shoot <br />
                        While aiming, hit Escape or right click to cancel
                    </div>
                )}
                </div>

                {/* PLACE / FLICK. Active mode is black, the other is grey.
                    FLICK is dead while the striker overlaps a coin — there is no
                    legal shot from there. */}
                <div className="mode-buttons">
                    <button
                        type="button"
                        className={`mode-button mode-button-place${handState.mode === "place" ? " mode-button-active" : ""}`}
                        onClick={() => handRef.current.armPlace()}
                        disabled={!isMyTurn || isAnimating}
                    >
                        PLACE
                    </button>
                    <button
                        type="button"
                        className={`mode-button mode-button-flick${handState.mode === "flick" ? " mode-button-active" : ""}`}
                        onClick={() => handRef.current.armFlick()}
                        disabled={!isMyTurn || isAnimating || handState.blocked}
                        title={handState.blocked ? "No legal shot from here. Move the striker first." : undefined}
                    >
                        FLICK
                    </button>
                </div>

            </div>
        </div>
    );
}

export default GameCanvas;
