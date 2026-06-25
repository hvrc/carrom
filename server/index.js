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
//   requestRoomData, heartbeat, disconnect
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
});

// port for the server to listen on
// rooms is a Map to store active rooms, map stores key-value pairs
// lastHeartbeat is a Map to track the last heartbeat time for each client
// 5 minutes heartbeat timeout (client sends every 5 minutes)

const PORT = process.env.PORT || 3000;
const rooms = new Map();
const lastHeartbeat = new Map();
const heartbeatTimeout = 5 * 60 * 1000;

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

// for each room, get the room sockets from the io.sockets.adapter.rooms,
// if the room sockets are undefined or if the room sockets size is zero,
// delete that room from the rooms map

function cleanupEmptyRooms() {
    for (const [roomName, room] of rooms.entries()) {
        const roomSockets = io.sockets.adapter.rooms.get(roomName);
        if (!roomSockets || roomSockets.size === 0) {
            rooms.delete(roomName);
        }
    }
}

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

// this section does the following every 5 seconds:
// it promotes the joiner to creator if the creator has left,
// deletes the room if both creator and joiner have left

// !
// joiner does not need to become creator,
// 10 seconds is too short
// smoother swapping of clients

// get the current date (and time?),
// for each time stamp and client id in the map of heartbeats,
// if the time difference between now and the last heartbeat is greater than the heartbeat timeout,
// iterate through each room in the rooms map,

setInterval(() => {
    const now = Date.now();
    lastHeartbeat.forEach((lastTime, clientId) => {
        if (now - lastTime > heartbeatTimeout) {
            rooms.forEach((room, roomName) => {
                // if either the creator or joiner leaves, delete the room and notify all players
                if (room.creator && room.creator.clientId === clientId) {
                    io.to(roomName).emit("roomClosed", "Creator has left the room");
                    rooms.delete(roomName);
                } else if (room.joiner && room.joiner.clientId === clientId) {
                    io.to(roomName).emit("roomClosed", "Player has left the room");
                    rooms.delete(roomName);
                }
            });

            // delete the client id from the lastHeartbeat map
            lastHeartbeat.delete(clientId);
        }
    });

// every 5 seconds
}, 5000);

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
    console.log("New client connected:", socket.id);
    
    const clientId = socket.handshake.query.clientId;
    console.log("Client ID:", clientId);

    if (!clientId || clientId === "null" || clientId === "undefined") {
        console.error("Invalid client ID:", clientId);
        socket.emit("error", "Invalid client ID");
        socket.disconnect();
        return;
    }

    // Add error handling for socket events
    socket.on("error", (error) => {
        console.error("Socket error:", error);
    });

    // add to the lastHeartbeat map with the current time and clientId
    // listen for heartbeat events from the client,
    // if the incoming clientId matches the one stored in lastHeartbeat,
    // update the last heartbeat time for that clientId, to the current time

    lastHeartbeat.set(clientId, Date.now());
    socket.on("heartbeat", ({ clientId: incomingClientId }) => {
        if (incomingClientId === clientId) {
            lastHeartbeat.set(clientId, Date.now());
        }
    });

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
            socket.join(roomName);
            socket.emit("accessGranted");
        } else if (
            playerRole === "joiner" &&
            room.joiner &&
            room.joiner.clientId === incomingClientId
        ) {
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

    // listen for a leave room event ent by clients,
    // it sends the room name and the incoming client id
    // if rooms map has the received room name, get the room object from the map

    // if the room's creator is set and the incoming client id matches the creator's client id,
    // WHICH MEANS IT WAS THE CREATOR WHO SENT THE LEAVE ROOM EVENT TO THE CLIENT
    // if the room's joiner is set, set the room creator's username and client id to that of the joiner
    // set the room joiner to null, remove the incoming client id from the room's client ids set,
    // set whose turn to "creator",
    // send an event to all clients called room update,
    // with room name, the creator as the new creator, the joiner as null,
    // and whose turn, which was set to "creator"
    // if the room's joiner is not set, delete the room from the rooms map,
    // send an event to all clients in the room called room closed
    
    // else if the room joiner is set and the incoming client id matches the joiner's client id,
    // WHICH MEANS IT WAS THE JOINER THAT LEFT THE ROOM
    // set the joiner to null
    // remove the incoming client id from the room's client ids set,
    // send an event to all clients called room update,
    // with room name, the creator as the creator's username in the room object,
    // the joiner as null, and whose turn, which was set to "creator"

    // delete the incoming client id from the lastHeartbeat map,
    // clear rooms that are empty from the rooms map

    socket.on("leaveRoom", ({ roomName, clientId: incomingClientId }) => {
        // if (!incomingClientId || incomingClientId === "null" || incomingClientId === "undefined") {
        //     socket.emit("error", "Invalid client ID");
        //     return;
        // }

        if (rooms.has(roomName)) {
            const room = rooms.get(roomName);

            if (room.creator && room.creator.clientId === incomingClientId) {
                if (room.joiner) {

                    room.creator = {
                        username: room.joiner.username,
                        clientId: room.joiner.clientId,
                    };

                    room.joiner = null;
                    room.clientIds.delete(incomingClientId);
                    room.whoseTurn = "creator";

                    io.to(roomName).emit("roomUpdate", {
                        roomName,
                        creator: { username: room.creator.username },
                        joiner: null,
                        whoseTurn: room.whoseTurn,
                    });
                    
                } else {
                    rooms.delete(roomName);
                    io.to(roomName).emit("roomClosed", "Creator has left the room");
                }

            } else if ( room.joiner && room.joiner.clientId === incomingClientId ) {
                room.joiner = null;
                room.clientIds.delete(incomingClientId);
                room.whoseTurn = "creator";

                io.to(roomName).emit("roomUpdate", {
                    roomName,
                    creator: { username: room.creator.username },
                    joiner: null,
                    whoseTurn: room.whoseTurn,
                });

            }

            lastHeartbeat.delete(incomingClientId);
            cleanupEmptyRooms();
        }
    });
    
    // listen for a disconnect event sent by the clients or is the socket, if it is, what's the difference?
    // loop through each room in the rooms map,
    // if the room's creator is set and the creator's client id matches the incoming socket id, or
    // if the room's joiner is set and the joiner's client id matches the incoming socket id,
    // send a room closed event to the respecitve room, and delete the room from the map of rooms
    // delete the incoming socket id from the last heart beat map
    // remove empty rooms from the rooms map

    socket.on("disconnect", () => {
        rooms.forEach((room, roomName) => {

            if (room.creator && room.creator.clientId === socket.id) {
                io.to(roomName).emit("roomClosed", "Creator has left the room");
                rooms.delete(roomName);

            } else if (room.joiner && room.joiner.clientId === socket.id) {
                io.to(roomName).emit("roomClosed", "Player has left the room");
                rooms.delete(roomName);
            }
        });
        
        lastHeartbeat.delete(socket.id);
        cleanupEmptyRooms();
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
