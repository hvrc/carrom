// Game orchestration that needs the io instance: (re)dealing a game and
// mirroring authoritative state back onto the room for the roomUpdate channel.
// A factory so io is injected once at bootstrap.
import { rooms, roomUpdatePayload } from "./rooms.js";
import { createInitialState, fullStateSnapshot } from "./physics.js";

export function createGameService(io) {
    // Initialize / reset a room's authoritative game state and broadcast the
    // starting snapshot.
    function startGame(roomName) {
        const room = rooms.get(roomName);
        if (!room) return;
        if (room.simCancel) { room.simCancel(); room.simCancel = null; }
        room.game = createInitialState();
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

    return { startGame, syncRoomFromGame, broadcastRoomUpdate };
}
