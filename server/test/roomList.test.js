// Lobby list: status rule + pagination.  cd server && npm test
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rooms, createRoom, roomStatus, roomListPage } from "../rooms.js";

const seed = (name, { joiner = null, grace = false } = {}) => {
    const room = createRoom(name, { username: `c-${name}`, clientId: `cid-c-${name}` });
    if (joiner) {
        room.joiner = { username: joiner, clientId: `cid-j-${name}` };
        room.clientIds.add(`cid-j-${name}`);
    }
    if (grace) room.graceTimers[`cid-c-${name}`] = setTimeout(() => {}, 60000);
    rooms.set(name, room);
    return room;
};

beforeEach(() => {
    for (const room of rooms.values()) {
        for (const t of Object.values(room.graceTimers || {})) clearTimeout(t);
    }
    rooms.clear();
});

test("a room with a free seat is open (green)", () => {
    assert.equal(roomStatus(seed("a")), "open");
});

test("a full room is busy (yellow)", () => {
    assert.equal(roomStatus(seed("b", { joiner: "B" })), "busy");
});

test("a room with a player mid-reconnect is busy, even though a seat looks free", () => {
    // The seat is only vacant until the grace window expires — advertising it as
    // open would invite someone to take a chair its owner is walking back to.
    assert.equal(roomStatus(seed("c", { grace: true })), "busy");
});

test("the list carries the room name, its players, and a status", () => {
    seed("kitchen", { joiner: "bob" });
    const { rooms: page, total } = roomListPage(0, 20);
    assert.equal(total, 1);
    assert.deepEqual(page[0], {
        roomName: "kitchen",
        usernames: ["c-kitchen", "bob"],
        status: "busy",
    });
});

test("pages slice the list without gaps or repeats", () => {
    for (let i = 0; i < 25; i++) seed(`room-${String(i).padStart(2, "0")}`);

    const first = roomListPage(0, 20);
    const second = roomListPage(20, 20);

    assert.equal(first.total, 25);
    assert.equal(first.rooms.length, 20);
    assert.equal(second.rooms.length, 5, "the tail page is short, not padded");

    const names = [...first.rooms, ...second.rooms].map((r) => r.roomName);
    assert.equal(new Set(names).size, 25, "no room may appear on two pages");
    assert.equal(names[0], "room-00");
    assert.equal(names[24], "room-24");
});

test("an offset past the end returns nothing rather than throwing", () => {
    seed("only");
    const page = roomListPage(500, 20);
    assert.deepEqual(page.rooms, []);
    assert.equal(page.total, 1);
});

test("limit is clamped, so a client cannot ask for the whole world", () => {
    for (let i = 0; i < 60; i++) seed(`r${i}`);
    assert.equal(roomListPage(0, 9999).rooms.length, 50, "limit clamps to 50");
    assert.equal(roomListPage(0, 0).rooms.length, 20, "a bogus limit falls back to the default");
    assert.equal(roomListPage(-5, 20).offset, 0, "a negative offset clamps to 0");
});
