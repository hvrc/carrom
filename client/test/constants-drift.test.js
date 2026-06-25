// Drift guard: the client mirrors the server's board/physics geometry (the
// server is the authority). These constants are duplicated rather than shared
// via a package (see prd.md Phase 4 — a shared workspace would complicate the
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
