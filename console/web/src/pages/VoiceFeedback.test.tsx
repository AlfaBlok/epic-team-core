// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/api";
import { VoiceFeedbackPage } from "./VoiceFeedback";


// the owner makes a voice feedback link and reads each filed item (who, sentiment, summary, asks, bugs, the repo file).

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("T46-S20 VoiceFeedbackPage", () => {
  it("shows each filed item from the repo and the links", async () => {
    vi.spyOn(api, "listFeedback").mockResolvedValue({
      repo: "home_repo",
      dir: "feedback/voice",
      public: false,
      notes: [],
      links: [{ id: "fbl_1", token: "t", url: "https://team.example.com/api/public/feedback/t", world: "home", who: "Ana", product: "SocialApp", campaign: "testers", createdAt: "2026-11-08T17:00:00Z", createdBy: "Sam", notes: 1 }],
      filed: [{ file: "feedback/voice/2026-11-08-fbn_1.md", fields: { from: "Ana", product: "SocialApp", campaign: "testers", sentiment: "mixed", length_s: "90", received: "2026-11-08T17:02:00Z", status: "new" }, summary: "Ana likes the drafts.", asks: ["A dark mode"], bugs: ["Send fails on Safari"] }],
    });
    render(<VoiceFeedbackPage />, { wrapper: MemoryRouter });
    expect(await screen.findAllByTestId("feedback-item")).toHaveLength(1);
    expect(screen.getByText("Ana likes the drafts.")).toBeTruthy();
    expect(screen.getByText("A dark mode")).toBeTruthy();
    expect(screen.getByText("Send fails on Safari")).toBeTruthy();
    expect(screen.getByText("feedback/voice/2026-11-08-fbn_1.md").getAttribute("href")).toBe("https://github.com/Acme/home_repo/blob/main/feedback/voice/2026-11-08-fbn_1.md");
    expect(screen.getByTestId("feedback-not-public")).toBeTruthy();
    expect(screen.getAllByTestId("feedback-link")).toHaveLength(1);
  });
  it("Make link shows the link to send with a suggested message", async () => {
    vi.spyOn(api, "listFeedback").mockResolvedValue({ repo: "home_repo", dir: "feedback/voice", public: true, notes: [], links: [], filed: [] });
    const make = vi.spyOn(api, "createFeedbackLink").mockResolvedValue({ id: "fbl_2", token: "tok", url: "https://signup.example.com/api/public/feedback/tok", world: "home", who: "Bo", product: "SocialApp", campaign: "testers", createdAt: "", createdBy: "Sam", notes: 0 });
    render(<VoiceFeedbackPage />, { wrapper: MemoryRouter });
    fireEvent.change(await screen.findByLabelText("Their name"), { target: { value: "Bo" } });
    fireEvent.click(screen.getByTestId("feedback-make"));
    expect((await screen.findByTestId("feedback-made")).textContent).toContain("https://signup.example.com/api/public/feedback/tok");
    expect(make).toHaveBeenCalledWith({ who: "Bo", product: "SocialApp", campaign: "testers" });
  });
  it("iteration 2: the button is never greyed out; an empty name says what to do and makes nothing", async () => {
    vi.spyOn(api, "listFeedback").mockResolvedValue({ repo: "home_repo", dir: "feedback/voice", public: true, notes: [], links: [], filed: [] });
    const make = vi.spyOn(api, "createFeedbackLink");
    render(<VoiceFeedbackPage />, { wrapper: MemoryRouter });
    const btn = (await screen.findByTestId("feedback-make")) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect((await screen.findByTestId("feedback-error")).textContent).toContain("Type their name first");
    expect(document.activeElement).toBe(screen.getByLabelText("Their name"));
    expect(make).not.toHaveBeenCalled();
  });
  it("iteration 2: Enter in the name box makes the link; the message to send carries the link; empty campaign is left out", async () => {
    vi.spyOn(api, "listFeedback").mockResolvedValue({ repo: "home_repo", dir: "feedback/voice", public: true, notes: [], links: [], filed: [] });
    const make = vi.spyOn(api, "createFeedbackLink").mockResolvedValue({ id: "fbl_3", token: "k", url: "https://signup.example.com/api/public/feedback/k", world: "home", who: "Cy", product: "SocialApp", campaign: "", createdAt: "", createdBy: "Sam", notes: 0 });
    render(<VoiceFeedbackPage />, { wrapper: MemoryRouter });
    fireEvent.change(screen.getByLabelText("Campaign"), { target: { value: " " } });
    const name = await screen.findByLabelText("Their name");
    fireEvent.change(name, { target: { value: "Cy" } });
    fireEvent.submit(name.closest("form")!);
    expect((await screen.findByTestId("feedback-message")).textContent).toContain("https://signup.example.com/api/public/feedback/k");
    expect(make).toHaveBeenCalledWith({ who: "Cy", product: "SocialApp", campaign: undefined });
    expect(screen.getByTestId("feedback-copy-message")).toBeTruthy();
    expect(screen.getByText("Copy link")).toBeTruthy();
  });
});
