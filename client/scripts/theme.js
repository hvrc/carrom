// The one place every colour in the game is decided.
//
// Nothing else in the client may hard-code a colour: the canvas reads `theme`
// at draw time, and the DOM reads the CSS custom properties this file writes on
// :root. Add a palette to THEMES, point ACTIVE at it, and the whole app follows.
//
// Every element carries its own fill AND border, and the guide lines are split
// from the guide circles, so a theme can treat the painted markings as two
// different marks the way a real board does.

const THEMES = {
    // The default look: black and white, grey markings. Only three things carry
    // colour, and each one is a signal — the queen, the striker, and whoever is
    // on strike.
    default: {
        label: "Default",
        page: { background: "#ffffff", text: "#000000" },
        frame: { fill: "#ffffff", border: "#000000" },
        board: { fill: "#ffffff", border: "#000000" },
        pocket: { fill: "#ffffff", border: "#000000" },
        guides: {
            line: "#999999",      // baselines: painted markings, not edges
            circle: "#999999",    // their end circles
            circleFill: "transparent",
        },
        coins: {
            white: { fill: "#EADDCA", border: "#000000" },
            black: { fill: "#483C32", border: "#000000" },
            queen: { fill: "#D70040", border: "#D70040" },
        },
        striker: {
            fill: "#9FE2BF", border: "#000000",
            // Greyed out: no legal shot from where it stands. The body empties
            // out to nothing and only a grey outline is left, so it reads as a
            // ghost of the striker rather than a piece in its own right.
            blockedFill: "transparent", blockedBorder: "#bbbbbb",
        },
        aim: { own: "#000000", ownBlocked: "#000000", peer: "#000000" },
        // The stitched decoration. `grid` is the cell every stamp snaps to and
        // `dot` the stamp itself — the gap between them is what reads as thread
        // count. Set primary to "none" for a plain board.
        // Board skins: the art on the playing surface. `active` picks one of
        // the modules registered in scripts/skins/, or "none" for a plain board.
        // Each skin reads its own block below.
        skin: {
            active: "halftone",   // "none" | "halftone" | "ornament"

            // Dots on a grid, sized and faded by a field of travelling waves.
            halftone: {
                // Pale to deep, walked by dot size.
                ramp: ["#ECFFDC", "#C1E1C1", "#93C572"],
                grid: 15,         // pitch between dots
                dot: 12,          // diameter of a dot at full swell
                contrast: 0.95,   // how hard the waves bite (0..1)
                floor: 0.06,      // smallest dot, as a fraction of `dot`
                minAlpha: 0.12,   // faintest a dot goes
                wellRadius: 46,   // how far a piece presses the field down
                wellDepth: 0.95,  // how far down, directly beneath a piece
            },

            // Stitched dot-work: pocket lines, a centre flower, edge runs.
            ornament: {
                primary: "#8AA98B",   // sage, the body of every motif
                accentA: "#D79A78",   // terracotta, the odd contrast stitch
                accentB: "#B0B4E2",   // periwinkle, rarer still
                grid: 6.25,           // lattice pitch; divides 450 exactly, so a
                                      // quarter turn maps the lattice onto itself
                dot: 4.6,             // mark size; its gap to grid is the weave
            },
        },
        ui: {
            turnName: "#00A36C",
            idleName: "#999999", // the player who is not on strike
            text: "#000000",
            muted: "#999999",
            panelBackground: "#ffffff",
            panelBorder: "#000000",
            buttonBackground: "#ffffff",
            buttonBorder: "#000000",
            buttonText: "#000000",
            exitText: "#D22B2B",   // EXIT: the one destructive control on screen
            exitBorder: "#D22B2B",
            helpText: "#F4C430",   // the ? button
            helpBorder: "#F4C430",
            requiredMark: "#DE3163",   // the * on USERNAME: the one required field
            placeholderText: "#757575", // matches the browser's own placeholder grey
            joinAccent: "#8A9A5B",   // JOIN ROOM, once it can be clicked
            createAccent: "#93C572", // CREATE ROOM, once it can be clicked
            soloAccent: "#C1E1C1",   // PLAYGROUND: always available
            buttonDisabledBorder: "#dddddd",
            buttonDisabledText: "#cccccc",
            inputBorder: "#cccccc",
            modePlaceActive: "#C3B1E1",
            modeFlickActive: "#FAA0A0",
            modeInactive: "#cccccc",
            modeDisabled: "#e2e2e2",
            error: "#ff0000",
            seatOpen: "#22c55e",
            seatBusy: "#eab308",
        },
    },
};

// The palette in force. Mutated in place by applyTheme so the canvas — which
// reads it every frame — never holds a stale reference.
const ACTIVE = "default";

// Deep copy. Arrays are handled before the object branch: Object.fromEntries on
// an array would quietly turn it into {0:…,1:…}, which any consumer expecting a
// list then chokes on.
const clone = (v) => {
    if (Array.isArray(v)) return v.map(clone);
    if (v && typeof v === "object") {
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]));
    }
    return v;
};

export const theme = clone(THEMES[ACTIVE]);

// Mirror the palette into CSS custom properties so stylesheets and inline
// styles can use the same values the canvas does.
function writeCssVars(t, root = typeof document !== "undefined" ? document.documentElement : null) {
    if (!root) return;
    const walk = (obj, prefix) => {
        for (const [key, value] of Object.entries(obj)) {
            const name = `${prefix}-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
            if (value && typeof value === "object") walk(value, name);
            else root.style.setProperty(name, value);
        }
    };
    walk(t, "--c");
    root.style.setProperty("color-scheme", "light");
}

export function applyTheme(name = ACTIVE) {
    const next = THEMES[name];
    if (!next) throw new Error(`Unknown theme: ${name}`);
    for (const key of Object.keys(theme)) delete theme[key];
    Object.assign(theme, clone(next));
    writeCssVars(theme);
    return theme;
}

export const themeNames = () => Object.keys(THEMES);

// Coins arrive from the server as "white" | "black" | "red" — wire values, not
// colours. This is the only place that mapping lives.
export const pieceStyle = (wireColor) =>
    theme.coins[wireColor === "red" ? "queen" : wireColor] || theme.coins.white;

export default theme;
