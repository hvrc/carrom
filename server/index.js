// when a client connects via socket.connect() in Menu.jsx, Room.jsx,
// it creates a unique socket connection for that client
// socket.on(), this waits for specific events from the client
// socket emit(), sends an event to client who initiated the connection
// when client join a room using socket.join(room), 
// socket.io maintains a registry, which sockets are in which room
// socket.to(room).emit(), sends an event to all clients in room except the sender
// io.to(room).emit(), sends event to all clients in room

import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from 'cors';
import {
    createInitialState,
    fullStateSnapshot,
    startFlickSimulation,
} from "./physics.js";

// ============================================================================
// SOCKET EVENT CONTRACT (Phase 1 — server-authoritative physics)
// ----------------------------------------------------------------------------
// Room lifecycle (client -> server):
//   createRoom, joinRoom, rejoinRoom, leaveRoom, checkRoomAccess,
//   requestRoomData, disconnect
//   (liveness is Socket.IO's built-in ping/pong; no app-level heartbeat)
// Room lifecycle (server -> client):
//   playerJoined, roomUpdate, roomClosed, accessGranted, error
//
// Gameplay (client -> server):
//   flick           { roomName, strikerX, angle, force }
//                   strikerX clamped server-side; angle in radians (atan2);
//                   force in [0, 1].
//   strikerSliderUpdate { roomName, playerRole, sliderValue, strikerX }
//                   placement-only preview, relayed as-is.
//   gameReset       { roomName }   (request to start a new game)
//
// Gameplay (server -> client):
//   gameInit        full state snapshot (sent on join / reset / start)
//   physicsFrame    { coins:[{id,x,y}], striker:{x,y}|null }   (~30Hz during flick)
//   pocketEvent     { id, color, pocket:{x,y} }                (one per pocket)
//   turnResolved    full state snapshot + { strikerPocketed, pocketedThisTurn,
//                   continuedTurn, gameOver, winner }          (sent once per flick)
//   strikerSliderUpdate (relayed unchanged)
// ============================================================================

// express() returns ?
// createServer() creates an HTTP server, what is the nature of this server?
// Server() creates a socket.io server that listens on the HTTP server
// cors allows all origins *, and  allows GET and POST methods

const app = express();

// Allowed CORS origins, configurable via CORS_ORIGINS (comma-separated).
// Defaults keep the existing App Engine + local-dev origins working.
const CORS_ORIGINS = (
    process.env.CORS_ORIGINS ||
    "https://carrom-2222.el.r.appspot.com,http://localhost:3001"
)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

app.use(cors({ origin: CORS_ORIGINS, credentials: true }));

// Transport(s). Default WebSocket-only: no HTTP long-polling, which removes
// polling latency and the sticky-session requirement on Cloud Run, where
// long-polling otherwise clumps the 30Hz frame stream. (research §C2)
// NOTE: requires a WebSocket-capable host (Cloud Run / App Engine *flexible*).
// App Engine *standard* has no WebSocket support — there, set
// SOCKET_TRANSPORTS=polling,websocket as an escape hatch (with session affinity).
const SOCKET_TRANSPORTS = (process.env.SOCKET_TRANSPORTS || "websocket")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: { origin: CORS_ORIGINS, methods: ["GET", "POST"], credentials: true },
    transports: SOCKET_TRANSPORTS,
    // Resume a player's session + missed events across a refresh / brief drop
    // (research §C2). Works with the in-memory adapter (single instance).
    connectionStateRecovery: {
        maxDisconnectionDuration: 2 * 60 * 1000,
        skipMiddlewares: false,
    },
    // Built-in liveness. ~20s to detect a dead peer — replaces the old 5-minute
    // application heartbeat. Keep pingInterval+pingTimeout under any proxy
    // read-timeout.
    pingInterval: 10000,
    pingTimeout: 10000,
});

// PORT to listen on; `rooms` is a Map of active rooms (key: roomName).

const PORT = process.env.PORT || 3000;
const rooms = new Map();
// Active socket count per persistent clientId. A refresh briefly has two
// connections (old closing, new opening); this lets the disconnect handler
// avoid starting a grace teardown while another live connection for the same
// client exists — robust to connect/disconnect event ordering.
const liveConnections = new Map();
// Grace window: after a player disconnects, keep their room alive briefly so a
// refresh / transient network drop can reconnect and resume (research §C2).
// Tear the room down only if they don't return within the window.
const DISCONNECT_GRACE_MS = Number(process.env.DISCONNECT_GRACE_MS) || 30000;

// Find the room a persistent clientId belongs to. Returns [roomName, room, role]
// or null. A clientId is in at most one room.
function findRoomByClientId(clientId) {
    for (const [roomName, room] of rooms.entries()) {
        if (room.creator && room.creator.clientId === clientId) return [roomName, room, "creator"];
        if (room.joiner && room.joiner.clientId === clientId) return [roomName, room, "joiner"];
    }
    return null;
}

// Cancel a pending disconnect-grace teardown for a returning client.
function clearGraceTimer(room, clientId) {
    if (room && room.graceTimers && room.graceTimers[clientId]) {
        clearTimeout(room.graceTimers[clientId]);
        delete room.graceTimers[clientId];
    }
}

// this function takes a room name and a creator object,
// what is the nature of the creator object?
// the joiner is null
// client itds is a set of client ids, initialized with the creator's id
// the turn is intitially set to the creator
// debts for both is initially zero

function createRoom(roomName, creator) {
    return {
        creator,
        joiner: null,
        clientIds: new Set([creator.clientId]),
        // Server-authoritative game state. Initialized lazily when the second
        // player joins (see startGame()).
        game: null,
        // Holds the cancel handle of an in-flight flick simulation, if any.
        simCancel: null,
        // Pending disconnect-grace teardown timers, keyed by clientId.
        graceTimers: {},
        whoseTurn: "creator",
        scores: { creator: 0, joiner: 0 },
        debts: { creator: 0, joiner: 0 },
    };
}

// Initialize / reset the authoritative game state for a room and broadcast
// the initial snapshot so clients can render the starting position.
function startGame(roomName) {
    const room = rooms.get(roomName);
    if (!room) return;
    if (room.simCancel) { room.simCancel(); room.simCancel = null; }
    room.game = createInitialState();
    room.whoseTurn = room.game.whoseTurn;
    room.scores = room.game.scores;
    room.debts = room.game.debts;
    io.to(roomName).emit("gameInit", fullStateSnapshot(room.game));
}

// Mirror the auth game state's score/debt/turn back into the room object so
// the existing roomUpdate channel keeps Manager.js in sync without extra wiring.
function syncRoomFromGame(room) {
    if (!room.game) return;
    room.whoseTurn = room.game.whoseTurn;
    room.scores = { ...room.game.scores };
    room.debts = { ...room.game.debts };
}

function broadcastRoomUpdate(roomName) {
    const room = rooms.get(roomName);
    if (!room) return;
    io.to(roomName).emit("roomUpdate", {
        roomName,
        creator: room.creator
            ? {
                username: room.creator.username,
                score: room.scores.creator,
                debt: room.debts.creator,
            }
            : null,
        joiner: room.joiner
            ? {
                username: room.joiner.username,
                score: room.scores.joiner,
                debt: room.debts.joiner,
            }
            : null,
        whoseTurn: room.whoseTurn,
        scores: room.scores,
        debts: room.debts,
    });
}

// NOTE: room teardown is handled by explicit leaveRoom and by the
// disconnect-grace timer (see the disconnect handler). We must NOT delete rooms
// just because their socket.io room is momentarily empty — that would kill a
// game during the reconnect grace window.

// default route for server, backend
// intialize empty html string
// if rooms size is zero append a message to the html string saying there are no active rooms
// if rooms have a size greater than zero, then add a list to the html string,
// for eaech room in the rooms map, display the room's name, creator and joiner usernames
// rest is a simple HTML response that sends the final html string

app.get("/", (req, res) => {
    let html = "";
    if (rooms.size === 0) {
        html += "<p>No rooms currently active.</p>";
    } else {
        html += "<ul>";
        for (const [roomName, room] of rooms.entries()) {
            html += `<li>${roomName} - Creator: ${room.creator?.username || "N/A"}${room.joiner ? ", Joiner: " + room.joiner.username : ""}</li>`;
        }
        html += "</ul>";
    }
    res.send(html);
});

// Liveness is handled by Socket.IO's built-in ping/pong (configured above);
// dead peers surface as a `disconnect` event in ~20s. No custom heartbeat.

// listens for new client connections and handles their interactions
// io.on is the main event listener that waits for new players to connect
// the "connection" string is a predefined event name in socket.io,
// that automatically triggers when a new client connects to the server,
// socket parameter represents one sepcific player's connection channel,
// it contains a unique identifier for that player, 
// methods to communicate with that player (emit, on),
// connection info like socket.handshake.query.clientId,
// room membership abilities like join, leave
// sets a client id through the socket handshake query,

io.on("connection", (socket) => {
    const clientId = socket.handshake.query.clientId;

    if (!clientId || clientId === "null" || clientId === "undefined") {
        socket.emit("error", "Invalid client ID");
        socket.disconnect();
        return;
    }
    console.log(
        "Client connected:", socket.id, "clientId:", clientId,
        socket.recovered ? "(recovered)" : "",
    );
    liveConnections.set(clientId, (liveConnections.get(clientId) || 0) + 1);

    // Add error handling for socket events
    socket.on("error", (error) => {
        console.error("Socket error:", error);
    });

    // If this client already belongs to a room, they're (re)connecting after a
    // refresh / drop: cancel any pending grace teardown and re-join the
    // socket.io room so broadcasts reach them immediately. The client also
    // re-syncs explicitly via rejoinRoom -> requestRoomData.
    const reconnecting = findRoomByClientId(clientId);
    if (reconnecting) {
        const [reRoomName, reRoom] = reconnecting;
        clearGraceTimer(reRoom, clientId);
        socket.join(reRoomName);
    }

    // ! can the error handling be removed?
    // listen for a checkRoomAccess event, which checks if a player can access a room
    // it has parameters, room name and the incoming client id
    // if the incoming clientId is invalid, emit an error and return
    // if the room name is not found in the rooms map, emit an error and return
    // get the room from the rooms map that has the room name,
    // if the room's clientIds set has 2 or more unique client ids and,
    // if the incoming clientId is not in that set,
    // emit an error that the room is full and return
    // else, join the room using socket.join,
    // emit an accessGranted event to the client
    // how does the socket emit work, who is it emitting that access granted to?

    socket.on("checkRoomAccess", ({ roomName, clientId: incomingClientId }) => {
        if (
            !incomingClientId ||
            incomingClientId === "null" ||
            incomingClientId === "undefined"
        ) {
            socket.emit("error", "Invalid client ID");
            return;
        }
        if (!rooms.has(roomName)) {
            socket.emit("error", "Room does not exist");
            return;
        }
        const room = rooms.get(roomName);
        if (room.clientIds.size >= 2 && !room.clientIds.has(incomingClientId)) {
            socket.emit("error", "Room is full");
            return;
        }
        socket.join(roomName);
        socket.emit("accessGranted");
    });
    
    // ! can the error handling be removed?
    // rejoin room is to rejoin an existing room aftger a disconnection
    // takes room name, username, incoming client id and player role as parameters
    // if the incoming clientId is invalid, emit an error and return
    // if the room name is not found in the rooms map, emit an error and return
    // get the room from the rooms map that has the room name,
    // if the player role is creator and the room's creator is set and the id matches the incoming clientId,
    // join the room using socket.join, emit an accessGranted event
    // else if the player role is joiner and the room's joiner is set and the id matches the incoming clientId,
    // join the room using socket.join, emit an accessGranted event
    // else, emit an error, saying that the session or role is invalid

    socket.on("rejoinRoom", ({ roomName, username, clientId: incomingClientId, playerRole }) => {
        if (
            !incomingClientId ||
            incomingClientId === "null" ||
            incomingClientId === "undefined"
        ) {
            socket.emit("error", "Invalid client ID");
            return;
        }
        if (!rooms.has(roomName)) {
            socket.emit("error", "Room does not exist");
            return;
        }
        const room = rooms.get(roomName);
        if (
            playerRole === "creator" &&
            room.creator &&
            room.creator.clientId === incomingClientId
        ) {
            clearGraceTimer(room, incomingClientId);
            socket.join(roomName);
            socket.emit("accessGranted");
        } else if (
            playerRole === "joiner" &&
            room.joiner &&
            room.joiner.clientId === incomingClientId
        ) {
            clearGraceTimer(room, incomingClientId);
            socket.join(roomName);
            socket.emit("accessGranted");
        } else {
            socket.emit("error", "Invalid session or role");
        }
    });

    // creates room... takes room name, username, and incoming client id as parameters
    // if incoming clientId is invalid, emit an error and return
    // if the room name already exists in the rooms map, emit an error and return
    // create a new room object with the creator's username and client id,
    // set the joiner to null, initialize clientIds with the incoming clientId,
    // set whoseTurn to "creator",
    // join the room using socket.join,
    // emit a playerJoined event to the client with username and room name,
    // emit a roomUpdate event to the client with room name, creator's username, no joiner, and whoseTurn set to "creator"

    socket.on("createRoom", ({ roomName, username, clientId: incomingClientId }) => {
        if (
            !incomingClientId ||
            incomingClientId === "null" ||
            incomingClientId === "undefined"
        ) {
            socket.emit("error", "Invalid client ID");
            return;
        }
        if (rooms.has(roomName)) {
            socket.emit("error", "Room already exists");
            return;
        }
        rooms.set(
            roomName,
            createRoom(roomName, { username, clientId: incomingClientId }),
        );

        socket.join(roomName);
        socket.emit("playerJoined", { username, roomName });
        socket.emit("roomUpdate", {
            roomName,
            creator: { username },
            joiner: null,
            whoseTurn: "creator",
        });
    });

    // join room, takes room name, username, and incoming client id as parameters
    // whose username ?
    // if incoming clientId is invalid, emit an error and return
    // if the room name does not exist in the rooms map, emit an error and return
    // get the room from the rooms map that has the room name,
    // if the incoming clientId is already in the room's clientIds set, emit an error and return
    // if the room's clientIds set has 2 or more unique client ids, emit an error that the room is full and return
    // if the room's joiner is already set, emit an error that the room is full and return,
    // why check if specifically joiner is already in if we are checking if 2 or more are already in the room? 
    // set the room's joiner to an object with the username and incoming clientId,
    // add the incoming clientId to the room's clientIds set,
    // join the room using socket.join, emit a playerJoined event to the client with username and room name,
    // io to means emit to all clients in the room,
    // emit a roomUpdate event to all clients in the room with,
    // the room name, creator's username, joiner's username, and whoseTurn set to "creator" or "joiner",
    // based on the current state of the room

    socket.on("joinRoom", ({ roomName, username, clientId: incomingClientId }) => {
        if (
            !incomingClientId ||
            incomingClientId === "null" ||
            incomingClientId === "undefined"
        ) {
            socket.emit("error", "Invalid client ID");
            return;
        }
        if (!rooms.has(roomName)) {
            socket.emit("error", "Room does not exist");
            return;
        }
        const room = rooms.get(roomName);
        if (room.clientIds.has(incomingClientId)) {
            socket.emit("error", "Client already in room");
            return;
        }
        if (room.clientIds.size >= 2) {
            socket.emit("error", "Room is full");
            return;
        }
        if (room.joiner) {
            socket.emit("error", "Room is full");
            return;
        }

        room.joiner = { username, clientId: incomingClientId };
        room.clientIds.add(incomingClientId);
        socket.join(roomName);
        socket.emit("playerJoined", { username, roomName });

        // Both players present — (re)initialize authoritative game state.
        startGame(roomName);
        broadcastRoomUpdate(roomName);
    });

    // listen for a event sent by clients, with a room name
    // if the room name exists in the rooms map, get the room object
    // send an event to the clients called a room update
    // with the room name, the creator as the creator's username in the room object,
    // the joiner as the joiner's username in the room object,
    // and whose turn it is from the room object
    // if the room does not exist, emit an error that the room does not exist

    socket.on("requestRoomData", ({ roomName }) => {
        if (!rooms.has(roomName)) {
            socket.emit("error", "Room does not exist");
            return;
        }
        const room = rooms.get(roomName);
        socket.emit("roomUpdate", {
            roomName,
            creator: room.creator
                ? {
                    username: room.creator.username,
                    score: room.scores.creator,
                    debt: room.debts.creator,
                }
                : null,
            joiner: room.joiner
                ? {
                    username: room.joiner.username,
                    score: room.scores.joiner,
                    debt: room.debts.joiner,
                }
                : null,
            whoseTurn: room.whoseTurn,
            scores: room.scores,
            debts: room.debts,
        });
        // If a game is already in progress (e.g. the requester is reconnecting
        // or a late-joining spectator), push the current snapshot.
        if (room.game) {
            socket.emit("gameInit", fullStateSnapshot(room.game));
        }
    });

    // NOTE: switchTurn / continueTurn handlers removed.
    // Turn transitions are decided server-side in physics.resolveTurn() and
    // broadcast via the turnResolved event.

    // Explicit leave (EXIT button). A 2-player match can't continue with one
    // player, so leaving ends the room for both: cancel any in-flight sim, tell
    // the opponent, and delete the room. (The leaver navigates away client-side.)
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
    
    // On disconnect we do NOT tear the room down immediately. The player may be
    // refreshing or briefly dropping; start a grace timer keyed on their
    // persistent clientId (NOT socket.id, which changes per connection). If they
    // reconnect within the window, the connection handler / rejoinRoom cancels
    // the timer. Otherwise the room is closed and the opponent notified.
    socket.on("disconnect", () => {
        // Decrement this client's live-connection count. If another connection
        // for the same clientId is still up (e.g. a refresh that already
        // reconnected), do nothing — the player is present.
        const remaining = (liveConnections.get(clientId) || 1) - 1;
        if (remaining <= 0) liveConnections.delete(clientId);
        else liveConnections.set(clientId, remaining);

        const found = findRoomByClientId(clientId);
        if (!found) return;
        const [roomName, room] = found;
        if (remaining > 0) return;               // still connected elsewhere
        if (room.graceTimers[clientId]) return;  // teardown already pending

        room.graceTimers[clientId] = setTimeout(() => {
            const r = rooms.get(roomName);
            if (!r) return;
            if (r.simCancel) { r.simCancel(); r.simCancel = null; }
            io.to(roomName).emit("roomClosed", "Opponent left the room");
            rooms.delete(roomName);
        }, DISCONNECT_GRACE_MS);
    });

    // ========================================================================
    // GAMEPLAY EVENTS (Phase 1: server-authoritative physics)
    // ========================================================================

    // Striker slider preview \u2014 placement-only, broadcast to peer for live sync.
    // The authoritative strikerX is whatever the flicker sends in their `flick`.
    socket.on("strikerSliderUpdate", ({ roomName, playerRole, sliderValue, strikerX }) => {
        if (!rooms.has(roomName)) {
            socket.emit("error", "Room does not exist");
            return;
        }
        socket.to(roomName).emit("strikerSliderUpdate", {
            roomName, playerRole, sliderValue, strikerX,
        });
    });

    // Flick: client sends placement + angle + force. Server runs the simulation
    // and streams frames + per-pocket events + a final turnResolved.
    socket.on("flick", ({ roomName, strikerX, angle, force }) => {
        const room = rooms.get(roomName);
        if (!room) {
            socket.emit("error", "Room does not exist");
            return;
        }
        if (!room.game) {
            socket.emit("error", "Game has not started");
            return;
        }
        if (room.simCancel) return;

        // Determine actor role from sender's persistent clientId (handshake
        // query), NOT socket.id — socket.id changes on reconnect.
        let actor = null;
        if (room.creator && room.creator.clientId === clientId) actor = "creator";
        else if (room.joiner && room.joiner.clientId === clientId) actor = "joiner";
        if (!actor) {
            socket.emit("error", "You are not in this room");
            return;
        }
        if (actor !== room.game.whoseTurn) {
            socket.emit("error", "Not your turn");
            return;
        }

        room.simCancel = startFlickSimulation(
            room.game,
            { strikerX, angle, force },
            actor,
            {
                onFrame: (snap) => io.to(roomName).emit("physicsFrame", snap),
                onPocket: (p) => io.to(roomName).emit("pocketEvent", p),
                onDone: (resolution, fullState) => {
                    room.simCancel = null;
                    syncRoomFromGame(room);
                    io.to(roomName).emit("turnResolved", {
                        ...resolution,
                        state: fullState,
                    });
                    broadcastRoomUpdate(roomName);
                },
            },
        );
    });

    // Reset request \u2014 wipe game state and re-deal.
    socket.on("gameReset", ({ roomName }) => {
        if (!rooms.has(roomName)) {
            socket.emit("error", "Room does not exist");
            return;
        }
        startGame(roomName);
        broadcastRoomUpdate(roomName);
    });
});

// start server

httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
