import { ownerName } from "../identity.js";

/**
 * Asks only the owner can do never wake the Unblocker. Measured over one week, most of its real wakes were for a new
 * ask it could only leave on the hard floor, and most of the rest re-assessed an ask already left on the floor because
 * its wording changed.
 *
 * An ask is the owner's alone when its label is `do` (a step the owner takes in person) or its why-you text names the
 * owner's identity (sign-in, account, password vault), money (pay, card, spend, price), the owner's phone or computer
 * (or browser), or a public send (publishing, posting, a mail or reply in the owner's name, contacting someone). Such an
 * ask is carried as `left` with its floor item, never assessed: the floor makes it the owner's whatever the score.
 */
export type OwnerOnlyFloor = "jordi_hands" | "new_money" | "new_public_exposure";
export interface OwnerOnly {
  floor: OwnerOnlyFloor;
  why: string;
}

const RULES: { floor: OwnerOnlyFloor; words: string; re: RegExp }[] = [
  { floor: "new_money", words: "money", re: /\b(money|spends?|spending|pay|pays|paying|payments?|(?:your|his|her|their|credit|bank) card|stripe|prices?|wallet|stars|credits?|bank|invoices?|budget)\b/i },
  { floor: "jordi_hands", words: "the owner's phone or computer", re: /\b(phone|mac|laptop|chrome|browser|qr)\b/i },
  {
    floor: "jordi_hands",
    words: "the owner's identity",
    re: /\b(sign[- ]?ins?|signs in|log[- ]?ins?|logs in|accounts?|bitwarden|passwords?|identity|master password)\b/i,
  },
  {
    floor: "new_public_exposure",
    words: "a public send",
    re: /\b(publish(es|ed|ing)?|publicly|posts? (publicly|in)|in (your|his|her|their) (own )?name|(your|his|her|their) (own )?mailbox|sends?|sent|e-?mails?|repl(y|ies) to|contacts?|contacting|third part(y|ies)|(your|his|her|their) (father|mother))\b/i,
  },
];

/** The words a carried owner-only ask is shown with. */
export const ownerOnlyWords = () => `only ${ownerName()} can do this`;

/** Why an ask is the owner's alone (undefined: the Unblocker may assess it). `kind` is the ask label, `whyYou` its why-you text. */
export function ownerOnly(kind: string | undefined, whyYou: string | undefined): OwnerOnly | undefined {
  const why = (whyYou ?? "").trim();
  for (const r of RULES) if (why && r.re.test(why)) return { floor: r.floor, why: `${ownerOnlyWords()} (${r.words}): ${why}` };
  if ((kind ?? "").trim().toLowerCase() === "do") return { floor: "jordi_hands", why: `${ownerOnlyWords()} (a step taken in person)${why ? `: ${why}` : ""}` };
  return undefined;
}

/** The run id an owner-only ask is carried from (never a real run: the console left it without a wake). */
export const OWNER_ONLY_RUN = "console:owner-only";
