// Socket event-contract parity. Statically scans the server and client for
// emit/on event names and asserts they line up — so a dead client listener
// (no server emitter) or an unhandled client emit can't silently drift back in.
//   cd client && npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(dir, "..", "..");

const read = (p) => readFileSync(path.join(ROOT, p), "utf8");
const clientFiles = readdirSync(path.join(ROOT, "client/scripts"))
    .filter((f) => /\.(js|jsx)$/.test(f))
    .map((f) => read(path.join("client/scripts", f)))
    .join("\n");
const serverSrc = read("server/index.js");

// Socket.IO / Engine.IO built-in events that have no app-level counterpart.
const BUILTIN = new Set([
    "connect", "connecting", "disconnect", "disconnecting", "connect_error",
    "reconnect", "reconnect_error", "reconnect_attempt", "reconnecting",
    "reconnect_failed", "connection", "ping", "pong", "newListener", "removeListener",
]);

const names = (src, method) => {
    const re = new RegExp(`\\.${method}\\(\\s*["'\`]([a-zA-Z]+)["'\`]`, "g");
    const out = new Set();
    let m;
    while ((m = re.exec(src))) if (!BUILTIN.has(m[1])) out.add(m[1]);
    return out;
};

const clientListens = names(clientFiles, "on");
const clientEmits = names(clientFiles, "emit");
const serverEmits = names(serverSrc, "emit");
const serverListens = names(serverSrc, "on");

test("every client listener has a server emitter (no dead listeners)", () => {
    const orphan = [...clientListens].filter((e) => !serverEmits.has(e));
    assert.deepEqual(orphan, [], `client listens for events the server never emits: ${orphan}`);
});

test("every client emit is handled by the server (no dropped emits)", () => {
    const orphan = [...clientEmits].filter((e) => !serverListens.has(e));
    assert.deepEqual(orphan, [], `client emits events the server doesn't handle: ${orphan}`);
});

test("retired dead events are absent from the client", () => {
    const dead = ["scoreUpdate", "debtUpdate", "debtScoreUpdate", "debtPaid", "strikerCollisionUpdate"];
    for (const e of dead) {
        assert.ok(!clientFiles.includes(`"${e}"`) && !clientFiles.includes(`'${e}'`), `dead event still referenced: ${e}`);
    }
});
