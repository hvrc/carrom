// Copy the server's simulation into the client tree, so it can be bundled.
//
// Ruler mode runs the REAL physics rather than an approximation, which means
// the client has to import server/sim/*. That works in the repo, where the
// server is a directory away, and fails in the container, where the client is
// built from its own folder alone — nothing above it is uploaded.
//
// So the copy is made here, BEFORE the container is built, and the copy is what
// gets bundled. server/sim stays the single source of truth: this script only
// ever writes, never edits, and the copy is gitignored so it can never be
// changed by hand and drift.
//
// Runs from `npm run dev` and `npm run build`. Inside the container the server
// is not there — the copy already is, so it is left alone.

import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "..", "..", "server", "sim");
const target = join(here, "..", "vendor", "sim");

const exists = async (p) => !!(await stat(p).catch(() => null));

if (await exists(source)) {
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    await cp(source, target, { recursive: true });
    const files = await readdir(target);
    console.log(`vendored server/sim -> client/vendor/sim (${files.length} files)`);
} else if (await exists(target)) {
    // The container: no server to copy from, and none needed.
    console.log("vendored server/sim already present; nothing to copy");
} else {
    console.error(
        "Cannot find server/sim, and client/vendor/sim does not exist.\n" +
        "Run this from the repo so the simulation can be copied in.",
    );
    process.exit(1);
}
