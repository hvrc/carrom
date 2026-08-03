// Board skins: the art drawn on the playing surface, beneath the pieces.
//
// A skin is one object:
//
//   {
//     name:     "halftone",              // matches its key and its theme block
//     animated: true,                    // does it need a frame every tick?
//     draw(ctx, { time, pieces })        // paint into board space (900x900)
//   }
//
// `time` is milliseconds and `pieces` is every live coin plus the striker as
// { id, x, y } — enough for a skin to react to play without reading game state.
//
// To add one: write the module, export that shape, and register it below. Its
// settings live under `theme.skin.<name>`, and `theme.skin.active` picks it.
// Nothing else in the client needs to change — Draw calls whatever is active,
// and Board keeps the render loop running if it says it is animated.
//
// Skins are decoration only. They are drawn under the baselines and the pieces,
// they never read game state, and none of them can affect play.

import { theme } from "../theme.js";
import ornament from "./ornament.js";
import halftone from "./halftone.js";

export const SKINS = { ornament, halftone };

// The skin in force, or null for a plain board.
export function activeSkin() {
    const name = theme.skin?.active;
    if (!name || name === "none") return null;
    return SKINS[name] || null;
}

// Does the board need a frame every tick even when nothing is moving?
export const skinIsAnimated = () => !!activeSkin()?.animated;

// Paint the active skin, if there is one.
export function drawSkin(ctx, frame) {
    const skin = activeSkin();
    if (!skin) return;
    skin.draw(ctx, frame);
}

export default drawSkin;
