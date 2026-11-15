// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Slot, SLOT_GIVE_UP_MS, SlotStack, useSlotReady } from "./slot";

// The owner said the inbox "jumps". every section fetches at once, shows top to bottom, and the
// next one holds its place, so a section that lands late never pushes one already on screen.
function Section({ ready, label }: { ready: boolean; label: string }) {
  useSlotReady(ready);
  return <div>{ready ? label : `${label} loading`}</div>;
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.useRealTimers();
});

const slot = (name: string) => document.querySelector(`[data-slot="${name}"]`) as HTMLElement;
const content = (name: string) => slot(name).querySelector(":scope > div:last-child") as HTMLElement;
const placeholder = (name: string) => slot(name).querySelector('[data-testid="slot-placeholder"]') as HTMLElement | null;

describe("SlotStack", () => {
  it("a section that is in early waits, hidden, for the ones above; the next one holds its remembered height", () => {
    window.localStorage.setItem("inbox.slot.h.top", "255");
    window.localStorage.setItem("inbox.slot.h.below", "600");
    let setTop!: (b: boolean) => void;
    function Host() {
      const [top, set] = useState(false);
      setTop = set;
      return (
        <SlotStack>
          <Slot name="top">
            <Section ready={top} label="top" />
          </Slot>
          <Slot name="below" fallback={420}>
            <Section ready label="below" />
          </Slot>
        </SlotStack>
      );
    }
    render(<Host />);
    // below is in, but top is not: below stays out of sight (mounted, so it fetched), no placeholder for it yet.
    expect(slot("top").dataset.ready).toBe("no");
    expect(placeholder("top")?.style.height).toBe("255px");
    expect(content("top").hidden).toBe(true);
    expect(slot("below").dataset.ready).toBe("no");
    expect(content("below").hidden).toBe(true);
    expect(placeholder("below")).toBeNull();
    // the stack holds one screen (first visit) so a footer below it never slides while the sections come in.
    expect(screen.getByTestId("inbox-stack").style.minHeight).toBe(`${window.innerHeight}px`);
    act(() => setTop(true));
    expect(screen.getByTestId("inbox-stack").style.minHeight).toBe("");
    // top shows, and below (already in) shows right after it: no placeholder left anywhere.
    expect(slot("top").dataset.ready).toBe("yes");
    expect(content("top").hidden).toBe(false);
    expect(placeholder("top")).toBeNull();
    expect(slot("below").dataset.ready).toBe("yes");
    expect(screen.getByText("below")).toBeTruthy();
  });

  it("a first visit holds the fallback; a section that never says ready shows after the give-up time; `ready` needs nothing", () => {
    vi.useFakeTimers();
    render(
      <SlotStack>
        <Slot name="blocked" fallback={420}>
          <Section ready={false} label="blocked" />
        </Slot>
        <Slot name="after" ready>
          <p>after</p>
        </Slot>
      </SlotStack>,
    );
    expect(placeholder("blocked")?.style.height).toBe("420px");
    expect(slot("after").dataset.ready).toBe("no");
    act(() => vi.advanceTimersByTime(SLOT_GIVE_UP_MS));
    expect(slot("blocked").dataset.ready).toBe("yes");
    expect(slot("after").dataset.ready).toBe("yes");
  });

  it("outside a Slot, useSlotReady does nothing; a lone Slot works on its own", () => {
    render(<Section ready label="free" />);
    expect(screen.getByText("free")).toBeTruthy();
    render(
      <Slot name="alone">
        <Section ready label="alone" />
      </Slot>,
    );
    expect(slot("alone").dataset.ready).toBe("yes");
  });
});
