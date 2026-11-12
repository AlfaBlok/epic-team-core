import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { SpinesJson } from "../src/adapters/spines.js";
import { CAPABILITIES_FILE, buildRepoBook, readCapabilities } from "../src/book/build.js";

/** the services x capabilities table in the Epic Book, generated from the repo's data file. */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

const TABLE = {
  title: "What the team can do, per service",
  about: "tested live",
  checkedAt: "2026-11-01T15:13:29Z",
  states: { works: "works" },
  scope: "any seat",
  egressLegend: { laptop: "Sam's Mac" },
  plainStatus: [
    { world: "Your account", platform: "Reddit", word: "partly", text: "only while your Mac is online" },
    { world: "Your account", platform: "X", word: "maybe", text: "dropped: not a plain word" },
  ],
  other: [{ id: "memo", label: "Memo", what: "memory", egress: { kind: "server", label: "server-side" } }, { id: "bad", label: "no egress" }],
  capabilities: [{ id: "read", label: "Read" }],
  services: [
    {
      id: "x",
      label: "X",
      account: "@MemoAgent",
      egress: { kind: "laptop", label: "Sam's Mac (laptop egress)", offline: "refused", tester: "direct", secret: "dropped" },
      cells: {
        read: { state: "works", summary: "reads", egressSeen: "laptop (MX 189.128.x.x)", tested: "2026-11-01T15:12:44Z", test: "x_home_feed (read)", probe: { tool: "x_home_feed", kind: "read", args: {} }, realFrom: { site: "x", action: "x_reply" }, plain: { word: "partly", text: "needs your Mac" } },
        reply: { state: "works", summary: "replies", tested: "2026-11-01T15:12:44Z", test: "dry run", plain: { word: "sort of", text: "dropped" } },
      },
    },
  ],
};

const withRepo = (files: Record<string, string>, fn: (dir: string) => void) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e29s4-"));
  try {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

describe("T29-S4 capability table", () => {
  it("reads the repo's data file into its Book entry, without the probe specs", () => {
    withRepo({ [CAPABILITIES_FILE]: JSON.stringify(TABLE) }, (dir) => {
      const spines: SpinesJson = { root: "docs/spines/root.md", nodes: [] } as unknown as SpinesJson;
      const r = buildRepoBook({ name: "home_repo", path: dir, remote: "Acme/home_repo" }, spines, []);
      expect(r.capabilities).toMatchObject({
        title: TABLE.title,
        checkedAt: "2026-11-01T15:13:29Z",
        capabilities: [{ id: "read", label: "Read" }],
        source: CAPABILITIES_FILE,
        href: `https://github.com/Acme/home_repo/blob/main/${CAPABILITIES_FILE}`,
      });
      expect(r.capabilities!.services[0].cells.read).toEqual({
        state: "works",
        summary: "reads",
        tested: "2026-11-01T15:12:44Z",
        test: "x_home_feed (read)",
        egressSeen: "laptop (MX 189.128.x.x)",
        plain: { word: "partly", text: "needs your Mac" },
      });
      expect(r.capabilities!.services[0].cells.reply.plain).toBeUndefined(); // an unknown word is dropped, the chip falls back to the probe state
      expect(r.capabilities!.plainStatus).toEqual([{ world: "Your account", platform: "Reddit", word: "partly", text: "only while your Mac is online" }]);
      expect(r.capabilities!.services[0].egress).toEqual({ kind: "laptop", label: "Sam's Mac (laptop egress)", offline: "refused", tester: "direct" });
      expect(r.capabilities).toMatchObject({ scope: "any seat", egressLegend: { laptop: "Sam's Mac" } });
      expect(r.capabilities!.other).toEqual([{ id: "memo", label: "Memo", what: "memory", egress: { kind: "server", label: "server-side" } }]);
    });
  });

  it("leaves a repo without the file, or with a broken one, as it was", () => {
    withRepo({}, (dir) => expect(readCapabilities(dir)).toBeUndefined());
    withRepo({ [CAPABILITIES_FILE]: "{ not json" }, (dir) => expect(readCapabilities(dir)).toBeUndefined());
    withRepo({ [CAPABILITIES_FILE]: JSON.stringify({ services: [] }) }, (dir) => expect(readCapabilities(dir)).toBeUndefined());
  });

  it("home_repo's own table: every cell is dated, every gap and stale cell says why and what fixes it, every n/a says why", () => {
    const t = readCapabilities(REPO)!;
    expect(t).toBeDefined();
    expect(t.capabilities.map((c) => c.id)).toEqual(["read", "post", "reply", "read_dms", "answer_dms"]);
    expect(t.services.map((s) => s.id)).toEqual(expect.arrayContaining(["reddit", "x", "email", "airbnb", "tiktok", "instagram", "linkedin", "youtube"]));
    expect(t.scope).toBeTruthy();
    for (const s of t.services) {
      // rework (the owner 2026-11-02): every service names its egress (a legend kind) and what happens when it is offline.
      expect(s.egress, `${s.id} egress`).toBeDefined();
      expect(Object.keys(t.egressLegend ?? {}), `${s.id} egress kind`).toContain(s.egress!.kind);
      expect(s.egress!.offline, `${s.id} offline`).toBeTruthy();
      for (const c of t.capabilities) {
        const cell = s.cells[c.id];
        expect(cell, `${s.id}.${c.id}`).toBeDefined();
        expect(["works", "stale", "gap", "n/a"], `${s.id}.${c.id}`).toContain(cell.state);
        expect(Number.isNaN(Date.parse(cell.tested)), `${s.id}.${c.id} tested`).toBe(false);
        expect(cell.test, `${s.id}.${c.id} test`).toBeTruthy();
        if (cell.state === "gap" || cell.state === "stale") {
          expect(cell.why, `${s.id}.${c.id} why`).toBeTruthy();
          expect(cell.fix, `${s.id}.${c.id} fix`).toBeTruthy();
        }
        if (cell.state === "n/a") expect(cell.summary, `${s.id}.${c.id} n/a reason`).toBeTruthy();
        // every cell carries its plain word and its reason/fix in plain words.
        expect(cell.plain, `${s.id}.${c.id} plain`).toBeDefined();
        expect(cell.plain!.text.length, `${s.id}.${c.id} plain text`).toBeGreaterThan(10);
        if (cell.plain!.word !== "works" && cell.plain!.word !== "n/a") expect(cell.plain!.text, `${s.id}.${c.id} plain says what fixes it`).toMatch(/need|until|once|approve|not built|no listing/i);
      }
    }
    // the plain status block names each platform per world, and Reddit for testers is Not yet.
    expect(t.plainStatus!.length).toBeGreaterThanOrEqual(7);
    expect(t.plainStatus!.find((l) => l.world.startsWith("Tester") && l.platform === "Reddit")?.word).toBe("not yet");
    for (const o of t.other ?? []) expect(Object.keys(t.egressLegend ?? {}), `${o.id} egress kind`).toContain(o.egress.kind);
  });
});
