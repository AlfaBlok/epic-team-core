import { describe, expect, it } from "vitest";
import { nameProblem, pinText, slugOf } from "../src/pagePins.js";

const reg = (pages: object[]) => `${JSON.stringify({ hosts: ["pages.example"], pages }, null, 2)}\n`;
const SCORE = { port: 9442, row: "E907-S3", repo: "team", epic: "EPIC-906", title: "Team scorecard" };

describe("a pinned page has a plain name", () => {
  it("refuses a code, an empty or a long name", () => {
    expect(nameProblem("Scorecard")).toBe("");
    expect(nameProblem("Server health")).toBe("");
    for (const bad of ["EPIC-906 scorecard", "E907-S3", "Voice notes (L4)", "", "x".repeat(41)]) expect(nameProblem(bad)).not.toBe("");
  });

  it("pins with the name and a short address made from it", () => {
    const out = JSON.parse(pinText(reg([SCORE]), { port: 9442, pinned: true, name: "  Server   health " }));
    expect(out.pages[0]).toMatchObject({ pinned: true, name: "Server health", slug: "server-health" });
  });

  it("renames and keeps the address already shared", () => {
    const out = JSON.parse(pinText(reg([{ ...SCORE, pinned: true, name: "Team scorecard", slug: "scorecard" }]), { port: 9442, pinned: true, name: "Scorecard" }));
    expect(out.pages[0]).toMatchObject({ name: "Scorecard", slug: "scorecard" });
  });

  it("unpins and keeps the name; a taken or screen address is never given", () => {
    expect(JSON.parse(pinText(reg([{ ...SCORE, pinned: true, name: "Scorecard" }]), { port: 9442, pinned: false })).pages[0].pinned).toBeUndefined();
    const taken = JSON.parse(pinText(reg([SCORE, { port: 9, slug: "engine", title: "x" }]), { port: 9442, pinned: true, name: "Engine" }));
    expect(taken.pages[0].slug).toBeUndefined();
    expect(slugOf("Pages")).toBe("");
  });

  it("refuses a code name, an unknown page, and writes nothing new when unchanged", () => {
    expect(() => pinText(reg([SCORE]), { port: 9442, pinned: true, name: "EPIC-906" })).toThrow(/plain words/);
    expect(() => pinText(reg([SCORE]), { port: 1, pinned: true, name: "X y" })).toThrow(/not on the list/);
    const once = pinText(reg([SCORE]), { port: 9442, pinned: true, name: "Scorecard" });
    expect(pinText(once, { port: 9442, pinned: true, name: "Scorecard" })).toBe(once);
  });
});
