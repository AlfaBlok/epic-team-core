import fs from "node:fs";
import path from "node:path";

/**
 * The owner's workspace data can live in a data repo of its own, apart from the app's code: a home checkout whose
 * workspace data moved there keeps a
 * pointer, `docs/workspace-data.json` ({ repo, checkout }), and links in place of docs/pursuits.json and
 * docs/scorecards, so every read works as before. A WRITE must go to the data checkout (the folder next to the home
 * checkout, `<reposRoot>/<checkout>`), where it is committed and pushed; the home repo never holds the data again.
 * A checkout with no pointer (another workspace, a test folder) is its own data folder.
 */
export const WORKSPACE_DATA_POINTER = "docs/workspace-data.json";

export function workspaceDataDir(dir: string): string;
export function workspaceDataDir(dir: string | undefined): string | undefined;
export function workspaceDataDir(dir: string | undefined): string | undefined {
  if (!dir) return dir;
  let p: { repo?: unknown; checkout?: unknown };
  try {
    p = JSON.parse(fs.readFileSync(path.join(dir, WORKSPACE_DATA_POINTER), "utf8")) as typeof p;
  } catch {
    return dir;
  }
  if (typeof p.checkout !== "string" || !/^[A-Za-z0-9_.-]{1,100}$/.test(p.checkout)) return dir;
  if (process.env.CONSOLE_WORKSPACE_DATA) return process.env.CONSOLE_WORKSPACE_DATA;
  const beside = path.join(path.dirname(path.resolve(dir)), p.checkout);
  return fs.existsSync(beside) ? beside : dir;
}
