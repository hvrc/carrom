// What a leaderboard row IS, independent of where it is kept.
//
// Both backends — the JSON file and Firestore — share this, so a run recorded
// against one and read back from the other means the same thing. Ranking rules
// live here rather than in a query, because the two stores cannot express the
// same query and the rules must not drift.

export const SOLO_LIMIT = 10;      // top N playground runs
export const MATCH_LIMIT = 10;     // last N finished matches

/** Nobody is made to sign in to practise. An empty name is "?" everywhere. */
export const normaliseName = (username) => (username || "?").trim() || "?";

// A clock that never repeats itself.
//
// "Newest first" is decided entirely by this stamp, and two matches finishing
// inside the same millisecond would otherwise tie — leaving their order up to
// whatever the store felt like. Firestore cannot break such a tie without a
// second sort field, and a second sort field needs a composite index. Nudging
// the clock forward instead costs nothing and makes the order total.
let lastStamp = 0;
export function stamp() {
    lastStamp = Math.max(Date.now(), lastStamp + 1);
    return lastStamp;
}

/** A playground run, cleaned. `at` is stamped by the caller so this stays pure. */
export function normaliseRun({ username, coinCount, ms }, at) {
    return {
        username: normaliseName(username),
        coinCount: Number(coinCount) || 0,
        ms: Math.max(0, Math.round(ms)),
        at,
    };
}

/** A finished match, cleaned: who played, and the games each won. */
export function normaliseMatch({ players, wins }, at) {
    return {
        players: (players || []).map(normaliseName),
        wins: (wins || []).map((w) => Number(w) || 0),
        at,
    };
}

/**
 * The board: best run per player for one rack, fastest first.
 *
 * One row per name is the point — a player with an afternoon to spare should
 * not be able to take all ten places. The JSON backend needs this because it
 * keeps every run; Firestore keeps only each player's best, so for it this is
 * just the sort. Both call it, so both rank the same way.
 */
export function rankSoloRuns(runs, coinCount, limit = SOLO_LIMIT) {
    const rack = Number(coinCount);
    const best = new Map();
    for (const run of runs) {
        if (rack && run.coinCount !== rack) continue;
        const seen = best.get(run.username);
        if (!seen || run.ms < seen.ms) best.set(run.username, run);
    }
    return [...best.values()].sort((a, b) => a.ms - b.ms).slice(0, limit);
}

/**
 * A username as a Firestore document id.
 *
 * Percent-encoding gets rid of "/" (which would read as a path) and the prefix
 * keeps clear of the ids Firestore reserves: "." and "..", and anything of the
 * form __name__. The display name is stored in the document, so this only has
 * to be unique and legal, not readable.
 */
export const runDocId = (username) => `u_${encodeURIComponent(normaliseName(username))}`;
