// the main server full-suite guard (vitest-host-guard.ts beside the console, imported by every vitest config).
import { describe, expect, it } from "vitest";
import { fullSuiteRefusal, hasTestFilter } from "../../vitest-host-guard";

const cli = (...args: string[]) => ["/usr/bin/node", "/x/node_modules/vitest/vitest.mjs", ...args];

describe("vitest full-suite guard on the main server", () => {
  it("refuses an unfiltered run on vps-a9-1 and names the way out", () => {
    for (const args of [[], ["run"], ["run", "--reporter", "dot"], ["--run", "--maxWorkers=1"], ["watch"], ["run", "--", "--silent"]]) {
      const msg = fullSuiteRefusal(cli(...args), "vps-a9-1", {});
      expect(msg, args.join(" ")).toMatch(/full suite refused on vps-a9-1.*worker server.*VPS1_FULL_SUITE=1/);
    }
  });

  it("allows filtered runs on vps-a9-1", () => {
    for (const args of [
      ["run", "test/foo.test.ts"], ["foo"], ["run", "--reporter", "dot", "src/a.test.ts"], ["run", "-t", "deploy"],
      ["run", "--testNamePattern=x"], ["related", "src/a.ts"], ["run", "--changed"], ["list"],
    ]) {
      expect(fullSuiteRefusal(cli(...args), "vps-a9-1", {}), args.join(" ")).toBeNull();
    }
  });

  it("allows everything elsewhere, with VPS1_FULL_SUITE=1, and outside the vitest CLI", () => {
    expect(fullSuiteRefusal(cli("run"), "host2", {})).toBeNull();
    expect(fullSuiteRefusal(cli("run"), "vps-a9-1", { VPS1_FULL_SUITE: "1" })).toBeNull();
    expect(fullSuiteRefusal(["/usr/bin/node", "/x/node_modules/vitest/dist/workers/forks.js"], "vps-a9-1", {})).toBeNull();
    expect(fullSuiteRefusal(["/usr/bin/node", "/x/node_modules/.bin/vite", "build"], "vps-a9-1", {})).toBeNull();
    expect(fullSuiteRefusal(["/usr/bin/node", "/x/node_modules/.bin/vitest", "run"], "vps-a9-1", {})).not.toBeNull();
  });

  it("does not read an option's value as a file filter", () => {
    expect(hasTestFilter(["run", "--config", "vitest.config.ts"])).toBe(false);
    expect(hasTestFilter(["run", "--config=vitest.config.ts"])).toBe(false);
    expect(hasTestFilter(["run", "--config", "vitest.config.ts", "test/a.test.ts"])).toBe(true);
  });
});
