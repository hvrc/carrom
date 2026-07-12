// Drift guard: the client mirrors the server's board/physics geometry (the
// server is the authority). These constants are duplicated rather than shared
// via a package (see prds/2026-06-25-netcode-and-cloud-run.md Phase 4 — a shared workspace would complicate the
// per-service Cloud Run deploy). This test fails loudly if the two ever diverge.
//   cd client && npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import Draw from "../scripts/Draw.js";
import Coin from "../scripts/Coin.js";
import Striker from "../scripts/Striker.js";
import Pocket from "../scripts/Pocket.js";
import * as server from "../../server/physics.js";

test("client board geometry matches server", () => {
    assert.equal(Draw.FRAME_SIZE, server.FRAME_SIZE, "FRAME_SIZE");
    assert.equal(Draw.BOARD_SIZE, server.BOARD_SIZE, "BOARD_SIZE");
    assert.equal(Draw.BASE_DISTANCE, server.BASE_DISTANCE, "BASE_DISTANCE");
    assert.equal(Draw.BASE_HEIGHT, server.BASE_HEIGHT, "BASE_HEIGHT");
    assert.equal(Draw.BASE_WIDTH, server.BASE_WIDTH, "BASE_WIDTH");
});

test("client coin/striker/pocket sizes match server", () => {
    // Coin radius default lives in the Coin constructor.
    const coin = new Coin({ id: 1 });
    assert.equal(coin.radius, server.COIN_RADIUS, "COIN_RADIUS");
    const striker = new Striker(0, 0);
    assert.equal(striker.radius, server.STRIKER_RADIUS, "STRIKER_RADIUS");
    assert.equal(Pocket.POCKET_DIAMETER, server.POCKET_DIAMETER, "POCKET_DIAMETER");
});

test("client ledge geometry matches server", () => {
    // The ledge is where pocketed coins live. If the client and server disagree
    // about a slot's position, a coin animates to one place and lands in another.
    assert.equal(Draw.LEDGE_SPACING, server.LEDGE_SPACING, "LEDGE_SPACING");
    assert.equal(Draw.LEDGE_INSET, server.LEDGE_INSET, "LEDGE_INSET");
    assert.equal(Draw.LEDGE_Y_CREATOR, server.LEDGE_Y_CREATOR, "LEDGE_Y_CREATOR");
    assert.equal(Draw.LEDGE_Y_JOINER, server.LEDGE_Y_JOINER, "LEDGE_Y_JOINER");

    for (const role of ["creator", "joiner"]) {
        for (let i = 0; i < 10; i++) {
            assert.deepEqual(
                Draw.ledgeSlot(role, i),
                server.ledgeSlot(role, i),
                `ledgeSlot(${role}, ${i})`,
            );
        }
    }
});

test("the two ledges fill in opposite directions, so each player's reads left-to-right", () => {
    // The joiner's canvas is rotated 180°, so their row must run the other way in
    // board space for it to read left → right on their screen.
    const c0 = server.ledgeSlot("creator", 0);
    const c1 = server.ledgeSlot("creator", 1);
    const j0 = server.ledgeSlot("joiner", 0);
    const j1 = server.ledgeSlot("joiner", 1);
    assert.ok(c1.x > c0.x, "the creator's pile grows rightwards");
    assert.ok(j1.x < j0.x, "the joiner's grows leftwards in board space");
    assert.ok(c0.y > j0.y, "and they sit on opposite sides of the board");
});

test("a full pile of coins fits on the ledge", () => {
    // 9 coins + the queen is the most anyone can hold.
    const last = server.ledgeSlot("creator", 9);
    assert.ok(last.x + server.COIN_RADIUS < server.BOARD_X + server.BOARD_SIZE, "stays within the board's width");
    assert.ok(last.y + server.COIN_RADIUS <= server.FRAME_SIZE, "and inside the wooden frame");
});
