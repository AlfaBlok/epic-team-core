import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseDoc } from "../src/adapters/doc.js";
import { codeOf, deriveLabel, LABEL_MAX_WORDS } from "../src/adapters/label.js";
import type { SpinesJson } from "../src/adapters/spines.js";
import { buildTree, type TreeNode } from "../src/adapters/tree.js";

/** tree rows read `<code> <label>`: a spine's `Label:` line, else a short phrase derived from the title. */
describe("E935-S1 label rule", () => {
  it.each([
    ["EPIC-921: Multi-tenant home_repo: one console, many worlds", "EPIC-921", "Multi-tenant home_repo"],
    ["EPIC: M2 — Team console (milestones, personas)", "M2", "Team console"],
    ["EPIC: home_repo", "root", "home_repo"],
    ["[social] EPIC-903: Weekly report — credits", "EPIC-903", "Weekly report"],
    ["Console tree: fold below level 1 by default", "E935-S1", "Console tree"],
    ["Tree at a glance: folded, short code + plain label", undefined, "Tree at a glance"],
    ["M2 team console + persona cycle (milestone)", "M2", "team console + persona cycle"],
    ["Retry transient socket errors; then soak", "E906-S1", "Retry transient socket errors"],
    ["TikTok: sign up, switch to Business, link the shop", "E932-S1", "TikTok: sign up"],
    ["Reddit MCP tools on the Team Browser service", "M3-3", "Reddit MCP tools on the Team…"],
    ["Answer an ask from chat via the desk", "E918-S4", "Answer an ask from chat…"],
    ["E934-S5 Console reads the pack export as one source", "E934-S5", "Console reads the pack export…"],
    ["**Status contract**", "E913-S1", "Status contract"],
    ["Hosts view", "E6-S12b", "Hosts view"],
  ])("%s → %s", (title, id, want) => {
    expect(deriveLabel(title, id)).toBe(want);
  });

  it("code: a spine shows its title's EPIC-n / M5 (its id is the long Spine ID slug), root for the repo root; rows their id", () => {
    expect(codeOf({ kind: "spine", id: "memo-live-memo-heard-agent-team-for-sale", title: "EPIC-912: Memo live, Memo heard" })).toBe("EPIC-912");
    expect(codeOf({ kind: "spine", id: "agent-team-m5-unblocked-web", title: "EPIC: M5 — Unblocked web access" })).toBe("M5");
    expect(codeOf({ kind: "spine", id: "x", title: "[social] EPIC-903: Weekly report" })).toBe("EPIC-903");
    expect(codeOf({ kind: "spine", id: "agent-team-root", title: "EPIC: home_repo" }, true)).toBe("root");
    expect(codeOf({ kind: "spine", id: "some-slug", title: "Plain title" })).toBe("some-slug");
    expect(codeOf({ kind: "ticket", id: "E934-S5", title: "EPIC-909: x" })).toBe("E934-S5");
  });

  it("a one-word head is not a label: the separator is skipped", () => {
    expect(deriveLabel("Memo: live, heard", "EPIC-912")).toBe("Memo: live, heard");
  });

  it("Label: line in Current State or the header is read, inline markup stripped", () => {
    expect(parseDoc("# EPIC-909: Long\n\nSpine ID: x\nLabel: **Short** one\n\n## Goal\n\nx\n").label).toBe("Short one");
    expect(parseDoc("# EPIC-909: Long\n\n## Current State\n\nLabel: From state\nStatus: active\n").label).toBe("From state");
    expect(parseDoc("# EPIC-909: Long\n\n## Goal\n\nLabel: prose, not a header\n").label).toBeUndefined();
  });

  it("every live home_repo spine title and ledger row derives a short, prefix-free label", () => {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../docs/spines");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
    expect(files.length).toBeGreaterThan(10);
    let n = 0;
    for (const f of files) {
      const doc = parseDoc(fs.readFileSync(path.join(dir, f), "utf8"));
      const items: [string, string | undefined][] = [[doc.title ?? f, /(EPIC-\d+|M\d+)/.exec(doc.title ?? "")?.[1]], ...doc.ledger.filter((r) => r.title).map((r) => [r.title, r.id] as [string, string])];
      for (const [title, id] of items) {
        const l = deriveLabel(title, id);
        n++;
        expect(l, title).not.toBe("");
        expect(l.replace(/…$/, "").split(/\s+/).length, title).toBeLessThanOrEqual(LABEL_MAX_WORDS);
        expect(l, title).not.toMatch(/^\[|^EPIC[-:]|^M\d+ —/);
      }
    }
    expect(n).toBeGreaterThan(100);
  });
});

describe("E935-S1 tree nodes carry label", () => {
  let reposRoot: string;
  const write = (rel: string, text: string) => {
    const f = path.join(reposRoot, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  };
  beforeEach(() => {
    reposRoot = fs.mkdtempSync(path.join(os.tmpdir(), "console-e35s1-"));
    write("lab/.git/config", `[remote "origin"]\n\turl = https://github.com/Acme/lab.git\n`);
    write("lab/docs/spines/root.md", "# EPIC: lab\n\nSpine ID: root\n\n## Current State\n\nStatus: active\n\n## Issue Ledger\n\n| Issue | Title | Status |\n|---|---|---|\n| [EPIC-902](kid.md) | Kid | active |\n| R-1 | Ship the thing: with details (and more) | ready |\n");
    write("lab/docs/spines/kid.md", "# EPIC-902: Phase A: the long real name\n\nSpine ID: kid\nLabel: Real name\n\n## Current State\n\nStatus: active\n");
  });
  afterEach(() => fs.rmSync(reposRoot, { recursive: true, force: true }));

  it("spine Label: wins; rows derive from their title", () => {
    const node = (id: string, file: string, title: string, parent: string | null, children: string[] = []) => ({ id, path: `docs/spines/${file}`, title, parent, status: "active", rollup_status: "active", dod: [], children, run_state: "running" });
    const spines = { root: "docs/spines/root.md", nodes: [node("lab-root", "root.md", "EPIC: lab", null, ["docs/spines/kid.md"]), node("kid-long-spine-slug", "kid.md", "EPIC-902: Phase A: the long real name", "docs/spines/root.md")], orphans: [], mismatches: [] } as unknown as SpinesJson;
    const t = buildTree(reposRoot, { id: "ms", repo: "Acme/lab", path: "docs/spines/root.md", paused: false, title: "Lab" }, spines);
    const by = (code: string) => t.root.children.find((c: TreeNode) => c.code === code)!;
    expect(t.root).toMatchObject({ id: "lab-root", code: "root", label: "lab" });
    expect(by("EPIC-902")).toMatchObject({ id: "kid-long-spine-slug", label: "Real name", title: "EPIC-902: Phase A: the long real name" });
    expect(by("R-1").label).toBe("Ship the thing");
  });
});
