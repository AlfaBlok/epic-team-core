// under tsx (npm start / dev) the indexer process loads its TypeScript through tsx's loader. The release runs the
// bundled dist/indexer.mjs instead (scripts/build-release.sh).
import { register } from "tsx/esm/api";

register();
await import("./main.ts");
