// The theme engine.
//
// A theme is assembled from three layers, each patching the one before:
//
//   1. theme/base.js         every key the engine reads, as a plain board
//   2. each skin's defaults  shipped next to the skin's own code
//   3. theme/themes/<name>   what this theme actually changes
//
// So a theme file states only its differences, and a skin's settings live with
// the skin rather than being copied into every theme.
//
// `theme` is a live object, mutated in place when the theme changes. The canvas
// reads it every frame and holds the reference, so replacing the object would
// leave the board drawing an old palette.

import { base } from "./base.js";
import { mergeAll } from "./merge.js";
import { writeCssVars } from "./css.js";
import { THEMES, DEFAULT_THEME } from "./themes/index.js";
import { skinDefaults } from "../skins/registry.js";

/** Build the full theme for a name, without touching the live one. */
export function resolveTheme(name = DEFAULT_THEME) {
    const patch = THEMES[name];
    if (!patch) throw new Error(`Unknown theme: ${name}`);
    return mergeAll(base, { skin: skinDefaults() }, patch);
}

export const theme = resolveTheme(DEFAULT_THEME);

let current = DEFAULT_THEME;

/** Switch themes: rebuild in place, then republish the CSS variables. */
export function applyTheme(name = DEFAULT_THEME) {
    const next = resolveTheme(name);
    for (const key of Object.keys(theme)) delete theme[key];
    Object.assign(theme, next);
    current = name;
    writeCssVars(theme);
    return theme;
}

export const themeNames = () => Object.keys(THEMES);
export const currentTheme = () => current;

/**
 * Coins arrive from the server as "white" | "black" | "red" — wire values, not
 * colours. This is the only place that mapping lives.
 */
export const pieceStyle = (wireColor) =>
    theme.coins[wireColor === "red" ? "queen" : wireColor] || theme.coins.white;

export default theme;
