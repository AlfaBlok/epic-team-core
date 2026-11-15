import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { Hono } from "hono";
import { ANTHROPIC_TEXT_MODEL } from "../textModel.js";
import { ownerName, workerHost } from "../identity.js";

/**
 * E948-S62 the card quality check (the owner's vn_1: "did he get what he asked for", he rates delivery at 20%; his
 * note of 12 Nov: "Can we have like a quality control or something?"). The check itself runs on the worker host
 * (scripts/card_qc.py): it sets his own words beside the result point by point, opens the evidence at 390 and 1280 px in
 * a real browser and has a model look at it against the house rules. It writes the result beside the card, in the repo
 * (root L-45): `docs/cards/qc/<row>.json` and the first screens `<row>-390.webp`, `<row>-1280.webp`.
 *
 * The gate reads it here: a missed point holds the card as "not what he asked", a failed look as "failed the visual
 * check"; a card changed after its check waits for the next one. A repo that has a `docs/cards/qc/` folder has opted in:
 * there a card with no check yet waits too (other repos keep the gate as it was until they run the check).
 */

export interface QcPoint {
  said: string;
  where?: string;
  status: "met" | "declared" | "missed" | "elsewhere";
  how?: string;
}

export interface QcShot {
  width: number;
  url?: string;
  /** file name inside docs/cards/qc/ */
  file: string;
}

export interface QcResult {
  row: string;
  card?: string;
  cardSha: string;
  checkedAt: string;
  by?: string;
  words: QcPoint[];
  visual: { pass: boolean; problems: string[]; summary?: string };
  pass: boolean;
  held?: string[];
  /** the fresh reader's one sentence on what the card asks, and its most ambiguous part ("" = nothing). */
  reader?: { asked: string; ambiguous: string };
  /** the press-every-button walk of the evidence page; dead = the step where it dead-ends (null = none). */
  clicks?: { dead: string | null; shot?: string };
  shots: QcShot[];
}

/** what the card face carries from the check: his words beside the result, and the live screens. */
export interface CardQc {
  checkedAt: string;
  pass: boolean;
  words: QcPoint[];
  visual: { pass: boolean; problems: string[]; summary?: string };
  /** repo-relative paths of the live screens (phone first). */
  shots: { width: number; path: string }[];
}

export const QC_DIR = "docs/cards/qc";

/** the card file's fingerprint, as scripts/card_qc.py writes it (sha256, first 16 hex). */
export const cardSha = (buf: Buffer | string) => createHash("sha256").update(buf).digest("hex").slice(0, 16);

const STATUSES = new Set(["met", "declared", "missed", "elsewhere"]);

/** the check's result for a row, read from the repo; undefined when there is none or it does not parse. */
export function readQc(repoDir: string, row: string): QcResult | undefined {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(repoDir, QC_DIR, `${row}.json`), "utf8")) as Partial<QcResult>;
    if (typeof v.cardSha !== "string" || !Array.isArray(v.words) || typeof v.visual !== "object" || !v.visual) return undefined;
    return {
      row: String(v.row ?? row),
      ...(v.card ? { card: String(v.card) } : {}),
      cardSha: v.cardSha,
      checkedAt: String(v.checkedAt ?? ""),
      ...(v.by ? { by: String(v.by) } : {}),
      words: v.words
        .filter((w): w is QcPoint => !!w && typeof w === "object" && typeof (w as QcPoint).said === "string")
        .map((w) => ({ said: w.said, ...(w.where ? { where: String(w.where) } : {}), status: STATUSES.has(w.status) ? w.status : "missed", ...(w.how ? { how: String(w.how) } : {}) })),
      visual: { pass: v.visual.pass === true, problems: Array.isArray(v.visual.problems) ? v.visual.problems.map(String) : [], ...(v.visual.summary ? { summary: String(v.visual.summary) } : {}) },
      pass: v.pass === true,
      ...(Array.isArray(v.held) ? { held: v.held.map(String) } : {}),
      ...(v.reader && typeof v.reader === "object" ? { reader: { asked: String(v.reader.asked ?? ""), ambiguous: String(v.reader.ambiguous ?? "") } } : {}),
      ...(v.clicks && typeof v.clicks === "object"
        ? { clicks: { dead: v.clicks.dead ? String(v.clicks.dead) : null, ...(typeof v.clicks.shot === "string" && !v.clicks.shot.includes("/") ? { shot: v.clicks.shot } : {}) } }
        : {}),
      shots: Array.isArray(v.shots) ? v.shots.filter((s) => s && typeof s.file === "string" && !s.file.includes("/") && !s.file.includes("..")).map((s) => ({ width: Number(s.width) || 0, file: s.file, ...(s.url ? { url: String(s.url) } : {}) })) : [],
    };
  } catch {
    return undefined;
  }
}

/** a repo runs the check once it has the folder: there an unchecked card waits for its check. */
export const qcRequired = (repoDir: string) => {
  try {
    return fs.statSync(path.join(repoDir, QC_DIR)).isDirectory();
  } catch {
    return false;
  }
};

export interface QcVerdict {
  kind: "fails-qc";
  reason: string;
  problems: string[];
}

const RUN = (row: string) => `the quality check runs on ${workerHost()} every 15 minutes, or run \`python3 scripts/card_qc.py --repo <checkout> --row ${row} --commit\``;

/**
 * the gate's word on the check: undefined = it passed (or the repo does not run it yet); else why the card is held.
 * `cardText` is the card file as it is now (its fingerprint must match the one the check saw).
 */
export function qcVerdict(o: { row: string; required: boolean; qc: QcResult | undefined; cardText: Buffer | string | undefined }): QcVerdict | undefined {
  const { row, qc } = o;
  if (!qc) return o.required ? { kind: "fails-qc", reason: "not checked yet", problems: [`the quality check has not looked at it yet: ${RUN(row)}`] } : undefined;
  if (o.cardText !== undefined && cardSha(o.cardText) !== qc.cardSha)
    return { kind: "fails-qc", reason: "changed since its check", problems: [`the card changed after the quality check of ${qc.checkedAt}: ${RUN(row)}`] };
  const missed = qc.words.filter((w) => w.status === "missed");
  if (missed.length)
    return {
      kind: "fails-qc",
      reason: "not what he asked",
      problems: missed.map((w) => `${ownerName()} said "${w.said}"${w.where ? ` (${w.where})` : ""}: ${w.how || "the result does not show it"}`),
    };
  // a link or button on the evidence page that leads nowhere
  if (qc.clicks?.dead)
    return { kind: "fails-qc", reason: "dead end", problems: [qc.clicks.dead, ...(qc.clicks.shot ? [`its screen: ${QC_DIR}/${qc.clicks.shot}`] : [])] };
  if (!qc.visual.pass) return { kind: "fails-qc", reason: "failed the visual check", problems: qc.visual.problems.length ? qc.visual.problems : ["the look failed and named no reason"] };
  // "Ambiguity is our enemy": held until the fresh reader finds nothing ambiguous
  if (qc.reader?.ambiguous)
    return { kind: "fails-qc", reason: "ambiguous", problems: [`a fresh reader found this most ambiguous: ${qc.reader.ambiguous}`, ...(qc.reader.asked ? [`they read the card as asking: ${qc.reader.asked}`] : [])] };
  if (!qc.pass) return { kind: "fails-qc", reason: "failed the quality check", problems: qc.held?.length ? qc.held : ["the check did not pass"] };
  return undefined;
}

/** the face's part: the live screens that exist (phone first) and his words beside the result. */
export function qcFace(repoDir: string, qc: QcResult | undefined): CardQc | undefined {
  if (!qc) return undefined;
  const shots = qc.shots
    .map((s) => ({ width: s.width, path: `${QC_DIR}/${s.file}` }))
    .filter((s) => {
      try {
        return fs.statSync(path.join(repoDir, s.path)).isFile();
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.width - b.width);
  return { checkedAt: qc.checkedAt, pass: qc.pass, words: qc.words, visual: qc.visual, shots };
}

/** the picture his card shows: the check's live laptop screen (the thing itself), else the phone one. */
export const qcPicture = (q: CardQc | undefined) => (q?.pass ? (q.shots.find((s) => s.width >= 1000) ?? q.shots[0])?.path : undefined);

// ---------- the judge (the model that looks at the screens) ----------

export const QC_JUDGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["words", "visual", "reader"],
  properties: {
    // the fresh reader says what the card asks in one sentence and its most ambiguous part; changesAnswer: whether that
    // part would change what he answers (card_qc.py holds only then; without the field the judge wrote it into the text)
    reader: {
      type: "object",
      additionalProperties: false,
      required: ["asked", "ambiguous", "changesAnswer"],
      properties: { asked: { type: "string" }, ambiguous: { type: "string" }, changesAnswer: { type: "boolean" } },
    },
    words: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        // onPage: a missed point the evidence page shows after all (the card holds three short lines); changed,
        // what changed on the card or page when a point the last check accepted turns missed (card_qc.py keeps it otherwise)
        required: ["n", "status", "how", "onPage", "changed"],
        properties: {
          n: { type: "integer" },
          status: { type: "string", enum: ["met", "declared", "missed", "elsewhere"] },
          how: { type: "string" },
          onPage: { type: "boolean" },
          changed: { type: "string" },
        },
      },
    },
    visual: {
      type: "object",
      additionalProperties: false,
      // judge fix: breaches as a list, no pass flag; the card is held only when the list is not empty (card_qc.py)
      required: ["breaches", "summary"],
      properties: {
        breaches: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            // fault: true only when the page goes back to be fixed for it (card_qc.py drops fault false)
            required: ["rule", "width", "fault", "what"],
            properties: { rule: { type: "integer" }, width: { type: "integer" }, fault: { type: "boolean" }, what: { type: "string" } },
          },
        },
        summary: { type: "string" },
      },
    },
  },
} as const;

/**
 * A delivery check (a script outside the core) asks the same model two other questions: which of the owner's asks
 * did he repeat (`groups`), and is one live as he said it on these screens (`live`).
 */
export const DELIVERY_GROUPS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["groups"],
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ask", "items", "quotes", "screen"],
        properties: {
          ask: { type: "string" },
          items: { type: "array", items: { type: "integer" } },
          quotes: { type: "array", items: { type: "object", additionalProperties: false, required: ["n", "said"], properties: { n: { type: "integer" }, said: { type: "string" } } } },
          screen: { type: "string" },
        },
      },
    },
  },
} as const;
export const DELIVERY_LIVE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["live", "seen", "missing"],
  properties: { live: { type: "string", enum: ["yes", "partly", "no"] }, seen: { type: "string" }, missing: { type: "string" } },
} as const;
/** E996-S43: a fresh agent's dry run of one ask from its card alone (scripts/ask_dryrun.py): per step, is the exact place
 * named, does it exist now, could it be done from these words alone, and the first step that fails. */
export const ASK_DRY_RUN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  // asked, ambiguous: the fresh reader's one sentence and the card's most ambiguous part ("" = nothing)
  // E996-S58: changed, notStated, answeredBy, changesAnswer: a hold names what changed or the fact the card leaves out
  required: ["steps", "asked", "ambiguous", "verdict", "firstProblem", "changed", "notStated", "answeredBy", "changesAnswer"],
  properties: {
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["n", "step", "placeNamed", "exists", "doable", "why", "changed"],
        properties: {
          n: { type: "integer" },
          step: { type: "string" },
          placeNamed: { type: "string", enum: ["yes", "no"] },
          exists: { type: "string", enum: ["yes", "no", "unknown"] },
          doable: { type: "string", enum: ["yes", "no"] },
          why: { type: "string" },
          changed: { type: "string" },
        },
      },
    },
    asked: { type: "string" },
    ambiguous: { type: "string" },
    verdict: { type: "string", enum: ["pass", "fail"] },
    firstProblem: { type: "string" },
    changed: { type: "string" },
    notStated: { type: "string" },
    answeredBy: { type: "string" },
    changesAnswer: { type: "boolean" },
  },
} as const;
/** The answer shapes a caller may ask for by name (never a schema of its own). */
export const JUDGE_SCHEMAS = { qc: QC_JUDGE_SCHEMA, groups: DELIVERY_GROUPS_SCHEMA, live: DELIVERY_LIVE_SCHEMA, dryrun: ASK_DRY_RUN_SCHEMA } as const;
export type JudgeSchemaName = keyof typeof JUDGE_SCHEMAS;

export const QC_IMAGES_MAX = 8;
const IMAGE_MAX = 3_000_000;
const PROMPT_MAX = 30_000;

export interface JudgeImage {
  label: string;
  /** base64 PNG, JPEG or WebP */
  data: string;
  mediaType?: "image/png" | "image/jpeg" | "image/webp";
}

export type QcJudge = (prompt: string, images: JudgeImage[], schema?: JudgeSchemaName) => Promise<{ value: unknown; costUsd: number }>;

/** the check's model call on the console's credit account (the text model, which reads images too). */
export function anthropicQcJudge(key: () => Promise<string | undefined>, f: typeof fetch = fetch): QcJudge {
  return async (prompt, images, schema = "qc") => {
    const k = await key();
    if (!k) throw new Error("the console has no ANTHROPIC_API_KEY");
    const client = new Anthropic({ apiKey: k, fetch: f, maxRetries: 1, timeout: 120_000 });
    const content: Anthropic.ContentBlockParam[] = [];
    for (const im of images) {
      content.push({ type: "text", text: `Screenshot: ${im.label}` });
      content.push({ type: "image", source: { type: "base64", media_type: im.mediaType ?? "image/png", data: im.data } });
    }
    content.push({ type: "text", text: prompt });
    const msg = await client.messages.create({
      model: ANTHROPIC_TEXT_MODEL,
      max_tokens: 4000,
      messages: [{ role: "user", content }],
      output_config: { effort: "low", format: { type: "json_schema", schema: JUDGE_SCHEMAS[schema] as unknown as Record<string, unknown> } },
    });
    const text = msg.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text;
    if (typeof text !== "string") throw new Error(`the model sent no text (${msg.stop_reason ?? "no stop reason"})`);
    const u = msg.usage;
    const costUsd = Math.round((((u.input_tokens ?? 0) * 0.1 + (u.output_tokens ?? 0) * 0.5) / 1_000_000) * 1e6) / 1e6;
    return { value: JSON.parse(text), costUsd };
  };
}

/** POST /api/review-qc/judge {prompt, images:[{label, data, mediaType}], schema?: "qc"|"groups"|"live"|"dryrun"} → the model's answer
 * (the card check calls it; a delivery check with `groups` and `live`; the ask dry run with `dryrun`, E996-S43). */
export function mountQcJudge(api: Hono, judge: QcJudge) {
  api.post("/review-qc/judge", async (c) => {
    const b = (await c.req.json().catch(() => undefined)) as { prompt?: unknown; images?: unknown; schema?: unknown } | undefined;
    const prompt = typeof b?.prompt === "string" ? b.prompt : "";
    const images = Array.isArray(b?.images) ? (b.images as JudgeImage[]) : [];
    const schema = b?.schema === undefined ? "qc" : String(b.schema);
    if (!(schema in JUDGE_SCHEMAS)) return c.json({ error: { code: "bad_schema", message: `schema is one of ${Object.keys(JUDGE_SCHEMAS).join(", ")}` } }, 400);
    if (!prompt || prompt.length > PROMPT_MAX) return c.json({ error: { code: "bad_prompt", message: `a prompt of 1 to ${PROMPT_MAX} characters is required` } }, 400);
    if (images.length > QC_IMAGES_MAX || images.some((i) => !i || typeof i.data !== "string" || i.data.length > IMAGE_MAX || typeof i.label !== "string"))
      return c.json({ error: { code: "bad_images", message: `at most ${QC_IMAGES_MAX} images, each a base64 string under ${IMAGE_MAX} characters with a label` } }, 400);
    try {
      const r = await judge(prompt, images, schema as JudgeSchemaName);
      return c.json({ answer: r.value, costUsd: r.costUsd, model: ANTHROPIC_TEXT_MODEL, schema });
    } catch (e) {
      return c.json({ error: { code: "judge_failed", message: String((e as Error)?.message ?? e).slice(0, 300) } }, 502);
    }
  });
}
