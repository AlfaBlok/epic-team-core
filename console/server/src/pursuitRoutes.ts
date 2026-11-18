import type { Hono } from "hono";
import type { SpineWriter } from "./inbox/spineWrite.js";
import { repoKey } from "./adapters/repoNames.js";
import { credentialWorld } from "./auth/identity.js";
import { DEFAULT_TENANT } from "./db.js";
import type { Cadence } from "./schemas.js";
import type { Milestone, Store } from "./store.js";
import { PURSUITS_FILE, activeText, doneText, parkText, reorderText, scaleCadence, type PursuitsBody } from "./pursuits.js";

/**
 * The navigable scorecard's links and the owner's two switches:
 * - `withMilestones`: each pursuit's epics with the milestone that runs them and the teams on it (persona, its wake
 *   pace as set and as its rank makes it), so every line of the scorecard drills down to a deck and a milestone;
 * - POST /api/pursuits/order {ids} (his drag or arrows) and POST /api/pursuits/:id/park {parked}: one commit each in
 *   docs/pursuits.json of the code repo, the record (root L-45). The scheduler and the stall watch read the file.
 * - POST /api/pursuits/:id/active {active}: his On/Off switch; off keeps the objective in the file with
 *   `"active": false` and the day, out of Goals to set, the counts, the inbox and the wake prompts, greyed on the screen.
 * - POST /api/pursuits/:id/done {done}: Mark done (true) or undo (false); done keeps it in the file with `"active": false`
 *   and `"doneOn"`, out of every list like an inactive one, shown under Done.
 */

export interface PursuitTeam {
  persona: string;
  enabled: boolean;
  /** auto-parked by the wake gate (nothing to do): it wakes again by itself, so it still turns the wheel . */
  parked?: boolean;
  /** the pace as set ("every 60 min") and, when the rank changes it, as it runs now ("every 30 min"); parked: none. */
  pace: string;
  paceNow: string;
}
export interface PursuitMilestone {
  id: string;
  title: string;
  /** own: the epic is this milestone's spine; root: the epic sits under the repo's root milestone. */
  via: "own" | "root";
  teams: PursuitTeam[];
}

const plain = (p: string) => p.replace(/^\.\//, "");
const sameRepo = (a: string, b: string) => repoKey(a.split("/").pop()!) === repoKey(b.split("/").pop()!);
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function paceWords(c: Cadence): string {
  if (c.type === "interval") return c.everyMinutes % 60 === 0 && c.everyMinutes >= 120 ? `every ${c.everyMinutes / 60} h` : `every ${c.everyMinutes} min`;
  return `at ${c.timeOfDay} ${c.weekdays.length === 7 ? "daily" : `on ${c.weekdays.map((d) => DAYS[d]).join(", ")}`}`;
}

/** The milestone that runs an epic: its own spine's milestone, else the repo's root milestone. */
export function milestoneOfEpic(milestones: Milestone[], repo: string, path: string): { m: Milestone; via: "own" | "root" } | null {
  const same = milestones.filter((m) => !m.paused && sameRepo(m.repo, repo));
  const own = same.find((m) => plain(m.path) === plain(path));
  if (own) return { m: own, via: "own" };
  const root = same.find((m) => /(^|\/)root\.md$/.test(m.path)) ?? same.find((m) => !m.path.includes("/")) ?? (same.length === 1 ? same[0] : undefined);
  return root ? { m: root, via: "root" } : null;
}

export function withMilestones(
  body: PursuitsBody,
  store: Pick<Store, "listMilestones" | "listAssignments" | "getPersona">,
  effortOf?: (m: Milestone) => { parked: boolean; wakeFactor: number; minWakeMinutes?: number } | null,
): PursuitsBody & { pursuits: (PursuitsBody["pursuits"][number] & { milestones: PursuitMilestone[] })[]; retiredMilestones?: string[] } {
  const all = store.listMilestones().filter((m) => !m.settledAt);
  // a retired milestone is the one whose own spine the file names (never a repo's root fallback).
  const retiredMilestones = (body.retired ?? []).flatMap((r) => {
    const m = store.listMilestones().find((x) => !x.settledAt && sameRepo(x.repo, r.repo) && plain(x.path) === plain(r.path));
    return m ? [m.id] : [];
  });
  return {
    ...body,
    ...(retiredMilestones.length ? { retiredMilestones } : {}),
    pursuits: body.pursuits.map((p) => {
      const seen = new Map<string, PursuitMilestone>();
      const epics = p.epics.map((e) => {
        const hit = milestoneOfEpic(all, e.repo, e.path);
        if (!hit) return e;
        if (!seen.has(hit.m.id)) {
          const eff = effortOf?.(hit.m) ?? null;
          const teams = store
            .listAssignments({ milestoneId: hit.m.id })
            .map((a): PursuitTeam | null => {
              const persona = store.getPersona(a.personaId)?.name;
              if (!persona) return null;
              const pace = paceWords(a.cadence);
              const paceNow = !a.enabled ? "off" : eff?.parked ? "no wakes (parked)" : paceWords(scaleCadence(a.cadence, eff, eff?.minWakeMinutes));
              return { persona, enabled: a.enabled, ...(a.parkedAt && a.parkedReason !== "settled" ? { parked: true } : {}), pace, paceNow };
            })
            .filter((t): t is PursuitTeam => !!t)
            .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.persona.localeCompare(b.persona));
          seen.set(hit.m.id, { id: hit.m.id, title: hit.m.title, via: hit.via, teams });
        }
        return { ...e, milestoneId: hit.m.id };
      });
      return { ...p, epics, milestones: [...seen.values()] };
    }),
  };
}

export function mountPursuitWrites(api: Hono, o: { writer?: SpineWriter; repo: () => string | undefined; who: () => string; wrote?: (dir: string) => void }): void {
  const write = async (label: string, edit: (text: string) => string | null, msg: string, why: string) => {
    const dir = o.repo();
    if (!dir || !o.writer) return { status: 503, body: { error: { code: "no_spine_writer", message: "the console cannot write the repo here; nothing saved" } } };
    let bad = false;
    const by = o.who();
    const w = await o.writer.edit({
      repoDir: dir,
      path: PURSUITS_FILE,
      label,
      verify: false,
      fetchFreshMs: 30_000,
      edit: (text) => {
        let out: string | null;
        try {
          out = edit(text);
        } catch {
          out = null;
        }
        if (out === null) {
          bad = true;
          return { skip: "not a change of this file" };
        }
        return out === text ? { skip: "already saved" } : { text: out, msg: `${by}: ${msg}`, body: `${by} ${why} on the console's Pursuits page. Effort follows the order: the scheduler, the worker ceiling and the stall watch read this file.` };
      },
    });
    if (bad) return { status: 400, body: { error: { code: "bad_change", message: "that does not match the pursuits in the file; reload and try again" } } };
    if (w.status === "skipped" && w.reason === "already saved") return { status: 200, body: { ok: true } };
    if (w.status !== "written") return { status: w.status === "skipped" ? 409 : 502, body: { error: { code: w.status === "skipped" ? "write_skipped" : "write_failed", message: `not saved: ${w.reason ?? "unknown"}` } } };
    o.wrote?.(dir);
    return { status: 200, body: { ok: true, ...(w.sha ? { sha: w.sha } : {}) } };
  };
  const homeOnly = () => {
    const world = credentialWorld();
    return !world || world === DEFAULT_TENANT;
  };

  api.post("/pursuits/order", async (c) => {
    if (!homeOnly()) return c.json({ error: { code: "not_found", message: "no pursuits here" } }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown };
    const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string" && /^[\w-]{1,80}$/.test(x)) : [];
    if (!ids.length || ids.length !== (body.ids as unknown[]).length) return c.json({ error: { code: "bad_ids", message: "ids is the list of every pursuit id in the new order" } }, 400);
    const r = await write("pursuits order", (t) => reorderText(t, ids), `pursuits in order ${ids.join(", ")}`, `put the pursuits in the order ${ids.join(", ")}`);
    return c.json(r.body, r.status as 200);
  });

  api.post("/pursuits/:id/active", async (c) => {
    if (!homeOnly()) return c.json({ error: { code: "not_found", message: "no pursuits here" } }, 404);
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as { active?: unknown };
    if (!/^[\w-]{1,80}$/.test(id) || typeof body.active !== "boolean") return c.json({ error: { code: "bad_active", message: "active is true or false" } }, 400);
    const active = body.active;
    const day = new Date().toISOString().slice(0, 10);
    const r = await write(`objective ${id}`, (t) => activeText(t, id, active, day), `${active ? "switch on" : "switch off"} objective ${id}`, active ? `switched the objective ${id} back on` : `switched the objective ${id} off (inactive since ${day})`);
    return c.json(r.body, r.status as 200);
  });

  api.post("/pursuits/:id/done", async (c) => {
    if (!homeOnly()) return c.json({ error: { code: "not_found", message: "no pursuits here" } }, 404);
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as { done?: unknown };
    if (!/^[\w-]{1,80}$/.test(id) || typeof body.done !== "boolean") return c.json({ error: { code: "bad_done", message: "done is true or false" } }, 400);
    const done = body.done;
    const day = new Date().toISOString().slice(0, 10);
    const r = await write(`objective ${id}`, (t) => doneText(t, id, done, day), `${done ? "mark done" : "undo done"} objective ${id}`, done ? `marked the objective ${id} done (${day})` : `undid done on the objective ${id}: live again`);
    return c.json(r.body, r.status as 200);
  });

  api.post("/pursuits/:id/park", async (c) => {
    if (!homeOnly()) return c.json({ error: { code: "not_found", message: "no pursuits here" } }, 404);
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as { parked?: unknown };
    if (!/^[\w-]{1,80}$/.test(id) || typeof body.parked !== "boolean") return c.json({ error: { code: "bad_park", message: "parked is true or false" } }, 400);
    const parked = body.parked;
    const r = await write(`pursuit ${id}`, (t) => parkText(t, id, parked), `${parked ? "park" : "resume"} pursuit ${id}`, parked ? `parked the pursuit ${id} (no wakes, no workers)` : `resumed the pursuit ${id}`);
    return c.json(r.body, r.status as 200);
  });
}
