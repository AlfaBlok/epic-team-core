import fs from "node:fs";
import path from "node:path";
import type { Dod } from "../dod.js";
import { deriveStatus, type CurrentState, inside, isDoneStatus, normalizeStatus, readDoc, ticketIdFor, type DocInfo, type DocStatus, type SpineShape } from "./doc.js";
import { resolveRepo, type Repo } from "./repos.js";
import { noteFile } from "./fileDeps.js";
import { stripInline } from "./markdown.js";
import type { MonitorItem } from "./monitoring.js";

export interface MilestoneRef {
  id: string;
  repo: string;
  path: string;
  paused: boolean;
}

export interface Derived {
  status: DocStatus;
  dod: Dod;
  blockedReason?: string;
  /** `Waiting on:` text (context only; never implies blocked). */
  waitingOn?: string;
  stateExcerpt: string;
  /** named Current State lines (Status, Last, Result, Waiting on, Next action, Verified at). */
  state?: CurrentState;
  /** Machine-read sections found in the file (absent when it could not be read). */
  shape?: SpineShape;
  /** Current State `Monitoring:` items (waits on a time or condition); [] when none. */
  monitoring: MonitorItem[];
  /** Set when the repo or file could not be read; the other fields are then defaults. */
  docError?: string;
}

/** Same shape as the web `Ticket` (contract: read-only views). */
export interface Ticket {
  id: string;
  title: string;
  repo: string;
  milestoneId?: string;
  /** Normalised: done, blocked, active, dispatched, ready, pending, paused, "—", or a raw ticket-file / GitHub status. */
  status: string;
  /** Raw status text when it says more than `status` (e.g. "waiting on the owner's go (since 10-13)"). */
  statusDetail?: string;
  owner?: string;
  /** backlog rows: the row's `Role` cell (`Mac agent` = done on the owner's Mac, never by a server worker). */
  role?: string;
  /** Backlog rows: the row's gate cell (`Needs` column), when the table has one. */
  needs?: string;
  /** backlog rows: the row's `Depends on` cell, when the table has one. */
  dependsOn?: string;
  /** backlog rows: the row's `Next action` cell, when the table has one. */
  nextAction?: string;
  /** backlog rows: the row's date cell (`Last Verified` / `Updated`), when the table has one. */
  since?: string;
  /**
   * Backlog rows: "ledger" (Issue Ledger / Phases / Child Epics), the work-item heading ("queue", "backlog", …),
   * "ticket file" suffix when enriched from a linked ticket file (e.g. "ledger · ticket file"),
   * "ticket-root (not linked from spine)" for the fallback. Elsewhere: "tickets-dir" | "github".
   */
  source: string;
  url?: string;
  path?: string;
  /** Backlog rows with a linked file: what it is (linkKind below); only a ticket's own status overrides the row. */
  linkKind?: LinkKind;
}

/**
 * A linked file is a ticket (under a `tickets/` dir, in `Ticket root:`, or with a `Ticket ID:` header), an epic
 * (`Spine ID:` stamp) or a page (anything else: doctrine, notes). Pages have no status of their own.
 */
export type LinkKind = "ticket" | "epic" | "page";

const EMPTY_DOD: Dod = { done: 0, total: 0, items: [] };

/** `known`: the milestone's repo when the caller already resolved it (once per tree build, not per node). */
export function locate(reposRoot: string, m: Pick<MilestoneRef, "repo" | "path">, known?: Repo):
  | { repo: Repo; abs: string; info: DocInfo }
  | { error: string; repo?: Repo } {
  const repo = known ?? resolveRepo(reposRoot, m.repo);
  if (!repo) return { error: `repo ${m.repo} not found under ${reposRoot}` };
  const abs = inside(repo.path, m.path);
  if (!abs) return { error: `path ${m.path} is outside the repo`, repo };
  const info = readDoc(abs);
  if (!info) return { error: `file ${m.path} not found in ${repo.name}`, repo };
  return { repo, abs, info };
}

export function deriveMilestone(reposRoot: string, m: MilestoneRef): Derived {
  // Empty path = bootstrap in flight: the file does not exist yet, so plain defaults and no docError.
  // Status stays "active" (or "paused"); the UI labels the empty path "bootstrapping…".
  if (!m.path) return { status: m.paused ? "paused" : "active", dod: EMPTY_DOD, stateExcerpt: "", monitoring: [] };
  const loc = locate(reposRoot, m);
  if ("error" in loc)
    return { status: m.paused ? "paused" : "active", dod: EMPTY_DOD, stateExcerpt: "", monitoring: [], docError: loc.error };
  const { status, blockedReason, waitingOn } = deriveStatus(loc.info, m.paused);
  return {
    status,
    dod: loc.info.dod,
    ...(blockedReason ? { blockedReason } : {}),
    ...(waitingOn ? { waitingOn } : {}),
    stateExcerpt: loc.info.stateExcerpt,
    ...(loc.info.state ? { state: loc.info.state } : {}),
    shape: loc.info.shape,
    monitoring: loc.info.monitoring,
  };
}

function ticketFiles(dir: string): string[] {
  noteFile(dir); // a ticket file added or removed moves the directory's stamp
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md") && !/^readme\.md$/i.test(f))
      .sort()
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/** Ticket rows from a list of ticket files. */
export function ticketsFromFiles(repo: Repo, files: string[], milestoneId?: string): Ticket[] {
  const out: Ticket[] = [];
  for (const abs of files) {
    const info = readDoc(abs);
    if (!info) continue;
    out.push({
      id: ticketIdFor(abs, info),
      title: info.title ?? path.basename(abs, ".md"),
      repo: repo.remote ?? repo.name,
      milestoneId,
      status: info.statusLine ?? "unknown",
      owner: info.owner,
      source: "tickets-dir",
      path: path.relative(repo.path, abs).split(path.sep).join("/"),
    });
  }
  return out;
}

export const NOT_LINKED = "ticket-root (not linked from spine)";

/**
 * Backlog behind a milestone = this file's own work items, in doc order: Issue Ledger / Phases / Child Epics
 * rows, then rows of Queue / Backlog / Sprint / Tasks / Work items tables. A row whose cell links to a ticket
 * file, or whose id matches a file in `Ticket root:`, is enriched from that file (title when the row has none;
 * the row's owner wins). Status: a ticket file's own `Status:` (header or Current State) wins; a linked epic
 * only fills a row with no status cell (its Current State `Status:`); a linked page never sets it. Ticket root files the doc does not reference are not backlog,
 * except when the doc has no work-item rows at all: then the ticket root is listed as a fallback.
 */
/** Ledger ids that are placeholders, not item ids: rows carrying them stay separate rows. */
export const PLACEHOLDER_ID = /^(draft|tbd|todo|new|none|pending|n\/a|\?|-+|—|–)?$/i;

export function backlogFor(reposRoot: string, m: MilestoneRef, known?: Repo): Ticket[] {
  if (!m.path) return [];
  const loc = locate(reposRoot, m, known);
  if ("error" in loc) return [];
  const { repo, abs, info } = loc;
  const repoLabel = repo.remote ?? repo.name;
  const docDir = path.dirname(abs);
  const rel = (f: string) => path.relative(repo.path, f).split(path.sep).join("/");

  const rootDir = info.ticketRoot ? inside(repo.path, path.join(path.relative(repo.path, docDir), info.ticketRoot)) : undefined;
  const rootFiles = rootDir ? ticketFiles(rootDir) : [];
  const fileFor = (id: string, link?: string): string | undefined => {
    if (link) {
      const f = inside(repo.path, path.relative(repo.path, path.resolve(docDir, decodeURI(link))));
      if (f && f !== abs && readDoc(f)) return f;
    }
    return rootFiles.find((f) => ticketIdFor(f, readDoc(f)) === id);
  };

  const byId = new Map<string, Ticket>();
  const out: Ticket[] = [];
  for (const r of info.ledger) {
    // Placeholder ids (`draft` until an issue exists, `—`, `TBD`) name no item: such rows never merge.
    const placeholder = PLACEHOLDER_ID.test(stripInline(r.id));
    const prev = placeholder ? undefined : byId.get(r.id);
    if (prev) {
      // Same id in two tables (e.g. Child Epics + Issue Ledger): first position wins, later rows fill gaps.
      if (!prev.title) prev.title = r.title;
      if (!prev.owner) prev.owner = r.owner;
      if (!prev.needs && r.needs) prev.needs = r.needs;
      if (!prev.dependsOn && r.dependsOn) prev.dependsOn = r.dependsOn;
      if (!prev.nextAction && r.nextAction) prev.nextAction = r.nextAction;
      if (!prev.since && r.since) prev.since = r.since;
      if (prev.status === "—" && r.status) Object.assign(prev, normalizeStatus(r.status));
      if (!prev.path) {
        const f = fileFor(r.id, r.link);
        if (f) Object.assign(prev, enrich(prev, f));
      }
      continue;
    }
    const row: Ticket = {
      id: r.id,
      title: r.title,
      repo: repoLabel,
      milestoneId: m.id,
      ...normalizeStatus(r.status),
      owner: r.owner,
      ...(r.role ? { role: r.role } : {}),
      ...(r.needs ? { needs: r.needs } : {}),
      ...(r.dependsOn ? { dependsOn: r.dependsOn } : {}),
      ...(r.nextAction ? { nextAction: r.nextAction } : {}),
      ...(r.since ? { since: r.since } : {}),
      source: r.source,
    };
    const f = fileFor(r.id, r.link);
    const t = f ? { ...row, ...enrich(row, f) } : row;
    if (!placeholder) byId.set(r.id, t);
    out.push(t);
  }
  for (const t of out) {
    if (!t.title) t.title = t.id;
    if (t.statusDetail === undefined) delete t.statusDetail;
    if (t.owner === undefined) delete t.owner;
  }
  if (out.length > 0) return out;
  return ticketsFromFiles(repo, rootFiles, m.id).map((t) => ({ ...t, ...normalizeStatus(t.status), source: NOT_LINKED }));

  function enrich(row: Ticket, f: string): Partial<Ticket> {
    const fi = readDoc(f)!;
    const kind: LinkKind =
      fi.ticketId || rootFiles.includes(f) || /(^|\/)tickets\//.test(rel(f)) ? "ticket" : fi.spineId ? "epic" : "page";
    const own = kind === "ticket" ? fi.statusLine : kind === "epic" && row.status === "—" && !row.statusDetail ? fi.state?.status ?? undefined : undefined;
    const st = own ? normalizeStatus(own) : undefined;
    return {
      title: row.title || fi.title || path.basename(f, ".md"),
      ...(st && st.status !== "—" ? st : {}),
      owner: row.owner ?? fi.owner,
      source: `${row.source} · ticket file`,
      path: rel(f),
      linkKind: kind,
    };
  }
}

/** Open ticket files in a checkout (tickets/, docs/tickets/), non-done status only. */
export function openTicketFiles(repo: Repo): Ticket[] {
  const files = ["tickets", "docs/tickets"].flatMap((d) => ticketFiles(path.join(repo.path, d)));
  return ticketsFromFiles(repo, files).filter((t) => !isDoneStatus(t.status));
}
