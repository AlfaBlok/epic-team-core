import { describe, expect, it } from "vitest";
import { sameKeyTwins } from "../src/inbox/routes.js";
import type { WaitingItem } from "../src/inbox/waiting.js";

// E996-S29: two open asks for the same key (T9-A10 and a twin) are one card and one box; one save answers both.
const item = (id: string, over: Partial<WaitingItem> = {}) =>
  ({ id, source: "ask", state: "open", ask: "provide", question: id, code: id, secret: { app: "acme", name: "CLOUDFLARE_TOKEN" }, ...over }) as unknown as WaitingItem;

describe("E996-S29 same-key asks", () => {
  it("finds the other open asks that store the same key, never itself, an answered one or another key", () => {
    const a = item("A10");
    const list = [a, item("A12"), item("A13", { state: "answered" }), item("A14", { secret: { app: "acme", name: "OTHER" } }), item("A15", { secret: undefined })];
    expect(sameKeyTwins(list, a).map((i) => i.id)).toEqual(["A12"]);
    expect(sameKeyTwins(list, item("X", { secret: undefined }))).toEqual([]);
  });
});
