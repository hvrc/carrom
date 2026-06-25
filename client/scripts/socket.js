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
// Server URL: VITE_SERVER_URL overrides; otherwise prod backend / local dev.
const SERVER_URL =
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

// start heartbeat
// get client id from session storage
// if client id exists and heartbeat interval is not set,
// send an heartbeart emit to the server with the client id,
// every 5 minutes
let heartbeatInterval;
const startHeartbeat = () => {
    const clientId = sessionStorage.getItem("clientId");
    if (clientId && !heartbeatInterval) {
        heartbeatInterval = setInterval(() => {
            socket.emit("heartbeat", { clientId });
        }, 5 * 60 * 1000);
    }
};

// stop heartbeat on disconnect
// if heartbeatInterval is set,
// clear it and set it to null
const stopHeartbeat = () => {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
        console.log("Stopped heartbeat");
    }
};

// listen for connect, when it does, start the heartbeat
socket.on("connect", () => {
    // console.log( "Socket connected with clientId:", sessionStorage.getItem("clientId"));
    startHeartbeat();
});

// listen for a connect errior event, it will come with a error object?/message,
// stop the heartbeat
socket.on("connect_error", (error) => {
    console.error("Connect error:", error);
    stopHeartbeat();
});

// reconnect to the server if the connection is lost
// listen for a reconnect evernt, it comes with an attempt count,
// local storage is a built in browser feature that stores data on the user's device in special browser folders
// set username, room name, player role, client id from local storage
// if username, room name and client id have values,
// if player is a creator, emit a createRoom event with room name, username and client id
// else if player is a joiner, emit a joinRoom event with room name, username and client id
// start the heartbeat again
socket.on("reconnect", (attempt) => {
    const username = localStorage.getItem("username");
    const roomName = localStorage.getItem("roomName");
    const playerRole = localStorage.getItem("playerRole");
    const clientId = sessionStorage.getItem("clientId");
    if (username && roomName && clientId) {
        if (playerRole === "creator") {
            socket.emit("createRoom", { roomName, username, clientId });
        } else if (playerRole === "joiner") {
            socket.emit("joinRoom", { roomName, username, clientId });
        }
    }
    startHeartbeat();
});

// similar to the error event,
// listen for a reconnect error event,
// it will come with an error object/message,
// stop heartbeat
socket.on("reconnect_error", (error) => {
    console.error("Reconnect error:", error);
    stopHeartbeat();
});

// disconnect from the server
// listen for a disconnect event, it will come with a reason,
// stop the heartbeat
socket.on("disconnect", (reason) => {
    console.log("Socket disconnected:", reason);
    stopHeartbeat();
});

// export the socket instance so it can be used in other components and files
// menu, room, board, events
export default socket;