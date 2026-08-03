import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import socket, { getClientId, clearSession } from "./socket.js";
import Manager from "./Manager.js";
import Board from "./Board.jsx";
import Menu from "./Menu.jsx";

// Do we already have a session for THIS room? Opening /<room-name> cold (a
// shared link, or a click from the lobby list) does not, so we must ask for a
// username before touching the room — nobody plays anonymously.
const hasIdentity = (roomName) =>
    localStorage.getItem("roomName") === roomName &&
    !!localStorage.getItem("username") &&
    !!localStorage.getItem("playerRole");

// Room: owns the socket lifecycle for one room (join/rejoin, room updates,
// teardown) and renders the <Board>. All gameplay state arrives via the
// server-authoritative events handled inside Board.jsx; this component only
// tracks lobby-level data (who's in the room, scores/turn mirror) and routing.
export default function Room() {
    const { roomName } = useParams();
    const navigate = useNavigate();
    const [roomData, setRoomData] = useState(null);
    // Derived, not stored: a session can appear (the menu below just joined) or
    // belong to a different room (the URL changed under us), and stored state
    // would go stale in both cases. The tick only exists to force the recheck.
    const [identityTick, setIdentityTick] = useState(0);
    const joined = useMemo(() => hasIdentity(roomName), [roomName, identityTick]);
    const managerRef = useRef(null);

    // (Re)create the Manager once both players are present (or the room changes).
    useEffect(() => {
        if (
            roomData?.creator &&
            roomData?.joiner &&
            (!managerRef.current || managerRef.current.roomName !== roomName)
        ) {
            managerRef.current = new Manager(roomName, roomData);
        }
    }, [roomData, roomName]);

    useEffect(() => {
        // No username yet → the menu is on screen. Emitting anything here would
        // race it (and a checkRoomAccess for a non-existent room would trip the
        // fatal-error path below and bounce the visitor straight back to /).
        if (!joined) return;

        if (!socket.connected) socket.connect();
        const clientId = getClientId();
        const storedRoomName = localStorage.getItem("roomName");
        const username = localStorage.getItem("username");
        const playerRole = localStorage.getItem("playerRole");

        if (!clientId) {
            clearSession();
            navigate("/");
            return;
        }

        // Returning member → rejoin (resumes the existing game, no re-deal).
        // Otherwise just check access for this room.
        if (storedRoomName === roomName && username && playerRole) {
            socket.emit("rejoinRoom", { roomName, username, clientId, playerRole });
        } else {
            socket.emit("checkRoomAccess", { roomName, clientId });
        }

        const handleAccessGranted = () => {
            socket.emit("requestRoomData", { roomName });
        };

        const handleRoomUpdate = (data) => {
            if (data.roomName !== roomName) return;
            setRoomData(data);
            if (managerRef.current) {
                if (data.whoseTurn) {
                    managerRef.current.whoseTurn = data.whoseTurn;
                    managerRef.current.playerData[0].isTurn = data.whoseTurn === "creator";
                    managerRef.current.playerData[1].isTurn = data.whoseTurn === "joiner";
                }
                if (data.debts) {
                    managerRef.current.playerData[0].debt = data.debts.creator;
                    managerRef.current.playerData[1].debt = data.debts.joiner;
                }
                if (data.wins) {
                    managerRef.current.playerData[0].wins = data.wins.creator;
                    managerRef.current.playerData[1].wins = data.wins.joiner;
                }
                if (data.creator && typeof data.creator.score !== "undefined") {
                    managerRef.current.playerData[0].score = data.creator.score;
                }
                if (data.joiner && typeof data.joiner.score !== "undefined") {
                    managerRef.current.playerData[1].score = data.joiner.score;
                }
            } else {
                managerRef.current = new Manager(roomName, data);
            }
        };

        const handleRoomClosed = (msg) => {
            console.warn("[net] roomClosed:", msg);
            clearSession();
            navigate("/");
        };

        const handleError = (msg) => {
            // Only leave on a genuine room/session failure. Transient gameplay
            // errors (e.g. "Not your turn", "Game has not started") must NOT
            // eject the player.
            const fatal = /room does not exist|room is full|invalid session|invalid client/i.test(String(msg));
            if (fatal) {
                console.warn("[net] fatal error — leaving room:", msg);
                clearSession();
                navigate("/");
            } else {
                console.warn("[net] transient error (ignored):", msg);
            }
        };

        socket.on("accessGranted", handleAccessGranted);
        socket.on("roomUpdate", handleRoomUpdate);
        socket.on("roomClosed", handleRoomClosed);
        socket.on("error", handleError);

        return () => {
            socket.off("accessGranted", handleAccessGranted);
            socket.off("roomUpdate", handleRoomUpdate);
            socket.off("roomClosed", handleRoomClosed);
            socket.off("error", handleError);
        };
    }, [roomName, navigate, joined]);

    const handleLeaveRoom = () => {
        const clientId = getClientId();
        if (clientId) socket.emit("leaveRoom", { roomName, clientId });
        clearSession();
        navigate("/");
    };

    // Arrived by link with no session for this room: show the ordinary menu with
    // the room already filled in. It joins (or creates) the room and tells us,
    // and from there this is a normal seat.
    if (!joined) {
        return <Menu initialRoomName={roomName} onJoined={() => setIdentityTick((n) => n + 1)} />;
    }

    if (!roomData) return <div>Loading room...</div>;
    if (!managerRef.current) managerRef.current = new Manager(roomName, roomData);

    const manager = managerRef.current;
    const playerRole = localStorage.getItem("playerRole");
    const isMyTurn = roomData.whoseTurn === playerRole;

    return (
        <div style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "100vh",
            padding: "20px",
        }}>
            <Board
                isMyTurn={isMyTurn}
                socket={socket}
                roomName={roomName}
                playerRole={playerRole}
                manager={manager}
                onLeaveRoom={handleLeaveRoom}
                creatorUsername={roomData?.creator?.username || ""}
                joinerUsername={roomData?.joiner?.username || ""}
                whoseTurn={roomData.whoseTurn}
            />
        </div>
    );
}
