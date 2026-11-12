/**
 * the read model's drift check. The repo is the only source; read_model is a cache of it.
 * Every hour the refresher rebuilds each stored view off to the side (fresh spine reads from the checkouts, the same
 * spines.py output the refresher already holds, so no extra spines.py runs) and compares it with the stored payload.
 * A view that still differs after the refresher has had its normal chance to catch up is drift: logged, raised as an
 * alert, and shown by GET /api/health (`drift`) and GET /api/read-model/drift.
 */

/** Fields that are times of the computation, not content: never compared. `askers` is git blame, built only by the refresher. */
export const DRIFT_IGNORED_KEYS = new Set(["at", "asOf", "checkedAt", "computedMs", "generatedAt", "askers"]);

export interface DriftDiff {
  key: string;
  /** JSON path of the first difference, e.g. `items[3].state`. */
  path: string;
  stored: string;
  fresh: string;
}

export interface DriftResult {
  at: string;
  ok: boolean;
  /** Views rebuilt and compared. */
  checked: number;
  /** Views not compared this time (inputs still being read, no stored row yet). */
  skipped: number;
  /** Views that differed at first and matched after the refresher's next pass (it was still catching up). */
  settled: number;
  differ: DriftDiff[];
  ms: number;
  error?: string;
}

/** The comparable content of a view payload: computation times dropped, undefined dropped (JSON round trip). */
export function normalizeView(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalizeView);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      if (DRIFT_IGNORED_KEYS.has(k)) continue;
      const x = (v as Record<string, unknown>)[k];
      if (x === undefined) continue;
      out[k] = normalizeView(x);
    }
    return out;
  }
  return v;
}

const short = (v: unknown) => {
  const s = v === undefined ? "(missing)" : JSON.stringify(v);
  return s.length > 160 ? `${s.slice(0, 159)}…` : s;
};

/** The first place two normalized payloads differ, or undefined when they are the same. */
export function firstDiff(a: unknown, b: unknown, at = ""): { path: string; stored: string; fresh: string } | undefined {
  if (a === b) return undefined;
  const isObj = (x: unknown) => !!x && typeof x === "object";
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = firstDiff(a[i], b[i], `${at}[${i}]`);
      if (d) return d;
    }
    return undefined;
  }
  if (isObj(a) && isObj(b) && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = a as Record<string, unknown>;
    const kb = b as Record<string, unknown>;
    for (const k of [...new Set([...Object.keys(ka), ...Object.keys(kb)])].sort()) {
      const d = firstDiff(ka[k], kb[k], at ? `${at}.${k}` : k);
      if (d) return d;
    }
    return undefined;
  }
  return { path: at || "(root)", stored: short(a), fresh: short(b) };
}

/** The difference between a stored payload (JSON text) and a fresh rebuild of the view, if any. */
export function viewDiff(storedJson: string, fresh: unknown): { path: string; stored: string; fresh: string } | undefined {
  let stored: unknown;
  try {
    stored = JSON.parse(storedJson);
  } catch {
    return { path: "(root)", stored: "(unparseable)", fresh: short(fresh) };
  }
  return firstDiff(normalizeView(stored), normalizeView(JSON.parse(JSON.stringify(fresh ?? null))));
}

/** One line for the log and the alert. */
export function driftLine(r: DriftResult): string {
  if (r.error) return `read model drift check failed: ${r.error}`;
  if (r.ok) return `read model drift check: ${r.checked} views match the repo (${r.skipped} skipped, ${r.settled} caught up) in ${r.ms} ms`;
  const first = r.differ[0]!;
  return `read model DRIFT: ${r.differ.length} of ${r.checked} views differ from a rebuild from the repo; first ${first.key} at ${first.path}: stored ${first.stored}, rebuilt ${first.fresh}`;
}
