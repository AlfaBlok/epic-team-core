import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { gitOut } from "../src/freshness.js";
import { createPursuits } from "../src/pursuits.js";
import { createProducts, followPart, parseProducts, productOfCampaign } from "../src/products.js";
import { openDb } from "../src/db.js";
import { judge } from "../src/auth/routeScope.js";
import type { Identity } from "../src/auth/identity.js";

/**
 * a product is defined once (docs/scorecard/products.json names its deck and its kit); several objectives name
 * it and show its kit; the Products page reads the deck's four parts where they live, nothing copied.
 */
const DECK = `# Live: the product deck

<!-- personas read this -->

## Why it exists

Posting every day takes hours. [home]

## Who it is for

- Founders [home] [connect]

## How it works

1. **An idea.**
2. **Posted.**

Stat: 30 min | one voice note

## What it does for you

Read them there: [data/brief.md, Benefits](brief.md#benefits).

## How much it costs

Free.
`;
const BRIEF = `# Brief

## Voice

Plain.

## Benefits

Rules here.

| # | What it does | Benefit | Status | Screen |
|---|---|---|---|---|
| 1 | Writes posts. | You show up every day. | works today | x |
| 2 | Checks what worked. | Posts get better. | half built | |
`;

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "products-"));
  const home = path.join(root, "home_repo");
  const camp = path.join(root, "live-campaign");
  fs.mkdirSync(path.join(home, "docs/scorecard"), { recursive: true });
  fs.mkdirSync(path.join(home, "docs/kits/live/previews"), { recursive: true });
  fs.mkdirSync(path.join(camp, "data"), { recursive: true });
  // a repo checkout is a folder with .git (adapters/repos.ts)
  fs.mkdirSync(path.join(home, ".git"), { recursive: true });
  fs.mkdirSync(path.join(camp, ".git"), { recursive: true });
  fs.writeFileSync(path.join(camp, "data/product.md"), DECK);
  fs.writeFileSync(path.join(camp, "data/brief.md"), BRIEF);
  fs.writeFileSync(path.join(home, "docs/kits/live/kit.json"), JSON.stringify({ id: "live", name: "Live", tagline: "Agents that post for you", page: { accent: "#7c3bed" } }));
  fs.writeFileSync(path.join(home, "docs/kits/live/previews/banner-x.webp"), "WEBP");
  fs.writeFileSync(
    path.join(home, "docs/scorecard/products.json"),
    JSON.stringify({
      products: [
        { id: "live", name: "Live", url: "https://live.example", deck: { repo: "live-campaign", path: "data/product.md" }, kit: { dir: "docs/kits/live", files: "https://files.example/live/" } },
        { id: "other", name: "Other" },
        { id: "bad", name: "Bad", deck: { repo: "x", path: "../etc/passwd" }, kit: { dir: "/abs" } },
      ],
    }),
  );
  const line = { label: "Kit", from: "check", check: "k" };
  fs.writeFileSync(
    path.join(home, "docs/pursuits.json"),
    JSON.stringify({
      pursuits: [
        { id: "live-testers", name: "Five testers use Live", greenWhen: "five", product: "live", lines: [line] },
        { id: "live-channels", name: "Live on every channel", greenWhen: "all", product: "live", lines: [line] },
        { id: "house", name: "The house", greenWhen: "bought", lines: [line] },
      ],
    }),
  );
  const pursuits = createPursuits({ reposRoot: root, board: () => null, git: gitOut(10_000), home: "home_repo" });
  const products = createProducts({ reposRoot: root, pursuits: () => pursuits.get(), home: "home_repo" });
  return { root, pursuits, products };
}

describe("products: each defined once", () => {
  it("parses only safe products, deck and kit paths", () => {
    const ps = parseProducts(JSON.stringify({ products: [{ id: "a", name: "A", deck: { repo: "r", path: "data/product.md" } }, { id: "b", name: "B", deck: { repo: "r", path: "../x.md" }, kit: { dir: "/x" } }, { id: "a", name: "dup" }] }));
    expect(ps).toEqual([{ id: "a", name: "A", deck: { repo: "r", path: "data/product.md" } }, { id: "b", name: "B" }]);
    expect(parseProducts("not json")).toEqual([]);
  });

  it("a part that points at a section beside the deck shows that section, a benefit table as one line each", () => {
    const f = followPart("Read them there: [data/brief.md, Benefits](brief.md#benefits).", (file) => (file === "brief.md" ? BRIEF : undefined));
    expect(f).toEqual({ body: "- **You show up every day.** Writes posts.\n- **Posts get better.** Checks what worked. (half built)", from: "brief.md#benefits" });
    expect(followPart("Plain words.", () => BRIEF)).toEqual({ body: "Plain words." });
  });

  it("the page shows the deck's four parts, its kit and every objective naming it", async () => {
    const { root, products } = world();
    try {
      const body = await products.list();
      expect(body.products.map((p) => p.id)).toEqual(["live"]);
      const p = body.products[0];
      expect(p).toMatchObject({ name: "Live", tagline: "Agents that post for you", accent: "#7c3bed", kit: true, url: "https://live.example" });
      expect(p.deck?.parts.map((x) => x.label)).toEqual(["The problem it solves", "Who it is for", "How it works", "What it does for you"]);
      // the deck's source marks are left out; the benefits are read from the brief, not copied.
      expect(p.deck?.parts[0].body).toBe("Posting every day takes hours.");
      expect(p.deck?.parts[1].body).toBe("- Founders");
      expect(p.deck?.parts[2].body).toBe("1. **An idea.**\n2. **Posted.**");
      expect(p.deck?.parts[3]).toMatchObject({ from: "brief.md#benefits" });
      expect(p.wheels.map((w) => w.id)).toEqual(["live-testers", "live-channels"]);
      expect(await products.one("nope")).toBeNull();
      expect(products.kit("live")).toEqual({ product: { id: "live", name: "Live" }, kit: expect.objectContaining({ id: "live" }), files: "https://files.example/live/" });
      expect(products.kit("other")).toBeNull();
      expect(products.kitFile("live", "previews", "banner-x.webp")?.body.toString()).toBe("WEBP");
      expect(products.kitFile("live", "previews", "../kit.json")).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("several objectives share their product's one kit; an objective with no product has none", async () => {
    const { root, pursuits } = world();
    try {
      const body = await pursuits.get();
      const byId = new Map(body.pursuits.map((p) => [p.id, p]));
      expect(byId.get("live-testers")).toMatchObject({ kit: true, product: { id: "live", name: "Live" } });
      expect(byId.get("live-channels")).toMatchObject({ kit: true, product: { id: "live", name: "Live" } });
      expect(byId.get("house")?.kit).toBeUndefined();
      expect(pursuits.kit("live-testers")).toEqual({ pursuit: { id: "live-testers", name: "Five testers use Live" }, product: { id: "live", name: "Live" }, kit: expect.objectContaining({ id: "live" }), files: "https://files.example/live/" });
      expect(pursuits.kit("live-channels")?.product?.id).toBe("live");
      expect(pursuits.kitFile("live-channels", "previews", "banner-x.webp")?.body.toString()).toBe("WEBP");
      expect(pursuits.kit("house")).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("products on the social site", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-products-scope-"));
  const d = openDb(path.join(dir, "console.db"));
  const at = new Date().toISOString();
  d.prepare("INSERT INTO tenants (id, name, skin, plan, created_at) VALUES ('own-social', 'own', 'social', 'internal', ?)").run(at);
  d.prepare("INSERT INTO tenants (id, name, skin, plan, created_at) VALUES ('customer', 'c', 'console', 'team', ?)").run(at);
  const session = (tenant: string): Identity => ({ kind: "session", tenant, userId: "u", email: "e@x", name: "n", role: "owner" as never });
  it("an owner login in his own social world reads the products, one product and its kit; a customer's world does not", () => {
    for (const p of ["/api/products", "/api/products/live", "/api/products/live/kit", "/api/products/live/kit/previews/banner-x.webp", "/api/products/live/kit/fonts/a.woff2"])
      expect(judge(d, session("own-social"), "GET", p)).toEqual({ allow: true });
    expect(judge(d, session("customer"), "GET", "/api/products")).toMatchObject({ allow: false, status: 403 });
    expect(judge(d, session("own-social"), "GET", "/api/products/live/kit/other/x.webp")).toMatchObject({ allow: false, status: 403 });
    expect(judge(d, session("own-social"), "POST", "/api/products")).toMatchObject({ allow: false, status: 403 });
  });
});

describe("each campaign names its product, never repeats it", () => {
  const list = parseProducts(
    JSON.stringify({
      products: [
        { id: "notes", name: "Notes", deck: { repo: "notes-social", path: "data/product.md" }, posts: [{ repo: "notes-social" }] },
        { id: "live", name: "Live", deck: { repo: "live-campaign", path: "data/product.md" } },
        { id: "crew", name: "Crew", posts: [{ repo: "crew-campaign" }] },
        { id: "deals", name: "Deals", posts: [{ repo: "deals-campaign", community: "Deals" }] },
      ],
    }),
  );
  it("reads the product from the one list by the campaign's repo, bare name or owner/name slug", () => {
    expect(productOfCampaign(list, "acme/notes-social")).toEqual({ id: "notes", name: "Notes" });
    expect(productOfCampaign(list, "live-campaign")).toEqual({ id: "live", name: "Live" });
    expect(productOfCampaign(list, "acme/crew-campaign.git")).toEqual({ id: "crew", name: "Crew" });
    expect(productOfCampaign(list, "acme/deals-campaign")).toEqual({ id: "deals", name: "Deals" });
    expect(productOfCampaign(list, "acme/other-campaign")).toBeNull();
  });
  it("a Product: line in the campaign's spine wins, then the root spine's, by name or id", () => {
    const camp = "# Get testers\n\n## Current State\nProduct: [Crew](https://crew.example.com)\n";
    const root = "# Live campaign\nProduct: live\n";
    expect(productOfCampaign(list, "live-campaign", [camp, root])).toEqual({ id: "crew", name: "Crew" });
    expect(productOfCampaign(list, "live-campaign", [null, root])).toEqual({ id: "live", name: "Live" });
    // an unknown name falls back to the repo's product; a commented line or "Product deck:" is not a Product line
    expect(productOfCampaign(list, "live-campaign", ["Product: Nothing we know"])).toEqual({ id: "live", name: "Live" });
    expect(productOfCampaign(list, "deals-campaign", ["<!-- Product: notes -->\nProduct deck: [data/product.md](x)"])).toEqual({ id: "deals", name: "Deals" });
  });
});
