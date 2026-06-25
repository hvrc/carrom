// All per-connection socket event handlers. Wired up once per connection by
// index.js: io.on("connection", socket => registerHandlers(io, socket, service)).
import {
    rooms, liveConnections, DISCONNECT_GRACE_MS,
    createRoom, findRoomByClientId, clearGraceTimer, roomUpdatePayload,
} from "./rooms.js";
import { startFlickSimulation, fullStateSnapshot } from "./physics.js";

const isValidId = (id) => id && id !== "null" && id !== "undefined";

export function registerHandlers(io, socket, service) {
    const { startGame, syncRoomFromGame, broadcastRoomUpdate } = service;
    const clientId = socket.handshake.query.clientId;

    if (!isValidId(clientId)) {
        socket.emit("error", "Invalid client ID");
        socket.disconnect();
        return;
    }
    console.log("Client connected:", socket.id, "clientId:", clientId, socket.recovered ? "(recovered)" : "");
    liveConnections.set(clientId, (liveConnections.get(clientId) || 0) + 1);

    socket.on("error", (error) => console.error("Socket error:", error));

    // (Re)connecting member: cancel any pending grace teardown and re-join the
    // socket.io room so broadcasts reach them immediately. The client also
    // re-syncs via rejoinRoom -> requestRoomData.
    const reconnecting = findRoomByClientId(clientId);
    if (reconnecting) {
        const [reRoomName, reRoom] = reconnecting;
        clearGraceTimer(reRoom, clientId);
        socket.join(reRoomName);
    }

    // Lobby: can this client access the room? (join the socket.io room if so)
    socket.on("checkRoomAccess", ({ roomName, clientId: incomingClientId }) => {
        if (!isValidId(incomingClientId)) return socket.emit("error", "Invalid client ID");
        if (!rooms.has(roomName)) return socket.emit("error", "Room does not exist");
        const room = rooms.get(roomName);
        if (room.clientIds.size >= 2 && !room.clientIds.has(incomingClientId)) {
            return socket.emit("error", "Room is full");
        }
        socket.join(roomName);
        socket.emit("accessGranted");
    });

    // Reconnect after a refresh/drop. Resumes the existing game (no re-deal).
    socket.on("rejoinRoom", ({ roomName, clientId: incomingClientId, playerRole }) => {
        if (!isValidId(incomingClientId)) return socket.emit("error", "Invalid client ID");
        if (!rooms.has(roomName)) return socket.emit("error", "Room does not exist");
        const room = rooms.get(roomName);
        const matches =
            (playerRole === "creator" && room.creator && room.creator.clientId === incomingClientId) ||
            (playerRole === "joiner" && room.joiner && room.joiner.clientId === incomingClientId);
        if (!matches) return socket.emit("error", "Invalid session or role");
        clearGraceTimer(room, incomingClientId);
        socket.join(roomName);
        socket.emit("accessGranted");
    });

    socket.on("createRoom", ({ roomName, username, clientId: incomingClientId }) => {
        if (!isValidId(incomingClientId)) return socket.emit("error", "Invalid client ID");
        if (rooms.has(roomName)) return socket.emit("error", "Room already exists");
        rooms.set(roomName, createRoom(roomName, { username, clientId: incomingClientId }));
        socket.join(roomName);
        socket.emit("playerJoined", { username, roomName });
        socket.emit("roomUpdate", { roomName, creator: { username }, joiner: null, whoseTurn: "creator" });
    });

    socket.on("joinRoom", ({ roomName, username, clientId: incomingClientId }) => {
        if (!isValidId(incomingClientId)) return socket.emit("error", "Invalid client ID");
        if (!rooms.has(roomName)) return socket.emit("error", "Room does not exist");
        const room = rooms.get(roomName);
        if (room.clientIds.has(incomingClientId)) return socket.emit("error", "Client already in room");
        if (room.clientIds.size >= 2 || room.joiner) return socket.emit("error", "Room is full");

        room.joiner = { username, clientId: incomingClientId };
        room.clientIds.add(incomingClientId);
        socket.join(roomName);
        socket.emit("playerJoined", { username, roomName });

        // Both players present — (re)initialize authoritative game state.
        startGame(roomName);
        broadcastRoomUpdate(roomName);
    });

    // Re-send room data (+ current game snapshot if a game is in progress).
    socket.on("requestRoomData", ({ roomName }) => {
        if (!rooms.has(roomName)) return socket.emit("error", "Room does not exist");
        const room = rooms.get(roomName);
        socket.emit("roomUpdate", roomUpdatePayload(room, roomName));
        if (room.game) socket.emit("gameInit", fullStateSnapshot(room.game));
    });

    // Explicit leave (EXIT button). A 2-player match can't continue with one
    // player, so leaving ends the room for both.
    socket.on("leaveRoom", ({ roomName, clientId: incomingClientId }) => {
        const room = rooms.get(roomName);
        if (!room) return;
        const isMember =
            (room.creator && room.creator.clientId === incomingClientId) ||
            (room.joiner && room.joiner.clientId === incomingClientId);
        if (!isMember) return;
        if (room.simCancel) { room.simCancel(); room.simCancel = null; }
        clearGraceTimer(room, incomingClientId);
        socket.to(roomName).emit("roomClosed", "Opponent left the room");
        rooms.delete(roomName);
        socket.leave(roomName);
    });

    // Don't tear the room down immediately — start a grace timer keyed on the
    // persistent clientId (NOT socket.id). A reconnect cancels it; otherwise the
    // room closes and the opponent is notified.
    socket.on("disconnect", () => {
        const remaining = (liveConnections.get(clientId) || 1) - 1;
        if (remaining <= 0) liveConnections.delete(clientId);
        else liveConnections.set(clientId, remaining);

        const found = findRoomByClientId(clientId);
        if (!found) return;
        const [roomName, room] = found;
        if (remaining > 0) return;              // still connected elsewhere
        if (room.graceTimers[clientId]) return; // teardown already pending

        room.graceTimers[clientId] = setTimeout(() => {
            const r = rooms.get(roomName);
            if (!r) return;
            if (r.simCancel) { r.simCancel(); r.simCancel = null; }
            io.to(roomName).emit("roomClosed", "Opponent left the room");
            rooms.delete(roomName);
        }, DISCONNECT_GRACE_MS);
    });

    // Striker-placement preview — relayed to the peer for live sync. The
    // authoritative strikerX is whatever the flicker sends in their `flick`.
    socket.on("strikerSliderUpdate", ({ roomName, playerRole, sliderValue, strikerX }) => {
        if (!rooms.has(roomName)) return socket.emit("error", "Room does not exist");
        socket.to(roomName).emit("strikerSliderUpdate", { roomName, playerRole, sliderValue, strikerX });
    });

    // Flick: validate turn (by persistent clientId, not socket.id), run the
    // simulation, stream frames + per-pocket events + a final turnResolved.
    socket.on("flick", ({ roomName, strikerX, angle, force }) => {
        const room = rooms.get(roomName);
        if (!room) return socket.emit("error", "Room does not exist");
        if (!room.game) return socket.emit("error", "Game has not started");
        if (room.simCancel) return;

        let actor = null;
        if (room.creator && room.creator.clientId === clientId) actor = "creator";
        else if (room.joiner && room.joiner.clientId === clientId) actor = "joiner";
        if (!actor) return socket.emit("error", "You are not in this room");
        if (actor !== room.game.whoseTurn) return socket.emit("error", "Not your turn");

        room.simCancel = startFlickSimulation(room.game, { strikerX, angle, force }, actor, {
            onFrame: (snap) => io.to(roomName).emit("physicsFrame", snap),
            onPocket: (p) => io.to(roomName).emit("pocketEvent", p),
            onDone: (resolution, fullState) => {
                room.simCancel = null;
                syncRoomFromGame(room);
                io.to(roomName).emit("turnResolved", { ...resolution, state: fullState });
                broadcastRoomUpdate(roomName);
            },
        });
    });

    // Reset request — wipe game state and re-deal.
    socket.on("gameReset", ({ roomName }) => {
        if (!rooms.has(roomName)) return socket.emit("error", "Room does not exist");
        startGame(roomName);
        broadcastRoomUpdate(roomName);
    });
}
