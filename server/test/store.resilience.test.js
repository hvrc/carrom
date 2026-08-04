// What happens to a game when the leaderboard's database is down.
//
// The answer has to be "nothing". A player mid-match should not be able to tell
// that Firestore is unreachable — their shots still land, their turn still
// passes, and the result simply does not get written down. This once was not
// true: a server started without credentials died on the first read, taking
// every live room with it.
//
// No emulator needed. The database here is a stand-in that fails every call,
// which is the point — it is the failing, not Firestore, that is under test.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../store/index.js";

const BOOM = () => Promise.reject(new Error("firestore is down"));

// Chains like a Firestore handle; every terminal operation rejects.
function brokenDb() {
    const node = {
        collection: () => node,
        doc: () => node,
        orderBy: () => node,
        limit: () => node,
        listDocuments: BOOM,
        get: BOOM,
        add: BOOM,
        set: BOOM,
        delete: BOOM,
        runTransaction: BOOM,
    };
    return node;
}

describe("a leaderboard whose database is down", () => {
    const open = () => createStore({ backend: "firestore", db: brokenDb() });

    test("recording a run does not throw at the caller", async () => {
        // gameService awaits this at the end of a game. A rejection here would
        // surface as an unhandled rejection and kill the process.
        await open().recordSoloRun({ username: "harsh", coinCount: 19, ms: 4200 });
    });

    test("recording a match does not throw at the caller", async () => {
        await open().recordMatch({ players: ["a", "b"], wins: [2, 1] });
    });

    test("the boards read as empty rather than failing", async () => {
        const store = open();
        assert.deepEqual(await store.topSoloRuns(19), []);
        assert.deepEqual(await store.recentMatches(), []);
    });

    test("but health says plainly that it is broken", async () => {
        // The one place the failure must NOT be swallowed, so a deploy can gate.
        const { ok, backend, detail } = await open().health();
        assert.equal(ok, false);
        assert.equal(backend, "firestore");
        assert.match(detail, /firestore is down/);
    });
});
