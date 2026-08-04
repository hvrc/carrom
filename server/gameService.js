// Game orchestration that needs the io instance: (re)dealing a game and
// mirroring authoritative state back onto the room for the roomUpdate channel.
// A factory so io is injected once at bootstrap.
import { rooms, roomUpdatePayload, GAME_RESET_DELAY_MS, cancelBotTurn } from "./rooms.js";
import { createInitialState, fullStateSnapshot, startFlickSimulation } from "./physics.js";
import { planShot, MEDIUM } from "./bot/index.js";

// How long the computer takes over a turn. None of this is thinking time — it
// plans in well under a tenth of a second — it is there so the shot can be
// watched. First a pause as if considering, then the striker slides into place,
// then it shoots.
export const BOT_THINK_MS = Number(process.env.BOT_THINK_MS) || 850;
export const BOT_AIM_MS = Number(process.env.BOT_AIM_MS) || 550;

export function createGameService(io, store = null) {
    // Initialize / reset a room's authoritative game state and broadcast the
    // starting snapshot.
    function startGame(roomName) {
        const room = rooms.get(roomName);
        if (!room) return;
        if (room.simCancel) { room.simCancel(); room.simCancel = null; }
        // A pending bot turn belongs to the board being replaced.
        cancelBotTurn(room);
        room.game = createInitialState(room.coinCount);
        // The clock times the room, so it is stamped once and survives re-deals.
        if (!room.startedAt) room.startedAt = Date.now();
        room.whoseTurn = room.game.whoseTurn;
        room.scores = room.game.scores;
        room.debts = room.game.debts;
        io.to(roomName).emit("gameInit", fullStateSnapshot(room.game));
    }

    // Mirror the game's score/debt/turn back onto the room so the existing
    // roomUpdate channel keeps Manager.js in sync without extra wiring.
    function syncRoomFromGame(room) {
        if (!room.game) return;
        room.whoseTurn = room.game.whoseTurn;
        room.scores = { ...room.game.scores };
        room.debts = { ...room.game.debts };
    }

    function broadcastRoomUpdate(roomName) {
        const room = rooms.get(roomName);
        if (!room) return;
        io.to(roomName).emit("roomUpdate", roomUpdatePayload(room, roomName));
    }

    // Someone won: bank the win on the ROOM (so it survives the re-deal) and then
    // deal the next game. The win count is the only thing that carries over —
    // scores, ledges, colours and the queen all start fresh.
    //
    // The pause exists so the finished board is actually seen. Without it the
    // winning shot would resolve and the board would blink into a new rack in the
    // same breath.
    function finishGame(roomName, winner) {
        const room = rooms.get(roomName);
        if (!room || !winner) return;
        room.wins[winner] += 1;
        broadcastRoomUpdate(roomName);

        if (room.resetTimer) clearTimeout(room.resetTimer);
        room.resetTimer = setTimeout(() => {
            const live = rooms.get(roomName);
            if (!live) return; // the room closed while the result was on screen
            live.resetTimer = null;
            startGame(roomName);
            broadcastRoomUpdate(roomName);
            scheduleBotTurn(roomName);
        }, GAME_RESET_DELAY_MS);
    }

    // Practice room: the board is clear, so deal another rack. Same pause as a
    // finished game, so the empty board is actually seen.
    function redealSolo(roomName) {
        const room = rooms.get(roomName);
        if (!room) return;
        if (room.resetTimer) clearTimeout(room.resetTimer);
        room.resetTimer = setTimeout(() => {
            const live = rooms.get(roomName);
            if (!live) return;
            live.resetTimer = null;
            startGame(roomName);
            broadcastRoomUpdate(roomName);
        }, GAME_RESET_DELAY_MS);
    }

    // A room is over. What gets remembered is the SERIES — how many games each
    // player won — not the score of any single game, because that is what the
    // two of them would tell you afterwards.
    //
    // Solo rooms are not matches, and a room where nobody ever won a game is not
    // worth a line in the list.
    async function recordFinishedMatch(roomName) {
        const room = rooms.get(roomName);
        // Neither a practice board nor a game against the computer is a match
        // between two people, which is what the board in the menu lists.
        if (!store || !room || room.solo || room.bot) return;
        if (!room.creator || !room.joiner) return;

        const wins = room.wins || { creator: 0, joiner: 0 };
        if (wins.creator + wins.joiner === 0) return;

        await store.recordMatch({
            players: [room.creator.username, room.joiner.username],
            wins: [wins.creator, wins.joiner],
        });
    }

    // A playground run that cleared the board. The clock is the room's own, so
    // it measures from the first deal to the last coin down.
    async function recordSoloRun(roomName) {
        const room = rooms.get(roomName);
        if (!store || !room || !room.solo || !room.startedAt) return;

        await store.recordSoloRun({
            username: room.creator?.username,
            coinCount: room.coinCount,
            ms: Date.now() - room.startedAt,
        });
    }

    /**
     * Play a shot: simulate it, stream it, resolve the turn.
     *
     * The ONLY route a shot takes, whether it came from a person's socket or
     * from the computer. That is the point of it living here: two routes into
     * the simulation would be two sets of rules about when a game is over and
     * when a rack is re-dealt, and they would drift.
     *
     * Placement legality is the caller's business — a socket has someone to
     * tell about it, and the bot is not allowed to propose one.
     *
     * @returns {boolean} whether the shot was started
     */
    function playFlick(roomName, actor, { strikerX, angle, force }) {
        const room = rooms.get(roomName);
        if (!room || !room.game || room.simCancel) return false;

        room.simCancel = startFlickSimulation(room.game, { strikerX, angle, force }, actor, {
            solo: !!room.solo,
            onFrame: (snap) => io.to(roomName).emit("physicsFrame", snap),
            onPocket: (p) => io.to(roomName).emit("pocketEvent", p),
            onImpacts: (batch) => io.to(roomName).emit("impacts", batch),
            onDone: (resolution, fullState) => {
                room.simCancel = null;
                syncRoomFromGame(room);
                // `resolution.transfers` rides along: the end-of-turn moves the
                // clients animate (coin → ledge, striker → opponent, refunds →
                // centre). They are presentation over `state`, which is already final.
                io.to(roomName).emit("turnResolved", { ...resolution, state: fullState });

                if (room.solo) {
                    const cleared = room.game.coins.every((c) => c.pocketed);
                    broadcastRoomUpdate(roomName);
                    if (cleared) {
                        recordSoloRun(roomName);
                        // The clock restarts with the new rack, so the next run
                        // is timed from its own deal rather than from the first.
                        room.startedAt = null;
                        redealSolo(roomName);
                    }
                    return;
                }

                // A win banks a point on the room and re-deals (see finishGame).
                if (resolution.gameOver && resolution.winner) {
                    finishGame(roomName, resolution.winner);
                    return;
                }
                broadcastRoomUpdate(roomName);
                scheduleBotTurn(roomName);
            },
        });
        return true;
    }

    /**
     * If it is the computer's turn, take it — after a pause long enough to
     * watch. Does nothing in a room without a bot, or when it is not the bot's
     * turn, so it is safe to call after any turn resolves.
     */
    function scheduleBotTurn(roomName) {
        const room = rooms.get(roomName);
        if (!room || !room.bot || !room.game) return;
        if (room.game.whoseTurn !== room.bot.role) return;
        if (room.botTimer || room.simCancel) return;

        room.botTimer = setTimeout(async () => {
            const live = rooms.get(roomName);
            if (!live) return;                       // the room closed while it thought
            live.botTimer = null;
            if (!live.bot || !live.game) return;
            if (live.game.whoseTurn !== live.bot.role || live.simCancel) return;

            let shot;
            try {
                const plan = await planShot(live.game, live.bot.role, {
                    difficulty: live.bot.difficulty ?? MEDIUM,
                });
                shot = plan.shot;
            } catch (err) {
                // A bot that cannot decide must not freeze the game: the turn
                // would sit with a player that does not exist, for ever.
                console.error("bot failed to plan a shot:", err.message);
                return;
            }

            // Everything may have moved on across those awaits.
            const now = rooms.get(roomName);
            if (!now || !now.game || now.simCancel) return;
            if (now.game.whoseTurn !== now.bot?.role) return;

            // Let the striker be seen sliding into place before it goes, the
            // same preview a human's opponent sees while they line up.
            io.to(roomName).emit("strikerPlaceUpdate", {
                roomName, playerRole: now.bot.role, strikerX: shot.strikerX,
            });

            now.botTimer = setTimeout(() => {
                const room2 = rooms.get(roomName);
                if (!room2) return;
                room2.botTimer = null;
                if (!room2.game || room2.simCancel) return;
                if (room2.game.whoseTurn !== room2.bot?.role) return;
                playFlick(roomName, room2.bot.role, shot);
            }, BOT_AIM_MS);
        }, BOT_THINK_MS);
    }

    return {
        startGame, syncRoomFromGame, broadcastRoomUpdate, finishGame, redealSolo,
        recordFinishedMatch, recordSoloRun, playFlick, scheduleBotTurn,
        store,
    };
}
