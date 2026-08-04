// Leaderboards in Firestore. The production backend.
//
// Cloud Run throws the container's disk away on every deploy, so a file-backed
// leaderboard would reset each time the game shipped. This keeps the two lists
// outside the container entirely.
//
// SHAPE, and why it is shaped this way:
//
//   <ns>-solo-runs / {coinCount} / runs / {u_username}   one doc per player per rack
//   <ns>-matches   / {autoId}                            one doc per finished match
//
// A rack is a COLLECTION rather than a field because of indexes. Asking for
// "the 3-coin runs, fastest first" as a where + orderBy on two different fields
// needs a composite index, which is a thing someone has to remember to create
// and which fails in production if they don't. Ordering inside a per-rack
// collection needs only the single-field index Firestore maintains by itself,
// so this works against an empty database with no setup at all.
//
// One doc per player, keyed by name, means the board is the natural result of
// "order by ms, take ten" — there is no way for one player to hold every place,
// and no scan over an ever-growing pile of runs.
//
// Failure policy: a leaderboard is not worth taking the game down for. Every
// operation here catches; writes are dropped with a log line and reads come
// back empty, so a Firestore outage costs the boards and nothing else.

import {
    SOLO_LIMIT, MATCH_LIMIT, normaliseRun, normaliseMatch, runDocId, stamp,
} from "./shape.js";

// How long /health waits for an answer before calling it a failure.
const HEALTH_TIMEOUT_MS = 8000;

// One log line per failing operation kind, not one per call: a Firestore that
// is down is down for every shot, and a game's worth of identical stack traces
// buries anything else in the log.
function makeReporter() {
    const said = new Set();
    return (op, err) => {
        if (said.has(op)) return;
        said.add(op);
        console.error(`leaderboard ${op} failed (further ones silent):`, err.message);
    };
}

/**
 * @param {object} [opts]
 * @param {object} [opts.db]         an existing Firestore handle (tests pass one)
 * @param {string} [opts.namespace]  collection prefix; hvrc-web is a shared project
 */
export function createFirestoreStore({ db = null, namespace = process.env.STORE_NAMESPACE || "carrom" } = {}) {
    const report = makeReporter();
    const SOLO = `${namespace}-solo-runs`;
    const MATCHES = `${namespace}-matches`;

    // Imported on first use rather than at startup: the server boots and serves
    // games whether or not Firestore is reachable.
    //
    // FIRESTORE_DATABASE names the database, and naming it matters here: the
    // hvrc-web project's (default) database is in Datastore mode, which this
    // client cannot talk to, and the convention in that project is a Native
    // database per app. Unset means (default), which is right for the emulator
    // and wrong for production — so deploy.sh sets it.
    let handle = db ? Promise.resolve(db) : null;
    function database() {
        // A failed connection is forgotten rather than cached, so a server that
        // started while Firestore was unreachable picks it up when it returns
        // instead of staying broken until someone redeploys.
        if (!handle) {
            handle = connect().catch((err) => { handle = null; throw err; });
        }
        return handle;
    }

    async function connect() {
        // Credentials are checked HERE, before Firestore is asked for anything.
        //
        // Not belt-and-braces: when there are no application-default credentials
        // the failure surfaces inside google-gax's own stub setup, on a promise
        // nothing awaits — so it arrives as an unhandled rejection and Node
        // kills the process. A leaderboard cannot be allowed to take the game
        // server down with it. Asking for the credentials ourselves turns that
        // into an ordinary rejection of a call we await, which the callers above
        // already handle. Verified by running the server with no credentials:
        // it now serves games and reports the leaderboard as unhealthy.
        //
        // The emulator wants no credentials at all, so skip the check there.
        if (!process.env.FIRESTORE_EMULATOR_HOST) {
            const { GoogleAuth } = await import("google-auth-library");
            await new GoogleAuth({
                scopes: ["https://www.googleapis.com/auth/datastore"],
            }).getClient();
        }
        const { Firestore } = await import("@google-cloud/firestore");
        return new Firestore({
            projectId: process.env.GOOGLE_CLOUD_PROJECT || undefined,
            databaseId: process.env.FIRESTORE_DATABASE || undefined,
        });
    }

    const runsFor = (fdb, coinCount) =>
        fdb.collection(SOLO).doc(String(Number(coinCount) || 0)).collection("runs");

    return {
        backend: "firestore",

        /**
         * A playground run that cleared the board. Only a player's BEST run for
         * a rack is kept, so this is a compare-and-set: read the current best
         * inside a transaction and write only if this one beats it. Without the
         * transaction two runs landing together could both read "no record" and
         * the slower one could win by writing second.
         */
        async recordSoloRun(run) {
            const clean = normaliseRun(run, stamp());
            try {
                const fdb = await database();
                const ref = runsFor(fdb, clean.coinCount).doc(runDocId(clean.username));
                await fdb.runTransaction(async (tx) => {
                    const snap = await tx.get(ref);
                    if (snap.exists && snap.data().ms <= clean.ms) return;
                    tx.set(ref, clean);
                });
            } catch (err) {
                report("write (solo run)", err);
            }
        },

        /** The board for one rack: fastest first, one row per player. */
        async topSoloRuns(coinCount, limit = SOLO_LIMIT) {
            try {
                const fdb = await database();
                const snap = await runsFor(fdb, coinCount).orderBy("ms").limit(limit).get();
                return snap.docs.map((d) => d.data());
            } catch (err) {
                report("read (solo runs)", err);
                return [];
            }
        },

        /** A finished match: who played, and the games each won. */
        async recordMatch(match) {
            const clean = normaliseMatch(match, stamp());
            try {
                const fdb = await database();
                await fdb.collection(MATCHES).add(clean);
            } catch (err) {
                report("write (match)", err);
            }
        },

        /** The most recent finished matches, newest first. */
        async recentMatches(limit = MATCH_LIMIT) {
            try {
                const fdb = await database();
                const snap = await fdb.collection(MATCHES)
                    .orderBy("at", "desc").limit(limit).get();
                return snap.docs.map((d) => d.data());
            } catch (err) {
                report("read (matches)", err);
                return [];
            }
        },

        /**
         * Can this actually reach its database?
         *
         * Deliberately NOT wrapped in the swallow-everything policy above: the
         * point of this one is to surface the failure. Every other read comes
         * back empty when Firestore is unreachable, which is right for a player
         * mid-game and useless for a deploy that needs to know whether the
         * leaderboard it just shipped is writing anywhere.
         */
        async health() {
            const detail = `${namespace} @ ${process.env.FIRESTORE_DATABASE || "(default)"}`;
            try {
                // Bounded on purpose. The client retries a failing call for the
                // best part of a minute, and a deploy gate that hangs that long
                // is worse than one that says "no": an answer is the point.
                await Promise.race([
                    database().then((fdb) => fdb.collection(MATCHES).limit(1).get()),
                    new Promise((_, reject) => setTimeout(
                        () => reject(new Error(`no answer in ${HEALTH_TIMEOUT_MS}ms`)),
                        HEALTH_TIMEOUT_MS,
                    ).unref()),
                ]);
                return { backend: "firestore", ok: true, detail };
            } catch (err) {
                return { backend: "firestore", ok: false, detail: `${detail}: ${err.message}` };
            }
        },

        /**
         * Tests and local resets. Deletes the match list and every rack's runs.
         * Not a production path — there is no admin route that reaches this.
         */
        async reset() {
            try {
                const fdb = await database();
                const gone = [];
                const matches = await fdb.collection(MATCHES).get();
                for (const doc of matches.docs) gone.push(doc.ref.delete());
                const racks = await fdb.collection(SOLO).listDocuments();
                for (const rack of racks) {
                    const runs = await rack.collection("runs").get();
                    for (const doc of runs.docs) gone.push(doc.ref.delete());
                }
                await Promise.all(gone);
            } catch (err) {
                report("reset", err);
            }
        },
    };
}

export default createFirestoreStore;
