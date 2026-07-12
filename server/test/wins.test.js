// Games-won counter and the re-deal after a win (PRD F11).  cd server && npm test
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rooms, createRoom, roomUpdatePayload, GAME_RESET_DELAY_MS } from "../rooms.js";
import { createGameService } from "../gameService.js";

// A stand-in for socket.io that just records what was broadcast where.
const stubIo = () => {
    const sent = [];
    return {
        sent,
        to: (room) => ({ emit: (event, payload) => sent.push({ room, event, payload }) }),
        eventsFor: (room) => sent.filter((s) => s.room === room).map((s) => s.event),
    };
};

const seedRoom = (name) => {
    const room = createRoom(name, { username: "A", clientId: "cid-a" });
    room.joiner = { username: "B", clientId: "cid-b" };
    room.clientIds.add("cid-b");
    rooms.set(name, room);
    return room;
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
    for (const room of rooms.values()) {
        if (room.resetTimer) clearTimeout(room.resetTimer);
    }
    rooms.clear();
});

test("a new room starts with no wins, and none are broadcast as anything else", () => {
    const room = seedRoom("r");
    assert.deepEqual(room.wins, { creator: 0, joiner: 0 });
    const payload = roomUpdatePayload(room, "r");
    assert.deepEqual(payload.wins, { creator: 0, joiner: 0 });
    assert.equal(payload.creator.wins, 0);
    assert.equal(payload.joiner.wins, 0);
});

test("winning banks a win on the ROOM, so it survives the re-deal", async () => {
    const io = stubIo();
    const service = createGameService(io);
    const room = seedRoom("r");
    service.startGame("r");

    // Play the game to a state a win would leave behind, then win it.
    room.game.scores.creator = 7;
    room.game.pocketedPiles.creator = [{ id: 1, color: "white" }];
    room.game.colors = { creator: "white", joiner: "black" };

    service.finishGame("r", "creator");
    assert.deepEqual(room.wins, { creator: 1, joiner: 0 }, "the win is banked immediately");

    // The result stays on screen for a beat before the next rack is dealt.
    assert.equal(room.game.scores.creator, 7, "board is untouched while the result shows");

    await wait(GAME_RESET_DELAY_MS + 120);

    assert.deepEqual(room.wins, { creator: 1, joiner: 0 }, "wins carry across games");
    assert.equal(room.game.scores.creator, 0, "but the score is fresh");
    assert.deepEqual(room.game.colors, { creator: null, joiner: null }, "and colours are up for grabs again");
    assert.equal(room.game.pocketedPiles.creator.length, 0, "and the ledge is cleared");
    assert.equal(room.game.queenState, "on_board");
    assert.ok(io.eventsFor("r").includes("gameInit"), "the new rack is dealt to both players");
});

test("a second win adds to the count", async () => {
    const service = createGameService(stubIo());
    const room = seedRoom("r");
    service.startGame("r");

    service.finishGame("r", "creator");
    await wait(GAME_RESET_DELAY_MS + 80);
    service.finishGame("r", "joiner");
    await wait(GAME_RESET_DELAY_MS + 80);
    service.finishGame("r", "creator");
    await wait(GAME_RESET_DELAY_MS + 80);

    assert.deepEqual(room.wins, { creator: 2, joiner: 1 });
});

test("a pending re-deal does not fire into a room that has closed", async () => {
    const io = stubIo();
    const service = createGameService(io);
    const room = seedRoom("r");
    service.startGame("r");
    service.finishGame("r", "creator");

    // Both players walk out during the result screen.
    clearTimeout(room.resetTimer);   // what the leave/disconnect handlers do
    rooms.delete("r");

    await wait(GAME_RESET_DELAY_MS + 120);
    // Nothing should have been dealt into the dead room after it was deleted.
    assert.equal(rooms.has("r"), false);
});
