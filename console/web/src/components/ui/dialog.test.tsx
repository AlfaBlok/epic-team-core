// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

afterEach(cleanup);
// a fresh copy of the module: the suite's setup loads the dialog code before every file, this test checks the load itself
let ui: typeof import("@/components/ui/dialog");
beforeEach(async () => {
  vi.resetModules();
  ui = await import("@/components/ui/dialog");
});

const Box = ({ open }: { open: boolean }) => {
  const { Dialog, DialogContent, DialogTitle } = ui;
  return (
  <Dialog open={open} onOpenChange={() => undefined}>
    <DialogContent aria-describedby={undefined}>
      <DialogTitle>Send to</DialogTitle>
    </DialogContent>
  </Dialog>
  );
};

describe("a dialog's code loads the first time one opens", () => {
  it("a closed dialog draws nothing, an open one draws once its parts are in, and then at once every time", async () => {
    const { rerender } = render(<Box open={false} />);
    expect(screen.queryByText("Send to")).toBeNull();
    rerender(<Box open />);
    expect(await screen.findByText("Send to")).toBeTruthy();
    rerender(<Box open={false} />);
    rerender(<Box open />);
    expect(screen.getByText("Send to")).toBeTruthy(); // the parts are in: no wait the second time
  });
});
