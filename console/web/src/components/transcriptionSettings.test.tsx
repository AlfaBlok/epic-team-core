// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TranscriptionSettings, type TranscriptionView } from "./transcriptionSettings";

// "a settings section... what is the model that is being used for transcription
// and what's the cost in the last 30 days". He picks the model (ours first) and the paid backup; the model in use and the
// last 30 days' cost sit beside his choice.

afterEach(cleanup);

const view = (o: Partial<TranscriptionView["settings"]> = {}): TranscriptionView => ({
  settings: { model: "large-v3-turbo", paidBackup: true, ...o },
  models: [
    { id: "large-v3-turbo", label: "Whisper large-v3-turbo", kind: "ours", note: "On our server, free." },
    { id: "small", label: "Whisper small", kind: "ours", note: "On our server, free. Faster." },
    { id: "gemini", label: "Gemini Flash", kind: "paid", note: "Google, paid." },
  ],
  benchmark: { url: "https://example.com/model-test/", summary: "Measured on 19 of your notes, 50 min of speech." },
  inUse: { model: "whisper-large-v3-turbo", provider: "local", at: "2026-11-22T20:00:00Z" },
  last30: {
    usd: 2.68,
    minutes: 1003,
    lines: [
      { provider: "local", model: "whisper-large-v3-turbo", parts: 2, minutes: 4, usd: 0 },
      { provider: "openai", model: "gpt-4o-mini-transcribe", parts: 875, minutes: 908, usd: 2.35 },
      { provider: "gemini", model: "gemini-flash-latest", parts: 63, minutes: 91, usd: 0.33 },
    ],
    serverMinutes: 3,
    backupParts: 0,
  },
  calls: { on: false, count: 59, usd: 5.78 },
});

describe("Settings, Transcription", () => {
  it("shows ours first, the model in use and the last 30 days' cost; a pick saves", async () => {
    const save = vi.fn(async (b: Partial<TranscriptionView["settings"]>) => view(b));
    render(<TranscriptionSettings load={async () => view()} save={save} />);
    await screen.findByTestId("transcription-settings");
    expect(screen.getByTestId("transcription-in-use").textContent).toBe("Whisper large-v3-turbo, our server, free");
    expect(screen.getByTestId("transcription-30d").textContent).toBe("$2.68 for 1003 min");
    expect(screen.getByTestId("transcription-cost").textContent).toContain("Voice calls, now off");
    expect(screen.getByTestId("transcription-server-time").textContent).toContain("3 min, free");
    const bench = screen.getByTestId("transcription-benchmark");
    expect(bench.textContent).toContain("19 of your notes");
    expect(bench.querySelector("a")?.getAttribute("href")).toBe("https://example.com/model-test/");
    const labels = screen.getAllByRole("radio").map((r) => r.closest("label")?.textContent);
    expect(labels[0]).toContain("Whisper large-v3-turbo");
    fireEvent.click(screen.getAllByRole("radio")[1]);
    await waitFor(() => expect(save).toHaveBeenCalledWith({ model: "small" }));
    await waitFor(() => expect((screen.getAllByRole("radio")[1] as HTMLInputElement).checked).toBe(true));
  });

  it("not his console: nothing shows", async () => {
    const { container } = render(<TranscriptionSettings load={async () => undefined} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).toBe("");
  });
});
