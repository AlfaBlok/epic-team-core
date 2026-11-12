import { describe, expect, it } from "vitest";
import { defaultEveryMinutes } from "./dialogs";
import { formatCadence } from "../lib/format";

/** the Unblocker's cadence is a slow backstop (a new ask wakes it within minutes): attaching it starts at 6 h. */
describe("T8-S25 Unblocker backstop cadence", () => {
  it("defaults to 6 h for the Unblocker, 2 h for other personas", () => {
    expect(defaultEveryMinutes("Unblocker")).toBe(360);
    expect(defaultEveryMinutes("Delivery Manager")).toBe(120);
    expect(defaultEveryMinutes(undefined)).toBe(120);
    expect(formatCadence({ type: "interval", everyMinutes: 360 })).toBe("every 6 h");
  });
});
