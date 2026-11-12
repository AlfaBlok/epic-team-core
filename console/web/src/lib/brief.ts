import type { Assignment, Cadence, Milestone, Persona, SocialBriefInput, SocialExport } from "@/api/types";

/**
 * the Campaign brief screen's form over the pack export's `brief` (objective and targets from the root spine,
 * voice, style, never-say and key messages from the message house, audience, formats, examples and hold rules from
 * data/brief.md) plus each persona's cadence (console assignments). Save sends only the sections that changed: the
 * server replaces each given section whole, so an untouched one is never rewritten.
 */

export const WEIGHTS = ["over", "normal", "under"] as const;

export interface KeyMessageRow {
  id: string | null;
  message: string;
  weight: string;
  source: string;
}
export interface FormatRow {
  format: string;
  /** Text while editing (an empty or half-typed number is allowed); a number on Save. */
  share: string;
  example: string;
}
export interface ExampleRow {
  link: string;
  verdict: "like" | "dislike";
  why: string;
}
export interface HoldRow {
  id: string | null;
  match: string;
  why: string;
}

export interface BriefForm {
  objective: string;
  targets: string;
  audience: string;
  /** One item per line (Markdown list items in the file). */
  voice: string;
  style_rules: string;
  never_say: string;
  key_messages: KeyMessageRow[];
  formats: FormatRow[];
  examples: ExampleRow[];
  hold_rules: HoldRow[];
  /** Persona name → cadence (every assignment of that persona on the campaign repo). */
  cadence: Record<string, Cadence>;
}

/** One persona's assignments on the campaign repo, as the screen shows its cadence. */
export interface PersonaCadence {
  persona: string;
  cadence: Cadence;
  /** More than one assignment with different cadences: Save sets them all to the one shown. */
  mixed: boolean;
  enabled: boolean;
}

const s = (v: string | number | null | undefined) => (v === null || v === undefined ? "" : String(v));

/** The repo part of a milestone's repo (`a social world repo` → `a social world repo`). */
const repoName = (r: string) => r.replace(/\.git$/, "").split("/").filter(Boolean).pop() ?? r;

export function personaCadences(repo: string | null, milestones: Milestone[], assignments: Assignment[], personas: Persona[]): PersonaCadence[] {
  if (!repo) return [];
  const ms = new Set(milestones.filter((m) => m.repo && repoName(m.repo) === repo).map((m) => m.id));
  const name = new Map(personas.map((p) => [p.id, p.name]));
  const by = new Map<string, Assignment[]>();
  for (const a of assignments) {
    const n = name.get(a.personaId);
    if (!ms.has(a.milestoneId) || !n) continue;
    by.set(n, [...(by.get(n) ?? []), a]);
  }
  return [...by.entries()]
    .map(([persona, list]) => ({
      persona,
      cadence: list[0].cadence,
      mixed: new Set(list.map((a) => JSON.stringify(a.cadence))).size > 1,
      enabled: list.some((a) => a.enabled),
    }))
    .sort((a, b) => a.persona.localeCompare(b.persona));
}

export function formFromExport(d: SocialExport, cadences: PersonaCadence[] = []): BriefForm {
  const b = d.brief;
  return {
    objective: s(b.objective),
    targets: s(b.targets),
    audience: s(b.audience),
    voice: b.voice.join("\n"),
    style_rules: b.style_rules.join("\n"),
    never_say: b.never_say.join("\n"),
    key_messages: b.key_messages.map((k) => ({ id: k.id, message: s(k.message), weight: s(k.weight) || "normal", source: s(k.source) })),
    formats: b.formats.map((f) => ({ format: s(f.format), share: s(f.share), example: s(f.example) })),
    examples: b.examples.map((e) => ({ link: s(e.link), verdict: e.verdict === "dislike" ? "dislike" : "like", why: s(e.why) })),
    hold_rules: b.hold_rules.map((h) => ({ id: h.id, match: s(h.match), why: s(h.why) })),
    cadence: Object.fromEntries(cadences.map((c) => [c.persona, c.cadence])),
  };
}

const lines = (t: string) => t.split("\n").map((l) => l.replace(/^\s*[-*]\s+/, "").trim()).filter(Boolean);
const orNull = (t: string) => (t.trim() ? t.trim() : null);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Problems the screen can see before Save (the pack validator has the last word, as 422 issue lines). */
export function formProblems(f: BriefForm): string[] {
  const out: string[] = [];
  f.key_messages.forEach((k, i) => !k.message.trim() && out.push(`key message ${i + 1}: write the message or remove the row`));
  f.formats.forEach((x, i) => {
    if (!x.format.trim()) out.push(`format ${i + 1}: name the format or remove the row`);
    const n = Number(x.share);
    if (x.share.trim() === "" || !Number.isFinite(n) || n < 0 || n > 100) out.push(`format ${i + 1}: share is a number 0-100`);
  });
  f.examples.forEach((e, i) => !e.link.trim() && out.push(`example ${i + 1}: give the link or remove the row`));
  f.hold_rules.forEach((h, i) => !h.match.trim() && out.push(`hold rule ${i + 1}: say what to hold or remove the row`));
  for (const [p, c] of Object.entries(f.cadence)) {
    if (c.type === "interval" && !(c.everyMinutes >= 1)) out.push(`cadence ${p}: every at least 1 minute`);
    if (c.type === "fixed_time" && (!/^([01]\d|2[0-3]):[0-5]\d$/.test(c.timeOfDay) || !c.weekdays.length)) out.push(`cadence ${p}: a time (HH:MM) and at least one day`);
  }
  return out;
}

/** Formats' shares summed (the mix should come to 100%). */
export const formatsTotal = (f: Pick<BriefForm, "formats">) => f.formats.reduce((n, x) => n + (Number(x.share) || 0), 0);

/** The Save body: only the sections that differ from `base` (undefined = nothing to save). */
export function briefInput(f: BriefForm, base: BriefForm): SocialBriefInput | undefined {
  const out: SocialBriefInput = {};
  for (const k of ["objective", "targets", "audience"] as const) if (f[k].trim() !== base[k].trim()) out[k] = f[k].trim();
  for (const k of ["voice", "style_rules", "never_say"] as const) if (!same(lines(f[k]), lines(base[k]))) out[k] = lines(f[k]);
  if (!same(f.key_messages, base.key_messages))
    out.key_messages = f.key_messages.map((k) => ({ id: k.id, message: k.message.trim(), weight: (k.weight || "normal") as "over" | "normal" | "under" | "avoid", source: orNull(k.source) }));
  if (!same(f.formats, base.formats)) out.formats = f.formats.map((x) => ({ format: x.format.trim(), share: Number(x.share), example: orNull(x.example) }));
  if (!same(f.examples, base.examples)) out.examples = f.examples.map((e) => ({ link: e.link.trim(), verdict: e.verdict, why: orNull(e.why) }));
  if (!same(f.hold_rules, base.hold_rules)) out.hold_rules = f.hold_rules.map((h) => ({ id: h.id, match: h.match.trim(), why: orNull(h.why) }));
  const cadence = Object.entries(f.cadence)
    .filter(([p, c]) => !same(c, base.cadence[p]))
    .map(([persona, cadence]) => ({ persona, cadence }));
  if (cadence.length) out.cadence = cadence;
  return Object.keys(out).length ? out : undefined;
}

/** The section names a Save would write (for the "unsaved" line). */
export const changedSections = (f: BriefForm, base: BriefForm) => Object.keys(briefInput(f, base) ?? {});
