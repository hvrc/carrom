import { useEffect, useRef, useState } from "react";
import Draw from "./Draw";
import Hand from "./Hand";
import * as Events from "./Events";
import useResponsiveScale from "./hooks/useResponsiveScale.js";
import useGameSync from "./hooks/useGameSync.js";
import "./Board.css";

// GameCanvas: presentation + input. The canvas/striker/coins/hand state live in
// refs; server sync and the render loop are in useGameSync; responsive scale in
// useResponsiveScale. React state is reserved for discrete UI.
function GameCanvas({isMyTurn = true, socket, playerRole, roomName, manager, onLeaveRoom, creatorUsername = "", joinerUsername = ""}) {
    const [showHelp, setShowHelp] = useState(false);
    const handleHelpToggle = () => {
        setShowHelp(prev => !prev);
    };

    // (Slider chrome-stripping CSS lives in Board.css, imported above.)

    // Refs hold all 60fps game state (canvas, striker, coins). React state is
    // reserved for discrete UI: handState (cursor/slider) and isAnimating
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

    useEffect(() => {
        // Coins are seeded from the server's `gameInit` event (see the dedicated
        // useEffect below). We start empty; the first gameInit/turnResolved
        // snapshot populates coinsRef and triggers a redraw. The striker is
        // auto-instantiated on first draw by Draw.drawBoard.
        coinsRef.current = [];

        handRef.current.setCallbacks({
            onStateChange: (newState) => setHandState(newState),
            // Redraw the board when the flick line changes during aiming.
            onRedraw: (collisionState) => {
                const ctx = canvasRef.current?.getContext("2d");
                if (ctx) {
                    Draw.drawBoard(
                        ctx,
                        createGameState(),
                        playerRole,
                        collisionState,
                    );
                }
            },
            onSliderChange: (data) => {
                if (socket && roomName) {
                    socket.emit("strikerSliderUpdate", {
                        roomName,
                        playerRole,
                        ...data,
                    });
                }
            },
        });

        handRef.current.calculateSliderBoundaries(canvasRef);

    }, []);

    // helper function to create game state object for drawing
    // why have we chosen these values? are all these values used?
    // is it optiam to have these values and not any other?
    // is there a better way to create, store and reference a game state?

    // slider change function takes e as a parameter, 
    // e is an input event object containing, e target, which is the range input element htat trigered the event,
    // and e target value which holds the actual current value of the slider 
    // set a new value variable based on the value of e
    // call handle slider change to set the slider value in the hand reference
    // send hand state to the hand reference state
    // all this s just feels weird

    // call handle mouse down thorugh the hand reference
    // with the is animating bool
    // and other variables

    // call the handle mouse move function through the hand reference

    // call the handle mouse up function from the hand reference

    // get the x y of the touch on the canvas
    // this function is never used, why is that?

    // a reference to store the last known touch position for touch end

    // a function that creates a mouse event out of a touch event 
    // takes data type, touch, canvas
    // type can be mousedown, mousemove, mouseup
    // touch contains coordiantes and screen positions
    // canvas element for calculating correct offset coordiantes?
    // the event props help convert features of a touch event,
    // into the props that we can put in a mouse event
    // creates that mouse event using type and event prop
    // also add missing properties that some browsers expect
    // return the mouse event

    // start of a touch
    // prevent default actions like scrolling, panning, zooming, long press etc.
    // if there is exactly one finger touching the screen
    // get the first touch point from the touch event array
    // update reference that tracks the last known touch position
    // create a mouse event out of the touch
    // pass the mouse event to the existing mouse handler

    // do the same for the touch move,
    // however you end up creating a mouse move type mouse event

    // same for the touch end but you create the mouse event early, 
    // reset the last touch reference,
    // and also trigger a mouse up or flick handler through hand reference

    const createGameState = () => ({
        strikerRef,
        coinsRef,
        pocketingCoinsRef,
        isStrikerColliding,
        isFlickerActive: handState.isFlickerActive,
        flick: handState.flick,
        flickMaxLength: handState.flickMaxLength,
    });
    
    const handleSliderChange = (e) => {
        const newValue = parseFloat(e.target.value);
        handRef.current.handleSliderChange(newValue, strikerRef, socket, roomName, playerRole);
        setHandState(handRef.current.getState());
    };

    // Unified pointer input (mouse + touch + pen). On down we capture the
    // pointer so a drag that leaves the board keeps delivering move/up events.
    const pointerToCanvas = (e) => {
        const c = canvasRef.current;
        return handRef.current.pointerToCanvas(
            e.clientX, e.clientY, c.getBoundingClientRect(), c.width, c.height, playerRole,
        );
    };

    const handlePointerDown = (e) => {
        const { x, y } = pointerToCanvas(e);
        const started = handRef.current.pointerDown(x, y, { isMyTurn, isAnimating, strikerRef });
        if (started) {
            try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* unsupported */ }
        }
    };

    const handlePointerMove = (e) => {
        if (!handRef.current.flick.active) return; // only while aiming
        const { x, y } = pointerToCanvas(e);
        handRef.current.pointerMove(x, y, { isMyTurn, strikerRef });
    };

    const handlePointerUp = (e) => {
        handRef.current.pointerUp({ isMyTurn, strikerRef, socket, roomName });
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* unsupported */ }
    };

    const handlePointerCancel = () => {
        handRef.current.pointerCancel();
    };

    const redrawCanvas = () => {
        const ctx = canvasRef.current?.getContext("2d");
        if (ctx) Draw.drawBoard(ctx, createGameState(), playerRole);
    };

    // Server-authoritative sync + the single render loop (gameInit / physicsFrame
    // / pocketEvent / turnResolved / roomClosed). Owns the interpolation buffer
    // and the rAF loop; draws via redrawCanvas above.
    useGameSync({
        socket, roomName, playerRole,
        isAnimating, setIsAnimating, setHandState,
        handRef, strikerRef, coinsRef, pocketingCoinsRef,
        redrawCanvas, onLeaveRoom,
    });

    // Relay-only: peer's slider preview position.
    useEffect(() => {
        if (!socket || !roomName) return;

        const handleStrikerSliderUpdate = (data) => {
            Events.handleStrikerSliderUpdate(data, {
                roomName,
                strikerRef,
                handRef,
                setHandState,
                canvasRef,
                playerRole,
                createGameState,
            });
        };

        socket.on("strikerSliderUpdate", handleStrikerSliderUpdate);
        return () => socket.off("strikerSliderUpdate", handleStrikerSliderUpdate);
    }, [socket, roomName]);

    // separate useEffect for initial canvas drawing
    useEffect(() => {
        const canvas = canvasRef.current;
        const ctx = canvas.getContext("2d");
        Draw.drawBoard(ctx, createGameState(), playerRole);
    }, [
        isMyTurn,
        handState.isFlickerActive,
        handState.flick,
    ]);

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
                        <span>{creatorUsername ? creatorUsername.toUpperCase() : "?"} &nbsp; {manager?.getPlayerData("creator")?.score || 0}</span>
                        <span>{joinerUsername ? joinerUsername.toUpperCase() : "?"} &nbsp; {manager?.getPlayerData("joiner")?.score || 0}</span>
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
                    width={900}
                    height={900}
                    style={{
                        backgroundColor: "#fff",
                        cursor: isAnimating
                            ? "not-allowed"
                            : handState.isFlickerActive
                                ? "crosshair"
                                : isMyTurn && !strikerRef.current?.isStrikerMoving
                                    ? "grab"
                                    : "default",
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
                        DRAG ALONG THE AREA BELOW THE BOARD TO MOVE THE STRIKER <br />
                        DRAG ANYWHERE ON THE BOARD TO AIM AND RELEASE TO FLICK <br />
                        THE FURTHER YOU DRAG THE HARDER YOU'LL FLICK
                    </div>
                )}

                {/* Striker Position Slider */}
                <div style={{
                    width: '470px',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    height: '160px',
                    justifyContent: 'center',
                    position: 'relative',
                    zIndex: 1
                }}>
                    <input
                        type="range"
                        min="0"
                        max="100"
                        value={handState.sliderValue || 50}
                        onChange={handleSliderChange}
                        disabled={!isMyTurn || isAnimating || strikerRef.current?.isStrikerMoving}
                        style={{
                            width: '100%',
                            height: '130px',
                            borderRadius: '0',
                            background: 'transparent',
                            outline: 'none',
                            cursor: isMyTurn && !isAnimating && !strikerRef.current?.isStrikerMoving ? 'pointer' : 'not-allowed',
                            WebkitAppearance: 'none',
                            appearance: 'none',
                            opacity: 0,
                            border: 'none'
                        }}
                    />
                </div>
            </div>
        </div>
    );
}

export default GameCanvas;
