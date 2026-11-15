import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createPagesReader, groupPages, mountPinnedAddresses, pageParentProblem, parsePages, pinnedStatus } from "../src/pagesIndex.js";

/** No floating pages: every one-off page has a parent, the Pages index links down, the gate refuses an island. */

const REG = parsePages(
  JSON.stringify({
    rule: "every page has a parent",
    hosts: ["pages.tail-example.ts.net", "10.0.0.9"],
    pages: [
      { port: 9242, title: "The daily reports", row: "E904-S56", repo: "home_repo", epic: "EPIC-904", epicTitle: "Talk to the desk" },
      { port: 9241, path: "/summary/", title: "What we did", row: "E904-S57", repo: "home_repo", epic: "EPIC-904" },
      { port: 9031, title: "Giveaway", row: "E900-S29", repo: "social", epic: "EPIC-900", epicTitle: "Social presence" },
      { port: 9010, title: "Strategy deck", row: "E973-S1", repo: "home_repo", epic: "EPIC-973", epicTitle: "Strategy" },
      { title: "no address" },
    ],
  }),
);

describe("pages index", () => {
  it("groups pages by repo then epic, the home repo first, epics by number, each page with its address", () => {
    const body = groupPages(REG, "home_repo");
    expect(body.total).toBe(4);
    expect(body.groups.map((g) => g.id)).toEqual(["home_repo-EPIC-904", "home_repo-EPIC-973", "social-EPIC-900"]);
    const desk = body.groups[0];
    expect(desk.epicTitle).toBe("Talk to the desk");
    expect(desk.pages.map((p) => [p.row, p.url])).toEqual([
      ["E904-S56", "http://pages.tail-example.ts.net:9242/"],
      ["E904-S57", "http://pages.tail-example.ts.net:9241/summary/"],
    ]);
  });

  it("the gate refuses a page-host evidence page with no entry, by name or by address", () => {
    expect(pageParentProblem("http://pages.tail-example.ts.net:9241/", REG)).toBeUndefined();
    expect(pageParentProblem("http://10.0.0.9:9031/round-3.html", REG)).toBeUndefined();
    expect(pageParentProblem("http://pages.tail-example.ts.net:9555/", REG)).toMatch(/has no parent/);
    expect(pageParentProblem("http://10.0.0.9:9555/x.html", REG)).toMatch(/has no parent/);
  });

  it("leaves evidence elsewhere alone, and every card when there is no page list", () => {
    expect(pageParentProblem("https://notes.example.com/connect", REG)).toBeUndefined();
    expect(pageParentProblem("not a url", REG)).toBeUndefined();
    expect(pageParentProblem(undefined, REG)).toBeUndefined();
    expect(pageParentProblem("http://pages.tail-example.ts.net:9555/", undefined)).toBeUndefined();
    expect(pageParentProblem("http://pages.tail-example.ts.net:9555/", { hosts: [], pages: [] })).toBeUndefined();
  });

  it("reads the home repo's docs/pages/registry.json and sees a changed file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pages-"));
    const home = path.join(root, "home_repo");
    fs.mkdirSync(path.join(home, "docs/pages"), { recursive: true });
    execFileSync("git", ["-C", home, "init", "-q"]);
    try {
      const file = path.join(home, "docs/pages/registry.json");
      fs.writeFileSync(file, JSON.stringify({ hosts: ["h"], pages: [{ port: 9001, title: "One", row: "E901-S1", repo: "home_repo", epic: "EPIC-901" }] }));
      const svc = createPagesReader({ reposRoot: root, home: "home_repo" });
      expect(svc.get().total).toBe(1);
      fs.writeFileSync(file, JSON.stringify({ hosts: ["h"], pages: [{ port: 9001, title: "One", row: "E901-S1", repo: "home_repo", epic: "EPIC-901" }, { port: 9002, title: "Two", row: "E901-S2", repo: "home_repo", epic: "EPIC-901" }] }));
      const t = new Date(Date.now() + 5000);
      fs.utimesSync(file, t, t);
      expect(svc.get().total).toBe(2);
      expect(svc.registry()?.hosts).toEqual(["h"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("pinned pages", () => {
  const reg = parsePages(
    JSON.stringify({
      hosts: ["pages.tail-example.ts.net"],
      pages: [
        { port: 9442, title: "Our scorecard", name: "Team scorecard", pinned: true, slug: "scorecard", refresh: "x.service", row: "E907-S3", repo: "home_repo", epic: "EPIC-907" },
        { port: 9443, title: "Unnamed pin", pinned: true, row: "E907-S4", repo: "home_repo", epic: "EPIC-907" },
        { port: 9444, title: "Not pinned", name: "Named", row: "E907-S5", repo: "home_repo", epic: "EPIC-907" },
      ],
    }),
  );

  it("lists only named pinned pages above the groups, with their address", () => {
    const body = groupPages(reg, "home_repo");
    expect(body.pinned.map((p) => [p.name, p.url, p.slug])).toEqual([["Team scorecard", "http://pages.tail-example.ts.net:9442/", "scorecard"]]);
    expect(body.total).toBe(3);
  });

  it("the short address redirects to the pinned page; screens and unknown names fall through to the app", async () => {
    const app = new Hono();
    const pinned = groupPages(reg, "home_repo").pinned;
    mountPinnedAddresses(app, (slug) => pinned.find((p) => p.slug === slug));
    app.get("*", (c) => c.text("app"));
    const r = await app.request("/scorecard");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("http://pages.tail-example.ts.net:9442/");
    expect(await (await app.request("/inbox")).text()).toBe("app");
    expect(await (await app.request("/nothing-here")).text()).toBe("app");
    expect(await (await app.request("/scorecard/x")).text()).toBe("app");
  });

  it("asks the page server for its last refresh and runs its refresh, and says so when it does not answer", async () => {
    const page = groupPages(reg, "home_repo").pinned[0];
    const seen: string[] = [];
    const ok = (async (url: string, init?: RequestInit) => {
      seen.push(`${init?.method} ${url}`);
      return new Response(JSON.stringify({ refreshedAt: "2026-11-14T06:17:01Z", refreshable: true, running: init?.method === "POST" }), { status: init?.method === "POST" ? 202 : 200 });
    }) as typeof fetch;
    expect(await pinnedStatus(page, ok)).toMatchObject({ refreshedAt: "2026-11-14T06:17:01Z", refreshable: true, running: false });
    expect(await pinnedStatus(page, ok, "POST")).toMatchObject({ running: true });
    expect(seen).toEqual(["GET http://pages.tail-example.ts.net:9442/_page/status", "POST http://pages.tail-example.ts.net:9442/_page/refresh"]);
    const down = (async () => {
      throw new Error("refused");
    }) as typeof fetch;
    expect((await pinnedStatus(page, down)).error).toMatch(/did not answer/);
  });
});
