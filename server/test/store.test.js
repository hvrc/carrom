// The JSON backend: local development, and the fallback everywhere else.
// The rules themselves live in storeContract.js and are run against Firestore
// too, so the two cannot drift apart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStore } from "../store/index.js";
import { runStoreContract } from "./storeContract.js";

const dir = join(tmpdir(), "carrom-store-test");
const file = join(dir, "store.json");

runStoreContract("json backend", {
    open: () => createStore({ backend: "json", file }),
    clear: () => rm(dir, { recursive: true, force: true }),
});

// Specific to keeping it in a file.

test("the file is valid JSON after a burst of writes", async () => {
    await rm(dir, { recursive: true, force: true });
    const store = createStore({ backend: "json", file });
    await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
            store.recordSoloRun({ username: `p${i}`, coinCount: 5, ms: 1000 + i })),
    );
    // A half-written file is the failure the temp-file-and-rename prevents.
    const parsed = JSON.parse(await readFile(file, "utf8"));
    assert.equal(parsed.soloRuns.length, 20);
});
