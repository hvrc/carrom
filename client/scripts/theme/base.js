// The base theme: a plain carrom board, and the full shape of a theme.
//
// Every key the engine ever reads is declared here, which makes this file the
// contract. A theme in theme/themes/ is a PATCH over this — it states only what
// it changes, so adding one is a handful of lines rather than a copy of the
// whole palette.
//
// Two conventions run through it:
//
//   * anything drawn carries its own `fill` AND `border`, so a theme can change
//     one without the other
//   * the painted markings (guides) are separate from the physical edges
//     (frame, board, pocket), because on a real board they are different things
//
// Skins are not described here. Each skin ships its own defaults next to its
// code, and the engine merges them in — see theme/index.js.

export const base = {
    label: "Base",

    // The page around the board.
    page: { background: "#ffffff", text: "#000000" },

    // The physical board: the wooden frame, the playing surface, the pockets.
    frame: { fill: "#ffffff", border: "#000000" },
    board: { fill: "#ffffff", border: "#000000" },
    pocket: { fill: "#ffffff", border: "#000000" },

    // The painted markings.
    guides: {
        line: "#999999",            // baselines
        circle: "#999999",          // their end circles
        circleFill: "transparent",
        // The diagonals, their curls, and the centre dot and rack circle. The
        // baselines and moons are drawn either way.
        extras: false,
    },

    // The pieces. Coins are keyed by the wire values the server sends.
    coins: {
        white: { fill: "#ffffff", border: "#000000" },
        black: { fill: "#000000", border: "#000000" },
        queen: { fill: "#ff0000", border: "#ff0000" },
    },
    striker: {
        fill: "#ffffff", border: "#000000",
        // No legal shot from where it stands.
        blockedFill: "transparent", blockedBorder: "#bbbbbb",
    },

    // The aim line: your own, your own when the shot is illegal, the opponent's.
    aim: { own: "#000000", ownBlocked: "#000000", peer: "#000000" },

    // Ruler mode's forecast. The striker has its own colour; the coins it sets
    // moving run from `coin` towards `chainEnd`, a shade lighter for each
    // collision further down the chain.
    ruler: { striker: "#FF7F50", coin: "#FFBF00", chainEnd: "#FFF1C2" },

    // Which skin is painted, and where. Each skin's own settings are merged in
    // beneath this from the skin module itself.
    skin: {
        active: "none",             // "none" | any name in scripts/skins/
        surface: "board",           // "board" (the surface) | "canvas" (the page)
    },

    // Everything outside the canvas.
    ui: {
        text: "#000000",
        muted: "#999999",
        error: "#ff0000",

        turnName: "#000000",        // whoever is on strike
        idleName: "#999999",        // and whoever is not

        panelBackground: "#ffffff",
        panelBorder: "#000000",

        buttonBackground: "#ffffff",
        buttonBorder: "#000000",
        buttonText: "#000000",
        buttonDisabledBorder: "#dddddd",
        buttonDisabledText: "#cccccc",
        inputBorder: "#cccccc",
        placeholderText: "#757575",
        requiredMark: "#000000",

        // The controls that carry their own colour.
        exitText: "#000000",
        exitBorder: "#000000",
        rulerText: "#000000",
        audioText: "#000000",
        helpText: "#000000",
        helpBorder: "#000000",
        joinAccent: "#000000",
        createAccent: "#000000",
        soloAccent: "#000000",

        // PLACE / FLICK.
        modePlaceActive: "#000000",
        modeFlickActive: "#000000",
        modeInactive: "#cccccc",
        modeDisabled: "#e2e2e2",

        // The lobby's seat-status dots.
        seatOpen: "#22c55e",
        seatBusy: "#eab308",
    },
};

export default base;
