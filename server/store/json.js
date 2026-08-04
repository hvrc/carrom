// Leaderboards in a JSON file. The development backend, and the fallback.
//
// Written atomically — temp file, then rename — so a crash mid-write cannot
// leave half a file behind. That is enough for one server holding one file,
// which is what a local `npm run dev` is.
//
// This does NOT survive a Cloud Run deploy: the container's disk is thrown away
// with the container. Production runs the Firestore backend for that reason;
// see ./firestore.js and the chooser in ./index.js.

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
    SOLO_LIMIT, MATCH_LIMIT, normaliseRun, normaliseMatch, rankSoloRuns, stamp,
} from "./shape.js";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = join(here, "..", "data", "store.json");

const EMPTY = { soloRuns: [], matches: [] };

export function createJsonStore({ file = process.env.STORE_FILE || DEFAULT_FILE } = {}) {
    let cache = null;
    // Every change runs on this chain, one after another. Read-modify-write is
    // NOT atomic on its own: two results landing together both read the same
    // list, and the second write erases the first. Queueing the whole operation
    // — not just the write — is what stops that.
    let chain = Promise.resolve();

    async function readAll() {
        if (cache) return cache;
        try {
            const raw = await readFile(file, "utf8");
            const parsed = JSON.parse(raw);
            cache = { soloRuns: parsed.soloRuns || [], matches: parsed.matches || [] };
        } catch {
            cache = { ...EMPTY };      // no file yet, or an unreadable one
        }
        return cache;
    }

    async function persist(next) {
        cache = next;
        await mkdir(dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        await writeFile(tmp, JSON.stringify(next, null, 2));
        await rename(tmp, file);       // atomic: readers see old or new, never half
    }

    /** Read, change, write — with no other change interleaving. */
    function update(mutate) {
        chain = chain.then(async () => {
            const data = await readAll();
            await persist(mutate(data));
        }).catch((err) => {
            console.error("store write failed:", err.message);
        });
        return chain;
    }

    return {
        backend: "json",

        recordSoloRun(run) {
            return update((data) => ({
                ...data,
                soloRuns: [...data.soloRuns, normaliseRun(run, stamp())],
            }));
        },

        async topSoloRuns(coinCount, limit = SOLO_LIMIT) {
            await chain;                       // let any queued write land first
            const { soloRuns } = await readAll();
            return rankSoloRuns(soloRuns, coinCount, limit);
        },

        recordMatch(match) {
            return update((data) => ({
                ...data,
                matches: [normaliseMatch(match, stamp()), ...data.matches]
                    .slice(0, MATCH_LIMIT * 4),
            }));
        },

        async recentMatches(limit = MATCH_LIMIT) {
            await chain;
            const { matches } = await readAll();
            return matches.slice(0, limit);
        },

        /** Can this actually reach its file? Same question /health asks Firestore. */
        async health() {
            try {
                await mkdir(dirname(file), { recursive: true });
                await readAll();
                return { backend: "json", ok: true, detail: file };
            } catch (err) {
                return { backend: "json", ok: false, detail: `${file}: ${err.message}` };
            }
        },

        /** Tests and local resets: forget everything, on disk and in memory. */
        reset() {
            return update(() => ({ soloRuns: [], matches: [] }));
        },
    };
}

export default createJsonStore;
