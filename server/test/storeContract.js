// One set of rules, run against every backend.
//
// The JSON file and Firestore reach their answers by completely different
// routes — one ranks a list in memory, the other keeps one document per player
// and asks the database to sort. This suite is what stops those two routes from
// quietly disagreeing: the same fifteen assertions run against both, so a
// leaderboard means the same thing in development as it does in production.

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

/**
 * @param {string}   label      backend name, for the test output
 * @param {object}   hooks
 * @param {Function} hooks.open   () => a store onto the SAME storage each time,
 *                                so "survives a restart" means something
 * @param {Function} hooks.clear  () => empty that storage
 */
export function runStoreContract(label, { open, clear }) {
    describe(label, () => {
        let store;

        beforeEach(async () => {
            await clear();
            store = open();
        });

        test("an empty store reads as empty rather than throwing", async () => {
            assert.deepEqual(await store.topSoloRuns(19), []);
            assert.deepEqual(await store.recentMatches(), []);
        });

        test("playground runs come back fastest first", async () => {
            await store.recordSoloRun({ username: "slow", coinCount: 5, ms: 9000 });
            await store.recordSoloRun({ username: "quick", coinCount: 5, ms: 3000 });
            await store.recordSoloRun({ username: "middling", coinCount: 5, ms: 6000 });

            const top = await store.topSoloRuns(5);
            assert.deepEqual(top.map((r) => r.username), ["quick", "middling", "slow"]);
        });

        test("one row per player: only their best run counts", async () => {
            // Otherwise one person playing all afternoon owns the whole board.
            await store.recordSoloRun({ username: "harsh", coinCount: 5, ms: 9000 });
            await store.recordSoloRun({ username: "harsh", coinCount: 5, ms: 4000 });
            await store.recordSoloRun({ username: "harsh", coinCount: 5, ms: 7000 });

            const top = await store.topSoloRuns(5);
            assert.equal(top.length, 1);
            assert.equal(top[0].ms, 4000, "their fastest");
        });

        test("a slower run never displaces a faster one", async () => {
            // Firestore keeps only the best, so this is where "best" is decided;
            // the file backend keeps both and decides at read time. Same answer.
            await store.recordSoloRun({ username: "harsh", coinCount: 5, ms: 4000 });
            await store.recordSoloRun({ username: "harsh", coinCount: 5, ms: 8000 });
            assert.equal((await store.topSoloRuns(5))[0].ms, 4000);
        });

        test("racks are ranked separately", async () => {
            await store.recordSoloRun({ username: "a", coinCount: 3, ms: 1000 });
            await store.recordSoloRun({ username: "b", coinCount: 19, ms: 5000 });

            assert.deepEqual((await store.topSoloRuns(3)).map((r) => r.username), ["a"]);
            assert.deepEqual((await store.topSoloRuns(19)).map((r) => r.username), ["b"]);
        });

        test("the same name in two racks holds a row in each", async () => {
            await store.recordSoloRun({ username: "harsh", coinCount: 3, ms: 1000 });
            await store.recordSoloRun({ username: "harsh", coinCount: 19, ms: 9000 });
            assert.equal((await store.topSoloRuns(3))[0].ms, 1000);
            assert.equal((await store.topSoloRuns(19))[0].ms, 9000);
        });

        test("a player with no name is recorded as ?", async () => {
            await store.recordSoloRun({ username: "", coinCount: 5, ms: 1000 });
            await store.recordSoloRun({ username: "   ", coinCount: 5, ms: 2000 });
            const top = await store.topSoloRuns(5);
            assert.equal(top[0].username, "?");
            assert.equal(top.length, 1, "the nameless share one row");
        });

        test("a name that is punctuation is still a name", async () => {
            // Firestore keys a document by the name; "/" and "." are the two
            // that a naive key would either split on or be rejected for.
            for (const odd of ["a/b", ".", "..", "__x__", "?"]) {
                await store.recordSoloRun({ username: odd, coinCount: 11, ms: 1000 });
            }
            const names = (await store.topSoloRuns(11)).map((r) => r.username);
            assert.deepEqual(names.sort(), ["..", ".", "?", "__x__", "a/b"].sort());
        });

        test("the top list is capped", async () => {
            for (let i = 0; i < 25; i++) {
                await store.recordSoloRun({ username: `p${i}`, coinCount: 5, ms: 1000 + i });
            }
            assert.equal((await store.topSoloRuns(5)).length, 10);
        });

        test("matches come back newest first, with the series score", async () => {
            await store.recordMatch({ players: ["alice", "bob"], wins: [2, 1] });
            await store.recordMatch({ players: ["carol", "dan"], wins: [0, 3] });

            const recent = await store.recentMatches();
            assert.deepEqual(recent[0].players, ["carol", "dan"], "newest first");
            assert.deepEqual(recent[0].wins, [0, 3]);
            assert.deepEqual(recent[1].wins, [2, 1]);
        });

        test("matches recorded in the same millisecond still have an order", async () => {
            // Two results landing together must not leave the order to chance.
            await Promise.all([
                store.recordMatch({ players: ["a", "b"], wins: [1, 0] }),
                store.recordMatch({ players: ["c", "d"], wins: [1, 0] }),
                store.recordMatch({ players: ["e", "f"], wins: [1, 0] }),
            ]);
            const stamps = (await store.recentMatches()).map((m) => m.at);
            assert.equal(new Set(stamps).size, 3, "no two share a timestamp");
            assert.deepEqual([...stamps], [...stamps].sort((x, y) => y - x), "and they are ordered");
        });

        test("only the last ten matches are listed", async () => {
            for (let i = 0; i < 14; i++) {
                await store.recordMatch({ players: [`p${i}`, "x"], wins: [1, 0] });
            }
            const recent = await store.recentMatches();
            assert.equal(recent.length, 10);
            assert.deepEqual(recent[0].players[0], "p13", "and they are the last ten");
        });

        test("writes survive a restart", async () => {
            await store.recordSoloRun({ username: "harsh", coinCount: 19, ms: 4200 });
            await store.recordMatch({ players: ["a", "b"], wins: [1, 1] });

            const reopened = open();          // a fresh process would do this
            assert.equal((await reopened.topSoloRuns(19))[0].username, "harsh");
            assert.equal((await reopened.recentMatches()).length, 1);
        });

        test("simultaneous writes do not erase each other", async () => {
            // Two results landing together used to both read the old file, and
            // the second would write the first away.
            await Promise.all([
                store.recordSoloRun({ username: "a", coinCount: 5, ms: 1000 }),
                store.recordSoloRun({ username: "b", coinCount: 5, ms: 2000 }),
                store.recordSoloRun({ username: "c", coinCount: 5, ms: 3000 }),
            ]);
            assert.equal((await store.topSoloRuns(5)).length, 3);

            const reopened = open();
            assert.equal((await reopened.topSoloRuns(5)).length, 3, "and all three landed");
        });

        test("one player's simultaneous runs settle on the fastest", async () => {
            await Promise.all([
                store.recordSoloRun({ username: "harsh", coinCount: 5, ms: 5000 }),
                store.recordSoloRun({ username: "harsh", coinCount: 5, ms: 2000 }),
                store.recordSoloRun({ username: "harsh", coinCount: 5, ms: 8000 }),
            ]);
            const top = await store.topSoloRuns(5);
            assert.equal(top.length, 1);
            assert.equal(top[0].ms, 2000, "the slower ones cannot win by writing last");
        });
    });
}

export default runStoreContract;
