// under tsx (npm start / dev) a worker thread does not inherit tsx's loader: register it, then load the worker.
// The release runs the bundled dist/readModelWorker.mjs instead (scripts/build-release.sh).
import { register } from "tsx/esm/api";

register();
await import("./worker.ts");
