// The default look: a white board with grey markings, where only a few things
// carry colour and each one is a signal — the queen, the striker, whoever is on
// strike, and the controls that do something irreversible.
//
// A patch over theme/base.js: everything not named here comes from the base.

export default {
    label: "Default",

    frame: { border: "#5C5C5C" },
    board: { border: "#5C5C5C" },
    guides: { line: "#C6C6C6", circle: "#C6C6C6" },

    coins: {
        white: { fill: "#EADDCA" },
        black: { fill: "#483C32" },
        queen: { fill: "#D70040", border: "#D70040" },
    },
    striker: { fill: "#9FE2BF" },

    skin: {
        active: "halftone",
        surface: "canvas",
        halftone: {
            // Two wave systems, one green and one lavender. Everything else
            // about the halftone comes from the skin's own defaults.
            layers: [
                { ramp: ["#F4FFEC", "#DCF0D6", "#BEDFB4"], phase: 0, offset: 0 },
                { ramp: ["#F2F2FD", "#E3E3FB", "#CFD0F2"], phase: 2.6, offset: 0.5 },
            ],
        },
    },

    ui: {
        turnName: "#00A36C",
        exitText: "#D22B2B",
        exitBorder: "#D22B2B",
        rulerText: "#FFD700",
        audioText: "#7FB3D5",
        helpText: "#FF5F1F",
        helpBorder: "#FF5F1F",
        requiredMark: "#DE3163",
        joinAccent: "#8A9A5B",
        createAccent: "#93C572",
        soloAccent: "#C1E1C1",
        modePlaceActive: "#C3B1E1",
        modeFlickActive: "#FAA0A0",
    },
};
