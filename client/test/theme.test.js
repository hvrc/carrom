// The theme engine: a theme is a patch over a base, with each skin's own
// defaults merged in beneath it. These tests pin the merge rules and the
// contract every skin has to keep, because both are what make adding a theme
// cheap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { merge, mergeAll, clone } from "../scripts/theme/merge.js";
import { cssVarsFor } from "../scripts/theme/css.js";
import { base } from "../scripts/theme/base.js";
import { THEMES } from "../scripts/theme/themes/index.js";
import { SKINS, skinDefaults } from "../scripts/skins/registry.js";
import { theme, resolveTheme, applyTheme, themeNames, pieceStyle } from "../scripts/theme/index.js";

// ── merge ──────────────────────────────────────────────────────────────────

test("a patch only has to state what it changes", () => {
    const out = merge({ a: 1, nested: { x: 1, y: 2 } }, { nested: { y: 9 } });
    assert.deepEqual(out, { a: 1, nested: { x: 1, y: 9 } });
});

test("arrays replace rather than merge", () => {
    // Otherwise a theme could never shorten a list — asking for one layer would
    // silently leave the base's second one in place.
    const out = merge({ layers: [1, 2, 3] }, { layers: [9] });
    assert.deepEqual(out.layers, [9]);
});

test("merging never mutates its inputs", () => {
    const a = { nested: { x: 1 } };
    const b = { nested: { x: 2 } };
    const out = merge(a, b);
    out.nested.x = 99;
    assert.equal(a.nested.x, 1);
    assert.equal(b.nested.x, 2);
});

test("clone keeps arrays as arrays", () => {
    // Object.fromEntries on an array turns it into {0:…,1:…}; anything expecting
    // a list then chokes. This bit once already.
    const out = clone({ ramp: ["#fff", "#000"] });
    assert.ok(Array.isArray(out.ramp), "ramp survived as an array");
});

test("mergeAll applies patches left to right", () => {
    const out = mergeAll({ v: 0 }, { v: 1 }, { v: 2 });
    assert.equal(out.v, 2);
});

// ── assembly ───────────────────────────────────────────────────────────────

test("every theme resolves, and inherits everything it does not state", () => {
    for (const name of themeNames()) {
        const t = resolveTheme(name);
        // A key no theme overrides must still be there, from the base.
        assert.ok(t.ui.seatOpen, `${name} inherited ui.seatOpen`);
        assert.ok(t.aim.own, `${name} inherited aim.own`);
        assert.equal(typeof t.guides.extras, "boolean", `${name} inherited guides.extras`);
    }
});

test("a skin's defaults arrive without any theme mentioning them", () => {
    const t = resolveTheme("default");
    // The default theme names only `layers` for the halftone.
    assert.equal(THEMES.default.skin.halftone.grid, undefined, "the theme says nothing about grid");
    assert.equal(t.skin.halftone.grid, SKINS.halftone.defaults.grid, "but the skin's default is there");
    // And a skin the theme never mentions is still fully configured.
    assert.deepEqual(t.skin.ornament, SKINS.ornament.defaults);
});

test("a theme's override beats the skin's default", () => {
    const t = resolveTheme("default");
    assert.deepEqual(t.skin.halftone.layers, THEMES.default.skin.halftone.layers);
    assert.notDeepEqual(t.skin.halftone.layers, SKINS.halftone.defaults.layers);
});

test("an unknown theme is an error, not a silent fallback", () => {
    assert.throws(() => resolveTheme("no-such-theme"), /Unknown theme/);
});

test("switching themes keeps the SAME object", () => {
    // The canvas holds this reference and reads it every frame; swapping the
    // object would leave the board drawing an old palette for ever.
    const before = theme;
    applyTheme("default");
    assert.equal(theme, before, "the live theme is mutated in place");
});

// ── the skin contract ──────────────────────────────────────────────────────

test("every registered skin keeps the contract", () => {
    for (const [key, skin] of Object.entries(SKINS)) {
        assert.equal(skin.name, key, `${key}: name matches its key`);
        assert.equal(typeof skin.draw, "function", `${key}: has a draw`);
        assert.equal(typeof skin.animated, "boolean", `${key}: says whether it animates`);
        assert.ok(skin.defaults && typeof skin.defaults === "object", `${key}: ships defaults`);
    }
});

test("skinDefaults covers every skin", () => {
    assert.deepEqual(Object.keys(skinDefaults()).sort(), Object.keys(SKINS).sort());
});

// ── css variables ──────────────────────────────────────────────────────────

test("css names are kebab-cased and nested by path", () => {
    const vars = cssVarsFor({ ui: { modePlaceActive: "#fff" }, page: { text: "#000" } });
    assert.equal(vars["--c-ui-mode-place-active"], "#fff");
    assert.equal(vars["--c-page-text"], "#000");
});

test("arrays are not published as css variables", () => {
    // A skin's colour ramp is data for the canvas, not a value CSS can use.
    const vars = cssVarsFor({ skin: { halftone: { layers: [{ ramp: ["#fff"] }] } } });
    assert.deepEqual(Object.keys(vars), []);
});

test("the base declares every branch a theme may patch", () => {
    for (const [name, patch] of Object.entries(THEMES)) {
        for (const key of Object.keys(patch)) {
            if (key === "label" || key === "skin") continue;  // skin blocks come from the skins
            assert.ok(key in base, `${name} patches "${key}", which the base declares`);
        }
    }
});

test("pieceStyle maps wire colours to the theme's pieces", () => {
    assert.equal(pieceStyle("red"), theme.coins.queen, "red is the queen");
    assert.equal(pieceStyle("white"), theme.coins.white);
    assert.equal(pieceStyle("black"), theme.coins.black);
    assert.equal(pieceStyle("nonsense"), theme.coins.white, "anything unknown falls back");
});
