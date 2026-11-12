import { ownerName } from "../identity.js";
/**
 * what chat and card attachments share, in a module that imports nothing: the limits, the error the routes turn into
 * a reply, and (round 2) the files line after a card answer's words. review.ts, rows.ts and inbox/routes.ts read these at load
 * (zod schemas, status cells); importing them from attachments.ts made an import cycle (attachments → status/mark → inbox →
 * review → attachments) and "Cannot access 'ATTACH_MAX_PER_MESSAGE' before initialization" (e62s2carry).
 */
export const ATTACH_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACH_MAX_PER_MESSAGE = 8;

export class AttachError extends Error {
  constructor(
    public status: 400 | 404 | 413 | 415,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The marker of the files line on a card's answer: the status cell keeps it whole when it shortens his words. */
export const CARD_FILES_MARK = "📎";
export const cardFilesLine = (urls: string[]) =>
  `${CARD_FILES_MARK} ${ownerName()} attached ${urls.length === 1 ? "a file" : `${urls.length} files`}, open ${urls.length === 1 ? "it" : "each"} with your console headers: ${urls.join(" ")}`;
/** Splits a card answer into his words and its files line (empty when none). */
export function splitCardFiles(text: string): { words: string; files: string } {
  const at = text.search(new RegExp(`(^|\\s)${CARD_FILES_MARK} ${ownerName()} attached `, "u"));
  return at < 0 ? { words: text, files: "" } : { words: text.slice(0, at).trimEnd(), files: text.slice(at).trim() };
}
