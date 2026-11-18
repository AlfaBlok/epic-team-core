/**
 * The launch block at the top of the social product's Performance page: one screen, current. Every channel live or not
 * and why not, with its daily calls against the owner's number, and the objective's key results beside them
 * (docs/scorecards/<id>.json, measured by the pursuit checks; the daily calls in <callsDir>/<day>.json).
 * Posts out, replies and followers per channel come from the campaign repo's own KPI series (GET social/kpis?repo=…),
 * visits and sign-ups from the site counter (GET site-kpis): the web joins them, this file adds no second count.
 * Nothing is guessed: a channel nobody reads says "not measured yet", one without an account says so.
 */

export type LaunchState = "green" | "amber" | "red" | "unknown";
export type LaunchChannelKey = "x" | "reddit" | "linkedin" | "tiktok" | "youtube";

export interface LaunchKeyResult {
  label: string;
  value: string;
  state: LaunchState;
  target?: string;
  note?: string;
  measuredAt?: string;
  evidence?: { what: string; url: string };
}

export interface LaunchChannel {
  key: LaunchChannelKey;
  name: string;
  account: string;
  /** its public page when it exists. */
  url: string | null;
  /** true = read live this day, false = no account yet, null = not read (we cannot say). */
  live: boolean | null;
  /** why not live, or why it was not read; null when live. */
  why: string | null;
  /** call posts counted today (the owner's day); null = this channel has no daily call. */
  callsToday: number | null;
  callsTarget: number | null;
}

export interface LaunchBody {
  tenantId: string;
  shown: boolean;
  /** the objective as he named it in docs/pursuits.json. */
  objective: string | null;
  /** the campaign repo whose KPI series carry posts, replies and followers (null = not named). */
  campaignRepo: string | null;
  /** the site whose visits and sign-ups count for this launch (null = not named). */
  site: string | null;
  keyResults: LaunchKeyResult[];
  channels: LaunchChannel[];
  /** when the tester calls were last read, and for which day. */
  callsReadAt: string | null;
  callsDay: string | null;
}

/** One launch: its objective's id in docs/pursuits.json and its channels (the accounts list's words); a channel with `why` has no read. */
export interface LaunchConfig {
  pursuit: string;
  /** where the daily call reads are kept, one file per day (`<day>.json`). */
  callsDir: string;
  channels: { key: LaunchChannelKey; name: string; account: string; url: string | null; why?: string }[];
}

type Raw = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const stateOf = (v: unknown): LaunchState => (v === "green" || v === "amber" || v === "red" ? v : "unknown");

/** The scorecard file's live key results (the ones he took out stay out). */
export function launchKeyResults(scorecardText: string | null): LaunchKeyResult[] {
  if (!scorecardText) return [];
  let j: Raw;
  try {
    j = JSON.parse(scorecardText) as Raw;
  } catch {
    return [];
  }
  const krs = Array.isArray(j.keyResults) ? (j.keyResults as Raw[]) : [];
  return krs.flatMap((k) => {
    const label = str(k.label);
    if (!label) return [];
    const ev = k.evidence as Raw | undefined;
    const evidence = ev && str(ev.url) ? { what: str(ev.what) ?? "evidence", url: str(ev.url)! } : undefined;
    return [
      {
        label,
        value: str(k.value) ?? "not measured yet",
        state: stateOf(k.colour),
        ...(str(k.target) ? { target: str(k.target) } : {}),
        ...(str(k.note) ? { note: str(k.note) } : {}),
        ...(str(k.measuredAt) ? { measuredAt: str(k.measuredAt) } : {}),
        ...(evidence ? { evidence } : {}),
      },
    ];
  });
}

/** One channel's state from the newest tester-call read (null read = not read yet). */
export function launchChannels(cfg: LaunchConfig, callsText: string | null): { channels: LaunchChannel[]; readAt: string | null; day: string | null } {
  let c: Raw | null = null;
  try {
    c = callsText ? (JSON.parse(callsText) as Raw) : null;
  } catch {
    c = null;
  }
  const reads = (c?.reads ?? {}) as Record<string, Raw>;
  const target = (c?.target ?? {}) as Record<string, unknown>;
  const days = (c?.days ?? {}) as Record<string, Record<string, unknown>>;
  const day = Object.keys(days).sort().pop() ?? null;
  const channels = cfg.channels.map((ch): LaunchChannel => {
    const base = { key: ch.key, name: ch.name, account: ch.account, url: ch.url } as const;
    if (ch.why) return { ...base, url: null, live: false, why: ch.why, callsToday: null, callsTarget: null };
    const r = reads[ch.key];
    const t = typeof target[ch.key] === "number" ? (target[ch.key] as number) : null;
    const n = day && typeof days[day]?.[ch.key] === "number" ? (days[day][ch.key] as number) : null;
    if (!r) return { ...base, live: null, why: "not measured yet", callsToday: null, callsTarget: t };
    const state = str(r.state);
    if (state === "read") return { ...base, live: true, why: null, callsToday: n, callsTarget: t };
    if (state === "no account") return { ...base, url: null, live: false, why: str(r.note) ?? "no account yet", callsToday: null, callsTarget: t };
    return { ...base, live: null, why: str(r.note) ? `not read: ${str(r.note)}` : "not read", callsToday: null, callsTarget: t };
  });
  return { channels, readAt: str(c?.readAt) ?? null, day };
}

/** The launch's objective from docs/pursuits.json: its name and where its numbers live (`numbers.campaign`, `numbers.site`). */
export function launchPursuit(cfg: LaunchConfig, pursuitsText: string | null): { name: string | null; campaign: string | null; site: string | null } {
  try {
    const j = JSON.parse(pursuitsText ?? "") as Raw;
    const p = ((Array.isArray(j.pursuits) ? j.pursuits : []) as Raw[]).find((x) => x.id === cfg.pursuit);
    const n = (p?.numbers ?? {}) as Raw;
    return { name: str(p?.name) ?? null, campaign: str(n.campaign) ?? null, site: str(n.site) ?? null };
  } catch {
    return { name: null, campaign: null, site: null };
  }
}

export function computeLaunch(cfg: LaunchConfig, o: { tenantId: string; shown: boolean; scorecardText: string | null; callsText: string | null; pursuitsText: string | null }): LaunchBody {
  const { channels, readAt, day } = launchChannels(cfg, o.shown ? o.callsText : null);
  const p = launchPursuit(cfg, o.shown ? o.pursuitsText : null);
  return {
    tenantId: o.tenantId,
    shown: o.shown,
    objective: p.name,
    campaignRepo: p.campaign,
    site: p.site,
    keyResults: o.shown ? launchKeyResults(o.scorecardText) : [],
    channels: o.shown ? channels : [],
    callsReadAt: readAt,
    callsDay: day,
  };
}
