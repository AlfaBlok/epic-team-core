import { isIP } from "node:net";

/**
 * the client address for the per-address limit. our site reaches the console as Cloudflare → tunnel
 * (cloudflared on the main server) → Traefik (docker, peer 172.16.0.0/12) → here. Traefik drops forwarded headers from untrusted
 * sources and appends the address it saw, so the LAST X-Forwarded-For entry is Traefik's own view: the tunnel's private
 * address for Cloudflare traffic, the client's address for anyone connecting to the main server directly. Only in the first case is
 * Cf-Connecting-Ip (set by Cloudflare) the visitor; a direct client's own Cf-Connecting-Ip is ignored. A caller not behind
 * Traefik (tailnet, loopback) is its socket peer. An undefined peer is an in-process request (tests, the gateway).
 */
export function clientAddress(peer: string | undefined, header: (n: string) => string | undefined): string {
  const fromProxy = peer === undefined || isPrivate(peer);
  const xff = (header("x-forwarded-for") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const hop = fromProxy ? (xff[xff.length - 1] ?? header("x-real-ip")?.trim() ?? peer) : peer;
  const cf = header("cf-connecting-ip")?.trim();
  if (cf && isIP(cf) && (hop === undefined || isPrivate(hop))) return cf;
  return hop ?? "direct";
}

/** Loopback, RFC 1918 / docker bridges, IPv6 loopback and unique-local; IPv4-mapped IPv6 is read as IPv4. */
export function isPrivate(addr: string): boolean {
  const a = addr.replace(/^::ffff:/i, "");
  if (isIP(a) === 4) {
    const [x, y] = a.split(".").map(Number);
    return x === 127 || x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168);
  }
  if (isIP(a) === 6) return a === "::1" || /^f[cd]/i.test(a);
  return false;
}
