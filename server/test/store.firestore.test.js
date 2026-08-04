// The Firestore backend, run against a real Firestore — the emulator.
//
// This is the backend production uses, so testing it against a hand-written
// fake would prove nothing: the parts worth doubting are exactly the parts a
// fake would get right by construction (does a transaction actually serialise,
// does orderBy work without an index, is "a/b" a legal document id).
//
// Start one with:
//   docker run -d --name carrom-fs-emu -p 8088:8088 \
//     gcr.io/google.com/cloudsdktool/google-cloud-cli:emulators \
//     gcloud emulators firestore start --host-port=0.0.0.0:8088
//
// Without it these tests skip rather than fail: nobody should need Docker to
// work on the game.

import { test } from "node:test";
import { connect } from "node:net";
import { createStore } from "../store/index.js";
import { runStoreContract } from "./storeContract.js";

const HOST = process.env.FIRESTORE_EMULATOR_HOST || "localhost:8088";

function reachable(hostPort, ms = 700) {
    const [host, port] = hostPort.split(":");
    return new Promise((resolve) => {
        const socket = connect({ host, port: Number(port) });
        const done = (ok) => { socket.destroy(); resolve(ok); };
        socket.setTimeout(ms);
        socket.once("connect", () => done(true));
        socket.once("timeout", () => done(false));
        socket.once("error", () => done(false));
    });
}

const up = await reachable(HOST);

if (!up) {
    test("firestore backend (skipped: no emulator at " + HOST + ")", { skip: true }, () => {});
} else {
    process.env.FIRESTORE_EMULATOR_HOST = HOST;
    process.env.GOOGLE_CLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || "carrom-test";

    // Its own collections, so a run cannot tread on a real database if someone
    // points this at one by accident.
    const namespace = "test-carrom";
    const open = () => createStore({ backend: "firestore", namespace });

    runStoreContract("firestore backend", {
        open,
        clear: () => open().reset(),
    });
}
