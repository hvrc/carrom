import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import socket, { getClientId } from "./socket.js";
import Manager from "./Manager.js";
import Board from "./Board.jsx";
import { COIN_COUNTS, DEFAULT_COIN_COUNT } from "./flickMath.js";

/**
 * /computer — a game against the machine.
 *
 * A real game: turns pass, colours are claimed by whoever pockets first, the
 * queen has to be covered, and somebody wins. What it is not is a room — there
 * is no seat to wait for and nothing to advertise, so like the playground it is
 * private to this browser and never appears in the lobby.
 *
 * Everything the opponent does arrives on exactly the channels a human opponent
 * would use: the striker slides into place on `strikerPlaceUpdate`, the shot
 * comes back as frames and a `turnResolved`. The board does not know or care
 * that nobody is holding the other end.
 */
export default function Computer() {
    const navigate = useNavigate();
    const [params] = useSearchParams();

    // The rack travels in the URL, as it does for the playground, so the page
    // can be reloaded and still mean the same thing.
    const coinCount = useMemo(() => {
        const asked = Number(params.get("coins"));
        return COIN_COUNTS.includes(asked) ? asked : DEFAULT_COIN_COUNT;
    }, [params]);

    const [roomData, setRoomData] = useState(null);
    const managerRef = useRef(null);

    // One game per identity. The URL stays /computer; this is only the name the
    // server files it under.
    const roomName = useMemo(() => `computer-${getClientId() || "anon"}`, []);

    useEffect(() => {
        if (!socket.connected) socket.connect();
        const clientId = getClientId();
        if (!clientId) {
            navigate("/");
            return undefined;
        }

        const username = (localStorage.getItem("username") || "").trim() || "?";
        socket.emit("openComputer", { roomName, username, clientId, coinCount });

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
            if (data.joiner && typeof data.joiner.score !== "undefined") {
                m.playerData[1].score = data.joiner.score;
            }
            if (data.debts) {
                m.playerData[0].debt = data.debts.creator;
                m.playerData[1].debt = data.debts.joiner;
            }
        };

        socket.on("roomUpdate", handleRoomUpdate);
        return () => socket.off("roomUpdate", handleRoomUpdate);
    }, [roomName, navigate, coinCount]);

    if (!roomData) return <div>Loading...</div>;
    if (!managerRef.current) managerRef.current = new Manager(roomName, roomData);

    const handleLeave = () => {
        // Say so on the way out: the room holds a game the server is running,
        // and leaving quietly would leave it running until the socket drops.
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
                isMyTurn={roomData.whoseTurn === "creator"}
                socket={socket}
                roomName={roomName}
                title="COMPUTER"
                playerRole="creator"
                manager={managerRef.current}
                onLeaveRoom={handleLeave}
                creatorUsername={roomData?.creator?.username || "?"}
                joinerUsername={roomData?.joiner?.username || "COMPUTER"}
                whoseTurn={roomData.whoseTurn}
                startedAt={roomData.startedAt}
            />
        </div>
    );
}
