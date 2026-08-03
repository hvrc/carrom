import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import socket, { getClientId, clearSession } from "./socket.js";
import RoomList from "./RoomList.jsx";
import { theme } from "./theme.js";
import { COIN_COUNTS, DEFAULT_COIN_COUNT } from "./flickMath.js";

// Add custom hook for menu scaling
function useMenuScale() {
    const [scale, setScale] = useState(1);
    const MENU_SCALE = 0.8; // Adjust this to decrease/increase overall menu size

    useEffect(() => {
        const updateScale = () => {
            const isMobile = window.innerWidth <= 768;
            if (isMobile) {
                setScale(0.9 * MENU_SCALE);
            } else {
                setScale(MENU_SCALE);
            }
        };

        updateScale();
        window.addEventListener('resize', updateScale);
        return () => window.removeEventListener('resize', updateScale);
    }, []);

    return scale;
}

/**
 * The lobby. Also stands in for the "you opened a room link" screen: Room renders
 * this with `initialRoomName` set, which fills the room field in and puts the
 * cursor in the username box, so there is one way into a game rather than two.
 * `onJoined` lets that caller take over instead of navigating — the URL is
 * already the room, so there is nowhere to navigate to.
 */
export default function Menu({ initialRoomName = "", onJoined = null }) {
    const scale = useMenuScale();
    // socket.io handling room creation and joining

    // state variables
    // navigate is used to navigate to the room
    // use effect checks for saved room, clears storage if none, and cleans up socket listeners on exit

    // array destructuring
    // use state ("") returns two things,
    // the current value, which starts as an empty string
    // a function to change that value    // Shared state for both join and create operations
    const [username, setUsername] = useState("");
    const [roomName, setRoomName] = useState(initialRoomName);
    const [error, setError] = useState("");
    // The rack to deal when creating a room. Ignored when joining one.
    const [coinCount, setCoinCount] = useState(DEFAULT_COIN_COUNT);
    // The lobby list, handed up by <RoomList> so the buttons can be decided from
    // the same live data the list is showing.
    const [lobbyRooms, setLobbyRooms] = useState([]);
    const usernameRef = useRef(null);
    const navigate = useNavigate();

    const handleRooms = useCallback((rooms) => setLobbyRooms(rooms), []);

    // Arrived on a room link: the room is already decided, so the only thing left
    // to give is a name. Put the cursor there.
    useEffect(() => {
        if (initialRoomName) usernameRef.current?.focus();
    }, [initialRoomName]);

    // Into the room. When we are already sitting on that room's URL there is
    // nothing to navigate to — the caller just needs to know it can render the
    // board now.
    const enterRoom = (targetRoom) => {
        if (onJoined && targetRoom === initialRoomName) onJoined();
        else navigate(`/${targetRoom}`);
    };

    // Picking a room off the list fills the room name in rather than joining
    // behind your back. If we still don't know who you are, the cursor goes to
    // the username box — that is the only thing left to supply.
    const handlePickRoom = (picked) => {
        setRoomName(picked);
        setError("");
        if (!username.trim()) {
            usernameRef.current?.focus();
            return;
        }
        handleJoinRoom(picked);
    };

    // use effect is a react hook
    // it runs when a component first loads or when it is about to be removed,
    // or when values in the square brackets change, its called the dependency array
    // since its empty, it runs only once when the component mounts

    // gets room name from what user inputs into the field, which is stored in locaal storage
    // if room name is null, the local storage is cleared
    // socket off means stop listeing for this message,
    // in this case we are asking the browser/client to stop listening to playerJoined events

    useEffect(() => {
        const roomName = localStorage.getItem("roomName");
        if (!roomName) { clearSession(); }
        return () => {
            // Clean up listeners when component unmounts
            socket.off("playerJoined");
            socket.off("error");
        };
    }, []);

    // This browser already holds a seat (e.g. the game is open in another tab).
    // You get one seat, so we send you back to it rather than seating you a
    // second time — which is how one player used to end up playing themselves.
    useEffect(() => {
        const handleAlreadySeated = ({ roomName: seatedRoom, playerRole }) => {
            localStorage.setItem("roomName", seatedRoom);
            localStorage.setItem("playerRole", playerRole);
            // Keep the name we're already seated under; only fall back to what was
            // typed here if this profile somehow has no stored name.
            if (!localStorage.getItem("username") && username.trim()) {
                localStorage.setItem("username", username.trim());
            }
            navigate(`/${seatedRoom}`);
        };
        socket.on("alreadySeated", handleAlreadySeated);
        return () => socket.off("alreadySeated", handleAlreadySeated);
    }, [navigate, username]);

    // handles the creation of a room
    // if either username or room name are false, sets an error asking user to enter both
    // username and room name are both strings, set when user types in the shared input fields
    // if socket is not connected, connects to the server
    // gets client id from the session storage
    // if there is no client id found, sets an error asking user to refresh page and retry
    // emits a createRoom event to the server, with room name, username and client id
    const handleCreateRoom = () => {
        if (!username.trim()) {
            setError("Please enter a username");
            return;
        }
        const targetRoom = roomName.trim();
        if (!targetRoom) {
            setError("Please enter a room name");
            return;
        }

        if (!socket.connected) {
            socket.connect();
        }

        const clientId = getClientId();

        if (!clientId) {
            setError("Refresh and retry");
            return;
        }

        // Clear any existing error
        setError("");

        // Clean up any existing listeners
        socket.off("playerJoined");
        socket.off("error");

        // Set up event listeners for this specific operation
        const handlePlayerJoined = (data) => {
            if (data.username === username && data.roomName === targetRoom) {
                localStorage.setItem("username", username);
                localStorage.setItem("roomName", targetRoom);
                localStorage.setItem("playerRole", "creator");

                // Clean up listeners
                socket.off("playerJoined", handlePlayerJoined);
                socket.off("error", handleError);

                enterRoom(targetRoom);
            }
        };

        const handleError = (msg) => {
            setError(msg);
            socket.off("playerJoined", handlePlayerJoined);
            socket.off("error", handleError);
        };

        socket.on("playerJoined", handlePlayerJoined);
        socket.on("error", handleError);

        socket.emit("createRoom", {
            roomName: targetRoom,
            username: username,
            clientId,
            coinCount,
        });
    };

    // Joins `target` — either the room typed into the field, or one clicked in
    // the list. Username is required either way; the room name is not, because
    // clicking a room supplies it.
    const handleJoinRoom = (target) => {
        const targetRoom = (typeof target === "string" ? target : roomName).trim();

        if (!username.trim()) {
            setError("Please enter a username");
            return;
        }
        if (!targetRoom) {
            setError("Enter a room name, or pick a room below");
            return;
        }

        if (!socket.connected) {
            socket.connect();
        }

        const clientId = getClientId();

        if (!clientId) {
            setError("Refresh and retry");
            return;
        }

        // Clear any existing error
        setError("");

        // Clean up any existing listeners
        socket.off("playerJoined");
        socket.off("error");

        // Set up event listeners for this specific operation
        const handlePlayerJoined = (data) => {
            if (data.username === username && data.roomName === targetRoom) {
                localStorage.setItem("username", username);
                localStorage.setItem("roomName", targetRoom);
                localStorage.setItem("playerRole", "joiner");

                // Clean up listeners
                socket.off("playerJoined", handlePlayerJoined);
                socket.off("error", handleError);

                enterRoom(targetRoom);
            }
        };

        const handleError = (msg) => {
            setError(msg);
            socket.off("playerJoined", handlePlayerJoined);
            socket.off("error", handleError);
        };

        socket.on("playerJoined", handlePlayerJoined);
        socket.on("error", handleError);

        socket.emit("joinRoom", {
            roomName: targetRoom,
            username: username,
            clientId,
        });
    };
    
    // What each button needs before it will do anything. Both want a username and
    // a room name; after that the two are opposites, decided by the live lobby
    // list: you can only CREATE a room that does not exist yet, and you can only
    // JOIN one that does and still has a seat free.
    const typedRoom = roomName.trim();
    const listed = lobbyRooms.find((r) => r.roomName === typedRoom) || null;
    const named = username.trim().length > 0 && typedRoom.length > 0;

    const canCreate = named && listed === null;
    // The rack is the creator's call: if the room in the box already exists, its
    // rack is already dealt and the selector is not yours to touch.
    const rackLocked = listed !== null;
    const canJoin = named && listed !== null && listed.status === "open";

    // Each action carries its own colour once it can actually be used; until then
    // both sit in the same disabled grey, so colour means "this will do something".
    const buttonStyle = (enabled, accent) => ({
        borderRadius: '0',
        textAlign: 'center',
        width: '170px',
        height: '40px',
        fontSize: '16px',
        backgroundColor: theme.ui.buttonBackground,
        fontFamily: 'Helvetica, Arial, sans-serif',
        border: `2px solid ${enabled ? accent : theme.ui.buttonDisabledBorder}`,
        color: enabled ? accent : theme.ui.buttonDisabledText,
        cursor: enabled ? 'pointer' : 'not-allowed',
        fontWeight: 'bold',
    });

    // menu form with shared inputs for creating and joining rooms
    // displays error message on top
    // returns a div with shared input fields for username and room name
    // and two separate buttons for joining or creating a room
    // setUsername, setRoomName come from the shared state declarations at the top
      return (
        <div style={{ 
            display: 'flex', 
            justifyContent: 'center', 
            alignItems: 'center', 
            height: '100vh',
            backgroundColor: theme.page.background,
            color: theme.page.text
        }}>
            <div style={{
                textAlign: 'center',
                padding: '20px',
                backgroundColor: theme.page.background,
                transform: `scale(${scale})`,
                transformOrigin: 'center center'
            }}>
                <div style={{ marginBottom: '20px' }}>
                    <h1 style={{
                        fontSize: '48px',
                        marginBottom: '30px',
                        fontFamily: 'Helvetica, Arial, sans-serif',
                    }}>
                        CARROM
                    </h1>
                    {/* A real placeholder is one colour all the way through, and
                        only the * is meant to be red — so the prompt is drawn as
                        an overlay instead, centred over the empty field exactly
                        where a placeholder would sit, and dropped the moment
                        anything is typed. */}
                    <span style={{ position: 'relative', display: 'inline-block' }}>
                        <input
                            type="text"
                            ref={usernameRef}
                            aria-label="Username (required)"
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                            style={{
                                borderRadius: '0',
                                textAlign: 'center',
                                width: '350px',
                                height: '40px',
                                fontSize: '16px',
                                fontFamily: 'Helvetica, Arial, sans-serif',
                                backgroundColor: theme.ui.panelBackground,
                                color: theme.ui.text,
                                border: `1px solid ${theme.ui.inputBorder}`
                            }}
                        />
                        {username === "" && (
                            <span
                                aria-hidden="true"
                                style={{
                                    position: 'absolute',
                                    inset: 0,
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    color: theme.ui.placeholderText,
                                    fontFamily: 'Helvetica, Arial, sans-serif',
                                    fontSize: '16px',
                                    pointerEvents: 'none',
                                }}
                            >
                                USERNAME&nbsp;<span style={{ color: theme.ui.requiredMark }}>*</span>
                            </span>
                        )}
                    </span>
                    <br /><br />
                    
                    <input
                        type="text"
                        placeholder="ROOM NAME"
                        value={roomName}
                        onChange={(e) => setRoomName(e.target.value)}
                        style={{
                            borderRadius: '0',
                            textAlign: 'center',
                            width: '350px',
                            height: '40px',
                            fontSize: '16px',
                            fontFamily: 'Helvetica, Arial, sans-serif',
                            backgroundColor: theme.ui.panelBackground,
                            color: theme.ui.text,
                            border: `1px solid ${theme.ui.inputBorder}`
                        }}
                    />

                    {/* How many coins the rack holds, queen included. It belongs
                        to whoever creates the room, so it greys out once the name
                        in the box is a room that already exists — you play the
                        rack that is already on the table. */}
                    <div style={{
                        display: 'flex',
                        gap: '18px',
                        justifyContent: 'center',
                        alignItems: 'center',
                        width: '350px',
                        margin: '14px auto 0',
                        fontFamily: 'Helvetica, Arial, sans-serif',
                        fontSize: '14px',
                    }}>
                        <span style={{ color: theme.ui.muted, letterSpacing: '1px' }}>COINS</span>
                        {COIN_COUNTS.map((n) => {
                            const picked = n === coinCount;
                            return (
                                <button
                                    key={n}
                                    type="button"
                                    onClick={() => setCoinCount(n)}
                                    disabled={rackLocked}
                                    style={{
                                        background: 'none',
                                        border: 'none',
                                        padding: '2px 2px',
                                        fontFamily: 'Helvetica, Arial, sans-serif',
                                        fontSize: '16px',
                                        fontWeight: 'bold',
                                        letterSpacing: '1px',
                                        cursor: rackLocked ? 'not-allowed' : 'pointer',
                                        color: rackLocked
                                            ? theme.ui.modeDisabled
                                            : picked ? theme.ui.createAccent : theme.ui.modeInactive,
                                    }}
                                >
                                    {n}
                                </button>
                            );
                        })}
                    </div>

                    <br />
                    <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
                        <button
                            onClick={handleJoinRoom}
                            disabled={!canJoin}
                            style={buttonStyle(canJoin, theme.ui.joinAccent)}
                        >
                            JOIN ROOM
                        </button>
                        <button
                            onClick={handleCreateRoom}
                            disabled={!canCreate}
                            style={buttonStyle(canCreate, theme.ui.createAccent)}
                        >
                            CREATE ROOM
                        </button>
                    </div>
                    <div style={{ height: '30px', marginTop: '20px' }}>
                        {error && <p style={{color: theme.ui.error, margin: '0', fontFamily: 'Helvetica, Arial, sans-serif', textTransform: 'uppercase'}}>{error}</p>}
                    </div>

                    {/* Open rooms. Clicking one fills its name in above. */}
                    <RoomList onPick={handlePickRoom} onRooms={handleRooms} />
                </div>
            </div>
        </div>
    );
}
