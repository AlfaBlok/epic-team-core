/**
 * A JSON answer kept ready in the background, so a request does no work.
 *
 * GET /api/scorecards was built on the request (an answerCache of 10 s, so every open tab rebuilt it every 10 s): about
 * 0.25 s of solid CPU on a quiet host, and 1 to 46 s on a busy one, while the owner's sidebar waited on it. Here the
 * answer is built off the request, serialised once, gzipped once and hashed once; a request gets those bytes (or a 304).
 *
 * - the first `get()` starts the keeper (no timer before anyone asks) and waits for the first build only;
 * - every `checkMs` the keeper rebuilds when `signature()` changed (an input file was written) and the last build is at
 *   least `minGapMs` old, or when the last build is `everyMs` old whatever changed (database parts: milestones, asks);
 * - `refresh()` rebuilds now (a write that changes the answer); a failed build keeps the last answer.
 * - `file`: every build is also saved there, and a new process starts from the saved answer, so the first
 *   request after a restart gets the last good bytes at once (a release restarts the console every ~10 min; the cold
 *   build took 9.9 to 21 s on the main server while the sidebar waited), and the keeper rebuilds it in the background straight away.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { gzip as gzipCb } from "node:zlib";
import type { Context } from "hono";
import { etagMatches } from "./leanJson.js";

export interface PreparedJson {
  json: Buffer;
  gz: Buffer;
  etag: string;
  /** when it was built (ms) */
  at: number;
  /** how long the build took (ms) */
  tookMs: number;
}

export interface KeptJson {
  get(): Promise<PreparedJson>;
  refresh(): Promise<PreparedJson | undefined>;
  /** one keeper turn (the timer calls it; tests call it with their own clock). */
  tick(): Promise<void>;
  stop(): void;
}

const gzip = promisify(gzipCb);

export async function prepareJson(value: unknown, at: number, tookMs = 0): Promise<PreparedJson> {
  const json = Buffer.from(JSON.stringify(value));
  return { json, gz: await gzip(json, { level: 6 }), etag: `W/"${createHash("sha1").update(json).digest("base64url")}"`, at, tookMs };
}

export function keptJson(o: {
  build: () => Promise<unknown>;
  everyMs: number;
  minGapMs: number;
  checkMs: number;
  signature?: () => string;
  now?: () => number;
  log?: (msg: string) => void;
  /** false: no timer (tests drive tick()). */
  timer?: boolean;
  /** where the last good answer is saved, so a restart serves it at once; unset = memory only. */
  file?: string;
}): KeptJson {
  const now = o.now ?? Date.now;
  let kept: PreparedJson | undefined;
  /** true while `kept` is the saved answer from before this start (rebuilt on the first get). */
  let fromFile = false;
  if (o.file)
    try {
      const saved = JSON.parse(fs.readFileSync(o.file, "utf8")) as { at: number; tookMs: number; etag: string; json: string; gz: string };
      kept = { json: Buffer.from(saved.json, "base64"), gz: Buffer.from(saved.gz, "base64"), etag: saved.etag, at: saved.at, tookMs: saved.tookMs };
      fromFile = true;
    } catch {
      /* nothing saved yet, or unreadable: the first get builds it */
    }
  const save = (p: PreparedJson) => {
    if (!o.file) return;
    const f = o.file;
    const body = JSON.stringify({ at: p.at, tookMs: p.tookMs, etag: p.etag, json: p.json.toString("base64"), gz: p.gz.toString("base64") });
    void fs.promises
      .mkdir(path.dirname(f), { recursive: true })
      .then(() => fs.promises.writeFile(`${f}.tmp`, body))
      .then(() => fs.promises.rename(`${f}.tmp`, f))
      .catch((e) => o.log?.(`kept answer: could not save ${f}: ${(e as Error)?.message ?? e}`));
  };
  let building: Promise<PreparedJson | undefined> | undefined;
  let first: Promise<PreparedJson> | undefined;
  let sig: string | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const sign = () => {
    try {
      return o.signature?.() ?? "";
    } catch {
      return "";
    }
  };

  // a refresh asked while a build runs (a write landed mid-build) builds once more after it, so the write shows.
  let again = false;
  const refresh = (): Promise<PreparedJson | undefined> => {
    if (building) {
      again = true;
      return building.then(() => (again ? ((again = false), refresh()) : kept));
    }
    const started = now();
    building = (async () => {
      try {
        const value = await o.build();
        kept = await prepareJson(value, now(), now() - started);
        fromFile = false;
        save(kept);
        // read after the build: the spines it read are known only then (a file written mid-build waits for everyMs).
        sig = sign();
        return kept;
      } catch (e) {
        o.log?.(`kept answer: build failed, the last answer stands: ${(e as Error)?.message ?? e}`);
        return undefined;
      } finally {
        building = undefined;
      }
    })();
    return building;
  };

  const tick = async () => {
    if (!kept || building) return;
    const age = now() - kept.at;
    if (age >= o.everyMs || (age >= o.minGapMs && sign() !== sig)) await refresh();
  };

  const start = () => {
    if (timer || o.timer === false) return;
    timer = setInterval(() => void tick(), o.checkMs);
    timer.unref?.();
  };

  return {
    get() {
      if (kept && fromFile && !first) {
        // the saved answer from before this start: send it now, build the fresh one behind it
        start();
        first = Promise.resolve(kept);
        void refresh();
      }
      if (kept) return Promise.resolve(kept);
      if (!first) {
        start();
        first = refresh().then((p) => {
          if (p ?? kept) return (p ?? kept)!;
          throw new Error("the answer could not be built");
        });
        first.catch(() => (first = undefined));
      }
      return first;
    },
    refresh,
    tick,
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

/** answers a prepared JSON: 304 when the browser has it, gzip when it takes it; leanJson leaves it alone (ETag set). */
export function sendPrepared(c: Context, p: PreparedJson, now = Date.now()): Response {
  const headers = new Headers({
    "Content-Type": "application/json",
    ETag: p.etag,
    "Cache-Control": "private, no-cache",
    Vary: "Accept-Encoding",
    // how old the kept answer is, and how long it took to build (the slow-request check reads them)
    "X-Answer-Age": String(Math.max(0, Math.round((now - p.at) / 1000))),
    "X-Answer-Build-Ms": String(p.tookMs),
  });
  if (etagMatches(c.req.header("If-None-Match"), p.etag)) {
    headers.delete("Content-Type");
    return new Response(null, { status: 304, headers });
  }
  if (/\bgzip\b/i.test(c.req.header("Accept-Encoding") ?? "")) {
    headers.set("Content-Encoding", "gzip");
    return new Response(new Uint8Array(p.gz), { status: 200, headers });
  }
  return new Response(new Uint8Array(p.json), { status: 200, headers });
}
