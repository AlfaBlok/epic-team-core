import { afterEach, describe, expect, it } from "vitest";
import { homeRepo, homeWorld, identity, NEUTRAL_IDENTITY, ownerName } from "./identity";

describe("the web client's identity", () => {
  const saved = globalThis.__IDENTITY__;
  afterEach(() => {
    globalThis.__IDENTITY__ = saved;
  });

  it("reads what the page carries", () => {
    globalThis.__IDENTITY__ = { owner: "Sam", homeWorld: "acme", homeRepo: "acme_team" };
    expect([ownerName(), homeWorld(), homeRepo()]).toEqual(["Sam", "acme", "acme_team"]);
  });

  it("falls back to the neutral defaults, field by field, when the page carries none", () => {
    globalThis.__IDENTITY__ = undefined;
    expect(identity()).toEqual(NEUTRAL_IDENTITY);
    globalThis.__IDENTITY__ = { owner: " ", homeWorld: "acme" };
    expect(identity()).toEqual({ owner: "the owner", homeWorld: "acme", homeRepo: "team", mainHost: "main", workerHost: "worker", memory: "Memory", socialWorld: "social", opsRepo: "ops", org: "Acme", socialProduct: "SocialApp", deployer: "Deployer" });
  });
});
