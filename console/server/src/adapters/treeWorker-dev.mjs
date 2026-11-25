// under tsx (npm start / dev / tests) a worker thread does not inherit tsx's loader: register it, then load the worker.
// The release runs the bundled dist/treeWorker.mjs instead (scripts/build-release.sh).
import { register } from "tsx/esm/api";

register();
await import("./treeWorker.ts");
