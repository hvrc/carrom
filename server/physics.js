// Public facade for the carrom simulation. Pure, no DOM/socket/logging.
// Implementation is split into cohesive modules under ./sim/:
//   geometry.js  — board/physical constants + spatial helpers (mirrored on the
//                  client; guarded by the client constants-drift test)
//   collision.js — circle collisions, CCD integration, friction, border
//   state.js     — factories, respawn, and wire snapshots (full + delta)
//   rules.js     — turn resolution: scoring, queen FSM, foul/due, game-over
//   step.js      — the physics step + flick simulation (live + synchronous)
//
// Re-exported here so existing imports (`./physics.js`) and the test suite are
// unaffected by the internal module layout.
export * from "./sim/geometry.js";
export * from "./sim/collision.js";
export * from "./sim/state.js";
export * from "./sim/rules.js";
export * from "./sim/step.js";
