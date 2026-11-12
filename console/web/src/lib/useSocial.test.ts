import { describe, expect, it } from "vitest";
import type { Me } from "@/api/types";
import { worldId } from "./useSocial";

// the world the social screens read. The server's /api/me names it (auth/gate.ts); both skins follow it.
const me = (tenant: { id: string; skin: string } | null, kind = "none") => async () => ({ mode: "shadow", identity: { kind }, tenant, worlds: [] }) as unknown as Me;

describe("T21-S17 worldId: the social console follows its world before login", () => {
  it("social skin: social.example.com's /api/me names social → its campaign", async () => {
    expect(await worldId(me({ id: "social", skin: "social" }))).toBe("social");
  });
  it("console skin: team.example.com's /api/me names home, or no world (shadow) → home as before", async () => {
    expect(await worldId(me({ id: "home", skin: "console" }, "legacy"))).toBe("home");
    expect(await worldId(me(null))).toBe("home");
  });
  it("no /api/me (mock api) → home", async () => {
    expect(await worldId(undefined)).toBe("home");
  });
  it("T48-S7: a failing /api/me (timeout, 502 on restart) throws, never home", async () => {
    await expect(worldId(async () => Promise.reject(new Error("down")))).rejects.toThrow("down");
  });
});
