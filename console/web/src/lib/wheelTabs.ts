/**
 * Each product's wheel shows one static tab per kind of node its personas need in the product's data graph (the owner:
 * "each wheel will have a number of, let's say, static tabs. And these tabs depend on the data graph of the product ...
 * this totem in the graph gets exposed to the UX via these tabs"). The hosted layer gives each kind of wheel its tabs from
 * its product's graph file (src/hosted/wheelTabs.ts, read through an optional glob like the hosted brands); a build
 * without it shows the defaults below. An objective's page and a campaign's page each read theirs here.
 */
/** `kind`: "engine" for the console's own tabs, the same names in the same order on every app; "data" for a tab of the
 * product's own data graph (the owner, 24 Nov: "it's the same console is what I'm saying. with slightly different data tabs"). */
export type WheelTab = { id: string; label: string; shows: string[]; kind?: string; holds?: string; lives?: string; reads?: readonly string[]; writes?: readonly string[]; knows?: string };
/** (the owner, vn_cdef45cd: "you have a class which is objective ... these properties are ... what showing me on
 * the tabs"): the class a kind of wheel is, named in the product's graph file beside its tabs. */
/** The owner (24 Nov): `understood` says back his picture (an objective's knowledge in chapters, each what agents need
 * to roll it toward green); `names` are the words he picks from for one part, nothing renamed until he picks. */
export type WheelClass = { name: string; plural: string; one: string; his?: string; understood?: string; names?: readonly { word: string; why: string; collides: string; recommended?: boolean }[] };
export type WheelKind = "objective" | "campaign";

const plugs = import.meta.glob<{ HOSTED_WHEEL_TABS?: Partial<Record<WheelKind, readonly WheelTab[]>>; HOSTED_WHEEL_CLASS?: Partial<Record<WheelKind, WheelClass>> }>("../../../../../hosted/console/web/src/hosted/wheelTabs.ts", { eager: true });

/** a build without a product graph: the objective's ten; a campaign has the same engine tabs, with its own data tabs after Key results. */
const DEFAULTS: Record<WheelKind, readonly WheelTab[]> = {
  objective: [
    { id: "table", label: "Key results", shows: ["key-results"] },
    { id: "plan", label: "Plan", shows: ["plan"], kind: "data" },
    { id: "inbox", label: "Inbox", shows: ["inbox"] },
    { id: "chat", label: "Chat", shows: ["His words"] },
    { id: "personas", label: "Personas", shows: ["personas"] },
    { id: "kanban", label: "Board", shows: ["Epics"] },
    { id: "context", label: "Context", shows: ["product-deck"] },
    { id: "pages", label: "Pages", shows: ["pages"] },
    { id: "trackers", label: "Trackers", shows: ["trackers"] },
    { id: "log", label: "Log", shows: ["persona-log"] },
  ],
  campaign: [
    { id: "table", label: "Key results", shows: ["key-results"], kind: "engine" },
    { id: "benefits", label: "Benefits", shows: ["benefits", "product-deck"], kind: "data" },
    { id: "plan", label: "Plan", shows: ["marketing-plan", "social-kit"], kind: "data" },
    { id: "pipeline", label: "Pipeline", shows: ["Posts"], kind: "data" },
    { id: "history", label: "History", shows: ["Outcomes"], kind: "data" },
    { id: "waiting", label: "Inbox", shows: ["inbox"], kind: "engine" },
    { id: "chat", label: "Chat", shows: ["His words"], kind: "engine" },
    { id: "personas", label: "Personas", shows: ["personas"], kind: "engine" },
    { id: "work", label: "Board", shows: ["Epics"], kind: "engine" },
    { id: "context", label: "Context", shows: ["where-we-are", "Ideas and insights"], kind: "engine" },
    { id: "pages", label: "Pages", shows: ["pages"], kind: "engine" },
    { id: "trackers", label: "Trackers", shows: ["trackers"], kind: "engine" },
    { id: "log", label: "Log", shows: ["persona-log"], kind: "engine" },
  ],};

const hosted: Partial<Record<WheelKind, readonly WheelTab[]>> = Object.assign({}, ...Object.values(plugs).map((m) => m.HOSTED_WHEEL_TABS ?? {}));

export const WHEEL_TABS: Record<WheelKind, readonly WheelTab[]> = {
  objective: hosted.objective ?? DEFAULTS.objective,
  campaign: hosted.campaign ?? DEFAULTS.campaign,
};

const hostedClass: Partial<Record<WheelKind, WheelClass>> = Object.assign({}, ...Object.values(plugs).map((m) => m.HOSTED_WHEEL_CLASS ?? {}));
/** the class each kind of wheel is an object of: from the product's graph file, else a plain default. */
export const WHEEL_CLASS: Record<WheelKind, WheelClass> = {
  objective: hostedClass.objective ?? { name: "Objective", plural: "objectives", one: "Every objective is an object of one class: the same shape every time, and each tab is one of its properties." },
  campaign: hostedClass.campaign ?? { name: "Campaign", plural: "campaigns", one: "Every campaign is an object of one class: the same shape every time, and each tab is one of its properties." },
};
/** the made-of screen's path: what an objective (or a campaign) is made of, one box per tab. */
export const MADE_OF_PATH = "made-of";

/** the wheel's tabs as the tab strip takes them: id and label, in the graph file's order. */
export const wheelTabsOf = (kind: WheelKind): { id: string; label: string; data: boolean }[] => WHEEL_TABS[kind].map(({ id, label, kind: k }) => ({ id, label, data: k === "data" }));
