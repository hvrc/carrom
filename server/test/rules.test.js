// Rule resolution: claimed colours, the queen, fouls, the refused finishing
// coin, negative scores, game over.  cd server && npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    createInitialState, resolveTurn, roleForColor, ledgeSlot,
    POCKETS, CENTER_X, QUEEN_ID,
} from "../physics.js";

const P = POCKETS[0];

// Pocket a real coin of `color`, exactly as the simulation would: the coin is
// flagged pocketed IN STATE (resolveTurn reads that, not the event) and the
// matching pocket event is returned.
const potOf = (s, color) => {
    const coin = s.coins.find((c) => !c.pocketed && c.color === color);
    assert.ok(coin, `no live ${color} coin left to pocket`);
    coin.pocketed = true;
    return { kind: "coin", id: coin.id, color, pocket: { ...P }, from: { x: P.x, y: P.y }, t: 100 };
};

const potQueen = (s) => potOf(s, "red");

// A striker foul. The simulation flags state.striker.pocketed when it goes down,
// and resolveTurn reads that flag — so a unit test has to set it too.
const foul = (s, alsoPotted = []) => {
    s.striker.pocketed = true;
    return [...alsoPotted, { kind: "striker", pocket: { ...P }, from: { x: P.x, y: P.y }, t: 100 }];
};

// Give the players colours without playing a turn to claim them.
const withColors = (s, creatorColor) => {
    s.colors.creator = creatorColor;
    s.colors.joiner = creatorColor === "white" ? "black" : "white";
    return s;
};

// Silently take a colour off the board, leaving `leave` of them.
const clearColor = (s, color, leave = 0) => {
    const live = s.coins.filter((c) => !c.pocketed && c.color === color);
    for (const c of live.slice(0, live.length - leave)) c.pocketed = true;
};

const liveOf = (s, color) => s.coins.filter((c) => !c.pocketed && c.color === color).length;

// ── F7: colours are claimed, not assigned ───────────────────────────────────

test("nobody owns a colour until the first coin is pocketed", () => {
    const s = createInitialState();
    assert.deepEqual(s.colors, { creator: null, joiner: null });
});

test("the first coin pocketed claims that colour for whoever potted it", () => {
    const s = createInitialState();
    // The JOINER pots a white coin. Under the old seat-based rule white was the
    // creator's by birthright; now it belongs to the joiner because they took it.
    resolveTurn(s, [potOf(s, "white")], "joiner");
    assert.equal(s.colors.joiner, "white");
    assert.equal(s.colors.creator, "black");
    assert.equal(s.scores.joiner, 1);
    assert.equal(s.scores.creator, 0);
});

test("once claimed, a colour stays put — later pockets score for its owner", () => {
    const s = createInitialState();
    resolveTurn(s, [potOf(s, "white")], "creator");   // creator claims white
    resolveTurn(s, [potOf(s, "white")], "joiner");    // joiner pots a white: it's the creator's
    assert.equal(s.colors.creator, "white");
    assert.equal(s.scores.creator, 2);
    assert.equal(s.scores.joiner, 0);
    assert.equal(roleForColor(s, "white"), "creator");
});

test("a queen-first pocket claims nothing; the covering coin sets the colour", () => {
    const s = createInitialState();
    // Turn 1: creator pots ONLY the queen. No colour is claimed by it.
    resolveTurn(s, [potQueen(s)], "creator");
    assert.deepEqual(s.colors, { creator: null, joiner: null });
    assert.equal(s.queenState, "pocketed_uncovered");

    // Turn 2 (their cover turn): they cover with a BLACK coin — so black is theirs.
    resolveTurn(s, [potOf(s, "black")], "creator");
    assert.equal(s.colors.creator, "black");
    assert.equal(s.colors.joiner, "white");
    assert.equal(s.queenState, "covered");
});

// ── F8: the queen is worth one point ────────────────────────────────────────

test("covering the queen scores 1, not 5", () => {
    const s = withColors(createInitialState(), "white");
    // Pot the queen and a white coin on the same stroke: 1 for the coin + 1 queen.
    resolveTurn(s, [potQueen(s), potOf(s, "white")], "creator");
    assert.equal(s.queenState, "covered");
    assert.equal(s.scores.creator, 2, "one for the coin, one for the queen");
});

test("an uncovered queen goes back to the centre and scores nothing", () => {
    const s = withColors(createInitialState(), "white");
    resolveTurn(s, [potQueen(s)], "creator");   // potted, pending cover
    assert.equal(s.queenState, "pocketed_uncovered");
    assert.equal(s.scores.creator, 0);

    resolveTurn(s, [], "creator");                        // cover turn: potted nothing
    assert.equal(s.queenState, "on_board");
    assert.equal(s.scores.creator, 0);
    const queen = s.coins.find((c) => c.id === QUEEN_ID);
    assert.equal(queen.pocketed, false, "the queen is back on the board");
});

test("fouling on the stroke that pots the queen voids the cover", () => {
    const s = withColors(createInitialState(), "white");
    resolveTurn(s, foul(s, [potQueen(s), potOf(s, "white")]), "creator");
    assert.equal(s.queenState, "on_board", "the queen is returned");
    assert.equal(s.whoseTurn, "joiner", "a foul always passes the turn");
});

// ── F10: a foul costs exactly one point, and the score may go negative ──────

test("a foul at zero with an empty ledge shows −1, and owes the board a coin", () => {
    const s = withColors(createInitialState(), "white");
    resolveTurn(s, foul(s), "creator");
    assert.equal(s.scores.creator, -1, "no floor at zero");
    assert.equal(s.debts.creator, 1, "and a coin is owed back to the board");
});

test("fouling twice with nothing to give reaches −2", () => {
    const s = withColors(createInitialState(), "white");
    resolveTurn(s, foul(s), "creator");
    resolveTurn(s, foul(s), "creator");
    assert.equal(s.scores.creator, -2);
    assert.equal(s.debts.creator, 2);
});

test("the foul is charged ONCE — paying the coin debt does not dock again", () => {
    // This is the double-punishment the old code had: the score floored at 0 and
    // the debt was later settled by silently deducting a second point.
    const s = withColors(createInitialState(), "white");
    resolveTurn(s, foul(s), "creator");
    assert.equal(s.scores.creator, -1);

    // Now they pocket a coin. They earn the point; the coin itself goes straight
    // back to the board to pay the debt. Net: −1 + 1 = 0, not −1 again.
    resolveTurn(s, [potOf(s, "white")], "creator");
    assert.equal(s.scores.creator, 0, "the point counts — the foul was already paid for");
    assert.equal(s.debts.creator, 0, "and the physical debt is settled");
    assert.equal(s.pocketedPiles.creator.length, 0, "the coin went back to the board, not the ledge");
    const paid = s.coins.find((c) => c.id === 1);
    assert.equal(paid.pocketed, false);
});

test("a foul with coins on the ledge takes a point AND a coin", () => {
    const s = withColors(createInitialState(), "white");
    resolveTurn(s, [potOf(s, "white"), potOf(s, "white")], "creator");
    assert.equal(s.scores.creator, 2);
    assert.equal(s.pocketedPiles.creator.length, 2);

    resolveTurn(s, foul(s), "creator");
    assert.equal(s.scores.creator, 1, "one point, never two");
    assert.equal(s.pocketedPiles.creator.length, 1, "and one coin returns to the board");
    assert.equal(s.debts.creator, 0, "nothing is owed — they had a coin to give");
});

// ── F9: the finishing coin needs the queen covered ──────────────────────────

test("clearing your colour with the queen UNCOVERED refuses the coin", () => {
    const s = withColors(createInitialState(), "white");
    clearColor(s, "white", 1);                 // creator has exactly one white left
    s.scores.creator = 8;
    const lastPot = potOf(s, "white");   // pockets the final one
    const last = { id: lastPot.id };

    const r = resolveTurn(s, [lastPot], "creator");

    assert.equal(r.gameOver, false, "the game does not end");
    assert.equal(s.scores.creator, 8, "the coin scores nothing");
    assert.equal(liveOf(s, "white"), 1, "the coin is back on the board");
    assert.equal(s.coins.find((c) => c.id === last.id).pocketed, false);
    assert.ok(
        !s.pocketedPiles.creator.some((c) => c.id === last.id),
        "and it never reaches the ledge",
    );
});

test("a refused coin does not buy a continued turn", () => {
    const s = withColors(createInitialState(), "white");
    clearColor(s, "white", 1);
    const lastPot = potOf(s, "white");   // pockets the final one
    const last = { id: lastPot.id };
    const r = resolveTurn(s, [lastPot], "creator");
    assert.equal(r.continuedTurn, false, "it didn't count, so it can't extend the turn");
    assert.equal(s.whoseTurn, "joiner");
});

test("with the queen covered, clearing your colour ends the game and you win", () => {
    const s = withColors(createInitialState(), "white");
    s.queenState = "covered";
    clearColor(s, "white", 1);
    const lastPot = potOf(s, "white");   // pockets the final one
    const last = { id: lastPot.id };

    const r = resolveTurn(s, [lastPot], "creator");
    assert.equal(r.gameOver, true);
    assert.equal(r.winner, "creator");
    assert.equal(s.gameOver, true);
});

test("the queen counts as covered no matter WHO covered it", () => {
    // Your example: user 1 covers the queen, user 2 clears their coins → user 2 wins.
    const s = withColors(createInitialState(), "white");
    s.queenState = "covered";
    s.queenPocketedBy = null; // it was the creator who covered it, a turn ago
    clearColor(s, "black", 1);
    const lastPot = potOf(s, "black");   // pockets the final one
    const last = { id: lastPot.id };

    const r = resolveTurn(s, [lastPot], "joiner");
    assert.equal(r.gameOver, true);
    assert.equal(r.winner, "joiner", "the joiner cleared black and wins");
});

test("covering the queen with the last coin finishes the game in one stroke", () => {
    const s = withColors(createInitialState(), "white");
    clearColor(s, "white", 1);
    const lastPot = potOf(s, "white");   // pockets the final one
    const last = { id: lastPot.id };

    // Queen + the final white on the same stroke: the queen is covered by that
    // coin, so the coin is NOT refused, and the game ends.
    const r = resolveTurn(s, [potQueen(s), lastPot], "creator");
    assert.equal(s.queenState, "covered");
    assert.equal(r.gameOver, true);
    assert.equal(r.winner, "creator");
});

test("potting the opponent's last coin for them is refused too, while the queen is up", () => {
    const s = withColors(createInitialState(), "white");
    clearColor(s, "black", 1);
    const lastPot = potOf(s, "black");   // pockets the final one
    const last = { id: lastPot.id };

    // The creator pots the joiner's final black coin. It would hand the joiner the
    // game — but the queen is uncovered, so it comes back to the centre.
    const r = resolveTurn(s, [lastPot], "creator");
    assert.equal(r.gameOver, false);
    assert.equal(s.scores.joiner, 0);
    assert.equal(liveOf(s, "black"), 1);
});

// ── F5/F6: ledges and the transfers that fill them ─────────────────────────

test("a pocketed coin lands on its owner's ledge, in pocket order", () => {
    const s = createInitialState();
    const first = potOf(s, "white");
    const second = potOf(s, "white");
    resolveTurn(s, [first, second], "creator");
    assert.deepEqual(
        s.pocketedPiles.creator.map((c) => c.id),
        [first.id, second.id],
        "the ledge is the pocket order",
    );
    assert.equal(s.pocketedPiles.joiner.length, 0);
});

test("every pocketed coin is given a walk from the pocket to its ledge slot", () => {
    const s = createInitialState();
    const r = resolveTurn(s, [potOf(s, "white")], "creator");
    const walk = r.transfers.find((t) => t.kind === "coin" && t.id === 1);
    assert.ok(walk, "the coin must be animated, not teleported");
    assert.deepEqual(walk.from, { x: P.x, y: P.y }, "it starts at the pocket it fell into");
    assert.deepEqual(walk.to, ledgeSlot("creator", 0), "and ends in its ledge slot");
});

test("the striker is handed to the opponent as a move, never a jump", () => {
    const s = withColors(createInitialState(), "white");
    const r = resolveTurn(s, foul(s), "creator");
    const walk = r.transfers.find((t) => t.kind === "striker");
    assert.ok(walk);
    assert.deepEqual(walk.from, { x: P.x, y: P.y }, "from the pocket it fell into");
    assert.equal(walk.to.x, CENTER_X);
    assert.equal(walk.to.y, s.striker.y, "to the baseline of whoever is on now");
});

test("a refused coin is animated back to the centre, not onto the ledge", () => {
    const s = withColors(createInitialState(), "white");
    clearColor(s, "white", 1);
    const lastPot = potOf(s, "white");   // pockets the final one
    const last = { id: lastPot.id };
    const r = resolveTurn(s, [lastPot], "creator");

    const walks = r.transfers.filter((t) => t.kind === "coin" && t.id === last.id);
    assert.equal(walks.length, 1, "one journey, not a trip to the ledge and back");
    const live = s.coins.find((c) => c.id === last.id);
    assert.deepEqual(walks[0].to, { x: live.x, y: live.y }, "it ends where the coin actually is");
    assert.deepEqual(walks[0].from, { x: P.x, y: P.y }, "starting from the pocket");
});

test("a refunded coin is animated off the ledge and back to the board", () => {
    const s = withColors(createInitialState(), "white");
    resolveTurn(s, [potOf(s, "white")], "creator");     // ledge: [1]
    const r = resolveTurn(s, foul(s), "creator"); // foul → coin 1 goes back

    const walk = r.transfers.find((t) => t.kind === "coin" && t.id === 1);
    assert.ok(walk);
    assert.deepEqual(walk.from, ledgeSlot("creator", 0), "it leaves the ledge slot it sat in");
    const live = s.coins.find((c) => c.id === 1);
    assert.deepEqual(walk.to, { x: live.x, y: live.y });
});

test("the queen joins the coverer's ledge, and a later foul can hand it back", () => {
    const s = withColors(createInitialState(), "white");
    resolveTurn(s, [potQueen(s), potOf(s, "white")], "creator");
    assert.ok(
        s.pocketedPiles.creator.some((c) => c.color === "red"),
        "the covered queen sits on the ledge like any other coin",
    );

    // Foul: the last coin on the ledge is the queen, so it goes back — and that
    // un-covers her.
    resolveTurn(s, foul(s), "creator");
    assert.equal(s.queenState, "on_board");
    assert.equal(s.coins.find((c) => c.id === QUEEN_ID).pocketed, false);
});
