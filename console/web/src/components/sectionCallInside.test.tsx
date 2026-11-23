// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { FoldSection } from "@/components/homeSection";

// the call (phone) button leaves each inbox section heading; it shows inside the section once open.
afterEach(cleanup);

function Section({ start = false }: { start?: boolean }) {
  const [open, setOpen] = useState(start);
  return (
    <FoldSection title="Goals to set" count={3} testId="s" open={open} onToggle={setOpen} call={<button data-testid="s-call">Call</button>}>
      <div data-testid="s-cards">cards</div>
    </FoldSection>
  );
}

describe("section call inside the open section", () => {
  it("folded: no phone on the heading line, nor anywhere", () => {
    render(<Section />);
    expect(screen.queryByTestId("s-call")).toBeNull();
  });
  it("open: the phone sits inside the section body, never in the heading", () => {
    render(<Section />);
    fireEvent.click(screen.getByTestId("s-toggle"));
    const call = screen.getByTestId("s-call");
    const header = screen.getByTestId("s").querySelector("[data-fold-header]")!;
    expect(within(header as HTMLElement).queryByTestId("s-call")).toBeNull();
    expect(call.closest("[data-section-call]")).not.toBeNull();
    // above the cards
    expect(call.compareDocumentPosition(screen.getByTestId("s-cards")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
