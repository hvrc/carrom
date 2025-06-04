export class Board {
  constructor(scene, config) {
    this.scene = scene;
    this.config = config;
    this.strikerState = "idle";
    this.strikerResetTimer = 0;
    this.score = 0;
    this.striker = null;
    this.coins = [];
    this.pockets = [];
    this.slider = null;
    this.rotationSlider = null;
    this.slingshot = null;
    this.gfx = null;
    this.debug = false;
    this.rotation = 0;
    this.pocketedCoins = [];

    this.bounds = {
      left: 40,
      right: 660,
      top: 40,
      bottom: 660
    };

    this.centerX = 350;
    this.centerY = 350;
    this.strikerRadius = 25;
    this.coinRadius = 15;
    this.pocketRadius = 22.5;
    this.ring1Radius = 32;
    this.ring2Radius = 62;
    this.strikerDefaultY = 585; // 557;
    this.strikerDefaultX = 350;

    this.displayedCoins = [];
    this.displayConfig = {
      startX: 15,
      startY: 620,
      spacing: 35,
      scale: 0.8
    };

    this.pocketPositionMultiplier = 1.5;
  }

  lerp(a, b, t) {
    return a + (b - a) * t;
  }

  getContainingPocket(obj) {
    for (const p of this.pockets) {
      const dx = obj.x - p.x, dy = obj.y - p.y;
      const dist = Math.hypot(dx, dy);
      const threshold = p.r - (obj.radius / 3);
      if (dist < threshold) return p;
    }
    return null;
  }

  resolveCollision(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const dist = Math.hypot(dx, dy);
    const minDist = a.radius + b.radius;
    
    if (dist < minDist && dist > 0) {
      const overlap = (minDist - dist) / 2;
      const nx = dx / dist, ny = dy / dist;
      a.x -= nx * overlap; a.y -= ny * overlap;
      b.x += nx * overlap; b.y += ny * overlap;

      const rvx = b.vx - a.vx, rvy = b.vy - a.vy;
      const velAlongNorm = rvx * nx + rvy * ny;
      if (velAlongNorm > 0) return;

      const imp = -(1 + this.config.restitution) * velAlongNorm / (1 / a.mass + 1 / b.mass);
      const ix = imp * nx, iy = imp * ny;
      a.vx -= ix / a.mass; a.vy -= iy / a.mass;
      b.vx += ix / b.mass; b.vy += iy / b.mass;
    }
  }

  checkPocket(obj) {
    return this.getContainingPocket(obj) !== null;
  }

  physicsUpdate(dt) {
    if (this.strikerState === "moving") {
      this.striker.x += this.striker.vx * dt * this.config.fps;
      this.striker.y += this.striker.vy * dt * this.config.fps;
    }
    this.striker.vx *= this.config.friction;
    this.striker.vy *= this.config.friction;
    const spd = Math.hypot(this.striker.vx, this.striker.vy);
    if (spd < 0.1) { this.striker.vx = this.striker.vy = 0; }

    if (this.striker.x < this.config.board.left + this.config.strikerRadius) {
      this.striker.x = this.config.board.left + this.config.strikerRadius;
      this.striker.vx = -this.striker.vx * this.config.restitution;
    } else if (this.striker.x > this.config.board.right - this.config.strikerRadius) {
      this.striker.x = this.config.board.right - this.config.strikerRadius;
      this.striker.vx = -this.striker.vx * this.config.restitution;
    }
    if (this.striker.y < this.config.board.top + this.config.strikerRadius) {
      this.striker.y = this.config.board.top + this.config.strikerRadius;
      this.striker.vy = -this.striker.vy * this.config.restitution;
    } else if (this.striker.y > this.config.board.bottom - this.config.strikerRadius) {
      this.striker.y = this.config.board.bottom - this.config.strikerRadius;
      this.striker.vy = -this.striker.vy * this.config.restitution;
    }

    for (const c of this.coins) {
      if (!c.pocket) {
        c.x += c.vx * dt * this.config.fps;
        c.y += c.vy * dt * this.config.fps;
      }
      c.vx *= this.config.friction;
      c.vy *= this.config.friction;
      const cs = Math.hypot(c.vx, c.vy);
      if (cs < 0.1) { c.vx = c.vy = 0; }

      if (c.x < this.config.board.left + c.radius) {
        c.x = this.config.board.left + c.radius;
        c.vx = -c.vx * this.config.restitution;
      } else if (c.x > this.config.board.right - c.radius) {
        c.x = this.config.board.right - c.radius;
        c.vx = -c.vx * this.config.restitution;
      }
      if (c.y < this.config.board.top + c.radius) {
        c.y = this.config.board.top + c.radius;
        c.vy = -c.vy * this.config.restitution;
      } else if (c.y > this.config.board.bottom - c.radius) {
        c.y = this.config.board.bottom - c.radius;
        c.vy = -c.vy * this.config.restitution;
      }
    }

    for (const c of this.coins) this.resolveCollision(this.striker, c);

    for (let i = 0; i < this.coins.length; i++)
      for (let j = i + 1; j < this.coins.length; j++)
        this.resolveCollision(this.coins[i], this.coins[j]);

    const pullF = 3 * dt;
    let p = this.getContainingPocket(this.striker);
    if (p) {
      this.striker.x = this.lerp(this.striker.x, p.x, pullF);
      this.striker.y = this.lerp(this.striker.y, p.y, pullF);
    }
    for (const c of this.coins) {
      const pp = this.getContainingPocket(c);
      if (pp) {
        c.x = this.lerp(c.x, pp.x, pullF);
        c.y = this.lerp(c.y, pp.y, pullF);
      }
    }
  }

  renderPocketedCoin(coin) {
    // const x = this.displayConfig.startX;
    // const y = this.displayConfig.startY - (this.displayedCoins.length * this.displayConfig.spacing);

    // const coinImg = document.createElement('img');
    // coinImg.src = `images/${coin.color}.png`;
    // coinImg.style.position = 'absolute';
    // coinImg.style.left = `${x}px`;
    // coinImg.style.top = `${y}px`;
    // coinImg.style.width = `${this.coinRadius * 2 * this.displayConfig.scale}px`;
    // coinImg.style.height = `${this.coinRadius * 2 * this.displayConfig.scale}px`;
    // coinImg.style.zIndex = '1000';

    // const gameContainer = document.getElementById('game-container');
    // gameContainer.appendChild(coinImg);

    // this.displayedCoins.push({ 
    //     element: coinImg, 
    //     id: coin.id,
    //     color: coin.color 
    // });

    coin.processedPocket = true;
  }

  moveCoinToCenter(coin) {
    coin.x = this.config.centerX;
    coin.y = this.config.centerY;
    coin.vx = 0;
    coin.vy = 0;
    coin.pocket = false;
    coin.pocketTimer = 0;
    coin.processedPocket = false;
    coin.sprite.setPosition(coin.x, coin.y);
  }

  spawnCoin(color) {
    const coinIdCounter = this.coins.length > 0 ? Math.max(...this.coins.map(c => parseInt(c.id.split('-')[1]))) + 1 : 0;
    const coin = {
      id: `coin-${coinIdCounter}`,
      x: this.config.centerX,
      y: this.config.centerY,
      radius: this.config.coinRadius,
      vx: 0,
      vy: 0,
      mass: 0.8,
      sprite: this.scene.add.sprite(this.config.centerX, this.config.centerY, color)
        .setDisplaySize(this.config.coinRadius * 2, this.config.coinRadius * 2),
      pocket: false,
      pocketTimer: 0,
      color: color,
      processedPocket: false
    };
    this.coins.push(coin);
  }

  rotateCentralCoins(angle) {
    const centerX = this.config.centerX;
    const centerY = this.config.centerY;
    const ring1Count = this.config.ring1Count;
    const ring2Count = this.config.ring2Count;

    for (let i = 0; i < ring1Count + ring2Count + 1; i++) {
      const coin = this.coins[i];
      let relX, relY, baseAngle, radius;

      if (i < ring1Count) {
        baseAngle = (i * (2 * Math.PI / ring1Count));
        radius = this.config.ring1Radius;
      } else if (i < ring1Count + ring2Count) {
        baseAngle = ((i - ring1Count) * (2 * Math.PI / ring2Count));
        radius = this.config.ring2Radius;
      } else {
        baseAngle = 0;
        radius = 0;
      }

      const newAngle = baseAngle + angle;
      relX = radius * Math.cos(newAngle);
      relY = radius * Math.sin(newAngle);
      coin.x = centerX + relX;
      coin.y = centerY + relY;
      coin.sprite.setPosition(coin.x, coin.y);
    }
  }

  initialize() {
    if (this.boardSprite) this.boardSprite.destroy();
    if (this.gfx) this.gfx.destroy();
    if (this.striker) this.striker.sprite.destroy();
    if (this.turnText) this.turnText.remove();
    this.coins.forEach(coin => coin.sprite.destroy());
    this.coins = [];

    this.displayedCoins.forEach(display => display.element.remove());
    this.displayedCoins = [];

    this.gfx = this.scene.add.graphics();
    this.turnText = document.createElement('div');
    this.scoreText = document.getElementById('score-indicator');

    this.boardSprite = this.scene.add.image(0, 0, 'board')
      .setOrigin(0)
      .setDisplaySize(this.config.w, this.config.h);

    this.slider = {
      min: this.config.board.left + this.config.strikerRadius + this.config.sliderOffset,
      max: this.config.board.right - this.config.strikerRadius - this.config.sliderOffset,
      track: { x: null, y: null, width: null, height: 4 },
      handle: { radius: this.config.sliderHandleRadius, cx: this.config.strikerDefaultX, cy: null },
      dragging: false,
      dragOffset: 0
    };

    this.slider.track.x = this.slider.min;
    this.slider.track.y = this.config.h - 20;
    this.slider.track.width = this.slider.max - this.slider.min;
    this.slider.track.height = 4;
    this.slider.handle.cy = this.slider.track.y;

    this.rotationSlider = {
      min: this.config.board.left + this.config.strikerRadius + this.config.rotationSliderOffset,
      max: this.config.board.right - this.config.strikerRadius - this.config.rotationSliderOffset,
      track: { x: null, y: null, width: null, height: 4 },
      handle: { radius: this.config.sliderHandleRadius, cx: this.config.centerX, cy: null },
      dragging: false,
      dragOffset: 0
    };

    this.rotationSlider.track.x = this.rotationSlider.min;
    this.rotationSlider.track.y = 20;
    this.rotationSlider.track.width = this.rotationSlider.max - this.rotationSlider.min;
    this.rotationSlider.handle.cy = this.rotationSlider.track.y;

    this.pockets = [
      { 
          x: this.config.board.left + this.config.pocketRadius * this.pocketPositionMultiplier, 
          y: this.config.board.top + this.config.pocketRadius * this.pocketPositionMultiplier, 
          r: this.config.pocketRadius 
      },
      { 
          x: this.config.board.right - this.config.pocketRadius * this.pocketPositionMultiplier, 
          y: this.config.board.top + this.config.pocketRadius * this.pocketPositionMultiplier, 
          r: this.config.pocketRadius 
      },
      { 
          x: this.config.board.left + this.config.pocketRadius * this.pocketPositionMultiplier, 
          y: this.config.board.bottom - this.config.pocketRadius * this.pocketPositionMultiplier, 
          r: this.config.pocketRadius 
      },
      { 
          x: this.config.board.right - this.config.pocketRadius * this.pocketPositionMultiplier, 
          y: this.config.board.bottom - this.config.pocketRadius * this.pocketPositionMultiplier, 
          r: this.config.pocketRadius 
      }
    ];

    this.striker = {
      x: this.config.strikerDefaultX,
      y: this.config.strikerDefaultY,
      radius: this.config.strikerRadius,
      vx: 0,
      vy: 0,
      mass: 1.0,
      sprite: this.scene.add.sprite(this.config.strikerDefaultX, this.config.strikerDefaultY, 'striker')
        .setDisplaySize(this.config.strikerRadius * 2, this.config.strikerRadius * 2)
    };

    this.slingshot = { active: false, startX: 0, startY: 0, endX: 0, endY: 0, maxLength: this.config.slingshotMaxLength };
    this.coins = [];

    let ci = 1;
    const getImageKey = (i) => (i % 2 ? 'white' : 'black');
    let coinIdCounter = 0;

    for (let i = 0; i < this.config.ring1Count; i++) {
      const ang = i * (2 * Math.PI / this.config.ring1Count);
      const x = this.config.centerX + this.config.ring1Radius * Math.cos(ang);
      const y = this.config.centerY + this.config.ring1Radius * Math.sin(ang);
      const color = getImageKey(ci++);
      const coin = {
        id: `coin-${coinIdCounter++}`,
        x: x,
        y: y,
        radius: this.config.coinRadius,
        vx: 0,
        vy: 0,
        mass: 0.8,
        sprite: this.scene.add.sprite(x, y, color)
          .setDisplaySize(this.config.coinRadius * 2, this.config.coinRadius * 2),
        pocket: false,
        pocketTimer: 0,
        color: color,
        processedPocket: false
      };
      this.coins.push(coin);
    }

    for (let i = 0; i < this.config.ring2Count; i++) {
      const ang = i * (2 * Math.PI / this.config.ring2Count);
      const x = this.config.centerX + this.config.ring2Radius * Math.cos(ang);
      const y = this.config.centerY + this.config.ring2Radius * Math.sin(ang);
      const color = getImageKey(ci++);
      const coin = {
        id: `coin-${coinIdCounter++}`,
        x: x,
        y: y,
        radius: this.config.coinRadius,
        vx: 0,
        vy: 0,
        mass: 0.8,
        sprite: this.scene.add.sprite(x, y, color)
          .setDisplaySize(this.config.coinRadius * 2, this.config.coinRadius * 2),
        pocket: false,
        pocketTimer: 0,
        color: color,
        processedPocket: false
      };
      this.coins.push(coin);
    }

    const queen = {
      id: `coin-${coinIdCounter++}`,
      x: this.config.centerX,
      y: this.config.centerY,
      radius: this.config.coinRadius,
      vx: 0,
      vy: 0,
      mass: 0.8,
      sprite: this.scene.add.sprite(this.config.centerX, this.config.centerY, 'queen')
        .setDisplaySize(this.config.coinRadius * 2, this.config.coinRadius * 2),
      pocket: false,
      pocketTimer: 0,
      color: 'queen',
      processedPocket: false
    };
    this.coins.push(queen);

    this.strikerState = "idle";
    this.strikerResetTimer = 0;
    this.score = 0;
    this.rotation = 0;
    this.pocketedCoins = [];

    const scoreContainer = document.createElement('div');
    scoreContainer.style.position = 'absolute';
    scoreContainer.style.display = 'flex';
    scoreContainer.style.justifyContent = 'space-between';
    scoreContainer.style.alignItems = 'baseline';
    scoreContainer.style.gap = '0';
    scoreContainer.style.width = '88%';
    scoreContainer.style.bottom = '-10px';
    scoreContainer.style.left = '6%';
    scoreContainer.style.padding = '0 0px';
    scoreContainer.style.fontFamily = 'custom-font';
    scoreContainer.style.color = '#ecd8ba';

    const turnContainer = document.createElement('div');
    turnContainer.style.position = 'absolute';
    turnContainer.style.left = '35px';
    turnContainer.style.top = '-22px';
    turnContainer.style.fontFamily = 'custom-font';
    turnContainer.style.color = '#ecd8ba';

    const titleContainer = document.createElement('div');
    titleContainer.style.position = 'absolute';
    titleContainer.style.right = '40px';
    titleContainer.style.top = '-22px';
    titleContainer.style.fontFamily = 'custom-font';
    titleContainer.style.color = '#ecd8ba';

    this.turnText = document.createElement('div');
    this.turnText.style.fontSize = '42px';
    this.turnText.style.lineHeight = '1';
    this.turnText.style.transformOrigin = 'center';
    this.turnText.style.whiteSpace = 'nowrap';

    const whiteScore = document.createElement('div');
    whiteScore.id = 'white-score';
    whiteScore.style.fontSize = '32px';
    whiteScore.style.lineHeight = '1';

    const blackScore = document.createElement('div');
    blackScore.id = 'black-score';
    blackScore.style.fontSize = '32px';
    blackScore.style.lineHeight = '1';

    const titleText = document.createElement('div');
    titleText.textContent = 'carrom';
    titleText.style.fontSize = '42px';
    titleText.style.lineHeight = '1';
    // titleText.style.transform = 'rotate(-90deg)';
    titleText.style.transformOrigin = 'center';
    titleText.style.whiteSpace = 'nowrap';

    turnContainer.appendChild(this.turnText);
    scoreContainer.appendChild(whiteScore);
    scoreContainer.appendChild(blackScore);
    titleContainer.appendChild(titleText);
    
    const gameContainer = document.getElementById('game-container');
    gameContainer.style.position = 'relative';
    gameContainer.appendChild(turnContainer);
    gameContainer.appendChild(scoreContainer);
    gameContainer.appendChild(titleContainer);

    scoreContainer.classList.add('score-container');
    turnContainer.classList.add('turn-container');
    titleContainer.classList.add('title-container');

    const htmlSlider = document.getElementById('striker-slider');
    let lastX = null;

    htmlSlider.addEventListener('touchstart', (e) => {
        if (this.strikerState !== "idle") return;
        lastX = e.touches[0].clientX;
        e.preventDefault();
    }, { passive: false });

    htmlSlider.addEventListener('touchmove', (e) => {
        if (this.strikerState !== "idle" || lastX === null) return;
        
        const deltaX = e.touches[0].clientX - lastX;
        lastX = e.touches[0].clientX;
        
        const currentValue = parseFloat(htmlSlider.value);
        const newValue = Math.max(0, Math.min(100, currentValue + (deltaX * 0.2)));
        
        htmlSlider.value = newValue;
        const percent = newValue / 100;
        const newX = this.slider.min + (this.slider.max - this.slider.min) * percent;
        this.slider.handle.cx = newX;
        this.striker.x = newX;
        
        e.preventDefault();
    }, { passive: false });

    htmlSlider.addEventListener('touchend', () => {
        lastX = null;
    });

    htmlSlider.addEventListener('mousedown', (e) => {
        if (this.strikerState !== "idle") return;
        lastX = e.clientX;
    });

    window.addEventListener('mousemove', (e) => {
        if (this.strikerState !== "idle" || lastX === null) return;
        
        const deltaX = e.clientX - lastX;
        lastX = e.clientX;
        
        const currentValue = parseFloat(htmlSlider.value);
        const newValue = Math.max(0, Math.min(100, currentValue + (deltaX * 0.2)));
        
        htmlSlider.value = newValue;
        const percent = newValue / 100;
        const newX = this.slider.min + (this.slider.max - this.slider.min) * percent;
        this.slider.handle.cx = newX;
        this.striker.x = newX;
    });

    window.addEventListener('mouseup', () => {
        lastX = null;
    });
  }

  rotateBoard() {
    this.rotation += Math.PI;
    const centerX = this.config.w / 2;
    const centerY = this.config.h / 2;

    this.boardSprite.setPosition(centerX, centerY);
    this.boardSprite.setOrigin(0.5, 0.5);
    this.boardSprite.setRotation(this.rotation);

    this.striker.sprite.setRotation(this.rotation);
    const strikerRelX = this.striker.x - centerX;
    const strikerRelY = this.striker.y - centerY;
    this.striker.x = centerX + (strikerRelX * Math.cos(Math.PI) - strikerRelY * Math.sin(Math.PI));
    this.striker.y = centerY + (strikerRelX * Math.sin(Math.PI) + strikerRelY * Math.cos(Math.PI));

    for (const coin of this.coins) {
      coin.sprite.setRotation(this.rotation);
      const coinRelX = coin.x - centerX;
      const coinRelY = coin.y - centerY;
      coin.x = centerX + (coinRelX * Math.cos(Math.PI) - coinRelY * Math.sin(Math.PI));
      coin.y = centerY + (coinRelX * Math.sin(Math.PI) + coinRelY * Math.cos(Math.PI));
    }

    this.slider.track.y = this.config.h - 20;
    this.slider.track.height = 4;
    this.slider.track.x = this.config.board.left + this.config.strikerRadius + this.config.sliderOffset;
    this.slider.track.width = (this.config.board.right - this.config.strikerRadius - this.config.sliderOffset) - this.slider.track.x;
    this.slider.min = this.slider.track.x;
    this.slider.max = this.slider.track.x + this.slider.track.width;
    this.slider.handle.cx = Phaser.Math.Clamp(this.slider.handle.cx, this.slider.min, this.slider.max);
    this.slider.handle.cy = this.slider.track.y;
  }

  update(time, delta, firstTurn, currentPlayer) {
    const dt = delta / 1000;
    if (currentPlayer) {
      if (this.turnText) {
        this.turnText.textContent = `${currentPlayer.getColor()}'s turn`;
      }
      const whiteScore = document.getElementById('white-score');
      const blackScore = document.getElementById('black-score');
      if (whiteScore) {
        whiteScore.textContent = `white ${this.scene.gameManager.players[0].getScore()}`;
      }
      if (blackScore) {
        blackScore.textContent = `black ${this.scene.gameManager.players[1].getScore()}`;
      }
    }

    if (this.strikerState === "idle") {
      this.striker.x = this.slider.handle.cx;
      this.striker.y = this.config.strikerDefaultY;
    }

    const steps = 6, sub = dt / steps;
    for (let i = 0; i < steps; i++) this.physicsUpdate(sub);

    if (this.strikerState === "moving" && this.checkPocket(this.striker)) {
      this.strikerState = "pocket";
      this.strikerResetTimer = 0;
      this.striker.vx = this.striker.vy = 0;
    }
    if (this.strikerState === "moving" && this.striker.vx === 0 && this.striker.vy === 0) {
      this.strikerResetTimer += dt;
      if (this.strikerResetTimer >= 1) {
        this.strikerState = "idle";
        this.striker.x = this.config.strikerDefaultX;
        this.striker.y = this.config.strikerDefaultY;
        this.slider.handle.cx = this.config.strikerDefaultX;
        this.slider.handle.cy = this.slider.track.y;
        this.strikerResetTimer = 0;
      }
    }
    if (this.strikerState === "pocket") {
      this.strikerResetTimer += dt;
      if (this.strikerResetTimer >= 1) {
        this.strikerState = "idle";
        this.striker.x = this.config.strikerDefaultX;
        this.striker.y = this.config.strikerDefaultY;
        this.striker.vx = this.striker.vy = 0;
        this.slider.handle.cx = this.config.strikerDefaultX;
        this.strikerResetTimer = 0;
      }
    }

    for (let i = this.coins.length - 1; i >= 0; i--) {
      const c = this.coins[i];
      if (!c.pocket && !c.processedPocket && this.checkPocket(c)) {
        c.pocket = true;
        c.pocketTimer = 0;
      }
      if (c.pocket && !c.processedPocket) {
        c.pocketTimer += dt;
        if (c.pocketTimer >= 1) {
          this.pocketedCoins.push({ color: c.color });
          this.renderPocketedCoin(c);
        }
      }
    }

    this.striker.sprite.setPosition(this.striker.x, this.striker.y);
    for (const c of this.coins) {
      c.sprite.setPosition(c.x, c.y);
    }

    this.gfx.clear();
    this.gfx.setDepth(100);

    // this.gfx.fillStyle(0xffffff);
    // for (const pocket of this.pockets) {
    //     this.gfx.fillCircle(pocket.x, pocket.y, pocket.r);
    // }

    if (this.slingshot.active) {
      let dx = this.slingshot.endX - this.striker.x,
          dy = this.slingshot.endY - this.striker.y,
          d = Math.hypot(dx, dy);

      let capX = this.slingshot.endX;
      let capY = this.slingshot.endY;

      if (d > this.slingshot.maxLength) {
        const sc = this.slingshot.maxLength / d;
        capX = this.striker.x + dx * sc;
        capY = this.striker.y + dy * sc;
      }

      this.gfx.lineStyle(2, 0xecd8ba);
      this.gfx.beginPath();
      this.gfx.moveTo(this.striker.x, this.striker.y);
      this.gfx.lineTo(capX, capY);
      this.gfx.strokePath();
    }
    if (this.debug) {
      this.gfx.lineStyle(1, 0xecd8ba);
      this.gfx.strokeCircle(this.striker.x, this.striker.y, this.striker.radius);
      for (const c of this.coins) {
        this.gfx.strokeCircle(c.x, c.y, c.radius);
      }
    }

    const htmlSlider = document.getElementById('striker-slider');
    const percent = (this.slider.handle.cx - this.slider.min) / (this.slider.max - this.slider.min);
    htmlSlider.value = percent * 100;
  }

  getStrikerState() {
    return this.strikerState;
  }

  setStrikerState(state) {
    this.strikerState = state;
  }

  getStriker() {
    return this.striker;
  }

  getSlider() {
    return this.slider;
  }

  getRotationSlider() {
    return this.rotationSlider;
  }

  getSlingshot() {
    return this.slingshot;
  }

  getScore() {
    return this.score;
  }

  resetScore() {
    this.score = 0;
  }

  getPocketedCoins() {
    return this.pocketedCoins;
  }

  clearPocketedCoins() {
    this.pocketedCoins = [];
  }
}