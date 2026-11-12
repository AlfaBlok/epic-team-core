import { describe, expect, it } from "vitest";
import { LOGIN_PAGE } from "../src/auth/loginPage.js";
import { socialHead } from "../src/brand.js";

// the login page shows the product's mark and its one-word name, and its card fits a phone.
describe("T65-S5 login page", () => {
  it("leads with the host's mark and name: EpicTeam, or SocialApp on a social host", () => {
    expect(LOGIN_PAGE()).toContain('<div class="brand"><img src="/favicon.svg" width="32" height="32" alt=""><span data-brand-name>EpicTeam</span></div>');
    expect(socialHead(LOGIN_PAGE())).toContain("<span data-brand-name>SocialApp</span>");
  });

  it("the card counts its padding in its width, so 92vw never runs past a phone's edge", () => {
    expect(LOGIN_PAGE()).toMatch(/main\{box-sizing:border-box;width:min\(360px,92vw\)/);
  });
});
