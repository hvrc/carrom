// The computer player.
//
// It plays by actually playing: every shot it considers is run through the same
// simulation and the same rules the game uses, on a copy of the board, and it
// keeps the one it liked best. There is no separate model of carrom here that
// could drift from the real one.
//
// Two things make that affordable. `aim.js` proposes only shots with a reason
// to exist, so there are dozens to try rather than thousands. And the trying is
// SLICED: the planner works for a few milliseconds, hands the event loop back,
// and resumes. Without that, a bot thinking would freeze the physics of every
// other game on the server for a third of a second — one player's opponent
// would stutter every other player's shot.
//
// DIFFICULTY (0 = hopeless, 1 = deadly) is one number that moves three things:
// how many shots it looks at, whether it takes the best one it found, and how
// accurately it hits what it aimed at. Missing is modelled the way people miss
// — the bot picks a good shot and then plays it slightly wrong, rather than
// picking a bad shot on purpose.
//
// The game is fixed at MEDIUM. The parameter exists because a difficulty you
// cannot dial is a difficulty you cannot test: the tests set it to 0 and 1 to
// prove it means something.

import { simulateFlickSync } from "../sim/step.js";
import { candidateShots, safeShot } from "./aim.js";
import { scoreOutcome } from "./score.js";

/** The one the game ships with. Not exposed in the UI, by design. */
export const MEDIUM = 0.5;

// The dials difficulty moves. The extremes are what difficulty 0 and 1 mean.
const TUNING = {
    // Shots looked at: 14 at the bottom, 46 at the top.
    candidatesMin: 14,
    candidatesMax: 46,
    // Aim error in radians at difficulty 0. About 8°, which is enough to miss
    // a straightforward pot from mid-board most of the time. Tuned upwards from
    // 5°, where the weakest bot still scored on a quarter of its turns and the
    // bottom half of the scale hardly differed from the middle.
    aimErrorMax: 0.14,
    // And how far off the intended weight it hits, as a fraction.
    forceErrorMax: 0.3,
    // How deep into its own ranking it is willing to reach. At difficulty 0 it
    // takes one of the top 7 at random; at 1 it always takes the best.
    reachMax: 6,
};

const lerp = (a, b, t) => a + (b - a) * t;

/** Uniform noise in [-spread, +spread], softened towards the middle. */
function jitter(spread, random) {
    // Two samples rather than one: errors cluster near zero and the wild miss
    // is rare, which is how a person misses.
    return spread * ((random() + random()) - 1);
}

/**
 * Everything the bot decided, for tests and for the log. `intended` is the shot
 * it meant to play; `shot` is the one it actually plays after its own error is
 * applied — the difference between those two IS the difficulty.
 */
function decision(shot, intended, extra) {
    return { ...extra, shot, intended };
}

/**
 * Pick a shot.
 *
 * Runs in slices: `yieldEvery` milliseconds of work, then a turn of the event
 * loop. Await it; it is not fast and it is not meant to be.
 *
 * @param {object} state      the live game state (never mutated)
 * @param {string} role       which seat the bot is playing
 * @param {object} [opts]
 * @param {number} [opts.difficulty]
 * @param {Function} [opts.random]      injectable for deterministic tests
 * @param {number} [opts.yieldEvery]    ms of work between breaths
 */
export async function planShot(state, role, opts = {}) {
    const difficulty = Math.max(0, Math.min(1, opts.difficulty ?? MEDIUM));
    const random = opts.random || Math.random;
    // Measured, thinking about a full 19-coin board while a 16ms timer runs:
    //
    //   no slicing   110ms of tick delay — seven frames gone
    //   12ms slices   10ms
    //   4ms slices     7ms
    //
    // Slicing at all is what matters; the exact budget barely does. 4ms is
    // chosen for headroom, because the budget is checked AFTER a simulation and
    // a long shot can overrun it by several milliseconds on its own.
    const yieldEvery = opts.yieldEvery ?? 4;

    const budget = Math.round(lerp(TUNING.candidatesMin, TUNING.candidatesMax, difficulty));
    const candidates = candidateShots(state, role, budget);
    if (candidates.length === 0) {
        return decision(safeShot(state, role), null, { reason: "nothing on", considered: 0 });
    }

    const before = {
        scores: { ...state.scores },
        colors: { ...state.colors },
    };

    const judged = [];
    let sliceStart = Date.now();
    for (const candidate of candidates) {
        // A firmer version of the same shot as well: being slightly short is
        // the difference between a coin in the pocket and a coin beside it, and
        // the geometry cannot tell which side of that line it is on.
        for (const force of [candidate.force, Math.min(1, candidate.force + 0.22)]) {
            const shot = { strikerX: candidate.strikerX, angle: candidate.angle, force };
            const board = structuredClone(state);
            const { resolution } = simulateFlickSync(board, shot, role);
            judged.push({
                shot,
                targetId: candidate.targetId,
                value: scoreOutcome(before, board, resolution, role),
            });

            if (Date.now() - sliceStart >= yieldEvery) {
                await new Promise((resume) => setImmediate(resume));
                sliceStart = Date.now();
            }
        }
    }

    judged.sort((a, b) => b.value - a.value);

    // Which of them it takes. A weaker bot reaches further down its own list —
    // it is not that it cannot tell which shot is best, it is that it does not
    // always play it. The bias keeps even a bad bot mostly near the top.
    const reach = Math.round(lerp(TUNING.reachMax, 0, difficulty));
    const pick = reach === 0
        ? 0
        : Math.min(judged.length - 1, Math.floor(random() ** 2 * (reach + 1)));
    const chosen = judged[pick];

    // And then it misses, by an amount difficulty decides. This is applied to
    // the shot it MEANT to play, so what the bot intended stays inspectable.
    //
    // Squared, not linear, and measured rather than guessed. Aim error is
    // brutally non-linear in its effect: at 2° off the bot scored on a third of
    // its turns, at 0° on four fifths. A linear dial spent its whole bottom
    // half between "bad" and "slightly less bad" — every setting below the top
    // played about the same, because a hard break pots coins by luck whatever
    // the aim, which puts a floor of roughly a fifth of turns under even the
    // worst bot. Squaring puts the middle of the dial in the middle of the
    // range of play that is actually reachable.
    const miss = (1 - difficulty) ** 2;
    const aimError = jitter(TUNING.aimErrorMax * miss, random);
    const forceError = jitter(TUNING.forceErrorMax * miss, random);
    const played = {
        strikerX: chosen.shot.strikerX,
        angle: chosen.shot.angle + aimError,
        force: Math.max(0.12, Math.min(1, chosen.shot.force * (1 + forceError))),
    };

    return decision(played, chosen.shot, {
        reason: "planned",
        considered: judged.length,
        rank: pick,
        value: chosen.value,
        targetId: chosen.targetId,
        aimError,
    });
}

export default planShot;
