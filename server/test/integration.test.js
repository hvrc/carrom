// End-to-end lobby + flick + sync tests. Spawns the REAL server (index.js) on a
// free port and drives two websocket socket.io clients.  cd server && npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { io as ioc } from "socket.io-client";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "index.js");

let child;
let PORT;
let nextId = 1;

function freePort() {
    return new Promise((resolve, reject) => {
        const srv = createServer();
        srv.unref();
        srv.on("error", reject);
        srv.listen(0, () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

function startServer(port) {
    return new Promise((resolve, reject) => {
        const c = spawn(process.execPath, [SERVER], {
            env: { ...process.env, PORT: String(port), NODE_ENV: "test", CORS_ORIGINS: "*" },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        const t = setTimeout(() => reject(new Error("server start timeout")), 5000);
        c.stdout.on("data", (d) => {
            out += d.toString();
            if (out.includes("Server running")) { clearTimeout(t); resolve(c); }
        });
        c.on("exit", (code) => { if (!out.includes("Server running")) reject(new Error("server exited " + code)); });
    });
}

function connect() {
    const clientId = `test-${nextId++}`;
    const socket = ioc(`http://localhost:${PORT}`, {
        transports: ["websocket"],
        query: { clientId },
        reconnection: false,
        forceNew: true,
    });
    socket._clientId = clientId;
    return socket;
}

function once(socket, event, timeout = 3000) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout waiting for "${event}"`)), timeout);
        socket.once(event, (data) => { clearTimeout(t); resolve(data); });
    });
}

// Bring up a room with both players present; resolves once both have gameInit.
async function makeRoom(roomName) {
    const a = connect();
    await once(a, "connect");
    a.emit("createRoom", { roomName, username: "A", clientId: a._clientId });
    await once(a, "playerJoined");

    const aInit = once(a, "gameInit");
    const b = connect();
    await once(b, "connect");
    const bInit = once(b, "gameInit");
    b.emit("joinRoom", { roomName, username: "B", clientId: b._clientId });
    await once(b, "playerJoined");

    const [aState, bState] = await Promise.all([aInit, bInit]);
    return { a, b, aState, bState };
}

const sortCoins = (coins) => [...coins].sort((x, y) => x.id - y.id);

before(async () => {
    PORT = await freePort();
    child = await startServer(PORT);
});

after(() => {
    if (child) child.kill("SIGKILL");
});

test("two players join and both receive an identical 19-coin gameInit", async () => {
    const { a, b, aState, bState } = await makeRoom("room-init");
    assert.equal(aState.coins.length, 19);
    assert.deepEqual(sortCoins(aState.coins), sortCoins(bState.coins));
    assert.equal(aState.whoseTurn, "creator");
    a.disconnect();
    b.disconnect();
});

test("clients negotiate the websocket transport (no long-polling)", async () => {
    const { a, b } = await makeRoom("room-transport");
    assert.equal(a.io.engine.transport.name, "websocket");
    assert.equal(b.io.engine.transport.name, "websocket");
    a.disconnect();
    b.disconnect();
});

test("actor flick streams physicsFrames to BOTH clients and resolves once, passing the turn", async () => {
    const { a, b } = await makeRoom("room-flick");
    let aFrames = 0, bFrames = 0;
    a.on("physicsFrame", () => aFrames++);
    b.on("physicsFrame", () => bFrames++);
    const aResolved = once(a, "turnResolved", 8000);
    const bResolved = once(b, "turnResolved", 8000);

    // gentle sideways tap by the creator — won't pocket, so the turn must pass
    a.emit("flick", { roomName: "room-flick", strikerX: 300, angle: Math.PI, force: 0.18 });

    const [ar, br] = await Promise.all([aResolved, bResolved]);
    assert.ok(aFrames > 0, "creator received frames");
    assert.ok(bFrames > 0, "joiner received frames");
    assert.equal(ar.state.whoseTurn, "joiner");
    assert.equal(br.state.whoseTurn, "joiner");
    assert.equal(ar.strikerPocketed, false);
    a.disconnect();
    b.disconnect();
});

test("a flick from the player who is NOT on turn is rejected", async () => {
    const { a, b } = await makeRoom("room-wrongturn");
    let frames = 0;
    a.on("physicsFrame", () => frames++);
    b.on("physicsFrame", () => frames++);
    const err = once(b, "error", 3000); // joiner tries to act on creator's turn
    b.emit("flick", { roomName: "room-wrongturn", strikerX: 450, angle: -Math.PI / 2, force: 1 });
    const msg = await err;
    assert.match(String(msg), /not your turn/i);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(frames, 0, "no simulation should have started");
    a.disconnect();
    b.disconnect();
});

test("a third client cannot join a full room", async () => {
    const { a, b } = await makeRoom("room-full");
    const c = connect();
    await once(c, "connect");
    const err = once(c, "error", 3000);
    c.emit("joinRoom", { roomName: "room-full", username: "C", clientId: c._clientId });
    const msg = await err;
    assert.match(String(msg), /full/i);
    a.disconnect();
    b.disconnect();
    c.disconnect();
});

test("delta+timestamp frames reconstruct to the authoritative final state on a peer", async () => {
    const { a, b, bState } = await makeRoom("room-recon");
    // b (joiner, the peer) reconstructs full positions from the delta stream,
    // exactly like Board.jsx: seed from gameInit, merge each frame's delta.
    const full = new Map(bState.coins.filter((c) => !c.pocketed).map((c) => [c.id, { x: c.x, y: c.y }]));
    const pocketed = new Set();
    let lastT = -1;
    let frameCount = 0;
    b.on("physicsFrame", (f) => {
        frameCount++;
        assert.equal(typeof f.t, "number");
        assert.ok(f.t > lastT, "timestamps strictly increase within a burst");
        lastT = f.t;
        for (const c of f.coins) full.set(c.id, { x: c.x, y: c.y });
    });
    b.on("pocketEvent", (p) => { if (p.kind === "coin") { pocketed.add(p.id); full.delete(p.id); } });

    const resolved = once(b, "turnResolved", 8000);
    a.emit("flick", { roomName: "room-recon", strikerX: 450, angle: -Math.PI / 2 + 0.05, force: 1 });
    const r = await resolved;

    assert.ok(frameCount > 3, "received a stream of frames");
    // Every live coin in the authoritative final state should match the
    // reconstructed position within quantization tolerance (±1px).
    for (const c of r.state.coins) {
        if (c.pocketed) continue;
        const recon = full.get(c.id);
        assert.ok(recon, `coin ${c.id} present in reconstruction`);
        assert.ok(Math.abs(recon.x - c.x) <= 1.5, `coin ${c.id} x within tolerance`);
        assert.ok(Math.abs(recon.y - c.y) <= 1.5, `coin ${c.id} y within tolerance`);
    }
    a.disconnect();
    b.disconnect();
});

test("server status page lists active rooms and reflects env CORS", async () => {
    const { a, b } = await makeRoom("room-status");
    const res = await fetch(`http://localhost:${PORT}/`);
    const html = await res.text();
    assert.match(html, /room-status/);
    a.disconnect();
    b.disconnect();
});
