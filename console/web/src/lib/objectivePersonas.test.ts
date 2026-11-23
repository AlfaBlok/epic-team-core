// an objective's Personas tab lists only its own personas, though eight objectives share the home root milestone.
import { describe, expect, it } from "vitest";
import { personasOfObjective } from "@/lib/objectivePersonas";

const A = [
  { id: "dm-listen", milestoneId: "ms_root", objective: "listening" },
  { id: "dm-bw", milestoneId: "ms_root", objective: "vault" },
  { id: "whole-team", milestoneId: "ms_root" },
  { id: "dm-house", milestoneId: "ms_house" },
  { id: "dm-testers", milestoneId: "ms_testers_epic", objective: "testers" },
];
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe("personasOfObjective", () => {
  it("a shared milestone shows only the personas that name the objective", () => {
    expect(ids(personasOfObjective(A, { id: "vault", milestoneId: "ms_root", shared: true }))).toEqual(["dm-bw"]);
    expect(ids(personasOfObjective(A, { id: "listening", milestoneId: "ms_root", shared: true }))).toEqual(["dm-listen"]);
  });
  it("a milestone of its own also shows the ones that name no objective", () => {
    expect(ids(personasOfObjective(A, { id: "buy-house", milestoneId: "ms_house" }))).toEqual(["dm-house"]);
  });
  it("one that names the objective shows on it from any milestone", () => {
    expect(ids(personasOfObjective(A, { id: "testers" }))).toEqual(["dm-testers"]);
  });
});
