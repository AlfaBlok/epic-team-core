import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Context, Hono } from "hono";
import { DEFAULT_TENANT, type DB } from "../db.js";
import { notJordi } from "../status/mark.js";
import { ATTACH_MAX_BYTES, ATTACH_MAX_PER_MESSAGE, AttachError, cardFilesLine } from "./attachLimits.js";
import { ownerName } from "../identity.js";

// the limits, the error and the files line live in a leaf module (no imports), so the review, row and inbox
// modules read them without loading this one (it imports status/mark.js, which reaches back into them: an import cycle).
export { ATTACH_MAX_BYTES, ATTACH_MAX_PER_MESSAGE, AttachError, CARD_FILES_MARK, cardFilesLine, splitCardFiles } from "./attachLimits.js";

/**
 * screenshots and files in Chat. The page uploads each file
 * first (POST /api/chat/attachments, the raw bytes), shows its thumbnail, and sends the message with the attachment ids; the
 * console adds one `📎 Attachments` block to the message text with a link per file (served by the console to signed-in users
 * of the same world, and to the desk with its usual console headers), so the desk downloads and opens each one, a queued send
 * (T3 down) carries them like any text, and the chat history shows them again from that block.
 * Files live in a folder beside the database (CONSOLE_CHAT_ATTACHMENTS_DIR), one row each in `chat_attachments`.
 */
/** First line of the block the console adds to a message (the chat bubble shows the files instead of it). */
export const ATTACH_HEAD = "📎 Attachments";

/** What Chat takes: images, short screen recordings and common documents. Never an executable, an archive or SVG (script). */
export const ATTACH_TYPES: Record<string, { ext: string; kind: "image" | "video" | "doc" | "text" }> = {
  "image/png": { ext: "png", kind: "image" },
  "image/jpeg": { ext: "jpg", kind: "image" },
  "image/webp": { ext: "webp", kind: "image" },
  "image/gif": { ext: "gif", kind: "image" },
  "image/heic": { ext: "heic", kind: "image" },
  "image/heif": { ext: "heif", kind: "image" },
  "video/mp4": { ext: "mp4", kind: "video" },
  "video/quicktime": { ext: "mov", kind: "video" },
  "video/webm": { ext: "webm", kind: "video" },
  "application/pdf": { ext: "pdf", kind: "doc" },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": { ext: "docx", kind: "doc" },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": { ext: "xlsx", kind: "doc" },
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": { ext: "pptx", kind: "doc" },
  "text/plain": { ext: "txt", kind: "text" },
  "text/csv": { ext: "csv", kind: "text" },
  "text/markdown": { ext: "md", kind: "text" },
  "application/json": { ext: "json", kind: "text" },
};
/** The picker's `accept`: the same list (the page and the console agree). */
export const ATTACH_ACCEPT = Object.keys(ATTACH_TYPES).join(",");
/** Browsers that leave a file's type empty or generic: guess it from the name. */
const BY_EXT: Record<string, string> = Object.fromEntries([
  ...Object.entries(ATTACH_TYPES).map(([m, t]) => [t.ext, m]),
  ["jpeg", "image/jpeg"],
  ["markdown", "text/markdown"],
]);


export interface Attachment {
  id: string;
  name: string;
  mime: string;
  bytes: number;
  createdAt: string;
  /** The console path that serves it (`/api/chat/attachments/<id>/<name>`). */
  path: string;
}

/** A file name safe in a link, a header and a path segment: letters, digits, dot, dash, underscore; at most 80 characters. */
export function safeName(raw: string, ext: string): string {
  const base = (raw.split(/[\\/]/).pop() ?? "").normalize("NFKD").replace(/[^\w.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").replace(/-{2,}/g, "-");
  const stem = base.replace(/\.[^.]*$/, "").slice(0, 70).replace(/[-.]+$/, "") || "file";
  return `${stem}.${ext}`;
}

/** The content type this console takes for a file, from its declared type or its name; undefined = refused. */
export function attachType(mime: string, name: string): string | undefined {
  const m = mime.split(";")[0].trim().toLowerCase();
  if (ATTACH_TYPES[m]) return m;
  if (m === "image/jpg") return "image/jpeg";
  // no type or a generic one (phones send documents as octet-stream, some browsers a text/* variant): the name decides
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  const byName = ext ? BY_EXT[ext] : undefined;
  return byName && (!m || m === "application/octet-stream" || m.startsWith("text/")) ? byName : undefined;
}

const starts = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);
const ascii = (b: Uint8Array, at: number, s: string) => starts(b, [...s].map((c) => c.charCodeAt(0)), at);

/** Do the bytes look like the type? Executables and scripts never pass, whatever the name says. */
export function bytesMatch(mime: string, b: Uint8Array): boolean {
  if (starts(b, [0x4d, 0x5a]) || starts(b, [0x7f, 0x45, 0x4c, 0x46]) || ascii(b, 0, "#!") || starts(b, [0xcf, 0xfa, 0xed, 0xfe]) || starts(b, [0xca, 0xfe, 0xba, 0xbe])) return false;
  switch (mime) {
    case "image/png":
      return starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return starts(b, [0xff, 0xd8, 0xff]);
    case "image/gif":
      return ascii(b, 0, "GIF8");
    case "image/webp":
      return ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP");
    case "video/webm":
      return starts(b, [0x1a, 0x45, 0xdf, 0xa3]);
    case "image/heic":
    case "image/heif":
    case "video/mp4":
    case "video/quicktime":
      return ascii(b, 4, "ftyp") || ascii(b, 4, "moov") || ascii(b, 4, "mdat") || ascii(b, 4, "wide");
    case "application/pdf":
      return ascii(b, 0, "%PDF-");
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      return starts(b, [0x50, 0x4b, 0x03, 0x04]);
    default:
      // text: no NUL byte in the first 8 KB
      return ATTACH_TYPES[mime]?.kind === "text" && !b.subarray(0, 8192).includes(0);
  }
}

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export interface AttachmentsDeps {
  db: DB;
  /** Folder of the files: <dir>/<world>/<id>.<ext>. */
  dir: string;
  /** The world of the current request (the request-scoped store's tenant). */
  world: () => string;
  /** The console base the desk calls (CONSOLE_PUBLIC_URL): the links in the message point there. */
  publicUrl: string;
  now?: () => number;
}

export function createAttachments(d: AttachmentsDeps) {
  const { db } = d;
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_attachments (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      mime TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      file TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      sent_at TEXT
    );
    CREATE INDEX IF NOT EXISTS chat_attachments_tenant ON chat_attachments (tenant_id, created_at);
  `);
  const now = d.now ?? Date.now;
  const world = () => d.world() || DEFAULT_TENANT;
  const base = d.publicUrl.replace(/\/+$/, "");
  const toAtt = (r: any): Attachment => ({ id: r.id, name: r.name, mime: r.mime, bytes: r.bytes, createdAt: r.created_at, path: `/api/chat/attachments/${r.id}/${r.name}` });
  const row = (id: string) => db.prepare("SELECT * FROM chat_attachments WHERE id = ? AND tenant_id = ?").get(id, world()) as any;

  function add(bytes: Uint8Array, declaredType: string, rawName: string): Attachment {
    if (!bytes.byteLength) throw new AttachError(400, "empty", "the file is empty");
    if (bytes.byteLength > ATTACH_MAX_BYTES) throw new AttachError(413, "too_big", `a file is at most ${ATTACH_MAX_BYTES / 1024 / 1024} MB (this one is ${kb(bytes.byteLength)})`);
    const mime = attachType(declaredType, rawName);
    if (!mime) throw new AttachError(415, "type_refused", `Chat takes images, screen recordings, PDF, Office documents and text files, not ${declaredType || "this file type"}`);
    if (!bytesMatch(mime, bytes)) throw new AttachError(415, "type_mismatch", `the file does not look like a ${ATTACH_TYPES[mime].ext.toUpperCase()} file`);
    const id = `att_${crypto.randomBytes(6).toString("hex")}`;
    const w = world();
    const folder = path.join(d.dir, w.replace(/[^\w-]/g, "_"));
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const file = path.join(folder, `${id}.${ATTACH_TYPES[mime].ext}`);
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    const name = safeName(rawName, ATTACH_TYPES[mime].ext);
    const sha = crypto.createHash("sha256").update(bytes).digest("hex");
    db.prepare("INSERT INTO chat_attachments (id, tenant_id, name, mime, bytes, file, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, w, name, mime, bytes.byteLength, file, sha, new Date(now()).toISOString());
    return toAtt(row(id));
  }

  /** One attachment of this world, with its file; another world's id is a 404, like a missing one. */
  function get(id: string): Attachment & { file: string } {
    const r = row(id);
    if (!r || !fs.existsSync(r.file)) throw new AttachError(404, "not_found", `no attachment ${id}`);
    return { ...toAtt(r), file: r.file };
  }

  /**
   * The message as the desk gets it: his text, then one block naming each file with its link and how to open it.
   * `fetchHeaders` is what the desk sends on its console calls (the Team desk's `-H 'X-Console-Run: team-desk'`).
   */
  function compose(text: string, ids: string[] | undefined, fetchHeaders?: string): string {
    const list = [...new Set(ids ?? [])];
    if (!list.length) return text;
    if (list.length > ATTACH_MAX_PER_MESSAGE) throw new AttachError(400, "too_many", `at most ${ATTACH_MAX_PER_MESSAGE} files in one message`);
    const atts = list.map((id) => get(id));
    const stamp = new Date(now()).toISOString();
    for (const a of atts) db.prepare("UPDATE chat_attachments SET sent_at = COALESCE(sent_at, ?) WHERE id = ?").run(stamp, a.id);
    const h = fetchHeaders ? `${fetchHeaders} ` : "";
    const first = atts[0];
    return [
      text.trim(),
      "",
      `${ATTACH_HEAD} (${atts.length}): ${ownerName()} attached ${atts.length === 1 ? "this file" : "these files"} to his message. Open each one before you answer: ` +
        `download it with the headers of your console calls, e.g. \`curl -sS ${h}-o /tmp/${first.id}-${first.name} '${base}${first.path}'\`, then read the file (an image shows as a picture).`,
      ...atts.map((a) => `- ${a.name} · ${a.mime} · ${kb(a.bytes)} · ${base}${a.path}`),
    ]
      .join("\n")
      .replace(/^\n+/, "");
  }

  /**
   * files sent with a card's answer (Answer, Changes wanted, Decline). One line after his words, so it stays in
   * the spine answer line, the reopened row's status and the brief or wake of the agent who reads the answer: no brackets
   * (a status cell turns them into square ones), only the link of each file, opened with that agent's console headers.
   */
  function cardText(text: string, ids: string[] | undefined): string {
    const list = [...new Set(ids ?? [])];
    if (!list.length) return text;
    if (list.length > ATTACH_MAX_PER_MESSAGE) throw new AttachError(400, "too_many", `at most ${ATTACH_MAX_PER_MESSAGE} files in one answer`);
    const atts = list.map((id) => get(id));
    const stamp = new Date(now()).toISOString();
    for (const a of atts) db.prepare("UPDATE chat_attachments SET sent_at = COALESCE(sent_at, ?) WHERE id = ?").run(stamp, a.id);
    const words = text.trim().replace(/\s+$/, "");
    return `${words}${words ? " " : ""}${cardFilesLine(atts.map((a) => `${base}${a.path}`))}`;
  }
  return { add, get, compose, cardText };
}

export type Attachments = ReturnType<typeof createAttachments>;

/** Where the page reads a file: images, video and PDF open in the browser; anything else downloads. Never runs as a page. */
function serve(a: Attachment & { file: string }): Response {
  const body = fs.readFileSync(a.file);
  const kind = ATTACH_TYPES[a.mime]?.kind;
  const inline = kind === "image" || kind === "video" || a.mime === "application/pdf" || kind === "text";
  return new Response(body, {
    headers: {
      "content-type": kind === "text" ? `${a.mime === "application/json" ? "text/plain" : a.mime}; charset=utf-8` : a.mime,
      "content-length": String(body.byteLength),
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${a.name}"`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}

/**
 * POST /api/chat/attachments: one file, the raw bytes as the body, `content-type` its type and `x-filename` its name
 * (URI-encoded); the owner's own, from his console page. GET /api/chat/attachments/:id[/:name]: the file, to anyone signed in
 * to the same world (the desk included); another world's id is a 404.
 */
export function mountAttachments(api: Hono, atts: Attachments) {
  const guard = (fn: (c: Context) => Promise<Response> | Response) => async (c: Context) => {
    try {
      return await fn(c);
    } catch (e) {
      if (e instanceof AttachError) return c.json({ error: { code: e.code, message: e.message } }, e.status);
      throw e;
    }
  };
  api.post(
    "/chat/attachments",
    guard(async (c) => {
      const why = notJordi((h) => c.req.header(h));
      if (why) return c.json({ error: { code: "jordi_only", message: `only ${ownerName()} attaches files, from the console page in his browser (${why})` } }, 403);
      const len = Number(c.req.header("content-length"));
      if (Number.isFinite(len) && len > ATTACH_MAX_BYTES) throw new AttachError(413, "too_big", `a file is at most ${ATTACH_MAX_BYTES / 1024 / 1024} MB`);
      let name = "file";
      try {
        name = decodeURIComponent(c.req.header("x-filename") ?? "file");
      } catch {
        /* keep the default */
      }
      const buf = new Uint8Array(await c.req.arrayBuffer());
      return c.json({ attachment: atts.add(buf, c.req.header("content-type") ?? "", name) }, 201);
    }),
  );
  /**
   * a box whose own route takes only words (Send
   * to, Steer, Run now, a slide's note, a post's or an idea's feedback) still sends his files: the page asks for their line
   * of links here and puts it after his words, so the agent who reads them opens each file like a card answer's.
   */
  api.post(
    "/chat/attachments/line",
    guard(async (c) => {
      const why = notJordi((h) => c.req.header(h));
      if (why) return c.json({ error: { code: "jordi_only", message: `only ${ownerName()} attaches files, from the console page in his browser (${why})` } }, 403);
      const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown };
      const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string" && x.length <= 40) : [];
      if (!ids.length) throw new AttachError(400, "no_files", "name at least one uploaded file");
      return c.json({ line: atts.cardText("", ids) });
    }),
  );
  const one = guard((c) => serve(atts.get(c.req.param("id") ?? "")));
  api.get("/chat/attachments/:id", one);
  api.get("/chat/attachments/:id/:name", one);
}
