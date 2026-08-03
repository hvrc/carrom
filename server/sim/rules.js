// Carrom rule resolution: colour claiming, scoring, the queen, striker fouls,
// continue-vs-pass, and game-over. Called once per flick after the board settles.
// Mutates state and returns what happened — including the `transfers` the clients
// animate (a pocketed coin walking to the ledge, a refunded coin returning to the
// centre, the striker sliding across to the opponent).
//
// Scoring model (PRD F7–F11):
//   * A coin is worth 1 point to the player who OWNS ITS COLOUR, whoever potted it.
//   * The queen is worth 1 point, and only once covered.
//   * A striker foul costs exactly 1 point — never two. The score may go negative:
//     a player on 0 who fouls shows −1. The foul ALSO costs a physical coin, which
//     comes off your ledge and back onto the board. With an empty ledge you owe the
//     board a coin (`debts`), paid from the next coin you pocket — and paying it
//     does NOT dock you again, because the point was taken at the moment of the foul.
import {
    CENTER_X, CENTER_Y, MAX_TURNS_IN_A_ROW, baselineYFor, ledgeSlot,
} from "./geometry.js";
import { respawnAtCenter, QUEEN_ID } from "./state.js";

export function otherRole(role) {
    return role === "creator" ? "joiner" : "creator";
}

const OPPOSITE = { white: "black", black: "white" };

// Which player owns a colour — null while the colour is still unclaimed.
export function roleForColor(state, color) {
    if (state.colors.creator === color) return "creator";
    if (state.colors.joiner === color) return "joiner";
    return null;
}

// F7. Colours belong to nobody until the first coin is pocketed; whoever pockets
// it claims that colour, and their opponent gets the other. The queen claims
// nothing — so a player whose first pocket is the queen may cover with any coin,
// and that covering coin, being their first pocketed coin, sets their colour.
function claimColorIfUnclaimed(state, actor, color) {
    if (color === "red") return;
    if (state.colors.creator || state.colors.joiner) return;
    state.colors[actor] = color;
    state.colors[otherRole(actor)] = OPPOSITE[color];
}

const move = (kind, id, color, from, to) => ({ kind, id, color, from: { ...from }, to: { ...to } });

// Park a coin on its owner's ledge, and declare the walk from pocket to ledge.
function toLedge(state, owner, coin, from, transfers) {
    const pile = state.pocketedPiles[owner];
    pile.push({ id: coin.id, color: coin.color });
    transfers.push(move("coin", coin.id, coin.color, from, ledgeSlot(owner, pile.length - 1)));
}

// Take a coin off a ledge and put it back on the board, animating the return.
// Used by fouls, debt payments, and the refused finishing coin.
function backToBoard(state, role, pileIndex, transfers) {
    const pile = state.pocketedPiles[role];
    const [coin] = pile.splice(pileIndex, 1);
    const from = ledgeSlot(role, pileIndex);
    const live = respawnAtCenter(state, coin.color, coin.id);
    // Handing the queen back to the board un-covers it.
    if (coin.color === "red") {
        state.queenState = "on_board";
        state.queenPocketedBy = null;
        state.queenPocketPos = null;
    }
    transfers.push(move("coin", coin.id, coin.color, from, { x: live.x, y: live.y }));
    return coin;
}

function coverQueen(state, actor, transfers) {
    state.queenState = "covered";
    state.scores[actor] += 1; // F8: the queen is worth 1, not 5
    const from = state.queenPocketPos || { x: CENTER_X, y: CENTER_Y };
    state.queenPocketedBy = null;
    state.queenPocketPos = null;
    // The queen joins the coverer's ledge like any other coin — which also means a
    // later foul can hand it straight back to the board.
    toLedge(state, actor, { id: QUEEN_ID, color: "red" }, from, transfers);
}

function returnQueenToCentre(state, transfers) {
    const from = state.queenPocketPos || { x: CENTER_X, y: CENTER_Y };
    state.queenState = "on_board";
    state.queenPocketedBy = null;
    state.queenPocketPos = null;
    const live = respawnAtCenter(state, "red", QUEEN_ID);
    transfers.push(move("coin", QUEEN_ID, "red", from, { x: live.x, y: live.y }));
}

const liveCountOfColor = (state, color) =>
    state.coins.filter((c) => !c.pocketed && c.color === color).length;

// Returns { strikerPocketed, continuedTurn, gameOver, winner, transfers }.
export function resolveTurn(state, pocketedThisTurn, actor, opts = {}) {
    // Practice room: there is nobody to hand the turn to. Keeping the turn here
    // rather than patching it afterwards matters, because step 8 places the
    // striker on whoever's baseline is next — patch it later and the striker has
    // already been sent to the empty side of the board.
    const solo = !!opts.solo;
    const strikerFoul = state.striker.pocketed;
    const strikerEvent = pocketedThisTurn.find((p) => p.kind === "striker");
    const transfers = [];
    let continuedTurn = false;
    let gameOver = false;
    let winner = null;

    // --- 1. Colours are claimed by the first coin pocketed (F7) ---
    for (const p of pocketedThisTurn) {
        if (p.kind !== "striker" && p.color !== "red") {
            claimColorIfUnclaimed(state, actor, p.color);
            break;
        }
    }

    // --- 2. Credit each coin to the owner of its colour ---
    // Practice: there is no opponent to own the other colour, so everything you
    // pocket is yours and lands on your ledge.
    const credited = [];
    for (const p of pocketedThisTurn) {
        if (p.kind === "striker" || p.color === "red") continue;
        const owner = solo ? actor : roleForColor(state, p.color);
        if (!owner) continue; // unreachable: pocketing a coin always claims a colour
        state.scores[owner] += 1;
        toLedge(state, owner, p, p.pocket, transfers);
        credited.push({ id: p.id, color: p.color, owner });
    }

    // --- 3. Queen ---
    const queenEvent = pocketedThisTurn.find((p) => p.color === "red");
    const myColor = state.colors[actor];
    const ownColorPocketed = solo
        ? credited.length > 0
        : credited.some((c) => c.color === myColor);

    if (queenEvent && state.queenState === "on_board") {
        state.queenState = "pocketed_uncovered";
        state.queenPocketedBy = actor;
        state.queenPocketPos = { ...queenEvent.pocket };
    }

    if (state.queenState === "pocketed_uncovered" && state.queenPocketedBy === actor) {
        if (queenEvent && strikerFoul) {
            returnQueenToCentre(state, transfers);   // fouled on the queen shot
        } else if (queenEvent && ownColorPocketed) {
            coverQueen(state, actor, transfers);     // potted AND covered in one turn
        } else if (!queenEvent) {
            // The cover turn — the queen went down on an earlier flick.
            if (ownColorPocketed && !strikerFoul) coverQueen(state, actor, transfers);
            else returnQueenToCentre(state, transfers);
        }
        // else: queen potted alone, no foul → stays pending for the cover turn.
    }

    // --- 4. Striker foul: one point, and one coin back to the board (F10) ---
    if (strikerFoul) {
        state.scores[actor] -= 1; // no floor: 0 → −1 → −2 …
        const pile = state.pocketedPiles[actor];
        if (pile.length > 0) {
            backToBoard(state, actor, pile.length - 1, transfers);
        } else {
            state.debts[actor] += 1; // nothing to give: owe the board a coin
        }
    }

    // --- 5. Pay outstanding coin debts off the ledge ---
    // Coin only. The point was already taken at the foul; taking another here is
    // the double punishment we ruled out.
    for (const role of ["creator", "joiner"]) {
        while (state.debts[role] > 0 && state.pocketedPiles[role].length > 0) {
            backToBoard(state, role, state.pocketedPiles[role].length - 1, transfers);
            state.debts[role] -= 1;
        }
    }

    // --- 6. The finishing coin only counts if the queen is covered (F9) ---
    // Otherwise it returns to the centre and scores nothing. This applies to
    // whichever colour was cleared — including the case where the actor clears
    // their OPPONENT's colour by potting the opponent's last coin.
    const refused = new Set();
    if (!solo && state.queenState !== "covered") {
        for (const role of ["creator", "joiner"]) {
            const color = state.colors[role];
            if (!color || liveCountOfColor(state, color) > 0) continue;

            const last = [...credited].reverse().find((c) => c.color === color);
            if (!last) continue;
            const pile = state.pocketedPiles[role];
            const idx = pile.findIndex((c) => c.id === last.id);
            if (idx === -1) continue; // already taken back by a debt payment

            // Rewrite its journey: it never reaches the ledge. It goes back to the
            // centre from the pocket it fell into.
            const declared = transfers.findIndex((t) => t.kind === "coin" && t.id === last.id);
            const from = declared !== -1 ? transfers[declared].from : ledgeSlot(role, idx);
            if (declared !== -1) transfers.splice(declared, 1);

            pile.splice(idx, 1);
            state.scores[role] -= 1;
            const live = respawnAtCenter(state, last.color, last.id);
            transfers.push(move("coin", last.id, last.color, from, { x: live.x, y: live.y }));
            refused.add(last.id);
        }
    }

    // --- 7. Continue or pass ---
    // A refused coin buys nothing: it did not count, so it cannot extend the turn.
    const effectivelyPocketedOwn = credited.some(
        (c) => c.color === myColor && !refused.has(c.id),
    );
    const queenPendingCover =
        state.queenState === "pocketed_uncovered" && state.queenPocketedBy === actor;

    if (!strikerFoul &&
        (effectivelyPocketedOwn || queenPendingCover) &&
        state.continuedTurnCount < MAX_TURNS_IN_A_ROW) {
        continuedTurn = true;
        state.continuedTurnCount += 1;
    } else {
        continuedTurn = false;
        state.continuedTurnCount = 0;
        state.whoseTurn = solo ? actor : otherRole(actor);
    }

    // --- 8. Hand the striker to whoever is on now (animated, not teleported) ---
    const strikerFrom = strikerFoul && strikerEvent
        ? { ...strikerEvent.pocket }
        : { x: state.striker.x, y: state.striker.y };
    state.striker.pocketed = false;
    state.striker.velocity = { x: 0, y: 0 };
    state.striker.x = CENTER_X;
    state.striker.y = baselineYFor(state.whoseTurn);
    transfers.push(move("striker", null, null, strikerFrom, { x: state.striker.x, y: state.striker.y }));

    // --- 9. Game over: a colour is cleared AND the queen is covered ---
    // Covered by ANYONE: if your opponent covered the queen and you then clear your
    // colour, you still win.
    if (!solo && state.queenState === "covered") {
        for (const role of ["creator", "joiner"]) {
            const color = state.colors[role];
            if (!color) continue;
            if (liveCountOfColor(state, color) === 0) {
                gameOver = true;
                winner = role;
                break;
            }
        }
    }
    if (gameOver) {
        state.gameOver = true;
        state.winner = winner;
    }

    return { strikerPocketed: strikerFoul, continuedTurn, gameOver, winner, transfers };
}
