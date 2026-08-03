// Mirror a theme into CSS custom properties, so stylesheets and inline styles
// read the same values the canvas does.
//
// Naming: nested keys join with dashes and camelCase becomes kebab, so
// `ui.modePlaceActive` is `--c-ui-mode-place-active`. Arrays are skipped —
// they are data for the canvas (a skin's colour ramp), not values CSS can use.

export function cssVarsFor(theme) {
    const out = {};
    const walk = (obj, prefix) => {
        for (const [key, value] of Object.entries(obj)) {
            if (Array.isArray(value)) continue;
            const name = `${prefix}-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
            if (value !== null && typeof value === "object") walk(value, name);
            else if (typeof value === "string") out[name] = value;
        }
    };
    walk(theme, "--c");
    return out;
}

export function writeCssVars(theme, root = defaultRoot()) {
    if (!root) return {};
    const vars = cssVarsFor(theme);
    for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
    root.style.setProperty("color-scheme", "light");
    return vars;
}

const defaultRoot = () =>
    (typeof document !== "undefined" ? document.documentElement : null);
