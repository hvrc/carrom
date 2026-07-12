import { useCallback, useEffect, useRef, useState } from "react";
import socket from "./socket.js";
import "./RoomList.css";

const PAGE_SIZE = 20;

// Distance from the bottom (px) at which the next page is fetched. Big enough
// that the next slice usually lands before the user reaches the end.
const PREFETCH_MARGIN = 80;

/**
 * The lobby list: every open room, one per line, with the players in it and a
 * status dot. Pages in as the user scrolls — there is no pager UI, by design.
 *
 * Rooms are fetched over the same socket the game uses (`listRooms` ->
 * `roomList`), so the list reflects live server state rather than a cached HTTP
 * response.
 */
export default function RoomList({ onPick }) {
    const [rooms, setRooms] = useState([]);
    const [total, setTotal] = useState(0);
    const loadingRef = useRef(false);
    const containerRef = useRef(null);

    // Read from a ref inside the socket handler: the listener is registered once,
    // and a stale closure over `rooms` would keep re-requesting offset 0.
    const roomsRef = useRef([]);
    roomsRef.current = rooms;

    const fetchPage = useCallback((offset) => {
        if (loadingRef.current) return;
        loadingRef.current = true;
        if (!socket.connected) socket.connect();
        socket.emit("listRooms", { offset, limit: PAGE_SIZE });
    }, []);

    useEffect(() => {
        const handleRoomList = ({ rooms: page, offset, total: count }) => {
            loadingRef.current = false;
            setTotal(count);
            setRooms((prev) => {
                // offset 0 is a refresh (mount / reconnect): replace outright.
                const base = offset === 0 ? [] : prev;
                const seen = new Set(base.map((r) => r.roomName));
                // Dedupe by name: a room closing mid-scroll shifts the tail, so
                // the same room can arrive twice across two pages.
                return [...base, ...page.filter((r) => !seen.has(r.roomName))];
            });
        };

        // Named, so the cleanup removes only this listener — socket.off("connect")
        // with no handler would rip out everyone else's too.
        const handleConnect = () => fetchPage(0);

        socket.on("roomList", handleRoomList);
        socket.on("connect", handleConnect); // a fresh list on every (re)connect
        fetchPage(0);

        return () => {
            socket.off("roomList", handleRoomList);
            socket.off("connect", handleConnect);
        };
    }, [fetchPage]);

    const handleScroll = () => {
        const el = containerRef.current;
        if (!el || loadingRef.current) return;
        if (roomsRef.current.length >= total) return; // everything is loaded
        if (el.scrollHeight - el.scrollTop - el.clientHeight < PREFETCH_MARGIN) {
            fetchPage(roomsRef.current.length);
        }
    };

    if (rooms.length === 0) return null; // no rooms, no empty-state chrome

    return (
        <>
        <div className="room-list-label">ROOMS</div>
        <div className="room-list" ref={containerRef} onScroll={handleScroll}>
            {rooms.map((room) => (
                <button
                    type="button"
                    key={room.roomName}
                    className="room-list-row"
                    onClick={() => onPick(room.roomName)}
                >
                    <span style={{ minWidth: 0 }}>
                        <div className="room-list-name">{room.roomName}</div>
                        <div className="room-list-players">{room.usernames.join(", ")}</div>
                    </span>
                    <span
                        className={`room-list-dot room-list-dot-${room.status === "open" ? "open" : "busy"}`}
                        title={room.status === "open" ? "A seat is free" : "Full, or a player is reconnecting"}
                    />
                </button>
            ))}
        </div>
        </>
    );
}
