/**
 * Each product's wheel shows one static tab per kind of node its personas need in the product's data graph (the owner:
 * "each wheel will have a number of, let's say, static tabs. And these tabs depend on the data graph of the product ...
 * this totem in the graph gets exposed to the UX via these tabs"). The hosted layer gives each kind of wheel its tabs from
 * its product's graph file (src/hosted/wheelTabs.ts, read through an optional glob like the hosted brands); a build
 * without it shows the defaults below. An objective's page and a campaign's page each read theirs here.
 */
export type WheelTab = { id: string; label: string; shows: string[] };
export type WheelKind = "objective" | "campaign";

const plugs = import.meta.glob<{ HOSTED_WHEEL_TABS?: Partial<Record<WheelKind, readonly WheelTab[]>> }>("../../../../../hosted/console/web/src/hosted/wheelTabs.ts", { eager: true });

/** a build without a product graph: the objective's nine and the campaign's own. */
const DEFAULTS: Record<WheelKind, readonly WheelTab[]> = {
  objective: [
    { id: "table", label: "Key results", shows: ["key-results"] },
    { id: "plan", label: "Plan", shows: ["plan"] },
    { id: "inbox", label: "Inbox", shows: ["inbox"] },
    { id: "chat", label: "Chat", shows: ["His words"] },
    { id: "personas", label: "Personas", shows: ["personas"] },
    { id: "kanban", label: "Board", shows: ["Epics"] },
    { id: "context", label: "Context", shows: ["product-deck"] },
    { id: "pages", label: "Pages", shows: ["pages"] },
    { id: "trackers", label: "Trackers", shows: ["trackers"] },
  ],
  campaign: [
    { id: "plan", label: "Plan", shows: ["marketing-plan"] },
    { id: "product", label: "Product", shows: ["product-deck"] },
    { id: "kit", label: "Social kit", shows: ["social-kit"] },
    { id: "waiting", label: "Inbox", shows: ["inbox"] },
    { id: "chat", label: "Chat", shows: ["His words"] },
    { id: "pipeline", label: "Pipeline", shows: ["Posts"] },
    { id: "work", label: "Tasks", shows: ["Epics"] },
    { id: "observations", label: "Lessons", shows: ["Ideas and insights"] },
    { id: "history", label: "History", shows: ["Outcomes"] },
  ],
};

const hosted: Partial<Record<WheelKind, readonly WheelTab[]>> = Object.assign({}, ...Object.values(plugs).map((m) => m.HOSTED_WHEEL_TABS ?? {}));

export const WHEEL_TABS: Record<WheelKind, readonly WheelTab[]> = {
  objective: hosted.objective ?? DEFAULTS.objective,
  campaign: hosted.campaign ?? DEFAULTS.campaign,
};

/** the wheel's tabs as the tab strip takes them: id and label, in the graph file's order. */
export const wheelTabsOf = (kind: WheelKind): { id: string; label: string }[] => WHEEL_TABS[kind].map(({ id, label }) => ({ id, label }));
