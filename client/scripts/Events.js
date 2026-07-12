import Draw from "./Draw";

/**
 * Relay-only handler: the opponent's striker placement, so you watch them scrub
 * the striker along their baseline before they shoot.
 *
 * The payload is a board-space X and needs no mirroring — the striker lives in
 * the same shared 900-space as the coins, and each client's canvas is rotated for
 * its own seat at draw time. (The old slider-percentage payload DID need
 * mirroring; that went with the slider.)
 *
 * All other gameplay state arrives via gameInit / physicsFrame / pocketEvent /
 * turnResolved, handled in useGameSync.
 */
export const handleStrikerPlaceUpdate = (
    data,
    { roomName, strikerRef, canvasRef, playerRole, createGameState },
) => {
    if (
        data.roomName !== roomName ||
        data.playerRole === playerRole ||   // our own placement, echoed back
        !strikerRef.current ||
        !Number.isFinite(data.strikerX)
    ) return;

    strikerRef.current.updatePosition(data.strikerX, strikerRef.current.y);

    const ctx = canvasRef.current?.getContext("2d");
    if (ctx) Draw.drawBoard(ctx, createGameState(), playerRole);
};
