import { io } from "socket.io-client";

// generate or reuse a unique client id for each browser session, which is each client
// sessuib storage is a built in browser feature that stores data for as long as the given tab is open
// get the browser/client id from the session storage
// if there is no client id set, generate a new one, using a UUID-like format
// set it in the session storage
// return the client id
const generateClientId = () => {
    let clientId = sessionStorage.getItem("clientId");
    if (!clientId) {
        clientId = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(
            /[xy]/g,
            (c) => {
                const r = (Math.random() * 16) | 0;
                return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
            },
        );
        sessionStorage.setItem("clientId", clientId);
    }
    return clientId;
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
//   3. prod App Engine backend / local dev fallback.
const runtimeServerUrl =
    (typeof window !== "undefined" && window.RUNTIME_CONFIG && window.RUNTIME_CONFIG.serverUrl) || "";
const SERVER_URL =
    runtimeServerUrl ||
    import.meta.env.VITE_SERVER_URL ||
    (import.meta.env.PROD
        ? "https://backend-dot-carrom-2222.el.r.appspot.com"
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
    const clientId = sessionStorage.getItem("clientId");
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