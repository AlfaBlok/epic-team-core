import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deskVoiceBase } from "@/voice/deskBase";

// which desk records a voice
// note is one rule, voice/deskBase.ts, for every control on both sites (top bar mic, Chat, card boxes). Found it
// written twice (Layout.tsx had its own copy). This fails when any other source file builds a desk's voice route again.

const SRC = path.resolve(__dirname, "..");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
  });
/** Code only: comments name the route in words, which is fine. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("T101-S7: one rule for which desk records a voice note", () => {
  it("only voice/deskBase.ts builds a world desk's voice route", () => {
    const owners = files(SRC)
      .filter((f) => /desk\/voice/.test(code(readFileSync(f, "utf8"))))
      .map((f) => path.relative(SRC, f));
    expect(owners).toEqual([path.join("voice", "deskBase.ts")]);
  });

  it("the rule: home records on its Team desk, every other world on its own desk", () => {
    expect(deskVoiceBase(undefined)).toBe("/api/voice");
    expect(deskVoiceBase("home")).toBe("/api/voice");
    expect(deskVoiceBase("social")).toBe("/api/tenants/social/desk/voice");
  });

  it("Layout and Chat take the rule from voice/deskBase, never their own copy", () => {
    for (const f of ["components/Layout.tsx", "pages/Chat.tsx"]) {
      const text = readFileSync(path.join(SRC, f), "utf8");
      expect(text, f).toMatch(/import \{[^}]*\bdeskVoiceBase\b[^}]*\} from "@\/voice\/deskBase"/);
      expect(code(text), f).not.toMatch(/(?:const|function)\s+deskVoiceBase\b/);
    }
  });
});
