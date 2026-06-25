// Pure physics + game-rules simulation for carrom.
// No DOM/canvas dependencies. Mirrors client constants in:
//   client/scripts/Draw.js   (board geometry)
//   client/scripts/Coin.js   (coin physics)
//   client/scripts/Striker.js (striker physics)
//   client/scripts/Hand.js   (FLICK_POWER)
//   client/scripts/Pocket.js (pocket geometry)
//
// Coordinate system is canvas-space: origin at (0,0) of a 900x900 frame.
// Board is centered, so boardX = boardY = (FRAME_SIZE - BOARD_SIZE) / 2 = 75.

const FRAME_SIZE = 900;
const BOARD_SIZE = 750;
const BOARD_X = (FRAME_SIZE - BOARD_SIZE) / 2; // 75
const BOARD_Y = (FRAME_SIZE - BOARD_SIZE) / 2; // 75

const BASE_DISTANCE = 102;
const BASE_HEIGHT = 32;
const BASE_WIDTH = 470;

const POCKET_DIAMETER = 45;
const POCKET_RADIUS = POCKET_DIAMETER / 2;
const POCKET_NEAR_THRESHOLD = 60;

const COIN_RADIUS = 15;
const COIN_MASS = 0.5;
const COIN_RESTITUTION = 0.6;
const COIN_FRICTION = 0.97;

const STRIKER_RADIUS = 21;
const STRIKER_MASS = 1;
const STRIKER_RESTITUTION = 0.6;
const STRIKER_FRICTION = 0.97;

const MOVEMENT_THRESHOLD = 0.21;
const FLICK_POWER = 0.4; // matches Hand.FLICK_POWER
const MAX_VELOCITY_FROM_FLICK = FLICK_POWER * 100; // = 40 px/tick at force=1

// CCD config (matches client Physics.js)
const CCD_SPEED_THRESHOLD = 2;
const CCD_MAX_SUB_STEPS = 4;
const CCD_SPEED_DIVISOR = 5;
const CCD_MIN_REMAINING_TIME = 0.01;

// Game rule tuning
const MAX_TURNS_IN_A_ROW = 3; // safety cap to prevent infinite continued turns

// Pocket center coordinates
const POCKETS = [
    { x: BOARD_X + POCKET_RADIUS, y: BOARD_Y + POCKET_RADIUS },
    { x: BOARD_X + BOARD_SIZE - POCKET_RADIUS, y: BOARD_Y + POCKET_RADIUS },
    { x: BOARD_X + POCKET_RADIUS, y: BOARD_Y + BOARD_SIZE - POCKET_RADIUS },
    { x: BOARD_X + BOARD_SIZE - POCKET_RADIUS, y: BOARD_Y + BOARD_SIZE - POCKET_RADIUS },
];

const CENTER_X = BOARD_X + BOARD_SIZE / 2; // 450
const CENTER_Y = BOARD_Y + BOARD_SIZE / 2; // 450

const TOP_BASELINE_Y = BOARD_Y + BASE_DISTANCE + BASE_HEIGHT / 2;
const BOTTOM_BASELINE_Y = BOARD_Y + BOARD_SIZE - BASE_DISTANCE - BASE_HEIGHT / 2;

const SLIDER_MIN_X = BOARD_X + (BOARD_SIZE - BASE_WIDTH) / 2 + STRIKER_RADIUS;
const SLIDER_MAX_X = BOARD_X + (BOARD_SIZE - BASE_WIDTH) / 2 + BASE_WIDTH - STRIKER_RADIUS;

// ---------- Coin / Striker factories ----------

function makeCoin(id, color, x, y) {
    return {
        id,
        color, // "white" | "black" | "red"
        x,
        y,
        velocity: { x: 0, y: 0 },
        radius: COIN_RADIUS,
        coinMass: COIN_MASS,
        restitution: COIN_RESTITUTION,
        friction: COIN_FRICTION,
        pocketed: false,
    };
}

function makeStriker(x, y) {
    return {
        x,
        y,
        velocity: { x: 0, y: 0 },
        radius: STRIKER_RADIUS,
        strikerMass: STRIKER_MASS,
        restitution: STRIKER_RESTITUTION,
        friction: STRIKER_FRICTION,
        pocketed: false,
    };
}

function createCoinFormation() {
    const coins = [];
    let id = 1;
    let colorIndex = 1;
    const rings = [
        { count: 6, radius: 32 },
        { count: 12, radius: 62 },
    ];
    for (const ring of rings) {
        for (let i = 0; i < ring.count; i++) {
            const angle = i * ((2 * Math.PI) / ring.count);
            const x = CENTER_X + ring.radius * Math.cos(angle);
            const y = CENTER_Y + ring.radius * Math.sin(angle);
            const color = colorIndex % 2 ? "white" : "black";
            coins.push(makeCoin(id++, color, x, y));
            colorIndex++;
        }
    }
    coins.push(makeCoin(id++, "red", CENTER_X, CENTER_Y));
    return coins;
}

function baselineYFor(role) {
    // creator plays bottom by convention; joiner plays top.
    return role === "creator" ? BOTTOM_BASELINE_Y : TOP_BASELINE_Y;
}

function clampStrikerX(x) {
    return Math.max(SLIDER_MIN_X, Math.min(SLIDER_MAX_X, x));
}

// ---------- Collision math (mirrors client Physics.js) ----------

function resolveCircleCollision(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) return;
    const overlap = a.radius + b.radius - dist;
    if (overlap <= 0) return;

    const nx = dx / dist;
    const ny = dy / dist;
    const aMass = a.strikerMass || a.coinMass;
    const bMass = b.strikerMass || b.coinMass;
    const totalMass = aMass + bMass;

    a.x -= nx * (overlap * (bMass / totalMass));
    a.y -= ny * (overlap * (bMass / totalMass));
    b.x += nx * (overlap * (aMass / totalMass));
    b.y += ny * (overlap * (aMass / totalMass));

    const dvx = b.velocity.x - a.velocity.x;
    const dvy = b.velocity.y - a.velocity.y;
    const vn = dvx * nx + dvy * ny;
    if (vn >= 0) return;

    const restitution = Math.min(a.restitution, b.restitution);
    const impulse = (-(1 + restitution) * vn) / (1 / aMass + 1 / bMass);
    const ix = impulse * nx;
    const iy = impulse * ny;
    a.velocity.x -= ix / aMass;
    a.velocity.y -= iy / aMass;
    b.velocity.x += ix / bMass;
    b.velocity.y += iy / bMass;
}

function areCirclesColliding(a, b) {
    return Math.hypot(b.x - a.x, b.y - a.y) < a.radius + b.radius;
}

function handleBorderCollision(obj) {
    const minX = BOARD_X + obj.radius;
    const maxX = BOARD_X + BOARD_SIZE - obj.radius;
    const minY = BOARD_Y + obj.radius;
    const maxY = BOARD_Y + BOARD_SIZE - obj.radius;
    let collided = false;
    if (obj.x < minX) { obj.x = minX; obj.velocity.x = Math.abs(obj.velocity.x) * obj.restitution; collided = true; }
    else if (obj.x > maxX) { obj.x = maxX; obj.velocity.x = -Math.abs(obj.velocity.x) * obj.restitution; collided = true; }
    if (obj.y < minY) { obj.y = minY; obj.velocity.y = Math.abs(obj.velocity.y) * obj.restitution; collided = true; }
    else if (obj.y > maxY) { obj.y = maxY; obj.velocity.y = -Math.abs(obj.velocity.y) * obj.restitution; collided = true; }
    return collided;
}

function continuousCircleCollision(a, b) {
    const relPosX = a.x - b.x;
    const relPosY = a.y - b.y;
    const relVelX = a.velocity.x - b.velocity.x;
    const relVelY = a.velocity.y - b.velocity.y;
    const collisionDist = a.radius + b.radius;
    const A = relVelX * relVelX + relVelY * relVelY;
    const B = 2 * (relPosX * relVelX + relPosY * relVelY);
    const C = relPosX * relPosX + relPosY * relPosY - collisionDist * collisionDist;
    if (Math.abs(A) < 1e-10) return null;
    const disc = B * B - 4 * A * C;
    if (disc < 0) return null;
    const sq = Math.sqrt(disc);
    const t = Math.min((-B - sq) / (2 * A), (-B + sq) / (2 * A));
    return t >= 0 && t <= 1 ? t : null;
}

function updateWithCCD(obj, others) {
    const vx = obj.velocity.x;
    const vy = obj.velocity.y;
    const speed = Math.hypot(vx, vy);

    if (speed < CCD_SPEED_THRESHOLD) {
        obj.x += vx;
        obj.y += vy;
        handleBorderCollision(obj);
        return;
    }

    const subSteps = Math.min(Math.ceil(speed / CCD_SPEED_DIVISOR), CCD_MAX_SUB_STEPS);
    const stepSize = 1.0 / subSteps;

    for (let s = 0; s < subSteps; s++) {
        const sx = vx * stepSize;
        const sy = vy * stepSize;
        const startX = obj.x;
        const startY = obj.y;

        let earliest = 1.0;
        let hit = null;
        for (const other of others) {
            if (other === obj) continue;
            const saveVx = obj.velocity.x;
            const saveVy = obj.velocity.y;
            obj.velocity.x = sx;
            obj.velocity.y = sy;
            const t = continuousCircleCollision(obj, other);
            obj.velocity.x = saveVx;
            obj.velocity.y = saveVy;
            if (t !== null && t < earliest) {
                earliest = t;
                hit = other;
            }
        }

        obj.x = startX + sx * earliest;
        obj.y = startY + sy * earliest;
        const borderCollided = handleBorderCollision(obj);

        if (hit && earliest < 1.0) {
            resolveCircleCollision(obj, hit);
            const remaining = 1.0 - earliest;
            if (remaining > CCD_MIN_REMAINING_TIME) {
                obj.x += obj.velocity.x * stepSize * remaining;
                obj.y += obj.velocity.y * stepSize * remaining;
            }
        } else if (!borderCollided) {
            obj.x = startX + sx;
            obj.y = startY + sy;
        }
    }
}

function isMoving(obj) {
    if (obj.pocketed) return false;
    return Math.abs(obj.velocity.x) > MOVEMENT_THRESHOLD ||
           Math.abs(obj.velocity.y) > MOVEMENT_THRESHOLD;
}

function applyFrictionAndStop(obj) {
    obj.velocity.x *= obj.friction;
    obj.velocity.y *= obj.friction;
    if (Math.abs(obj.velocity.x) <= MOVEMENT_THRESHOLD &&
        Math.abs(obj.velocity.y) <= MOVEMENT_THRESHOLD) {
        obj.velocity.x = 0;
        obj.velocity.y = 0;
    }
}

function isInsidePocket(obj) {
    for (const p of POCKETS) {
        const d = Math.hypot(obj.x - p.x, obj.y - p.y);
        if (d < POCKET_RADIUS - obj.radius / 2) return p;
    }
    return null;
}

// ---------- Single physics step ----------

function step(state) {
    const { striker, coins } = state;
    const live = coins.filter(c => !c.pocketed);
    const all = striker.pocketed ? live : [striker, ...live];

    if (!striker.pocketed) updateWithCCD(striker, live);
    for (const coin of live) {
        const others = all.filter(o => o !== coin);
        updateWithCCD(coin, others);
    }

    // friction + threshold stop
    if (!striker.pocketed) applyFrictionAndStop(striker);
    for (const coin of live) applyFrictionAndStop(coin);

    // overlap cleanup
    for (const coin of live) {
        if (!striker.pocketed && areCirclesColliding(striker, coin)) {
            resolveCircleCollision(striker, coin);
        }
    }
    for (let i = 0; i < live.length; i++) {
        for (let j = i + 1; j < live.length; j++) {
            if (areCirclesColliding(live[i], live[j])) {
                resolveCircleCollision(live[i], live[j]);
            }
        }
    }

    // pocket detection
    const newlyPocketed = [];
    if (!striker.pocketed) {
        const p = isInsidePocket(striker);
        if (p) {
            striker.pocketed = true;
            striker.velocity.x = 0;
            striker.velocity.y = 0;
            // Snapshot striker position at the moment of capture so the
            // client can tween from there into the pocket.
            newlyPocketed.push({
                kind: "striker",
                pocket: p,
                from: { x: striker.x, y: striker.y },
            });
        }
    }
    for (const coin of live) {
        const p = isInsidePocket(coin);
        if (p) {
            coin.pocketed = true;
            coin.velocity.x = 0;
            coin.velocity.y = 0;
            newlyPocketed.push({ kind: "coin", id: coin.id, color: coin.color, pocket: p });
        }
    }

    return newlyPocketed;
}

function anythingMoving(state) {
    if (!state.striker.pocketed && isMoving(state.striker)) return true;
    for (const c of state.coins) if (!c.pocketed && isMoving(c)) return true;
    return false;
}

// ---------- Game state factory ----------

function createInitialState() {
    return {
        coins: createCoinFormation(),
        striker: makeStriker(CENTER_X, BOTTOM_BASELINE_Y),
        whoseTurn: "creator",
        scores: { creator: 0, joiner: 0 },
        debts: { creator: 0, joiner: 0 },
        // pocketed pile = list of {id, color} per player. used to refund a coin on striker-foul.
        pocketedPiles: { creator: [], joiner: [] },
        // queen state machine: "on_board" | "pocketed_uncovered" | "covered"
        queenState: "on_board",
        queenPocketedBy: null, // role who pocketed queen, awaiting cover
        continuedTurnCount: 0,
        gameOver: false,
        winner: null,
    };
}

function colorForRole(role) {
    return role === "creator" ? "white" : "black";
}

function otherRole(role) {
    return role === "creator" ? "joiner" : "creator";
}

// Respawn a single coin at center (or as close as possible to the center
// without overlapping live coins). Used after striker pocket / queen reset.
function respawnAtCenter(state, color, preferredId = null) {
    const live = state.coins.filter(c => !c.pocketed);
    let cx = CENTER_X;
    let cy = CENTER_Y;
    // try center; if blocked, jiggle outward in a spiral
    for (let r = 0; r < 200; r += COIN_RADIUS) {
        const tries = r === 0 ? 1 : 8;
        for (let i = 0; i < tries; i++) {
            const a = (i / tries) * Math.PI * 2;
            const tx = CENTER_X + r * Math.cos(a);
            const ty = CENTER_Y + r * Math.sin(a);
            const blocked = live.some(c => Math.hypot(c.x - tx, c.y - ty) < COIN_RADIUS * 2 + 1);
            if (!blocked) { cx = tx; cy = ty; r = 9999; break; }
        }
    }

    // Reuse a coin object: prefer the requested id (e.g. queen=19) if it exists
    // and is currently pocketed; otherwise mint a new id.
    let coin = preferredId != null ? state.coins.find(c => c.id === preferredId && c.pocketed) : null;
    if (coin) {
        coin.pocketed = false;
        coin.color = color;
        coin.x = cx;
        coin.y = cy;
        coin.velocity = { x: 0, y: 0 };
    } else {
        const newId = Math.max(0, ...state.coins.map(c => c.id)) + 1;
        coin = makeCoin(newId, color, cx, cy);
        state.coins.push(coin);
    }
    return coin;
}

// ---------- Turn resolution ----------
// Called once per flick after physics has fully settled.
// Mutates state. Returns { strikerPocketed, pocketedThisTurn, continuedTurn,
// gameOver, winner }.

function resolveTurn(state, pocketedThisTurn, actor) {
    const myColor = colorForRole(actor);
    const oppColor = colorForRole(otherRole(actor));

    let strikerFoul = state.striker.pocketed;
    let continuedTurn = false;
    let gameOver = false;
    let winner = null;

    // Score coins. Coin goes to the player whose color it is, regardless of who
    // pocketed it. If you pocket the opponent's coin, they score.
    for (const p of pocketedThisTurn) {
        if (p.color === "white") {
            state.scores.creator += 1;
            state.pocketedPiles.creator.push({ id: p.id, color: "white" });
        } else if (p.color === "black") {
            state.scores.joiner += 1;
            state.pocketedPiles.joiner.push({ id: p.id, color: "black" });
        }
        // queen handled below
    }

    // --- Queen state machine ---
    const queenPocketedThisTurn = pocketedThisTurn.find(p => p.color === "red");
    const ownColorPocketedThisTurn = pocketedThisTurn.some(p => p.color === myColor);

    if (queenPocketedThisTurn) {
        // Queen was pocketed this turn.
        if (state.queenState === "on_board") {
            state.queenState = "pocketed_uncovered";
            state.queenPocketedBy = actor;
        }
        // (Already-pocketed queen can't be pocketed again.)
    }

    if (state.queenState === "pocketed_uncovered" && state.queenPocketedBy === actor) {
        // Cover-turn rule:
        // If you pocketed the queen AND another own-color coin in the same flick,
        // queen is immediately covered. Otherwise you have a follow-up cover turn.
        if (queenPocketedThisTurn && ownColorPocketedThisTurn) {
            state.queenState = "covered";
            state.scores[actor] += 5; // queen bonus
            state.queenPocketedBy = null;
        } else if (!queenPocketedThisTurn) {
            // This is a cover-turn attempt (pocketed queen on a previous flick).
            if (ownColorPocketedThisTurn && !strikerFoul) {
                state.queenState = "covered";
                state.scores[actor] += 5;
                state.queenPocketedBy = null;
            } else {
                // Failed to cover -> queen goes back on board.
                state.queenState = "on_board";
                state.queenPocketedBy = null;
                respawnAtCenter(state, "red", 19);
            }
        }
    }

    // --- Striker foul ---
    if (strikerFoul) {
        const pile = state.pocketedPiles[actor];
        if (pile.length > 0) {
            // refund one coin from your pile back to center
            const refund = pile.pop();
            // remove score that was awarded for it (if it was your color)
            if (refund.color === colorForRole(actor)) {
                state.scores[actor] = Math.max(0, state.scores[actor] - 1);
            }
            respawnAtCenter(state, refund.color, refund.id);
        } else {
            state.debts[actor] += 1;
        }
    }

    // --- Settle outstanding debt against current score (both players) ---
    // Any score gained this turn (including for the opponent when the actor
    // pockets the opponent's color) is applied against that player's debt
    // before being credited to their displayed score.
    for (const role of ["creator", "joiner"]) {
        if (state.debts[role] > 0 && state.scores[role] > 0) {
            const settle = Math.min(state.scores[role], state.debts[role]);
            state.scores[role] -= settle;
            state.debts[role] -= settle;
        }
    }

    // --- Continue turn vs switch ---
    // You continue if you pocketed your own coin AND no foul.
    // Cover turn after pocketing queen also forces continue (one extra turn).
    const queenPendingCover = state.queenState === "pocketed_uncovered" &&
                              state.queenPocketedBy === actor;

    if (!strikerFoul &&
        (ownColorPocketedThisTurn || queenPendingCover) &&
        state.continuedTurnCount < MAX_TURNS_IN_A_ROW) {
        continuedTurn = true;
        state.continuedTurnCount += 1;
    } else {
        continuedTurn = false;
        state.continuedTurnCount = 0;
        state.whoseTurn = otherRole(actor);
    }

    // --- Reset striker for next flick ---
    state.striker.pocketed = false;
    state.striker.velocity = { x: 0, y: 0 };
    state.striker.x = CENTER_X;
    state.striker.y = baselineYFor(state.whoseTurn);

    // --- Game-over check ---
    // If all coins of the player-up's color are gone (and queen is settled),
    // game ends. Winner is highest score.
    const liveCoins = state.coins.filter(c => !c.pocketed);
    const liveOwnColor = liveCoins.filter(c => c.color === colorForRole(state.whoseTurn));
    const queenSettled = state.queenState !== "pocketed_uncovered";
    if (liveOwnColor.length === 0 && queenSettled) {
        gameOver = true;
        if (state.scores.creator > state.scores.joiner) winner = "creator";
        else if (state.scores.joiner > state.scores.creator) winner = "joiner";
        else winner = null; // tie
        state.gameOver = true;
        state.winner = winner;
    }

    return { strikerPocketed: strikerFoul, continuedTurn, gameOver, winner };
}

// ---------- Snapshots for the wire ----------

function frameSnapshot(state) {
    return {
        coins: state.coins
            .filter(c => !c.pocketed)
            .map(c => ({ id: c.id, x: c.x, y: c.y })),
        striker: state.striker.pocketed
            ? null
            : { x: state.striker.x, y: state.striker.y },
    };
}

function fullStateSnapshot(state) {
    return {
        coins: state.coins.map(c => ({
            id: c.id, color: c.color, x: c.x, y: c.y, pocketed: c.pocketed,
        })),
        striker: { x: state.striker.x, y: state.striker.y },
        whoseTurn: state.whoseTurn,
        scores: { ...state.scores },
        debts: { ...state.debts },
        pocketedPiles: {
            creator: [...state.pocketedPiles.creator],
            joiner: [...state.pocketedPiles.joiner],
        },
        queenState: state.queenState,
        queenPocketedBy: state.queenPocketedBy,
        continuedTurnCount: state.continuedTurnCount,
        gameOver: state.gameOver,
        winner: state.winner,
    };
}

// ---------- Flick simulation ----------
// Runs the physics loop with periodic frame callbacks.
// `flickInput` = { strikerX, angle, force } where:
//   strikerX in [SLIDER_MIN_X, SLIDER_MAX_X] (clamped here)
//   angle    in radians, standard math convention (atan2(vy, vx))
//   force    in [0, 1]
// `actor` = "creator" | "joiner" — whose turn it currently is.
//
// `onFrame(snapshot, pocketsThisTick)` is called every TICK_BROADCAST_EVERY ticks.
// `onDone(resolution, fullState)` is called after physics settles + rules resolved.

const TICK_MS = 16;             // 60Hz simulation
const TICK_BROADCAST_EVERY = 2; // → 30Hz frame stream
const MAX_TICKS = 60 * 15;      // hard safety cap (~15s)

// Place the striker per client input and apply launch velocity from angle/force.
// Shared by the live (timer) and synchronous (test/prediction) runners so the
// two can never diverge.
function launchStriker(state, flickInput, actor) {
    state.striker.pocketed = false;
    state.striker.x = clampStrikerX(flickInput.strikerX);
    state.striker.y = baselineYFor(actor);
    const force = Math.max(0, Math.min(1, flickInput.force || 0));
    const speed = MAX_VELOCITY_FROM_FLICK * force;
    state.striker.velocity = {
        x: Math.cos(flickInput.angle) * speed,
        y: Math.sin(flickInput.angle) * speed,
    };
}

function startFlickSimulation(state, flickInput, actor, { onFrame, onPocket, onDone }) {
    launchStriker(state, flickInput, actor);

    const pocketedThisTurn = [];
    let tick = 0;

    const interval = setInterval(() => {
        const newlyPocketed = step(state);
        for (const p of newlyPocketed) {
            pocketedThisTurn.push(p);
            onPocket && onPocket(p);
        }
        tick += 1;

        if (tick % TICK_BROADCAST_EVERY === 0) {
            onFrame && onFrame(frameSnapshot(state));
        }

        const stillMoving = anythingMoving(state);
        if (!stillMoving || tick >= MAX_TICKS) {
            clearInterval(interval);
            // Final frame
            onFrame && onFrame(frameSnapshot(state));
            const resolution = resolveTurn(state, pocketedThisTurn, actor);
            onDone && onDone({
                ...resolution,
                pocketedThisTurn,
            }, fullStateSnapshot(state));
        }
    }, TICK_MS);

    return () => clearInterval(interval);
}

// Synchronous twin of startFlickSimulation: runs the identical step loop to
// completion with no timers. Used by the test suite and as a determinism oracle
// (same input + same start state ⇒ identical result, run to run). Returns the
// collected frames, pockets, rule resolution, and final snapshot.
function simulateFlickSync(state, flickInput, actor) {
    launchStriker(state, flickInput, actor);
    const pocketedThisTurn = [];
    const frames = [];
    let tick = 0;
    while (true) {
        const newlyPocketed = step(state);
        for (const p of newlyPocketed) pocketedThisTurn.push(p);
        tick += 1;
        if (tick % TICK_BROADCAST_EVERY === 0) frames.push(frameSnapshot(state));
        if (!anythingMoving(state) || tick >= MAX_TICKS) {
            frames.push(frameSnapshot(state));
            const resolution = resolveTurn(state, pocketedThisTurn, actor);
            return {
                frames,
                pocketedThisTurn,
                resolution: { ...resolution, pocketedThisTurn },
                fullState: fullStateSnapshot(state),
                ticks: tick,
            };
        }
    }
}

export {
    // constants (export selectively for tests/debug)
    BOARD_X, BOARD_Y, BOARD_SIZE, FRAME_SIZE,
    CENTER_X, CENTER_Y,
    TOP_BASELINE_Y, BOTTOM_BASELINE_Y,
    SLIDER_MIN_X, SLIDER_MAX_X,
    POCKETS, POCKET_RADIUS,
    // state
    createInitialState,
    createCoinFormation,
    fullStateSnapshot,
    frameSnapshot,
    // simulation
    startFlickSimulation,
    simulateFlickSync,
    step,
    resolveTurn,
    respawnAtCenter,
    isInsidePocket,
    // helpers
    clampStrikerX,
    baselineYFor,
};
