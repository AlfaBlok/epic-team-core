import { sectionRange } from "../approvals.js";
import { proseLines } from "../adapters/markdown.js";

/**
 * one `Name: value` field of a spine's `## Current State`, read and written as text, so a console
 * setting or a run's report lives in the spine (written through the one spine writer), never only in console.db.
 * Fields inside code fences are ignored (proseLines); `- Name:` and `**Name:**` forms are read and kept.
 */
const STATE_H = /^current state\b/i;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const fieldRe = (name: string) => new RegExp(`^(\\s*(?:[-*]\\s+)?(?:\\*\\*)?${esc(name)}(?:\\*\\*)?\\s*:(?:\\*\\*)?\\s*)(.*?)(\\r?)$`, "i");

/** The field's line index and value (first one in Current State); undefined when the spine has none. */
export function stateField(text: string, name: string): { line: number; value: string } | undefined {
  const cs = sectionRange(text, STATE_H);
  if (!cs) return undefined;
  const lines = proseLines(text);
  const raw = text.split("\n");
  const re = fieldRe(name);
  for (let k = cs.head + 1; k < cs.end; k++) {
    if (!re.test(lines[k] ?? "")) continue;
    const m = re.exec(raw[k])!;
    return { line: k, value: m[2].trim() };
  }
  return undefined;
}

/**
 * The spine with the field set to `value` (replaced in place), added when absent (after the first of `after` that the
 * section has, else after the section's last non-blank line), or taken out when `value` is undefined. A spine without a
 * Current State section comes back unchanged.
 */
export function setStateField(text: string, name: string, value: string | undefined, after: string[] = []): string {
  const cs = sectionRange(text, STATE_H);
  if (!cs) return text;
  const raw = text.split("\n");
  const have = stateField(text, name);
  if (have) {
    if (value === undefined) raw.splice(have.line, 1);
    else {
      const m = fieldRe(name).exec(raw[have.line])!;
      raw[have.line] = `${m[1]}${value}${m[3]}`;
    }
    return raw.join("\n");
  }
  if (value === undefined) return text;
  let at = -1;
  for (const a of after) {
    const f = stateField(text, a);
    if (f) {
      at = f.line;
      break;
    }
  }
  if (at < 0) {
    at = cs.head;
    for (let k = cs.head + 1; k < cs.end; k++) if (raw[k].trim()) at = k;
  }
  raw.splice(at + 1, 0, `${name}: ${value}`);
  return raw.join("\n");
}
