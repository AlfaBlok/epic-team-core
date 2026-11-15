import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { deriveStatus, normalizeStatus, parseDoc, readDoc, ticketIdFor } from "../src/adapters/doc.js";
import { githubSlug, listDocs, listRepos, repoForDir, resolveRepo } from "../src/adapters/repos.js";
import { NOT_LINKED, backlogFor, deriveMilestone } from "../src/adapters/milestone.js";
import { mapSeats } from "../src/adapters/seats.js";
import { createMcpClient, sortThreads, t3ThreadLister, type Thread } from "../src/adapters/threads.js";
import type { ReadConfig } from "../src/routes/read.js";
import { E5, EPIC0, ROOT_SPINE, SEATS, makeFixtureRoot, real } from "./fixtures.js";

let fx: ReturnType<typeof makeFixtureRoot>;
beforeEach(() => {
  fx = makeFixtureRoot();
});
afterEach(() => fx.cleanup());

const dod = (done: number, total: number) => ({ dod: { done, total, items: [] }, statusLine: undefined, waitingOn: undefined });

describe("repos adapter", () => {
  it("lists only git checkouts whose .git is a directory, with GitHub remote and EpicSpine flag", () => {
    const repos = listRepos(fx.root);
    expect(repos.map((r) => r.name)).toEqual(["home_repo", "ops", "plain"]);
    expect(repos.find((r) => r.name === "ops")).toMatchObject({ remote: "Acme/ops", hasEpicSpine: true });
    expect(repos.find((r) => r.name === "home_repo")).toMatchObject({ remote: "Acme/home_repo", hasEpicSpine: true });
    expect(repos.find((r) => r.name === "plain")).toMatchObject({ remote: undefined, hasEpicSpine: false });
  });

  it("parses GitHub remotes", () => {
    expect(githubSlug("https://github.com/Acme/ops.git")).toBe("Acme/ops");
    expect(githubSlug("git@github.com:acme-ai/cloud.git")).toBe("acme-ai/cloud");
    expect(githubSlug("https://gitlab.com/a/b.git")).toBeUndefined();
  });

  it("resolves a milestone repo by name, owner/name, or path, and a worktree to its repo", () => {
    const infra = path.join(fx.root, "ops");
    expect(resolveRepo(fx.root, "ops")?.path).toBe(infra);
    expect(resolveRepo(fx.root, "acme/ops")?.path).toBe(infra);
    expect(resolveRepo(fx.root, infra)?.path).toBe(infra);
    expect(resolveRepo(fx.root, "nope")).toBeUndefined();
    expect(repoForDir(fx.root, path.join(fx.root, "home_repo-wt-m2-3"))?.name).toBe("home_repo");
  });

  it("lists candidate docs: spines first, then tickets, with title, status and DoD", () => {
    const docs = listDocs(path.join(fx.root, "ops"));
    expect(docs).toEqual([
      { path: "docs/EPIC-900-VPS-FLEET.md", kind: "spine", title: "EPIC-900: VPS fleet — inventory, health, and sizing", status: "active", dod: { done: 1, total: 2 } },
      { path: "tickets/E1-inventory-health-baseline.md", kind: "ticket", title: "E1: Inventory + health baseline", status: "done", dod: { done: 1, total: 1 } },
      { path: "tickets/E905-fleet-observatory.md", kind: "ticket", title: 'E5: Fleet Observatory (milestone "M2")', status: "active", dod: { done: 0, total: 7 } },
      { path: "tickets/VH-T10-watchdog-alert-delivery.md", kind: "ticket", title: "VH-T10: Watchdog alert delivery", status: "blocked — needs Sam", dod: { done: 0, total: 0 } },
    ]);
    const at = listDocs(path.join(fx.root, "home_repo")).map((d) => `${d.kind}:${d.path}`);
    expect(at).toEqual(["spine:docs/spines/root.md", "spine:notes/deep/leaf.md"]); // node_modules skipped
  });
});

describe("doc parsing + status heuristic", () => {
  it("reads title, status, waiting-on, ticket root and a 6-line Current State excerpt", () => {
    const d = parseDoc(EPIC0);
    expect(d).toMatchObject({ title: "EPIC-900: VPS fleet — inventory, health, and sizing", statusLine: "active", ticketRoot: "../tickets", spineId: "EPIC-900" });
    expect(d.waitingOn).toBe("Sam decisions for P1b, P2, P4 (P0 done).");
    expect(d.stateExcerpt.split("\n")).toHaveLength(5);
    expect(d.stateExcerpt).toMatch(/^Owner: Sam/);
    const root = parseDoc(ROOT_SPINE);
    expect(root.stateExcerpt.split("\n")).toHaveLength(6);
    expect(root.stateExcerpt).not.toMatch(/Verified at/);
  });

  it("falls back to the Goal section for the excerpt (epic tickets)", () => {
    const d = parseDoc(E5);
    expect(d.stateExcerpt).toMatch(/^One page Sam opens/);
    expect(d.dod).toMatchObject({ done: 0, total: 7 });
    expect(d.ledger.map((r) => [r.id, r.status])).toEqual([
      ["E5.1", "done 2026-10-14 (88406a2)"],
      ["E5.2", "done 2026-10-14"],
      ["E5.3", "pending E5.1"],
    ]);
  });

  it("status = the Status word only: paused (console) > Status word > unknown; DoD progress does not change it", () => {
    expect(deriveStatus({ ...dod(2, 2), statusLine: "blocked" }, true)).toEqual({ status: "paused" });
    expect(deriveStatus({ ...dod(2, 2), statusLine: "active" }, false)).toEqual({ status: "active" });
    expect(deriveStatus({ ...dod(1, 1), statusLine: "done (verify first run)" }, false)).toEqual({ status: "done" });
    expect(deriveStatus({ ...dod(0, 3), statusLine: "ready" }, false)).toEqual({ status: "ready" });
    expect(deriveStatus({ ...dod(0, 3), statusLine: "**Deferred** by Sam" }, false)).toEqual({ status: "deferred" });
    expect(deriveStatus({ ...dod(0, 3), statusLine: "draft" }, false)).toEqual({ status: "draft" });
    expect(deriveStatus(dod(0, 0), false)).toEqual({ status: "unknown" });
    expect(deriveStatus({ ...dod(0, 0), statusLine: "research + plan (no production change)" }, false)).toEqual({ status: "unknown" });
  });

  it("blocked only when the Status word is blocked; reason = rest of the line, else Waiting on", () => {
    expect(deriveStatus({ ...dod(0, 3), statusLine: "blocked — waiting on vendor" }, false)).toEqual({
      status: "blocked",
      blockedReason: "waiting on vendor",
    });
    expect(deriveStatus({ ...dod(0, 3), statusLine: "Blocked", waitingOn: "DNS change" }, false)).toEqual({
      status: "blocked",
      blockedReason: "Waiting on: DNS change",
      waitingOn: "DNS change",
    });
    expect(deriveStatus({ ...dod(0, 3), statusLine: "active — unblocked yesterday" }, false).status).toBe("active");
  });

  it("Waiting on never implies blocked (EPIC-903 one status word): Status active + Waiting on Sam → active", () => {
    const w = (waitingOn: string, statusLine = "active") => deriveStatus({ ...dod(0, 3), statusLine, waitingOn }, false);
    expect(w("Sam decisions for P1b, P2")).toEqual({ status: "active", waitingOn: "Sam decisions for P1b, P2" });
    expect(w("approval of the memory limits")).toEqual({ status: "active", waitingOn: "approval of the memory limits" });
    expect(w("Sam's go", "deferred")).toEqual({ status: "deferred", waitingOn: "Sam's go" });
    expect(w("none")).toEqual({ status: "active" });
  });

  it("derives ticket ids from files", () => {
    expect(ticketIdFor("/x/tickets/E905-fleet-observatory.md")).toBe("E905");
    expect(ticketIdFor("/x/tickets/VH-T10-watchdog-alert-delivery.md")).toBe("VH-T10");
    expect(ticketIdFor("/x/tickets/notes.md")).toBe("notes");
  });

  it("caches parsed files by mtime", () => {
    const f = path.join(fx.root, "ops/tickets/E905-fleet-observatory.md");
    const a = readDoc(f)!;
    expect(readDoc(f)).toBe(a);
    fs.writeFileSync(f, E5.replace("- [ ] Tabs", "- [x] Tabs"));
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(f, later, later);
    const b = readDoc(f)!;
    expect(b).not.toBe(a);
    expect(b.dod.done).toBe(1);
  });
});

describe("milestone derivation + backlog", () => {
  const ms = (repo: string, p: string, paused = false) => ({ id: "ms_1", repo, path: p, paused });

  it("reads the ops E5 ticket", () => {
    const d = deriveMilestone(fx.root, ms("Acme/ops", "tickets/E905-fleet-observatory.md"));
    expect(d).toMatchObject({ status: "active", dod: { done: 0, total: 7 } });
    expect(d.dod.items[0]).toEqual({ text: "Tabs **Now**, **CPU**, **DATA** on the existing status page (other chapters stay reachable).", checked: false });
    expect(d.docError).toBeUndefined();
  });

  it("reports a missing repo or file without failing", () => {
    expect(deriveMilestone(fx.root, ms("nope", "x.md"))).toMatchObject({ status: "active", dod: { total: 0 }, docError: expect.stringMatching(/repo nope/) });
    expect(deriveMilestone(fx.root, ms("ops", "../other_repo/AGENTS.md")).docError).toMatch(/outside/);
    expect(deriveMilestone(fx.root, ms("ops", "missing.md", true))).toMatchObject({ status: "paused", docError: expect.stringMatching(/not found/) });
  });

  it("builds the backlog from the doc's own ledger rows, enriched from the linked ticket files", () => {
    const b = backlogFor(fx.root, ms("ops", "docs/EPIC-900-VPS-FLEET.md"));
    const byId = Object.fromEntries(b.map((t) => [t.id, t]));
    // sits in the Ticket root but never links it: not backlog.
    expect(Object.keys(byId)).toEqual(["E1", "E5"]);
    expect(byId.E5).toMatchObject({ title: "Fleet Observatory", status: "active", source: "ledger · ticket file", repo: "Acme/ops", path: "tickets/E905-fleet-observatory.md", milestoneId: "ms_1" });
    expect(byId.E1.status).toBe("done");
    const rootB = backlogFor(fx.root, ms("home_repo", "docs/spines/root.md"));
    expect(rootB).toEqual([
      { id: "M2-2", title: "Cycle + bootstrap", repo: "Acme/home_repo", milestoneId: "ms_1", status: "dispatched", owner: "seat pool", role: "Ticket worker", source: "ledger" },
      { id: "M2-3", title: "Read adapters + pickers", repo: "Acme/home_repo", milestoneId: "ms_1", status: "dispatched", owner: "seat pool", role: "Ticket worker", source: "ledger" },
    ]);
  });

  it("falls back to the Ticket root only when the doc has no work-item rows", () => {
    fx.write("ops/docs/EPIC-909.md", "# EPIC-909\n\nTicket root: ../tickets\n\n## Current State\n\nStatus: active\n");
    const b = backlogFor(fx.root, ms("ops", "docs/EPIC-909.md"));
    expect(b.map((t) => `${t.id}|${t.status}|${t.source}`)).toEqual([
      `E1|done|${NOT_LINKED}`,
      `E5|active|${NOT_LINKED}`,
      `VH-T10|blocked|${NOT_LINKED}`,
    ]);
    expect(b[2].statusDetail).toBe("blocked — needs Sam");
  });

  describe("real ops EPIC-902 sprint spine", () => {
    const tickets: [string, string][] = [
      ["E6-market-data-rationalization", "# E6: Market data rationalized (milestone M7)\n\nTicket ID: E6\nStatus: active\nOwner: delivery manager + workers\n"],
      ["VH-T16-backups-direct-to-s3", "# VH-T16: Backups go straight to S3\n\nStatus: ready\nOwner: worker\n"],
      ["VH-T18-persist-deployer-limits", "# VH-T18: Persist the xtreme_logger 1G limit in Deployer\n\nStatus: blocked\nOwner: Sam (approvals)\n"],
      ["VH-T19-cron-logger-harmonization", "# VH-T19: Cron / logger harmonization (future)\n\nStatus: blocked\n"],
    ];
    beforeEach(() => {
      fx.write("ops/docs/EPIC-902-MAIN-CONTROL.md", real("EPIC-902-MAIN-CONTROL.md"));
      for (const [f, text] of tickets) fx.write(`ops/tickets/${f}.md`, text);
    });

    it("backlog = 11 Queue rows + 5 Issue Ledger rows in doc order, statuses normalised", () => {
      const b = backlogFor(fx.root, ms("ops", "docs/EPIC-902-MAIN-CONTROL.md"));
      expect(b.map((t) => `${t.id} | ${t.status} | ${t.source}`)).toEqual([
        "S1 | done | queue",
        "S2 | — | queue",
        "S3 | — | queue",
        "S4 | blocked | queue",
        "S5 | ready | queue",
        "S6 | ready | queue",
        "S7 | blocked | queue",
        "S8 | — | queue",
        "S9 | blocked | queue",
        "S10 | ready | queue",
        "S11 | active | queue",
        "E6 | active | ledger · ticket file",
        "VH-T16 | ready | ledger · ticket file",
        "VH-T18 | blocked | ledger · ticket file",
        "VH-T19 | blocked | ledger · ticket file",
        "E5 | active | ledger · ticket file",
      ]);
      const byId = Object.fromEntries(b.map((t) => [t.id, t]));
      expect(byId.S1).toMatchObject({ title: "Pause tripwire", owner: "Sam (root)", statusDetail: "done 10-16 03:00, verified inactive/disabled" });
      expect(byId.S4.statusDetail).toBe("waiting on Sam's go (since 10-13)");
      expect(byId.S2.statusDetail).toBe("due ~10-17 03:00");
      expect(byId.S5.statusDetail).toBeUndefined();
      // Ledger has only `Ticket | Depends On`: title + owner come from the linked file, not the Depends On cell.
      expect(byId.E6).toMatchObject({ title: "E6: Market data rationalized (milestone M7)", owner: "delivery manager + workers", path: "tickets/E6-market-data-rationalization.md" });
      expect(byId.E5.title).toBe('E5: Fleet Observatory (milestone "M2")');
      expect(b.some((t) => t.id === "E1" || t.id === "VH-T10")).toBe(false);
    });

    // 109e99e93 turned this fixture's numbered Exit Test into a Definition Of Done of five open checkboxes;
    // the untracked numbered list is covered by dod.test.ts and doneMeansDod.test.ts ("old spine regression").
    it("DoD = the 5 Definition Of Done checkboxes, all open; status + shape", () => {
      const d = deriveMilestone(fx.root, ms("ops", "docs/EPIC-902-MAIN-CONTROL.md"));
      expect(d.dod).toMatchObject({ done: 0, total: 5, tracked: true });
      expect(d.dod.items).toHaveLength(5);
      expect(d.dod.items.every((i) => i.checked === false)).toBe(true);
      expect(d.dod.items[0].text).toMatch(/^DOD-1 \*\*CPU\*\*: production/);
      expect(d.dod.items[4].text).toMatch(/^DOD-5 \*\*Nothing silent\*\*/);
      expect(d.status).toBe("active"); // Status: active; "Waiting on: the owner …" is context only
      expect(d.waitingOn).toMatch(/^Sam: S2 root stop/);
      expect(d.blockedReason).toBeUndefined();
      expect(d.shape).toEqual({ dod: true, currentState: true, status: true, waitingOn: true, issueLedger: true, queue: true });
    });
  });

  it("real E5 ticket: 0/7 tracked; real home_repo M2 spine: ledger rows", () => {
    fx.write("ops/tickets/E905-fleet-observatory.md", real("E905-fleet-observatory.md"));
    const e5 = deriveMilestone(fx.root, ms("ops", "tickets/E905-fleet-observatory.md"));
    expect(e5.dod).toMatchObject({ done: 0, total: 7 });
    expect(e5.dod.tracked).toBe(true);
    expect(e5.dod.items.every((i) => i.checked === false)).toBe(true);
    expect(backlogFor(fx.root, ms("ops", "tickets/E905-fleet-observatory.md")).map((t) => `${t.id}|${t.status}`)).toEqual([
      "E5.1|done",
      "E5.2|done",
      "E5.3|done",
      "E5.4|done",
    ]);

    fx.write("home_repo/docs/spines/m2-team-console.md", real("m2-team-console.md"));
    const m2 = deriveMilestone(fx.root, ms("home_repo", "docs/spines/m2-team-console.md"));
    expect(m2.dod).toMatchObject({ done: 1, total: 8 });
    const b = backlogFor(fx.root, ms("home_repo", "docs/spines/m2-team-console.md"));
    expect(b.map((t) => t.id)).toEqual(["M2-1", "M2-2", "M2-3", "M2-4", "M2-5", "M2-7", "M2-8", "M2-6"]);
    expect(b.every((t) => t.source === "ledger")).toBe(true);
    expect(b.find((t) => t.id === "M2-8")).toMatchObject({ status: "dispatched", statusDetail: "dispatched 2026-10-16" });
    expect(b.find((t) => t.id === "M2-6")?.status).toBe("pending");
  });

  it("normalises free-text statuses", () => {
    expect(normalizeStatus("**done 10-16 03:00**, verified")).toEqual({ status: "done", statusDetail: "done 10-16 03:00, verified" });
    expect(normalizeStatus("waiting on Sam's go")).toEqual({ status: "blocked", statusDetail: "waiting on Sam's go" });
    expect(normalizeStatus("in progress")).toEqual({ status: "active", statusDetail: "in progress" });
    expect(normalizeStatus("blocked until ~10-23").status).toBe("blocked");
    expect(normalizeStatus("due ~10-17")).toEqual({ status: "—", statusDetail: "due ~10-17" });
    expect(normalizeStatus("ready")).toEqual({ status: "ready" });
    expect(normalizeStatus("not started")).toMatchObject({ status: "pending" });
    expect(normalizeStatus(undefined)).toEqual({ status: "—" });
  });
});

describe("seats", () => {
  it("maps seats.json to the console shape", () => {
    const s = mapSeats(SEATS, new Date("2026-10-14T21:20:00Z"));
    expect(s.map((x) => x.id)).toEqual(["seat1", "seat2"]);
    expect(s[0]).toEqual({
      id: "seat1",
      name: "seat1",
      usage5h: 4,
      usageWeekly: 29,
      resetsAt: { fiveHour: "2026-10-14T23:00:00Z", weekly: "2026-10-18T00:00:00Z", limitedUntil: undefined },
      limited: false,
      inFlight: 2,
      status: "ok",
      reason: undefined,
      readAt: "2026-10-14T21:00:00Z",
      org: "Acme",
    });
    expect(s[1]).toMatchObject({ usage5h: undefined, status: "unknown", reason: "usage endpoint HTTP 429", limited: false });
    const limited = mapSeats({ seats: { s: { maxed_until: "2026-10-15T00:00:00Z", usage: {} } } }, new Date("2026-10-14T21:20:00Z"))[0];
    expect(limited).toMatchObject({ limited: true, status: "limited", resetsAt: { limitedUntil: "2026-10-15T00:00:00Z" } });
  });
});

describe("threads", () => {
  it("sorts active threads first, then newest", () => {
    const t = (id: string, status: string, updatedAt: string) => ({ id, title: id, project: "p", status, updatedAt });
    expect(sortThreads([t("a", "completed", "2026-10-14T10:00Z"), t("b", "running", "2026-10-14T09:00Z"), t("c", "idle", "2026-10-14T11:00Z")]).map((x) => x.id)).toEqual(["b", "c", "a"]);
  });

  it("speaks MCP to T3 (initialize, session header, SSE replies) and lists threads per project", async () => {
    const tokenFile = path.join(fx.root, "tok");
    fs.writeFileSync(tokenFile, "secret-token\n");
    const seen: { auth?: string; sid?: string; method: string; name?: string; args?: any }[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const msg = JSON.parse(body);
        seen.push({ auth: req.headers.authorization, sid: req.headers["mcp-session-id"] as string, method: msg.method, name: msg.params?.name, args: msg.params?.arguments });
        if (msg.method === "initialize") {
          res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "S1" });
          return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
        }
        if (msg.method === "notifications/initialized") return res.writeHead(202).end();
        const structured =
          msg.params.name === "t3_project_list"
            ? { projects: [{ id: "p1", title: "ops", workspaceRoot: "/r/ops", deletedAt: null }, { id: "p0", title: "gone", deletedAt: "x" }] }
            : { threads: [{ threadId: "t1", title: "E5 wake", status: "completed", updatedAt: "2026-10-14T20:00:00Z", providerInstanceId: "claudeAgent_seat2", parentThreadId: null, model: "m" }] };
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { structuredContent: structured } })}\n\n`);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    try {
      const threads = await t3ThreadLister({ url, tokenFile })();
      expect(threads).toEqual([
        { id: "t1", title: "E5 wake", project: "ops", workspaceRoot: "/r/ops", status: "completed", updatedAt: "2026-10-14T20:00:00Z", parentThreadId: undefined, seat: "seat2", model: "m" },
      ]);
      expect(seen.map((s) => s.name ?? s.method)).toEqual(["initialize", "notifications/initialized", "t3_project_list", "t3_thread_list"]);
      expect(seen.every((s) => s.auth === "Bearer secret-token")).toBe(true);
      expect(seen.slice(1).every((s) => s.sid === "S1")).toBe(true);
      expect(seen[3].args).toEqual({ projectId: "p1", settled: false, limit: 100 });
    } finally {
      server.close();
    }
  });

  it("surfaces T3 tool errors", async () => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const msg = JSON.parse(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: msg.method === "tools/call" ? { isError: true, content: [{ type: "text", text: "nope" }] } : {} }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const tokenFile = path.join(fx.root, "tok");
    fs.writeFileSync(tokenFile, "t");
    try {
      const mcp = createMcpClient({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, tokenFile });
      await expect(mcp.call("t3_project_list", {})).rejects.toThrow(/nope/);
    } finally {
      server.close();
    }
  });
});

describe("read routes", () => {
  let db: DB;
  let dbDir: string;
  let threads: () => Promise<Thread[]>;
  let issues: (slug: string) => Promise<any[]>;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "console-read-db-"));
    db = openDb(path.join(dbDir, "c.db"));
    threads = async () => [];
    issues = async () => [];
    const cfg: ReadConfig = {
      reposRoot: fx.root,
      seatsFile: path.join(fx.root, "seats.json"),
      listThreads: () => threads(),
      listIssues: (s) => issues(s),
    };
    app = createApp(db, { read: cfg });
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined, headers: res.headers };
  };
  const milestone = async (repo: string, p: string) =>
    (await call("POST", "/api/milestones", { title: p, repo, path: p, owner: "Sam" })).json;

  it("GET /api/repos and /api/repos/:name/docs", async () => {
    const repos = await call("GET", "/api/repos");
    expect(repos.status).toBe(200);
    expect(repos.json.map((r: any) => r.name)).toEqual(["home_repo", "ops", "plain"]);
    const docs = await call("GET", "/api/repos/ops/docs");
    expect(docs.json.map((d: any) => d.path)).toContain("tickets/E905-fleet-observatory.md");
    expect((await call("GET", "/api/repos/home_repo-wt-m2-3/docs")).status).toBe(404);
    expect((await call("GET", "/api/repos/nope/docs")).json.error.code).toBe("not_found");
  });

  it("milestones carry status / DoD / excerpt read from the file", async () => {
    const e5 = await milestone("Acme/ops", "tickets/E905-fleet-observatory.md");
    expect(e5).toMatchObject({ status: "active", dod: { done: 0, total: 7 } });
    expect(e5.stateExcerpt).toMatch(/^One page Sam/);
    const epic = await milestone("ops", "docs/EPIC-900-VPS-FLEET.md");
    expect(epic).toMatchObject({ status: "active", waitingOn: "Sam decisions for P1b, P2, P4 (P0 done).", dod: { done: 1, total: 2 } });
    expect(epic.blockedReason).toBeUndefined();
    expect((await call("PATCH", `/api/milestones/${epic.id}`, { paused: true })).json.status).toBe("paused");
    const listed = (await call("GET", "/api/milestones")).json;
    expect(listed.map((m: any) => m.status)).toEqual(["active", "paused"]);
  });

  it("GET /api/milestones/:id/backlog", async () => {
    const epic = await milestone("ops", "docs/EPIC-900-VPS-FLEET.md");
    const b = await call("GET", `/api/milestones/${epic.id}/backlog`);
    expect(b.json.map((t: any) => `${t.id}:${t.status}`)).toEqual(["E1:done", "E5:active"]);
    expect((await call("GET", "/api/milestones/ms_x/backlog")).status).toBe(404);
  });

  it("GET /api/tickets: open ticket files + GitHub issues, tolerating gh failure per repo", async () => {
    const e5 = await milestone("Acme/ops", "tickets/E905-fleet-observatory.md");
    await milestone("home_repo", "docs/spines/root.md");
    issues = async (slug) => {
      if (slug === "Acme/home_repo") throw new Error("gh: not authenticated");
      return [{ id: "#41", title: "502 after restart", repo: slug, status: "open", source: "github", url: "https://github.com/Acme/ops/issues/41" }];
    };
    const r = await call("GET", "/api/tickets");
    expect(r.status).toBe(200);
    expect(r.json.map((t: any) => `${t.repo} ${t.id} ${t.source} ${t.milestoneId === e5.id ? "E5" : "-"}`)).toEqual([
      "Acme/ops #41 github E5",
      "Acme/ops E5 tickets-dir E5",
      "Acme/ops VH-T10 tickets-dir -",
    ]);
    expect(r.headers.get("x-console-warnings")).toMatch(/home_repo: gh: not authenticated/);
  });

  it("GET /api/threads maps project/worktree to milestones; 503 when T3 fails", async () => {
    const e5 = await milestone("ops", "tickets/E905-fleet-observatory.md");
    const epic = await milestone("ops", "docs/EPIC-900-VPS-FLEET.md");
    const root = await milestone("home_repo", "docs/spines/root.md");
    threads = async () => [
      { id: "a", title: "E5 - ux health", project: "ops", workspaceRoot: path.join(fx.root, "ops"), status: "running", updatedAt: "2026-10-14T20:00:00Z" },
      { id: "b", title: "EPIC-900 refresh", project: "ops", workspaceRoot: path.join(fx.root, "ops"), status: "idle", updatedAt: "2026-10-14T19:00:00Z" },
      { id: "c", title: "cleanup", project: "ops", workspaceRoot: path.join(fx.root, "ops"), status: "idle", updatedAt: "2026-10-14T18:00:00Z" },
      { id: "d", title: "M2-3 worker", project: "home_repo", workspaceRoot: path.join(fx.root, "home_repo-wt-m2-3"), status: "idle", updatedAt: "2026-10-14T17:00:00Z" },
      { id: "e", title: "other", project: "other", workspaceRoot: "/elsewhere/other", status: "idle", updatedAt: "2026-10-14T16:00:00Z" },
    ];
    const r = await call("GET", "/api/threads");
    expect(r.json.map((t: any) => [t.id, t.milestoneId])).toEqual([
      ["a", e5.id],
      ["b", epic.id],
      ["c", undefined],
      ["d", root.id],
      ["e", undefined],
    ]);

    // a fresh app (no cache) whose T3 call fails → 503 JSON
    const failing = createApp(db, { read: { reposRoot: fx.root, seatsFile: "/nope", listThreads: async () => { throw new Error("connect ECONNREFUSED"); } } });
    const res = await failing.request("/api/threads");
    expect(res.status).toBe(503);
    expect((await res.json()).error).toEqual({ code: "t3_unavailable", message: "T3 threads unavailable: connect ECONNREFUSED" });
  });

  it("GET /api/seats reads seats.json; 503 when unreadable", async () => {
    const r = await call("GET", "/api/seats");
    expect(r.json.map((s: any) => [s.id, s.usage5h ?? null, s.status])).toEqual([
      ["seat1", 4, "ok"],
      ["seat2", null, "unknown"],
    ]);
    fs.rmSync(path.join(fx.root, "seats.json"));
    expect((await call("GET", "/api/seats")).status).toBe(503);
  });
});
