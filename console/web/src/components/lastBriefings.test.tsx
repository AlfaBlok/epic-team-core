// @vitest-environment jsdom
// The owner: "Where in the UI can I get access to the last snapshot of these
// briefings? Where are they?" Home, under the Briefing button: the newest 06:00 and 18:30 pictures, earlier ones one tap away.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api, type BriefingPictures } from "@/api";
import { deliveryWords, LastBriefings, splitBriefings } from "@/components/lastBriefings";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

let k = 0;
const pic = (n: string, what: string) => ({ url: `/api/notify/lights/${n.repeat(12)}${String(++k).padStart(12, "0")}.png`, what, ok: true, receipt: `whatsapp:${n}:sent` });
const morning = (at: string, n: string): BriefingPictures => ({ briefing: "morning", at, pictures: [pic(n, "Team objectives"), pic(n, "Team last day"), pic(n, "Social channels"), pic(n, "Social plan")] });
const evening = (at: string, n: string): BriefingPictures => ({ briefing: "evening", at, pictures: [pic(n, "Social plan"), pic(n, "Social channels 7d")] });
const all = [morning("2026-11-20T12:00:30Z", "a"), evening("2026-11-20T00:30:10Z", "b"), morning("2026-11-19T14:49:00Z", "c"), evening("2026-11-19T00:30:00Z", "d")];

describe("the last briefings on Home", () => {
  it("the newest of each briefing first, every other one earlier", () => {
    const { last, earlier } = splitBriefings(all);
    expect(last.map((b) => b.briefing + b.at)).toEqual(["morning2026-11-20T12:00:30Z", "evening2026-11-20T00:30:10Z"]);
    expect(earlier).toHaveLength(2);
  });

  it("shows the 06:00 four and the 18:30 two; a tap opens one large; earlier briefings are one tap away", async () => {
    (api as { getBriefingPictures?: unknown }).getBriefingPictures = vi.fn(async () => ({ briefings: all }));
    render(<LastBriefings delayMs={0} />);
    await waitFor(() => expect(screen.getAllByTestId("briefing-pictures")).toHaveLength(2));
    const [m, e] = screen.getAllByTestId("briefing-pictures");
    expect(m.querySelectorAll("img")).toHaveLength(4);
    expect(e.querySelectorAll("img")).toHaveLength(2);
    expect(m.textContent).toContain("Morning briefing");
    fireEvent.click(screen.getAllByTestId("briefing-picture")[1]);
    expect(screen.getByTestId("briefing-picture-open").textContent).toContain("Team last day");
    fireEvent.click(screen.getByTestId("earlier-briefings"));
    expect(screen.getAllByTestId("briefing-pictures")).toHaveLength(4);
  });

  it("asks nothing before the page is idle after its first paint", async () => {
    const get = vi.fn(async () => ({ briefings: all }));
    (api as { getBriefingPictures?: unknown }).getBriefingPictures = get;
    vi.useFakeTimers();
    render(<LastBriefings />);
    expect(get).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(get).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("nothing shows where no briefing was sent", async () => {
    (api as { getBriefingPictures?: unknown }).getBriefingPictures = vi.fn(async () => ({ briefings: [] }));
    const { container } = render(<LastBriefings delayMs={0} />);
    await waitFor(() => expect((api as unknown as { getBriefingPictures: ReturnType<typeof vi.fn> }).getBriefingPictures).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  // each briefing he got is confirmed delivered, not only sent (the channel's delivery receipt)
  it("says whether each briefing reached his phone: read, delivered, not yet, failed; nothing before it is known", async () => {
    expect(deliveryWords("read")?.text).toBe("Read on your phone");
    expect(deliveryWords("delivered")?.text).toBe("Delivered to your phone");
    expect(deliveryWords("sent")?.text).toBe("Sent, not delivered yet");
    expect(deliveryWords("failed")?.tone).toBe("bad");
    expect(deliveryWords(null)).toBeNull();
    const two = [{ ...morning("2026-11-20T12:00:30Z", "a"), delivery: "delivered" as const }, evening("2026-11-20T00:30:10Z", "b")];
    (api as { getBriefingPictures?: unknown }).getBriefingPictures = vi.fn(async () => ({ briefings: two }));
    render(<LastBriefings delayMs={0} />);
    await waitFor(() => expect(screen.getAllByTestId("briefing-pictures")).toHaveLength(2));
    const [m, e] = screen.getAllByTestId("briefing-pictures");
    expect(m.querySelector("[data-testid=briefing-delivery]")?.textContent).toBe("Delivered to your phone");
    expect(e.querySelector("[data-testid=briefing-delivery]")).toBeNull();
  });
});
