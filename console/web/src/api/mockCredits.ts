import { homeWorld } from "@/lib/identity";
import type { CreditGrantInput, CreditGrantResult, CreditLedgerEntry, Credits } from "./types";

/** mock credits: the home world is internal (metered, never held); every other world is on the founding plan. */
export function mockCredits(now: () => Date) {
  const worlds = new Map<string, { plan: string; gate: boolean; ledger: CreditLedgerEntry[]; since: string }>();
  const day = (offset: number) => new Date(now().getTime() - offset * 86400_000).toISOString();
  const entry = (tenantId: string, i: number, at: string, kind: CreditLedgerEntry["kind"], credits: number, extra: Partial<CreditLedgerEntry> = {}): CreditLedgerEntry => ({
    id: `cl_${tenantId}_${i}`,
    tenantId,
    at,
    kind,
    millicredits: Math.round(credits * 1000),
    credits,
    note: "",
    actor: kind === "debit" ? "usage" : "platform",
    ...extra,
  });
  const world = (tenantId: string) => {
    let w = worlds.get(tenantId);
    if (!w) {
      const ledger: CreditLedgerEntry[] = [];
      const internal = tenantId === homeWorld();
      if (!internal) ledger.push(entry(tenantId, 0, day(20), "grant", 4000, { note: "founding plan: first grant" }));
      for (let d = 19; d >= 0; d -= 1)
        ledger.push(entry(tenantId, 20 - d, day(d), "debit", -(40 + ((d * 37) % 90)), { runId: `run_mock_${d}`, priceKey: "claude-seat", model: "claude-sonnet-5-5", notional: true, note: "claude-seat claude-sonnet-5-5 (notional: seat run at API list price)" }));
      w = { plan: internal ? "internal" : "founding", gate: false, ledger: ledger.reverse(), since: day(21) };
      worlds.set(tenantId, w);
    }
    return w;
  };
  const get = (tenantId: string): Credits => {
    const w = world(tenantId);
    const balanceMc = w.ledger.reduce((s, e) => s + e.millicredits, 0);
    const unlimited = tenantId === homeWorld() || w.plan === "internal";
    const lastGrant = w.ledger.find((e) => e.kind === "grant");
    const next = lastGrant ? new Date(lastGrant.at) : undefined;
    if (next) while (next.getTime() <= now().getTime()) next.setUTCMonth(next.getUTCMonth() + 1);
    const burn = Array.from({ length: 30 }, (_, i) => {
      const d = day(29 - i).slice(0, 10);
      const debits = w.ledger.filter((e) => e.kind === "debit" && e.at.slice(0, 10) === d);
      const c = -debits.reduce((s, e) => s + e.credits, 0);
      return { day: d, credits: c, notionalCredits: -debits.filter((e) => e.notional).reduce((s, e) => s + e.credits, 0) };
    });
    return {
      tenantId,
      plan: w.plan,
      unlimited,
      gate: w.gate,
      balance: Math.round(balanceMc / 10) / 100,
      balanceMc,
      monthlyGrant: unlimited ? 0 : 4000,
      ...(next && !unlimited ? { nextGrantAt: next.toISOString() } : {}),
      ...(lastGrant ? { lastGrantAt: lastGrant.at } : {}),
      held: w.gate && !unlimited && balanceMc <= 0,
      since: w.since,
      burn,
      ledger: w.ledger.slice(0, 100),
    };
  };
  return {
    get,
    grant(tenantId: string, input: CreditGrantInput): CreditGrantResult {
      const w = world(tenantId);
      const e = entry(tenantId, w.ledger.length + 1, now().toISOString(), input.kind ?? "topup", input.credits, { note: input.note ?? "" });
      w.ledger.unshift(e);
      return { entry: e, credits: get(tenantId) };
    },
    setGate(tenantId: string, on: boolean) {
      world(tenantId).gate = on;
      return { credits: get(tenantId) };
    },
  };
}
