// Every theme the game ships with.
//
// To add one: write the file next to this, export a patch over theme/base.js,
// and add a line below. Nothing else needs to change — the engine merges it over
// the base and over each skin's own defaults, so a theme can be three lines or
// three hundred.

import defaultTheme from "./default.js";
import plain from "./plain.js";

export const THEMES = {
    default: defaultTheme,
    plain,
};

export const DEFAULT_THEME = "default";
