// What gets remembered, and what deliberately does not. These are the rules a
// leaderboard lives or dies by, so they are tested against the real service
// with a stand-in store rather than through the socket layer.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rooms, createRoom } from "../rooms.js";
import { createGameService } from "../gameService.js";

const fakeIo = { to: () => ({ emit: () => {} }) };

function fakeStore() {
    const runs = [];
    const matches = [];
    return {
        runs,
        matches,
        recordSoloRun: async (r) => { runs.push(r); },
        recordMatch: async (m) => { matches.push(m); },
        topSoloRuns: async () => runs,
        recentMatches: async () => matches,
    };
}

let store;
let service;

beforeEach(() => {
    rooms.clear();
    store = fakeStore();
    service = createGameService(fakeIo, store);
});

const twoPlayerRoom = (name, { creatorWins = 0, joinerWins = 0 } = {}) => {
    const room = createRoom(name, { username: "alice", clientId: "a" });
    room.joiner = { username: "bob", clientId: "b" };
    room.wins = { creator: creatorWins, joiner: joinerWins };
    rooms.set(name, room);
    return room;
};

// ── matches ────────────────────────────────────────────────────────────────

test("a finished match records the SERIES, not any single game", async () => {
    // Four games, two each: the pair would tell you "2-2", not the scores of the
    // individual games, so that is what is kept.
    twoPlayerRoom("r", { creatorWins: 2, joinerWins: 2 });
    await service.recordFinishedMatch("r");

    assert.equal(store.matches.length, 1);
    assert.deepEqual(store.matches[0].players, ["alice", "bob"]);
    assert.deepEqual(store.matches[0].wins, [2, 2]);
});

test("a room where nobody ever won a game is not a match", async () => {
    twoPlayerRoom("r", { creatorWins: 0, joinerWins: 0 });
    await service.recordFinishedMatch("r");
    assert.equal(store.matches.length, 0, "two people who never finished a game are not a result");
});

test("a room that never had a second player is not a match", async () => {
    const room = createRoom("lonely", { username: "alice", clientId: "a" });
    room.wins = { creator: 3, joiner: 0 };
    rooms.set("lonely", room);

    await service.recordFinishedMatch("lonely");
    assert.equal(store.matches.length, 0);
});

test("a playground room is never recorded as a match", async () => {
    const room = createRoom("playground-x", { username: "solo", clientId: "s" }, 5, true);
    room.wins = { creator: 4, joiner: 0 };
    rooms.set("playground-x", room);

    await service.recordFinishedMatch("playground-x");
    assert.equal(store.matches.length, 0, "practice is not a match");
});

test("a room that has already gone is not recorded", async () => {
    await service.recordFinishedMatch("never-existed");
    assert.equal(store.matches.length, 0);
});

// ── playground runs ────────────────────────────────────────────────────────

test("a cleared playground board records who, which rack, and how long", async () => {
    const room = createRoom("playground-y", { username: "harsh", clientId: "h" }, 3, true);
    room.startedAt = Date.now() - 4500;
    rooms.set("playground-y", room);

    await service.recordSoloRun("playground-y");

    assert.equal(store.runs.length, 1);
    assert.equal(store.runs[0].username, "harsh");
    assert.equal(store.runs[0].coinCount, 3, "the rack that was actually cleared");
    assert.ok(store.runs[0].ms >= 4400 && store.runs[0].ms < 6000,
        `timed from the deal, got ${store.runs[0].ms}ms`);
});

test("a two-player room is never recorded as a playground run", async () => {
    const room = twoPlayerRoom("r");
    room.startedAt = Date.now() - 1000;
    await service.recordSoloRun("r");
    assert.equal(store.runs.length, 0);
});

test("a run with no clock is not recorded", async () => {
    // startedAt is cleared the moment a run completes, so a second call for the
    // same board cannot record the same run twice.
    const room = createRoom("playground-z", { username: "harsh", clientId: "h" }, 5, true);
    room.startedAt = null;
    rooms.set("playground-z", room);

    await service.recordSoloRun("playground-z");
    assert.equal(store.runs.length, 0);
});

test("with no store at all, nothing throws", async () => {
    const bare = createGameService(fakeIo, null);
    twoPlayerRoom("r", { creatorWins: 1 });
    await bare.recordFinishedMatch("r");   // must simply do nothing
    await bare.recordSoloRun("r");
});
