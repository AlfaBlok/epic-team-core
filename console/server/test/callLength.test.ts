import { describe, expect, it } from "vitest";
import { CALL_MAX_MIN, CALL_WARN_MIN, callLength } from "../src/voice/voice.js";

// a TEST console may shorten a call to hear its spoken time left; production keeps 20 and 18 minutes.
describe("call length", () => {
  it("production: 20 minutes, the time left said at 18", () => {
    expect(callLength({})).toEqual({ callMaxMin: CALL_MAX_MIN, callWarnMin: CALL_WARN_MIN });
  });
  it("a TEST console's short limit, and a warning that never comes after it", () => {
    expect(callLength({ CONSOLE_CALL_MAX_MIN: "1.5", CONSOLE_CALL_WARN_MIN: "1" })).toEqual({ callMaxMin: 1.5, callWarnMin: 1 });
    expect(callLength({ CONSOLE_CALL_MAX_MIN: "3" })).toEqual({ callMaxMin: 3, callWarnMin: 1.5 });
    expect(callLength({ CONSOLE_CALL_MAX_MIN: "1", CONSOLE_CALL_WARN_MIN: "5" })).toEqual({ callMaxMin: 1, callWarnMin: 0.5 });
    expect(callLength({ CONSOLE_CALL_MAX_MIN: "90" })).toEqual({ callMaxMin: CALL_MAX_MIN, callWarnMin: CALL_WARN_MIN });
  });
});
