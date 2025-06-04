import { Board } from '/board.js';
import { Player } from '/player.js';

export class GameManager {
  constructor(scene, config) {
    this.scene = scene;
    this.config = config;
    this.board = new Board(scene, config);
    this.players = [
      new Player(1, "Player 1", "white"),
      new Player(2, "Player 2", "black")
    ];
    this.currentPlayerIndex = 0;
    this.turnStarted = false;
    this.turnScore = 0;
    this.turnPocketedCoins = [];
    this.maintainTurn = false;
    this.shouldSwitchTurn = false;
    this.queenPocketedThisTurn = false;
    this.coverTurn = false;
    this.pendingQueenCoin = null;
    this.firstTurn = true;
    this.maxScore = 10;
  }

  initialize() {
    this.board.initialize();
    this.players.forEach(player => player.resetScore());
    this.currentPlayerIndex = 0;
    this.turnStarted = false;
    this.turnScore = 0;
    this.turnPocketedCoins = [];
    this.maintainTurn = false;
    this.shouldSwitchTurn = false;
    this.queenPocketedThisTurn = false;
    this.coverTurn = false;
    this.pendingQueenCoin = null;
    this.firstTurn = true;
  }

  getCurrentPlayer() {
    return this.players[this.currentPlayerIndex];
  }

  getOpponentPlayer() {
    return this.players[(this.currentPlayerIndex + 1) % this.players.length];
  }

  switchTurn() {
    this.currentPlayerIndex = (this.currentPlayerIndex + 1) % this.players.length;
    this.board.rotateBoard();
    this.board.resetScore();
    this.turnScore = 0;
    this.turnPocketedCoins = [];
    this.maintainTurn = false;
    this.shouldSwitchTurn = false;
    this.queenPocketedThisTurn = false;
    this.coverTurn = false;
    this.pendingQueenCoin = null;
    this.getCurrentPlayer().setPendingQueen(false);
    this.turnStarted = false;
  }

  resetGame() {
    this.board.initialize();
    this.players.forEach(player => player.resetScore());
    this.currentPlayerIndex = 0;
    this.turnStarted = false;
    this.turnScore = 0;
    this.turnPocketedCoins = [];
    this.maintainTurn = false;
    this.shouldSwitchTurn = false;
    this.queenPocketedThisTurn = false;
    this.coverTurn = false;
    this.pendingQueenCoin = null;
    this.firstTurn = true;
  }

  startCoverTurn() {
    this.board.resetScore();
    this.turnScore = 0;
    this.turnPocketedCoins = [];
    this.maintainTurn = false;
    this.shouldSwitchTurn = false;
    this.queenPocketedThisTurn = false;
    this.coverTurn = true;
    this.board.setStrikerState("idle");
    this.board.striker.x = this.config.strikerDefaultX;
    this.board.striker.y = this.config.strikerDefaultY;
    this.board.striker.vx = 0;
    this.board.striker.vy = 0;
    this.board.slider.handle.cx = this.config.strikerDefaultX;
    this.board.strikerResetTimer = 0;
    this.turnStarted = false;
  }

  update(time, delta) {
    this.board.update(time, delta, this.firstTurn, this.getCurrentPlayer());
    const pocketedCoins = this.board.getPocketedCoins();

    for (const coin of pocketedCoins) {
      this.turnPocketedCoins.push(coin);
      const index = this.board.coins.findIndex(c => c.color === coin.color && c.processedPocket);
      if (index === -1) continue;
      const coinObj = this.board.coins[index];
      if (coin.color === 'queen') {
        if (this.getCurrentPlayer().hasPendingQueen()) {
          continue;
        }
        this.getCurrentPlayer().addScore(1);
        this.turnScore += 1;
        this.maintainTurn = true;
        this.queenPocketedThisTurn = true;
        this.getCurrentPlayer().setPendingQueen(true);
        this.pendingQueenCoin = coinObj;
        if (this.getCurrentPlayer().getScore() <= 0) {
          this.board.moveCoinToCenter(coinObj);
          this.pendingQueenCoin = null;
          this.getCurrentPlayer().setPendingQueen(false);
          this.queenPocketedThisTurn = false;
          this.coverTurn = false;
        } else {
          coinObj.sprite.destroy();
          this.board.coins.splice(index, 1);
        }
      } else {
        const currentPlayerColor = this.getCurrentPlayer().getColor();
        if (coin.color === currentPlayerColor) {
          this.getCurrentPlayer().addScore(1);
          this.turnScore += 1;
          this.maintainTurn = true;
          if (this.getCurrentPlayer().getScore() <= 0) {
            this.board.moveCoinToCenter(coinObj);
          } else {
            this.getCurrentPlayer().addPocketedCoin(coin.color);
            coinObj.sprite.destroy();
            this.board.coins.splice(index, 1);
            if (this.getCurrentPlayer().hasPendingQueen() && this.pendingQueenCoin) {
              this.getCurrentPlayer().addPocketedCoin('queen');
              this.getCurrentPlayer().setPendingQueen(false);
              this.queenPocketedThisTurn = false;
              this.coverTurn = false;
              this.pendingQueenCoin = null;
            }
          }
        } else {
          this.getOpponentPlayer().addScore(1);
          this.shouldSwitchTurn = true;
          if (this.getOpponentPlayer().getScore() <= 0) {
            this.board.moveCoinToCenter(coinObj);
          } else {
            this.getOpponentPlayer().addPocketedCoin(coin.color);
            coinObj.sprite.destroy();
            this.board.coins.splice(index, 1);
          }
        }
      }
      coinObj.processedPocket = false;
    }

    this.board.clearPocketedCoins();

    if (this.getCurrentPlayer().getScore() >= this.maxScore || this.getOpponentPlayer().getScore() >= this.maxScore) {
      this.resetGame();
      return;
    }

    if (this.board.getStrikerState() === "moving") {
      this.turnStarted = true;
      if (this.firstTurn) {
        this.firstTurn = false;
      }
    }

    if (this.turnStarted && (this.board.getStrikerState() === "idle" || this.board.getStrikerState() === "pocket")) {
      if (this.coverTurn && this.getCurrentPlayer().hasPendingQueen()) {
        const hasMatchingCoin = this.turnPocketedCoins.some(coin => coin.color === this.getCurrentPlayer().getColor());
        if (!hasMatchingCoin) {
          this.getCurrentPlayer().addScore(-1);
          this.getCurrentPlayer().setPendingQueen(false);
          this.queenPocketedThisTurn = false;
          this.coverTurn = false;
          this.board.spawnCoin('queen');
          this.pendingQueenCoin = null;
          this.switchTurn();
          return;
        }
      }

      if (this.board.getStrikerState() === "pocket") {
        this.getCurrentPlayer().addScore(-1);
        const coinColor = this.getCurrentPlayer().removePocketedCoin();
        if (coinColor) {
          this.board.spawnCoin(coinColor);
        }
        this.switchTurn();
      } else if (this.turnPocketedCoins.length > 0) {
        if (this.maintainTurn && !this.shouldSwitchTurn) {
          this.board.resetScore();
          this.turnScore = 0;
          this.turnPocketedCoins = [];
          this.maintainTurn = false;
          this.shouldSwitchTurn = false;
          this.queenPocketedThisTurn = false;
          if (this.getCurrentPlayer().hasPendingQueen()) {
            this.startCoverTurn();
          } else {
            this.coverTurn = false;
            this.board.setStrikerState("idle");
            this.board.striker.x = this.config.strikerDefaultX;
            this.board.striker.y = this.config.strikerDefaultY;
            this.board.striker.vx = 0;
            this.board.striker.vy = 0;
            this.board.slider.handle.cx = this.config.strikerDefaultX;
            this.board.strikerResetTimer = 0;
            this.turnStarted = false;
          }
        } else {
          this.switchTurn();
        }
      } else {
        if (this.getCurrentPlayer().hasPendingQueen()) {
          this.startCoverTurn();
        } else {
          this.switchTurn();
        }
      }
    }
  }

  handlePointerDown(ptr) {
    const striker = this.board.getStriker();
    const slingshot = this.board.getSlingshot();
    const strikerState = this.board.getStrikerState();

    if (strikerState === "idle") {
        let hasDragged = false;
        slingshot.ghostX = ptr.x;
        slingshot.ghostY = ptr.y;
        slingshot.startX = striker.x;
        slingshot.startY = striker.y;
        slingshot.endX = striker.x;
        slingshot.endY = striker.y;

        const canvas = this.scene.sys.canvas;
        const canvasBounds = canvas.getBoundingClientRect();

        const onPointerMove = (event) => {
            event.preventDefault();
            if (!slingshot.active) return;

            let pageX, pageY;
            if (event.touches) {
                const touch = event.touches[0];
                const rect = canvas.getBoundingClientRect();
                pageX = touch.clientX - rect.left;
                pageY = touch.clientY - rect.top;
            } else {
                const rect = canvas.getBoundingClientRect();
                pageX = event.clientX - rect.left;
                pageY = event.clientY - rect.top;
            }

            const scaleX = canvas.width / canvasBounds.width;
            const scaleY = canvas.height / canvasBounds.height;

            const moveX = (pageX * scaleX) - slingshot.ghostX;
            const moveY = (pageY * scaleY) - slingshot.ghostY;

            if (!hasDragged && Math.hypot(moveX, moveY) > 5) {
                hasDragged = true;
                this.board.setStrikerState("aiming");
            }

            if (hasDragged) {
                slingshot.endX = striker.x + moveX;
                slingshot.endY = striker.y + moveY;

                const dx = slingshot.endX - striker.x;
                const dy = slingshot.endY - striker.y;
                const dist = Math.hypot(dx, dy);

                if (dist > this.config.maxPower * 2) {
                    const scale = (this.config.maxPower * 2) / dist;
                    slingshot.endX = striker.x + dx * scale;
                    slingshot.endY = striker.y + dy * scale;
                }
            }
        };

        const onPointerUp = () => {
            if (slingshot.active && hasDragged) {
                const dx = slingshot.endX - striker.x;
                const dy = slingshot.endY - striker.y;
                const dist = Math.hypot(dx, dy);
                
                if (dist > 0.1) {
                    const power = Math.min(dist / 2, this.config.maxPower);
                    striker.vx = -(dx / dist) * power;
                    striker.vy = -(dy / dist) * power;
                    this.board.setStrikerState("moving");
                }
            }
            
            slingshot.active = false;
            if (!hasDragged) {
                this.board.setStrikerState("idle");
            }
            window.removeEventListener('touchmove', onPointerMove);
            window.removeEventListener('touchend', onPointerUp);
            window.removeEventListener('mousemove', onPointerMove);
            window.removeEventListener('mouseup', onPointerUp);
        };

        slingshot.active = true;
        window.addEventListener('touchmove', onPointerMove, { passive: false });
        window.addEventListener('touchend', onPointerUp);
        window.addEventListener('mousemove', onPointerMove);
        window.addEventListener('mouseup', onPointerUp);
    }
  }

  handlePointerMove(ptr) {
    const slider = this.board.getSlider();
    const rotationSlider = this.board.getRotationSlider();
    const strikerState = this.board.getStrikerState();

    if (strikerState !== "idle" && strikerState !== "aiming") {
        slider.dragging = false;
        return;
    }

    if (slider.dragging) {
        const newX = Phaser.Math.Clamp(ptr.x - slider.dragOffset, slider.min, slider.max);
        slider.handle.cx = newX;
        const htmlSlider = document.getElementById('striker-slider');
        const percent = (newX - slider.min) / (slider.max - slider.min);
        htmlSlider.value = percent * 100;
    }

    if (this.firstTurn && rotationSlider.dragging) {
      rotationSlider.handle.cx = Phaser.Math.Clamp(
          ptr.x - rotationSlider.dragOffset, 
          rotationSlider.min, 
          rotationSlider.max
      );
      const t = (rotationSlider.handle.cx - rotationSlider.min) / (rotationSlider.max - rotationSlider.min);
      const angle = t * 2 * Math.PI;
      this.board.rotateCentralCoins(angle);
    }
  }

  handlePointerUp(ptr) {
    const slider = this.board.getSlider();
    const rotationSlider = this.board.getRotationSlider();
    const striker = this.board.getStriker();
    const slingshot = this.board.getSlingshot();

    slider.dragging = false;
    rotationSlider.dragging = false;

    if (slingshot.active) {
      const dx = slingshot.startX - slingshot.endX;
      const dy = slingshot.startY - slingshot.endY;
      const dist = Math.hypot(dx, dy);
      const power = Math.min(dist / 2, this.config.maxPower);
      
      striker.vx = (dx / dist) * power;
      striker.vy = (dy / dist) * power;
      this.board.setStrikerState("moving");
      slingshot.active = false;
    }
  }
}