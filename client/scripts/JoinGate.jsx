import { useRef, useState } from "react";
import socket from "./socket.js";

/**
 * Username gate for a room you have no identity in yet — i.e. someone opened
 * /<room-name> directly, or clicked a room without a stored session.
 *
 * A player cannot enter a room anonymously, so this blocks until a username is
 * given. If the room exists we join it; if it doesn't (a link to a room that was
 * never created, or has since closed) we create it under that name and wait for
 * an opponent, which is what a shared link is expected to do.
 */
export default function JoinGate({ roomName, onJoined }) {
    const [username, setUsername] = useState("");
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    // Which request is in flight — decides the role we persist on success.
    const attemptRef = useRef("join");

    const submit = () => {
        const name = username.trim();
        if (!name) {
            setError("Please enter a username");
            return;
        }

        if (!socket.connected) socket.connect();
        const clientId = sessionStorage.getItem("clientId");
        if (!clientId) {
            setError("Refresh and retry");
            return;
        }

        setError("");
        setBusy(true);
        socket.off("playerJoined");
        socket.off("error");

        const cleanup = () => {
            socket.off("playerJoined", handlePlayerJoined);
            socket.off("error", handleError);
            setBusy(false);
        };

        const handlePlayerJoined = (data) => {
            if (data.roomName !== roomName || data.username !== name) return;
            localStorage.setItem("username", name);
            localStorage.setItem("roomName", roomName);
            localStorage.setItem("playerRole", attemptRef.current === "create" ? "creator" : "joiner");
            cleanup();
            onJoined();
        };

        const handleError = (msg) => {
            // The link points at a room that doesn't exist (yet). Create it under
            // that name rather than bouncing the visitor back to the menu.
            if (attemptRef.current === "join" && /does not exist/i.test(String(msg))) {
                attemptRef.current = "create";
                socket.emit("createRoom", { roomName, username: name, clientId });
                return;
            }
            cleanup();
            setError(String(msg));
        };

        socket.on("playerJoined", handlePlayerJoined);
        socket.on("error", handleError);

        attemptRef.current = "join";
        socket.emit("joinRoom", { roomName, username: name, clientId });
    };

    const input = {
        borderRadius: 0, textAlign: "center", width: "350px", height: "40px",
        fontSize: "16px", fontFamily: "Helvetica, Arial, sans-serif", border: "1px solid #ccc",
    };

    return (
        <div style={{
            display: "flex", justifyContent: "center", alignItems: "center",
            height: "100vh", backgroundColor: "white",
        }}>
            <div style={{ textAlign: "center", fontFamily: "Helvetica, Arial, sans-serif" }}>
                <h1 style={{ fontSize: "32px", marginBottom: "30px", textTransform: "uppercase" }}>
                    {roomName}
                </h1>
                <input
                    type="text"
                    autoFocus
                    placeholder="USERNAME *"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && submit()}
                    style={input}
                />
                <br /><br />
                <button
                    onClick={submit}
                    disabled={busy}
                    style={{
                        borderRadius: 0, width: "350px", height: "40px", fontSize: "16px",
                        backgroundColor: "white", fontFamily: "Helvetica, Arial, sans-serif",
                        border: "2px solid black", cursor: busy ? "default" : "pointer", fontWeight: "bold",
                    }}
                >
                    ENTER ROOM
                </button>
                <div style={{ height: "30px", marginTop: "20px" }}>
                    {error && (
                        <p style={{ color: "red", margin: 0, textTransform: "uppercase" }}>{error}</p>
                    )}
                </div>
            </div>
        </div>
    );
}
