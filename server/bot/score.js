// What a shot was worth, judged after the fact.
//
// The bot does not estimate outcomes: it plays each candidate out in the real
// simulation, with the real rules, and looks at the board that comes back. So
// this module never has to model carrom — the queen, colour claiming, fouls,
// debts and the finishing-coin rule have all already happened by the time it
// is asked. It only has to say how much it liked the result.
//
// The weights are ordered by how much a human would care, and the gaps between
// them are deliberate: potting beats position by enough that the bot will never
// pass up a pot to tidy the board, and a foul costs more than a pot gains, so
// it will not take a wild shot at a coin while risking the striker.

import { POCKETS } from "../sim/geometry.js";

// How close to a pocket a coin has to be before its position is worth
// anything. Roughly a quarter of the board — past that, "near a pocket" stops
// meaning much.
const NEAR = 300;

export const WEIGHTS = {
    myPoint: 10,        // a point for me
    theirPoint: -9,     // a point for them: nearly as bad as mine is good
    foul: -6,           // on top of the point the rules already took
    continued: 3,       // another turn is worth having
    // Ending the game dominates absolutely, and deliberately so: at ±120 a turn
    // that scored enough points could out-value handing the opponent the win,
    // which is never a trade worth making. Nothing else on this scale can reach
    // ±400, so a winning shot is always taken and a losing one never is.
    win: 400,
    loss: -400,
    position: 0.6,      // only ever a tie-breaker
};

/** How well placed one side's coins are: near a pocket is worth something. */
export function nearness(coins, color) {
    if (!color) return 0;
    let total = 0;
    for (const c of coins) {
        if (c.pocketed || c.color !== color) continue;
        let best = Infinity;
        for (const p of POCKETS) best = Math.min(best, Math.hypot(c.x - p.x, c.y - p.y));
        if (best < NEAR) total += 1 - best / NEAR;
    }
    return total;
}

/**
 * Judge a played-out shot.
 *
 * @param {object} before  scores/colors as they were, plus the coins
 * @param {object} after   the state the simulation produced
 * @param {object} outcome what resolveTurn reported
 * @param {string} role
 */
export function scoreOutcome(before, after, outcome, role) {
    const them = role === "creator" ? "joiner" : "creator";
    const myGain = after.scores[role] - before.scores[role];
    const theirGain = after.scores[them] - before.scores[them];

    let score = 0;
    score += WEIGHTS.myPoint * myGain;
    score += WEIGHTS.theirPoint * theirGain;
    if (outcome.strikerPocketed) score += WEIGHTS.foul;
    if (outcome.continuedTurn) score += WEIGHTS.continued;
    if (outcome.gameOver) score += outcome.winner === role ? WEIGHTS.win : WEIGHTS.loss;

    // Colours may have been claimed by this very shot, so read them from the
    // board as it is now — before the shot they may not have existed.
    const myColor = after.colors[role];
    const theirColor = after.colors[them];
    score += WEIGHTS.position * (
        nearness(after.coins, myColor) - nearness(after.coins, theirColor)
    );

    return score;
}
