// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ScorecardsBody } from "@/api/pursuit-types";
import { SidebarGoalSetsOf } from "@/components/goalSets";
import { ObjectiveName, productInk, splitObjectiveName } from "@/components/objectiveName";

/**
 * The owner: two objectives with the same goal under different products ("Acme: 5 testers", "Beta: 5 testers") read as
 * one name twice. The product is a small label in its own colour, the goal the main text.
 */
afterEach(cleanup);

const node = (id: string, name: string, rank: number) => ({
  id,
  kind: "pursuit" as const,
  name,
  rank,
  greens: 0,
  total: 1,
  spines: [],
  keyResults: [{ label: "Testers apply", state: "red" as const, value: "0 of 5", kind: "key-result" as const, work: [] }],
  rows: [],
  children: [],
});

describe("an objective's name in two parts", () => {
  it("splits the product from the goal", () => {
    expect(splitObjectiveName("Acme: 5 testers")).toEqual({ product: "Acme", goal: "5 testers" });
    expect(splitObjectiveName("Data products: 2 or 3 running alone")).toEqual({ product: "Data products", goal: "2 or 3 running alone" });
    expect(splitObjectiveName("Beta: 5 testers · 0 of 5")).toEqual({ product: "Beta", goal: "5 testers · 0 of 5" });
    expect(splitObjectiveName("House decision")).toEqual({ goal: "House decision" });
  });

  it("gives a product its own colour when one is set, else muted", () => {
    const inks = { acme: "text-[#123456]", dataproducts: "text-[#654321]" };
    expect(productInk("Acme", inks)).toBe("text-[#123456]");
    expect(productInk("Data products", inks)).toBe("text-[#654321]");
    expect(productInk("Gamma", inks)).toBe("text-muted-foreground bg-muted/70");
  });

  it("draws the label and the goal as two parts and still reads as the whole name", () => {
    render(<ObjectiveName name="Acme: 5 testers" />);
    const label = screen.getByTestId("objective-product");
    expect(label.dataset.product).toBe("Acme");
    expect(label.className).toContain("text-[12px]");
    // every label the same small chip on a very subtle soft background
    expect(label.className).toMatch(/rounded px-1.5/);
    expect(screen.getByTestId("objective-goal").textContent).toBe("5 testers");
    expect(screen.getByTestId("objective-name").textContent).toBe("Acme: 5 testers");
  });

  it("a name with no product part is drawn whole, no label", () => {
    render(<ObjectiveName name="House decision" />);
    expect(screen.queryByTestId("objective-product")).toBeNull();
    expect(screen.getByTestId("objective-name").textContent).toBe("House decision");
  });

  it("the sidebar's two '5 testers' objectives show their product as a separate label", () => {
    const data = { nodes: [node("a", "Acme: 5 testers", 1), node("b", "Beta: 5 testers", 2)], spineInfo: {} } as unknown as ScorecardsBody;
    render(
      <MemoryRouter>
        <SidebarGoalSetsOf data={data} />
      </MemoryRouter>,
    );
    const sets = screen.getAllByTestId("sidebar-set");
    expect(sets.map((s) => within(s).getByTestId("objective-product").dataset.product)).toEqual(["Acme", "Beta"]);
    expect(sets.map((s) => within(s).getByTestId("objective-goal").textContent)).toEqual(["5 testers", "5 testers"]);
  });
  it("flow (the objectives rows on the owner's phone): the label and the goal run as text, the goal one block that moves whole to the next line", () => {
    render(<ObjectiveName name="Acme: 5 testers" layout="flow" />);
    const n = screen.getByTestId("objective-name");
    expect(n.dataset.layout).toBe("flow");
    expect(n.className).not.toMatch(/(^| )(flex|grid|inline-flex)( |$)/);
    expect(screen.getByTestId("objective-product").textContent).toBe("Acme: ");
    const goal = screen.getByTestId("objective-goal");
    expect(goal.textContent).toBe("5 testers");
    expect(goal.className).toContain("inline-block");
    expect(goal.className).toContain("max-w-full");
  });
  it("the label is a placed box, so its hidden colon never escapes a clipped tag and widens the phone page", () => {
    for (const layout of ["stack", "inline", "flow"] as const) {
      const { unmount } = render(<ObjectiveName name="Acme: multi-tenant working" layout={layout} />);
      const label = screen.getByTestId("objective-product");
      expect(label.className.split(" ")).toContain("relative");
      expect(label.querySelector(".sr-only")).not.toBeNull();
      unmount();
    }
  });
});
