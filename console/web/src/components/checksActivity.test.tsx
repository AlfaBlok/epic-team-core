// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { RunChecks } from "@/components/runChecks";

afterEach(cleanup);

/** a left provide ask shows what the Unblocker searched for an existing credential. */
describe("T8-S9 checks in Activity", () => {
  it("renders `searched` on a left ask, next to why", () => {
    render(
      <RunChecks
        checks={[
          { code: "T0-A6", decision: "answered", answer: "yes", confidence: 85, source: "T0-G3" },
          { code: "T0-A8", decision: "left", why: "no ghcr credential found", searched: "docker config auths keys; gh auth status" },
        ]}
      />,
    );
    const rows = screen.getAllByTestId("run-check");
    expect(rows).toHaveLength(2);
    expect(rows[1].textContent).toContain("no ghcr credential found · searched: docker config auths keys; gh auth status");
    expect(rows[0].textContent).not.toContain("searched");
  });
});
