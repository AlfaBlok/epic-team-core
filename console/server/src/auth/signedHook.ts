import crypto from "node:crypto";
import fs from "node:fs";

/** A secret read from its file at each call (trimmed; undefined when absent or empty). Moved unchanged from stripeTesters.ts. */
export function secretFromFile(file: string): () => string | undefined {
  return () => {
    try {
      return fs.readFileSync(file, "utf8").trim() || undefined;
    } catch {
      return undefined;
    }
  };
}

/**
 * A signed webhook's header check, `t=<unix s>,v1=<hex HMAC-SHA256 of "<t>.<body>">` within a tolerance (Stripe's scheme;
 * the memory service relay signs its deliveries the same way). Moved unchanged from stripeTesters.ts.
 */
export function verifyStripeSignature(body: string, header: string | undefined, secret: string, nowSec: number, toleranceSec = 300): boolean {
  if (!header || !secret) return false;
  const parts = header.split(",").map((p) => p.trim().split("="));
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v ?? "");
  if (!Number.isFinite(t) || !sigs.length || Math.abs(nowSec - t) > toleranceSec) return false;
  const want = crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest();
  return sigs.some((s) => {
    const got = Buffer.from(s, "hex");
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  });
}
