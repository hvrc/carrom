// Manager: thin container for room/turn/score/wins state mirrored from the
// server. The client never mutates game rules — the server is sole authority.
// Score/turn/wins updates flow in via the `roomUpdate` and `turnResolved` socket
// events; this object exists so the UI can read structured player data.
//
// Note there is no `color` here any more. A colour is no longer a property of a
// seat: it is claimed by whoever pockets the first coin (PRD F7), so the game
// state owns that mapping, not this object.

export default class Manager {
    constructor(roomName, roomData = {}) {
        this.roomName = roomName;
        this.whoseTurn = roomData.whoseTurn || "creator";
        this.playerData = [
            {
                role: "creator",
                score: roomData.creator?.score || 0,
                debt: roomData.creator?.debt || 0,
                wins: roomData.creator?.wins || 0,
                isTurn: this.whoseTurn === "creator",
            },
            {
                role: "joiner",
                score: roomData.joiner?.score || 0,
                debt: roomData.joiner?.debt || 0,
                wins: roomData.joiner?.wins || 0,
                isTurn: this.whoseTurn === "joiner",
            },
        ];
    }

    getPlayerData(role) {
        return this.playerData.find((p) => p.role === role);
    }
}
