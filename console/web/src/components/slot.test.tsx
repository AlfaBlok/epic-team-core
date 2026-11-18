// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Slot, SLOT_GIVE_UP_MS, SlotStack, useSlotReady } from "./slot";

// The owner 18 Nov, vn_6fc46536: "The page needs to load up with everything"): every section fetches
// at once and they all show in the same frame once every one is in; one skeleton holds the place before, never a few
// sections with more arriving below.
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

describe("SlotStack", () => {
  it("no section shows until every section is in, then all show in one frame", () => {
    let setTop!: (b: boolean) => void;
    function Host() {
      const [top, set] = useState(false);
      setTop = set;
      return (
        <SlotStack>
          <Slot name="top">
            <Section ready={top} label="top" />
          </Slot>
          <Slot name="mid">
            <Section ready label="mid" />
          </Slot>
          <Slot name="below">
            <Section ready label="below" />
          </Slot>
        </SlotStack>
      );
    }
    render(<Host />);
    // two of three are in: still nothing drawn but the skeleton
    expect(["top", "mid", "below"].map((n) => slot(n).dataset.ready)).toEqual(["no", "no", "no"]);
    expect(content("mid").hidden).toBe(true);
    expect(screen.getByTestId("inbox-skeleton")).toBeTruthy();
    act(() => setTop(true));
    expect(["top", "mid", "below"].map((n) => slot(n).dataset.ready)).toEqual(["yes", "yes", "yes"]);
    expect(screen.queryByTestId("inbox-skeleton")).toBeNull();
    expect(screen.queryAllByTestId("slot-placeholder")).toHaveLength(0);
    // once drawn it stays drawn, even if a section goes back to loading
    act(() => setTop(false));
    expect(slot("mid").dataset.ready).toBe("yes");
  });

  it("the skeleton has one bar per section and the height the stack had last time", () => {
    window.localStorage.setItem("inbox.slot.h.inbox", "640");
    render(
      <SlotStack name="inbox">
        <Slot name="a">
          <Section ready={false} label="a" />
        </Slot>
        <Slot name="b">
          <Section ready={false} label="b" />
        </Slot>
      </SlotStack>,
    );
    const sk = screen.getByTestId("inbox-skeleton");
    expect(sk.style.minHeight).toBe("640px");
    expect(sk.children).toHaveLength(2);
    expect(sk.textContent).toBe("");
  });

  it("a section that never says ready shows with the rest after the give-up time; `ready` needs nothing", () => {
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
