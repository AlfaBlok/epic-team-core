import type { HostedPlug } from "./hosted.js";
import type { DB } from "../db.js";
import type { Vps3Target } from "../t3/remoteHost.js";
import type { SecretPut, SecretPutInput, SecretStoreResult } from "./keys.js";
import type { GatewayExtra } from "../gateway/gateway.js";
import { ownerName } from "../identity.js";

/**
 * The hosted layer's hooks: what core modules deep in the console ask of the hosted layer,
 * each with the one-team answer as its default. Core reads `hooks.<name>`; it never imports a hosted module.
 *
 * The hosted layer registers itself once (`registerHosted`, from hosted/console/server/src/hosted/index.ts when that folder
 * is present and CONSOLE_ONE_TEAM is not 1): its plugs become createApp's default plug list and their hooks replace the
 * defaults below. The server entry loads that folder by a computed path (loadHosted), so the core builds without it;
 * the test suite loads it in its setup file, as the hosted build does.
 *
 * Way back per hook: put the hosted call back at the call site (each hook names the function it stands for).
 */

/** A world's wake hold reason, or undefined when it may wake (hosted: cycle/worldGate.ts worldWakeGate). */
export type WorldWakeHold = (world: string | undefined) => string | undefined;
/** The code a held wake answers with (409). */
export const WORLD_WAKE_HOLD_CODE = "world_needs_box";

/**
 * a world whose wakes run on its own job servers, never on a shared host. The cycle
 * hands such a world's wake to `start` instead of a T3 thread; the world gate is open for exactly these worlds.
 * Hosted: cycle/jobRoute.ts (a world on CONSOLE_JOB_SERVER_WORLDS whose jobs are on: a Stripe payment or a coupon).
 */
export interface JobRoute {
  /**
   * This world's wakes run on its own route now (listed, jobs on). With `personaId`, that persona's wakes (a world can
   * move into its sandbox one persona at a time); without it, true only when the whole world has moved.
   */
  handles(world: string | undefined, personaId?: string): boolean;
  /** where the route runs this world's (persona's) jobs, in words, and the run's `route` value; default a job server. */
  where?(world: string, personaId?: string): { words: string; route: string };
  /**
   * the workspace whose job servers run this milestone's wakes, when the milestone (of another world, the owner's
   * home world) is routed there one milestone at a time; undefined = the milestone follows its own world.
   */
  boxFor?(milestoneId: string, world: string): string | undefined;
  /** The console as the job's agent reaches it: the agent gateway through the job's ssh tunnel. */
  base: string;
  /** Hand one wake to a job server of the world; resolves when the job ended (never throws). */
  start(i: JobStart): Promise<JobEnd>;
  /**
   * one chat turn of the world on a job server of its own with its own AI (never our seats): the prompt is the
   * desk's seed and the chat so far; resolves with the agent's reply text (never throws). None = this console has no chat route.
   */
  chat?(i: JobChatTurn): Promise<JobEnd & { reply?: string }>;
  /**
   * wait again for a job that outlived a console restart (a sandboxed job keeps running on its host; the console
   * that started it is gone). Resolves when the job ended, like `start`; `detached` again when this console stops too.
   * None = this route's jobs end with the console that started them.
   */
  resume?(i: { runId: string; world: string; personaId?: string }): Promise<JobEnd>;
}
export interface JobChatTurn {
  /** the turn's id (a safe name: letters, digits, `._-`). */
  turnId: string;
  world: string;
  personaId: string;
  prompt: string;
}
export interface JobStart {
  runId: string;
  world: string;
  assignmentId: string;
  personaId: string;
  model: string;
  /** The wake stub the job's agent runs (its curls read the per-job token from the job's memory). */
  stub: string;
  /** the milestone's repo (owner/name): a sandboxed job works in its own clone of it. */
  repo?: string;
  /** the workspace whose job server runs it (boxFor), when not `world` itself; the job then clones `repo`. */
  box?: string;
}
export interface JobEnd {
  ok: boolean;
  /** ok | vault | timeout | failed | off (provision.py job-report's words) */
  result: string;
  server?: string;
  detail?: string;
  /**
   * the job is still running on its host but this console stopped waiting for it (a restart): the run stays
   * open and its token alive; the next console re-attaches with `resume` and records the real end.
   */
  detached?: boolean;
}

/** The world gate with the job worlds let through (their wakes never reach a shared host). */
export const openForJobs = (hold: WorldWakeHold, route: JobRoute | undefined): WorldWakeHold =>
  route ? (world) => (route.handles(world) ? undefined : hold(world)) : hold;

export interface HostedHooks {
  /** The wake / chat seed text of a world's persona: its curls carry the world token (hosted: tenancy/agentAuth.ts withWorldAuth). */
  worldPrompt(text: string, w: { tenant: string; personaId: string; consoleUrl?: string; /** a wake on its world's own job servers */ job?: boolean }): string;
  /** Every curl in the text carries the world token (hosted: tenancy/agentAuth.ts curlsWithWorldAuth). */
  worldCurls(text: string, w: { tenant: string; personaId: string; /** a job on a job server */ job?: boolean }): string;
  /** The wake gate for worlds on shared hosts (hosted: cycle/worldGate.ts worldWakeGate). */
  worldWakeGate(env?: NodeJS.ProcessEnv): WorldWakeHold;
  /** Its state for /api/health (hosted: cycle/worldGate.ts worldWakeGateState). */
  worldWakeGateState(env?: NodeJS.ProcessEnv): { on: boolean; sharedHostWorlds: string[] };
  /** The job servers' route for worlds of model A (hosted: cycle/jobRoute.ts createJobRoute); none in the one-team core. */
  jobRoute(db: DB): JobRoute | undefined;
  /** Where a pasted key is stored (hosted: inbox/secretPut.ts, secrets/worlds.ts, secrets/worldStore.ts). */
  keys: KeyHooks;
  /** Live counts read from our sites for the red line's band (hosted: social/remoteCounts.ts). */
  counts: CountHooks;
  /** A repo's campaign spines (hosted: social/campaignPlan.ts listCampaignSpines); none in the one-team core. */
  /** A campaign's held one-pager draft under a review row (hosted: social/campaignPlan.ts approveHeldDraft, isHeldDraftRow). */
  heldDraft: { approve(spineText: string, ref: string, day: string, by?: string): string | undefined; isHeld(spineText: string, ref: string): boolean };
  /** The hosts we run consoles on (hosted: devCopy.ts, staging.ts, stagingCopy.ts, box.ts, the hosted second-host module, status/hostDisk.ts, siteKpis.ts). */
  host: HostHooks;
  campaignSpines(repoDir: string): { code: string; name: string; path: string; platform: string | null; deck?: string | null }[];
  /**
   * Shared persona text as a customer workspace reads it: its own owner's name, none of the home team's references
   * (hosted: tenancy/workspaceText.ts). The core's default only swaps the home owner's name for the workspace owner's.
   */
  workspaceText(text: string, owner: string): string;
}

/** One live count on a band: the number (null when never read), where it came from, when it was read. */
export interface LiveCountShape {
  label: string;
  source: string;
  value?: number | null;
  sourceText?: string;
  note?: string;
  page?: { name: string; address: string; url: string };
}

/** A ssh destination the console reaches a second host by. */
export interface SshTarget {
  ssh: string;
  sshKey?: string;
  knownHosts: string;
}

type Fetch = (req: Request, ...rest: any[]) => Response | Promise<Response>;

export interface HostHooks {
  /** Before anything reads the env: a dev copy, staging or a customer box force their switches. */
  applyEnv(env: NodeJS.ProcessEnv): { devCopy: boolean; staging: boolean; box: boolean };
  /** Once the db is open (a box makes its one team). */
  afterDb(db: DB): void;
  /** The second coding host (the worker server), when the env names one. */
  secondHost(): Vps3Target | undefined;
  /** Its ssh access, for transcript scans, pre-wake pulls and repo indexes there. */
  secondHostSsh(): SshTarget | undefined;
  /** A free-space probe of the second host's volumes. */
  diskProbe(t: SshTarget): (() => Promise<string>) | undefined;
  /** The server's fetch as this host serves it (a dev copy refuses writes, staging answers its banner routes). */
  wrapFetch<F extends Fetch>(fetch: F, o: { db: DB; mode: { devCopy: boolean; staging: boolean }; preflight: (req: Request, peer?: string) => { status: number; code: string; message: string } | undefined }): F;
  /** Old route names this host still answers (rewritten to the core's names before anything reads the path); none in the core. */
  aliasRoutes<F extends Fetch>(fetch: F): F;
  /** The host's own agent-gateway routes (hosted: a workspace's included AI); none in the core. */
  gatewayExtra(db: DB): GatewayExtra | undefined;
  /** The words the start line adds for this host's mode. */
  modeNote(mode: { devCopy: boolean; staging: boolean }): string;
  /** GitHub traffic readers for the Performance page; none in the core. */
  codeViews: ((repo: string) => Promise<{ date: string; count: number }[]>) | null;
  referrers: ((repo: string) => Promise<string[]>) | null;
}

export interface CountHooks {
  /** A count's source as `<name>#<field>`, or undefined when no source by that name is known (hosted: remoteSourceId). */
  sourceId(raw: string): string | undefined;
  /** The counts with their numbers read now (hosted: readCounts over the shared remoteCounts cache). */
  read(counts: { label: string; source: string }[]): Promise<LiveCountShape[]>;
}

export interface KeyHooks {
  /** The default store's writer (hosted: secretPutRunner, the infra repo `secret put`). */
  runner(): SecretPut;
  /** Store, retrying without the app platform when the app has none (hosted: putWithFallback). */
  putWithFallback(put: SecretPut, i: SecretPutInput): Promise<SecretStoreResult>;
  /** The answer line's words for a key stored with no env on the app platform (the hosted layer's own words). */
  storedNoDeploy(app: string): string;
  /** The answer line's words for a key stored in a world's own store (hosted: secrets/worlds.ts worldStoredMessage). */
  worldStoredMessage(world: string): string;
  /** The backend name of a world's own store (hosted: secrets/worldStore.ts WORLD_BACKEND). */
  worldBackend: string;
}

/** The one-team console keeps no keys: the secret store is the hosted layer's. */
export const NO_KEY_STORE = "this console has no secret store (the hosted layer keeps keys): nothing stored";

const ONE_TEAM: HostedHooks = {
  worldPrompt: (text) => text,
  worldCurls: (text) => text,
  worldWakeGate: () => () => undefined,
  worldWakeGateState: () => ({ on: false, sharedHostWorlds: [] }),
  jobRoute: () => undefined,
  keys: {
    runner: () => async () => ({ ok: false, err: NO_KEY_STORE }),
    putWithFallback: async (put, i) => {
      const r = await put(i);
      return r.ok ? { ok: true, deployed: false } : r;
    },
    storedNoDeploy: (app) => `stored for ${app}`,
    worldStoredMessage: (world) => `stored in the ${world} world's secret store`,
    worldBackend: "tenant",
  },
  counts: { sourceId: () => undefined, read: async () => [] },
  campaignSpines: () => [],
  host: {
    applyEnv: () => ({ devCopy: false, staging: false, box: false }),
    afterDb: () => undefined,
    secondHost: () => undefined,
    secondHostSsh: () => undefined,
    diskProbe: () => undefined,
    wrapFetch: (fetch) => fetch,
    aliasRoutes: (fetch) => fetch,
    gatewayExtra: () => undefined,
    modeNote: () => "",
    codeViews: null,
    referrers: null,
  },
  heldDraft: { approve: () => undefined, isHeld: () => false },
  workspaceText: (text, owner) => {
    const home = ownerName().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return home ? text.replace(new RegExp(`\\b${home}\\b`, "g"), owner) : text;
  },
};

/** The hooks in force (one-team defaults until the hosted layer registers). */
export const hooks: HostedHooks = { ...ONE_TEAM };

let registered: readonly HostedPlug[] = [];

/** The hosted layer's plugs, registered by the hosted layer; [] in the one-team core. */
export const registeredPlugs = (): readonly HostedPlug[] => registered;

/** Called once by the hosted layer: its plugs become createApp's default and its hooks replace the one-team ones. */
export function registerHosted(plugs: readonly HostedPlug[], h: Partial<HostedHooks>): void {
  registered = plugs;
  Object.assign(hooks, h);
}

/** Back to the bare core (tests of one-team mode). */
export function resetHosted(): void {
  registered = [];
  Object.assign(hooks, ONE_TEAM);
}
