import { execFile } from "../spawnHost.js";
import fs from "node:fs";
import type { DB } from "../db.js";
import { DEFAULT_TENANT } from "../db.js";
import type { Store } from "../store.js";
import { deliveryFor } from "./delivery.js";
import { repoKey } from "../adapters/repoNames.js";
import { type HostId, mainHost, workerHost } from "../identity.js";

/**
 * the repo index the Team desk reads to place an idea fast. Every checkout on the main server and the worker server (scripts/repo_index.py
 * per host: name, origin, newest commit, a one-line summary) joined with the console's milestones (the home world's by title, link and
 * Delivery Manager state; another world's named only as such), grouped by last activity: the last month, the last
 * 3 months, older. Git runs only in the background refresh (git spawns on the request path stall the console); the
 * route reads the stored rows. A host that cannot be reached keeps its last rows, and the index says so.
 */
export type IndexHost = HostId;
export const indexHosts = (): IndexHost[] => [mainHost(), workerHost()];
export const MONTH_DAYS = 31;
export const QUARTER_DAYS = 92;
export const REFRESH_MS = 6 * 3600_000;

export interface ScannedRepo {
  name: string;
  remote?: string | null;
  /** Newest commit on any ref (ISO). */
  last?: string | null;
  subject?: string | null;
  summary?: string | null;
  /** root spine path in the checkout ("" = none). */
  spine?: string | null;
}
export type RepoScan = (host: IndexHost) => Promise<ScannedRepo[]>;

export interface IndexEntry {
  name: string;
  remote?: string;
  hosts: IndexHost[];
  last?: string;
  subject?: string;
  summary: string;
  /** root spine in the checkout, when it has one (a milestone on it is `POST /api/milestones`; without, bootstrap). */
  spine?: string;
  /** no console milestone on this repo, in any world: the desk says so and offers to add one. */
  noMilestone: boolean;
  milestones: { id?: string; title: string; world: string; link?: string; delivery?: string }[];
}

export function migrateRepoIndex(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS repo_index (
      host TEXT NOT NULL,
      name TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (host, name)
    );
    CREATE TABLE IF NOT EXISTS repo_index_scan (
      host TEXT PRIMARY KEY,
      at TEXT,
      ok_at TEXT,
      error TEXT
    );
  `);
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** scripts/repo_index.py here, or over the console's ssh access on the worker server (same pattern as run_usage.py). */
export function realRepoScan(o: { script: string; root?: string; worker?: { ssh: string; sshKey?: string; knownHosts: string }; python?: string; timeoutMs?: number }): RepoScan {
  const timeout = o.timeoutMs ?? 180_000;
  const req = JSON.stringify({ root: o.root ?? "~/github" });
  return (host) =>
    new Promise((resolve, reject) => {
      const done = (err: Error | null, stdout: string, stderr: string) => {
        if (err) return reject(new Error(String(stderr).trim().split("\n").pop() || err.message));
        try {
          const out = JSON.parse(stdout) as { repos?: ScannedRepo[]; error?: string };
          if (out.error && !out.repos?.length) return reject(new Error(out.error));
          resolve(out.repos ?? []);
        } catch (e) {
          reject(new Error(`repo_index.py output: ${(e as Error).message}`));
        }
      };
      if (host === mainHost()) {
        execFile(o.python ?? "python3", ["-I", o.script, req], { timeout, maxBuffer: 8 << 20, encoding: "utf8" }, done);
        return;
      }
      if (!o.worker) return reject(new Error(`${workerHost()} not configured (CONSOLE_VPS3_SSH unset)`));
      const args = [
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=10",
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", `UserKnownHostsFile=${o.worker.knownHosts}`,
        ...(o.worker.sshKey ? ["-i", o.worker.sshKey] : []),
        o.worker.ssh,
        `python3 -I - ${shq(req)}`,
      ];
      const child = execFile("ssh", args, { timeout, maxBuffer: 8 << 20, encoding: "utf8" }, done);
      child.stdin?.end(fs.readFileSync(o.script));
    });
}

const slug = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");

export function createRepoIndex(d: { db: DB; store: Store; scan?: RepoScan; publicUrl: string; now?: () => number; hosts?: IndexHost[] }) {
  migrateRepoIndex(d.db);
  const now = d.now ?? Date.now;
  const hosts = d.hosts ?? indexHosts();
  const base = () => d.publicUrl.replace(/\/+$/, "");
  let running: Promise<{ host: IndexHost; repos?: number; error?: string }[]> | undefined;

  /** Scan every host (one at a time) and replace its rows; a failed host keeps its last rows. Never on a request. */
  function refresh() {
    running ??= (async () => {
      const out: { host: IndexHost; repos?: number; error?: string }[] = [];
      for (const host of hosts) {
        const at = new Date(now()).toISOString();
        try {
          if (!d.scan) throw new Error("no scanner");
          const repos = (await d.scan(host)).filter((r) => r && typeof r.name === "string" && r.name);
          d.db.exec("BEGIN");
          try {
            d.db.prepare("DELETE FROM repo_index WHERE host = ?").run(host);
            const ins = d.db.prepare("INSERT OR REPLACE INTO repo_index (host, name, data) VALUES (?, ?, ?)");
            for (const r of repos) ins.run(host, r.name, JSON.stringify(r));
            d.db.prepare("INSERT INTO repo_index_scan (host, at, ok_at, error) VALUES (?, ?, ?, NULL) ON CONFLICT(host) DO UPDATE SET at = excluded.at, ok_at = excluded.ok_at, error = NULL").run(host, at, at);
            d.db.exec("COMMIT");
          } catch (e) {
            d.db.exec("ROLLBACK");
            throw e;
          }
          out.push({ host, repos: repos.length });
        } catch (e) {
          const error = (e as Error).message.slice(0, 300);
          d.db.prepare("INSERT INTO repo_index_scan (host, at, error) VALUES (?, ?, ?) ON CONFLICT(host) DO UPDATE SET at = excluded.at, error = excluded.error").run(host, at, error);
          out.push({ host, error });
        }
      }
      return out;
    })().finally(() => {
      running = undefined;
    });
    return running;
  }

  function scans(): { host: string; at?: string; okAt?: string; error?: string }[] {
    return (d.db.prepare("SELECT host, at, ok_at, error FROM repo_index_scan ORDER BY host").all() as { host: string; at: string | null; ok_at: string | null; error: string | null }[]).map((r) => ({
      host: r.host,
      ...(r.at ? { at: r.at } : {}),
      ...(r.ok_at ? { okAt: r.ok_at } : {}),
      ...(r.error ? { error: r.error } : {}),
    }));
  }

  function entries(): IndexEntry[] {
    const rows = d.db.prepare("SELECT host, name, data FROM repo_index ORDER BY host, name").all() as { host: IndexHost; name: string; data: string }[];
    const byKey = new Map<string, IndexEntry>();
    for (const row of rows) {
      let r: ScannedRepo;
      try {
        r = JSON.parse(row.data) as ScannedRepo;
      } catch {
        continue;
      }
      const key = r.remote ? repoKey(slug(r.remote)) : `name:${r.name.toLowerCase()}`; // both names of a renamed repo, one entry
      const e = byKey.get(key) ?? { name: r.name, ...(r.remote ? { remote: r.remote } : {}), hosts: [], summary: "", noMilestone: true, milestones: [] };
      if (!e.hosts.includes(row.host)) e.hosts.push(row.host);
      if (!e.summary && r.summary) e.summary = r.summary;
      if (!e.spine && r.spine) e.spine = r.spine;
      if (r.last && (!e.last || Date.parse(r.last) > Date.parse(e.last))) {
        e.last = r.last;
        if (r.subject) e.subject = r.subject;
      }
      byKey.set(key, e);
    }
    // The console's milestones: each joins its repo (by origin slug, else checkout name); a repo no host has still gets a line.
    for (const m of d.store.listMilestones({ includeSettled: false })) {
      const s = slug(m.repo);
      const e =
        byKey.get(s) ??
        [...byKey.values()].find((x) => x.name.toLowerCase() === s.split("/").pop()) ??
        (() => {
          const fresh: IndexEntry = { name: s.split("/").pop() || m.repo, ...(s.includes("/") ? { remote: m.repo } : {}), hosts: [], summary: "", noMilestone: true, milestones: [] };
          byKey.set(s, fresh);
          return fresh;
        })();
      e.noMilestone = false;
      const world = d.store.worldOfMilestone(m.id) ?? DEFAULT_TENANT;
      if (world !== DEFAULT_TENANT) {
        e.milestones.push({ title: `another world's milestone (${world})`, world });
        continue;
      }
      const dl = deliveryFor(d.store, m.id);
      e.milestones.push({
        id: m.id,
        title: m.title,
        world,
        link: `${base()}/milestones/${m.id}`,
        delivery: dl.delivered ? `${dl.persona} on` : (dl.notice ?? "").replace(/^added, will not be delivered: /, ""),
      });
    }
    return [...byKey.values()].sort((a, b) => (Date.parse(b.last ?? "") || 0) - (Date.parse(a.last ?? "") || 0) || a.name.localeCompare(b.name));
  }

  const ageDays = (iso?: string) => {
    const t = Date.parse(iso ?? "");
    return Number.isFinite(t) ? (now() - t) / 86_400_000 : Infinity;
  };

  function line(e: IndexEntry): string {
    const days = ageDays(e.last);
    const when = e.last ? `${e.last.slice(0, 10)} (${days < 1 ? "today" : `${Math.floor(days)} d ago`})` : "no commits";
    const what = e.summary || (e.subject ? `no README; last commit: ${e.subject}` : "no README");
    const ms = e.milestones.length ? e.milestones.map((m) => (m.link ? `[${m.title}](${m.link}) · ${m.delivery}` : m.title)).join("; ") : noMilestoneText(e);
    return `- **${e.name}**${e.remote ? ` (${e.remote})` : ""}: ${what} · last activity ${when}${e.hosts.length ? ` on ${e.hosts.join("+")}` : ", no checkout"} · ${ms}`;
  }

  function markdown(): string {
    const all = entries();
    const month = all.filter((e) => ageDays(e.last) <= MONTH_DAYS);
    const quarter = all.filter((e) => ageDays(e.last) > MONTH_DAYS && ageDays(e.last) <= QUARTER_DAYS);
    const older = all.filter((e) => ageDays(e.last) > QUARTER_DAYS);
    const sc = scans();
    const scanLine = sc.length
      ? sc.map((s) => `${s.host} ${s.okAt ? `scanned ${s.okAt.slice(0, 16)}Z` : "never scanned"}${s.error ? ` (last try failed: ${s.error}; its rows are from the last good scan)` : ""}`).join(", ")
      : "not scanned yet";
    const section = (title: string, list: IndexEntry[]) => [`## ${title} (${list.length})`, ...(list.length ? list.map(line) : ["- none"]), ""];
    return [
      "# Repo index",
      "",
      `Every repo on ${mainHost()} and ${workerHost()} and every console milestone, one line each: what it is, last activity, its milestone and Delivery Manager. ${scanLine}; refreshed every ${REFRESH_MS / 3600_000} h in the background.`,
      "",
      ...section(`Worked in the last month`, month),
      ...section(`Last 3 months`, quarter),
      ...section(`All time (older)`, older),
    ].join("\n");
  }

  let timer: NodeJS.Timeout | undefined;
  return {
    refresh,
    entries,
    scans,
    markdown,
    /** First scan soon after boot (when the index is empty or stale), then every `everyMs`. */
    start(everyMs = REFRESH_MS, firstMs = 30_000) {
      const fresh = scans().some((s) => s.okAt && now() - Date.parse(s.okAt) < everyMs);
      const kick = () => void refresh().catch((e) => console.error("repo index:", e));
      if (!fresh) setTimeout(kick, firstMs).unref();
      timer = setInterval(kick, everyMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}

/** the index's words for a repo with no milestone; the desk's rule (desk.ts endpointLines) keys on "no milestone". */
export function noMilestoneText(e: Pick<IndexEntry, "spine">): string {
  return `no milestone (${e.spine ? `root spine ${e.spine}` : "no spine yet"}): offer to add it`;
}

export type RepoIndex = ReturnType<typeof createRepoIndex>;
