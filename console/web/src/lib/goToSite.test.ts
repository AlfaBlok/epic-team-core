// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { goToSite } from "./inPlaceLinks";

// The owner 28 Nov (e-e3055a, said again e-33b9a3): in the installed app a bar with a cross showed, "like I'm never
// in the actual app". A world switch loaded the other site (the social site) over the installed app, outside its scope.
describe("goToSite: the installed app never loads another site over itself", () => {
  const other = "https://social.example.com/login#handoff=abc";
  it("installed app, another site: a new window, the app stays", () => {
    const assign = vi.fn();
    const open = vi.fn();
    expect(goToSite(other, { installed: true, assign, open })).toBe("window");
    expect(open).toHaveBeenCalledWith(other);
    expect(assign).not.toHaveBeenCalled();
  });
  it("installed app, this same site: moves in place as before", () => {
    const assign = vi.fn();
    const open = vi.fn();
    expect(goToSite("/inbox", { installed: true, assign, open })).toBe("here");
    expect(assign).toHaveBeenCalledWith("/inbox");
    expect(open).not.toHaveBeenCalled();
  });
  it("a browser tab: the window moves to the other site as before", () => {
    const assign = vi.fn();
    const open = vi.fn();
    expect(goToSite(other, { installed: false, assign, open })).toBe("here");
    expect(assign).toHaveBeenCalledWith(other);
    expect(open).not.toHaveBeenCalled();
  });
});
