import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isStepId, labelEdit, readPersonaLog } from "../src/personaLog.js";

// the wheel's persona log, read from docs/persona-log/<day>.jsonl, with his labels from labels.json.
const home = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "plog-"));
  fs.mkdirSync(path.join(d, "docs/persona-log"), { recursive: true });
  return d;
};
const line = (id: string, objective: string, asked: boolean, at = "2026-11-24T04:00:00Z") =>
  JSON.stringify({ id, at, persona: "Delivery Manager", worker: false, objective, milestone: "ms_1", kr: null, row: "E907-S3", from: null, did: "x", why: "", asked, outcome: "progressed" });

describe("persona log", () => {
  it("reads one wheel's steps newest first, with his labels and the key result's counts", () => {
    const d = home();
    fs.writeFileSync(path.join(d, "docs/persona-log/2026-11-24.jsonl"), [line("run_a1111111", "alignment", false), line("run_b2222222", "alignment", true, "2026-11-24T05:00:00Z"), line("run_c3333333", "house", false)].join("\n") + "\n");
    fs.writeFileSync(path.join(d, "docs/persona-log/labels.json"), labelEdit("", "run_a1111111", "correct", "Sam"));
    const log = readPersonaLog(d, "alignment", 7, new Date("2026-11-24T06:00:00Z"));
    expect(log.steps.map((s) => s.id)).toEqual(["run_b2222222", "run_a1111111"]);
    expect(log.steps[1]!.label).toBe("correct");
    expect(log.counts).toEqual({ steps: 2, unasked: 1, correct: 1, incorrect: 0, unlabelled: 0 });
    expect(readPersonaLog(d, "milestone:ms_1", 7, new Date("2026-11-24T06:00:00Z")).steps).toHaveLength(3);
  });

  it("a label is set, replaced and cleared in the one file; ids are run ids only", () => {
    let t = labelEdit("", "run_a1111111", "correct", "Sam");
    t = labelEdit(t, "run_a1111111", "incorrect", "Sam");
    expect(JSON.parse(t).labels.run_a1111111.label).toBe("incorrect");
    expect(JSON.parse(labelEdit(t, "run_a1111111", "clear", "Sam")).labels).toEqual({});
    expect(isStepId("run_a1111111")).toBe(true);
    expect(isStepId("../../etc/passwd")).toBe(false);
  });
});
