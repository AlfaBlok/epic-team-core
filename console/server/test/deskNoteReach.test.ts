import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { managerState } from "../src/inbox/asks.js";
import { mountDeskInbox, noteReach } from "../src/desk/inbox.js";
import type { Store } from "../src/store.js";
import { SEED_VERSION, endpointLines } from "../src/desk/desk.js";

/**
 * (the owner, 22 Nov 02:23Z: "I asked you a question about Adeje ... You ignored it, right?"; the desk: "It
 * wasn't ignored"; at 04:48Z: "You were right ... Your Travel team's Delivery Manager is switched off, so both notes ...
 * sat unread"). Before the desk says where his words went, it asks who reads a note sent to that repo; a team whose
 * manager is off is said at once.
 */
type A = { id: string; milestoneId: string; personaId: string; enabled: boolean; parkedAt?: string | null; parkedReason?: string | null };
type M = { id: string; title: string; repo: string; path: string; paused: boolean; settledAt?: string };
const personas: Record<string, { name: string }> = { pe_dm: { name: "Delivery Manager" }, pe_w: { name: "Ticket worker" } };
function fake(ms: M[], as: A[]) {
  return {
    listMilestones: () => ms,
    listAssignments: (q: { milestoneId: string }) => as.filter((a) => a.milestoneId === q.milestoneId),
    getPersona: (id: string) => personas[id],
  } as unknown as Store;
}
const resolve = (repo: string) => {
  const name = repo.replace(/^.*\//, "");
  return ["trips", "home-repo", "home", "quiet"].includes(name) ? { path: `/r/${name === "home" ? "home-repo" : name}`, name: name === "home" ? "home-repo" : name } : undefined;
};
const travel: M = { id: "ms_travel", title: "Travel", repo: "acme/trips", path: "docs/travel/TRAVEL_SPINE.md", paused: false };
const teamRoot: M = { id: "ms_root", title: "home-repo", repo: "acme/home", path: "docs/spines/root.md", paused: false };
const teamEpic: M = { id: "ms_epic", title: "Social launch", repo: "acme/home", path: "docs/spines/epic-46.md", paused: false };

describe("who reads a desk note", () => {
  it("managerState: on, parked, off, none", () => {
    const s = (as: A[]) => managerState(fake([travel], as), "ms_travel");
    expect(s([{ id: "a", milestoneId: "ms_travel", personaId: "pe_dm", enabled: true }])).toBe("on");
    expect(s([{ id: "a", milestoneId: "ms_travel", personaId: "pe_dm", enabled: false, parkedAt: "2026-11-01", parkedReason: "all green" }])).toBe("parked");
    expect(s([{ id: "a", milestoneId: "ms_travel", personaId: "pe_dm", enabled: false, parkedAt: "2026-11-01", parkedReason: "settled" }])).toBe("off");
    expect(s([{ id: "a", milestoneId: "ms_travel", personaId: "pe_dm", enabled: false }])).toBe("off");
    // a worker that is on is not the manager
    expect(s([{ id: "w", milestoneId: "ms_travel", personaId: "pe_w", enabled: true }])).toBe("none");
  });

  it("the Adeje case: the Travel manager is off, so the note is not read and the desk says so", () => {
    const r = noteReach({ store: fake([travel], [{ id: "a", milestoneId: "ms_travel", personaId: "pe_dm", enabled: false }]), resolve }, "trips")!;
    expect(r).toMatchObject({ repo: "trips", manager: "off", reads: false, urgentWakes: false, goal: { id: "ms_travel", title: "Travel" } });
    expect(r.say).toBe("Travel's Delivery Manager is switched off, so nobody reads this note until it is switched on.");
  });

  it("picks the repo's home goal (its root spine) as the urgent sweep does, by owner/name too", () => {
    const store = fake([teamEpic, teamRoot], [
      { id: "e", milestoneId: "ms_epic", personaId: "pe_dm", enabled: true },
      { id: "r", milestoneId: "ms_root", personaId: "pe_dm", enabled: false },
    ]);
    const r = noteReach({ store, resolve }, "acme/home")!;
    expect(r.goal?.id).toBe("ms_root");
    expect(r.reads).toBe(false);
    const on = noteReach({ store: fake([teamRoot], [{ id: "r", milestoneId: "ms_root", personaId: "pe_dm", enabled: true }]), resolve }, "home-repo")!;
    expect(on).toMatchObject({ manager: "on", reads: true, urgentWakes: true });
  });

  it("all goals paused, no goal, unknown repo", () => {
    const paused = noteReach({ store: fake([{ ...travel, paused: true }], []), resolve }, "trips")!;
    expect(paused).toMatchObject({ manager: "paused", reads: false });
    expect(noteReach({ store: fake([], []), resolve }, "quiet")).toMatchObject({ manager: "no goal", reads: false });
    expect(noteReach({ store: fake([], []), resolve }, "nowhere")).toBeUndefined();
  });

  it("GET /api/desk/inbox/reach answers it", async () => {
    const api = new Hono();
    mountDeskInbox(api, { store: fake([travel], [{ id: "a", milestoneId: "ms_travel", personaId: "pe_dm", enabled: false }]), resolve });
    const ok = await api.request("/desk/inbox/reach?repo=trips");
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { reads: boolean }).reads).toBe(false);
    expect((await api.request("/desk/inbox/reach")).status).toBe(400);
    expect((await api.request("/desk/inbox/reach?repo=nowhere")).status).toBe(404);
  });

  it("the desk's remit: every claim names its check, and NOT READ is said at once", () => {
    const lines = endpointLines("http://console");
    const claim = lines.find((l) => l.startsWith("- Name the check behind each claim"));
    expect(claim).toMatch(/It wasn't ignored/);
    expect(claim).toMatch(/desk_reply_check\.py --text/);
    const notes = lines.find((l) => l.startsWith("- Notes between worlds"));
    expect(notes).toMatch(/NOT READ: <why>/);
    expect(notes).toMatch(/at once/);
    expect(SEED_VERSION).toBeGreaterThanOrEqual(55);
  });
});
