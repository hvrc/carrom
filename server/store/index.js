// What survives a restart: playground runs and finished matches.
//
// Everything else in this server is deliberately in memory — rooms die with the
// process, and that is fine. These two lists are the exception, because a
// leaderboard that empties on every deploy is not a leaderboard.
//
// Two backends behind one interface:
//
//   json        a file, written atomically. Local development. No credentials,
//               no network, and the data is right there to look at.
//   firestore   Cloud Run, where the container's disk does not outlive a deploy.
//
// The choice is automatic: K_SERVICE is set by Cloud Run and by nothing else, so
// production picks Firestore without any deploy-time flag to forget, and a
// developer who has never heard of Firestore still gets a working leaderboard.
// STORE_BACKEND overrides it either way.

import { createJsonStore } from "./json.js";
import { createFirestoreStore } from "./firestore.js";

export { SOLO_LIMIT, MATCH_LIMIT } from "./shape.js";

/**
 * @param {object} [opts]
 * @param {"json"|"firestore"} [opts.backend]
 * @param {string} [opts.file]        json backend: where to keep it
 * @param {object} [opts.db]          firestore backend: an existing handle
 * @param {string} [opts.namespace]   firestore backend: collection prefix
 */
export function createStore(opts = {}) {
    const backend = opts.backend
        || process.env.STORE_BACKEND
        || (process.env.K_SERVICE ? "firestore" : "json");

    const store = backend === "firestore"
        ? createFirestoreStore(opts)
        : createJsonStore(opts);

    console.log(`leaderboards: ${store.backend} backend`);
    return store;
}

export default createStore;
