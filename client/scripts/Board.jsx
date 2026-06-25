import { useEffect, useRef, useState } from "react";
import Coin from "./Coin";
import Draw from "./Draw";
import Hand from "./Hand";
import * as Events from "./Events";
import { sampleBuffer, pruneBuffer, INTERP_DELAY } from "./interpolate.js";
import "./Board.css";

// a custom hook for responsive scaling
// returns a scale value
// use state; i remember this sets scale variable to 1,
// and defines setscale as a function that can change the value of scale
// define a bool that is set to true if width is lesser than normal desktop width,
// to recognize if device is a Mobile
// define variables for width and height
// frame size is the length of outer side of board square
// set horizontal scale such that board is almost the same width as screen, with a small gap
// if on desktop, set horizontal and vertical scale with more gap between borders and outer gap of board
// set scale using both horizontal and vertical scale, 
// idk if we should have another multiplier 0.71!
// call the update scale function, the hook is called evey time the component first mounts
// theres a listener for whenever window resizes which calls the update scale function when it does resize
// 'resize' is an event
// returning the removal of the listener, as a cleanup function, i don't quite get this!

function useResponsiveScale() {
    const [scale, setScale] = useState(1);

    useEffect(() => {
        const updateScale = () => {
            const isMobile = window.innerWidth <= 768;
            const width = window.innerWidth;
            const height = window.innerHeight;
            
            if (isMobile) {
                const horizontalScale = (width - 20) / Draw.FRAME_SIZE;
                setScale(horizontalScale);
            } else {
                const horizontalScale = (width - 100) / Draw.FRAME_SIZE;
                const verticalScale = (height - 100) / Draw.FRAME_SIZE;
                setScale(Math.min(horizontalScale, verticalScale) * 0.7);
            }
        };

        updateScale();
        window.addEventListener('resize', updateScale);
        return () => window.removeEventListener('resize', updateScale);
    }, []);

    return scale;
}

// game canvas takes these parameters, the feel so unintuitive to me!
// i dont even know what the game canvas is, where is it?
// a function that handles the toggling of the help text
// is this redundant
// a use state to set the bool that shows/hides the help text
//  prev => !prev is a safe way to toggle a bool in react
// instread of directly setting the value we use a function,
// that receives its previous state and returns its opposite
// we wrap it in hand help toggle to follow reacts pattern,
// of having dedicated event handlers
// i still thing we should be able to do this without wrapping inside handler
// create a style element, write some css in its context
// and append it to the document head
// that css is absolutely insane it needs to be formatted and moved somewhere else!
// i assume it is for the invisible slider but it could be for other elements too
// return a cleanup function that removes the style element when the component unmounts

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
    // coinsRef so it survives applyServerCoins() rebuilds on turnResolved.
    const pocketingCoinsRef = useRef([]);
    const pocketedThisTurnRef = useRef([]);

    // ── Snapshot interpolation (research §C1) ──────────────────────────────
    // physicsFrame events are PRODUCERS: they reconstruct full positions from
    // the server's delta + push a timestamped snapshot into frameBufferRef.
    // A single requestAnimationFrame loop (renderLoopRef) is the CONSUMER: it
    // renders at display rate by sampling the buffer ~INTERP_DELAY ms in the
    // past, so motion stays smooth regardless of network jitter. The loop also
    // drives the pocket-drop tweens. It runs only while there's something to
    // animate, then draws a final frame and stops.
    const frameBufferRef = useRef([]);          // [{t, coins:[{id,x,y}], striker}]
    const wireFullRef = useRef(new Map());      // id -> {x,y}: last known full positions (delta reconstruction)
    const latestTRef = useRef(0);               // newest snapshot's server time
    const latestArrivalRef = useRef(0);         // local time that snapshot arrived
    const animatingRef = useRef(false);         // a flick is streaming
    const renderLoopRef = useRef(null);         // rAF handle

    // get boards top left x, y then get its center x, y
    // create coin formation, 
    // create coin fotmation returns an array of coin objects,
    // in the form id, color, x, y
    // set the coins refernce to coins list
    // then set the state variable value of coins as the local variable,
    // this is supposedly done because updating the state variable,
    // triggers react to re render the board with the new coin positions
    // this feels messy! shouldnt there be a simpler way of doing this?
    useEffect(() => {
        // Coins are seeded from the server's `gameInit` event (see the dedicated
        // useEffect below). We start empty; the first gameInit/turnResolved
        // snapshot populates coinsRef and triggers a redraw. The striker is
        // auto-instantiated on first draw by Draw.drawBoard.
        coinsRef.current = [];

        handRef.current.setCallbacks({
            onStateChange: (newState) => setHandState(newState),
            // No local physics anymore \u2014 striker positions come from the server
            // via physicsFrame events; we only need to broadcast the slider
            // preview and trigger redraws when the flick line changes.
            onAnimationStart: () => setIsAnimating(true),
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

    const handleMouseDown = (e) => {
        handRef.current.handleMouseDown(e, {
            isAnimating,
            isMyTurn,
            strikerRef,
            canvasRef,
            playerRole,
            isStrikerColliding,
            socket,
            roomName,
        });
    };

    const handleMouseMove = (e) => {
        handRef.current.handleMouseMove(e, {
            isMyTurn,
            strikerRef,
            canvasRef,
            playerRole,
        });
    };
    
    const handleMouseUp = (e) => {
        handRef.current.handleMouseUp(e, {
            isMyTurn,
            strikerRef,
            isStrikerColliding,
            socket,
            roomName,
            playerRole,
        });
    };
    
    const getTouchPosition = (touch, canvas) => {
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        return {
            x: (touch.clientX - rect.left) * scaleX,
            y: (touch.clientY - rect.top) * scaleY
        };
    };

    const lastTouchRef = useRef({ clientX: 0, clientY: 0, screenX: 0, screenY: 0 });

    const createSyntheticMouseEvent = (type, touch, canvas) => {
        const eventProps = {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: touch ? touch.clientX : lastTouchRef.current.clientX,
            clientY: touch ? touch.clientY : lastTouchRef.current.clientY,
            screenX: touch ? touch.screenX : lastTouchRef.current.screenX,
            screenY: touch ? touch.screenY : lastTouchRef.current.screenY,
            button: 0,
            buttons: type === 'mouseup' ? 0 : 1,
            detail: 1,
            isTrusted: true
        };

        const event = new MouseEvent(type, eventProps);

        if (!event.offsetX) {
            const rect = canvas.getBoundingClientRect();
            event.offsetX = eventProps.clientX - rect.left;
            event.offsetY = eventProps.clientY - rect.top;
        }

        return event;
    };

    const handleTouchStart = (e) => {
        e.preventDefault();
        if (e.touches.length === 1) {
            const touch = e.touches[0];
            lastTouchRef.current = {
                clientX: touch.clientX,
                clientY: touch.clientY,
                screenX: touch.screenX,
                screenY: touch.screenY
            };
            const mouseEvent = createSyntheticMouseEvent('mousedown', touch, canvasRef.current);
            handleMouseDown(mouseEvent);
        }
    };

    const handleTouchMove = (e) => {
        e.preventDefault();
        if (e.touches.length === 1) {
            const touch = e.touches[0];
            lastTouchRef.current = {
                clientX: touch.clientX,
                clientY: touch.clientY,
                screenX: touch.screenX,
                screenY: touch.screenY
            };
            const mouseEvent = createSyntheticMouseEvent('mousemove', touch, canvasRef.current);
            handleMouseMove(mouseEvent);
        }
    };

    const handleTouchEnd = (e) => {
        e.preventDefault();
        const mouseEvent = createSyntheticMouseEvent('mouseup', null, canvasRef.current);
        handleMouseUp(mouseEvent);
        lastTouchRef.current = {
            clientX: 0,
            clientY: 0,
            screenX: 0,
            screenY: 0
        };

        if (handRef.current._lastContext) {
            handRef.current.handleFlickMouseUp(mouseEvent, {
                isMyTurn,
                strikerRef,
                isStrikerColliding,
                socket,
                roomName,
            });
        }
    };

    // ========================================================================
    // SERVER-AUTHORITATIVE PHYSICS LISTENERS
    // ========================================================================
    // The local physics loop has been removed. Instead, we listen for:
    //   gameInit      \u2014 full initial coin layout (start / reset / late join)
    //   physicsFrame  \u2014 ~30Hz position updates during a flick
    //   pocketEvent   \u2014 a coin (or striker) was pocketed
    //   turnResolved  \u2014 flick finished; final state, scores, debts, turn
    // ========================================================================

    // Helper: rebuild local Coin objects from a server snapshot.
    const applyServerCoins = (serverCoins) => {
        const next = serverCoins
            .filter((c) => !c.pocketed)
            .map((c) => new Coin({ id: c.id, color: c.color, x: c.x, y: c.y }));
        coinsRef.current = next;
        // Seed the delta-reconstruction map from this authoritative full state so
        // the first streaming frame of the next flick has a complete baseline.
        const full = new Map();
        for (const c of next) full.set(c.id, { x: c.x, y: c.y });
        wireFullRef.current = full;
    };

    const redrawCanvas = () => {
        const ctx = canvasRef.current?.getContext("2d");
        if (ctx) Draw.drawBoard(ctx, createGameState(), playerRole);
    };

    // Pending striker re-placement to apply once the pocket tween finishes.
    // turnResolved typically arrives within ~16ms of a striker pocket, so we
    // can't snap-to-baseline immediately or the 250ms shrink-into-pocket
    // animation gets cut off.
    const pendingStrikerSyncRef = useRef(null);

    // The single render loop. Runs while a flick is streaming (animatingRef) or
    // a pocket tween is in flight. Each frame it (1) interpolates coin/striker
    // positions ~INTERP_DELAY ms in the past from the snapshot buffer, (2)
    // advances pocket-drop tweens, (3) redraws. Then it stops and draws a final
    // frame once nothing is animating.
    const renderTick = () => {
        const now = performance.now();
        const striker = strikerRef.current;

        // (1) Interpolate live positions from the buffer during a flick.
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

        // (2) Advance pocket-drop tweens.
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

        // (3) Draw.
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

    // Initial state + reset listener
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
            // Reset the interpolation burst.
            frameBufferRef.current = [];
            latestTRef.current = 0;
            animatingRef.current = false;
            redrawCanvas();
        };

        socket.on("gameInit", handleGameInit);
        return () => socket.off("gameInit", handleGameInit);
    }, [socket, roomName, playerRole]);

    // Streaming position updates during a flick (~30Hz)
    useEffect(() => {
        if (!socket || !roomName) return;

        const handlePhysicsFrame = (frame) => {
            // PRODUCER ONLY — never draws. Reconstruct full positions from the
            // server's delta, then push a timestamped snapshot for the render
            // loop to interpolate.
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

    // Per-pocket event \u2014 remove the coin from the local list immediately so the
    // next physicsFrame doesn't try to update a coin that no longer exists.
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
            // Stop reconstructing this coin in future delta frames.
            wireFullRef.current.delete(p.id);
            pocketedThisTurnRef.current.push(p);
        };

        socket.on("pocketEvent", handlePocketEvent);
        return () => socket.off("pocketEvent", handlePocketEvent);
    }, [socket, roomName]);

    // Turn resolution \u2014 server tells us the flick is fully settled and gives
    // us the authoritative full state (scores, debts, turn, queen, striker
    // placement). We sync local state and end the animating gate.
    useEffect(() => {
        if (!socket || !roomName) return;

        const handleTurnResolved = (payload) => {
            const state = payload.state;
            // End the interpolation burst and snap to the authoritative final
            // state. (Coins are at rest by now, so the snap is imperceptible.)
            frameBufferRef.current = [];
            animatingRef.current = false;
            applyServerCoins(state.coins);
            const striker = strikerRef.current;
            if (striker) {
                if (striker.beingPocketed) {
                    // Defer the snap-to-baseline until the pocket tween
                    // finishes (handled in renderTick).
                    pendingStrikerSyncRef.current = {
                        x: state.striker.x,
                        y: state.striker.y,
                    };
                } else {
                    striker.resetPocketAnim();
                    striker.x = state.striker.x;
                    striker.y = state.striker.y;
                    striker.velocity = { x: 0, y: 0 };
                    striker.isStrikerMoving = false;
                }
            }
            // Sync slider preview so the local player sees their striker at
            // the server-chosen baseline.
            const newSliderValue = handRef.current.xToSlider(
                state.striker.x,
                playerRole,
            );
            handRef.current.sliderValue = newSliderValue;
            setHandState(handRef.current.getState());

            pocketedThisTurnRef.current = [];

            setIsAnimating(false);
            redrawCanvas();
        };

        socket.on("turnResolved", handleTurnResolved);
        return () => socket.off("turnResolved", handleTurnResolved);
    }, [socket, roomName, playerRole]);

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
        handState.isPlacing,
        isMyTurn,
        handState.isFlickerActive,
        handState.flick,
    ]);
    // handle room closed event - return to menu if any player leaves
    useEffect(() => {
        if (!socket || !onLeaveRoom) return;

        const handleRoomClosed = () => {
            onLeaveRoom();
        };

        socket.on("roomClosed", handleRoomClosed);
        return () => {
            socket.off("roomClosed", handleRoomClosed);
        };
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

    // Get the responsive scale factor
    const scale = useResponsiveScale();    return (
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
                    onMouseDown={handleMouseDown}
                    onMouseMove={handleMouseMove}
                    onMouseUp={handleMouseUp}
                    onMouseLeave={(e) => handRef.current.handleMouseLeave(e, {
                        isAnimating,
                        isMyTurn,
                        strikerRef,
                        isStrikerColliding,
                    })}
                    onTouchStart={handleTouchStart}
                    onTouchMove={handleTouchMove}
                    onTouchEnd={handleTouchEnd}
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
