// Runtime configuration. This default ships empty; the Cloud Run container's
// entrypoint overwrites it at startup with the SERVER_URL env var. When empty
// (local dev / static hosting), socket.js falls back to VITE_SERVER_URL or
// localhost. Keeping this here also avoids a 404 in dev.
window.RUNTIME_CONFIG = { serverUrl: "" };
