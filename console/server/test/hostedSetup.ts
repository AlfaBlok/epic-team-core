// the suite tests the hosted build, so every test worker loads the hosted layer as the server entry does
// (plug/hosted.ts loadHosted): its plugs become createApp's default and its hooks replace the one-team ones.
// test/plug.test.ts checks the bare core (resetHosted) on its own.
import "./neutralOwner.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadHosted } from "../src/plug/hosted.js";
// the hosted tree when it is there (hostedEntries); the open core runs its suite without it
await loadHosted(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src"), {});
// the owner's name is config (src/identity.ts): the suite names a neutral owner, so a test that reads "Sam" in a prompt
// proves the text comes from the identity module. Our own name is checked where it must stay (test/identity.test.ts).
import { setIdentity } from "../src/identity.js";
setIdentity({ owner: "Sam" });
