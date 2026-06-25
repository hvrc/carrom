// Carrom rule resolution: scoring, queen FSM, striker foul/due, continue-vs-pass,
// game-over. Called once per flick after the board settles. Mutates state.
import { CENTER_X, CENTER_Y, MAX_TURNS_IN_A_ROW, baselineYFor } from "./geometry.js";
import { respawnAtCenter } from "./state.js";

export function colorForRole(role) {
    return role === "creator" ? "white" : "black";
}

export function otherRole(role) {
    return role === "creator" ? "joiner" : "creator";
}

// Returns { strikerPocketed, continuedTurn, gameOver, winner }.
export function resolveTurn(state, pocketedThisTurn, actor) {
    const myColor = colorForRole(actor);

    const strikerFoul = state.striker.pocketed;
    let continuedTurn = false;
    let gameOver = false;
    let winner = null;

    // Score coins by colour, regardless of who potted them.
    for (const p of pocketedThisTurn) {
        if (p.color === "white") {
            state.scores.creator += 1;
            state.pocketedPiles.creator.push({ id: p.id, color: "white" });
        } else if (p.color === "black") {
            state.scores.joiner += 1;
            state.pocketedPiles.joiner.push({ id: p.id, color: "black" });
        }
        // queen handled below
    }

    // --- Queen state machine ---
    const queenPocketedThisTurn = pocketedThisTurn.find(p => p.color === "red");
    const ownColorPocketedThisTurn = pocketedThisTurn.some(p => p.color === myColor);

    if (queenPocketedThisTurn) {
        if (state.queenState === "on_board") {
            state.queenState = "pocketed_uncovered";
            state.queenPocketedBy = actor;
        }
    }

    if (state.queenState === "pocketed_uncovered" && state.queenPocketedBy === actor) {
        // Cover-turn rule. Same-stroke cover requires no foul; a foul voids it.
        if (queenPocketedThisTurn && ownColorPocketedThisTurn && !strikerFoul) {
            state.queenState = "covered";
            state.scores[actor] += 5; // queen bonus
            state.queenPocketedBy = null;
        } else if (queenPocketedThisTurn && strikerFoul) {
            state.queenState = "on_board";
            state.queenPocketedBy = null;
            respawnAtCenter(state, "red", 19);
        } else if (!queenPocketedThisTurn) {
            // Cover-turn attempt (queen potted on a previous flick).
            if (ownColorPocketedThisTurn && !strikerFoul) {
                state.queenState = "covered";
                state.scores[actor] += 5;
                state.queenPocketedBy = null;
            } else {
                state.queenState = "on_board";
                state.queenPocketedBy = null;
                respawnAtCenter(state, "red", 19);
            }
        }
        // else: queen potted alone, no foul -> stays pending (cover turn below).
    }

    // --- Striker foul ---
    if (strikerFoul) {
        const pile = state.pocketedPiles[actor];
        if (pile.length > 0) {
            const refund = pile.pop();
            if (refund.color === colorForRole(actor)) {
                state.scores[actor] = Math.max(0, state.scores[actor] - 1);
            }
            respawnAtCenter(state, refund.color, refund.id);
        } else {
            state.debts[actor] += 1;
        }
    }

    // --- Settle outstanding debt against current score (both players) ---
    for (const role of ["creator", "joiner"]) {
        if (state.debts[role] > 0 && state.scores[role] > 0) {
            const settle = Math.min(state.scores[role], state.debts[role]);
            state.scores[role] -= settle;
            state.debts[role] -= settle;
        }
    }

    // --- Continue turn vs switch ---
    const queenPendingCover = state.queenState === "pocketed_uncovered" &&
                              state.queenPocketedBy === actor;

    if (!strikerFoul &&
        (ownColorPocketedThisTurn || queenPendingCover) &&
        state.continuedTurnCount < MAX_TURNS_IN_A_ROW) {
        continuedTurn = true;
        state.continuedTurnCount += 1;
    } else {
        continuedTurn = false;
        state.continuedTurnCount = 0;
        state.whoseTurn = otherRole(actor);
    }

    // --- Reset striker for next flick ---
    state.striker.pocketed = false;
    state.striker.velocity = { x: 0, y: 0 };
    state.striker.x = CENTER_X;
    state.striker.y = baselineYFor(state.whoseTurn);

    // --- Game-over check ---
    // Ends as soon as EITHER colour is cleared and the queen is settled. Robust
    // to fouls (which refund a coin), the continue cap, and who potted last.
    const liveCoins = state.coins.filter(c => !c.pocketed);
    const whiteLeft = liveCoins.filter(c => c.color === "white").length;
    const blackLeft = liveCoins.filter(c => c.color === "black").length;
    const queenSettled = state.queenState !== "pocketed_uncovered";
    if (queenSettled && (whiteLeft === 0 || blackLeft === 0)) {
        gameOver = true;
        if (state.scores.creator > state.scores.joiner) winner = "creator";
        else if (state.scores.joiner > state.scores.creator) winner = "joiner";
        else winner = null;
        state.gameOver = true;
        state.winner = winner;
    }

    return { strikerPocketed: strikerFoul, continuedTurn, gameOver, winner };
}
