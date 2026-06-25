// Bootstrap: HTTP + Socket.IO server wiring. The room data layer lives in
// rooms.js, io-dependent orchestration in gameService.js, and all per-connection
// event handlers in socketHandlers.js.
//
// ============================================================================
// SOCKET EVENT CONTRACT (server-authoritative physics)
// ----------------------------------------------------------------------------
// Room lifecycle (client -> server):
//   createRoom, joinRoom, rejoinRoom, leaveRoom, checkRoomAccess, requestRoomData
//   (liveness is Socket.IO's built-in ping/pong; no app-level heartbeat)
// Room lifecycle (server -> client):
//   playerJoined, roomUpdate, roomClosed, accessGranted, error
//
// Gameplay (client -> server):
//   flick               { roomName, strikerX, angle, force }  (angle rad, force 0..1)
//   strikerSliderUpdate { roomName, playerRole, sliderValue, strikerX }  (relayed)
//   gameReset           { roomName }
// Gameplay (server -> client):
//   gameInit      full state snapshot (join / reset / start / reconnect)
//   physicsFrame  { t, coins:[{id,x,y}], striker:{x,y}|null }  (~30Hz, delta-encoded)
//   pocketEvent   { kind, id?, color?, pocket:{x,y}, from? }   (one per pocket)
//   turnResolved  full snapshot + { strikerPocketed, pocketedThisTurn, continuedTurn, gameOver, winner }
//   strikerSliderUpdate (relayed unchanged)
// ============================================================================

import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import { rooms } from "./rooms.js";
import { createGameService } from "./gameService.js";
import { registerHandlers } from "./socketHandlers.js";

const app = express();

// Allowed CORS origins, configurable via CORS_ORIGINS (comma-separated).
const CORS_ORIGINS = (
    process.env.CORS_ORIGINS || "https://carrom-2222.el.r.appspot.com,http://localhost:3001"
)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

app.use(cors({ origin: CORS_ORIGINS, credentials: true }));

// Transport(s). Default WebSocket-only: no HTTP long-polling (removes polling
// latency + the sticky-session requirement on Cloud Run). Requires a
// WebSocket-capable host (Cloud Run / App Engine *flexible*). On App Engine
// *standard* set SOCKET_TRANSPORTS=polling,websocket (with session affinity).
const SOCKET_TRANSPORTS = (process.env.SOCKET_TRANSPORTS || "websocket")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: { origin: CORS_ORIGINS, methods: ["GET", "POST"], credentials: true },
    transports: SOCKET_TRANSPORTS,
    // Resume a player's session + missed events across a refresh / brief drop.
    connectionStateRecovery: { maxDisconnectionDuration: 2 * 60 * 1000, skipMiddlewares: false },
    // Built-in liveness (~20s to detect a dead peer). Keep under any proxy read-timeout.
    pingInterval: 10000,
    pingTimeout: 10000,
});

const PORT = process.env.PORT || 3000;

// Status page: list active rooms.
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

const service = createGameService(io);
io.on("connection", (socket) => registerHandlers(io, socket, service));

httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
