import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_TENANT, type DB } from "../db.js";
import { forTenant, type Persona, type Store } from "../store.js";
import type { SpineWrite, SpineWriter } from "../inbox/spineWrite.js";
import { RecordError } from "./milestoneRecord.js";
import { mainHost, workerHost } from "../identity.js";

/**
 * a persona is a file in its world's team repo,
 *
 *   state/personas/<name>.md   front matter (id, name, model, host, provider, skills, mayWrite, freshThreadEachWake,
 *                              skipUnchanged, createdAt; JSON values) and `## Remit`, the instruction every wake follows,
 *                              verbatim to the end of the file.
 *
 * so who changed a remit, and when, is in git, and a lost console.db loses no persona. A create, edit (Settings, the model
 * or provider picker, a team skill detached) or delete writes the file first through the one spine writer; only a written
 * file changes console.db, a write that does not land changes nothing (RecordError). Every team-state pass applies the
 * files to console.db (the personas table is an index of them, ids kept for the run log). The file name is set at
 * creation and kept on a rename (the id inside is the key). Same team repo as state/milestones.json (milestoneRecord's
 * `dirOf`; staging and worlds with no checkout keep console.db only). A world's own pack persona files (a social world repo's
 * `personas/`) are its own and are never touched.
 */
export const PERSONAS_DIR = "state/personas";

type Fields = Omit<Persona, "remit"> & { provider?: string | null };

const KEYS = ["id", "name", "model", "host", "provider", "skills", "mayWrite", "freshThreadEachWake", "skipUnchanged", "createdAt"] as const;

export function personaText(p: Persona & { provider?: string | null }): string {
  const v: Record<string, unknown> = { ...p, provider: p.provider ?? null };
  const front = KEYS.map((k) => `${k}: ${JSON.stringify(v[k] ?? null)}`).join("\n");
  return `---\n${front}\n---\n\n## Remit\n\n${p.remit.replace(/\s+$/, "")}\n`;
}

export function parsePersona(text: string): (Persona & { provider?: string | null }) | { error: string } {
  const m = /^---\n([\s\S]*?)\n---\n\n## Remit\n\n([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  if (!m) return { error: "not a persona file (front matter, then ## Remit)" };
  const f: Record<string, unknown> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i < 1) continue;
    try {
      f[line.slice(0, i).trim()] = JSON.parse(line.slice(i + 1).trim());
    } catch {
      return { error: `front matter line is not JSON: ${line.slice(0, 80)}` };
    }
  }
  const s = (k: string) => (typeof f[k] === "string" ? (f[k] as string) : undefined);
  const id = s("id");
  if (!id || !/^pe_[\w-]+$/.test(id) || !s("name")) return { error: "no valid id or name" };
  return {
    id,
    name: s("name")!,
    remit: m[2].replace(/\n$/, ""),
    model: s("model") ?? "",
    host: s("host") === workerHost() ? workerHost() : mainHost(),
    provider: s("provider") ?? null,
    skills: Array.isArray(f.skills) ? (f.skills as unknown[]).filter((x): x is string => typeof x === "string") : [],
    mayWrite: f.mayWrite === true,
    freshThreadEachWake: f.freshThreadEachWake === true,
    skipUnchanged: f.skipUnchanged !== false,
    createdAt: s("createdAt") ?? "",
  };
}

export const slugOf = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "persona";

export interface PersonaRecordDeps {
  db: DB;
  dirOf: (world: string) => string | undefined;
  writer: Pick<SpineWriter, "edit" | "scaffold">;
  log?: (m: string) => void;
  now?: () => Date;
}

export function createPersonaRecord(d: PersonaRecordDeps) {
  const now = () => d.now?.() ?? new Date();
  const log = d.log ?? (() => {});
  const providerOf = (id: string) => (d.db.prepare("SELECT provider FROM personas WHERE id = ?").get(id) as { provider?: string | null } | undefined)?.provider ?? null;
  const files = (dir: string): { rel: string; text: string }[] => {
    const abs = path.join(dir, PERSONAS_DIR);
    if (!fs.existsSync(abs)) return [];
    return fs
      .readdirSync(abs)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => ({ rel: `${PERSONAS_DIR}/${f}`, text: fs.readFileSync(path.join(abs, f), "utf8") }));
  };
  /** The file that holds persona `id` in `dir`, else a free `state/personas/<slug>.md` for `name`. */
  function fileFor(dir: string, id: string, name: string): string {
    for (const f of files(dir)) {
      const p = parsePersona(f.text);
      if (!("error" in p) && p.id === id) return f.rel;
    }
    const taken = new Set(files(dir).map((f) => f.rel));
    const base = `${PERSONAS_DIR}/${slugOf(name)}`;
    for (let n = 1; ; n++) if (!taken.has(n === 1 ? `${base}.md` : `${base}-${n}.md`)) return n === 1 ? `${base}.md` : `${base}-${n}.md`;
  }
  const worlds = () => (d.db.prepare("SELECT DISTINCT tenant_id AS t FROM personas").all() as { t: string | null }[]).map((r) => r.t ?? DEFAULT_TENANT);

  /** Write (or, `gone`, empty) the persona's file; nothing for a world with no team repo. Throws RecordError. */
  async function write(world: string, p: Persona & { provider?: string | null }, why: string, gone = false): Promise<SpineWrite | undefined> {
    const dir = d.dirOf(world);
    if (!dir) return undefined;
    const rel = fileFor(dir, p.id, p.name);
    if (gone && !fs.existsSync(path.join(dir, rel))) return undefined;
    const w = gone
      ? await d.writer.scaffold({
          repoDir: dir,
          path: rel,
          label: `persona ${p.name}`,
          scaffold: async (r) => {
            fs.rmSync(path.join(r, rel), { force: true });
            return { ok: true, files: [rel] };
          },
          msg: `Personas: remove ${p.name} (console)`,
          body: `The agent-team console removed the persona ${p.name} (${p.id}) of ${world} before deleting it.`,
        })
      : await d.writer.edit({
          repoDir: dir,
          path: rel,
          label: `persona ${p.name}`,
          edit: () => ({ text: personaText(p), msg: `Personas: ${why} (console)`, body: `The agent-team console wrote the persona ${p.name} (${p.id}) of ${world} before changing it.` }),
        });
    if (w.status !== "written") throw new RecordError(w.status, `${rel} not written (${w.reason ?? w.status}); nothing changed`);
    return w;
  }

  /** Files → console.db for every world with a team repo: each file updates or adds its persona. */
  const applied = new Map<string, string>();
  function apply(): string[] {
    const out: string[] = [];
    for (const world of new Set([...worlds(), DEFAULT_TENANT])) {
      const dir = d.dirOf(world);
      if (!dir) continue;
      const fs_ = files(dir);
      const sig = fs_.map((f) => `${f.rel}\0${f.text}`).join("\0\0");
      if (applied.get(world) === sig) continue;
      applied.set(world, sig);
      const s = forTenant(d.db, world);
      for (const f of fs_) {
        const p = parsePersona(f.text);
        if ("error" in p) {
          log(`personas: ${world} ${f.rel} ignored: ${p.error}`);
          continue;
        }
        const cur = s.getPersona(p.id);
        if (!cur) {
          if (d.db.prepare("SELECT 1 FROM personas WHERE id = ?").get(p.id)) continue; // another world's id: never moved
          s.createPersona({ ...p, id: p.id, createdAt: p.createdAt || now().toISOString() });
          if (p.provider) d.db.prepare("UPDATE personas SET provider = ? WHERE id = ?").run(p.provider, p.id);
          out.push(`${world}: ${p.name} added`);
          continue;
        }
        const patch: Parameters<Store["updatePersona"]>[1] = {};
        for (const k of ["name", "remit", "model", "host", "mayWrite", "freshThreadEachWake", "skipUnchanged"] as const) if (cur[k] !== p[k]) (patch as Record<string, unknown>)[k] = p[k];
        if (JSON.stringify(cur.skills) !== JSON.stringify(p.skills)) patch.skills = p.skills;
        const prov = providerOf(p.id);
        if ((prov ?? null) !== (p.provider ?? null)) d.db.prepare("UPDATE personas SET provider = ? WHERE id = ?").run(p.provider ?? null, p.id);
        if (Object.keys(patch).length) s.updatePersona(p.id, patch);
        if (Object.keys(patch).length || (prov ?? null) !== (p.provider ?? null)) out.push(`${world}: ${p.name} updated`);
      }
    }
    if (out.length) log(`personas: applied ${out.join("; ")}`);
    return out;
  }

  /** carry-over: each world's console.db personas written as files once (one commit per world; `dry` = say what). */
  async function carry(o: { dry?: boolean } = {}): Promise<{ world: string; action: string; count: number; reason?: string }[]> {
    const out: { world: string; action: string; count: number; reason?: string }[] = [];
    for (const world of new Set(worlds())) {
      const dir = d.dirOf(world);
      const mine = forTenant(d.db, world).listPersonas();
      if (!dir) {
        out.push({ world, action: "no team-repo checkout: stays in console.db", count: mine.length });
        continue;
      }
      const have = new Set(files(dir).flatMap((f) => {
        const p = parsePersona(f.text);
        return "error" in p ? [] : [p.id];
      }));
      const missing = mine.filter((p) => !have.has(p.id));
      if (!missing.length) {
        out.push({ world, action: "already in files", count: mine.length });
        continue;
      }
      if (o.dry) {
        out.push({ world, action: "would write", count: missing.length });
        continue;
      }
      // one name → one file, decided before any is written
      const plan: { rel: string; text: string }[] = [];
      const taken = new Set(files(dir).map((f) => f.rel));
      for (const p of missing) {
        const base = `${PERSONAS_DIR}/${slugOf(p.name)}`;
        let rel = `${base}.md`;
        for (let n = 2; taken.has(rel); n++) rel = `${base}-${n}.md`;
        taken.add(rel);
        plan.push({ rel, text: personaText({ ...p, provider: providerOf(p.id) }) });
      }
      const w = await d.writer.scaffold({
        repoDir: dir,
        path: plan[0].rel,
        label: "personas carry",
        scaffold: async (r) => {
          fs.mkdirSync(path.join(r, PERSONAS_DIR), { recursive: true });
          for (const f of plan) fs.writeFileSync(path.join(r, f.rel), f.text);
          return { ok: true, files: plan.map((f) => f.rel) };
        },
        msg: `Personas: carry ${plan.length} persona(s) from console.db (console)`,
        body: `The agent-team console wrote the personas of ${world} as files once; from now on each change is written here first.`,
      });
      out.push(w.status === "written" ? { world, action: "written", count: plan.length } : { world, action: "not written", count: plan.length, reason: w.reason ?? w.status });
    }
    return out;
  }

  /** Store calls that write the file first; each throws RecordError with console.db untouched when it is not written. */
  function recorded(s: Store) {
    const worldOf = (id: string) => s.worldOfPersona?.(id) ?? s.tenant ?? DEFAULT_TENANT;
    return {
      async createPersona(input: Parameters<Store["createPersona"]>[0]): Promise<Persona> {
        const id = `pe_${randomUUID()}`;
        const createdAt = now().toISOString();
        const p: Persona = { id, name: input.name, remit: input.remit, skills: input.skills, model: input.model, mayWrite: input.mayWrite, host: input.host ?? mainHost(), freshThreadEachWake: !!input.freshThreadEachWake, skipUnchanged: input.skipUnchanged !== false, createdAt };
        await write(s.tenant ?? DEFAULT_TENANT, p, `add ${input.name}`);
        return s.createPersona({ ...input, id, createdAt });
      },
      async updatePersona(id: string, patch: Parameters<Store["updatePersona"]>[1] & { provider?: string }): Promise<Persona | undefined> {
        const cur = s.getPersona(id);
        if (!cur) return undefined;
        const { provider, ...rest } = patch;
        const next = { ...cur, ...rest, provider: provider ?? providerOf(id) };
        if (personaText(next) !== personaText({ ...cur, provider: providerOf(id) })) await write(worldOf(id), next, `${cur.name}: ${Object.keys(patch).join(", ")} changed`);
        if (provider !== undefined) d.db.prepare("UPDATE personas SET provider = ? WHERE id = ?").run(provider, id);
        return Object.keys(rest).length ? s.updatePersona(id, rest) : s.getPersona(id);
      },
      async deletePersona(id: string): Promise<boolean> {
        const cur = s.getPersona(id);
        if (!cur) return false;
        await write(worldOf(id), cur, `remove ${cur.name}`, true);
        return !!s.deletePersona(id);
      },
    };
  }

  return { apply, carry, recorded, write };
}

export type PersonaRecord = ReturnType<typeof createPersonaRecord>;
export type RecordedPersonas = ReturnType<PersonaRecord["recorded"]>;

/** The same calls on console.db only (no record wired). */
export function plainPersonas(s: Store, db: DB): RecordedPersonas {
  return {
    createPersona: async (input) => s.createPersona(input),
    updatePersona: async (id, patch) => {
      const { provider, ...rest } = patch;
      if (provider !== undefined) db.prepare("UPDATE personas SET provider = ? WHERE id = ?").run(provider, id);
      return Object.keys(rest).length ? s.updatePersona(id, rest) : s.getPersona(id);
    },
    deletePersona: async (id) => !!s.deletePersona(id),
  };
}
