import Pocket from "./Pocket.js";
import Striker from "./Striker.js";

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

        // Draw flick line if active
        Draw._drawFlickLine(ctx, gameState, overrideCollisionState);

        // Draw the opponent's aim line (relayed) if they're currently lining up.
        Draw._drawPeerAimLine(ctx, gameState);

        ctx.restore();
    }

    /**
     * Draw frame and board rectangles
     * @private
     */
    static _drawFrameAndBoard(ctx, frameX, frameY, boardX, boardY) {
        ctx.strokeStyle = "black";
        ctx.lineWidth = 1;
        ctx.strokeRect(frameX, frameY, Draw.FRAME_SIZE, Draw.FRAME_SIZE);
        ctx.strokeRect(boardX, boardY, Draw.BOARD_SIZE, Draw.BOARD_SIZE);
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

        pocketPositions.forEach(([x, y]) => {
            ctx.beginPath();
            ctx.arc(x, y, pocketRadius, 0, Math.PI * 2);
            ctx.stroke();
        });
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

        // Draw moons and base lines
        basePositions.forEach((pos) => {
            const isVertical = pos.side === "left" || pos.side === "right";
            const baseRadius = Draw.BASE_HEIGHT / 2;

            if (isVertical) {
                Draw._drawVerticalBase(ctx, pos, baseRadius);
            } else {
                Draw._drawHorizontalBase(ctx, pos, baseRadius);
            }
        });
    }

    /**
     * Draw vertical base line with moons
     * @private
     */
    static _drawVerticalBase(ctx, pos, baseRadius) {
        ctx.beginPath();
        ctx.arc(
            pos.x + baseRadius,
            pos.y + baseRadius,
            baseRadius,
            0,
            Math.PI * 2,
        );
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(
            pos.x + baseRadius,
            pos.y + Draw.BASE_WIDTH - baseRadius,
            baseRadius,
            0,
            Math.PI * 2,
        );
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(pos.x, pos.y + baseRadius);
        ctx.lineTo(pos.x, pos.y + Draw.BASE_WIDTH - baseRadius);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(pos.x + Draw.BASE_HEIGHT, pos.y + baseRadius);
        ctx.lineTo(
            pos.x + Draw.BASE_HEIGHT,
            pos.y + Draw.BASE_WIDTH - baseRadius,
        );
        ctx.stroke();
    }

    /**
     * Draw horizontal base line with moons
     * @private
     */
    static _drawHorizontalBase(ctx, pos, baseRadius) {
        ctx.beginPath();
        ctx.arc(
            pos.x + baseRadius,
            pos.y + baseRadius,
            baseRadius,
            0,
            Math.PI * 2,
        );
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(
            pos.x + Draw.BASE_WIDTH - baseRadius,
            pos.y + baseRadius,
            baseRadius,
            0,
            Math.PI * 2,
        );
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(pos.x + baseRadius, pos.y);
        ctx.lineTo(pos.x + Draw.BASE_WIDTH - baseRadius, pos.y);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(pos.x + baseRadius, pos.y + Draw.BASE_HEIGHT);
        ctx.lineTo(
            pos.x + Draw.BASE_WIDTH - baseRadius,
            pos.y + Draw.BASE_HEIGHT,
        );
        ctx.stroke();
    }

    /**
     * Draw striker with collision state opacity
     * @private
     */
    static _drawStriker(ctx, gameState, overrideCollisionState) {
        if (!gameState.strikerRef.current) return;
        const striker = gameState.strikerRef.current;

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

        // Draw striker with consistent border style
        ctx.beginPath();
        ctx.arc(drawX, drawY, drawRadius, 0, Math.PI * 2);
        ctx.strokeStyle = "black";
        ctx.lineWidth = 1;
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
            ctx.strokeStyle = "black";
            ctx.lineWidth = 1;
            ctx.setLineDash([5, 5]); // dashed line to indicate disabled state
        } else {
            ctx.globalAlpha = 1.0; // full opacity when not colliding
            ctx.strokeStyle = "black";
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
        ctx.strokeStyle = "black";
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
