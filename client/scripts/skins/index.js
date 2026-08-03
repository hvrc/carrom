// The skin in force, resolved against the active theme.
//
// This is what the rest of the client talks to; `registry.js` is the list of
// skins and `theme/` decides which one is on. Skins are decoration only: they
// are drawn beneath the pieces, they never read game state, and none of them
// can affect play.

import { theme } from "../theme/index.js";
import { SKINS } from "./registry.js";

/** The active skin, or null for a plain board. */
export function activeSkin() {
    const name = theme.skin?.active;
    if (!name || name === "none") return null;
    return SKINS[name] || null;
}

/** Does the board need a frame every tick even when nothing is moving? */
export const skinIsAnimated = () => !!activeSkin()?.animated;

/**
 * Where the active skin is painted:
 *   "board"   on the playing surface, under the pieces
 *   "canvas"  across the page behind the board, leaving the surface clear
 */
export const skinSurface = () =>
    (theme.skin?.surface === "canvas" ? "canvas" : "board");

/**
 * Paint the active skin.
 * @param {CanvasRenderingContext2D} ctx
 * @param {{time:number, pieces:Array, bounds:?object}} frame
 */
export function drawSkin(ctx, frame) {
    const skin = activeSkin();
    if (!skin) return;
    skin.draw(ctx, { ...frame, settings: theme.skin[skin.name] || {} });
}

export { SKINS };
export default drawSkin;
