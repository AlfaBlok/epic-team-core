/**
 * The owner said "the inbox takes about 10 s and jumps". The Inbox's list sends only
 * what the screen shows. Measured on production 20:52Z: GET /waiting-on-owner was 1.78 MB for 298 items, 95% of it the
 * 245 done asks (history the folded Answered list shows as one line each) and a second full copy of every answered
 * item inside its `response.item`. `?view=list` (what the web app asks for) keeps every open and answered card whole,
 * drops `response.item` everywhere and cuts a done or superseded item to its one-line row; the card behind a row is
 * fetched when it opens (GET /waiting-on-owner/:id). Agents' curl without `view` still get the whole list.
 */

/** the longest question or answer a folded row carries (the row shows one line; the opened card has the whole text). */
export const ROW_TEXT_MAX = 200;

/** the fields a done or superseded row reads (AnsweredRow, the Superseded line, the filters and counts around them). */
const ROW_FIELDS = [
  "id",
  "source",
  "signal",
  "gate",
  "repo",
  "code",
  "state",
  "feedback",
  "decidedBy",
  "doneAt",
  "consumedAt",
  "supersededBy",
  "snoozedUntil",
  "macAgent",
  "line",
  "who",
  "row",
  "milestoneId",
  "milestoneTitle",
  "path",
  "title",
  "ask",
  "since",
  "decidable",
  "ownerName",
  "priority",
  "relay",
] as const;

/** the parts of an answer a folded row reads: when, what kind, the also-closed chip, delivery state. */
const RESPONSE_ROW_FIELDS = ["id", "kind", "createdAt", "delivery", "settles"] as const;

const cut = (s: unknown): string | undefined => (typeof s !== "string" ? undefined : s.length > ROW_TEXT_MAX ? `${s.slice(0, ROW_TEXT_MAX - 1)}…` : s);

type Obj = Record<string, unknown>;
const pick = (o: Obj, keys: readonly string[]): Obj => {
  const out: Obj = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
};

/** an answer without the full copy of the item it answered (the list already carries the item). */
const lean = (r: unknown): unknown => {
  if (!r || typeof r !== "object") return r;
  const { item: _item, ...rest } = r as Obj;
  return rest;
};

/** a done or superseded item as its folded row (`slim: true`: the client fetches the whole card when it opens). */
export function rowOf(it: Obj): Obj {
  const r = it.response as Obj | undefined;
  const spine = r?.spine as Obj | undefined;
  return {
    ...pick(it, ROW_FIELDS),
    question: cut(it.question) ?? "",
    ...(it.answer !== undefined ? { answer: cut(it.answer) } : {}),
    contextLinks: [],
    owner: pick((it.owner as Obj) ?? {}, ["kind", "label"]),
    // the row's answer is `answer` (answeredBy); the answer's own words and commit are in the card it opens.
    ...(r ? { response: { ...pick(r, RESPONSE_ROW_FIELDS), text: "", ...(spine ? { spine: pick(spine, ["status"]) } : {}) } } : {}),
    slim: true,
  };
}

/** the list as the Inbox screen needs it: whole open and answered cards, done and superseded ones as rows. */
export function listView<T extends Obj>(items: T[]): Obj[] {
  return items.map((it) => (it.state === "done" || it.state === "superseded" ? rowOf(it) : it.response ? { ...it, response: lean(it.response) } : it));
}

/** `?view=list` */
export const wantsListView = (q: (n: string) => string | undefined) => q("view") === "list";
