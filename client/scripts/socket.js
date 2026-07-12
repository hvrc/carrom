import { io } from "socket.io-client";

// The player's identity, stable for as long as the browser profile keeps its
// storage.
//
// This used to live in sessionStorage, which is scoped to ONE TAB. Opening the
// game in a second tab minted a brand-new clientId, so the server saw a
// different human and cheerfully seated them opposite themselves — the reported
// "harsh vs harsh" bug. localStorage is shared across tabs of the same profile,
// so a second tab is now recognised as the same player and is sent back to the
// seat it already holds.
//
// Note this does NOT break testing against yourself: a normal window and an
// incognito window have separate localStorage partitions (as do two different
// browsers), so they remain two distinct players.
const CLIENT_ID_KEY = "clientId";

export const getClientId = () => {
    let clientId = localStorage.getItem(CLIENT_ID_KEY);
    if (!clientId) {
        // One-time migration: adopt the tab's old sessionStorage id if it has one,
        // so a player mid-game when this shipped keeps their seat.
        clientId = sessionStorage.getItem(CLIENT_ID_KEY);
    }
    if (!clientId) {
        clientId = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(
            /[xy]/g,
            (c) => {
                const r = (Math.random() * 16) | 0;
                return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
            },
        );
    }
    localStorage.setItem(CLIENT_ID_KEY, clientId);
    return clientId;
};

const generateClientId = getClientId;

// Leaving a room clears the player's *session* (which room, which seat, what
// name) — but NOT their identity. The old code called localStorage.clear(),
// which was harmless when the clientId lived in sessionStorage; now it would
// wipe the identity on every exit, mint a new one on the way back in, and
// resurrect exactly the duplicate-seat bug this change exists to kill.
export const clearSession = () => {
    for (const key of ["username", "roomName", "playerRole"]) {
        localStorage.removeItem(key);
    }
};

// socket.io client... connects to server with client id attached
// io() returns a socket connection object, that has methods like:
// emit() to send messages to the server, on()/off() to listen for/stop listening to messages from the server,
// socket is an instance of the socket.io client, which is used to communicate with the server
// takes the server URL, which is localhost for development
// we dont want it to connect automatically,
// we want reconnections to be enabled, 5 attempts with a 1 second delay
// and we want to pass the client id as a query parameter
// Server URL resolution, in priority order:
//   1. window.RUNTIME_CONFIG.serverUrl — injected at container start from the
//      Cloud Run SERVER_URL env var (see client/public/config.js + entrypoint).
//      Lets one built image be repointed at deploy time without a rebuild.
//   2. VITE_SERVER_URL — build-time override.
//   3. Fallback: the live Cloud Run server in prod, localhost in dev. On Cloud
//      Run (1) always wins, so this only matters for a static host that never
//      runs the entrypoint.
const runtimeServerUrl =
    (typeof window !== "undefined" && window.RUNTIME_CONFIG && window.RUNTIME_CONFIG.serverUrl) || "";
const SERVER_URL =
    runtimeServerUrl ||
    import.meta.env.VITE_SERVER_URL ||
    (import.meta.env.PROD
        ? "https://carrom-server-23xhui47pq-uc.a.run.app"
        : "http://localhost:3000");

// Transport(s) — default WebSocket-only to match the server. Override with
// VITE_SOCKET_TRANSPORTS=polling,websocket only if deploying to a host without
// native WebSocket support (e.g. App Engine standard).
const SOCKET_TRANSPORTS = (import.meta.env.VITE_SOCKET_TRANSPORTS || "websocket")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const socket = io(SERVER_URL, {
    autoConnect: false,
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
    transports: SOCKET_TRANSPORTS,
    query: { clientId: generateClientId() },
});

// Liveness is handled by Socket.IO's built-in ping/pong (server pingInterval/
// pingTimeout) — no custom application heartbeat.

socket.on("connect_error", (error) => {
    console.error("Connect error:", error);
});

// On socket.io auto-reconnect (transient drop, no page reload), re-establish
// room membership via rejoinRoom — which resumes the existing game WITHOUT
// re-dealing. (The old code emitted createRoom/joinRoom, which errored and
// ejected the player.) A page refresh goes through Room.jsx's own rejoinRoom.
socket.on("reconnect", () => {
    const username = localStorage.getItem("username");
    const roomName = localStorage.getItem("roomName");
    const playerRole = localStorage.getItem("playerRole");
    const clientId = getClientId();
    if (username && roomName && playerRole && clientId) {
        socket.emit("rejoinRoom", { roomName, username, clientId, playerRole });
    }
});

socket.on("reconnect_error", (error) => {
    console.error("Reconnect error:", error);
});

socket.on("disconnect", (reason) => {
    console.log("Socket disconnected:", reason);
});

// Dev-only debugging handle (stripped from production builds by Vite).
if (import.meta.env.DEV) {
    window.__socket = socket;
}

// export the socket instance so it can be used in other components and files
// menu, room, board, events
export default socket;