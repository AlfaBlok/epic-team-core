import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FEATURES_FILE, readFeatureLists, readFeatures } from "../src/book/features.js";
import { FEATURE_LIST_RULE, REVIEW_RULE } from "../src/review/review.js";
import { ROW_CLOSE_RULE } from "../src/cycle/prompts.js";

/**
 * one feature list per service, read by the console and epicspine.dev/team/, and the habit in every brief.
 */

const withRepo = (body: string | undefined, fn: (dir: string) => void) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e43s7-"));
  try {
    if (body !== undefined) {
      fs.mkdirSync(path.join(dir, path.dirname(FEATURES_FILE)), { recursive: true });
      fs.writeFileSync(path.join(dir, FEATURES_FILE), body);
    }
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

describe("the service's feature list", () => {
  it("reads the repo's data file; lines without a title or text drop; a missing or broken file gives nothing", () => {
    const file = {
      title: "What EpicTeam does for you",
      service: "EpicTeam",
      groups: [
        { id: "inbox-focus", title: "Keeps your inbox focused", features: [{ id: "a", title: "One page, one card", text: "One card per page.", rows: ["E943-S7"], since: "2026-11-08" }, { id: "b", title: "no text" }] },
        { id: "bad" },
      ],
    };
    withRepo(JSON.stringify(file), (dir) => {
      const f = readFeatures(dir, "Acme/home_repo")!;
      expect(f.groups.map((g) => g.id)).toEqual(["inbox-focus"]);
      expect(f.groups[0].features).toEqual([{ id: "a", title: "One page, one card", text: "One card per page.", rows: ["E943-S7"], since: "2026-11-08" }]);
      expect(f.href).toBe(`https://github.com/Acme/home_repo/blob/main/${FEATURES_FILE}`);
    });
    withRepo(undefined, (dir) => expect(readFeatures(dir)).toBeUndefined());
    withRepo("{not json", (dir) => expect(readFeatures(dir)).toBeUndefined());
    withRepo(undefined, (dir) => expect(readFeatureLists(dir)).toEqual([]));
  });



  it("every worker brief and every wake carry the habit: an approved feature a user can see joins the list", () => {
    expect(FEATURE_LIST_RULE).toMatch(/when Sam closes a row done \(approved\) for something new a user can see, add it to the service's feature list in the same change or the next wake/);
    expect(FEATURE_LIST_RULE).toContain(FEATURES_FILE.replace("docs/features/", "home_repo docs/features/"));
    expect(ROW_CLOSE_RULE).toContain(FEATURE_LIST_RULE);
    expect(REVIEW_RULE).toContain(FEATURE_LIST_RULE);
  });
});
