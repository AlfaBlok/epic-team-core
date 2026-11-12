import { describe, expect, it, vi } from "vitest";
import { LOGIN_PAGE } from "../src/auth/loginPage.js";

describe("T43-S2 brand family on the login page", () => {
  it("titles the page EpicTeam, and SocialApp on social.example.com", () => {
    expect(LOGIN_PAGE()).toContain("<title>Log in · EpicTeam</title>");
    expect(LOGIN_PAGE()).toContain('location.hostname === "social.example.com") document.title = "Log in · SocialApp"');
    expect(LOGIN_PAGE()).not.toContain("home_repo</title>");
  });
});
