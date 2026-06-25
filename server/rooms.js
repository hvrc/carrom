// Room data layer: the in-memory room registry + pure helpers. No socket.io,
// no physics — just state and the small functions that operate on it.

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

export function createRoom(roomName, creator) {
    return {
        creator,
        joiner: null,
        clientIds: new Set([creator.clientId]),
        // Server-authoritative game state; lazily created when player 2 joins.
        game: null,
        // Cancel handle of an in-flight flick simulation, if any.
        simCancel: null,
        // Pending disconnect-grace teardown timers, keyed by clientId.
        graceTimers: {},
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

// The `roomUpdate` payload mirrored to clients (Manager.js reads it).
export function roomUpdatePayload(room, roomName) {
    return {
        roomName,
        creator: room.creator
            ? { username: room.creator.username, score: room.scores.creator, debt: room.debts.creator }
            : null,
        joiner: room.joiner
            ? { username: room.joiner.username, score: room.scores.joiner, debt: room.debts.joiner }
            : null,
        whoseTurn: room.whoseTurn,
        scores: room.scores,
        debts: room.debts,
    };
}
