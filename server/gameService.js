// Game orchestration that needs the io instance: (re)dealing a game and
// mirroring authoritative state back onto the room for the roomUpdate channel.
// A factory so io is injected once at bootstrap.
import { rooms, roomUpdatePayload, GAME_RESET_DELAY_MS } from "./rooms.js";
import { createInitialState, fullStateSnapshot } from "./physics.js";

export function createGameService(io) {
    // Initialize / reset a room's authoritative game state and broadcast the
    // starting snapshot.
    function startGame(roomName) {
        const room = rooms.get(roomName);
        if (!room) return;
        if (room.simCancel) { room.simCancel(); room.simCancel = null; }
        room.game = createInitialState(room.coinCount);
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

    return { startGame, syncRoomFromGame, broadcastRoomUpdate, finishGame, redealSolo };
}
