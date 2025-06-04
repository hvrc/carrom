import { GameManager } from './manager.js';

const configGame = {
  fps: 60,
  w: 700,
  h: 700,
  title: "Carrom",
  strikerDefaultX: 350,
  strikerDefaultY: 585, // 557
  slingshotMaxLength: 100,
  friction: 0.994,
  restitution: 0.75,
  maxPower: 50,
  strikerRadius: 25,
  board: {
    left: 40,
    right: 660,
    top: 40,
    bottom: 660
  },
  pocketRadius: 22.5,
  coinRadius: 15,
  centerX: 350,
  centerY: 350,
  ring1Count: 6,
  ring2Count: 12,
  ring1Radius: 32,
  ring2Radius: 62,
  sliderOffset: 100,
  rotationSliderOffset: 200,
  sliderHandleRadius: 5,
  rotationSliderWidth: 100,
};

window.onload = () => {
  new Phaser.Game({
    type: Phaser.AUTO,
    width: configGame.w,
    height: configGame.h,
    parent: 'game-container',
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
      width: configGame.w,
      height: configGame.h
    },
    scene: { preload, create, update }
  });
};

function preload() {
  this.load.image('board', 'images/board.png');
  this.load.image('striker', 'images/striker.png');
  this.load.image('black', 'images/black.png');
  this.load.image('white', 'images/white.png');
  this.load.image('queen', 'images/queen.png');
}

function create() {
  this.gameManager = new GameManager(this, configGame);
  this.gameManager.initialize();

  this.input.on('pointerdown', ptr => {
    this.gameManager.handlePointerDown(ptr);
  });

  this.input.on('pointermove', ptr => {
    this.gameManager.handlePointerMove(ptr);
  });

  this.input.on('pointerup', ptr => {
    this.gameManager.handlePointerUp(ptr);
  });

  this.game.canvas.addEventListener('touchstart', function(e) {
    e.preventDefault();
  }, { passive: false });

  this.game.canvas.addEventListener('touchmove', function(e) {
    e.preventDefault();
  }, { passive: false });

  this.game.canvas.addEventListener('touchend', function(e) {
    e.preventDefault();
  }, { passive: false });
}

function update(time, delta) {
  this.gameManager.update(time, delta);
}