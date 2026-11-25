import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DB } from "../db.js";
import { forTenant, type Milestone } from "../store.js";
import type { SpineWrite, SpineWriter } from "../inbox/spineWrite.js";
import type { Placement, Placements } from "../desk/placements.js";
import type { DeskMessage } from "../desk/session.js";
import { sameRepo } from "../adapters/repoNames.js";
import { homeWorld, memoryName, ownerName } from "../identity.js";

/**
 * the owner's own team state lives in its own private repo (the team repo), not in the code
 * repo, the way a social world repo holds a customer's state. The console keeps working from its database and keeps the repo in
 * step through the one spine writer (guards, one lock per checkout, commit + push main-direct):
 *
 *   state/big-roots.json   the owner's big roots (position + title per milestone). The file is the source: a change on main
 *                          (by hand, or another host) is applied to the milestones; a big-root change on the console
 *                          (PATCH bigRoot / title of a big root) is written back to the file.
 *   desk/placements.json   the desk's placements (desk_placement), written after every change and read back on start, so
 *                          a lost database loses none of them.
 *   desk/chat/<day>.md     the Team desk chat, append-only per message id (one file per UTC day), copied from its T3 thread.
 *   voice/<day>.md         the owner's WhatsApp voice-note transcripts (relay), append-only per the memory service note id, one file
 *                          per UTC day of the recording, pasted keys redacted as in the chat copy.
 *
 * Team-level asks wait in the repo's root spine `## Waiting on`; the console lists them, labelled "Team" (TEAM_LABEL),
 * next to each epic's asks, through the milestone that tracks that spine; an answer is written back by the spine writer.
 *
 * Everything is the home world's (the owner's world). Absent checkout = everything here is a no-op (tests, other hosts).
 */
export const TEAM_REPO_DEFAULT = "team";
export const BIG_ROOTS_FILE = "state/big-roots.json";
export const PLACEMENTS_FILE = "desk/placements.json";
export const CHAT_DIR = "desk/chat";
export const VOICE_DIR = "voice";
export const TEAM_ROOT_SPINE = "docs/spines/root.md";
/** how the console's Waiting on names the team repo's own (team-level) asks. */
export const TEAM_LABEL = "Team";
const WORLD = homeWorld();
const PULL_ONLY = "pull only";

export const BIG_ROOTS_ABOUT =
  `${ownerName()}'s big roots: the milestones that lead the console sidebar, in this order. The console reads this file (position and title, matched by milestoneId, else by repo + path) and writes it back when a big root is renamed, reordered, added or removed on the console. Remove an entry to make that milestone ordinary again.`;
export const PLACEMENTS_ABOUT =
  "What the Team desk placed in the tree and whether it closed. Written by the console after every change; read back on start so nothing is lost.";

export interface BigRootEntry {
  position: number;
  title?: string;
  milestoneId?: string;
  repo?: string;
  path?: string;
}

/** True for the milestone that tracks the team repo's root spine (`the team repo` docs/spines/root.md, or CONSOLE_TEAM_REPO). */
export const isTeamMilestone = (m: { repo?: string; path?: string }, repo = TEAM_REPO_DEFAULT) =>
  m.path === TEAM_ROOT_SPINE && (m.repo ?? "").split("/").pop()!.toLowerCase() === (repo || TEAM_REPO_DEFAULT).toLowerCase();

/** One voice note's copy for voice/<day>.md. */
export interface VoiceNoteCopy {
  /** the memory service evidenceRef (`Log/2026-11-01.md#^e-3e479d`): the note's id in the file. */
  ref: string;
  capturedAt?: string;
  url?: string;
  text: string;
}

export interface TeamStateDeps {
  db: DB;
  reposRoot: string;
  /** Checkout name under reposRoot (CONSOLE_TEAM_REPO; default `team`). */
  repo?: string;
  writer: Pick<SpineWriter, "edit" | "scaffold">;
  placements?: Pick<Placements, "list" | "restore">;
  /** The desk chat's finished messages (Desk.transcript); undefined = no chat copy. */
  transcript?: () => Promise<DeskMessage[]>;
  log?: (msg: string) => void;
  /** after the pull, before big roots: state/milestones.json → console.db (milestoneRecord.apply). */
  beforeApply?: () => void;
  /** Read the checkout, never commit or push to it (a local, test or staging boot: teamRepoWrites false). */
  readOnly?: boolean;
}

/** Why a read-only boot leaves the team repo alone (the skipped write's reason). */
export const READ_ONLY_BOOT = "this boot does not write the team repo (set NODE_ENV=production or CONSOLE_TEAM_WRITE=1)";

/**
 * May this boot commit and push to the team repo? Only the production unit (NODE_ENV=production, not staging) by
 * default; CONSOLE_TEAM_WRITE=1 or 0 says so explicitly. A source boot on a server whose repos root holds the real team
 * checkout (no NODE_ENV) only reads it: such a boot once pushed two self-cancelling desk/placements.json commits.
 * The test runner writes its temp checkouts only (test/realCheckoutGuard.ts refuses any real one), so it counts as yes.
 */
export function teamRepoWrites(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CONSOLE_TEAM_WRITE === "1") return true;
  if (env.CONSOLE_TEAM_WRITE === "0" || env.CONSOLE_STAGING === "1") return false;
  return env.NODE_ENV === "production" || !!env.VITEST || env.NODE_ENV === "test";
}

export interface TeamSyncResult {
  pull?: string;
  bigRoots?: string;
  placements?: string;
  chat?: string;
}

const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";
const hash = (t: string) => crypto.createHash("sha256").update(t).digest("hex");

/** Tokens that must never land in a repo (a pasted key in chat): replaced before the copy is written. */
const SECRETISH = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\b(ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g,
  /\btok_[A-Za-z0-9]{24,}/g,
];
export const redact = (t: string) => SECRETISH.reduce((s, re) => s.replace(re, "[redacted]"), t);

/** Parse state/big-roots.json; undefined (and why) when it is not a valid list. */
export function parseBigRoots(text: string): { entries: BigRootEntry[] } | { error: string } {
  let v: any;
  try {
    v = JSON.parse(text);
  } catch (e) {
    return { error: `not valid JSON (${(e as Error).message})` };
  }
  const list = Array.isArray(v) ? v : v?.bigRoots;
  if (!Array.isArray(list)) return { error: "no bigRoots list" };
  const entries: BigRootEntry[] = [];
  for (const [i, e] of list.entries()) {
    const position = Number(e?.position ?? i + 1);
    if (!Number.isInteger(position) || position < 1 || position > 99) return { error: `entry ${i + 1}: position must be 1..99` };
    if (!e?.milestoneId && !(e?.repo && e?.path)) return { error: `entry ${i + 1}: needs milestoneId, or repo and path` };
    entries.push({ position, ...(typeof e.title === "string" && e.title.trim() ? { title: e.title.trim() } : {}), ...(e.milestoneId ? { milestoneId: String(e.milestoneId) } : {}), ...(e.repo ? { repo: String(e.repo) } : {}), ...(e.path ? { path: String(e.path) } : {}) });
  }
  return { entries };
}

/** The file text for these milestones' big roots (ordered by position). */
export function bigRootsText(ms: Milestone[]): string {
  const roots = ms.filter((m) => m.bigRoot != null).sort((a, b) => a.bigRoot! - b.bigRoot! || a.createdAt.localeCompare(b.createdAt));
  return json({ about: BIG_ROOTS_ABOUT, bigRoots: roots.map((m) => ({ position: m.bigRoot, title: m.title, milestoneId: m.id, repo: m.repo, path: m.path })) });
}

export function placementsText(list: Placement[]): string {
  return json({ about: PLACEMENTS_ABOUT, placements: list });
}

// ---------- the chat copy ----------

const ID_MARK = /<!-- m:([^\s>]+) -->/g;
const dayOf = (m: DeskMessage) => (m.at && /^\d{4}-\d{2}-\d{2}T/.test(m.at) ? m.at.slice(0, 10) : undefined);

/** Append the messages a day file lacks (by message id); returns the new text, or undefined when nothing is new. */
export function appendChat(existing: string, day: string, msgs: DeskMessage[]): string | undefined {
  const have = new Set([...existing.matchAll(ID_MARK)].map((x) => x[1]));
  const fresh = msgs.filter((m) => !have.has(m.id));
  if (!fresh.length) return undefined;
  const blocks = fresh.map((m) => {
    const time = `${m.at!.slice(11, 16)}Z`;
    if (m.kind === "seed") return `## ${time} · new desk session${m.session ? ` ${m.session}` : ""}\n<!-- m:${m.id} -->\n`;
    const who = m.role === "user" ? (m.from === "console" ? "Console" : ownerName()) : "Team desk";
    const from = m.page ? ` (from ${m.page.replace(/\s+/g, " ")})` : "";
    return `## ${time} · ${who}${from}\n<!-- m:${m.id} -->\n\n${redact(m.text.trim())}${m.truncated ? "\n\n(cut short in the T3 read)" : ""}\n`;
  });
  const head = existing.trim() ? existing.replace(/\s*$/, "\n\n") : `# Team desk chat · ${day}\n\n`;
  return head + blocks.join("\n");
}

// ---------- the voice-note copy ----------

const VOICE_MARK = /<!-- vn:(.+?) -->/g;
export const voiceDayOf = (n: Pick<VoiceNoteCopy, "capturedAt">, now = new Date()) =>
  n.capturedAt && /^\d{4}-\d{2}-\d{2}T/.test(n.capturedAt) ? n.capturedAt.slice(0, 10) : now.toISOString().slice(0, 10);
/** Note ids a voice day file holds. */
export const voiceRefsIn = (text: string) => new Set([...text.matchAll(VOICE_MARK)].map((x) => x[1]));

/** Append the notes a day file lacks (by the memory service note id), oldest first; undefined when nothing is new. */
export function appendVoice(existing: string, day: string, notes: VoiceNoteCopy[]): string | undefined {
  const have = voiceRefsIn(existing);
  const fresh = notes.filter((n) => !have.has(n.ref)).sort((a, b) => (a.capturedAt ?? "").localeCompare(b.capturedAt ?? ""));
  if (!fresh.length) return undefined;
  const blocks = fresh.map((n) => {
    const time = n.capturedAt && /T\d{2}:\d{2}/.test(n.capturedAt) ? `${n.capturedAt.slice(11, 16)}Z` : "time unknown";
    return `## ${time} · ${ownerName()} (voice note, WhatsApp → ${memoryName()})\n<!-- vn:${n.ref} -->\n\n${memoryName()}: ${n.ref}${n.url ? ` · ${n.url}` : ""}\n\n${redact(n.text.trim() || "(no transcript)")}\n`;
  });
  const head = existing.trim() ? existing.replace(/\s*$/, "\n\n") : `# ${ownerName()}'s voice notes · ${day}\n\nTranscripts of his WhatsApp voice notes, as ${memoryName()} transcribed them, copied by the agent-team console (one entry per note).\n\n`;
  return head + blocks.join("\n");
}

export function createTeamState(deps: TeamStateDeps) {
  const skipped = async (): Promise<SpineWrite> => ({ status: "skipped", reason: READ_ONLY_BOOT });
  const d: TeamStateDeps = deps.readOnly ? { ...deps, writer: { edit: skipped, scaffold: skipped } } : deps;
  const name = d.repo || TEAM_REPO_DEFAULT;
  const dir = () => {
    const p = path.join(d.reposRoot, name);
    return fs.existsSync(path.join(p, ".git")) ? p : undefined;
  };
  const log = d.log ?? (() => {});
  const store = () => forTenant(d.db, WORLD);
  const readRel = (rel: string) => {
    const r = dir();
    try {
      return r ? fs.readFileSync(path.join(r, rel), "utf8") : undefined;
    } catch {
      return undefined;
    }
  };
  const said = (w: SpineWrite) => (w.status === "written" ? `written${w.sha ? ` ${w.sha}` : ""}` : `${w.status}: ${w.reason ?? ""}`);

  let appliedHash: string | undefined;

  /** File → milestones: positions and titles of the home world's milestones follow the file. Returns what changed. */
  function applyBigRoots(): string | undefined {
    const text = readRel(BIG_ROOTS_FILE);
    if (text === undefined) return undefined;
    const h = hash(text);
    if (h === appliedHash) return undefined;
    const parsed = parseBigRoots(text);
    if ("error" in parsed) {
      appliedHash = h; // one log line per bad version, not one per pass
      log(`team state: ${BIG_ROOTS_FILE} ignored: ${parsed.error}`);
      return `ignored: ${parsed.error}`;
    }
    const s = store();
    const ms = s.listMilestones({ includeSettled: true });
    const want = new Map<string, BigRootEntry>();
    for (const e of parsed.entries) {
      const m = (e.milestoneId && ms.find((x) => x.id === e.milestoneId)) || (e.repo && e.path ? ms.find((x) => sameRepo(x.repo, e.repo) && x.path === e.path) : undefined);
      if (m) want.set(m.id, e);
    }
    const changed: string[] = [];
    for (const m of ms) {
      const e = want.get(m.id);
      const pos = e ? e.position : null;
      const p: { bigRoot?: number | null; title?: string; titleSetAt?: string } = {};
      if ((m.bigRoot ?? null) !== pos) p.bigRoot = pos;
      if (e?.title && e.title !== m.title) Object.assign(p, { title: e.title, titleSetAt: new Date().toISOString() });
      if (Object.keys(p).length) {
        s.updateMilestone(m.id, p);
        changed.push(`${e?.title ?? m.title}${p.bigRoot !== undefined ? ` → ${pos ?? "ordinary"}` : ""}${p.title ? " (renamed)" : ""}`);
      }
    }
    appliedHash = h;
    return changed.length ? `applied: ${changed.join("; ")}` : undefined;
  }

  /**
   * the file first. `ms` = the home world's milestones as they will be after the change (default: as they are);
   * the caller changes console.db only when this answers written. No in-memory retry: a failed write is the caller's error.
   */
  async function writeBigRoots(why: string, ms?: Milestone[]): Promise<SpineWrite | undefined> {
    const r = dir();
    if (!r) return undefined;
    const text = bigRootsText(ms ?? store().listMilestones({ includeSettled: true }));
    const w = await d.writer.edit({
      repoDir: r,
      path: BIG_ROOTS_FILE,
      label: "big roots",
      edit: () => ({ text, msg: `Big roots: ${why} (console)`, body: `The agent-team console wrote ${ownerName()}'s big roots after a change on the console.` }),
    });
    if (w.status === "written") appliedHash = hash(text);
    else log(`team state: ${BIG_ROOTS_FILE} ${said(w)}`);
    return w;
  }

  /** the home world's placements only (another world's, e.g. a social world repo's, stay out of the owner's repo, as on GET /desk/placements). */
  const ownPlacements = (list: Placement[]): Placement[] => {
    try {
      const mine = new Set((d.db.prepare("SELECT id FROM desk_placement WHERE tenant_id = ?").all(WORLD) as { id: string }[]).map((x) => x.id));
      return list.filter((p) => mine.has(p.id));
    } catch {
      return list; // no tenancy column yet: one world
    }
  };

  async function writePlacements(): Promise<string | undefined> {
    const r = dir();
    if (!r || !d.placements) return undefined;
    const text = placementsText(ownPlacements(d.placements.list()));
    if (readRel(PLACEMENTS_FILE) === text) return undefined;
    const w = await d.writer.edit({
      repoDir: r,
      path: PLACEMENTS_FILE,
      label: "desk placements",
      edit: () => ({ text, msg: "Desk placements updated (console)", body: "The agent-team console copied the Team desk's placements." }),
    });
    return said(w);
  }

  async function writeChat(): Promise<string | undefined> {
    const r = dir();
    if (!r || !d.transcript) return undefined;
    const msgs = (await d.transcript()).filter((m) => dayOf(m) && (m.kind === "seed" || m.text.trim()));
    const byDay = new Map<string, DeskMessage[]>();
    for (const m of msgs) byDay.set(dayOf(m)!, [...(byDay.get(dayOf(m)!) ?? []), m]);
    const next = new Map<string, string>();
    for (const [day, list] of byDay) {
      const rel = `${CHAT_DIR}/${day}.md`;
      const t = appendChat(readRel(rel) ?? "", day, list);
      if (t !== undefined) next.set(rel, t);
    }
    if (!next.size) return undefined;
    const n = [...next.values()].length;
    const w = await d.writer.scaffold({
      repoDir: r,
      path: "docs/spines/root.md",
      label: "desk chat",
      scaffold: async (repoDir) => {
        // Re-read under the writer's lock (after its fast-forward): append to what is on main now.
        const files: string[] = [];
        for (const rel of next.keys()) {
          const day = path.basename(rel, ".md");
          const abs = path.join(repoDir, rel);
          const cur = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
          const t = appendChat(cur, day, byDay.get(day)!);
          if (t === undefined) continue;
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, t);
          files.push(rel);
        }
        return files.length ? { ok: true, files } : { ok: false, error: "the chat copy is up to date" };
      },
      msg: `Desk chat copied (${[...next.keys()].map((k) => path.basename(k, ".md")).join(", ")}) (console)`,
      body: `The agent-team console appended the Team desk's newest messages to ${n} day file(s).`,
    });
    return said(w);
  }

  /** Voice notes → voice/<day>.md (append-only by note id). Returns the ids now on file (in this checkout), with how the write went. */
  async function writeVoice(notes: VoiceNoteCopy[]): Promise<{ status?: string; archived: string[] }> {
    const r = dir();
    if (!r || !notes.length) return { archived: [] };
    const byDay = new Map<string, VoiceNoteCopy[]>();
    for (const n of notes) byDay.set(voiceDayOf(n), [...(byDay.get(voiceDayOf(n)) ?? []), n]);
    const onFile = () => {
      const got = new Set<string>();
      for (const day of byDay.keys()) for (const ref of voiceRefsIn(readRel(`${VOICE_DIR}/${day}.md`) ?? "")) got.add(ref);
      return notes.map((n) => n.ref).filter((ref) => got.has(ref));
    };
    let status: string | undefined;
    if (onFile().length < notes.length) {
      const w = await d.writer.scaffold({
        repoDir: r,
        path: TEAM_ROOT_SPINE,
        label: "voice notes",
        scaffold: async (repoDir) => {
          // Re-read under the writer's lock (after its fast-forward): append to what is on main now.
          const files: string[] = [];
          for (const [day, list] of byDay) {
            const rel = `${VOICE_DIR}/${day}.md`;
            const abs = path.join(repoDir, rel);
            const t = appendVoice(fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "", day, list);
            if (t === undefined) continue;
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, t);
            files.push(rel);
          }
          return files.length ? { ok: true, files } : { ok: false, error: "the voice-note copy is up to date" };
        },
        msg: `Voice notes copied (${[...byDay.keys()].join(", ")}) (console)`,
        body: `The agent-team console copied ${notes.length} of ${ownerName()}'s voice-note transcripts from ${memoryName()}.`,
      });
      status = said(w);
      if (w.status !== "written") log(`team state: voice notes ${status}`);
    }
    return { ...(status ? { status } : {}), archived: onFile() };
  }

  /** Bring the checkout up to origin/main through the spine writer (same lock, fetch, fast-forward); no commit. Says why
   * only when the pull could not happen (diverged, fetch failed). */
  async function pullMain(): Promise<string | undefined> {
    const r = dir();
    if (!r) return undefined;
    const w = await d.writer.edit({ repoDir: r, path: BIG_ROOTS_FILE, label: "team state pull", edit: () => ({ skip: PULL_ONLY }) });
    return w.status === "skipped" && w.reason === PULL_ONLY ? undefined : `not pulled: ${said(w)}`;
  }

  let syncing: Promise<TeamSyncResult> | undefined;
  let restored = false;

  /** On start: placements the copy holds and the database lacks come back (once per process). */
  function restorePlacements(): number {
    if (restored || !d.placements || !dir()) return 0;
    restored = true;
    const text = readRel(PLACEMENTS_FILE);
    if (!text) return 0;
    try {
      const v = JSON.parse(text);
      const n = d.placements.restore(Array.isArray(v?.placements) ? v.placements : []);
      if (n) log(`team state: ${n} desk placement(s) restored from ${PLACEMENTS_FILE}`);
      return n;
    } catch (e) {
      log(`team state: ${PLACEMENTS_FILE} unreadable: ${(e as Error).message}`);
      return 0;
    }
  }

  return {
    dir,
    applyBigRoots,
    writeBigRoots,
    writeVoice,

    /** On start: placements the copy holds and the database lacks come back. */
    restorePlacements,

    /** A console change touches the big roots: write the file first (`ms` = the milestones after the change). */
    bigRootsChanged: (why: string, ms?: Milestone[]) => writeBigRoots(why, ms),

    /** One background pass: pull, file → milestones; then the placements and chat copies. */
    sync(): Promise<TeamSyncResult> {
      syncing ??= (async () => {
        const out: TeamSyncResult = {};
        if (!dir()) return out;
        restorePlacements();
        // Fetch + fast-forward under the writer's lock first, so an edit on GitHub main (by hand, or another host) is
        // applied on this pass; without it the checkout only moved when a chat or placements write happened to pull.
        const pulled = await pullMain();
        if (pulled) out.pull = pulled;
        d.beforeApply?.();
        const a = applyBigRoots();
        if (a) out.bigRoots = a;
        const p = await writePlacements().catch((e) => `failed: ${(e as Error).message}`);
        if (p) out.placements = p;
        const c = await writeChat().catch((e) => `failed: ${(e as Error).message}`);
        if (c) out.chat = c;
        return out;
      })().finally(() => {
        syncing = undefined;
      });
      return syncing;
    },
  };
}

export type TeamState = ReturnType<typeof createTeamState>;
