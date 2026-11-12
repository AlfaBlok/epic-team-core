import { describe, expect, it } from "vitest";
import { createMockClient } from "./mock";
import type { Me } from "./types";

// the mock answers /api/me as the live console does with CONSOLE_AUTH off (the home world, console skin).
describe("getMe (mock)", () => {
  it("is today's world with auth off", async () => {
    const me: Me = await createMockClient().getMe!();
    expect(me.mode).toBe("off");
    expect(me.identity).toEqual({ kind: "legacy", tenantId: "home" });
    expect(me.tenant?.skin).toBe("console");
    expect(me.worlds).toEqual([]);
  });
});
