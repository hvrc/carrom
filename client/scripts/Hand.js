import { Draw } from "./Draw.js";

/**
 * Hand interaction manager for carrom game
 * Handles all mouse events, striker placement, and flicking mechanics
 * 
 * Flicker Drawing Mechanism:
 * - Click on striker: Flick line draws from striker center to cursor position
 * - Click elsewhere: Flick line draws from click position, applies relative offset to striker
 */
export class Hand {
    // Flick constants - reduced power for finer linear scaling
    static FLICK_MAX_LENGTH = 100;
    static FLICK_POWER = 0.4;  // Reduced base power for finer control

    /**
     * Compute flick parameters from current this.flick state and emit a
     * server-authoritative `flick` event. Returns true if a flick was sent.
     * Does NOT mutate striker velocity \u2014 the server is the simulation source
     * of truth and will broadcast physicsFrame updates back to all clients.
     */
    _emitFlick({ strikerRef, socket, roomName }) {
        if (!socket || !roomName || !strikerRef?.current) return false;
        const dx = this.flick.startX - this.flick.endX;
        const dy = this.flick.startY - this.flick.endY;
        const distance = Math.hypot(dx, dy);
        if (distance <= 5) return false;
        const force = Math.min(distance / this.flickMaxLength, 1);
        const angle = Math.atan2(dy, dx);
        socket.emit("flick", {
            roomName,
            strikerX: strikerRef.current.x,
            angle,
            force,
        });
        return true;
    }

    constructor() {
        // State management
        this.isPlacing = false;
        this.canPlace = true;
        this.isFlickerActive = false;
        this.flick = {
            active: false,
            startX: 0,
            startY: 0,
            endX: 0,
            endY: 0,
            mode: null, // 'striker' or 'remote'
            initialClickX: 0,  // Store initial click position
            initialClickY: 0,
        };
        this.flickMaxLength = Hand.FLICK_MAX_LENGTH;

        // Slider state management
        this.sliderValue = 50; // 0-100 percentage
        this.sliderMin = 0;
        this.sliderMax = 0;
        this.sliderSensitivity = 0.2;

        // Callbacks that will be set by the parent component
        this.onStateChange = null;
        this.onStrikerMove = null;
        this.onCollisionUpdate = null;
        this.onAnimationStart = null;
        this.onRedraw = null;
        this.onSliderChange = null;

        // Global mouse tracking state
        this.isMouseDown = false;
        this.globalListenersAdded = false;
        this._lastContext = null;

        // Bind global event handlers
        this._handleGlobalMouseMove = this._handleGlobalMouseMove.bind(this);
        this._handleGlobalMouseUp = this._handleGlobalMouseUp.bind(this);
    }

    /**
     * Set callback functions for communication with parent component
     */
    setCallbacks({
        onStateChange,
        onStrikerMove,
        onCollisionUpdate,
        onAnimationStart,
        onRedraw,
        onSliderChange,
    }) {
        this.onStateChange = onStateChange;
        this.onStrikerMove = onStrikerMove;
        this.onCollisionUpdate = onCollisionUpdate;
        this.onAnimationStart = onAnimationStart;
        this.onRedraw = onRedraw;
        this.onSliderChange = onSliderChange;
    }

    /**
     * Update internal state and notify parent
     */
    _updateState(updates) {
        Object.assign(this, updates);
        if (this.onStateChange) {
            this.onStateChange({
                isPlacing: this.isPlacing,
                canPlace: this.canPlace,
                isFlickerActive: this.isFlickerActive,
                flick: { ...this.flick },
                flickMaxLength: this.flickMaxLength,
            });
        }
    }

    /**
     * Handle flick mouse down event
     */
    handleFlickMouseDown(
        e,
        { isMyTurn, strikerRef, isStrikerColliding, canvasRef, playerRole },
    ) {
        if (!isMyTurn || !strikerRef.current || !this.isFlickerActive) return;

        // prevent flicking if striker is colliding with coins
        if (isStrikerColliding) {
            return;
        }

        const rect = canvasRef.current.getBoundingClientRect();
        let x = e.clientX - rect.left;
        let y = e.clientY - rect.top;

        if (playerRole === "joiner") {
            x = canvasRef.current.width - x;
            y = canvasRef.current.height - y;
        }

        this._updateState({
            flick: {
                active: true,
                startX: strikerRef.current.x,
                startY: strikerRef.current.y,
                endX: x,
                endY: y,
            },
        });
    }

    /**
     * Handle flick mouse move event
     */
    handleFlickMouseMove(e, { isMyTurn, strikerRef, canvasRef, playerRole }) {
        if (
            !isMyTurn ||
            !strikerRef.current ||
            !this.isFlickerActive ||
            !this.flick.active
        ) {
            return;
        }

        const rect = canvasRef.current.getBoundingClientRect();
        let x = e.clientX - rect.left;
        let y = e.clientY - rect.top;

        if (playerRole === "joiner") {
            x = canvasRef.current.width - x;
            y = canvasRef.current.height - y;
        }

        // Calculate the distance from start to current mouse position
        const dx = x - this.flick.startX;
        const dy = y - this.flick.startY;
        const distance = Math.sqrt(dx * dx + dy * dy);

        // Cap the flick line at maximum length
        if (distance > this.flickMaxLength) {
            // Calculate the direction vector
            const directionX = dx / distance;
            const directionY = dy / distance;
            
            // Set the end point at maximum distance
            x = this.flick.startX + directionX * this.flickMaxLength;
            y = this.flick.startY + directionY * this.flickMaxLength;
        }

        this._updateState({
            flick: { ...this.flick, endX: x, endY: y },
        });
    }

    /**
     * Handle flick mouse up event
     */
    handleFlickMouseUp(e, { isMyTurn, strikerRef, isStrikerColliding, socket, roomName }) {
        if (
            !isMyTurn ||
            !strikerRef.current ||
            !this.isFlickerActive ||
            !this.flick.active
        ) {
            return;
        }

        // prevent execution if striker is colliding with coins
        if (!isStrikerColliding) {
            this._emitFlick({ strikerRef, socket, roomName });
        }

        this._updateState({
            flick: { active: false, startX: 0, startY: 0, endX: 0, endY: 0, mode: null, initialClickX: 0, initialClickY: 0 },
        });
    }
    
    /**
     * Handle mouse down event (unified handler)
     */
    handleMouseDown(
        e,
        {
            isAnimating,
            isMyTurn,
            strikerRef,
            canvasRef,
            playerRole,
            isStrikerColliding,
            socket,
            roomName,
        },
    ) {

        // block all input when animation is active
        if (isAnimating || !isMyTurn || !strikerRef.current) return;

        const rect = canvasRef.current.getBoundingClientRect();
        let x = e.clientX - rect.left;
        let y = e.clientY - rect.top;

        if (playerRole === "joiner") {
            x = canvasRef.current.width - x;
            y = canvasRef.current.height - y;
        }
        
        // Check if striker is in idle state (not moving) AND not colliding with coins
        if (!strikerRef.current.isStrikerMoving && !isStrikerColliding) {
            // Check if click is on the striker
            const clickedOnStriker = strikerRef.current.isPointInside(x, y);
            
            if (clickedOnStriker) {
                // Mode 1: Clicked on striker - store initial click position relative to striker
                this._updateState({
                    isFlickerActive: true,
                    flick: {
                        active: true,
                        startX: strikerRef.current.x,  // Always draw from striker center
                        startY: strikerRef.current.y,
                        endX: strikerRef.current.x,    // Start with no offset
                        endY: strikerRef.current.y,
                        mode: 'striker',
                        initialClickX: x,  // Store where the user clicked
                        initialClickY: y,
                    },
                });
            } else {
                // Mode 2: Clicked elsewhere - store click position as virtual reference
                this._updateState({
                    isFlickerActive: true,
                    flick: {
                        active: true,
                        startX: strikerRef.current.x,  // Always draw from striker center
                        startY: strikerRef.current.y,
                        endX: strikerRef.current.x,    // Start with no offset
                        endY: strikerRef.current.y,
                        mode: 'remote',
                        initialClickX: x,  // Store the virtual reference point
                        initialClickY: y,
                    },
                });
            }

            // Redraw to show flick line
            if (this.onRedraw) {
                this.onRedraw();
            }
        }

        // Save context and start global tracking
        this._lastContext = {
            isAnimating,
            isMyTurn,
            strikerRef,
            canvasRef,
            playerRole,
            isStrikerColliding,
            socket,
            roomName,
        };
        this.isMouseDown = true;
        this._addGlobalListeners();
    }
    
    /**
     * Handle mouse move event (unified handler)
     */
    handleMouseMove(
        e,
        {
            isAnimating,
            isMyTurn,
            strikerRef,
            canvasRef,
            playerRole,
            coinsRef,
            socket,
            roomName,
            isStrikerColliding,
        },
    ) {
        // block all input when animation is active
        if (isAnimating || !isMyTurn) return;

        // Update flick line when we're in flick mode and have an active flick
        // BUT stop flicking immediately if striker is now colliding with coins
        if (this.isFlickerActive && this.flick.active && strikerRef.current) {
            
            // If striker is now colliding, cancel the flick interaction
            if (isStrikerColliding) {
                this._updateState({
                    isFlickerActive: false,
                    flick: {
                        active: false,
                        startX: 0,
                        startY: 0,
                        endX: 0,
                        endY: 0,
                        mode: null,
                        initialClickX: 0,
                        initialClickY: 0,
                    },
                });
                
                // Redraw to clear flick line
                if (this.onRedraw) {
                    this.onRedraw();
                }

                return;
            }

            const rect = canvasRef.current.getBoundingClientRect();
            let x = e.clientX - rect.left;
            let y = e.clientY - rect.top;

            if (playerRole === "joiner") {
                x = canvasRef.current.width - x;
                y = canvasRef.current.height - y;
            }
            
            let newEndX, newEndY;
            let startX = strikerRef.current.x;  // Always draw from current striker position
            let startY = strikerRef.current.y;

            // Calculate relative mouse movement from initial click position
            const deltaX = x - this.flick.initialClickX;
            const deltaY = y - this.flick.initialClickY;

            if (this.flick.mode === 'striker') {
                // Mode 1: Apply relative movement directly from striker center
                newEndX = strikerRef.current.x + deltaX;
                newEndY = strikerRef.current.y + deltaY;
            } else if (this.flick.mode === 'remote') {
                // Mode 2: Apply relative movement from striker center
                newEndX = strikerRef.current.x + deltaX;
                newEndY = strikerRef.current.y + deltaY;
            }
            
            // Calculate distance and cap at maximum length
            const dx = newEndX - startX;
            const dy = newEndY - startY;
            const distance = Math.sqrt(dx * dx + dy * dy);

            // Cap the flick line at maximum length
            if (distance > this.flickMaxLength) {
                const directionX = dx / distance;
                const directionY = dy / distance;
                newEndX = startX + directionX * this.flickMaxLength;
                newEndY = startY + directionY * this.flickMaxLength;
            }

            this._updateState({
                flick: { 
                    ...this.flick, 
                    active: true, // Ensure flick remains active during movement
                    startX: startX, // Always use current striker position
                    startY: startY,
                    endX: newEndX, 
                    endY: newEndY 
                },
            });

            // Redraw to show updated flick line
            if (this.onRedraw) {
                this.onRedraw();
            }
        }

        // Use saved context for global moves if needed
        const ctx = this._lastContext;
        if (!ctx) return;

        const rect = ctx.canvasRef.current.getBoundingClientRect();
        let x = e.clientX - rect.left;
        let y = e.clientY - rect.top;

        if (ctx.playerRole === "joiner") {
            x = ctx.canvasRef.current.width - x;
            y = ctx.canvasRef.current.height - y;
        }
        
        let newEndX, newEndY;
        let startX = ctx.strikerRef.current.x;  // Always draw from current striker position
        let startY = ctx.strikerRef.current.y;

        // Calculate relative mouse movement from initial click position
        const deltaX = x - this.flick.initialClickX;
        const deltaY = y - this.flick.initialClickY;

        if (this.flick.mode === 'striker') {
            // Mode 1: Apply relative movement directly from striker center
            newEndX = ctx.strikerRef.current.x + deltaX;
            newEndY = ctx.strikerRef.current.y + deltaY;
        } else if (this.flick.mode === 'remote') {
            // Mode 2: Apply relative movement from striker center
            newEndX = ctx.strikerRef.current.x + deltaX;
            newEndY = ctx.strikerRef.current.y + deltaY;
        }
        
        // Calculate distance and cap at maximum length
        const dx = newEndX - startX;
        const dy = newEndY - startY;
        const distance = Math.sqrt(dx * dx + dy * dy);

        // Cap the flick line at maximum length
        if (distance > this.flickMaxLength) {
            const directionX = dx / distance;
            const directionY = dy / distance;
            newEndX = startX + directionX * this.flickMaxLength;
            newEndY = startY + directionY * this.flickMaxLength;
        }

        this._updateState({
            flick: { 
                ...this.flick, 
                active: true, // Ensure flick remains active during movement
                startX: startX, // Always use current striker position
                startY: startY,
                endX: newEndX, 
                endY: newEndY 
            },
        });

        // Redraw to show updated flick line
        if (this.onRedraw) {
            this.onRedraw();
        }
    }
    
    /**
     * Handle mouse up event (unified handler)
     */
    handleMouseUp(
        e,
        {
            isAnimating,
            isMyTurn,
            strikerRef,
            isStrikerColliding,
            coinsRef,
            socket,
            roomName,
            playerRole,
        },
    ) {
        // block all input when animation is active
        if (isAnimating || !isMyTurn) return;
        if (this.isFlickerActive && strikerRef.current) {
            // Prevent flicking if striker is colliding with coins
            if (isStrikerColliding) {
                // Reset flick state without executing the flick
                this._updateState({
                    isFlickerActive: false,
                    flick: {
                        active: false,
                        startX: 0,
                        startY: 0,
                        endX: 0,
                        endY: 0,
                        mode: null,
                        initialClickX: 0,
                        initialClickY: 0,
                    },
                });
                
                // Redraw to clear flick line
                if (this.onRedraw) {
                    this.onRedraw();
                }
                return;
            }

            // Calculate flick power and direction based on mode
            let dx, dy;
            if (this.flick.mode === 'striker' || this.flick.mode === 'remote') {
                dx = this.flick.startX - this.flick.endX;
                dy = this.flick.startY - this.flick.endY;
            }

            const distance = Math.sqrt(dx * dx + dy * dy);
            if (distance > 5) {
                // Server is the simulation source of truth: emit angle/force only.
                this._emitFlick({ strikerRef, socket, roomName });
            }

            // Reset flick state
            this._updateState({
                isFlickerActive: false,
                flick: {
                    ...this.flick,
                    active: false,
                    mode: null,
                    initialClickX: 0,
                    initialClickY: 0,
                },
            });

            // Redraw to clear flick line
            if (this.onRedraw) {
                this.onRedraw();
            }
        }

        // Clean up global tracking
        this.isMouseDown = false;
        this._removeGlobalListeners();

        // Use saved context for global mouseup if needed
        const ctx = this._lastContext;
        if (!ctx) return;

        // Prevent flicking if striker is colliding with coins
        if (isStrikerColliding) {
            
            // Reset flick state without executing the flick
            this._updateState({
                isFlickerActive: false,
                flick: {
                    active: false,
                    startX: 0,
                    startY: 0,
                    endX: 0,
                    endY: 0,
                    mode: null,
                    initialClickX: 0,
                    initialClickY: 0,
                },
            });
            
            // Redraw to clear flick line
            if (this.onRedraw) {
                this.onRedraw();
            }
            return;
        }
        
        // Calculate flick power and direction based on mode
        let dx, dy;
          if (this.flick.mode === 'striker') {
            // Mode 1: Direction is OPPOSITE of drag (striker moves away from drag direction)
            dx = this.flick.startX - this.flick.endX;  // Reversed direction
            dy = this.flick.startY - this.flick.endY;  // Reversed direction
        } else if (this.flick.mode === 'remote') {
            // Mode 2: Direction is OPPOSITE of flick line (same slingshot effect as Mode 1)
            dx = this.flick.startX - this.flick.endX;  // Reversed direction (opposite of flick line)
            dy = this.flick.startY - this.flick.endY;  // Reversed direction (opposite of flick line)
        }

        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance > 5) {
            // Server is the simulation source of truth.
            this._emitFlick({
                strikerRef: ctx.strikerRef,
                socket: ctx.socket,
                roomName: ctx.roomName,
            });
        }
        
        // Reset flick state
        this._updateState({
            isFlickerActive: false,
            flick: {
                ...this.flick,
                active: false,
                mode: null,
                initialClickX: 0,
                initialClickY: 0,
            },
        });

        // Redraw to clear flick line
        if (this.onRedraw) {
            this.onRedraw();
        }
    }    /**
     * Add global window-level mouse event listeners
     */
    _addGlobalListeners() {
        if (!this.globalListenersAdded) {
            window.addEventListener('mousemove', this._handleGlobalMouseMove);
            window.addEventListener('mouseup', this._handleGlobalMouseUp);
            this.globalListenersAdded = true;
        }
    }

    /**
     * Remove global window-level mouse event listeners
     */
    _removeGlobalListeners() {
        if (this.globalListenersAdded) {
            window.removeEventListener('mousemove', this._handleGlobalMouseMove);
            window.removeEventListener('mouseup', this._handleGlobalMouseUp);
            this.globalListenersAdded = false;
        }
    }

    /**
     * Global mousemove handler for maintaining flick outside board
     */
    _handleGlobalMouseMove(e) {
        if (this.isMouseDown && this._lastContext) {
            this.handleMouseMove(e, this._lastContext);
        }
    }

    /**
     * Global mouseup handler for finalizing flick anywhere
     */
    _handleGlobalMouseUp(e) {
        if (this.isMouseDown && this._lastContext) {
            this.handleMouseUp(e, this._lastContext);
        }
    }

    /**
     * No-op for mouse leaving canvas - maintain flick until actual mouseup
     */
    handleMouseLeave(e, context) {
        // We intentionally do nothing here to keep the flick active
        // The global mouse handlers will take care of move/up events
    }    /**
     * Calculate slider boundaries based on legal striker movement area
     * Restricts slider to the base width (legal striker X axis) instead of full board
     */
    calculateSliderBoundaries(canvasRef, strikerRadius = 21) {
        if (!canvasRef.current) return;

        const ctx = canvasRef.current.getContext("2d");
        const boardX = (ctx.canvas.width - Draw.BOARD_SIZE) / 2;
        
        // Calculate the legal striker area boundaries (base width, not full board)
        const baseX = boardX + (Draw.BOARD_SIZE - Draw.BASE_WIDTH) / 2;
        
        this.sliderMin = baseX + strikerRadius;
        this.sliderMax = baseX + Draw.BASE_WIDTH - strikerRadius;
    }
    
    /**
     * Convert slider percentage to X coordinate
     */
    sliderToX(percentage, playerRole = "creator") {
        if (this.sliderMax === 0) return 0;
        
        // Invert percentage for joiner player due to canvas rotation
        const adjustedPercentage = playerRole === "joiner" ? (100 - percentage) : percentage;
        
        return this.sliderMin + (this.sliderMax - this.sliderMin) * (adjustedPercentage / 100);
    }

    /**
     * Convert X coordinate to slider percentage
     */
    xToSlider(x, playerRole = "creator") {
        if (this.sliderMax === 0) return 50;
        
        const percentage = Math.max(0, Math.min(100, ((x - this.sliderMin) / (this.sliderMax - this.sliderMin)) * 100));
        
        // Invert percentage for joiner player due to canvas rotation
        return playerRole === "joiner" ? (100 - percentage) : percentage;
    }
    
    /**
     * Handle slider value change
     */
    handleSliderChange(newValue, strikerRef, socket, roomName, playerRole) {
        this.sliderValue = Math.max(0, Math.min(100, newValue));
        
        if (strikerRef.current) {
            const newX = this.sliderToX(this.sliderValue, playerRole);
            strikerRef.current.updatePosition(newX, strikerRef.current.y);
              // Emit slider position to other player
            // Always send the actual slider value, let the receiver handle coordinate conversion
            if (socket && roomName && this.onSliderChange) {
                this.onSliderChange({
                    sliderValue: this.sliderValue,
                    strikerX: newX,
                    playerRole
                });
            }
        }
    }

    /**
     * Handle delta-based slider movement for touch/mouse
     */
    handleSliderDelta(deltaX, strikerRef, socket, roomName, playerRole) {
        const deltaValue = deltaX * this.sliderSensitivity;
        const newValue = this.sliderValue + deltaValue;
        this.handleSliderChange(newValue, strikerRef, socket, roomName, playerRole);
    }    /**
     * Get current state for external access
     */
    getState() {
        return {
            isPlacing: this.isPlacing,
            canPlace: this.canPlace,
            isFlickerActive: this.isFlickerActive,
            flick: { ...this.flick },
            flickMaxLength: this.flickMaxLength,
            sliderValue: this.sliderValue,
        };
    }

    /**
     * Reset state (useful for game resets)
     */
    reset() {
        this.flickMaxLength = Hand.FLICK_MAX_LENGTH;
        this._updateState({
            isPlacing: false,
            canPlace: true,
            isFlickerActive: false,
            flick: { active: false, startX: 0, startY: 0, endX: 0, endY: 0, mode: null, initialClickX: 0, initialClickY: 0 },
        });
    }
}

export default Hand;
