import { describe, expect, it } from "vitest";
import { advisories, parseAsks } from "../src/inbox/asks.js";
import { ownBoxProblem } from "../src/inbox/phantomRefs.js";

/**
 * E996-S29 (the owner, 12 Nov: "HOW CAN I HAVE SOME TEXT REFERRING TO A PASTE IN A BOX THAT DOESN'T EXIST"): a key card
 * has its box, so its words never send him to another box (the T3 request_secret card) and never say the card has none.
 * T9-A10 in production on 13 Nov said both, under its own working box.
 */
const T9_A10 =
  "Create one Cloudflare key: open dash.cloudflare.com, My Profile, API Tokens, Create Token; then paste it in the private T3 " +
  "request_secret card the Delivery Manager sends you (it is stored as acme CLOUDFLARE_WORKERS_TOKEN), not in the console card, " +
  "which has no secret box while this ask is on the Mac list.";
const SECRET = { app: "acme", name: "CLOUDFLARE_WORKERS_TOKEN" };

describe("E996-S29 a key card names only its own box", () => {
  it("names a key card that says its card has no box, or sends the key to another card", () => {
    expect(ownBoxProblem({ ask: "provide", question: T9_A10, secret: SECRET })).toMatch(/its words say the card has no box/);
    expect(ownBoxProblem({ ask: "provide", question: "Create the token, then paste it in the private T3 request_secret card", secret: SECRET })).toMatch(
      /send Sam to paste the key in another card/,
    );
    expect(ownBoxProblem({ ask: "provide", question: "x", steps: "1) Create Token 2) paste it into the secret card the Delivery Manager sends you", secret: SECRET })).toMatch(/another card/);
  });

  it("passes a key card that points to its own box, and an ask with no box (the ask gate's rule 6 covers those)", () => {
    expect(ownBoxProblem({ ask: "provide", question: "Create one Cloudflare key, then paste it in the box Paste the key here on this card", secret: SECRET })).toBeUndefined();
    expect(ownBoxProblem({ ask: "provide", question: T9_A10 })).toBeUndefined();
  });

  it("an open key ask with those words carries an advisory on its card's checks", () => {
    const a = parseAsks(`## Waiting on\n\n- [ask T9-A10: provide @Sam since 2026-11-10] ${T9_A10} — secret: acme CLOUDFLARE_WORKERS_TOKEN`)[0];
    expect(a.secret).toEqual(SECRET);
    expect(advisories(a, [a]).some((x) => /^key card words: .*no box/.test(x))).toBe(true);
  });
});
