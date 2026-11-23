import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_TENANT, type DB } from "../db.js";
import { DEFAULT_WRITE_SCOPE, forTenant, type Assignment, type Store } from "../store.js";
import type { Cadence } from "../schemas.js";
import type { SpineWrite, SpineWriter } from "../inbox/spineWrite.js";
import { RecordError } from "./milestoneRecord.js";
import { ownerName } from "../identity.js";

/**
 * who works on which spine, how often,
 * whether the owner switched it on, what it may write, which services it may use and how many emails it may send a day
 * live in the world's team repo, not in console.db:
 *
 *   state/assignments.json   one entry per assignment: id, milestoneId, personaId, cadence, enabled (the owner's switch),
 *                            writeEnabled, writeScope, createdAt, and `objective` (the docs/pursuits.json id it works:
 *                            several objectives share one milestone, so each objective's Personas tab lists only its
 *                            own).
 *   state/access.json        `mcp`: [{serviceId, personaId, allowed}] (a service switch per persona; an absent pair is
 *                            the service's default), `mailCaps`: [{personaId, dailyCap}].
 *
 * Each change the owner (or a desk acting for him) makes is written first, through the one spine writer; only a written
 * file changes console.db, and a write that does not land changes nothing (RecordError). A write grant from Approve also
 * becomes a `## Standing approvals` line in the spine (inbox/routes.ts). console.db keeps the scheduler's own state
 * (last/next run, retry, auto-park, T3 task): an auto-park is the scheduler's, never the owner's switch, so the file's
 * `enabled` stays his choice and applying the file never wakes a parked assignment. Every team-state pass applies the
 * files to console.db. Same team repo and staging rule as state/milestones.json (milestoneRecord's `dirOf`).
 */
export const ASSIGNMENTS_FILE = "state/assignments.json";
export const ACCESS_FILE = "state/access.json";

export interface AssignmentEntry {
  id: string;
  milestoneId: string;
  personaId: string;
  cadence: Cadence;
  /** the owner's switch (an auto-park leaves it as it was). */
  enabled: boolean;
  writeEnabled: boolean;
  writeScope: string;
  /** the objective it works (docs/pursuits.json id); absent = the milestone's, shown on its objectives when only one has it. */
  objective?: string;
  createdAt: string;
}
export interface AccessFile {
  mcp: { serviceId: string; personaId: string; allowed: boolean }[];
  mailCaps: { personaId: string; dailyCap: number }[];
}

/** The file's view of an assignment: the owner's switch is on while the scheduler has it parked. */
export const assignmentEntryOf = (a: Assignment): AssignmentEntry => ({
  id: a.id,
  milestoneId: a.milestoneId,
  personaId: a.personaId,
  cadence: a.cadence,
  enabled: a.enabled || !!a.parkedAt,
  writeEnabled: a.writeEnabled,
  writeScope: a.writeScope,
  ...(a.objective ? { objective: a.objective } : {}),
  createdAt: a.createdAt,
});

const byCreated = (a: AssignmentEntry, b: AssignmentEntry) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
export const assignmentsText = (list: AssignmentEntry[]) =>
  JSON.stringify({ about: `Who works on which spine for this world, how often, whether ${ownerName()} switched it on and what it may write. The console writes this file before it changes anything and reads it back on every pass.`, assignments: [...list].sort(byCreated) }, null, 2) + "\n";
export const accessText = (a: AccessFile) =>
  JSON.stringify(
    {
      about: "Which services each persona of this world may use (an absent pair is the service's default) and how many emails it may send a day. The console writes this file before it changes anything.",
      mcp: [...a.mcp].sort((x, y) => x.serviceId.localeCompare(y.serviceId) || x.personaId.localeCompare(y.personaId)),
      mailCaps: [...a.mailCaps].sort((x, y) => x.personaId.localeCompare(y.personaId)),
    },
    null,
    2,
  ) + "\n";

export function parseAssignments(text: string): { entries: AssignmentEntry[] } | { error: string } {
  try {
    const v = JSON.parse(text) as { assignments?: unknown };
    if (!Array.isArray(v.assignments)) return { error: "no `assignments` list" };
    const entries: AssignmentEntry[] = [];
    for (const x of v.assignments as Record<string, unknown>[]) {
      if (typeof x?.id !== "string" || typeof x.milestoneId !== "string" || typeof x.personaId !== "string" || !x.cadence || typeof x.cadence !== "object")
        return { error: `an entry is not an assignment: ${JSON.stringify(x).slice(0, 120)}` };
      entries.push({
        id: x.id,
        milestoneId: x.milestoneId,
        personaId: x.personaId,
        cadence: x.cadence as Cadence,
        enabled: x.enabled === true,
        writeEnabled: x.writeEnabled === true,
        writeScope: typeof x.writeScope === "string" ? x.writeScope : "",
        ...(typeof x.objective === "string" && x.objective.trim() ? { objective: x.objective.trim() } : {}),
        createdAt: typeof x.createdAt === "string" ? x.createdAt : "",
      });
    }
    return { entries };
  } catch (e) {
    return { error: `not JSON: ${(e as Error).message}` };
  }
}
export function parseAccess(text: string): AccessFile | { error: string } {
  try {
    const v = JSON.parse(text) as Partial<AccessFile>;
    const mcp = Array.isArray(v.mcp) ? v.mcp.filter((x) => typeof x?.serviceId === "string" && typeof x.personaId === "string").map((x) => ({ serviceId: x.serviceId, personaId: x.personaId, allowed: x.allowed === true })) : [];
    const mailCaps = Array.isArray(v.mailCaps) ? v.mailCaps.filter((x) => typeof x?.personaId === "string" && Number.isInteger(x.dailyCap)).map((x) => ({ personaId: x.personaId, dailyCap: x.dailyCap })) : [];
    return { mcp, mailCaps };
  } catch (e) {
    return { error: `not JSON: ${(e as Error).message}` };
  }
}

export interface AssignmentRecordDeps {
  db: DB;
  dirOf: (world: string) => string | undefined;
  writer: Pick<SpineWriter, "edit">;
  log?: (m: string) => void;
  now?: () => Date;
}

export function createAssignmentRecord(d: AssignmentRecordDeps) {
  const now = () => d.now?.() ?? new Date();
  const log = d.log ?? (() => {});
  const read = (dir: string, rel: string) => {
    try {
      return fs.readFileSync(path.join(dir, rel), "utf8");
    } catch {
      return undefined;
    }
  };
  const worldOfPersona = (personaId: string) => (d.db.prepare("SELECT tenant_id AS t FROM personas WHERE id = ?").get(personaId) as { t?: string } | undefined)?.t ?? DEFAULT_TENANT;
  const dbAssignments = (world: string) => {
    const s = forTenant(d.db, world);
    return s.listAssignments({}).map(assignmentEntryOf);
  };
  const dbAccess = (world: string): AccessFile => ({
    mcp: (d.db.prepare("SELECT a.service_id AS serviceId, a.persona_id AS personaId, a.allowed FROM mcp_access a JOIN personas p ON p.id = a.persona_id WHERE p.tenant_id = ?").all(world) as { serviceId: string; personaId: string; allowed: number }[]).map((x) => ({ ...x, allowed: !!x.allowed })),
    mailCaps: (d.db.prepare("SELECT c.persona_id AS personaId, c.daily_cap AS dailyCap FROM mail_caps c JOIN personas p ON p.id = c.persona_id WHERE p.tenant_id = ?").all(world) as { personaId: string; dailyCap: number }[]),
  });

  async function writeFile(world: string, rel: string, why: string, make: (text: string) => string | { skip: string }): Promise<SpineWrite | undefined> {
    const dir = d.dirOf(world);
    if (!dir) return undefined;
    let bad: string | undefined;
    const w = await d.writer.edit({
      repoDir: dir,
      path: rel,
      label: rel,
      edit: (text) => {
        const out = make(text);
        if (typeof out !== "string") return { skip: (bad = out.skip) };
        return { text: out, msg: `${rel === ASSIGNMENTS_FILE ? "Assignments" : "Access"}: ${why} (console)`, body: `The agent-team console recorded a change for ${world} before making it.` };
      },
    });
    if (w.status !== "written") throw new RecordError(w.status, `${rel} not written (${bad ?? w.reason ?? w.status}); nothing changed`);
    applied.delete(`${world}\0${rel}`);
    return w;
  }
  const changeAssignments = (world: string, why: string, change: (list: AssignmentEntry[]) => AssignmentEntry[]) =>
    writeFile(world, ASSIGNMENTS_FILE, why, (text) => {
      const p = text.trim() ? parseAssignments(text) : { entries: dbAssignments(world) };
      return "error" in p ? { skip: `${ASSIGNMENTS_FILE} is not readable (${p.error}): fix it by hand first` } : assignmentsText(change(p.entries));
    });
  const changeAccess = (world: string, why: string, change: (a: AccessFile) => AccessFile) =>
    writeFile(world, ACCESS_FILE, why, (text) => {
      const p = text.trim() ? parseAccess(text) : dbAccess(world);
      return "error" in p ? { skip: `${ACCESS_FILE} is not readable (${p.error}): fix it by hand first` } : accessText(change(p));
    });

  const applied = new Map<string, string>();
  /** Files → console.db for every world with a team repo. */
  function apply(): string[] {
    const out: string[] = [];
    const worlds = new Set([DEFAULT_TENANT, ...(d.db.prepare("SELECT DISTINCT tenant_id AS t FROM personas").all() as { t: string | null }[]).map((r) => r.t ?? DEFAULT_TENANT)]);
    for (const world of worlds) {
      const dir = d.dirOf(world);
      if (!dir) continue;
      const s = forTenant(d.db, world);
      const at = read(dir, ASSIGNMENTS_FILE);
      if (at !== undefined && applied.get(`${world}\0${ASSIGNMENTS_FILE}`) !== at) {
        applied.set(`${world}\0${ASSIGNMENTS_FILE}`, at);
        const p = parseAssignments(at);
        if ("error" in p) log(`assignments: ${world} ${ASSIGNMENTS_FILE} ignored: ${p.error}`);
        else
          for (const e of p.entries) {
            const cur = s.getAssignment(e.id);
            if (!cur) {
              if (d.db.prepare("SELECT 1 FROM assignments WHERE id = ?").get(e.id)) continue;
              if (!s.getMilestone(e.milestoneId) || !s.getPersona(e.personaId)) continue; // waits for its milestone / persona
              s.createAssignment({ id: e.id, milestoneId: e.milestoneId, personaId: e.personaId, cadence: e.cadence, enabled: e.enabled, writeEnabled: e.writeEnabled, writeScope: e.writeScope, objective: e.objective, createdAt: e.createdAt || now().toISOString() });
              out.push(`${world}: assignment ${e.id} added`);
              continue;
            }
            const patch: Parameters<Store["updateAssignment"]>[1] = {};
            if (JSON.stringify(cur.cadence) !== JSON.stringify(e.cadence)) patch.cadence = e.cadence;
            if (cur.writeEnabled !== e.writeEnabled) patch.writeEnabled = e.writeEnabled;
            if (cur.writeScope !== e.writeScope) patch.writeScope = e.writeScope;
            if ((cur.objective ?? "") !== (e.objective ?? "")) patch.objective = e.objective ?? null;
            // the owner's switch: off is off; on wakes only an assignment the scheduler has not parked
            if (!e.enabled && (cur.enabled || cur.parkedAt)) Object.assign(patch, { enabled: false, parkedAt: null, parkedReason: null });
            if (e.enabled && !cur.enabled && !cur.parkedAt) patch.enabled = true;
            if (Object.keys(patch).length) {
              s.updateAssignment(e.id, patch);
              out.push(`${world}: assignment ${e.id} updated`);
            }
          }
      }
      const ac = read(dir, ACCESS_FILE);
      if (ac !== undefined && applied.get(`${world}\0${ACCESS_FILE}`) !== ac) {
        applied.set(`${world}\0${ACCESS_FILE}`, ac);
        const p = parseAccess(ac);
        if ("error" in p) log(`access: ${world} ${ACCESS_FILE} ignored: ${p.error}`);
        else {
          const t = now().toISOString();
          for (const x of p.mcp) {
            if (worldOfPersona(x.personaId) !== world || !d.db.prepare("SELECT 1 FROM personas WHERE id = ?").get(x.personaId)) continue;
            const had = d.db.prepare("SELECT allowed FROM mcp_access WHERE service_id = ? AND persona_id = ?").get(x.serviceId, x.personaId) as { allowed: number } | undefined;
            if (had && !!had.allowed === x.allowed) continue;
            d.db.prepare("INSERT INTO mcp_access (service_id, persona_id, allowed, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (service_id, persona_id) DO UPDATE SET allowed = excluded.allowed, updated_at = excluded.updated_at").run(x.serviceId, x.personaId, x.allowed ? 1 : 0, t);
            out.push(`${world}: access ${x.serviceId} ${x.personaId}`);
          }
          for (const x of p.mailCaps) {
            if (worldOfPersona(x.personaId) !== world || !d.db.prepare("SELECT 1 FROM personas WHERE id = ?").get(x.personaId)) continue;
            const had = d.db.prepare("SELECT daily_cap FROM mail_caps WHERE persona_id = ?").get(x.personaId) as { daily_cap: number } | undefined;
            if (had?.daily_cap === x.dailyCap) continue;
            d.db.prepare("INSERT INTO mail_caps (persona_id, daily_cap, updated_at) VALUES (?, ?, ?) ON CONFLICT (persona_id) DO UPDATE SET daily_cap = excluded.daily_cap, updated_at = excluded.updated_at").run(x.personaId, x.dailyCap, t);
            out.push(`${world}: mail cap ${x.personaId}`);
          }
        }
      }
    }
    if (out.length) log(`assignments/access: applied ${out.join("; ")}`);
    return out;
  }

  /** carry-over: each world's assignments and access written to its files once (`dry` = say what). */
  async function carry(o: { dry?: boolean } = {}): Promise<{ world: string; file: string; action: string; count: number; reason?: string }[]> {
    const out: { world: string; file: string; action: string; count: number; reason?: string }[] = [];
    const worlds = new Set((d.db.prepare("SELECT DISTINCT tenant_id AS t FROM personas").all() as { t: string | null }[]).map((r) => r.t ?? DEFAULT_TENANT));
    for (const world of worlds) {
      const dir = d.dirOf(world);
      const mine = dbAssignments(world);
      const acc = dbAccess(world);
      if (!dir) {
        out.push({ world, file: "*", action: "no team-repo checkout: stays in console.db", count: mine.length });
        continue;
      }
      const run = async (file: string, count: number, missing: number, doit: () => Promise<unknown>) => {
        if (!missing) return out.push({ world, file, action: "already in the file", count });
        if (o.dry) return out.push({ world, file, action: "would write", count: missing });
        try {
          await doit();
          out.push({ world, file, action: "written", count: missing });
        } catch (e) {
          out.push({ world, file, action: "not written", count: missing, reason: (e as Error).message });
        }
      };
      const at = read(dir, ASSIGNMENTS_FILE);
      const have = at ? parseAssignments(at) : { entries: [] };
      const haveIds = new Set("error" in have ? [] : have.entries.map((e) => e.id));
      const missingA = mine.filter((e) => !haveIds.has(e.id));
      await run(ASSIGNMENTS_FILE, mine.length, at === undefined ? Math.max(missingA.length, 1) : missingA.length, () =>
        changeAssignments(world, `carry ${missingA.length} assignment(s) from console.db`, (list) => [...list, ...missingA.filter((e) => !list.some((x) => x.id === e.id))]),
      );
      const ac = read(dir, ACCESS_FILE);
      const haveAcc = ac ? parseAccess(ac) : { mcp: [], mailCaps: [] };
      const key = (x: { serviceId: string; personaId: string }) => `${x.serviceId}\0${x.personaId}`;
      const hm = new Set("error" in haveAcc ? [] : haveAcc.mcp.map(key));
      const hc = new Set("error" in haveAcc ? [] : haveAcc.mailCaps.map((x) => x.personaId));
      const mm = acc.mcp.filter((x) => !hm.has(key(x)));
      const mc = acc.mailCaps.filter((x) => !hc.has(x.personaId));
      await run(ACCESS_FILE, acc.mcp.length + acc.mailCaps.length, ac === undefined ? Math.max(mm.length + mc.length, 1) : mm.length + mc.length, () =>
        changeAccess(world, `carry ${mm.length} service switch(es) and ${mc.length} send cap(s) from console.db`, (a) => ({
          mcp: [...a.mcp, ...mm.filter((x) => !a.mcp.some((y) => key(y) === key(x)))],
          mailCaps: [...a.mailCaps, ...mc.filter((x) => !a.mailCaps.some((y) => y.personaId === x.personaId))],
        })),
      );
    }
    return out;
  }

  /** Assignment calls that record first (each throws RecordError with console.db untouched when not written). */
  function recorded(s: Store) {
    const worldOf = (a: { personaId: string }) => worldOfPersona(a.personaId);
    return {
      async createAssignment(input: Parameters<Store["createAssignment"]>[0]): Promise<Assignment> {
        const id = `as_${randomUUID()}`;
        const createdAt = now().toISOString();
        const writeEnabled = input.writeEnabled ?? !!s.getPersona(input.personaId)?.mayWrite;
        const writeScope = input.writeScope ?? (writeEnabled ? DEFAULT_WRITE_SCOPE : "");
        const e: AssignmentEntry = { id, milestoneId: input.milestoneId, personaId: input.personaId, cadence: input.cadence, enabled: input.enabled, writeEnabled, writeScope, ...(input.objective ? { objective: input.objective } : {}), createdAt };
        // refs that the store would refuse (missing, another world's) are not recorded: the store's error answers
        if (s.getMilestone(input.milestoneId) && s.getPersona(input.personaId) && (s.worldOfMilestone?.(input.milestoneId) ?? DEFAULT_TENANT) === worldOf(input))
          await changeAssignments(worldOf(input), `attach ${s.getPersona(input.personaId)!.name} to ${s.getMilestone(input.milestoneId)!.title}`, (list) => [...list.filter((x) => x.id !== id), e]);
        return s.createAssignment({ ...input, id, createdAt, writeEnabled, writeScope });
      },
      /** the owner's fields (cadence, enabled, write grant, persona, milestone) are recorded first; the scheduler's go straight. */
      async updateAssignment(id: string, p: Parameters<Store["updateAssignment"]>[1]): Promise<Assignment | undefined> {
        const cur = s.getAssignment(id);
        if (!cur) return undefined;
        const was = assignmentEntryOf(cur);
        const next: AssignmentEntry = {
          ...was,
          ...(p.cadence ? { cadence: p.cadence } : {}),
          ...(p.enabled !== undefined ? { enabled: p.enabled } : {}),
          ...(p.writeEnabled !== undefined ? { writeEnabled: p.writeEnabled } : {}),
          ...(p.writeScope !== undefined ? { writeScope: p.writeScope } : {}),
          ...(p.milestoneId ? { milestoneId: p.milestoneId } : {}),
          ...(p.personaId ? { personaId: p.personaId } : {}),
        };
        if (p.objective !== undefined) {
          if (p.objective) next.objective = p.objective;
          else delete next.objective;
        }
        if (JSON.stringify(next) !== JSON.stringify(was)) {
          const what = [p.enabled !== undefined && p.enabled !== was.enabled ? (p.enabled ? "switched on" : "switched off") : "", p.cadence ? "cadence" : "", p.writeEnabled !== undefined || p.writeScope !== undefined ? "write grant" : "", p.objective !== undefined && p.objective !== was.objective ? `objective ${p.objective || "none"}` : ""].filter(Boolean).join(", ") || "changed";
          await changeAssignments(worldOf(next), `${s.getPersona(next.personaId)?.name ?? next.personaId} on ${s.getMilestone(next.milestoneId)?.title ?? next.milestoneId}: ${what}`, (list) => [...list.filter((x) => x.id !== id), next]);
        }
        return s.updateAssignment(id, p);
      },
      async deleteAssignment(id: string): Promise<boolean> {
        const cur = s.getAssignment(id);
        if (!cur) return false;
        await changeAssignments(worldOf(cur), `detach ${s.getPersona(cur.personaId)?.name ?? cur.personaId} from ${s.getMilestone(cur.milestoneId)?.title ?? cur.milestoneId}`, (list) => list.filter((x) => x.id !== id));
        return !!s.deleteAssignment(id);
      },
    };
  }

  return {
    apply,
    carry,
    recorded,
    /** A service switch for a persona, recorded first (`set` then writes console.db). */
    async access(serviceId: string, personaId: string, allowed: boolean, set: () => void) {
      await changeAccess(worldOfPersona(personaId), `${serviceId} ${allowed ? "allowed" : "refused"} for ${personaId}`, (a) => ({ ...a, mcp: [...a.mcp.filter((x) => !(x.serviceId === serviceId && x.personaId === personaId)), { serviceId, personaId, allowed }] }));
      set();
    },
    /** A send cap for a persona, recorded first. */
    async mailCap(personaId: string, dailyCap: number, set: () => void) {
      await changeAccess(worldOfPersona(personaId), `send cap ${dailyCap} a day for ${personaId}`, (a) => ({ ...a, mailCaps: [...a.mailCaps.filter((x) => x.personaId !== personaId), { personaId, dailyCap }] }));
      set();
    },
  };
}

export type AssignmentRecord = ReturnType<typeof createAssignmentRecord>;
export type RecordedAssignments = ReturnType<AssignmentRecord["recorded"]>;

/** The same calls on console.db only (no record wired). */
export function plainAssignments(s: Store): RecordedAssignments {
  return {
    createAssignment: async (input) => s.createAssignment(input),
    updateAssignment: async (id, p) => s.updateAssignment(id, p),
    deleteAssignment: async (id) => !!s.deleteAssignment(id),
  };
}
