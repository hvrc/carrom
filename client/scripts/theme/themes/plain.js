// A bare board: no skin, no colour beyond what the game needs to be legible.
// Useful for screenshots and for playing without anything moving in the corner
// of your eye — and it is what a theme file looks like when it changes almost
// nothing.

export default {
    label: "Plain",
    guides: { line: "#C6C6C6", circle: "#C6C6C6" },
    coins: {
        white: { fill: "#EADDCA" },
        black: { fill: "#483C32" },
        queen: { fill: "#D70040", border: "#D70040" },
    },
    striker: { fill: "#9FE2BF" },
    ui: { turnName: "#00A36C" },
};
