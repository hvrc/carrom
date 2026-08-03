// The clock's unit grows with the number rather than padding it out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatElapsed } from "../scripts/elapsed.js";

const S = 1000, M = 60 * S, H = 60 * M, D = 24 * H;

test("seconds alone, until the first minute", () => {
    assert.equal(formatElapsed(0), "0");
    assert.equal(formatElapsed(7 * S), "7");
    assert.equal(formatElapsed(59 * S), "59");
});

test("minutes from a minute, seconds padded", () => {
    assert.equal(formatElapsed(60 * S), "1:00");
    assert.equal(formatElapsed(61 * S), "1:01");
    assert.equal(formatElapsed(59 * M + 58 * S), "59:58");
    assert.equal(formatElapsed(59 * M + 59 * S), "59:59");
});

test("hours from an hour, up to the day", () => {
    assert.equal(formatElapsed(H), "1:00:00");
    assert.equal(formatElapsed(H + 1 * S), "1:00:01");
    assert.equal(formatElapsed(23 * H + 59 * M + 59 * S), "23:59:59");
});

test("days after that", () => {
    assert.equal(formatElapsed(D), "1:00:00:00");
    assert.equal(formatElapsed(D + 23 * H + 59 * M + 59 * S), "1:23:59:59");
    assert.equal(formatElapsed(9 * D + H), "9:01:00:00");
});

test("never goes backwards past zero", () => {
    assert.equal(formatElapsed(-5000), "0");
});
