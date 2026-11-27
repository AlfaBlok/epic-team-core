import { describe, expect, it } from "vitest";
import { callLimitLine, clockNote, quietLine, spanWords } from "./timeLeft";

// the words every call kind says before its limits, in the call's language.
describe("time left said out loud", () => {
  it("names the span in words", () => {
    expect(spanWords(120)).toBe("two minutes");
    expect(spanWords(60)).toBe("one minute");
    expect(spanWords(30)).toBe("30 seconds");
    expect(spanWords(10)).toBe("ten seconds");
    expect(spanWords(120, "es")).toBe("dos minutos");
    expect(spanWords(60, "es")).toBe("un minuto");
    expect(spanWords(10, "es")).toBe("diez segundos");
  });
  it("the call limit and the quiet hang-up, English and Spanish", () => {
    expect(callLimitLine(120)).toBe("Heads up: about two minutes left on this call. You can call again after.");
    expect(callLimitLine(120, "es")).toBe("Aviso: quedan dos minutos de llamada. Luego puedes volver a llamar.");
    expect(callLimitLine(60, "es")).toBe("Aviso: queda un minuto de llamada. Luego puedes volver a llamar.");
    expect(quietLine(10)).toBe("Still there? I'll hang up in ten seconds.");
    expect(quietLine(10, "es")).toBe("¿Sigues ahí? Cuelgo en diez segundos.");
  });
  it("the agent's note asks for the words exactly", () => {
    expect(clockNote("Still there?")).toMatch(/^\[call clock\].*say exactly "Still there\?"/);
  });
});
