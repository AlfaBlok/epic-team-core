import os from "node:os";
import path from "node:path";
/**
 * Who this console is for (open core): the owner's name, the home world's id and the home repo's checkout name.
 *
 * The open core ships neutral defaults; a hosted layer sets its own values before the server loads (its first import),
 * a unit can set them with CONSOLE_OWNER_NAME, CONSOLE_HOME_WORLD and CONSOLE_HOME_REPO, and the server entry takes the
 * owner's name from the home world's tenant row once the database is open. Read through the functions, at call time:
 * a value copied into a module-level constant would miss a later set.
 */
export interface Identity {
  /** the person the team works for, as prompts and pages name him or her */
  owner: string;
  /** the id of the home world (the default tenant every unscoped row belongs to) */
  homeWorld: string;
  /** the checkout name of the home repo (the team's own repo under REPOS_ROOT) */
  homeRepo: string;
  /** the id of the main host: the server the console runs on (its T3, its seats); stored on personas, runs and links */
  mainHost: string;
  /** the id of the worker host: the second server agents may run on, reached over a tunnel */
  workerHost: string;
  /** the memory service's name as people read it (voice notes come from it, the desk cites it) */
  memory: string;
  /** the id of the social world the home desk pairs with (its own desk, the desk-to-desk notes) */
  socialWorld: string;
  /** the ops repo: the checkout that holds the servers' tools, the secret store and its approvals (also the home world's secret backend id) */
  opsRepo: string;
  /** the GitHub owner (user or organisation) of the home repo and the team's other repos: links and prompt text name it */
  org: string;
  /** the social product's name as people read it (the social world's desk, its login page and page head) */
  socialProduct: string;
  /** the app platform keys are also set in (an app's env), as people read it */
  deployer: string;
}

export const NEUTRAL_IDENTITY: Identity = { owner: "the owner", homeWorld: "home", homeRepo: "team", mainHost: "main", workerHost: "worker", memory: "Memory", socialWorld: "social", opsRepo: "ops", org: "Acme", socialProduct: "SocialApp", deployer: "Deployer" };

/** a host id (mainHost or workerHost) */
export type HostId = string;

let set: Partial<Identity> = {};
/** the owner's name from the home world's tenant row (openDb), below a set value and the environment */
let rowOwner: string | undefined;

function fromEnv(env: NodeJS.ProcessEnv): Partial<Identity> {
  const v = (k: string) => env[k]?.trim() || undefined;
  // host ids go into SQL defaults and ssh paths: a plain id or nothing
  const id = (k: string) => (/^[A-Za-z0-9_.-]+$/.test(v(k) ?? "") ? v(k) : undefined);
  return {
    owner: v("CONSOLE_OWNER_NAME"),
    homeWorld: v("CONSOLE_HOME_WORLD"),
    homeRepo: v("CONSOLE_HOME_REPO"),
    mainHost: id("CONSOLE_MAIN_HOST"),
    workerHost: id("CONSOLE_WORKER_HOST"),
    memory: v("CONSOLE_MEMORY_NAME"),
    socialWorld: id("CONSOLE_SOCIAL_WORLD"),
    opsRepo: id("CONSOLE_OPS_REPO"),
    org: id("CONSOLE_HOME_ORG"),
    socialProduct: v("CONSOLE_SOCIAL_PRODUCT"),
    deployer: v("CONSOLE_DEPLOYER_NAME"),
  };
}

/** the identity in force: set values first, then the environment, then the neutral defaults */
export function identity(env: NodeJS.ProcessEnv = process.env): Identity {
  const e = fromEnv(env);
  return {
    owner: set.owner ?? e.owner ?? rowOwner ?? NEUTRAL_IDENTITY.owner,
    homeWorld: set.homeWorld ?? e.homeWorld ?? NEUTRAL_IDENTITY.homeWorld,
    homeRepo: set.homeRepo ?? e.homeRepo ?? NEUTRAL_IDENTITY.homeRepo,
    mainHost: set.mainHost ?? e.mainHost ?? NEUTRAL_IDENTITY.mainHost,
    workerHost: set.workerHost ?? e.workerHost ?? NEUTRAL_IDENTITY.workerHost,
    memory: set.memory ?? e.memory ?? NEUTRAL_IDENTITY.memory,
    socialWorld: set.socialWorld ?? e.socialWorld ?? NEUTRAL_IDENTITY.socialWorld,
    opsRepo: set.opsRepo ?? e.opsRepo ?? NEUTRAL_IDENTITY.opsRepo,
    org: set.org ?? e.org ?? NEUTRAL_IDENTITY.org,
    socialProduct: set.socialProduct ?? e.socialProduct ?? NEUTRAL_IDENTITY.socialProduct,
    deployer: set.deployer ?? e.deployer ?? NEUTRAL_IDENTITY.deployer,
  };
}

/** set some or all of the identity (a hosted layer at load, the server entry from the tenant row, a test) */
export function setIdentity(next: Partial<Identity>): void {
  for (const k of ["homeWorld", "homeRepo", "mainHost", "workerHost", "socialWorld", "opsRepo", "org"] as const)
    if (next[k] != null && !/^[A-Za-z0-9_.-]+$/.test(next[k]!)) throw new Error(`identity: ${k} must be a plain id, got ${JSON.stringify(next[k])}`);
  set = { ...set, ...Object.fromEntries(Object.entries(next).filter(([, x]) => typeof x === "string" && x.trim())) };
}

/** set only what is not set yet (a hosted layer's own values: a value set before it, like a test's neutral owner, wins) */
export function setIdentityDefaults(next: Partial<Identity>): void {
  setIdentity(Object.fromEntries(Object.entries(next).filter(([k]) => set[k as keyof Identity] == null)));
}

/** the owner's name as the home world's tenant row holds it (openDb reads it; a set value or the environment wins) */
export function ownerFromRow(name: string | undefined | null): void {
  rowOwner = name?.trim() || undefined;
}

/** forget every set value (tests) */
export function resetIdentity(): void {
  set = {};
  rowOwner = undefined;
}

export const ownerName = (): string => identity().owner;
export const homeWorld = (): string => identity().homeWorld;
export const homeRepo = (): string => identity().homeRepo;
export const mainHost = (): HostId => identity().mainHost;
export const workerHost = (): HostId => identity().workerHost;
/**
 * The platform's home world, read from this one place: the world whose owner login holds the platform's powers
 * (secrets, servers, other workspaces, deploys) and which no customer site opens. `CONSOLE_PLATFORM_WORLD` names it; unset
 * (the switch off, the default) it is the home world, as before. Set (say `home`), the home world stays where the
 * data lives (unscoped rows, the servers' own callers) but becomes a plain workspace for its people: its owner opens it on
 * the customer site like any customer, and the platform world's login works as the platform on the private console.
 */
export const platformWorld = (env: NodeJS.ProcessEnv = process.env): string => {
  const v = env.CONSOLE_PLATFORM_WORLD?.trim();
  return v && /^[A-Za-z0-9_.-]+$/.test(v) ? v : homeWorld();
};
/** the switch is on: the platform lives in its own world, the home world is a plain workspace for its people */
export const platformMoved = (env: NodeJS.ProcessEnv = process.env): boolean => platformWorld(env) !== homeWorld();
/** the memory service's name (voice notes, the desk's citations) */
export const memoryName = (): string => identity().memory;
/** the social world the home desk pairs with */
export const socialWorld = (): string => identity().socialWorld;
/** the ops repo's checkout name (the servers' tools, the secret store and its approvals; the home world's secret backend) */
export const opsRepo = (): string => identity().opsRepo;
/** the GitHub owner of the home repo (links: https://github.com/<org>/<repo>) */
export const homeOrg = (): string => identity().org;
/** the social product's name (the social desk, its login page and page head; the team product is EpicTeam) */
export const socialProduct = (): string => identity().socialProduct;
/** the app platform's name (a key "set in <deployer>"; the key store's `deployed` flag) */
export const deployerName = (): string => identity().deployer;
/** one of the two host ids (a value read from the database, a request or a seat name) */
export const isHostId = (h: unknown): h is HostId => h === mainHost() || h === workerHost();

/** the owner's lines in a voice call's transcript carry this speaker value (the page sends it, stored calls keep it) */
export const OWNER_WHO = "owner";
const ownerWhoAliases = new Set<string>();
/** an older speaker value that still means the owner (a hosted layer's stored calls) */
export function addOwnerWhoAlias(w: string): void {
  ownerWhoAliases.add(w);
}
/** whether a transcript line's speaker is the owner (the current value or an older one a hosted layer registered) */
export const isOwnerWho = (w: unknown): boolean => w === OWNER_WHO || (typeof w === "string" && ownerWhoAliases.has(w));

/** the owner's name as a regular expression source (for parsers of text the console wrote with it) */
export const ownerPattern = (): string => ownerName().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** the memory service's name as a regular expression source (parsers of the voice-note lines the console wrote) */
export const memoryPattern = (): string => memoryName().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Where this console lives (open core): its public addresses and the hosts around it. Neutral defaults; a
 * hosted layer sets its own at load (setSitesDefaults, like the identity), and the environment still wins where a
 * call site reads it (CONSOLE_TEAM_URL, CONSOLE_SOCIAL_URL, CONSOLE_CUSTOMER_HOSTS,...).
 */
export interface Sites {
  /** the console's own address (the home world's skin) */
  teamUrl: string;
  /** the address of the social skin (other worlds) */
  socialUrl: string;
  /** customer sites as `host=product` pairs (auth/gate.ts customerHosts); none by default */
  customerHosts: string;
  /** the customer site social worlds moved to (auth/gate.ts socialMovedTo); none by default */
  socialMovedTo: string;
  /** the builder logins of the customer sites as `provider|login|product|login` (auth/oauth.ts); none by default */
  customerLogins: string;
  /** private network addresses by name, for links shown to people (book/deliverables.ts) */
  tailnetNames: Record<string, string>;
  /** the reply voice server (voice/speak.ts) */
  replyVoiceUrl: string;
  /** who web push services may contact about this console (a mailto: URL) */
  contact: string;
  /** the mail sending account (Cloudflare Email Sending) for sign-up and reset mail (auth/emailAccess.ts); none by default = no mail */
  mailAccount: string;
  /** the YouTube channel handles the YouTube Allow link may store keys for (auth/youtubeConnect.ts); none by default */
  youtubeChannels: string;
  /** one-button connects (auth/connects.ts ConnectSpec): an account its owner connects with one tap; none by default */
  connects: import("./auth/connects.js").ConnectSpec[];
  /** the console's state folder under the home directory (its database, job server state; stateDir()) */
  stateDir: string;
  /** the seat broker's folder under the home directory (seats, the T3 token, providers, the watchdog pause; seatDir()) */
  seatDir: string;
  /** where every host keeps its checkouts (`<root>/<repo name>`; hostReposRoot()); empty: ~/github of the console */
  reposRoot: string;
  /** the cloud the seeded hosts rent from (the hosts table's provider) */
  hostProvider: string;
  /** the console's own root-only key folder (one file per key name, read with sudo -n; keyFile()) */
  keyStore: string;
  /** the key store's names-only index (0644, no values; CONSOLE_SECRET_INDEX still wins) */
  keyIndex: string;
  /** the author and committer email of the commits the console writes */
  gitEmail: string;
  /** the list of Mac agent tickets (a page on the worker server; the web client links it); none by default */
  macListUrl: string;
  /** the Epic Book's link to the owner's open questions (a plan page); none by default */
  bookQuestionsUrl: string;
  /** the servers' wheel (its wheel.json): its red key results wake their owner repo's Delivery Manager; none by default */
  serverWheelUrl: string;
  /** how other hosts reach the main host over ssh (an ssh config alias) */
  mainSsh: string;
  /** the epic that owns the daily press test: its spine in the home repo, its code and the row that runs the test */
  pressTest: { spine: string; epic: string; row: string };
  /** the first-party page counter the sign-in page tells its sign-up steps to (a `…/api/public/pv` address, no cookie); none by default */
  pageCounter: string;
}

export const NEUTRAL_SITES: Sites = {
  teamUrl: "https://team.example.com",
  socialUrl: "https://social.example.com",
  customerHosts: "",
  pageCounter: "",
  socialMovedTo: "",
  customerLogins: "",
  tailnetNames: {},
  replyVoiceUrl: "http://127.0.0.1:18940",
  contact: "mailto:owner@example.com",
  mailAccount: "",
  youtubeChannels: "",
  connects: [],
  stateDir: "team_console",
  seatDir: "team_m0",
  reposRoot: "",
  hostProvider: "cloud",
  keyStore: "/etc/console-keys/console",
  keyIndex: "/var/lib/console-keys/index.json",
  gitEmail: "console@example.com",
  macListUrl: "",
  bookQuestionsUrl: "",
  serverWheelUrl: "",
  mainSsh: "main",
  pressTest: { spine: "docs/spines/buttons-never-fail.md", epic: "EPIC-900", row: "E900-S2" },
};

let sitesSet: Partial<Sites> = {};

/** the sites in force: set values over the neutral defaults (call sites add their environment variable on top) */
export function sites(): Sites {
  return { ...NEUTRAL_SITES, ...sitesSet };
}

/** set some or all of the sites (a test) */
export function setSites(next: Partial<Sites>): void {
  sitesSet = { ...sitesSet, ...Object.fromEntries(Object.entries(next).filter(([, x]) => x != null)) };
}

/** set only what is not set yet (a hosted layer's own values: a value set before it, like a test's, wins) */
export function setSitesDefaults(next: Partial<Sites>): void {
  setSites(Object.fromEntries(Object.entries(next).filter(([k]) => sitesSet[k as keyof Sites] == null)));
}

/** forget every set site (tests) */
export function resetSites(): void {
  sitesSet = {};
}

/** the console's state folder (sites().stateDir under the home directory) */
export const stateDir = (home: string = os.homedir()): string => path.join(home, sites().stateDir);

/** the seat broker's folder (sites().seatDir under the home directory) */
export const seatDir = (home: string = os.homedir()): string => path.join(home, sites().seatDir);

/** the file of one key in the console's own key store (sites().keyStore) */
export const keyFile = (name: string): string => `${sites().keyStore}/${name}`;

/** the key store's names-only index: CONSOLE_SECRET_INDEX, else sites().keyIndex */
export const keyIndexFile = (env: NodeJS.ProcessEnv = process.env): string => env.CONSOLE_SECRET_INDEX || sites().keyIndex;

/** the folder every host keeps its checkouts in (`<root>/<repo name>`, the same path on each host) */
export const hostReposRoot = (): string => sites().reposRoot || path.join(os.homedir(), "github");

/** the host name of an address ("https://team.example.com/x" -> "team.example.com"); the input when it is not a URL */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

/** the domain the console's own address sits under ("https://team.example.com" -> "example.com") */
export function siteDomain(): string {
  const h = hostOf(sites().teamUrl);
  const parts = h.split(".");
  return parts.length > 2 ? parts.slice(1).join(".") : h;
}
