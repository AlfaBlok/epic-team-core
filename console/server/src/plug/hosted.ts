import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Hono } from "hono";
import type { DB } from "../db.js";
import type { Auth } from "../auth/identity.js";
import type { SpineWriter } from "../inbox/spineWrite.js";
import type { SecretPut, WorldKeys } from "./keys.js";
import type { Assignment, Milestone, Run, Store } from "../store.js";
import type { T3Client } from "../t3/client.js";
import type { Dispatcher } from "../t3/dispatcher.js";
import type { Vps3Target } from "../t3/remoteHost.js";
import type { RunT3State } from "../cycle/reconcile.js";
import type { ChatSession, SessionDeps } from "../desk/session.js";
import type { Attachments } from "../desk/attachments.js";
import type { AskContext, ConnSummary, MemoryLookup, VoiceNoteList } from "./memory.js";
import type { Notifiable } from "../notify/notice.js";
import type { Persona, RuleBroken } from "../store.js";
import type { GateDecision } from "../cycle/gateCore.js";
import type { PackRunner } from "../packRunner.js";
import type { PostReview } from "../review/postCards.js";
import { type HostId } from "../identity.js";

/**
 * The plug for the hosted layer (; map: docs/proposals/e89-repo-plan/console-core-map.md).
 *
 * The open core is the console one team runs on one server. The hosted parts (billing, worlds, social sites, the
 * Team Browser, the per-world secret store, our hosts) are plugs: core hands each one the context below and the plug
 * mounts its own routes. Core never imports a hosted module through this seam; the hosted layer passes its plugs in
 * (`createApp(db, { hosted })`) or `hostedFromEnv` picks ours. With `CONSOLE_ONE_TEAM=1` no plug is mounted and the
 * console is the bare core: the hosted routes answer 404.
 *
 * Way back: the plugs mount exactly what app.ts mounted inline before (same routes, same order in the app), so taking
 * a plug out of the list and putting its call back inline is the whole revert.
 */
export interface HostedContext {
  /** The /api router (routes mount relative to /api). */
  api: Hono;
  db: DB;
  /** The console's public URL, for links a hosted flow sends back (checkout return pages). */
  publicUrl: string;
  /** One line on the team desk (absent when the cycle is off, as in tests). */
  notify?: (text: string, id: string) => Promise<true | string>;
  /** Whether a world (tenant) exists. */
  hasTenant: (id: string) => boolean;
  /** Make a paying tester's world (the tester flow owns it). */
  makeWorld?: (signup: Record<string, any>, payment: "stripe") => Promise<any>;
}

export interface HostedPlug {
  /** Short name, shown in /api/health `plugs`. */
  name: string;
  /** Mount its routes where core mounts the plugs (billing). */
  mount?(ctx: HostedContext): void;
  /** the secret store (per-world key stores and the Secrets page); absent = the console keeps no keys. */
  secrets?(ctx: SecretsContext): SecretsArea;
  /** the Team Browser (its instances per world, their keys, the sign-in proxy); absent = no Team Browser. */
  browser?(ctx: BrowserContext): BrowserArea;
  /** credits per world (the debit, the monthly grants, the wake gate, their routes); absent = no credits, no gate. */
  credits?(ctx: CreditsContext): CreditsArea;
  /** our hosts (the Hosts view, the worker server's disk watch, runs by host, the laptop switch, the release log); absent = none. */
  hosts?(): HostsArea;
  /** many worlds (world desks, the Company view, testers and their worlds, onboarding); absent = one team. */
  tenancy?(): TenancyArea;
  /** the team's services (the memory service memory, Gmail and the team mailbox, WhatsApp, the services hub); absent = none. */
  services?(ctx: ServicesContext): ServicesArea;
  /** the social skin (campaigns, posts, the pack, its wake pre-checks and sections, site numbers); absent = none. */
  social?(ctx: { db: DB; reposRoot: string; packRunner?: PackRunner }): SocialArea;
}

/** The run-end pack check of a pack repo (hosted: cycle/packWake.ts packCheck; tests fake it). */
export type PackCheck = (o: { skillDir: string; repoDir: string; runId: string; since: string; persona: Pick<Persona, "name"> & Partial<Pick<Persona, "remit">>; now?: () => Date }) => Promise<RuleBroken | undefined>;

/** A Call's script (hosted: voice/campaign.ts). */
type CallScript = { instructions: (name: string) => string; tools: (name?: string) => any };

/** The social skin as core uses it (each made and mounted where app.ts did it). */
export interface SocialArea {
  /** The pack export cache (social/packExport.ts), passed to other plugs untouched. */
  source: unknown;
  /** the launch board (the script runs from the code repo's checkout; a timer every `everyMs`). */
  launch(o: { run?: () => Promise<string>; cacheFile?: string; everyMs?: number; teamDir: () => string | undefined }): {
    hasDrafts(): boolean;
    /** The last good board (null before the first run). */
    board(): import("../pursuits.js").BoardView | null;
    /** The Delivery Manager's section on reds with no open row (launch/board.ts launchDraftSection). */
    section(paths: Set<string>, closer: (spine: string) => boolean): string | undefined;
    mount(api: Hono): void;
  };
  /** whose posts the Publisher on `m` sends. */
  publisherContext(m: Milestone, dir: string, worldOf: (id: string) => string): unknown;
  /** the Publisher / Responder wake pre-check. */
  wakeGate(o: { repoDir: (m: Milestone) => string | undefined; worldOf: (id: string) => string; browserUrls: (m: Milestone) => string[]; browserHeaders: (url: string) => Record<string, string> }): (a: Assignment, m: Milestone, p: Persona, runs: Run[], opts?: { readOnly?: boolean }) => Promise<GateDecision | undefined>;
  /** a pack repo's wake section and the Writer brief. */
  packSection(skillDir: string, dir: string, m: Milestone, p: Persona, since: string | undefined, worldOf: (id: string) => string): Promise<string | undefined>;
  roleBrief(skillDir: string, dir: string, m: Milestone, p: Persona, since: string | undefined, worldOf: (id: string) => string): Promise<string | undefined>;
  packCheck: PackCheck;
  /** a campaign's Call, a world desk's. */
  campaignCall: CallScript;
  worldDeskCall: CallScript;
  /**..S27, the social routes and the writer (the wake gate moves late posts with it). */
  mountRoutes(o: { api: Hono; store: Store; skillDir?: string; wake?: (id: string, note: string) => Promise<unknown>; recordAssignments: (s: Store) => any; teamDir: () => string | undefined }): void;
  /** the site numbers and the hourly KPI read, held posts as cards, campaigns, the digest. */
  mountSites(o: {
    api: Hono;
    store: Store;
    skillDir?: string;
    codeViews?: ((repo: string) => Promise<{ date: string; count: number }[]>) | null;
    referrers?: ((repo: string) => Promise<string[]>) | null;
    kpiEveryMs?: number;
    browserUrls: (world: string) => string[];
    browserHeaders: (url: string) => Record<string, string>;
    record: { milestones: (s: Store) => any; personas: (s: Store) => any; assignments: (s: Store) => any };
    socialUrl: string;
    digestBase: string;
    notify?: (text: string, id: string) => Promise<true | string>;
  }): { campaigns: unknown; postReview: PostReview };
  /** every site's past days of a world. */
  sitesDaily(store: Store, world: string): unknown;
  /** a product deck's live page with its numbers read now (hourly cache). */
  livePage(repo: string | undefined): Promise<unknown>;
}

/** What core hands the services plug: createApp's `mcp` (tests fake its backends), passed through untouched. */
export interface ServicesContext {
  api: Hono;
  db: DB;
  options?: object;
}

/** A the memory service helper's answer wording (hosted: a hosted services module AskWorder). */
export type AskWorderShape = (question: string, context: string, names: string[]) => Promise<{ answer: string; refs: string[]; model: string; costUsd: number }>;

/** The WhatsApp notifier as core uses it (hosted: notify/whatsapp.ts). */
export interface Notifier {
  alert(kind: string, text: string): Promise<unknown>;
  tick(): Promise<unknown>;
}

/** the memory service's connections per world as core uses them (hosted: a hosted services module, a hosted services module). */
export interface MemoryArea {
  summary(world: string): ConnSummary | undefined;
  worlds(): string[];
  connected(world: string): boolean;
  tick(): Promise<unknown>;
  /** a posted Chat note or an ended call to the world's the memory service (absent: the forward is off). */
  forward?: { enqueue(id: string): void; enqueueCall(id: string): void };
}

type Post = (text: string, page?: string, clientRequestId?: string) => Promise<true | string>;

/** The team's services as core uses them (each made and mounted where app.ts did it). */
export interface ServicesArea {
  /** the wake's Team services section (the last probe results only: a wake never waits on a service). */
  wakeSection(personaId: string, runId: string): Promise<string | undefined>;
  /** the memory service's entry reader and voice-note lister (the memory plug, plug/memory.ts). */
  memory: MemoryLookup;
  voiceNotes: VoiceNoteList;
  /** who words the memory service helper's answer, on the console's text model. */
  askWorder(o: { onClaude: boolean; anthropicKey: () => Promise<string | undefined>; openAiKey: () => Promise<string | undefined>; worder?: unknown }): { worder: AskWorderShape; model: string };
  /** the skill whose one holder per world sends WhatsApp. */
  notifySkill: string;
  /** the WhatsApp notifier and its routes (the skill's). */
  whatsapp(o: { api: Hono; push: (pending: Notifiable[]) => Promise<string[]>; sources: () => Promise<Notifiable[]>; options?: object; store: Store; setSkills: (personaId: string, skills: string[]) => Promise<unknown> }): Notifier;
  /** the team mailbox (a reply naming a row lands on it). */
  mail(o: { repos: () => { name: string; dir: string }[]; spineMilestone: (repo: string, spine: string) => Promise<string | undefined>; wake?: (milestoneId: string, note: string) => Promise<unknown>; post: Post }): void;
  /** the memory service per world, the forward, the helper; mounted where app.ts mounted them. */
  memoryArea(o: {
    teamName: (world: string) => string;
    worldMilestones: (world: string) => { id: string; title: string }[];
    onPosted: (world: string, ref: string, capturedAt: string | undefined, via: string | undefined) => void;
    post: (world: string, deskId: string, text: string, page?: string, clientRequestId?: string) => Promise<true | string>;
    callChat: (c: { id: string; world: string; milestoneId: string | null }) => Promise<string | undefined>;
    askContext: (world: string) => Promise<AskContext>;
    askWorder?: AskWorderShape;
    pollSearches: (world: string) => unknown;
    connections?: object;
    forward?: object;
  }): MemoryArea;
  /** the Services page, the hub, the mail settings and poll, the Gmail MCP (the team mailbox's timer with them). */
  mountRoutes(o: { recordAccess: (...a: any[]) => any; recordCap: (...a: any[]) => any }): void;
}

/** A world's Team desk thread as core uses it (hosted: desk/worldDesk.ts). */
export interface WorldDesksArea {
  chatFor(world: string): ChatSession;
  view(world: string): ReturnType<ChatSession["view"]>;
  send(world: string, text: string, page?: string, clientRequestId?: string): ReturnType<ChatSession["send"]>;
  tick(): Promise<void>;
  /** The header a world desk's own call carries (X-Console-Run). */
  runHeader(world: string): string;
  /** The world token header of a persona's curl. */
  bearer(world: string, personaId: string): string;
  /** GET/POST /tenants/:id/desk/messages. */
  mount(api: Hono, store: Store, attachments: Attachments, said: (world: string, text: string, clientRequestId?: string, pending?: boolean) => void): void;
}

/** What the tester worlds give core back (hosted: testerWorld.ts). */
export interface TesterWorldsArea {
  billingOf: (world: string) => string | undefined;
  makeSignupWorld: (i: { email: string; name: string; product: "team" | "social"; provider: string; host: string; visitSource?: string }) => Promise<{ world: string }>;
  makeWorld: (signup: Record<string, any>, payment: "stripe") => Promise<any>;
  onSitesChanged: (world: string) => void;
}

/** Many worlds as core uses them (each made and mounted where app.ts did it). Opaque values (the social source,
 * the campaigns) pass from the social plug through core untouched. */
export interface TenancyArea {
  worldDesks(d: SessionDeps & { publicUrl: string; reposRoot: string; deskRepo?: string }): WorldDesksArea;
  /**..S9 the Company view's reads (and's uptime checks every `uptimeEveryMs`). */
  mountCompanies(o: { api: Hono; db: DB; reposRoot: string; social: unknown; sitesDaily: (world: string) => unknown; spinesOf?: (dir: string) => Promise<unknown>; memberships: (userId: string) => any; get: (path: string) => Promise<Response>; uptimeEveryMs?: number }): void;
  /** companies set on screen and a wheel's notes; returns the wheel's voice note filer. */
  mountCompanyWrites(o: { api: Hono; reposRoot: string; spine: SpineWriter; send: (milestoneId: string | undefined, text: string, page?: string, clientRequestId?: string) => Promise<unknown>; hasMilestone: (id: string) => boolean }): { filedVoice(f: { id: string; world: string; milestoneId?: string; fill: boolean; page?: string; words: string; audio: string }): Promise<unknown> };
  /** GET /tenants/:id/onboarding. */
  mountOnboarding(o: { api: Hono; db: DB; store: Store; reposRoot: string; social: unknown; ownBrowser: (w: string) => string | undefined; lentBrowsers: (w: string) => string[]; siteHeaders: (url: string) => Record<string, string>; customerSites: () => any; hosts: (w: string) => string[] }): void;
  /** the Testers page. */
  mountTesters(o: { api: Hono; db: DB; notify?: (text: string, id: string) => Promise<true | string> }): void;
  /** a signup made a working world. */
  mountTesterWorlds(o: { api: Hono; db: DB; reposRoot: string; campaigns: unknown; socialUrl: string; wake?: (id: string, note: string) => Promise<{ id: string } | undefined>; browser?: object; consoleUrl: string; wakeHold: (world: string) => string | undefined; notify?: (text: string) => void }): TesterWorldsArea;
}


/** What the Hosts view reads (hosted: cycle/hosts.ts HostsOptions, the part app.ts passes). */
export interface HostsViewContext {
  api: Hono;
  store: Store;
  enabled: boolean;
  t3?: T3Client;
  dispatcher?: Dispatcher;
  worker?: Vps3Target;
  hostOf: (assignmentId: string) => HostId | undefined;
  runT3State: (runId: string) => RunT3State | undefined;
  staleRunMs?: number;
}

/** the worker server's disk watch as core uses it (hosted: status/hostDisk.ts). */
export interface DiskWatch {
  health(): unknown;
  /** The Delivery Manager's wake section, when the disk is low. */
  section(): string | undefined;
  start(everyMs: number): void;
}

/** Our hosts as core uses them (each mounted where app.ts mounted it). */
export interface HostsArea {
  /** GET /hosts and POST /hosts/the worker server/wake. */
  mountView(ctx: HostsViewContext): void;
  /** the worker server's free space watch. */
  diskWatch(o: { probe: () => Promise<string>; minFreePct?: number; log: (m: string) => void; alert: (text: string) => void }): DiskWatch;
  /** GET /host-disk. */
  mountDisk(api: Hono, disk: () => DiskWatch | undefined): void;
  /** GET /runs/hosts. */
  mountRunHosts(api: Hono, store: Store): void;
  /** the laptop switch; `stepOf` reads the Mac ticket's step `step`. */
  mountLaptop(api: Hono, o: { db: DB; notify?: (text: string, id: string) => Promise<unknown>; release: (egress: string) => number; stepOf: (t: { page?: string; url?: string }, step: string) => any }): void;
  /** GET /releases and /api/releases. */
  mountReleases(app: Hono, api: Hono): void;
}

/** the credits gate's owner notice as a spine ask (app.ts wires it to inbox/raise.ts); `ref` is what `notice_id` keeps. */
export interface CreditNotice {
  /** Write the notice into the milestone's spine; resolves to its ref (`spine:<milestone id>:<code>`), or undefined if not written. */
  raise(m: Milestone, text: { question: string; proposedAction: string }): Promise<string | undefined>;
  /** Credits are back: take the ask out of the spine. */
  retire(ref: string): Promise<void>;
}

/** What core hands the credits plug. */
export interface CreditsContext {
  db: DB;
  store: Store;
  notice: () => CreditNotice;
}

/** Credits as core uses them (hosted: credits/routes.ts, credits/gate.ts). */
export interface CreditsArea {
  /** Charge every collected run once (after a usage collection, and in the sweep). */
  debit(ids?: string[]): void;
  /** The monthly plan grants that are due. */
  monthly(): void;
  /** Hold a wake of a world out of credits (the held run), or undefined to wake as usual. */
  gate(a: Assignment, m: Milestone): Run | undefined;
  /** Mount the credits routes (where app.ts mounted them). */
  mount(api: Hono): void;
}

/** The Team Browser proxy's options (createApp's `browser`; tests point it at a fake). */
export interface BrowserOptions {
  browserUrl?: string;
  worldUrls?: Record<string, string>;
  publicUrl?: string;
  browserKey?: (world: string) => string | undefined;
}

/** What core hands the browser plug. */
export interface BrowserContext {
  api: Hono;
  db: DB;
  /** createApp's `browser` (default: from env, auth/routes.ts browserProxyOptionsFromEnv). */
  options?: BrowserOptions;
  /** createApp's `browserInstances` (tester worlds' own instances; tests fake the runner). */
  instances?: object;
}

/** The Team Browser as core uses it. */
export interface BrowserArea {
  /** The instances a world's personas read (its own first). */
  urlsFor(world: string): string[];
  /** The world an instance URL belongs to. */
  worldOf(url: string): string | undefined;
  /** The world's own instance. */
  own(world: string): string | undefined;
  /** The key headers for a world's instance. */
  headersOfWorld(world: string): Record<string, string>;
  /** The key headers for an instance URL (none when no world owns it). */
  headersFor(url: string): Record<string, string>;
  /** Mount the sign-in proxy's /api routes (where app.ts mounted them); `auth` is createApp's. */
  mount(o: { auth: Auth; onSitesChanged?: (world: string) => void }): void;
  /** Mount the Mac's sync script route on the root app (after the /api routes). */
  mountScript(app: Hono): void;
  /** What the hosted world maker takes from this plug (its instances and keys), passed through untouched. */
  forWorlds: object;
}

/** What core hands the secrets plug. */
export interface SecretsContext {
  api: Hono;
  db: DB;
  reposRoot: string;
  spine: SpineWriter;
  /** Tests fake the `secret put` runner and point the Secrets page at fixtures. */
  secretPut?: SecretPut;
  secrets?: object;
  worldSecretsKey?: string;
}

export type AddKeyAnswer =
  | { ok: true; stored: { app: string; name: string; deployed: boolean } }
  | { ok: false; status: 400 | 403 | 409 | 502 | 503; code: string; message: string };

/** The secret store as core uses it: the key asks' store, the Secrets page, a steps page's key box. */
export interface SecretsArea {
  /** Where a pasted key goes, per world. */
  keys: WorldKeys;
  /** Mount the Secrets page's routes (called where app.ts mounted them). */
  mount(): void;
  /** A steps page's key box (store only). */
  addKey(i: { app: string; name: string; value: string; note: string; replace: boolean; file?: boolean }): Promise<AddKeyAnswer>;
  /** Whether a world's own store holds the key. */
  hasWorldKey(world: string, app: string, name: string): boolean;
}

export function oneTeam(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CONSOLE_ONE_TEAM === "1";
}

/** Mount every plug once, in order; returns the names mounted. */
export function mountPlugs(plugs: readonly HostedPlug[], ctx: HostedContext): string[] {
  const names: string[] = [];
  for (const p of plugs) {
    if (names.includes(p.name)) continue;
    p.mount?.(ctx);
    names.push(p.name);
  }
  return names;
}

/** Where a hosted layer may sit for a source tree at `dir` (server/src): beside it, or in a hosted tree next to core/. */
export function hostedEntries(dir: string): string[] {
  return [path.join(dir, "hosted", "index"), path.resolve(dir, "../../../../hosted/console/server/src/hosted/index")];
}

/**
 * Load the hosted layer when its folder is there (hostedEntries): `hosted/index` registers its plugs and hooks
 * (plug/hooks.ts). The path is computed, so the core builds and runs without the folder; CONSOLE_ONE_TEAM=1 skips it.
 * Returns whether it loaded.
 */
export async function loadHosted(dir: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (oneTeam(env)) return false;
  const base = hostedEntries(dir).find((b) => fs.existsSync(`${b}.ts`) || fs.existsSync(`${b}.js`));
  if (!base) return false;
  await import(pathToFileURL(`${base}.js`).href);
  return true;
}
