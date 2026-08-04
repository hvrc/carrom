// All per-connection socket event handlers. Wired up once per connection by
// index.js: io.on("connection", socket => registerHandlers(io, socket, service)).
import {
    rooms, liveConnections, DISCONNECT_GRACE_MS,
    createRoom, findRoomByClientId, clearGraceTimer, roomUpdatePayload, roomListPage, touchRoom,
    cancelBotTurn,
} from "./rooms.js";
import { MEDIUM } from "./bot/index.js";
import {
    fullStateSnapshot, clampStrikerX, baselineYFor, overlapsAnyCoin, foulsMoon,
    normalizeCoinCount,
} from "./physics.js";

const isValidId = (id) => id && id !== "null" && id !== "undefined";

// What the computer is called, and how well it plays. The difficulty is fixed
// here on purpose: the engine takes any value from 0 to 1 and the tests use
// both ends of that range, but the game ships with one setting and no dial in
// the interface to change it.
const COMPUTER_NAME = "COMPUTER";
const BOT_DIFFICULTY = MEDIUM;

export function registerHandlers(io, socket, service) {
    const {
        startGame, syncRoomFromGame, broadcastRoomUpdate, finishGame, redealSolo,
        recordFinishedMatch, recordSoloRun, playFlick, scheduleBotTurn, store,
    } = service;
    const clientId = socket.handshake.query.clientId;

    if (!isValidId(clientId)) {
        socket.emit("error", "Invalid client ID");
        socket.disconnect();
        return;
    }
    console.log("Client connected:", socket.id, "clientId:", clientId, socket.recovered ? "(recovered)" : "");
    liveConnections.set(clientId, (liveConnections.get(clientId) || 0) + 1);

    socket.on("error", (error) => console.error("Socket error:", error));

    // (Re)connecting member: cancel any pending grace teardown and re-join the
    // socket.io room so broadcasts reach them immediately. The client also
    // re-syncs via rejoinRoom -> requestRoomData.
    const reconnecting = findRoomByClientId(clientId);
    if (reconnecting) {
        const [reRoomName, reRoom] = reconnecting;
        clearGraceTimer(reRoom, clientId);
        socket.join(reRoomName);
    }

    // Lobby: can this client access the room? (join the socket.io room if so)
    // Lobby list, paged. The menu asks for the next slice as the user scrolls,
    // so this must stay cheap: no game state, just names + who's in + a status.
    socket.on("listRooms", ({ offset, limit } = {}) => {
        socket.emit("roomList", roomListPage(offset, limit));
    });

    // The two boards on the menu: fastest playground runs for one rack, and the
    // last few finished matches.
    socket.on("leaderboards", async ({ coinCount } = {}) => {
        if (!store) return socket.emit("leaderboards", { soloRuns: [], matches: [] });
        const [soloRuns, matches] = await Promise.all([
            store.topSoloRuns(coinCount),
            store.recentMatches(),
        ]);
        socket.emit("leaderboards", { coinCount, soloRuns, matches });
    });

    socket.on("checkRoomAccess", ({ roomName, clientId: incomingClientId }) => {
        if (!isValidId(incomingClientId)) return socket.emit("error", "Invalid client ID");
        if (!rooms.has(roomName)) return socket.emit("error", "Room does not exist");
        const room = rooms.get(roomName);
        if (room.clientIds.size >= 2 && !room.clientIds.has(incomingClientId)) {
            return socket.emit("error", "Room is full");
        }
        socket.join(roomName);
        socket.emit("accessGranted");
    });

    // Reconnect after a refresh/drop. Resumes the existing game (no re-deal).
    socket.on("rejoinRoom", ({ roomName, clientId: incomingClientId, playerRole }) => {
        if (!isValidId(incomingClientId)) return socket.emit("error", "Invalid client ID");
        if (!rooms.has(roomName)) return socket.emit("error", "Room does not exist");
        const room = rooms.get(roomName);
        const matches =
            (playerRole === "creator" && room.creator && room.creator.clientId === incomingClientId) ||
            (playerRole === "joiner" && room.joiner && room.joiner.clientId === incomingClientId);
        if (!matches) return socket.emit("error", "Invalid session or role");
        clearGraceTimer(room, incomingClientId);
        socket.join(roomName);
        socket.emit("accessGranted");
    });

    // A client holds at most ONE seat, anywhere. If they already have one, we do
    // not hand them a second — we tell them which seat is theirs and they walk
    // back into it (a rejoin). This is what stops one human from occupying both
    // sides of a room: with a browser-wide identity, a second tab is recognised
    // as the same player and bounced back to their existing seat instead of being
    // seated opposite themselves.
    const seatedElsewhere = (incomingClientId) => {
        const seat = findRoomByClientId(incomingClientId);
        if (!seat) return false;
        const [seatedRoom, seatedRoomObj, playerRole] = seat;
        // A practice room is not a seat in the sense that matters here: it holds
        // nobody else up, so it must not stop this client entering a real room.
        // A game against the computer is the same — the other seat is not a
        // person waiting, and being stuck in one would make the COMPUTER button
        // a trap you could not leave for a real game.
        if (seatedRoomObj.solo || seatedRoomObj.bot) return false;
        socket.emit("alreadySeated", { roomName: seatedRoom, playerRole });
        return true;
    };

    socket.on("createRoom", ({ roomName, username, clientId: incomingClientId, coinCount }) => {
        if (!isValidId(incomingClientId)) return socket.emit("error", "Invalid client ID");
        if (seatedElsewhere(incomingClientId)) return;
        if (rooms.has(roomName)) return socket.emit("error", "Room already exists");
        // coinCount is the creator's choice of rack; anything else falls back to
        // the full board (normalizeCoinCount, inside createRoom).
        rooms.set(roomName, createRoom(roomName, { username, clientId: incomingClientId }, coinCount));
        socket.join(roomName);
        socket.emit("playerJoined", { username, roomName });
        socket.emit("roomUpdate", { roomName, creator: { username }, joiner: null, whoseTurn: "creator" });
    });

    socket.on("joinRoom", ({ roomName, username, clientId: incomingClientId }) => {
        if (!isValidId(incomingClientId)) return socket.emit("error", "Invalid client ID");
        if (seatedElsewhere(incomingClientId)) return;
        if (!rooms.has(roomName)) return socket.emit("error", "Room does not exist");
        const room = rooms.get(roomName);
        if (room.clientIds.size >= 2 || room.joiner) return socket.emit("error", "Room is full");

        room.joiner = { username, clientId: incomingClientId };
        room.clientIds.add(incomingClientId);
        touchRoom(room);
        socket.join(roomName);
        socket.emit("playerJoined", { username, roomName });

        // Both players present — (re)initialize authoritative game state.
        startGame(roomName);
        broadcastRoomUpdate(roomName);
    });

    // The practice room. One seat, dealt immediately, private to this client.
    // Asking for it twice resumes the room already there rather than failing.
    socket.on("openSolo", ({ roomName, username, clientId: incomingClientId, coinCount }) => {
        if (!isValidId(incomingClientId)) return socket.emit("error", "Invalid client ID");

        const existing = rooms.get(roomName);
        if (existing) {
            if (!existing.solo || existing.creator?.clientId !== incomingClientId) {
                return socket.emit("error", "Room does not exist");
            }
            clearGraceTimer(existing, incomingClientId);
            socket.join(roomName);
            // The name and the rack can both change between visits: whoever comes
            // back is whoever is here now.
            if (username) existing.creator.username = username;
            socket.emit("playerJoined", { username: existing.creator.username, roomName });

            const wanted = normalizeCoinCount(coinCount);
            if (coinCount !== undefined && wanted !== existing.coinCount) {
                // A different rack was asked for: deal it, and time it from now.
                existing.coinCount = wanted;
                existing.startedAt = null;
                startGame(roomName);
                broadcastRoomUpdate(roomName);
                return;
            }

            broadcastRoomUpdate(roomName);
            if (existing.game) socket.emit("gameInit", fullStateSnapshot(existing.game));
            return;
        }

        rooms.set(roomName, createRoom(
            roomName, { username, clientId: incomingClientId }, coinCount, true,
        ));
        socket.join(roomName);
        socket.emit("playerJoined", { username, roomName });
        startGame(roomName);          // no second player to wait for
        broadcastRoomUpdate(roomName);
    });

    // A game against the computer. One person, one seat that is not a socket.
    //
    // Deliberately shaped like openSolo rather than like createRoom: there is
    // nobody to wait for and nothing to advertise, so the room is private to
    // this client and hidden from the lobby. Unlike a practice board, though,
    // this is a real two-sided game — turns pass, colours are claimed, and
    // somebody wins.
    socket.on("openComputer", ({ roomName, username, clientId: incomingClientId, coinCount }) => {
        if (!isValidId(incomingClientId)) return socket.emit("error", "Invalid client ID");

        const existing = rooms.get(roomName);
        if (existing) {
            if (!existing.bot || existing.creator?.clientId !== incomingClientId) {
                return socket.emit("error", "Room does not exist");
            }
            clearGraceTimer(existing, incomingClientId);
            socket.join(roomName);
            if (username) existing.creator.username = username;
            socket.emit("playerJoined", { username: existing.creator.username, roomName });

            const wanted = normalizeCoinCount(coinCount);
            if (coinCount !== undefined && wanted !== existing.coinCount) {
                // A different rack means a different game, not a different view
                // of this one: the series starts again too.
                existing.coinCount = wanted;
                existing.startedAt = null;
                existing.wins = { creator: 0, joiner: 0 };
                startGame(roomName);
                broadcastRoomUpdate(roomName);
                scheduleBotTurn(roomName);
                return;
            }

            broadcastRoomUpdate(roomName);
            if (existing.game) socket.emit("gameInit", fullStateSnapshot(existing.game));
            // Coming back to a board where it is the computer's move — after a
            // refresh, say — the turn has to be picked up again, or the game
            // sits waiting on a player with no socket to nudge it.
            scheduleBotTurn(roomName);
            return;
        }

        const room = createRoom(
            roomName, { username, clientId: incomingClientId }, coinCount, false,
            { role: "joiner", difficulty: BOT_DIFFICULTY },
        );
        // The opponent seat, filled by something that is not a connection. The
        // clientId is a marker, not a session: nothing can ever connect as it,
        // which is what keeps this room private.
        room.joiner = { username: COMPUTER_NAME, clientId: `bot:${roomName}` };
        rooms.set(roomName, room);

        socket.join(roomName);
        socket.emit("playerJoined", { username, roomName });
        startGame(roomName);
        broadcastRoomUpdate(roomName);
        scheduleBotTurn(roomName);   // in case the computer is the one to open
    });

    // Re-send room data (+ current game snapshot if a game is in progress).
    socket.on("requestRoomData", ({ roomName }) => {
        if (!rooms.has(roomName)) return socket.emit("error", "Room does not exist");
        const room = rooms.get(roomName);
        socket.emit("roomUpdate", roomUpdatePayload(room, roomName));
        if (room.game) socket.emit("gameInit", fullStateSnapshot(room.game));
    });

    // Explicit leave (EXIT button). A 2-player match can't continue with one
    // player, so leaving ends the room for both.
    socket.on("leaveRoom", ({ roomName, clientId: incomingClientId }) => {
        const room = rooms.get(roomName);
        if (!room) return;
        const isMember =
            (room.creator && room.creator.clientId === incomingClientId) ||
            (room.joiner && room.joiner.clientId === incomingClientId);
        if (!isMember) return;
        if (room.simCancel) { room.simCancel(); room.simCancel = null; }
        clearGraceTimer(room, incomingClientId);
        if (room.resetTimer) clearTimeout(room.resetTimer);
        cancelBotTurn(room);
        recordFinishedMatch(roomName);
        socket.to(roomName).emit("roomClosed", "Opponent left the room");
        rooms.delete(roomName);
        socket.leave(roomName);
    });

    // Don't tear the room down immediately — start a grace timer keyed on the
    // persistent clientId (NOT socket.id). A reconnect cancels it; otherwise the
    // room closes and the opponent is notified.
    socket.on("disconnect", () => {
        const remaining = (liveConnections.get(clientId) || 1) - 1;
        if (remaining <= 0) liveConnections.delete(clientId);
        else liveConnections.set(clientId, remaining);

        const found = findRoomByClientId(clientId);
        if (!found) return;
        const [roomName, room] = found;
        if (remaining > 0) return;              // still connected elsewhere
        if (room.graceTimers[clientId]) return; // teardown already pending

        room.graceTimers[clientId] = setTimeout(() => {
            const r = rooms.get(roomName);
            if (!r) return;
            if (r.simCancel) { r.simCancel(); r.simCancel = null; }
            if (r.resetTimer) clearTimeout(r.resetTimer); // a re-deal must not fire into a dead room
            cancelBotTurn(r);                             // nor must a pending bot shot
            recordFinishedMatch(roomName);
            io.to(roomName).emit("roomClosed", "Opponent left the room");
            rooms.delete(roomName);
        }, DISCONNECT_GRACE_MS);
    });

    // Striker-placement preview — relayed to the peer so they watch the striker
    // being scrubbed into place. Carries a board-space X (the slider is gone).
    // Relay only: the authoritative strikerX is whatever the flicker sends in
    // their `flick`, which is validated above.
    socket.on("strikerPlaceUpdate", ({ roomName, playerRole, strikerX }) => {
        if (!rooms.has(roomName)) return socket.emit("error", "Room does not exist");
        socket.to(roomName).emit("strikerPlaceUpdate", { roomName, playerRole, strikerX });
    });

    // Aim preview: relay the aiming player's flick line to their opponent so
    // they can watch the shot being lined up. Relay-only — the flick itself is
    // still validated and simulated server-side, so a forged aimUpdate can only
    // draw a misleading line, never affect the simulation. Coordinates are
    // already in the shared 900-space (the joiner's 180° rotation is applied at
    // draw time), so they pass through untouched.
    socket.on("aimUpdate", ({ roomName, playerRole, active, startX, startY, endX, endY }) => {
        const room = rooms.get(roomName);
        if (!room) return; // silent: stale aim frames must not spam errors
        if (room.whoseTurn !== playerRole) return; // only the player to move may aim
        socket.to(roomName).emit("aimUpdate", { roomName, playerRole, active, startX, startY, endX, endY });
    });

    // Ruler mode is announced, not enforced: it only draws a forecast on the
    // owner's screen, and the opponent is told so it is never a secret edge.
    socket.on("rulerUpdate", ({ roomName, playerRole, ruler }) => {
        if (!rooms.has(roomName)) return;
        socket.to(roomName).emit("rulerUpdate", { roomName, playerRole, ruler: !!ruler });
    });

    // Flick: validate turn (by persistent clientId, not socket.id), run the
    // simulation, stream frames + per-pocket events + a final turnResolved.
    socket.on("flick", ({ roomName, strikerX, angle, force }) => {
        const room = rooms.get(roomName);
        if (!room) return socket.emit("error", "Room does not exist");
        if (!room.game) return socket.emit("error", "Game has not started");
        if (room.simCancel) return;
        touchRoom(room);

        let actor = null;
        if (room.creator && room.creator.clientId === clientId) actor = "creator";
        else if (room.joiner && room.joiner.clientId === clientId) actor = "joiner";
        if (!actor) return socket.emit("error", "You are not in this room");
        // In a practice room there is nobody to hand the turn to, so it is
        // always this player's.
        if (!room.solo && actor !== room.game.whoseTurn) {
            return socket.emit("error", "Not your turn");
        }

        // F3: no shot from a striker that overlaps a coin. The client greys the
        // striker out and refuses to arm, but that is only feedback — the rule is
        // enforced here, where a forged flick can't get round it.
        const placedX = clampStrikerX(strikerX);
        if (overlapsAnyCoin(room.game.coins, placedX, baselineYFor(actor))) {
            return socket.emit("error", "Striker is overlapping a coin");
        }
        // Same deal for the baseline's end circles: cover one fully or stay off it.
        if (foulsMoon(placedX)) {
            return socket.emit("error", "Striker is half on the baseline circle");
        }

        playFlick(roomName, actor, { strikerX, angle, force });
    });

    // Reset request — wipe game state and re-deal.
    socket.on("gameReset", ({ roomName }) => {
        if (!rooms.has(roomName)) return socket.emit("error", "Room does not exist");
        startGame(roomName);
        broadcastRoomUpdate(roomName);
    });
}
