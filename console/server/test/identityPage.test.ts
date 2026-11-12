import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import { identity, resetIdentity, resetSites, setIdentity, setSites, sites } from "../src/identity.js";
import { identityIndex, identityScript, originFile, withIdentity, withOrigin } from "../src/identityPage.js";

const ID = { owner: "Sam", homeWorld: "acme", homeRepo: "acme_team", mainHost: "main", workerHost: "worker", memory: "Memory", socialWorld: "social", opsRepo: "ops", org: "Acme", socialProduct: "SocialApp", deployer: "Deployer" };

describe("the app page carries the identity", () => {
  const saved = identity();
  afterEach(() => {
    resetIdentity();
    setIdentity(saved);
  });

  it("puts one script first in the head, before the bundle, once", () => {
    const html = `<!doctype html><html><head><meta charset="UTF-8"><script type="module" src="/assets/a.js"></script></head><body></body></html>`;
    const out = withIdentity(html, ID);
    expect(out).toContain(`<head><script>window.__IDENTITY__={"owner":"Sam","homeWorld":"acme","homeRepo":"acme_team","mainHost":"main","workerHost":"worker","memory":"Memory","socialWorld":"social","opsRepo":"ops","org":"Acme","socialProduct":"SocialApp","deployer":"Deployer","sites":{"teamUrl":"https://team.example.com",`);
    expect(out).toMatch(/"bookQuestionsUrl":""\}\}<\/script><meta charset/);
    expect(out.indexOf("__IDENTITY__")).toBeLessThan(out.indexOf("/assets/a.js"));
    expect(withIdentity(out, ID)).toBe(out);
    expect(withIdentity("<p>x</p>", ID).startsWith("<script>window.__IDENTITY__=")).toBe(true);
  });

  it("a name can never end the script or open markup", () => {
    const s = identityScript({ ...ID, owner: "</script><img src=x onerror=alert(1)> & \u2028" });
    expect(s.match(/<\/script>/g)).toHaveLength(1);
    expect(s).not.toContain("<img");
    expect(s).toContain("\\u003c/script\\u003e");
    expect(JSON.parse(s.slice("<script>window.__IDENTITY__=".length, -"</script>".length)).owner).toBe("</script><img src=x onerror=alert(1)> & \u2028");
  });

  it("is made once per index version and identity", () => {
    const f = { raw: Buffer.from("<html><head></head></html>"), etag: '"a"' };
    const one = identityIndex(f, ID);
    expect(identityIndex(f, ID)).toBe(one);
    expect(identityIndex(f, { ...ID, owner: "Kim" }).etag).not.toBe(one.etag);
  });

  it("the served app page names the identity in force", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "identity-page-"));
    try {
      fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><html><head><title>x</title></head><body></body></html>");
      setIdentity(ID);
      const app = createApp(openDb(":memory:"), { staticDir: dir });
      const res = await app.request("/some/page");
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(`window.__IDENTITY__={"owner":"Sam","homeWorld":"acme","homeRepo":"acme_team","mainHost":"main","workerHost":"worker","memory":"Memory","socialWorld":"social","opsRepo":"ops","org":"Acme","socialProduct":"SocialApp","deployer":"Deployer","sites":{`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the app page's address", () => {
  it("the page as built names the neutral team address; served, it names this console's (or stays as built on the neutral one)", () => {
    const built = `<head><meta property="og:url" content="https://team.example.com/"><meta property="og:image" content="https://team.example.com/og-image.png"></head>`;
    expect(withOrigin(built, "https://console.acme.test")).toBe(`<head><meta property="og:url" content="https://console.acme.test/"><meta property="og:image" content="https://console.acme.test/og-image.png"></head>`);
    expect(withOrigin(built, "https://team.example.com")).toBe(built);
  });

  it("the steps kit names the neutral team address; served, its voice page opens on this console's", async () => {
    const kit = fs.readFileSync(path.join(__dirname, "../../web/public/steps-kit.js"));
    expect(kit.toString()).toContain('"https://team.example.com/"');
    const f = { raw: kit, etag: '"k"' };
    expect(originFile(f, "https://team.example.com")).toBe(f);
    expect(originFile(f, "https://console.acme.test").raw.toString()).toContain('"https://console.acme.test/"');
    expect(originFile(f, "https://console.acme.test")).toBe(originFile(f, "https://console.acme.test"));
    const saved = sites();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "identity-kit-"));
    try {
      fs.writeFileSync(path.join(dir, "index.html"), "<html><head></head></html>");
      fs.writeFileSync(path.join(dir, "steps-kit.js"), kit);
      setSites({ teamUrl: "https://console.acme.test" });
      const res = await createApp(openDb(":memory:"), { staticDir: dir }).request("/steps-kit.js");
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('"https://console.acme.test/"');
      expect(text).not.toContain('"https://team.example.com/"');
    } finally {
      resetSites();
      setSites(saved);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
