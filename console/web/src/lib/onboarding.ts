import type { Onboarding, OnboardingTick, Socials } from "@/api";
import { ownerName, socialWorld } from "@/lib/identity";

/**
 * the mock's scorecard, the owner as the social product's customer zero (iteration 2, 11 Nov: only what a live check proves):
 * no Google sign-in on cloud.social.app recorded yet, the vault waits on his Confirm so no item is checked, X and Reddit
 * signed in only on the platform's browser, the product page and a pinned campaign done, no post out from his own team. 2 of 6.
 */
const T = (id: OnboardingTick["id"], title: string, line: string, state: OnboardingTick["state"], today: string, how: string, fix: string | null, proof: string): OnboardingTick => ({ id, title, line, state, today, how, fix, proof });
const WAIT = "Not checked: your helper is not confirmed in your Bitwarden yet.";
export function mockOnboarding(world = socialWorld()): Onboarding {
  return {
    world,
    product: "social",
    site: "cloud.social.example",
    done: 2,
    of: 6,
    ticks: [
      T("signin", "Sign in", "With Google or GitHub", "part", "Your login sam+memo@example.com has sessions, but none from your own Google or GitHub sign-in on cloud.social.example.", "A login that opens only your team signed in with Google or GitHub on the customer site. Older sessions do not count.", "Tap Continue with Google on cloud.social.example.", "3 session(s) of sam+memo@example.com, none made by Google or GitHub on cloud.social.example."),
      T("vault", "Your team vault", "Every login and key in your Bitwarden", "part", "Your helper joined your Bitwarden but waits for your Confirm, so nothing of your team can be saved or checked there yet.", "Your team's helper is confirmed in your Bitwarden and finds an item for every login and key your team uses.", "Press Confirm on the helper under Members in your Bitwarden.", `Helper: accepted, waiting for ${ownerName()}'s Confirm. 0 of 9 logins and keys found.`),
      T("accounts", "Your social accounts", "Signed in on your team's own browser", "part", "X and Reddit signed in only on the platform's browser, not yet on your team's own.", "Your team's own browser finds you signed in on each channel. A browser lent by the platform does not count.", "Save your X login in your Bitwarden: your team signs in to X itself.", "Your team's own browser signed in: none. Lent browser only: X and Reddit."),
      T("product", "Your product", "What you promote, in your words", "done", "Your product page is written, with memo.example.com.", "Your product page exists in your team's repo, with your website.", null, "data/product.md found, website https://memo.example.com."),
      T("campaign", "Your first campaign", "Pinned, with where and how often", "done", "Get testers is pinned, with its channel, cadence and measure.", "A pinned campaign names its channel, how often it posts and what it measures.", null, "1 campaign(s), 1 pinned."),
      T("post", "Your first post out", "You OK it, it goes out from your team", "todo", "No post of a pinned campaign has gone out yet.", "A post of that campaign is live, its numbers are counted, and your accounts are on your team's own browser.", "Connect your accounts on your team's own browser, then OK the first post.", "0 post(s) of pinned campaigns, 0 out."),
    ],
    accounts: [
      { platform: "x", label: "X", state: "yellow" },
      { platform: "reddit", label: "Reddit", state: "yellow" },
    ],
    vault: [
      { name: "Your login sam+memo@example.com on cloud.social.example", kind: "login", state: "red", why: WAIT },
      { name: "X @MemoMemory", kind: "login", state: "red", why: WAIT },
      { name: "Reddit u/jordimr", kind: "login", state: "red", why: WAIT },
      { name: "X_BEARER_TOKEN (x-mcp)", kind: "key", state: "red", why: "The platform lends this key. Your team needs its own." },
    ],
    readAt: "2026-11-11T00:00:00.000Z",
  };
}

/** the mock's Connect your socials, a customer half way (helper confirmed, X saved). */
export function mockSocials(world = socialWorld()): Socials {
  const ids = [["x", "X"], ["reddit", "Reddit"], ["linkedin", "LinkedIn"], ["instagram", "Instagram"], ["tiktok", "TikTok"], ["youtube", "YouTube"]];
  return {
    world,
    stage: "ready",
    helper: { address: `${world}-vault@example.com`, server: "https://vault.bitwarden.com", state: "confirmed", at: new Date().toISOString() },
    owner: null,
    org: "Example team",
    socials: ids.map(([id, label]) => ({ id, label, inVault: id === "x", lastRead: null })),
    xConnected: true,
    connected: 1,
    platform: false,
    working: false,
  };
}
