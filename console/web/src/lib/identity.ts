/**
 * Who this console is for (open core), on the web side: the server writes the owner's name, the home world, the
 * home repo, the two host ids, the memory service's name, the social world and the ops repo into the app page before the bundle (server/src/identityPage.ts), so the first paint already names them.
 * Served without it (the dev server), the open core's neutral defaults hold. Read through the functions.
 */
export interface Identity {
  owner: string;
  homeWorld: string;
  homeRepo: string;
  /** the main host's id (the server the console runs on) */
  mainHost: string;
  /** the worker host's id (the second server agents may run on) */
  workerHost: string;
  /** the memory service's name (where voice notes are kept) */
  memory: string;
  /** the id of the social world the home desk pairs with */
  socialWorld: string;
  /** the ops repo's name (the servers' tools and the secret store) */
  opsRepo: string;
  /** the GitHub owner of the home repo and the team's other repos (links) */
  org: string;
  /** the social product's name (its desk, its skin and brand) */
  socialProduct: string;
  /** the app platform keys are also set in (an app's env) */
  deployer: string;
  /** the password manager a pasted key goes into first (unset: the console's own secret store) */
  vault?: string;
}

export const NEUTRAL_IDENTITY: Identity = { owner: "the owner", homeWorld: "home", homeRepo: "team", mainHost: "main", workerHost: "worker", memory: "Memory", socialWorld: "social", opsRepo: "ops", org: "Acme", socialProduct: "SocialApp", deployer: "Deployer" };

/** a host id (mainHost or workerHost) */
export type HostId = string;

/**
 * Where this console lives, on the web side: the server writes its addresses into the same script (`sites`), so links
 * to the other skin, the customer sites and the Mac list name this console's. Neutral (example.com, none) without it.
 */
export interface Sites {
  /** the console's own address (the home world's skin) */
  teamUrl: string;
  /** the address of the social skin */
  socialUrl: string;
  /** customer sites as `host=product` pairs (team or social), the current one of each product first */
  customerHosts: string;
  /** the social product's current customer site, when it moved (the other social hosts redirect there) */
  socialMovedTo: string;
  /** the list of Mac agent tickets (a page on the worker server); none by default */
  macListUrl: string;
  /** the Epic Book's link to the owner's open questions (a plan page); none by default */
  bookQuestionsUrl: string;
}

export const NEUTRAL_SITES: Sites = { teamUrl: "https://team.example.com", socialUrl: "https://social.example.com", customerHosts: "", socialMovedTo: "", macListUrl: "", bookQuestionsUrl: "" };

declare global {
  // eslint-disable-next-line no-var
  var __IDENTITY__: (Partial<Identity> & { sites?: Partial<Sites> }) | undefined;
}

/** the sites the page carries, field by field over the neutral defaults */
export function sites(): Sites {
  const w = globalThis.__IDENTITY__?.sites;
  const out = { ...NEUTRAL_SITES };
  for (const k of Object.keys(out) as (keyof Sites)[]) if (typeof w?.[k] === "string") out[k] = w[k]!;
  return out;
}

/** the customer sites of one product (team or social), the current one first */
export function customerSitesOf(product: "team" | "social"): string[] {
  const pairs = sites().customerHosts.split(/[\s,]+/).filter(Boolean).map((x) => x.split("=")).filter(([h, p]) => h && p === product).map(([h]) => h.toLowerCase());
  const moved = product === "social" ? sites().socialMovedTo.toLowerCase() : "";
  return moved ? [moved, ...pairs.filter((h) => h !== moved)] : pairs;
}

/** the domain the console's own address sits under ("https://team.example.com" -> "example.com") */
export function siteDomain(): string {
  const parts = hostOf(sites().teamUrl).split(".");
  return parts.length > 2 ? parts.slice(1).join(".") : parts.join(".");
}

/** the host name of an address ("https://team.example.com/x" -> "team.example.com") */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

const str = (x: unknown) => (typeof x === "string" && x.trim() ? x : undefined);

/** the identity the page carries, field by field over the neutral defaults */
export function identity(): Identity {
  // window.__IDENTITY__ in the page (window is globalThis there); a test sets globalThis.__IDENTITY__
  const w = globalThis.__IDENTITY__;
  return {
    owner: str(w?.owner) ?? NEUTRAL_IDENTITY.owner,
    homeWorld: str(w?.homeWorld) ?? NEUTRAL_IDENTITY.homeWorld,
    homeRepo: str(w?.homeRepo) ?? NEUTRAL_IDENTITY.homeRepo,
    mainHost: str(w?.mainHost) ?? NEUTRAL_IDENTITY.mainHost,
    workerHost: str(w?.workerHost) ?? NEUTRAL_IDENTITY.workerHost,
    memory: str(w?.memory) ?? NEUTRAL_IDENTITY.memory,
    socialWorld: str(w?.socialWorld) ?? NEUTRAL_IDENTITY.socialWorld,
    opsRepo: str(w?.opsRepo) ?? NEUTRAL_IDENTITY.opsRepo,
    org: str(w?.org) ?? NEUTRAL_IDENTITY.org,
    socialProduct: str(w?.socialProduct) ?? NEUTRAL_IDENTITY.socialProduct,
    deployer: str(w?.deployer) ?? NEUTRAL_IDENTITY.deployer,
    ...(str(w?.vault) ? { vault: str(w?.vault) } : {}),
  };
}

/** where a pasted key goes, as people read it: the password manager when one is set, else the secret store. */
export const keyVaultName = (): string | undefined => identity().vault;

export const ownerName = (): string => identity().owner;
export const homeWorld = (): string => identity().homeWorld;
export const homeRepo = (): string => identity().homeRepo;
export const mainHost = (): HostId => identity().mainHost;
export const workerHost = (): HostId => identity().workerHost;
export const memoryName = (): string => identity().memory;
export const socialWorld = (): string => identity().socialWorld;
export const opsRepo = (): string => identity().opsRepo;
export const homeOrg = (): string => identity().org;
export const socialProduct = (): string => identity().socialProduct;
export const deployerName = (): string => identity().deployer;
/** a repo's page on GitHub under the home org (the home repo when no name is given) */
export const githubRepoUrl = (repo: string = homeRepo()): string => `https://github.com/${homeOrg()}/${repo}`;
