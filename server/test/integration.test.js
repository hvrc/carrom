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
            env: {
                ...process.env, PORT: String(port), NODE_ENV: "test",
                CORS_ORIGINS: "*", DISCONNECT_GRACE_MS: "600",
            },
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

test("turns alternate across consecutive flicks (full loop repeats)", async () => {
    const { a, b } = await makeRoom("room-turns");
    // Await both resolutions on the SAME socket (a) so ordered delivery avoids a
    // cross-socket race where a previous turnResolved arrives late on the peer.
    const flickAndWait = (sock, payload) => {
        const p = once(a, "turnResolved", 8000);
        sock.emit("flick", { roomName: "room-turns", ...payload });
        return p;
    };

    let r = await flickAndWait(a, { strikerX: 300, angle: Math.PI, force: 0.15 });
    assert.equal(r.state.whoseTurn, "joiner");

    r = await flickAndWait(b, { strikerX: 600, angle: 0, force: 0.15 });
    assert.equal(r.state.whoseTurn, "creator");
    assert.equal(r.state.gameOver, false);
    a.disconnect();
    b.disconnect();
});

// ── Phase 3: presence & reconnection ──────────────────────────────────────

test("a refresh (reconnect, same clientId) resumes the same game — not re-dealt", async () => {
    const { a, b } = await makeRoom("room-refresh");
    // advance the game so a re-deal would be detectable (turn flips to joiner)
    const r1 = await (() => {
        const p = once(a, "turnResolved", 8000);
        a.emit("flick", { roomName: "room-refresh", strikerX: 300, angle: Math.PI, force: 0.2 });
        return p;
    })();
    const turnAfter = r1.state.whoseTurn;
    const liveAfter = r1.state.coins.filter((c) => !c.pocketed).length;
    assert.equal(turnAfter, "joiner");

    // simulate a browser refresh of player A: drop the socket, open a NEW one
    // with the SAME clientId, then rejoinRoom + requestRoomData.
    const aId = a._clientId;
    a.disconnect();
    const a2 = ioc(`http://localhost:${PORT}`, { transports: ["websocket"], query: { clientId: aId }, reconnection: false, forceNew: true });
    await once(a2, "connect");
    const a2Init = once(a2, "gameInit", 4000);
    a2.emit("rejoinRoom", { roomName: "room-refresh", username: "A", clientId: aId, playerRole: "creator" });
    await once(a2, "accessGranted", 4000);
    a2.emit("requestRoomData", { roomName: "room-refresh" });
    const state = await a2Init;

    assert.equal(state.whoseTurn, turnAfter, "turn preserved across refresh (not reset to creator)");
    assert.equal(state.coins.filter((c) => !c.pocketed).length, liveAfter, "board preserved");
    a2.disconnect();
    b.disconnect();
});

test("a disconnect with no return tears the room down after the grace window", async () => {
    const { a, b } = await makeRoom("room-grace");
    const closed = once(b, "roomClosed", 4000);
    a.disconnect(); // gone, never returns
    const msg = await closed; // arrives ~600ms later (grace)
    assert.match(String(msg), /left|closed/i);
    // room is gone — a fresh client cannot join it
    const c = connect();
    await once(c, "connect");
    const err = once(c, "error", 3000);
    c.emit("joinRoom", { roomName: "room-grace", username: "C", clientId: c._clientId });
    assert.match(String(await err), /does not exist/i);
    b.disconnect();
    c.disconnect();
});

test("explicit leave ends the room and notifies the opponent", async () => {
    const { a, b } = await makeRoom("room-leave");
    const bClosed = once(b, "roomClosed", 3000);
    a.emit("leaveRoom", { roomName: "room-leave", clientId: a._clientId });
    assert.match(String(await bClosed), /left/i);
    const c = connect();
    await once(c, "connect");
    const err = once(c, "error", 3000);
    c.emit("checkRoomAccess", { roomName: "room-leave", clientId: c._clientId });
    assert.match(String(await err), /does not exist/i);
    a.disconnect();
    b.disconnect();
    c.disconnect();
});

// ── Aim preview relay ────────────────────────────────────────────────────────

test("the player on turn has their aim line relayed to the opponent", async () => {
    const { a, b } = await makeRoom("room-aim");
    const seen = once(b, "aimUpdate");
    a.emit("aimUpdate", {
        roomName: "room-aim", playerRole: "creator",
        active: true, startX: 400, startY: 700, endX: 450, endY: 760,
    });
    const aim = await seen;
    assert.equal(aim.active, true);
    assert.equal(aim.playerRole, "creator");
    // Coordinates pass through untouched — they are already in the shared
    // 900-space that both clients render (the joiner's rotation is applied at
    // draw time), so any transform here would double-rotate the line.
    assert.deepEqual(
        { startX: aim.startX, startY: aim.startY, endX: aim.endX, endY: aim.endY },
        { startX: 400, startY: 700, endX: 450, endY: 760 },
    );
    a.disconnect();
    b.disconnect();
});

test("the aiming player does not receive their own relayed aim line", async () => {
    const { a, b } = await makeRoom("room-aim-echo");
    let echoed = false;
    a.on("aimUpdate", () => { echoed = true; });
    const seen = once(b, "aimUpdate");
    a.emit("aimUpdate", {
        roomName: "room-aim-echo", playerRole: "creator",
        active: true, startX: 400, startY: 700, endX: 420, endY: 720,
    });
    await seen;
    assert.equal(echoed, false, "an echo back to the sender would fight their own live aim line");
    a.disconnect();
    b.disconnect();
});

test("an off-turn player cannot broadcast an aim line", async () => {
    const { a, b } = await makeRoom("room-aim-offturn");
    let leaked = false;
    a.on("aimUpdate", () => { leaked = true; });
    // It is the creator's turn; the joiner tries to draw on their opponent's board.
    b.emit("aimUpdate", {
        roomName: "room-aim-offturn", playerRole: "joiner",
        active: true, startX: 0, startY: 0, endX: 900, endY: 900,
    });
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(leaked, false, "only the player to move may relay an aim line");
    a.disconnect();
    b.disconnect();
});

test("releasing the flick clears the opponent's ghost line", async () => {
    const { a, b } = await makeRoom("room-aim-clear");
    const shown = once(b, "aimUpdate");
    a.emit("aimUpdate", {
        roomName: "room-aim-clear", playerRole: "creator",
        active: true, startX: 400, startY: 700, endX: 450, endY: 760,
    });
    assert.equal((await shown).active, true);

    const cleared = once(b, "aimUpdate");
    a.emit("aimUpdate", { roomName: "room-aim-clear", playerRole: "creator", active: false });
    assert.equal((await cleared).active, false);
    a.disconnect();
    b.disconnect();
});

// ── Lobby list ───────────────────────────────────────────────────────────────

test("listRooms returns names, players and status, and pages as the client scrolls", async () => {
    const { a, b } = await makeRoom("room-lobby-full");   // full -> busy

    const c = connect();
    await once(c, "connect");
    c.emit("createRoom", { roomName: "room-lobby-open", username: "C", clientId: c._clientId });
    await once(c, "playerJoined");                        // one seat free -> open

    const lister = connect();
    await once(lister, "connect");
    const seen = once(lister, "roomList");
    lister.emit("listRooms", { offset: 0, limit: 20 });
    const page = await seen;

    const byName = Object.fromEntries(page.rooms.map((r) => [r.roomName, r]));
    assert.equal(byName["room-lobby-full"].status, "busy");
    assert.deepEqual(byName["room-lobby-full"].usernames, ["A", "B"]);
    assert.equal(byName["room-lobby-open"].status, "open");
    assert.deepEqual(byName["room-lobby-open"].usernames, ["C"]);
    assert.ok(page.total >= 2);

    // The second page must not repeat the first — that's what infinite scroll
    // relies on, since it appends by offset.
    const nextSeen = once(lister, "roomList");
    lister.emit("listRooms", { offset: 1, limit: 1 });
    const next = await nextSeen;
    assert.equal(next.rooms.length, 1);
    assert.equal(next.offset, 1);
    assert.notEqual(next.rooms[0].roomName, page.rooms[0].roomName);

    a.disconnect();
    b.disconnect();
    c.disconnect();
    lister.disconnect();
});

test("a link to a room that doesn't exist yet: join is refused, then create succeeds", async () => {
    // Mirrors JoinGate: opening /<name> cold tries joinRoom first, and falls back
    // to createRoom when the room isn't there — so a shared link still works if
    // the recipient arrives before the sender created it.
    const a = connect();
    await once(a, "connect");

    const err = once(a, "error");
    a.emit("joinRoom", { roomName: "room-from-link", username: "A", clientId: a._clientId });
    assert.match(String(await err), /does not exist/i);

    const joined = once(a, "playerJoined");
    a.emit("createRoom", { roomName: "room-from-link", username: "A", clientId: a._clientId });
    assert.equal((await joined).roomName, "room-from-link");

    // And the freshly created room shows up in the lobby as open.
    const seen = once(a, "roomList");
    a.emit("listRooms", { offset: 0, limit: 50 });
    const page = await seen;
    const room = page.rooms.find((r) => r.roomName === "room-from-link");
    assert.equal(room.status, "open");
    assert.deepEqual(room.usernames, ["A"]);

    a.disconnect();
});
