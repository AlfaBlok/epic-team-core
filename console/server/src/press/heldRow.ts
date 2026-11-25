import { ownerName } from "../identity.js";
import { OUT_OF_COLUMNS, type Press, type PressRequest } from "./presses.js";

/**
 * the owner's press on a row the console could read two ways is kept (press outbox, `held`) and lands by
 * itself within a minute of the row's repair. Its row is flagged to the row's owner (the milestone's Delivery
 * manager) the same minute, with this brief, never only on the 15-minute repair timer.
 */
export type HeldCard = { repo: string; path: string; ref: string; title?: string; milestoneId?: string };

/** the row a kept press writes: the review card's row, else the press's stored card, else its body's repo, path and ref. */
export function heldCard(p: Press & { request?: PressRequest }, cardOf?: (id: string) => HeldCard | undefined): HeldCard | undefined {
  try {
    const c = cardOf?.(p.target);
    if (c) return c;
  } catch {
    /* the review list is not built yet: the stored card or the body */
  }
  if (p.request?.card) return p.request.card;
  try {
    const b = JSON.parse(p.request?.body || "{}") as { repo?: unknown; path?: unknown; ref?: unknown };
    if (typeof b.repo === "string" && typeof b.path === "string" && typeof b.ref === "string") return { repo: b.repo, path: b.path, ref: b.ref };
  } catch {
    /* no body */
  }
  return undefined;
}

/** what the row's owner is told. */
export function heldRowBrief(p: Press, card: HeldCard): string {
  const m = OUT_OF_COLUMNS.exec(p.held ?? p.reason ?? "");
  const shape = m ? `${m[2]} cells under a ${m[3]}-cell header` : "cells out of line with its header";
  const who = ownerName();
  return [
    `Row flag: ${who}'s press "${p.action}" on ${card.ref}${card.title ? ` (${card.title.slice(0, 120)})` : ""} at ${p.at.slice(0, 16).replace("T", " ")}Z is kept but not written yet.`,
    `Row ${card.ref} in ${card.repo} ${card.path} has ${shape}, and it can be read more than one way, so the console wrote nothing.`,
    `Repair the row now: in ${card.repo} run \`python3 scripts/ledger_rows.py repair --commit\`, or rebuild it by column with \`python3 scripts/ledger_rows.py set ${card.ref} …\`, then push.`,
    `His press (${p.id}) applies by itself within a minute of the push. Never press or write his answer yourself.`,
  ].join("\n");
}
