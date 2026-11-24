import { useEffect, useState, useSyncExternalStore } from "react";
import { useInRouterContext, useLocation } from "react-router-dom";
import { Phone } from "lucide-react";
import { api, type ReviewItem } from "@/api";
import type { TeamCard } from "@/api/teamcard-types";
import { mutate } from "@/lib/data";
import { isDecisionCard } from "@/lib/cardKind";
import { decisionChoices } from "@/components/review";
import { cn } from "@/lib/utils";
import { busy, useCallTab } from "./CallProvider";
import type { CallFocus, CallHands } from "./engine";

/**
 * A phone button inside each open inbox section ("Goals to set (14 cards)", never on its heading) starts the same Team desk call (one voice, one
 * call code), already holding
 * that section's cards and a briefing for them. It goes one by one to clear the board, answers fast, and hands other work
 * to the desk. On his spoken yes (read back once) the call presses his own button on a card through the same calls the
 * card's button makes (never a card closed or hidden any other way); a card with no button it may press, or a
 * choice it cannot make the way the card does, goes to the desk.
 */

/** One card as the call gets it, with how the page presses each button it lists. */
export interface SectionCard {
  kind: "review" | "ask" | "goal" | "team";
  id: string;
  code?: string;
  title: string;
  where?: string;
  source?: string;
  goal?: string;
  delivered?: string[];
  evidence?: string;
  decision?: string;
  options?: string[];
  question?: string;
  recommend?: string;
  /** the buttons the call may press for him (see engine `press_card`); a label ending in "…" takes his words. */
  buttons?: string[];
  /** the card's evidence, shown in the call bar while the voice is on this card (page only; the console drops it). */
  link?: { label: string; url: string };
}
type Press = (button: string, words?: string) => Promise<string>;
export type PressableCard = SectionCard & { press?: Press };

export const MARK_COMPLETE = "Mark complete";
export const CHANGES_WANTED = "Changes wanted…";
export const ANSWER_IN_WORDS = "Answer in words…";

const done = (what: string) => `done: ${what}`;

/** A review card (Decisions, Done, waiting for your review): Mark complete, his decision's own choices, Changes wanted. */
export function reviewCard(i: ReviewItem & { milestoneTitle?: string }): PressableCard {
  const f = i.face;
  const choices = f && isDecisionCard(f) ? (decisionChoices(f) ?? []) : [];
  const next = f?.next ?? [];
  // Mark complete as the card's own button does with his switches untouched: the team's recommendation for each next step.
  const complete = () =>
    api.completeReviewItem(i.id, {
      start: next.flatMap((s, n) => (s.recommend === "start" ? [n] : [])),
      park: next.flatMap((s, n) => (s.recommend === "start" ? [] : [n])),
      ...(next.some((s) => s.target) ? { why: next.map(() => "") } : {}),
    });
  const choose = (label: string) => {
    const c = choices.find((x) => x.label === label)!;
    const idx = next.map((_, n) => n);
    const plain = (f?.decision ?? "").split("?")[0].replace(/^(?:do|should|shall|will|can|would) (?:we|the team|i)\s+/i, "").trim();
    const plan = !next.length && c.start && plain ? `${/:\s*plan\b/i.test(c.label) ? "Plan" : "Do"}: ${plain}` : undefined;
    const switches = next.some((s) => s.target);
    return api.completeReviewItem(i.id, { ...(c.start ? { start: idx, park: [] } : { park: idx }), ...(switches && c.start ? { why: next.map(() => "") } : {}), choice: c.label, ...(plan ? { plan } : {}) });
  };
  const buttons = choices.length ? [...choices.map((c) => c.label), CHANGES_WANTED] : [MARK_COMPLETE, CHANGES_WANTED];
  return {
    kind: "review",
    id: i.id,
    ...(i.ref ? { code: i.ref } : {}),
    title: f?.title || i.title,
    ...(i.milestoneTitle ? { where: i.milestoneTitle } : {}),
    ...(f?.source ? { source: f.source } : {}),
    ...(f?.taskGoal ? { goal: f.taskGoal } : {}),
    ...(f?.delivered?.length ? { delivered: f.delivered.map((d) => `${d.ok === false ? "✗" : "✓"} ${d.text}`) } : {}),
    ...(f?.evidence?.label ? { evidence: f.evidence.label } : {}),
    ...(f?.evidence?.url ? { link: { label: f.evidence.label || "Evidence", url: f.evidence.url } } : {}),
    ...(f?.decision ? { decision: f.decision } : {}),
    ...(f?.options?.length ? { options: f.options } : {}),
    buttons,
    press: async (button, words) => {
      if (button === CHANGES_WANTED) {
        await mutate(() => api.relaunchReviewItem(i.id, words ?? ""), "inbox");
        return done("his words went to the team as Changes wanted");
      }
      if (button === MARK_COMPLETE) {
        await mutate(complete, "inbox");
        return done("marked complete");
      }
      await mutate(() => choose(button), "inbox");
      return done(`chose ${button}`);
    },
  };
}

/** A team card (Goals to set: pick one of its goals; ideas and digests: answer in words), through its own answer route. */
export function teamCard(c: TeamCard): PressableCard {
  const goals = c.goal?.options ?? [];
  const label = (g: { goal: string; number: string }) => `${g.goal}${g.number ? ` (${g.number})` : ""}`.slice(0, 110);
  return {
    kind: c.kind === "goal" ? "goal" : "team",
    id: c.id,
    title: c.title,
    ...(c.scorecardName ? { where: c.scorecardName } : {}),
    ...(c.source ? { source: c.source } : {}),
    ...(c.goal ? { question: `${c.goal.unset}. Options: ${goals.map((g, n) => `${n + 1}) ${label(g)}`).join("; ")}` } : {}),
    ...(c.goal?.recommend !== undefined && goals[c.goal.recommend] ? { recommend: label(goals[c.goal.recommend]) } : {}),
    ...(c.idea ? { question: c.idea.gain, recommend: c.idea.recommend } : {}),
    ...(c.digest ? { question: `${c.digest.greens} of ${c.digest.total} green. ${c.digest.reasons.map((r) => r.text).join(" ")}`.slice(0, 1800) } : {}),
    ...((c.goal?.links ?? c.idea?.links)?.length ? { evidence: (c.goal?.links ?? c.idea?.links)!.map((l) => l.label).join(", "), link: (c.goal?.links ?? c.idea?.links)![0] } : {}),
    buttons: [...goals.map(label), ANSWER_IN_WORDS],
    press: async (button, words) => {
      const pick = goals.findIndex((g) => label(g) === button);
      const r = await mutate(() => api.answerTeamCard(c.id, pick >= 0 ? { pick, via: "voice" } : { text: words ?? "", via: "voice" }), "inbox");
      // its commit, when the route wrote one: the voice says "it landed" only with it
      return done(`${pick >= 0 ? `picked ${button}` : "his answer was sent"}${r?.sha ? `, landed ${r.sha.slice(0, 9)}` : ""}`);
    },
  };
}

/** A question or block waiting on him: its answer goes to the desk (the voice presses nothing). */
export function askCard(a: { id: string; code?: string; title: string; question?: string; where?: string; url?: string }): PressableCard {
  return { ...(a.url ? { link: { label: "Open it", url: a.url } } : {}), kind: "ask", id: a.id, ...(a.code ? { code: a.code } : {}), title: a.title, ...(a.question && a.question !== a.title ? { question: a.question } : {}), ...(a.where ? { where: a.where } : {}), buttons: [] };
}

export const ASK_YES = "Yes: go ahead";
export const ASK_NO = "No: drop it";

/**
 * a question's own answer route (the waiting card's respond: POST …/respond), for a whole-inbox call: Yes / No
 * on an approve ask, his words on any ask. The console checked his yes and that the button is one the card lists.
 */
export async function pressAsk(p: { id: string; button: string; words?: string; milestoneId?: string }): Promise<string> {
  const kind = p.button === ASK_YES ? "approve" : p.button === ASK_NO ? "deny" : "answer";
  // E948-S200: a yes-or-no ask's Yes and No are his answer, with any words he added
  const word = p.button === "Yes" || p.button === "No" ? p.button : undefined;
  const words = (p.words ?? "").trim();
  const text = kind === "answer" ? (word ? (words ? `${word}. ${words}` : word) : words) : "";
  if (kind === "answer" && !text) return "not pressed: his answer needs his words";
  await mutate(() => api.respondToWaiting(p.id, { kind, text, ...(p.milestoneId ? { milestoneId: p.milestoneId } : {}), wake: true }), "inbox");
  return done(kind === "approve" ? "said yes" : kind === "deny" ? "said no" : "his answer was sent");
}

/** the button on the card read fresh (the list may have moved since the call started): pressed only when it is still one of his. */
async function pressOn(card: PressableCard | undefined, button: string, words?: string): Promise<string> {
  if (!card?.press) return "not pressed: the card is no longer in his inbox";
  const want = button.toLowerCase().replace(/[….]+$/, "");
  const b = (card.buttons ?? []).find((x) => x.toLowerCase().replace(/[….]+$/, "") === want);
  if (!b) return `not pressed: ${button} is not one of his buttons on it now (${(card.buttons ?? []).join(" · ")})`;
  return card.press(b, words);
}

/**
 * the hands of the Team desk's whole-inbox call (no section's cards on this page): it presses his button through
 * the same card builders a section call uses (reviewCard, teamCard, the ask's respond), each card read fresh, shows the
 * card when the inbox is on screen, and files his words on an objective through the briefing's own route.
 */
export function inboxHands(): CallHands {
  return {
    press: async (p) => {
      if (p.kind === "review") {
        const items = await api.listReviewItems();
        const i = items.find((x) => x.id === p.id);
        return pressOn(i ? reviewCard(i) : undefined, p.button, p.words);
      }
      if (p.kind === "goal" || p.kind === "team") {
        const body = await api.listTeamCards();
        const c = body.open.find((x) => x.id === p.id);
        return pressOn(c ? teamCard(c) : undefined, p.button, p.words);
      }
      if (p.kind === "ask") return pressAsk(p);
      return "not pressed: this card has no button the call may press";
    },
    show: (id) => void showOnScreen(id),
    file: async (p) => {
      const r = await api.briefingAnswer({ kind: "objective", id: p.id, name: p.name, words: p.words });
      return `filed: ${r.filed.join(" and ")}`;
    },
  };
}

/** the Team desk's voice is on here (his own console, voice switched on): the section buttons show. One read per page. */
let stateRead: Promise<boolean> | undefined;
function useVoiceOn(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    stateRead ??= fetch("/api/voice/state")
      .then(async (r) => (r.ok ? !!((await r.json()) as { available?: boolean }).available : false))
      .catch(() => false);
    void stateRead.then((v) => live && setOn(v));
    return () => {
      live = false;
    };
  }, []);
  return on;
}

/**
 * The phone button beside a section's name. Pressing it starts the Team desk call holding `cards()` (the cards the section
 * shows now, in its order); the call floats on every page (CallWidget) with Mute and Hang up.
 */
/** the card the voice is on, on his screen: its section open, scrolled to it, marked until the next one. */
const ON_CALL = ["ring-2", "ring-emerald-600", "ring-offset-4", "rounded-lg"];
export function showOnScreen(id: string, doc: Document = document) {
  for (const el of doc.querySelectorAll("[data-on-call]")) {
    el.classList.remove(...ON_CALL);
    el.removeAttribute("data-on-call");
  }
  const el = [...doc.querySelectorAll<HTMLElement>("[data-inbox-card]")].find((x) => {
    const v = x.getAttribute("data-inbox-card") ?? "";
    return v === id || v.endsWith(`:${id}`);
  });
  if (!el) return false;
  el.setAttribute("data-on-call", "");
  el.classList.add(...ON_CALL);
  el.scrollIntoView?.({ behavior: "smooth", block: "start" });
  return true;
}

export function SectionCallButton({ section, cards, testId, onOpen }: { section: string; cards: () => PressableCard[]; testId: string; /** opens the section, so the cards show while the call walks them */ onOpen?: () => void }) {
  const on = useVoiceOn();
  const tab = useCallTab();
  useSyncExternalStore(tab.subscribe, tab.snapshot, tab.snapshot);
  const loc = useInRouterContext() ? useLocation() : undefined; // eslint-disable-line react-hooks/rules-of-hooks
  if (!on) return null;
  const h = tab.call("/api/voice", { callee: "the desk" });
  const live = busy(h.engine.view().phase);
  const start = () => {
    const list = cards();
    const presses = new Map(list.map((c) => [c.id, c.press]));
    const focus: CallFocus = {
      section,
      cards: list.slice(0, 60).map(({ press: _p, ...c }) => c as unknown as Record<string, unknown>),
      show: (id) => void showOnScreen(id),
      press: async (p) => {
        const f = presses.get(p.id);
        if (!f) return "not pressed: this card has no button the call may press";
        return f(p.button, p.words);
      },
    };
    onOpen?.();
    tab.started(h, loc ? `${loc.pathname}${loc.search}` : undefined);
    void h.engine.startFocused(focus);
  };
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        start();
      }}
      disabled={live}
      title={live ? "A call is on" : `Call about ${section}: the voice goes through these cards with you`}
      aria-label={`Call about ${section}`}
      data-testid={`${testId}-call`}
      className={cn("inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40")}
    >
      <Phone className="size-4" aria-hidden />
      <span>Call</span>
    </button>
  );
}
