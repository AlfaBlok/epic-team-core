import type { Context, Hono } from "hono";
import { z } from "zod";
import { resolveRepo } from "../adapters/repos.js";
import { currentAuth, type AuthMode } from "../auth/identity.js";
import { hasOwnerPower } from "../auth/owner.js";
import { DEFAULT_TENANT, type DB } from "../db.js";
import { dropFromWaitingField, waitOnPerson, type SpineWrite, type SpineWriter } from "../inbox/spineWrite.js";
import { worldRepos } from "../worldRepos.js";
import type { Store } from "../store.js";
import { board, dueEscalations, goalsOf, inboxFor, readWorld, type World } from "./inbox.js";
import { answerLine, approveLine, escalateLine, lineOfCode, sendBackLine, type LineEdit } from "./lines.js";
import { PEOPLE_PAGE } from "./page.js";
import { find, type Person } from "./roster.js";

/**
 * many humans on one team.
 *  - The roster is the `## People` section of the world's root spine (roster.ts); the console keeps only which login is
 *    which handle (`memberships.handle`) and which Know cards a person pressed Seen on (`people_seen`).
 *  - A login linked to a handle that is not the owner is a PERSON login: it reaches only its own inbox, the goals it is
 *    named on and the /people page (rule 2: outside humans see only their goals). Every other route answers 403
 *    `person_scope` and every other page goes to /people, in every auth mode.
 *  - Only the owner invites people, sees the board or another person's inbox (rule 4). Answers, approvals, Not sure and
 *    send-backs are ask line edits in the spine (lines.ts), committed and pushed like the owner's answers.
 *  - Asks past their person's time limit go up to whom they escalate to (`escalates to: @X after <n> h`): every
 *    `tickMs`, or at once on the owner's POST /people/escalate-due.
 */
export function ensurePeople(db: DB): void {
  const cols = (db.prepare("PRAGMA table_info(memberships)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("handle")) db.exec("ALTER TABLE memberships ADD COLUMN handle TEXT");
  db.exec(`CREATE TABLE IF NOT EXISTS people_seen (
    tenant_id TEXT NOT NULL,
    handle TEXT NOT NULL COLLATE NOCASE,
    card TEXT NOT NULL,
    seen_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, handle, card)
  )`);
}

export interface PeopleCaller {
  tenant: string;
  /** Owner powers in this world (owner login, the console host, auth off). */
  owner: boolean;
  /** The People handle of this login, when linked. */
  handle?: string;
  userId?: string;
}

/** The handle a login is in a world, or undefined. */
export function handleOf(db: DB, userId: string, tenant: string): string | undefined {
  try {
    const r = db.prepare("SELECT handle FROM memberships WHERE user_id = ? AND tenant_id = ?").get(userId, tenant) as { handle?: string | null } | undefined;
    return r?.handle?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function peopleCaller(db: DB, mode: AuthMode): PeopleCaller {
  const a = currentAuth();
  const i = a?.identity;
  // auth off, or shadow with no credential (today's console: it refuses nothing, so the caller is the home world's owner as on every
  // other page); under `on` a caller with no credential never gets here (401)
  if (!i || mode === "off" || i.kind === "none") return { tenant: DEFAULT_TENANT, owner: mode !== "on" };
  if (i.kind === "session") {
    const handle = handleOf(db, i.userId, i.tenant);
    return { tenant: i.tenant, owner: i.role === "owner", userId: i.userId, ...(handle ? { handle } : {}) };
  }
  return { tenant: i.tenant, owner: hasOwnerPower(i, a?.mode) };
}

/** Paths a person login reaches (everything else: 403 on /api, a redirect to /people for pages). */
const PERSON_API = /^\/api\/(people(\/.*)?|me|health|access\/logout)$/;
const PERSON_PAGE = /^\/(people|login)$|^\/(favicon[\w.-]*|apple-touch-icon[\w.-]*|icon-[\w.-]+|manifest[\w.-]*\.webmanifest|sw\.js)$/;
/** rule 2: a person login (a member linked to a non-owner handle) sees only its own inbox and goals. */
export function mountPersonGate(app: Hono, o: { db: DB; mode: AuthMode }) {
  app.use("*", async (c, next) => {
    const i = currentAuth()?.identity;
    if (!i || i.kind !== "session" || i.role === "owner" || !handleOf(o.db, i.userId, i.tenant)) return next();
    const p = c.req.path;
    if (PERSON_API.test(p) || PERSON_PAGE.test(p)) return next();
    if (p.startsWith("/api/")) return c.json({ error: { code: "person_scope", message: "this login sees only its own inbox and goals (/people)" } }, 403);
    return c.redirect("/people", 302);
  });
}

const textIn = z.object({ text: z.string().trim().min(1).max(4000) });
const noteIn = z.object({ note: z.string().trim().min(1).max(2000) });
const inviteIn = z.object({ handle: z.string().trim().min(1).max(60), email: z.string().trim().email().max(200), name: z.string().trim().max(120).optional() });

export interface PeopleDeps {
  db: DB;
  store: Store;
  reposRoot: string;
  mode: AuthMode;
  spine: SpineWriter;
  /** auth service bits (identity.ts): make a login and its one-time setup link. */
  addMember: (input: { email: string; tenant: string; role: "member"; name?: string }) => string;
  createSetup: (email: string) => { token: string; expiresAt: string };
  /** Each written edit: the read model and the repo views re-read it. */
  written?: (repoDir: string) => void;
  now?: () => number;
  /** Background time-limit sweep (ms; 0 or absent = only on request). */
  tickMs?: number;
}

const err = (c: Context, status: 400 | 403 | 404 | 409 | 422 | 502, code: string, message: string) => c.json({ error: { code, message } }, status);
const today = (now: number) => new Date(now).toISOString().slice(0, 10);

export function mountPeople(api: Hono, app: Hono, o: PeopleDeps) {
  ensurePeople(o.db);
  const now = () => (o.now ? o.now() : Date.now());
  const reposOf = (tenant: string) => (worldRepos(o.db, o.store, o.reposRoot, tenant) ?? []).map((r) => ({ name: r.name, path: r.path }));
  const worldOf = (tenant: string): World => readWorld(reposOf(tenant));
  const seenOf = (tenant: string, handle: string) =>
    new Set((o.db.prepare("SELECT card FROM people_seen WHERE tenant_id = ? AND handle = ?").all(tenant, handle) as { card: string }[]).map((r) => r.card));
  /** The person this caller is (their handle), or the owner on the list when the caller has owner powers. */
  const meIn = (w: World, who: PeopleCaller): Person | undefined => (who.handle ? find(w.roster, who.handle) : who.owner ? w.roster.people.find((p) => p.role === "owner") : undefined);
  const logins = (tenant: string) =>
    o.db.prepare("SELECT m.handle, u.email, u.name, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = ? AND m.handle IS NOT NULL").all(tenant) as { handle: string; email: string; name: string; role: string }[];

  api.get("/people", (c) => {
    const who = peopleCaller(o.db, o.mode);
    const w = worldOf(who.tenant);
    const me = meIn(w, who);
    const people = w.roster.people.map((p) => ({ handle: p.handle, role: p.role, area: p.area, ...(p.escalatesTo ? { escalatesTo: p.escalatesTo } : {}), ...(p.escalateAfterHours ? { escalateAfterHours: p.escalateAfterHours } : {}), ...(who.owner && p.alerts ? { alerts: p.alerts } : {}) }));
    return c.json({
      world: who.tenant,
      ...(w.rosterRepo ? { rosterRepo: w.rosterRepo } : {}),
      people,
      problems: w.roster.problems,
      me: me ? { handle: me.handle, role: me.role, owner: who.owner } : { owner: who.owner },
      ...(who.owner ? { logins: logins(who.tenant).map((l) => ({ handle: l.handle, email: l.email })) } : {}),
    });
  });

  api.get("/people/goals", (c) => {
    const who = peopleCaller(o.db, o.mode);
    const w = worldOf(who.tenant);
    const me = meIn(w, who);
    if (!me) return err(c, 404, "not_on_list", "this login is on no People list");
    return c.json({ handle: me.handle, goals: goalsOf(w, me).map((g) => ({ repo: g.repo, path: g.path, title: g.title, ...(g.code ? { code: g.code } : {}) })) });
  });

  api.get("/people/inbox", (c) => {
    const who = peopleCaller(o.db, o.mode);
    const w = worldOf(who.tenant);
    const want = c.req.query("handle")?.trim();
    const me = meIn(w, who);
    // rule 4 and 2: another person's inbox is the owner's to open
    const p = want && !(me && me.handle.toLowerCase() === want.toLowerCase()) ? (who.owner ? find(w.roster, want) : undefined) : me;
    if (want && !p) return who.owner ? err(c, 404, "not_on_list", `@${want} is not on the People list`) : err(c, 403, "owner_only", "only the owner opens another person's inbox");
    if (!p) return err(c, 404, "not_on_list", "this login is on no People list");
    return c.json(inboxFor(w, p, seenOf(who.tenant, p.handle), now()));
  });

  api.get("/people/board", (c) => {
    const who = peopleCaller(o.db, o.mode);
    if (!who.owner) return err(c, 403, "owner_only", "the board is the owner's");
    return c.json(board(worldOf(who.tenant)));
  });

  api.post("/people/invite", async (c) => {
    const who = peopleCaller(o.db, o.mode);
    if (!who.owner) return err(c, 403, "owner_only", "only the owner adds people");
    const b = inviteIn.safeParse(await c.req.json().catch(() => ({})));
    if (!b.success) return err(c, 400, "bad_request", b.error.issues.map((i) => i.message).join("; "));
    const p = find(worldOf(who.tenant).roster, b.data.handle);
    if (!p) return err(c, 404, "not_on_list", `@${b.data.handle} is not on the People list: add the line to the root spine first`);
    if (p.role === "owner") return err(c, 409, "owner", "the owner signs in with their own login");
    const owns = o.db.prepare("SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ? COLLATE NOCASE AND m.tenant_id = ? AND m.role = 'owner'").get(b.data.email, who.tenant);
    if (owns) return err(c, 409, "owner", "that login already owns this world");
    const userId = o.addMember({ email: b.data.email, tenant: who.tenant, role: "member", ...(b.data.name ? { name: b.data.name } : {}) });
    o.db.prepare("UPDATE memberships SET handle = ? WHERE user_id = ? AND tenant_id = ?").run(p.handle, userId, who.tenant);
    const s = o.createSetup(b.data.email);
    return c.json({ handle: p.handle, email: b.data.email, setupPath: `/login?setup=${encodeURIComponent(s.token)}&next=%2Fpeople`, expiresAt: s.expiresAt }, 201);
  });

  /** The owner removes a person's login from the world (the People line stays: the repo is the roster). */
  api.delete("/people/logins/:handle", (c) => {
    const who = peopleCaller(o.db, o.mode);
    if (!who.owner) return err(c, 403, "owner_only", "only the owner removes people");
    const h = c.req.param("handle");
    const rows = o.db.prepare("SELECT user_id FROM memberships WHERE tenant_id = ? AND handle = ? COLLATE NOCASE AND role != 'owner'").all(who.tenant, h) as { user_id: string }[];
    for (const r of rows) {
      o.db.prepare("DELETE FROM sessions WHERE user_id = ? AND tenant_id = ?").run(r.user_id, who.tenant);
      o.db.prepare("DELETE FROM memberships WHERE user_id = ? AND tenant_id = ?").run(r.user_id, who.tenant);
      const left = o.db.prepare("SELECT COUNT(*) AS n FROM memberships WHERE user_id = ?").get(r.user_id) as { n: number };
      if (!left.n) o.db.prepare("DELETE FROM users WHERE id = ?").run(r.user_id);
    }
    o.db.prepare("DELETE FROM people_seen WHERE tenant_id = ? AND handle = ?").run(who.tenant, h);
    return c.json({ removed: rows.length });
  });

  /** One ask line edit in its spine, as `by`. */
  /**
   * Current State's `Waiting on:` follows the line (it says who is blocked on whom): an open ask waits on whom it
   * names, an answer awaiting approval on the approver, an answer that counts on nobody.
   */
  const followWaiting = (text: string, code: string, line: string) => {
    const open = /^\s*[-*]\s+\[ask\s+[^\s:\]]+\s*:\s*\w+\s+@([^\s\]]+)/i.exec(line);
    if (open) return waitOnPerson(text, code, open[1]);
    const awaits = /·\s*awaits\s+@([^\s\]·]+)/i.exec(line);
    return awaits ? waitOnPerson(text, code, awaits[1]) : dropFromWaitingField(text, code);
  };
  const writeAsk = async (tenant: string, repoName: string, code: string, label: string, msg: string, edit: (raw: string, date: string) => LineEdit): Promise<SpineWrite | { refused: string }> => {
    if (!reposOf(tenant).some((r) => r.name === repoName)) return { refused: `${repoName} is not a repo of this world` };
    const repo = resolveRepo(o.reposRoot, repoName);
    const w = readWorld([{ name: repoName, path: repo!.path }]);
    const x = w.asks.find((a) => a.ask.code === code);
    if (!x) return { refused: `no ask ${code} in ${repoName}` };
    let refused: string | undefined;
    const r = await o.spine.edit({
      repoDir: repo!.path,
      path: x.path,
      label,
      edit: (text, date) => {
        const lines = text.split("\n");
        const at = lineOfCode(text, code);
        if (at < 0) return { skip: "the ask is not in the spine any more" };
        const cr = lines[at].endsWith("\r") ? "\r" : "";
        const e = edit(cr ? lines[at].slice(0, -1) : lines[at], date);
        if ("refused" in e) {
          refused = e.refused;
          return { skip: e.refused };
        }
        lines[at] = e.line + cr;
        const out = lines.join("\n");
        return { text: followWaiting(out, code, e.line), msg, body: `${label}\n\nWritten by the console for a person on the People list (many humans).` };
      },
    });
    if (refused) return { refused };
    if (r.status === "written") o.written?.(repo!.path);
    return r;
  };
  const answerOf = (r: SpineWrite | { refused: string }, c: Context) => {
    if ("refused" in r) return err(c, 409, "refused", r.refused);
    if (r.status !== "written") return err(c, 502, r.status, r.reason ?? "the spine write did not go through");
    return c.json({ write: r });
  };
  const actor = (c: Context): { who: PeopleCaller; me?: Person } | Response => {
    const who = peopleCaller(o.db, o.mode);
    const w = worldOf(who.tenant);
    const me = meIn(w, who);
    if (!me) return err(c, 403, "not_on_list", "this login is on no People list");
    return { who, me };
  };

  api.post("/people/asks/:repo/:code/answer", async (c) => {
    const a = actor(c);
    if (a instanceof Response) return a;
    const b = textIn.safeParse(await c.req.json().catch(() => ({})));
    if (!b.success) return err(c, 400, "bad_request", "text is required");
    const { repo, code } = c.req.param();
    const r = await writeAsk(a.who.tenant, repo, code, `Answer ${code}: @${a.me!.handle}`, `Answer ${code}: answered by @${a.me!.handle} (many humans)`, (raw, date) => answerLine(raw, a.me!.handle, b.data.text, date));
    return answerOf(r, c);
  });

  api.post("/people/asks/:repo/:code/approve", async (c) => {
    const a = actor(c);
    if (a instanceof Response) return a;
    const { repo, code } = c.req.param();
    const r = await writeAsk(a.who.tenant, repo, code, `Approve ${code}: @${a.me!.handle}`, `Approve ${code}: approved by @${a.me!.handle} (many humans)`, (raw, date) => approveLine(raw, a.me!.handle, date));
    return answerOf(r, c);
  });

  api.post("/people/asks/:repo/:code/send-back", async (c) => {
    const a = actor(c);
    if (a instanceof Response) return a;
    const b = noteIn.safeParse(await c.req.json().catch(() => ({})));
    if (!b.success) return err(c, 400, "bad_request", "note is required");
    const { repo, code } = c.req.param();
    const r = await writeAsk(a.who.tenant, repo, code, `Send back ${code}: @${a.me!.handle}`, `Send back ${code}: @${a.me!.handle} wants changes (many humans)`, (raw, date) => sendBackLine(raw, a.me!.handle, b.data.note, date));
    return answerOf(r, c);
  });

  api.post("/people/asks/:repo/:code/not-sure", async (c) => {
    const a = actor(c);
    if (a instanceof Response) return a;
    const b = noteIn.safeParse(await c.req.json().catch(() => ({})));
    if (!b.success) return err(c, 400, "bad_request", "note is required");
    const to = a.me!.escalatesTo ?? worldOf(a.who.tenant).roster.people.find((p) => p.role === "owner")?.handle;
    if (!to || to.toLowerCase() === a.me!.handle.toLowerCase()) return err(c, 409, "nobody_above", "nobody to escalate to: the People list names no one above you");
    const { repo, code } = c.req.param();
    const r = await writeAsk(a.who.tenant, repo, code, `Escalate ${code}: @${a.me!.handle} to @${to}`, `Escalate ${code}: @${a.me!.handle} is not sure, to @${to} (many humans)`, (raw, date) => escalateLine(raw, a.me!.handle, to, b.data.note, date));
    return "refused" in r || r.status !== "written" ? answerOf(r, c) : c.json({ write: r, to });
  });

  api.post("/people/asks/:repo/:code/seen", (c) => {
    const a = actor(c);
    if (a instanceof Response) return a;
    const { repo, code } = c.req.param();
    o.db.prepare("INSERT OR REPLACE INTO people_seen (tenant_id, handle, card, seen_at) VALUES (?, ?, ?, ?)").run(a.who.tenant, a.me!.handle, `${repo}/${code}`, new Date(now()).toISOString());
    return c.json({ seen: `${repo}/${code}` });
  });

  /** The time limit: every open ask past its person's `after <n> h` goes to whom they escalate to. */
  const escalateDue = async (tenant: string) => {
    const due = dueEscalations(worldOf(tenant), now());
    const out: { card: string; from: string; to: string; status: string; reason?: string }[] = [];
    for (const d of due) {
      const r = await writeAsk(tenant, d.card.repo, d.card.code, `Escalate ${d.card.code}: @${d.from} to @${d.to} (time limit)`, `Escalate ${d.card.code}: waited past @${d.from}'s ${d.hours} h, to @${d.to} (many humans)`, (raw, date) =>
        escalateLine(raw, d.from, d.to, `no answer within ${d.hours} h, passed on by the time limit`, date),
      );
      out.push({ card: d.card.id, from: d.from, to: d.to, status: "refused" in r ? "refused" : r.status, ...("refused" in r ? { reason: r.refused } : r.reason ? { reason: r.reason } : {}) });
    }
    return out;
  };
  api.post("/people/escalate-due", async (c) => {
    const who = peopleCaller(o.db, o.mode);
    if (!who.owner) return err(c, 403, "owner_only", "the owner's");
    return c.json({ escalated: await escalateDue(who.tenant) });
  });
  if (o.tickMs)
    setInterval(() => {
      const tenants = (o.db.prepare("SELECT id FROM tenants").all() as { id: string }[]).map((t) => t.id);
      void (async () => {
        for (const t of tenants) {
          const done = await escalateDue(t).catch((e) => (console.warn(`people: time limit sweep ${t}: ${(e as Error).message}`), []));
          for (const d of done) console.log(`people: ${d.card} @${d.from} → @${d.to}: ${d.status}${d.reason ? ` (${d.reason})` : ""}`);
        }
      })();
    }, o.tickMs).unref();

  app.get("/people", (c) => c.html(PEOPLE_PAGE));
}
