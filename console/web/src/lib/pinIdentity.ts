import type { Identity, Sites } from "@/lib/identity";

/**
 * The hosted console's identity (src/hosted/identity.ts) for tests: the web suite names a neutral owner
 * (hostedIdentity.test.setup.ts), and a test that checks our own words pins ours. The glob is optional, like the
 * hosted plug's: without src/hosted there is nothing to pin and the neutral identity stays.
 */
const found = import.meta.glob<{ OUR_IDENTITY?: Identity; OUR_SITES?: Sites }>("../../../../../hosted/console/web/src/hosted/identity.ts", { eager: true });
export const HOSTED_IDENTITY: Identity | undefined = Object.values(found)[0]?.OUR_IDENTITY;
export const HOSTED_SITES: Sites | undefined = Object.values(found)[0]?.OUR_SITES;

/** the suite's identity: the hosted console's with a neutral owner, home world, home repo, host ids, memory name, social world and ops repo */
export function suiteIdentity(): Partial<Identity> {
  return { ...HOSTED_IDENTITY, owner: "Sam", homeWorld: "home", homeRepo: "home_repo", mainHost: "main", workerHost: "worker", memory: "Memory", socialWorld: "social", opsRepo: "ops", org: "Acme", socialProduct: "SocialApp", deployer: "Deployer" };
}

/** pin the hosted console's own identity (the owner's name included) for a test that checks our words; `over` keeps some fields neutral */
export function pinOurIdentity(over: Partial<Identity> = {}): void {
  globalThis.__IDENTITY__ = { ...HOSTED_IDENTITY, ...over };
}

/** pin only the hosted console's two host ids, for a test that checks our host names */
export function pinOurHosts(): void {
  globalThis.__IDENTITY__ = { ...globalThis.__IDENTITY__, mainHost: HOSTED_IDENTITY?.mainHost, workerHost: HOSTED_IDENTITY?.workerHost };
}

/** pin only the hosted console's memory name and social world, for a test that checks our product and world words */
export function pinOurMemory(): void {
  globalThis.__IDENTITY__ = { ...globalThis.__IDENTITY__, memory: HOSTED_IDENTITY?.memory, socialWorld: HOSTED_IDENTITY?.socialWorld, socialProduct: HOSTED_IDENTITY?.socialProduct };
}

/** pin only the hosted console's home world, for a test that checks our world's id */
export function pinOurWorld(): void {
  globalThis.__IDENTITY__ = { ...globalThis.__IDENTITY__, homeWorld: HOSTED_IDENTITY?.homeWorld };
}

/** pin only the hosted console's home repo, for a test that checks our repo's name */
export function pinOurRepo(): void {
  globalThis.__IDENTITY__ = { ...globalThis.__IDENTITY__, homeRepo: HOSTED_IDENTITY?.homeRepo, org: HOSTED_IDENTITY?.org };
}

/** pin the hosted console's addresses (its two skins, customer sites, Mac list), for a test that checks our sites */
export function pinOurSites(): void {
  globalThis.__IDENTITY__ = { ...globalThis.__IDENTITY__, sites: HOSTED_SITES };
}
