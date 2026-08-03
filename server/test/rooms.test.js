// Room lifespan: a full room is not torn down by the disconnect grace, so it
// expires on inactivity instead. A half-empty room is the grace window's job.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rooms, createRoom, touchRoom, sweepIdleRooms, ROOM_IDLE_MS } from "../rooms.js";

const seat = (id) => ({ username: id, clientId: id });

const room = (name, { both = true, idleFor = 0 } = {}) => {
    const r = createRoom(name, seat("a"));
    if (both) { r.joiner = seat("b"); r.clientIds.add("b"); }
    r.lastActivity = Date.now() - idleFor;
    rooms.set(name, r);
    return r;
};

beforeEach(() => rooms.clear());

test("a full room past the window is closed", () => {
    room("stale", { idleFor: ROOM_IDLE_MS + 1000 });
    assert.deepEqual(sweepIdleRooms(null), ["stale"]);
    assert.equal(rooms.has("stale"), false);
});

test("a full room inside the window is left alone", () => {
    room("fresh", { idleFor: ROOM_IDLE_MS - 60_000 });
    assert.deepEqual(sweepIdleRooms(null), []);
    assert.equal(rooms.has("fresh"), true);
});

test("a half-empty room is never swept — the grace window owns it", () => {
    room("waiting", { both: false, idleFor: ROOM_IDLE_MS * 10 });
    assert.deepEqual(sweepIdleRooms(null), []);
    assert.equal(rooms.has("waiting"), true);
});

test("activity resets the clock", () => {
    const r = room("busy", { idleFor: ROOM_IDLE_MS + 1000 });
    touchRoom(r);
    assert.deepEqual(sweepIdleRooms(null), []);
    assert.equal(rooms.has("busy"), true);
});

test("the window is 36 hours", () => {
    assert.equal(ROOM_IDLE_MS, 36 * 60 * 60 * 1000);
});

test("sweeping clears the timers it finds, so nothing fires into a dead room", () => {
    const r = room("timers", { idleFor: ROOM_IDLE_MS + 1000 });
    let cancelled = false;
    r.simCancel = () => { cancelled = true; };
    r.resetTimer = setTimeout(() => { throw new Error("re-dealt a deleted room"); }, 50);
    sweepIdleRooms(null);
    assert.equal(cancelled, true, "the running simulation was cancelled");
});
