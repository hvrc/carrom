// Every skin the game ships with, and the settings each one brings with it.
//
// A skin is one object:
//
//   {
//     name:     "halftone",               // matches its key and its theme block
//     animated: true,                     // does it need a frame every tick?
//     defaults: { … },                    // its own settings, merged under any
//                                         // theme that overrides them
//     draw(ctx, { time, pieces, bounds, settings })
//   }
//
// Deliberately importing NOTHING from the theme: the theme engine imports this
// to collect defaults, so a dependency the other way would be a cycle. Skins are
// handed their settings at draw time instead of reaching for them.

import ornament from "./ornament.js";
import halftone from "./halftone.js";

export const SKINS = { ornament, halftone };

/** Every skin's defaults, keyed by name — the shape a theme patches. */
export const skinDefaults = () =>
    Object.fromEntries(Object.entries(SKINS).map(([name, skin]) => [name, skin.defaults || {}]));

export default SKINS;
