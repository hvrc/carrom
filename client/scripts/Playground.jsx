import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import socket, { getClientId } from "./socket.js";
import Manager from "./Manager.js";
import Board from "./Board.jsx";

/**
 * /playground — the practice board. One player, the full rack, and no opponent
 * to wait for: the turn never leaves you and the board re-deals as soon as the
 * last coin is down.
 *
 * The room is real and server-authoritative like any other — the physics has to
 * come from somewhere — but it is private to this browser identity and hidden
 * from the lobby, so two people on /playground never meet.
 */
export default function Playground() {
    const navigate = useNavigate();
    const [roomData, setRoomData] = useState(null);
    const managerRef = useRef(null);

    // One room per identity. The URL stays /playground; this is only the name
    // the server files it under.
    const roomName = useMemo(() => `playground-${getClientId() || "anon"}`, []);

    useEffect(() => {
        if (!socket.connected) socket.connect();
        const clientId = getClientId();
        if (!clientId) {
            navigate("/");
            return undefined;
        }

        const username = localStorage.getItem("username") || "SOLO";
        socket.emit("openSolo", { roomName, username, clientId });

        const handleRoomUpdate = (data) => {
            if (data.roomName !== roomName) return;
            setRoomData(data);
            const m = managerRef.current;
            if (!m) {
                managerRef.current = new Manager(roomName, data);
                return;
            }
            if (data.creator && typeof data.creator.score !== "undefined") {
                m.playerData[0].score = data.creator.score;
            }
            if (data.debts) m.playerData[0].debt = data.debts.creator;
        };

        socket.on("roomUpdate", handleRoomUpdate);
        return () => socket.off("roomUpdate", handleRoomUpdate);
    }, [roomName, navigate]);

    if (!roomData) return <div>Loading playground...</div>;
    if (!managerRef.current) managerRef.current = new Manager(roomName, roomData);

    const handleLeave = () => {
        const clientId = getClientId();
        if (clientId) socket.emit("leaveRoom", { roomName, clientId });
        navigate("/");
    };

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
                isMyTurn
                solo
                socket={socket}
                roomName={roomName}
                title="PLAYGROUND"
                playerRole="creator"
                manager={managerRef.current}
                onLeaveRoom={handleLeave}
                creatorUsername={roomData?.creator?.username || "SOLO"}
                joinerUsername=""
                whoseTurn="creator"
                startedAt={roomData?.startedAt}
            />
        </div>
    );
}
