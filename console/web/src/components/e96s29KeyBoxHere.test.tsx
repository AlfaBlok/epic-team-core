// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { WaitingItem } from "@/api";
import { foldSameKey, keyStepsHere, keyWordsHere, SecretBox } from "@/components/waiting";

// E996-S29 (the owner, 12 Nov: "it doesn't tell me where to paste it. And it doesn't give me enough, a box to paste it"):
// the box says Paste the key here, every step on a key card points to it, and asks for the same key are one card.

afterEach(cleanup);

const item = (id: string, over: Partial<WaitingItem> = {}) =>
  ({ id, code: id, repo: "tax", state: "open", ask: "provide", question: id, title: id, contextLinks: [], milestoneId: "ms_1", secret: { app: "acme", name: "CLOUDFLARE_TOKEN" }, ...over }) as unknown as WaitingItem;

describe("E996-S29 the key box says where the key goes", () => {
  it("labels the box Paste the key here", () => {
    render(<SecretBox item={item("T9-A10") as WaitingItem & { secret: { app: string; name: string } }} />);
    expect(screen.getByTestId("secret-box-label").textContent).toBe("Paste the key here");
    expect(screen.getByLabelText("Paste the key here")).toBeTruthy();
  });

  it("a step that points to a box elsewhere points to this card's box", () => {
    const steps = { list: ["Create Token", "then paste it in the secret card", "paste it in the private T3 request_secret card the Delivery Manager sends you"] };
    expect(keyStepsHere(steps, item("A")).list).toEqual(["Create Token", "then paste it in the box Paste the key here on this card", "paste it in the box Paste the key here on this card"]);
    expect(keyStepsHere(steps, item("A", { secret: undefined })).list[1]).toBe("then paste it in the secret card");
  });
});

describe("E996-S29 a key card's words never deny its box", () => {
  it("the ask text points to this card's box and drops 'the console card, which has no secret box' (T9-A10, 13 Nov)", () => {
    const t9 =
      "Your job: create it; then paste it in the private T3 request_secret card the Delivery Manager sends you (it is stored as acme CLOUDFLARE_TOKEN), " +
      "not in the console card, which has no secret box while this ask is on the Mac list. Never show the token in this chat.";
    expect(keyWordsHere(t9, item("A"))).toBe(
      "Your job: create it; then paste it in the box Paste the key here on this card (it is stored as acme CLOUDFLARE_TOKEN). Never show the token in this chat.",
    );
    // no box on the card: the words stay as written (the ask gate holds a box ask with no box)
    expect(keyWordsHere(t9, item("A", { secret: undefined }))).toBe(t9);
    expect(keyWordsHere(t9, item("A", { state: "answered" }))).toBe(t9);
  });
});

describe("E996-S29 asks for the same key are one card", () => {
  it("keeps the first card, names the others on it, drops them from the list", () => {
    const { items, folded } = foldSameKey([item("T9-A10"), item("T7-A12", { repo: "social" }), item("X1", { secret: { app: "acme", name: "OTHER" } }), item("X2", { state: "answered" })]);
    expect(items.map((i) => i.id)).toEqual(["T9-A10", "X1", "X2"]);
    expect(items[0].sameKey).toEqual(["T7-A12"]);
    expect([...folded]).toEqual(["T7-A12"]);
  });
});
