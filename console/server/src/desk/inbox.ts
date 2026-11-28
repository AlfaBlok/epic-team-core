import fs from "node:fs";
import path from "node:path";
import type { Hono } from "hono";
import type { Store } from "../store.js";
import { managerState, type ManagerState } from "../inbox/asks.js";
import { homeRepo, ownerName, socialProduct } from "../identity.js";

/**
 * (the owner: "the agent team writes to other worlds desks by dropping a markdown note in their repo"):
 * the desk-to-desk note inbox. A world's desk inbox is the folder `desk/inbox/` in its home repo. Another world's agent
 * hands work over by committing ONE markdown file there and nothing else in that repo:
 *
 *   desk/inbox/<YYYY-MM-DD>-<from world>-<slug>.md
 *   ---
 *   from: the home world                       the sending world
 *   about: <one line: what is asked>
 *   reply-to: the team's code repo      the sender's home repo; the answer goes to its desk/inbox/
 *   status: open                       open → answered (the receiver sets it)
 *   in-reply-to: <path>                only on an answer: the note it answers, in the receiver's repo
 *   ---
 *   <the request in plain words>
 *
 * The receiving world's Delivery Manager reads its open notes on its next wake (an urgent note wakes it at once; this section of its wake prompt; only the
 * repo's home milestone, the one on its root spine, gets it, so one wake answers each note), acts within its own remit,
 * then answers by dropping a note in the sender's inbox and marking the received one `status: answered`. The full contract
 * is the team doc docs/desk-inbox.md (the code repo) and `scripts/desk_note.py`, which writes, lists and answers notes.
 */
export const DESK_INBOX_DIR = "desk/inbox";
/** a note that hands an approved improvement request to the world that builds it (inbox/improvement.ts). */
export const IMPROVEMENT_KIND = "improvement-request";
/**
 * the owner's product feedback, said on the social product's desk (the one desk he talks to) about this team's products,
 * passed on by that desk as one note quoting him (scripts/desk_note.py send --kind product-feedback).
 */
export const FEEDBACK_KIND = "product-feedback";

export interface DeskNote {
  /** Path inside the repo, e.g. desk/inbox/2026-11-07-the home world-hello.md */
  file: string;
  from: string;
  about: string;
  replyTo: string;
  status: string;
  inReplyTo?: string;
  /** Where its answer is (`answered:` on a note answered here). */
  answered?: string;
  /** `improvement-request` on a hand-off note (and on the builder's answers to it). */
  kind?: string;
  /** the ask it carries, `<repo>/<code>`. */
  ask?: string;
  /** the request's state on the note: open, taken (with `row`), done, declined. */
  request?: string;
  row?: string;
  campaign?: string;
  doneMeans?: string;
  /** product feedback: where and when he said it. */
  source?: string;
  /** a monitor alert handed back to its team (status/alertHandBack.ts): the alert's id. */
  alert?: string;
  /** an urgent note wakes the receiving world's Delivery Manager at once (cycle `tickUrgentNotes`). */
  urgent?: boolean;
  body: string;
}

/**
 * a note whose `about` starts "Improvement request:" (or "Re: Improvement request:") is one, with or without
 * `kind:`: a world that writes the note by hand (a social world repo, 2026-11-11) and the console's hand-off read the same.
 * desk_note.py `parse` keeps the same rule.
 */
export const IMPROVEMENT_ABOUT = /^\s*(?:re:\s*)?improvement[\s-]+request\s*:/i;
/**
 * an urgent note: `urgent: yes` in its frontmatter (desk_note.py send --urgent), or an original note whose
 * `about` starts "URGENT" (how worlds marked them by hand). An answer (`in-reply-to`) is urgent only by the field.
 * desk_note.py `is_urgent` keeps the same rule.
 */
export const URGENT_ABOUT = /^\s*urgent\b/i;
const urgentOf = (f: Record<string, string>) =>
  f.urgent ? /^(yes|true|1)$/i.test(f.urgent) : !f["in-reply-to"] && URGENT_ABOUT.test(f.about);
const kindOf = (f: Record<string, string>) => (f.kind ? f.kind.toLowerCase() : IMPROVEMENT_ABOUT.test(f.about) ? IMPROVEMENT_KIND : undefined);
/** A hand-made request names its ask in brackets, "(…)": read as `a social world repo/`. */
export function askFromAbout(about: string): string | undefined {
  if (!IMPROVEMENT_ABOUT.test(about)) return undefined;
  const m = /\(\s*([a-z0-9][\w.-]*)\s+((?:EPIC-)?[A-Z]?\d*[A-Z]*\d*-A\d+)\b/i.exec(about);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/** The frontmatter of one note (`key: value` lines between `---` fences); undefined when the file has none. */
export function parseNote(file: string, text: string): DeskNote | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return undefined;
  const f: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) f[kv[1].toLowerCase()] = kv[2].trim();
  }
  if (!f.from || !f.about) return undefined;
  return {
    file,
    from: f.from,
    about: f.about,
    replyTo: f["reply-to"] ?? "",
    status: (f.status || "open").toLowerCase(),
    ...(f["in-reply-to"] ? { inReplyTo: f["in-reply-to"] } : {}),
    ...(f.answered ? { answered: f.answered } : {}),
    ...(kindOf(f) ? { kind: kindOf(f) } : {}),
    ...(f.ask || askFromAbout(f.about) ? { ask: f.ask || askFromAbout(f.about) } : {}),
    ...(f.request ? { request: f.request.toLowerCase() } : {}),
    ...(f.row ? { row: f.row } : {}),
    ...(f.campaign ? { campaign: f.campaign } : {}),
    ...(f["done-means"] ? { doneMeans: f["done-means"] } : {}),
    ...(f.source ? { source: f.source } : {}),
    ...(f.alert ? { alert: f.alert } : {}),
    ...(urgentOf(f) ? { urgent: true } : {}),
    body: m[2].trim(),
  };
}

/**
 * every sweep (urgent notes, desk-note pass, wake news) re-read and re-parsed every world's inbox, about 2,000
 * files and 8 MB on 22 Nov, synchronously (up to 0.9 s of one blocked event loop); a note is parsed again only when its
 * file's mtime or size changes.
 */
const noteCache = new Map<string, { sig: string; note: DeskNote | undefined }>();

/** Every note in the checkout's desk inbox (README and files without frontmatter skipped), oldest name first. */
export function readInbox(checkoutDir: string): DeskNote[] {
  const dir = path.join(checkoutDir, DESK_INBOX_DIR);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".md") && n.toLowerCase() !== "readme.md");
  } catch {
    return [];
  }
  const out: DeskNote[] = [];
  const seen = new Set<string>();
  for (const n of names.sort()) {
    const f = path.join(dir, n);
    seen.add(f);
    try {
      const st = fs.statSync(f);
      const sig = `${st.mtimeMs}:${st.size}`;
      let hit = noteCache.get(f);
      if (!hit || hit.sig !== sig) {
        hit = { sig, note: parseNote(`${DESK_INBOX_DIR}/${n}`, fs.readFileSync(f, "utf8")) };
        noteCache.set(f, hit);
      }
      if (hit.note) out.push({ ...hit.note });
    } catch {
      /* unreadable: skipped */
    }
  }
  for (const f of noteCache.keys()) if (f.startsWith(dir + path.sep) && !seen.has(f)) noteCache.delete(f); // gone from the inbox
  return out;
}

export const openNotes = (notes: DeskNote[]) => notes.filter((n) => n.status === "open");

/**
 * the open urgent notes of a checkout's desk inbox, each with when it reached this checkout (the file's mtime: the
 * console's pull wrote it), for the urgent sweep (cycle `tickUrgentNotes`).
 */
export function urgentOpenNotes(checkoutDir: string): Array<{ file: string; about: string; at: string }> {
  return openNotes(readInbox(checkoutDir))
    .filter((n) => n.urgent)
    .map((n) => {
      let at: string;
      try {
        at = fs.statSync(path.join(checkoutDir, n.file)).mtime.toISOString();
      } catch {
        at = new Date().toISOString();
      }
      return { file: n.file, about: n.about, at };
    });
}

const BODY_MAX = 600;
/**
 * the wake carries at most this many notes in full (urgent first, then the oldest), then one line each for the next
 * ones up to LINES_MAX characters, then a count and the command that lists the rest (136 open notes in full
 * were 131 KB of a 235 KB wake; a wake stays under 100,000 characters).
 */
export const FULL_NOTES_MAX = 6;
export const LINES_MAX = 3_000;

const headOf = (n: DeskNote) =>
  `- ${n.urgent ? "**URGENT** " : ""}\`${n.file}\` from **${n.from}**${n.replyTo ? ` (reply to ${n.replyTo})` : ""}${n.inReplyTo ? `, answering ${n.inReplyTo}` : ""}: ${n.about}`;

/** urgent notes first, then the oldest: the first FULL_NOTES_MAX in full, the next as one line each, then the count left. */
export function noteLines(open: DeskNote[], repo: string): string[] {
  const order = [...open.filter((n) => n.urgent), ...open.filter((n) => !n.urgent)];
  const full = order.slice(0, Math.max(FULL_NOTES_MAX, open.filter((n) => n.urgent).length));
  const out = full.map((n) => {
    const body = n.body.length > BODY_MAX ? `${n.body.slice(0, BODY_MAX)}… (open the note for the rest)` : n.body;
    return [headOf(n), ...body.split("\n").map((l) => `  > ${l}`)].join("\n");
  });
  let used = 0, listed = full.length;
  for (const n of order.slice(full.length)) {
    const line = headOf(n);
    if (used + line.length > LINES_MAX) break;
    out.push(line);
    used += line.length;
    listed++;
  }
  if (listed < order.length)
    out.push(`- …and ${order.length - listed} more open note${order.length - listed > 1 ? "s" : ""}: \`python3 <${homeRepo()} checkout>/scripts/desk_note.py list <this checkout>\` lists every one (${repo}); open each note's file for its body.`);
  return out;
}

/** The Delivery Manager's wake section for its repo's open notes; undefined when none is open. */
export function deskInboxSection(notes: DeskNote[], repo: string): string | undefined {
  const open = openNotes(notes);
  if (!open.length) return undefined;
  return [
    `## Desk inbox (${open.length} open note${open.length > 1 ? "s" : ""} from other worlds)`,
    `Other worlds' teams dropped these notes in \`${DESK_INBOX_DIR}/\` of ${repo} (the desk-to-desk inbox; contract: ${homeRepo()} docs/desk-inbox.md). For each, in this wake:`,
    `1. Read it and act within your remit and write rule: a thing to do becomes a row in the right spine of this repo (owner a persona of this world), a question gets its answer, a decision only ${ownerName()} can take becomes a coded ask in your spine. You never act on the sender's world: its settings, repos and spines stay its own.`,
    `2. Answer it: drop one note in the sender's inbox (its \`reply-to\` repo, folder \`${DESK_INBOX_DIR}/\`) named \`<today>-<this world>-re-<slug>.md\` with frontmatter \`from\` (this world), \`about\`, \`reply-to\` (this repo), \`status: open\`, \`in-reply-to: <the note's path here>\`, and in the body what you did (row ids, links) or why not. Write nothing else in the sender's repo. Easiest: \`python3 <${homeRepo()} checkout>/scripts/desk_note.py reply <this checkout>/<note path> --body "…"\`.`,
    "3. Mark the received note `status: answered` (and add `answered: <reply path>`), commit both repos naming this run, push.",
    ...(open.some((n) => n.urgent)
      ? ["An **URGENT** note woke you now, ahead of your cadence: act on it first in this wake, before any other work, and answer it in this wake."]
      : []),
    ...noteLines(open, repo),
    ...(open.some((n) => n.kind === IMPROVEMENT_KIND && !n.inReplyTo)
      ? [
          `An **improvement request** note (\`kind: improvement-request\`) is work ${ownerName()} already approved on his card in the sending world (${socialProduct()} never codes, so it hands builds to this desk). Do not ask him again: make ONE ledger row for it in the spine that owns that product or site (its \`done-means\` is the row's done means, cite the note path and its \`ask\`), then answer with \`python3 <${homeRepo()} checkout>/scripts/desk_note.py reply <this checkout>/<note> --to <its reply-to checkout> --from <this world> --reply-to <this repo> --request taken --row <row code> --body \"<row code, spine link, when>\"\`. Only when it cannot be built (outside every remit here, or unsafe) answer \`--request declined\` with why. When the row later closes, \`desk_note.py done\` tells the sender what is live (listed under Improvement requests taken).`,
        ]
      : []),
    ...(open.some((n) => n.kind === FEEDBACK_KIND && !n.inReplyTo)
      ? [
          `A **product feedback** note (\`kind: product-feedback\`) is ${ownerName()}'s own words about this team's products (the console, EpicTeam, the ${socialProduct()} screens), said on his ${socialProduct()} desk: he talks only to that desk now and it passes his feedback here. Place it as you place his own voice notes (L-37, his ask is ready): his words quoted on the open row it is about, or ONE new row in the spine that owns that product (cite the note path and its \`source\`); never ask him to repeat it here. Then answer so his ${socialProduct()} desk can tell him where it landed: \`python3 <${homeRepo()} checkout>/scripts/desk_note.py reply <this checkout>/<note> --to <its reply-to checkout> --from <this world> --reply-to <this repo> --row <row code> --body \"<row code, spine link, what happens next>\"\`.`,
        ]
      : []),
    "An answer to a note this world sent (it has `in-reply-to`) needs no answer back: act on it, then mark it answered (`desk_note.py close <note> --note \"<what you did>\"`).",
    `A note from this world itself (its \`reply-to\` is this repo) is one of its own personas handing on the rest of ${ownerName()}'s words (it handled its own part): place each part as you place his voice notes (his words on an existing row or ask, a new row for a new ask, L-37), then close it with where each landed (\`desk_note.py close <note> --note \"…\"\`), no answer back.`,
  ].join("\n");
}

/**
 * GET /api/desk/inbox: the caller's world's desk inboxes, one per repo its milestones name (request-scoped store: only that
 * world's repos), every note with its status. Read-only: notes are written and answered in git (scripts/desk_note.py).
 */
/**
 * who reads a desk note sent to this repo, asked BEFORE the desk tells the owner where his words went. A note
 * lands in the repo's desk/inbox/ and only its home goal's Delivery Manager reads it (the goal on a root spine, else the
 * first: the same pick as the urgent sweep). On 22 Nov the desk told him his Adeje question "wasn't ignored" and that an
 * urgent note "wakes their manager straight away" while the Travel manager was off: both notes sat unread for hours.
 * `reads` = the next wake reads it; `urgentWakes` = an urgent note wakes someone within minutes; `say` = the one line the
 * desk tells him at once when nobody reads it.
 */
export type NoteReach = {
  repo: string;
  goal?: { id: string; title: string; path?: string };
  manager: ManagerState | "paused" | "no goal";
  reads: boolean;
  urgentWakes: boolean;
  say: string;
};
export function noteReach(d: { store: Store; resolve: (repo: string) => { path: string; name: string } | undefined }, repo: string): NoteReach | undefined {
  const r = d.resolve(repo);
  if (!r) return undefined;
  const same = d.store.listMilestones().filter((m) => !m.settledAt && m.repo && d.resolve(m.repo)?.path === r.path);
  const live = same.filter((m) => !m.paused);
  const root = (m: { path?: string | null }) => /(^|\/)root\.md$/i.test(m.path ?? "");
  const home = live.find(root) ?? live[0];
  if (!home) {
    const paused = same.length > 0;
    return {
      repo: r.name,
      manager: paused ? "paused" : "no goal",
      reads: false,
      urgentWakes: false,
      say: paused
        ? `${r.name}'s goals are all paused, so nobody reads this note until one is switched back on.`
        : `${r.name} has no goal in the console, so nobody reads this note.`,
    };
  }
  const manager = managerState(d.store, home.id);
  const goal = { id: home.id, title: home.title, path: home.path ?? undefined };
  const team = `${home.title}'s Delivery Manager`;
  const say =
    manager === "on"
      ? `${team} is on: it reads this note on its next wake, an urgent one within minutes.`
      : manager === "parked"
        ? `${team} is parked: an urgent note wakes it, a plain note waits until it is woken.`
        : manager === "off"
          ? `${team} is switched off, so nobody reads this note until it is switched on.`
          : `${home.title} has no Delivery Manager, so nobody reads this note.`;
  return { repo: r.name, goal, manager, reads: manager === "on", urgentWakes: manager === "on" || manager === "parked", say };
}

export function mountDeskInbox(
  api: Hono,
  d: {
    store: Store;
    resolve: (repo: string) => { path: string; name: string } | undefined;
    /**
     * the home world's view of every world: a note is how one world hands another work, so when the caller is the home
     * world and its own goals do not hold the repo, the world whose goal does is the one that reads it.
     */
    everyWorld?: { store: Store; callerIsHome: () => boolean };
  },
) {
  // GET /api/desk/inbox/reach?repo=<checkout or owner/name>: who reads a note sent there (desk_note.py asks it)
  api.get("/desk/inbox/reach", (c) => {
    const repo = (c.req.query("repo") ?? "").trim();
    if (!repo) return c.json({ error: "validation_error", message: "repo is required (a checkout name or owner/name)" }, 400);
    let reach = noteReach(d, repo);
    if (reach?.manager === "no goal" && d.everyWorld?.callerIsHome()) reach = noteReach({ store: d.everyWorld.store, resolve: d.resolve }, repo) ?? reach;
    return reach ? c.json(reach) : c.json({ error: "not_found", message: `${repo} is not a repo the console has checked out` }, 404);
  });
  api.get("/desk/inbox", (c) => {
    const seen = new Set<string>();
    const repos: { repo: string; open: number; notes: DeskNote[] }[] = [];
    for (const m of d.store.listMilestones()) {
      const r = m.repo ? d.resolve(m.repo) : undefined;
      if (!r || seen.has(r.path)) continue;
      seen.add(r.path);
      const notes = readInbox(r.path);
      if (notes.length || fs.existsSync(path.join(r.path, DESK_INBOX_DIR))) repos.push({ repo: r.name, open: openNotes(notes).length, notes });
    }
    return c.json({ repos });
  });
}
