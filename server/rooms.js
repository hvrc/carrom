// Room data layer: the in-memory room registry + pure helpers. No socket.io,
// no physics — just state and the small functions that operate on it.
import { DEFAULT_COIN_COUNT, normalizeCoinCount } from "./sim/state.js";

// roomName -> room object.
export const rooms = new Map();

// Active socket count per persistent clientId. A refresh briefly has two
// connections (old closing, new opening); this lets the disconnect handler
// avoid starting a grace teardown while another live connection for the same
// client exists — robust to connect/disconnect event ordering.
export const liveConnections = new Map();

// Grace window: after a player disconnects, keep their room alive briefly so a
// refresh / transient drop can reconnect and resume. Tear down only if they
// don't return within the window. (research §C2)
export const DISCONNECT_GRACE_MS = Number(process.env.DISCONNECT_GRACE_MS) || 30000;

// How long the finished board stays up before the next game is dealt, so the
// winner is actually seen rather than the board blinking into a fresh rack.
export const GAME_RESET_DELAY_MS = Number(process.env.GAME_RESET_DELAY_MS) || 3500;

export function createRoom(roomName, creator, coinCount = DEFAULT_COIN_COUNT) {
    return {
        creator,
        // How many coins this room plays with, queen included. Chosen once by
        // whoever created the room and kept across re-deals; a player joining
        // walks into the rack that is already set.
        coinCount: normalizeCoinCount(coinCount),
        joiner: null,
        clientIds: new Set([creator.clientId]),
        // Server-authoritative game state; lazily created when player 2 joins.
        game: null,
        // Cancel handle of an in-flight flick simulation, if any.
        simCancel: null,
        // Pending disconnect-grace teardown timers, keyed by clientId.
        graceTimers: {},
        // Games won in this room. Lives on the ROOM, not the game state, so it
        // survives the re-deal after each win. In memory only: it dies with the
        // room (PRD Q8).
        wins: { creator: 0, joiner: 0 },
        // Handle for the pending re-deal after a win.
        resetTimer: null,
        whoseTurn: "creator",
        scores: { creator: 0, joiner: 0 },
        debts: { creator: 0, joiner: 0 },
    };
}

// Which room a persistent clientId belongs to. Returns [roomName, room, role]
// or null. A clientId is in at most one room.
export function findRoomByClientId(clientId) {
    for (const [roomName, room] of rooms.entries()) {
        if (room.creator && room.creator.clientId === clientId) return [roomName, room, "creator"];
        if (room.joiner && room.joiner.clientId === clientId) return [roomName, room, "joiner"];
    }
    return null;
}

// Cancel a pending disconnect-grace teardown for a returning client.
export function clearGraceTimer(room, clientId) {
    if (room && room.graceTimers && room.graceTimers[clientId]) {
        clearTimeout(room.graceTimers[clientId]);
        delete room.graceTimers[clientId];
    }
}

// Lobby list: room health, reduced to the two states the menu shows as a dot.
//   "open"  (green)  — a seat is free and nobody is mid-reconnect: join freely.
//   "busy"  (yellow) — full (a game is under way), or a player is inside the
//                      disconnect grace window, so the room may not survive.
// A room in grace is deliberately NOT advertised as open: the seat looks free
// but its occupant may walk back into it within DISCONNECT_GRACE_MS.
export function roomStatus(room) {
    const reconnecting = Object.keys(room.graceTimers || {}).length > 0;
    if (reconnecting) return "busy";
    return room.joiner ? "busy" : "open";
}

// One page of the lobby list. Rooms iterate in insertion order (Map), so paging
// is stable as long as nothing is deleted mid-scroll; a room closing just
// shifts the tail, which the client tolerates (it dedupes by name).
export function roomListPage(offset = 0, limit = 20) {
    const start = Math.max(0, Math.floor(Number(offset)) || 0);
    const size = Math.min(Math.max(1, Math.floor(Number(limit)) || 20), 50);

    const page = [];
    let i = 0;
    for (const [roomName, room] of rooms.entries()) {
        if (i >= start) {
            page.push({
                roomName,
                usernames: [room.creator?.username, room.joiner?.username].filter(Boolean),
                status: roomStatus(room),
            });
            if (page.length >= size) break;
        }
        i++;
    }
    return { rooms: page, offset: start, limit: size, total: rooms.size };
}

// The `roomUpdate` payload mirrored to clients (Manager.js reads it).
export function roomUpdatePayload(room, roomName) {
    const wins = room.wins || { creator: 0, joiner: 0 };
    return {
        roomName,
        creator: room.creator
            ? {
                username: room.creator.username,
                score: room.scores.creator,
                debt: room.debts.creator,
                wins: wins.creator,
            }
            : null,
        joiner: room.joiner
            ? {
                username: room.joiner.username,
                score: room.scores.joiner,
                debt: room.debts.joiner,
                wins: wins.joiner,
            }
            : null,
        whoseTurn: room.whoseTurn,
        scores: room.scores,
        debts: room.debts,
        wins: { ...wins },
    };
}
