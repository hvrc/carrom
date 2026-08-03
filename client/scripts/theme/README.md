# Themes

Every colour in the client comes from here. Nothing else may hard-code one: the
canvas reads `theme` at draw time, and the DOM reads the CSS custom properties
this package writes onto `:root`.

## How a theme is assembled

Three layers, each patching the one before:

| | | |
|---|---|---|
| 1 | `base.js` | every key the engine reads, as a plain board |
| 2 | each skin's `defaults` | shipped next to the skin's own code |
| 3 | `themes/<name>.js` | what this theme actually changes |

So a theme file states only its differences. `themes/plain.js` is fifteen lines
and a complete theme.

## Adding a theme

1. Write `themes/mine.js` exporting a patch over `base.js`.
2. Add it to `themes/index.js`.

That is the whole job. Anything you leave out comes from the base, and any skin
settings you leave out come from the skin.

```js
// themes/midnight.js
export default {
    label: "Midnight",
    page: { background: "#12141c", text: "#e8e8f0" },
    board: { fill: "#1b1e28", border: "#39405a" },
    coins: { white: { fill: "#e8e8f0" }, black: { fill: "#2a2f3e" } },
    skin: { active: "halftone", halftone: { layers: [{ ramp: ["#1b1e28", "#2a3350"] }] } },
};
```

## Rules the engine keeps

- **Patches merge deeply, arrays replace.** A theme saying `layers: [one]` gets
  one layer — merging arrays would make it impossible to shorten a list.
- **The live `theme` object is mutated in place**, never replaced. The canvas
  holds the reference and reads it every frame; swapping the object would leave
  the board drawing an old palette for ever.
- **An unknown theme throws.** A silent fallback would hide a typo behind a
  board that looks almost right.
- **Arrays are not published as CSS variables.** A skin's colour ramp is data
  for the canvas, not a value CSS can use.

## Adding a skin

Skins live in `../skins/`. A skin is one object — `{ name, animated, defaults,
draw }` — registered in `skins/registry.js`. It ships its own settings as
`defaults`, so themes only state what they want to change, and it is handed
those settings at draw time rather than reaching for the theme itself. That is
why `registry.js` imports nothing from here: the dependency runs one way.

`theme.skin.active` picks one; `theme.skin.surface` says whether it is painted
on the playing surface (`"board"`) or across the page behind it (`"canvas"`).
