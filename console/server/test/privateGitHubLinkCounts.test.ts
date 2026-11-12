import { describe, expect, it } from "vitest";

/**
 * a private GitHub page answers 404 to the anonymous live check; the console asks the GitHub API as itself.
 * (The rest of, a card following its row back to work, is gone with: the card is the row.)
 */
describe("T48-S23 a private GitHub link counts as live when the GitHub API sees it", () => {
  it("maps github.com pages to the API path that proves them", async () => {
    const { githubApiPath } = await import("../src/review/review.js");
    const p = (s: string) => githubApiPath(new URL(s));
    expect(p("https://github.com/Acme/home_repo/blob/main/docs/security/2026-11/agent-team-core.md")).toBe("repos/Acme/home_repo/contents/docs/security/2026-11/agent-team-core.md?ref=main");
    expect(p("https://github.com/Acme/team")).toBe("repos/Acme/team");
    expect(p("https://github.com/Acme/team/pull/12")).toBe("repos/Acme/team/pulls/12");
    expect(p("https://github.com/Acme/team/issues/3")).toBe("repos/Acme/team/issues/3");
    expect(p("https://github.com/Acme/team/actions")).toBeUndefined();
    expect(p("https://x.dev/Acme/team")).toBeUndefined();
  });

  it("a 404 the API confirms is live; one it does not stays pending; other hosts never ask it", async () => {
    const { checkLive } = await import("../src/review/review.js");
    const nf = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    const asked: string[] = [];
    const api = (exists: boolean) => async (path: string) => (asked.push(path), exists);
    const url = "https://github.com/Acme/home_repo/blob/main/docs/security/2026-11/multi-tenant.md";
    expect(await checkLive(url, undefined, { fetch: nf, githubApi: api(true) })).toMatchObject({ ok: true });
    expect(await checkLive(url, undefined, { fetch: nf, githubApi: api(false) })).toMatchObject({ ok: false, error: "answered 404" });
    expect(await checkLive("https://x.dev/gone", undefined, { fetch: nf, githubApi: api(true) })).toMatchObject({ ok: false });
    expect(asked).toHaveLength(2);
  });
});
