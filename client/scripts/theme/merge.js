// Deep copy and deep merge — the two operations the theme engine is built on.
// Pure, no DOM, unit-tested in client/test/theme.test.js.

/**
 * Deep copy. Arrays are handled BEFORE the object branch: Object.fromEntries on
 * an array quietly turns it into {0:…,1:…}, and any consumer expecting a list
 * then chokes on it.
 */
export function clone(value) {
    if (Array.isArray(value)) return value.map(clone);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)]));
    }
    return value;
}

/**
 * Merge `patch` over `base`, deeply, returning a new object.
 *
 * Arrays REPLACE rather than merge. A theme saying `layers: [one]` means one
 * layer, not "the first of the base's layers, overwritten" — merging them would
 * make it impossible to shorten a list.
 */
export function merge(base, patch) {
    if (patch === undefined) return clone(base);
    if (Array.isArray(patch) || Array.isArray(base)) return clone(patch);
    if (!isPlainObject(base) || !isPlainObject(patch)) return clone(patch);

    const out = clone(base);
    for (const [key, value] of Object.entries(patch)) {
        out[key] = key in out ? merge(out[key], value) : clone(value);
    }
    return out;
}

/** Merge a list of patches left to right, over `base`. */
export const mergeAll = (base, ...patches) =>
    patches.reduce((acc, patch) => merge(acc, patch), clone(base));

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
