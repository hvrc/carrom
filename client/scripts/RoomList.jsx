import { useCallback, useEffect, useRef, useState } from "react";
import socket from "./socket.js";
import "./RoomList.css";

const PAGE_SIZE = 20;

// The lobby is live: rooms come and go while you are sitting on the menu, so the
// list re-reads itself on this interval as well as on every reconnect and every
// time the tab comes back to the foreground.
const REFRESH_MS = 3000;

// If a request goes unanswered this long, stop waiting for it. Without this a
// single lost reply would leave `loadingRef` stuck and every later refresh —
// including the one on reconnect — would be skipped, which is how the list ends
// up empty and stays empty.
const REQUEST_TIMEOUT_MS = 5000;

// The server caps a page at 50.
const MAX_PAGE = 50;

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
export default function RoomList({ onPick, onRooms }) {
    const [rooms, setRooms] = useState([]);
    const [total, setTotal] = useState(0);
    const loadingRef = useRef(false);
    const containerRef = useRef(null);

    // Read from a ref inside the socket handler: the listener is registered once,
    // and a stale closure over `rooms` would keep re-requesting offset 0.
    const roomsRef = useRef([]);
    roomsRef.current = rooms;

    const timeoutRef = useRef(null);

    const fetchPage = useCallback((offset, limit = PAGE_SIZE) => {
        if (loadingRef.current) return;
        loadingRef.current = true;
        clearTimeout(timeoutRef.current);
        timeoutRef.current = setTimeout(() => { loadingRef.current = false; }, REQUEST_TIMEOUT_MS);
        if (!socket.connected) socket.connect();
        socket.emit("listRooms", { offset, limit });
    }, []);

    // A refresh re-reads from the top, but asks for as much as is already on
    // screen — otherwise refreshing while scrolled would silently truncate the
    // list back to one page.
    const refresh = useCallback(() => {
        fetchPage(0, Math.min(MAX_PAGE, Math.max(PAGE_SIZE, roomsRef.current.length)));
    }, [fetchPage]);

    useEffect(() => {
        const handleRoomList = ({ rooms: page, offset, total: count }) => {
            loadingRef.current = false;
            clearTimeout(timeoutRef.current);
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
        const handleConnect = () => refresh();

        // Coming back to the tab should show the lobby as it is now, not as it
        // was when you left it — and browsers throttle timers in background tabs,
        // so the interval alone cannot be trusted to have kept up.
        const handleVisible = () => {
            if (document.visibilityState === "visible") refresh();
        };

        socket.on("roomList", handleRoomList);
        socket.on("connect", handleConnect); // a fresh list on every (re)connect
        document.addEventListener("visibilitychange", handleVisible);
        window.addEventListener("focus", refresh);
        fetchPage(0);

        const poll = setInterval(() => {
            if (document.visibilityState === "visible") refresh();
        }, REFRESH_MS);

        return () => {
            socket.off("roomList", handleRoomList);
            socket.off("connect", handleConnect);
            document.removeEventListener("visibilitychange", handleVisible);
            window.removeEventListener("focus", refresh);
            clearInterval(poll);
            clearTimeout(timeoutRef.current);
        };
    }, [fetchPage, refresh]);

    // The menu needs the same live list to decide whether JOIN and CREATE are
    // usable for the room name that's been typed in, so hand it up on every change.
    useEffect(() => {
        if (onRooms) onRooms(rooms);
    }, [rooms, onRooms]);

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
