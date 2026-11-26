import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { mountTreeAdd, treeAddsBusy, type Held } from "../src/status/add.js";
import type { SpineWriter } from "../src/inbox/spineWrite.js";

/**
 * His 25 Nov 11:55Z voice notes became rows only at 12:24 to 12:30Z. One Add takes 20 to 120 s (the filing
 * match and its judges) while a restart drains requests for 25 s, and 9 releases restarted the console in that half
 * hour, cutting Adds that the desk then filed again. The console counts the Adds in flight (`filing.busy` on
 * /api/health) so deploy.sh waits for them before it restarts.
 */
const SPINE = `# EPIC-909: Demo

## Issue Ledger

| Issue | Role | Owner / Assignment | Title | Status | Depends On | PR/Branch | Base | Latest Evidence | Last Verified | Next Action |
|---|---|---|---|---|---|---|---|---|---|---|
| E909-S1 | Ticket worker | worker | Something else | done (approved by Sam 2026-11-22) | none | none | main | none | 2026-11-22 | none |

## Decisions

| Date | Outcome | Decision / Attempt | Durable Summary | Evidence | Revisit When |
|---|---|---|---|---|---|
| 2026-10-20 | accepted | x | y | z | never |
`;
const SAID = "make the voice note a row within ten minutes";

describe("the Adds being filed are counted for the deploy's wait", () => {
  it("counts an Add while its filing match runs and drops it when it answers, also on an error", async () => {
    let text = SPINE;
    let release: (h: Held) => void = () => undefined;
    const spine = {
      edit: async (i: { edit: (t: string, d: string) => { text: string } | { skip: string } }) => {
        const out = i.edit(text, "2026-11-26");
        if ("skip" in out) return { status: "skipped" as const, reason: out.skip };
        text = out.text;
        return { status: "written" as const, sha: "abc1234" };
      },
    } as unknown as SpineWriter;
    const m = { id: "ms_1", title: "Demo", repo: "demo", path: "docs/spines/epic.md", owner: "", paused: false } as never;
    const api = new Hono();
    mountTreeAdd(api, {
      store: { getMilestone: (id: string) => (id === "ms_1" ? m : undefined) } as never,
      spine,
      locate: async () => ({ repoDir: "/r", rel: "docs/spines/epic.md" }),
      treePaths: async () => new Set(),
      invalidate: () => undefined,
      deskAsk: async (chat) => (SAID.includes(chat) ? { text: SAID, at: "2026-11-26T10:00:00Z" } : "not his"),
      wakeWaitMs: 10,
      held: () => new Promise<Held>((r) => (release = r)),
    });
    const post = (id: string) =>
      api.request(`/milestones/${id}/tree/add`, { method: "POST", headers: { "content-type": "application/json", "x-console-run": "team-desk" }, body: JSON.stringify({ kind: "row", title: "Voice note to row fast", chat: SAID }) });

    expect(treeAddsBusy()).toBe(0);
    const pending = post("ms_1");
    await new Promise((r) => setTimeout(r, 20));
    expect(treeAddsBusy()).toBe(1);
    release({ held: null, after: null, top: [], why: "no ticket is close" });
    const r = await (await pending).json();
    expect(r).toMatchObject({ id: "E909-S2", ready: true });
    expect(treeAddsBusy()).toBe(0);

    expect((await post("ms_missing")).status).toBe(404);
    expect(treeAddsBusy()).toBe(0);
  });
});
