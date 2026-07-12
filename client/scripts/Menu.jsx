import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import socket from "./socket.js";
import RoomList from "./RoomList.jsx";

// Room name is optional: creating without one gets a generated name, so a
// player can start a game without inventing anything.
const generateRoomName = () => `room-${Math.random().toString(36).slice(2, 7)}`;

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

export default function Menu() {
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
    const [roomName, setRoomName] = useState("");
    const [error, setError] = useState("");
    const navigate = useNavigate();

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
        if (!roomName) { localStorage.clear();}
        return () => {
            // Clean up listeners when component unmounts
            socket.off("playerJoined");
            socket.off("error");
        };
    }, []);

    // handles the creation of a room
    // if either username or room name are false, sets an error asking user to enter both
    // username and room name are both strings, set when user types in the shared input fields
    // if socket is not connected, connects to the server
    // gets client id from the session storage
    // if there is no client id found, sets an error asking user to refresh page and retry
    // emits a createRoom event to the server, with room name, username and client id
    const handleCreateRoom = () => {
        // Username is the only required field. An empty room name gets a
        // generated one, so "just start a game" is a single click.
        if (!username.trim()) {
            setError("Please enter a username");
            return;
        }
        const targetRoom = roomName.trim() || generateRoomName();
        if (!roomName.trim()) setRoomName(targetRoom);

        if (!socket.connected) {
            socket.connect();
        }

        const clientId = sessionStorage.getItem("clientId");

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

                navigate(`/${targetRoom}`);
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

        const clientId = sessionStorage.getItem("clientId");

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

                navigate(`/${targetRoom}`);
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
            backgroundColor: 'white'
        }}>
            <div style={{
                textAlign: 'center',
                padding: '20px',
                backgroundColor: 'white',
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
                    <input
                        type="text"
                        placeholder="USERNAME *"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        style={{
                            borderRadius: '0',
                            textAlign: 'center',
                            width: '350px',
                            height: '40px',
                            fontSize: '16px',
                            fontFamily: 'Helvetica, Arial, sans-serif',
                            border: '1px solid #ccc'
                        }}
                    />
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
                            border: '1px solid #ccc'
                        }}
                    />
                    <br /><br />
                    <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
                        <button 
                            onClick={handleJoinRoom}
                            style={{
                                borderRadius: '0',
                                textAlign: 'center',
                                width: '170px',
                                height: '40px',
                                fontSize: '16px',
                                backgroundColor: 'white',
                                fontFamily: 'Helvetica, Arial, sans-serif',
                                border: '2px solid black',
                                cursor: 'pointer',
                                fontWeight: 'bold'
                            }}
                        >
                            JOIN ROOM
                        </button>
                        <button 
                            onClick={handleCreateRoom}
                            style={{
                                borderRadius: '0',
                                textAlign: 'center',
                                width: '170px',
                                height: '40px',
                                fontSize: '16px',
                                backgroundColor: 'white',
                                fontFamily: 'Helvetica, Arial, sans-serif',
                                border: '2px solid black',
                                cursor: 'pointer',
                                fontWeight: 'bold'
                            }}
                        >
                            CREATE ROOM
                        </button>
                    </div>
                    <div style={{ height: '30px', marginTop: '20px' }}>
                        {error && <p style={{color: 'red', margin: '0', fontFamily: 'Helvetica, Arial, sans-serif', textTransform: 'uppercase'}}>{error}</p>}
                    </div>

                    {/* Open rooms. Clicking one joins it with the username above. */}
                    <RoomList onPick={handleJoinRoom} />
                </div>
            </div>
        </div>
    );
}
