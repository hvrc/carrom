export class Player {
  constructor(id, name, color) {
    this.id = id;
    this.name = name;
    this.score = 0;
    this.color = color;
    this.pocketedCoins = [];
    this.pendingQueen = false;
  }

  addScore(points) {
    this.score += points;
  }

  getScore() {
    return this.score;
  }

  getName() {
    return this.name;
  }

  getColor() {
    return this.color;
  }

  resetScore() {
    this.score = 0;
    this.pocketedCoins = [];
    this.pendingQueen = false;
  }

  addPocketedCoin(color) {
    this.pocketedCoins.push(color);
  }

  removePocketedCoin() {
    const queenIndex = this.pocketedCoins.indexOf('queen');
    if (queenIndex !== -1) {
      this.pocketedCoins.splice(queenIndex, 1);
      return 'queen';
    }
    const colorIndex = this.pocketedCoins.indexOf(this.color);
    if (colorIndex !== -1) {
      this.pocketedCoins.splice(colorIndex, 1);
      return this.color;
    }
    return null;
  }

  setPendingQueen(pending) {
    this.pendingQueen = pending;
  }

  hasPendingQueen() {
    return this.pendingQueen;
  }
}