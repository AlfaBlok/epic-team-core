// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type SocialDigestView, type SocialWriteResult } from "@/api";
import { AppRoutes } from "@/App";
import { SidebarNav } from "@/components/Layout";
import { SKINS, SkinProvider } from "@/lib/skin";
import { parseC6, sampleDigest, undoAction } from "@/lib/digest";
import { sampleSocialData } from "@/lib/social";
import { DigestPage } from "@/pages/Digest";

// the 20:00 digest page (social skin) and the C6 Undo control.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const VIEW: SocialDigestView = (() => {
  const v = sampleDigest("social", "2026-10-27");
  v.page = "https://social.example/digest?date=2026-10-27";
  v.sent = { at: "2026-10-27T20:00:05Z", error: null };
  v.digest.held = [{ ...v.digest.posts[0], id: "P-0009", status: "held", title: "a held one", link: null }];
  v.digest.report = { date: "2026-10-27", path: "data/reports/2026-10-27.md", numbers: "2 out, 9 replies", best_worst: null, learned: "questions work", highlights: null, feedback: null, cost: null };
  return v;
})();

const renderAt = (url: string, el = <DigestPage />) =>
  render(
    <SkinProvider skin={SKINS.social}>
      <MemoryRouter initialEntries={[url]}>{el}</MemoryRouter>
    </SkinProvider>,
  );

describe("C6 rule lines", () => {
  it("parse the [C6 S<n>: …] tag; other rules are not C6", () => {
    expect(parseC6("- shorter on X [C6 S2: feedback F1, F4 on P-0138, P-0143]")).toEqual({ id: "S2", text: "shorter on X", feedback: ["F1", "F4"], posts: ["P-0138", "P-0143"] });
    expect(parseC6("Do disclose. [Voice]")).toBeUndefined();
    expect(undoAction("S2")).toEqual({ action: "style-rules/S2/undo" });
  });
});

describe("Digest page", () => {
  it("shows the day: went out with links, the report, sent status; date from ?date=", async () => {
    const get = vi.spyOn(api, "getSocialDigest").mockResolvedValue(VIEW);
    renderAt("/digest?date=2026-10-27");
    const out = await screen.findByTestId("digest-went-out");
    expect(get).toHaveBeenCalledWith(expect.any(String), "2026-10-27", undefined);
    const first = VIEW.digest.posts[0];
    expect(within(out).getByText(first.title!).closest("a")!.getAttribute("href")).toBe(first.link);
    expect(screen.getByTestId("digest-sent").textContent).toMatch(/Sent to you in the desk chat at 20:00 UTC/);
    expect(within(screen.getByTestId("digest-report")).getByText("2 out, 9 replies")).toBeTruthy();
    expect(within(screen.getByTestId("digest-held")).getAllByRole("listitem")).toHaveLength(1);
  });

  it("Undo on a C6 rule calls the write API's style-rules/<id>/undo", async () => {
    vi.spyOn(api, "getSocialDigest").mockResolvedValue(VIEW);
    const write = vi.spyOn(api, "socialWrite").mockResolvedValue({ ...sampleSocialData("social"), action: "style rule undo", id: "S1", commit: "abc", push: { state: "pushed" }, files: [] } as SocialWriteResult);
    renderAt("/digest");
    const rule = await screen.findByTestId("c6-rule");
    expect(rule.textContent).toMatch(/shorter on X/);
    fireEvent.click(within(rule).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(write).toHaveBeenCalledWith("social", { action: "style-rules/S1/undo" }, "social"));
    expect((await screen.findByTestId("c6-msg")).textContent).toBe("Style rule S1 removed.");
  });

  it("a note on a post is feedback; a repeat reports the new Style rule", async () => {
    vi.spyOn(api, "getSocialDigest").mockResolvedValue(VIEW);
    const write = vi.spyOn(api, "socialWrite").mockResolvedValue({
      ...sampleSocialData("social"),
      action: "feedback",
      id: "P-0001",
      commit: "abc",
      push: { state: "pushed" },
      files: [],
      info: { styleRule: { id: "S2", text: "shorter", feedback: ["F1", "F2"], posts: [] } },
    } as SocialWriteResult);
    renderAt("/digest");
    const post = (await screen.findAllByTestId("digest-post"))[0];
    const id = VIEW.digest.posts[0].id;
    fireEvent.change(within(post).getByLabelText(`note on ${id}`), { target: { value: "shorter" } });
    fireEvent.click(within(post).getByRole("button", { name: "Note" }));
    await waitFor(() => expect(write).toHaveBeenCalledWith("social", { action: `posts/${id}/feedback`, body: { feedback: "shorter" } }, "social"));
    expect((await within(post).findByTestId("digest-post-msg")).textContent).toMatch(/new Style rule S2 "shorter"/);
  });

  it("is a social-skin screen: route, no sidebar link (T58-S3: digests sit in the campaign's History); the console skin has neither", () => {
    expect(SKINS.social.screens.has("digest")).toBe(false);
    expect(SKINS.social.reach?.has("digest")).toBe(true);
    expect(SKINS.console.screens.has("digest")).toBe(false);
    vi.spyOn(api, "getSocialDigest").mockResolvedValue(VIEW);
    render(
      <SkinProvider skin={SKINS.social}>
        <MemoryRouter initialEntries={["/digest"]}>
          <SidebarNav />
          <AppRoutes />
        </MemoryRouter>
      </SkinProvider>,
    );
    expect(screen.queryAllByRole("link", { name: /Digest/ })).toHaveLength(0);
    expect(screen.queryByText(/Not found\./)).toBeNull();
  });
});
