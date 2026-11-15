import { openDb } from "../db.js";
import { createIndexer, type IndexerConfig } from "./core.js";
import { setRepoAllowlist } from "../adapters/repos.js";

/**
 * the indexer process (core.ts). The console starts it (launch.ts) with its config in CONSOLE_INDEXER_CONFIG and
 * its own pid in CONSOLE_INDEXER_PARENT: when that console is gone (a stop, a deploy's restart, a crash) the indexer
 * exits too, so it never writes a database a deploy is restoring. It answers nothing over the network.
 */
const c = JSON.parse(process.env.CONSOLE_INDEXER_CONFIG || "{}") as IndexerConfig;
if (!c.dbPath || !c.reposRoot) {
  console.error("indexer: CONSOLE_INDEXER_CONFIG needs dbPath and reposRoot");
  process.exit(2);
}
const only = setRepoAllowlist(process.env.CONSOLE_INDEX_REPOS); // staging indexes the code repo only
if (only) console.log(`indexer: only these repos are indexed (CONSOLE_INDEX_REPOS): ${only.join(", ")}`);
const parent = Number(process.env.CONSOLE_INDEXER_PARENT || 0);
const db = openDb(c.dbPath);
const indexer = createIndexer(db, c);
indexer.start();

const stop = (why: string) => {
  console.log(`indexer: stopping (${why})`);
  indexer.stop();
  try {
    db.close();
  } catch {
    /* closing anyway */
  }
  process.exit(0);
};
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => stop(sig));
if (parent > 0)
  setInterval(() => {
    try {
      process.kill(parent, 0);
    } catch {
      stop(`console ${parent} is gone`);
    }
  }, 1_000);
