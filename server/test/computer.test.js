// A game against the computer, over a real socket.
//
// The bot is tested on its own elsewhere; what matters here is the wiring: that
// the room exists and is private, that the turn actually comes back, and above
// all that a room which closes mid-think does not wake up and play a shot into
// a game nobody is in.

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { io as connect } from "socket.io-client";

import { registerHandlers } from "../socketHandlers.js";
import { createGameService } from "../gameService.js";
import { rooms, roomListPage } from "../rooms.js";

let httpServer;
let ioServer;
let port;

before(async () => {
    httpServer = createServer();
    ioServer = new Server(httpServer, { cors: { origin: "*" } });
    const service = createGameService(ioServer, null);
    ioServer.on("connection", (socket) => registerHandlers(ioServer, socket, service));
    await new Promise((done) => httpServer.listen(0, done));
    port = httpServer.address().port;
});

after(async () => {
    for (const room of rooms.values()) {
        if (room.botTimer) clearTimeout(room.botTimer);
        if (room.resetTimer) clearTimeout(room.resetTimer);
        if (room.simCancel) room.simCancel();
    }
    rooms.clear();
    ioServer.close();
    await new Promise((done) => httpServer.close(done));
});

beforeEach(() => {
    for (const room of rooms.values()) {
        if (room.botTimer) clearTimeout(room.botTimer);
        if (room.resetTimer) clearTimeout(room.resetTimer);
        if (room.simCancel) room.simCancel();
    }
    rooms.clear();
});

const client = (clientId) => connect(`http://localhost:${port}`, {
    transports: ["websocket"],
    query: { clientId },
    forceNew: true,
});

/** Wait for an event, or fail with something more useful than a timeout. */
function waitFor(socket, event, ms = 15000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.off(event, onEvent);
            reject(new Error(`waited ${ms}ms for "${event}" and it never came`));
        }, ms);
        function onEvent(payload) {
            clearTimeout(timer);
            socket.off(event, onEvent);
            resolve(payload);
        }
        socket.on(event, onEvent);
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openComputerGame(id = "human-1", coinCount = 5) {
    const socket = client(id);
    await waitFor(socket, "connect");
    const roomName = `computer-${id}`;
    socket.emit("openComputer", { roomName, username: "harsh", clientId: id, coinCount });
    await waitFor(socket, "gameInit");
    return { socket, roomName };
}

describe("a game against the computer", () => {
    test("opens a room with the computer sitting opposite", async () => {
        const { socket, roomName } = await openComputerGame("human-open");
        const room = rooms.get(roomName);

        assert.ok(room, "the room exists");
        assert.equal(room.creator.username, "harsh");
        assert.equal(room.joiner.username, "COMPUTER");
        assert.equal(room.bot.role, "joiner");
        assert.equal(room.bot.difficulty, 0.5, "shipped at medium");
        assert.equal(room.game.whoseTurn, "creator", "the person goes first");
        socket.close();
    });

    test("the room is not in the lobby", async () => {
        // It has no seat to offer, so listing it would be an invitation to a
        // room nobody can enter.
        const { socket, roomName } = await openComputerGame("human-hidden");
        const listed = roomListPage(0, 50).rooms.map((r) => r.roomName);
        assert.ok(!listed.includes(roomName));
        assert.equal(roomListPage(0, 50).total, 0);
        socket.close();
    });

    test("after the person plays, the computer answers", async () => {
        const { socket, roomName } = await openComputerGame("human-turn");

        // A shot that will not pot anything: the turn passes to the computer.
        socket.emit("flick", { roomName, strikerX: 450, angle: -Math.PI / 2, force: 0.25 });
        const mine = await waitFor(socket, "turnResolved");
        assert.equal(mine.state.whoseTurn, "joiner", "the turn went to the computer");

        // And now, without anyone sending anything, it plays.
        const theirs = await waitFor(socket, "turnResolved");
        assert.ok(theirs.state, "the computer took its turn on its own");
        socket.close();
    });

    test("the striker is seen sliding into place before the computer shoots", async () => {
        const { socket, roomName } = await openComputerGame("human-preview");
        socket.emit("flick", { roomName, strikerX: 450, angle: -Math.PI / 2, force: 0.25 });
        await waitFor(socket, "turnResolved");

        const preview = await waitFor(socket, "strikerPlaceUpdate");
        assert.equal(preview.playerRole, "joiner");
        assert.ok(Number.isFinite(preview.strikerX));
        socket.close();
    });

    test("a room that closes mid-think never plays its shot", async () => {
        // The failure this prevents: the bot's timer fires after the room is
        // gone, and simulates a turn against a game with nobody in it.
        const { socket, roomName } = await openComputerGame("human-leaver");
        socket.emit("flick", { roomName, strikerX: 450, angle: -Math.PI / 2, force: 0.25 });
        await waitFor(socket, "turnResolved");

        assert.ok(rooms.get(roomName).botTimer, "the computer is thinking");
        socket.emit("leaveRoom", { roomName, clientId: "human-leaver" });
        await sleep(60);
        assert.equal(rooms.has(roomName), false, "the room is gone");

        // Long enough for the think and the aim pause to have fired.
        await sleep(1800);
        assert.equal(rooms.has(roomName), false, "and nothing brought it back");
        socket.close();
    });

    test("re-opening the same room resumes it rather than dealing again", async () => {
        const { socket, roomName } = await openComputerGame("human-resume");
        const room = rooms.get(roomName);
        room.game.scores.creator = 3;          // something to notice surviving

        socket.emit("openComputer", { roomName, username: "harsh", clientId: "human-resume", coinCount: 5 });
        await waitFor(socket, "gameInit");
        assert.equal(rooms.get(roomName).game.scores.creator, 3, "same game, not a new one");
        socket.close();
    });

    test("asking for a different rack starts a fresh series", async () => {
        const { socket, roomName } = await openComputerGame("human-rack", 5);
        rooms.get(roomName).wins = { creator: 2, joiner: 1 };

        socket.emit("openComputer", { roomName, username: "harsh", clientId: "human-rack", coinCount: 19 });
        await waitFor(socket, "gameInit");
        const room = rooms.get(roomName);
        assert.equal(room.coinCount, 19);
        assert.equal(room.game.coins.length, 19);
        assert.deepEqual(room.wins, { creator: 0, joiner: 0 }, "a different rack is a different contest");
        socket.close();
    });

    test("somebody else cannot take the computer's seat", async () => {
        const { socket, roomName } = await openComputerGame("human-owner");

        const intruder = client("intruder");
        await waitFor(intruder, "connect");
        intruder.emit("joinRoom", { roomName, username: "gatecrasher", clientId: "intruder" });
        const err = await waitFor(intruder, "error");
        assert.match(err, /full/i);
        assert.equal(rooms.get(roomName).joiner.username, "COMPUTER");

        socket.close();
        intruder.close();
    });

    test("being in a computer game does not lock the player out of a real one", async () => {
        // The other seat is not a person waiting, so this must not read as
        // "already seated" — that would make the button a trap.
        const { socket, roomName } = await openComputerGame("human-free");
        socket.emit("createRoom", { roomName: "a-real-room", username: "harsh", clientId: "human-free" });
        const joined = await waitFor(socket, "playerJoined");
        assert.equal(joined.roomName, "a-real-room");
        assert.ok(rooms.has(roomName), "and the computer game is still there");
        socket.close();
    });
});
