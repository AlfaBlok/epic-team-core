// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { LaptopStep, MacTask, WaitingItem } from "@/api";
import { laptopRows, MacCards } from "@/components/laptopSwitch";

// E996-S29 (the owner: "HOW CAN I HAVE SOME TEXT REFERRING TO A PASTE IN A BOX THAT DOESN'T EXIST"): T9-A10's Mac ticket
// told him to paste a Cloudflare key in its secret box; the ticket card (its steps page) had none. A ticket whose ask
// takes a key shows that ask's private box under the ticket card.

afterEach(cleanup);

const step: LaptopStep = { pageId: "sp_ee8fd488", step: "laptop-run", state: "todo", notes: [] };
const task: MacTask = { key: "tax#T9-A10", repo: "tax", ask: "T9-A10", title: "Create one Cloudflare key", order: 1, url: "http://h/t/T9-A10/", command: "paste it", step };
const item = (over: Partial<WaitingItem> = {}) =>
  ({ id: "wj_a10", code: "T9-A10", repo: "tax", state: "open", ask: "provide", macAgent: true, question: "Create one Cloudflare key", title: "T9-A10", contextLinks: [], secret: { app: "acme", name: "CLOUDFLARE_WORKERS_TOKEN" }, ...over }) as unknown as WaitingItem;
const box = (i: WaitingItem) => <div data-testid="secret-box">{i.code}</div>;

describe("E996-S29 a Mac ticket that takes a key has its private box", () => {
  it("shows the ask's private box under the ticket card", () => {
    render(<MacCards rows={laptopRows([task], [item()])} keyBox={box} />);
    expect(screen.getByTestId("laptop-card")).toBeTruthy();
    expect(screen.getByTestId("secret-box").textContent).toBe("T9-A10");
  });

  it("shows no box when the ask names no secret target or is answered", () => {
    render(<MacCards rows={laptopRows([task], [item({ secret: undefined })])} keyBox={box} />);
    expect(screen.queryByTestId("secret-box")).toBeNull();
    cleanup();
    render(<MacCards rows={laptopRows([task], [item({ state: "answered" })])} keyBox={box} />);
    expect(screen.queryByTestId("secret-box")).toBeNull();
  });
});

describe("E996-S29 a dated note never renders blank on the Mac card", () => {
  it("shows notes with words only", () => {
    const withNotes: MacTask = { ...task, step: { ...step, notes: [{ at: "2026-11-10", words: "" }, { at: "2026-11-12", words: "Repo not found" }] } };
    render(<MacCards rows={laptopRows([withNotes], [])} />);
    expect(screen.getByTestId("laptop-notes").textContent).toBe("Note 2026-11-12: Repo not found");
  });
});
