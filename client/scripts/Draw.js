import Pocket from "./Pocket.js";
import Striker from "./Striker.js";
import { theme, pieceStyle } from "./theme.js";
import { drawSkin } from "./skins/index.js";

/**
 * Drawing utility functions and constants for carrom game
 */
export class Draw {
    // Board dimensions and constants
    static FRAME_SIZE = 900;
    static BOARD_SIZE = 750;
    static BASE_DISTANCE = 102;
    static BASE_HEIGHT = 32;
    static BASE_WIDTH = 470;
    static CENTER_CIRCLE_DIAMETER = 170;

    // Ledge: mirrors server/sim/geometry.js (guarded by the constants-drift test).
    // Pocketed coins rest on the wooden frame band, on their owner's side.
    static LEDGE_SPACING = 44;
    static LEDGE_INSET = 24;
    static LEDGE_Y_CREATOR = 862.5;
    static LEDGE_Y_JOINER = 37.5;
    static COIN_RADIUS = 15;

    // Where the Nth coin in a player's pile sits. The joiner's row fills right →
    // left in board space so that, under their 180° canvas rotation, it reads
    // left → right on their screen — same as the creator's.
    static ledgeSlot(role, index) {
        const boardX = (Draw.FRAME_SIZE - Draw.BOARD_SIZE) / 2;
        if (role === "creator") {
            return {
                x: boardX + Draw.LEDGE_INSET + index * Draw.LEDGE_SPACING,
                y: Draw.LEDGE_Y_CREATOR,
            };
        }
        return {
            x: boardX + Draw.BOARD_SIZE - Draw.LEDGE_INSET - index * Draw.LEDGE_SPACING,
            y: Draw.LEDGE_Y_JOINER,
        };
    }

    /**
     * Draw the complete carrom board with all game elements
     * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
     * @param {Object} gameState - Current game state object
     * @param {string} playerRole - Player role ("creator" or "joiner")
     * @param {boolean} overrideCollisionState - Override collision state for real-time feedback
     */
    static drawBoard(
        ctx,
        gameState,
        playerRole,
        overrideCollisionState = null,
    ) {
        ctx.save();

        // Rotate canvas for joiner player
        if (playerRole === "joiner") {
            ctx.translate(ctx.canvas.width / 2, ctx.canvas.height / 2);
            ctx.rotate(Math.PI);
            ctx.translate(-ctx.canvas.width / 2, -ctx.canvas.height / 2);
        }

        ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

        const frameX = (ctx.canvas.width - Draw.FRAME_SIZE) / 2;
        const frameY = (ctx.canvas.height - Draw.FRAME_SIZE) / 2;
        const boardX = (ctx.canvas.width - Draw.BOARD_SIZE) / 2;
        const boardY = (ctx.canvas.height - Draw.BOARD_SIZE) / 2;

        // Initialize striker if not already done
        if (!gameState.strikerRef.current) {
            const initialX = boardX + Draw.BOARD_SIZE / 2;
            const initialY =
                boardY +
                Draw.BOARD_SIZE -
                Draw.BASE_DISTANCE -
                Draw.BASE_HEIGHT / 2;
            gameState.strikerRef.current = new Striker(initialX, initialY);
        }

        // Draw frame and board
        Draw._drawFrameAndBoard(ctx, frameX, frameY, boardX, boardY);

        // The board's skin, under everything else on the surface. It gets the
        // clock and the live pieces so it can react to play.
        drawSkin(ctx, {
            time: gameState.time,
            pieces: Draw._livePieces(gameState),
        });

        // Draw pockets
        Draw._drawPockets(ctx, boardX, boardY);

        // Draw base lines
        Draw._drawBaseLines(ctx, boardX, boardY);

        // Draw all coins (active + currently animating into pocket)
        gameState.coinsRef.current.forEach((coin) => coin.draw(ctx));
        if (gameState.pocketingCoinsRef) {
            gameState.pocketingCoinsRef.current.forEach((coin) => coin.draw(ctx));
        }

        // Draw striker
        Draw._drawStriker(ctx, gameState, overrideCollisionState);

        // Coins already pocketed, resting on each player's ledge.
        Draw._drawPiles(ctx, gameState);

        // Pieces mid-transfer (coin → ledge, striker → opponent, refunds → centre).
        Draw._drawFlying(ctx, gameState);

        // Draw flick line if active
        Draw._drawFlickLine(ctx, gameState, overrideCollisionState);

        // Draw the opponent's aim line (relayed) if they're currently lining up.
        Draw._drawPeerAimLine(ctx, gameState);

        ctx.restore();
    }

    /**
     * Every piece a skin may react to: the live coins and the striker.
     * @private
     */
    static _livePieces(gameState) {
        const out = [];
        for (const c of gameState.coinsRef.current) {
            if (!c.pocketed) out.push({ id: c.id, x: c.x, y: c.y });
        }
        const s = gameState.strikerRef.current;
        if (s && !s.pocketed) out.push({ id: "striker", x: s.x, y: s.y });
        return out;
    }

    /**
     * Draw frame and board rectangles
     * @private
     */
    static _drawFrameAndBoard(ctx, frameX, frameY, boardX, boardY) {
        // Wood first, then the playing surface on top of it — what's left showing
        // is the ledge band the pocketed coins sit on. Frame and board carry their
        // own border colours, so a theme can outline them differently.
        ctx.save();
        ctx.lineWidth = 1;

        ctx.fillStyle = theme.frame.fill;
        ctx.fillRect(frameX, frameY, Draw.FRAME_SIZE, Draw.FRAME_SIZE);
        ctx.strokeStyle = theme.frame.border;
        ctx.strokeRect(frameX, frameY, Draw.FRAME_SIZE, Draw.FRAME_SIZE);

        ctx.fillStyle = theme.board.fill;
        ctx.fillRect(boardX, boardY, Draw.BOARD_SIZE, Draw.BOARD_SIZE);
        ctx.strokeStyle = theme.board.border;
        ctx.strokeRect(boardX, boardY, Draw.BOARD_SIZE, Draw.BOARD_SIZE);

        ctx.restore();
    }

    /**
     * Draw pockets at board corners
     * @private
     */
    static _drawPockets(ctx, boardX, boardY) {
        const pocketRadius = Pocket.POCKET_DIAMETER / 2;
        const pocketPositions = [
            [boardX + pocketRadius, boardY + pocketRadius],
            [boardX + Draw.BOARD_SIZE - pocketRadius, boardY + pocketRadius],
            [boardX + pocketRadius, boardY + Draw.BOARD_SIZE - pocketRadius],
            [
                boardX + Draw.BOARD_SIZE - pocketRadius,
                boardY + Draw.BOARD_SIZE - pocketRadius,
            ],
        ];

        ctx.save();
        ctx.fillStyle = theme.pocket.fill;
        ctx.strokeStyle = theme.pocket.border;
        pocketPositions.forEach(([x, y]) => {
            ctx.beginPath();
            ctx.arc(x, y, pocketRadius, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        });
        ctx.restore();
    }

    /**
     * Draw base lines and moons
     * @private
     */
    static _drawBaseLines(ctx, boardX, boardY) {
        const basePositions = [
            {
                side: "bottom",
                x: boardX + (Draw.BOARD_SIZE - Draw.BASE_WIDTH) / 2,
                y:
                    boardY +
                    Draw.BOARD_SIZE -
                    Draw.BASE_DISTANCE -
                    Draw.BASE_HEIGHT,
            },
            {
                side: "top",
                x: boardX + (Draw.BOARD_SIZE - Draw.BASE_WIDTH) / 2,
                y: boardY + Draw.BASE_DISTANCE,
            },
            {
                side: "left",
                x: boardX + Draw.BASE_DISTANCE,
                y: boardY + (Draw.BOARD_SIZE - Draw.BASE_WIDTH) / 2,
            },
            {
                side: "right",
                x:
                    boardX +
                    Draw.BOARD_SIZE -
                    Draw.BASE_DISTANCE -
                    Draw.BASE_HEIGHT,
                y: boardY + (Draw.BOARD_SIZE - Draw.BASE_WIDTH) / 2,
            },
        ];

        // Fill each baseline band with the board colour FIRST, so whatever the
        // skin has painted underneath does not show through the markings. The
        // band is a capsule: a rectangle with a half-round cap at each end,
        // which is exactly the two moons plus the lines between them.
        ctx.save();
        ctx.fillStyle = theme.board.fill;
        basePositions.forEach((pos) => {
            const r = Draw.BASE_HEIGHT / 2;
            const vertical = pos.side === "left" || pos.side === "right";
            const [x1, y1] = [pos.x + r, pos.y + r];
            const [x2, y2] = vertical
                ? [pos.x + r, pos.y + Draw.BASE_WIDTH - r]
                : [pos.x + Draw.BASE_WIDTH - r, pos.y + r];

            const a = Math.atan2(y2 - y1, x2 - x1);
            ctx.beginPath();
            ctx.arc(x1, y1, r, a + Math.PI / 2, a - Math.PI / 2);
            ctx.arc(x2, y2, r, a - Math.PI / 2, a + Math.PI / 2);
            ctx.closePath();
            ctx.fill();
        });
        ctx.restore();

        // Draw moons and base lines
        ctx.save();
        basePositions.forEach((pos) => {
            const isVertical = pos.side === "left" || pos.side === "right";
            const baseRadius = Draw.BASE_HEIGHT / 2;

            if (isVertical) {
                Draw._drawVerticalBase(ctx, pos, baseRadius);
            } else {
                Draw._drawHorizontalBase(ctx, pos, baseRadius);
            }
        });
        ctx.restore();
    }

    /**
     * Draw vertical base line with moons
     * @private
     */
    static _drawVerticalBase(ctx, pos, baseRadius) {
        Draw._drawGuideCircle(ctx, pos.x + baseRadius, pos.y + baseRadius, baseRadius);
        Draw._drawGuideCircle(ctx, pos.x + baseRadius, pos.y + Draw.BASE_WIDTH - baseRadius, baseRadius);

        Draw._drawGuideLine(ctx, pos.x, pos.y + baseRadius, pos.x, pos.y + Draw.BASE_WIDTH - baseRadius);
        Draw._drawGuideLine(
            ctx,
            pos.x + Draw.BASE_HEIGHT, pos.y + baseRadius,
            pos.x + Draw.BASE_HEIGHT, pos.y + Draw.BASE_WIDTH - baseRadius,
        );
    }

    /**
     * The end circles of a baseline. Themed separately from the lines they cap —
     * on a real board they're often a different mark altogether.
     * @private
     */
    static _drawGuideCircle(ctx, x, y, radius) {
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        const fill = theme.guides.circleFill;
        if (fill && fill !== "transparent") {
            ctx.fillStyle = fill;
            ctx.fill();
        }
        ctx.strokeStyle = theme.guides.circle;
        ctx.stroke();
    }

    /**
     * One straight run of a baseline.
     * @private
     */
    static _drawGuideLine(ctx, x1, y1, x2, y2) {
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.strokeStyle = theme.guides.line;
        ctx.stroke();
    }

    /**
     * Draw horizontal base line with moons
     * @private
     */
    static _drawHorizontalBase(ctx, pos, baseRadius) {
        Draw._drawGuideCircle(ctx, pos.x + baseRadius, pos.y + baseRadius, baseRadius);
        Draw._drawGuideCircle(ctx, pos.x + Draw.BASE_WIDTH - baseRadius, pos.y + baseRadius, baseRadius);

        Draw._drawGuideLine(ctx, pos.x + baseRadius, pos.y, pos.x + Draw.BASE_WIDTH - baseRadius, pos.y);
        Draw._drawGuideLine(
            ctx,
            pos.x + baseRadius, pos.y + Draw.BASE_HEIGHT,
            pos.x + Draw.BASE_WIDTH - baseRadius, pos.y + Draw.BASE_HEIGHT,
        );
    }

    /**
     * Draw striker with collision state opacity
     * @private
     */
    static _drawStriker(ctx, gameState, overrideCollisionState) {
        if (!gameState.strikerRef.current) return;
        const striker = gameState.strikerRef.current;

        // While the striker is mid-transfer (gliding to the opponent's baseline)
        // the flying sprite IS the striker — drawing the real one too would show
        // two of them, one stuck at the old position.
        if (gameState.flying && gameState.flying.some((p) => p.kind === "striker")) return;

        // Pocket-drop tween: ease-in slide + shrink. Skip rendering once
        // progress hits 1; the parent animation loop will clear the flag.
        let drawX = striker.x;
        let drawY = striker.y;
        let drawRadius = striker.radius;
        if (striker.beingPocketed && striker.pocketTarget) {
            const t = striker.pocketProgress();
            if (t >= 1) return;
            const e = t * t;
            drawX = striker.pocketStartX + (striker.pocketTarget.x - striker.pocketStartX) * e;
            drawY = striker.pocketStartY + (striker.pocketTarget.y - striker.pocketStartY) * e;
            drawRadius = striker.radius * (1 - t);
        }

        // Use override collision state if provided, otherwise use React state
        const currentCollisionState =
            overrideCollisionState !== null
                ? overrideCollisionState
                : gameState.isStrikerColliding;

        ctx.save();

        // Set opacity based on collision state
        if (currentCollisionState) {
            ctx.globalAlpha = 0.4; // 40% opacity when colliding
        } else {
            ctx.globalAlpha = 1.0; // full opacity when not colliding
        }

        // Greyed out = no legal shot from here — the striker is on a coin, or half
        // on a baseline moon (F3). Same signal the FLICK button gives, on the piece.
        const s = theme.striker;
        const fill = gameState.strikerBlocked ? s.blockedFill : s.fill;
        ctx.beginPath();
        ctx.arc(drawX, drawY, drawRadius, 0, Math.PI * 2);
        ctx.strokeStyle = gameState.strikerBlocked ? s.blockedBorder : s.border;
        ctx.lineWidth = 1;
        // A "transparent" fill means an empty body — the board shows through.
        if (fill && fill !== "transparent") {
            ctx.fillStyle = fill;
            ctx.fill();
        }
        ctx.stroke();

        ctx.restore();
    }

    /**
     * Draw flick line when active
     * @private
     */    static _drawFlickLine(ctx, gameState, overrideCollisionState) {
        // Draw flick line if flickering is active OR if flick has been started (more lenient condition)
        if (!gameState.isFlickerActive && !gameState.flick.active) return;
        
        // Extra safety check to ensure we have valid flick coordinates
        if (!gameState.flick || 
            gameState.flick.startX === undefined || 
            gameState.flick.startY === undefined ||
            gameState.flick.endX === undefined || 
            gameState.flick.endY === undefined) return;

        ctx.save();

        // Use override collision state if provided, otherwise use React state
        const currentCollisionState =
            overrideCollisionState !== null
                ? overrideCollisionState
                : gameState.isStrikerColliding;

        // Set opacity and style based on collision state
        if (currentCollisionState) {
            ctx.globalAlpha = 0.4; // reduced opacity when colliding
            ctx.strokeStyle = theme.aim.ownBlocked;
            ctx.lineWidth = 1;
            ctx.setLineDash([5, 5]); // dashed line to indicate disabled state
        } else {
            ctx.globalAlpha = 1.0; // full opacity when not colliding
            ctx.strokeStyle = theme.aim.own;
            ctx.lineWidth = 1;
        }

        ctx.beginPath();
        ctx.moveTo(gameState.flick.startX, gameState.flick.startY);

        // Cap the line at max length
        let dx = gameState.flick.endX - gameState.flick.startX;
        let dy = gameState.flick.endY - gameState.flick.startY;
        let d = Math.hypot(dx, dy);
        let capX = gameState.flick.endX;
        let capY = gameState.flick.endY;

        if (d > gameState.flickMaxLength) {
            const scale = gameState.flickMaxLength / d;
            capX = gameState.flick.startX + dx * scale;
            capY = gameState.flick.startY + dy * scale;
        }

        ctx.lineTo(capX, capY);
        ctx.stroke();
        ctx.restore();
    }

    /**
     * A bare disc, used for pieces that aren't live Coin/Striker objects: the
     * ledge piles and the in-flight transfer sprites.
     * @private
     */
    static _drawDisc(ctx, x, y, radius, color) {
        const style = pieceStyle(color);
        ctx.save();
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fillStyle = style.fill;
        ctx.strokeStyle = style.border;
        ctx.fill();
        ctx.stroke();
        ctx.restore();
    }

    /**
     * Each player's pocketed coins, parked on the wooden ledge on their side of
     * the board — the way players stack them on a real board. Order is the order
     * they were pocketed, and it comes from the server, so both clients agree.
     * @private
     */
    static _drawPiles(ctx, gameState) {
        const piles = gameState.piles;
        if (!piles) return;
        for (const role of ["creator", "joiner"]) {
            const pile = piles[role] || [];
            pile.forEach((coin, i) => {
                const slot = Draw.ledgeSlot(role, i);
                Draw._drawDisc(ctx, slot.x, slot.y, Draw.COIN_RADIUS, coin.color);
            });
        }
    }

    /**
     * Pieces currently travelling between two places — a pocketed coin walking to
     * the ledge, the striker sliding to the opponent's baseline, a refunded coin
     * returning to the centre. Positions are computed by transfers.js from a
     * server-declared from/to; nothing here decides where anything ends up.
     * @private
     */
    static _drawFlying(ctx, gameState) {
        const flying = gameState.flying;
        if (!flying || flying.length === 0) return;
        for (const piece of flying) {
            const radius = piece.kind === "striker" ? Striker.RADIUS : Draw.COIN_RADIUS;
            if (piece.kind === "striker") {
                ctx.save();
                ctx.beginPath();
                ctx.arc(piece.x, piece.y, radius, 0, Math.PI * 2);
                ctx.fillStyle = theme.striker.fill;
                ctx.strokeStyle = theme.striker.border;
                ctx.fill();
                ctx.stroke();
                ctx.restore();
            } else {
                Draw._drawDisc(ctx, piece.x, piece.y, radius, piece.color);
            }
        }
    }

    /**
     * Draw the opponent's relayed aim line. Same coordinate space as everything
     * else on the board (the canvas is already rotated for the joiner above), so
     * the endpoints arrive from the server needing no transform. Drawn dashed and
     * faded so it reads as "them", not as your own aim.
     * @private
     */
    static _drawPeerAimLine(ctx, gameState) {
        const aim = gameState.peerAim;
        if (!aim || !aim.active) return;
        if (![aim.startX, aim.startY, aim.endX, aim.endY].every(Number.isFinite)) return;

        ctx.save();
        ctx.globalAlpha = 0.45;
        ctx.strokeStyle = theme.aim.peer;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(aim.startX, aim.startY);
        ctx.lineTo(aim.endX, aim.endY);
        ctx.stroke();
        ctx.restore();
    }

    /**
     * Get board coordinates from canvas
     * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
     * @returns {Object} Board coordinates {boardX, boardY}
     */
    static getBoardCoordinates(ctx) {
        return {
            boardX: (ctx.canvas.width - Draw.BOARD_SIZE) / 2,
            boardY: (ctx.canvas.height - Draw.BOARD_SIZE) / 2,
        };
    }

    /**
     * Get striker initial position for given role
     * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
     * @param {string} playerRole - Player role ("creator" or "joiner")
     * @returns {Object} Initial position {x, y}
     */
    static getStrikerInitialPosition(ctx, playerRole) {
        const { boardX, boardY } = Draw.getBoardCoordinates(ctx);
        const bottomBaselineY =
            boardY +
            Draw.BOARD_SIZE -
            Draw.BASE_DISTANCE -
            Draw.BASE_HEIGHT / 2;
        const topBaselineY = boardY + Draw.BASE_DISTANCE + Draw.BASE_HEIGHT / 2;

        return {
            x: boardX + Draw.BOARD_SIZE / 2,
            y: playerRole === "joiner" ? topBaselineY : bottomBaselineY,
        };
    }
}

export default Draw;
