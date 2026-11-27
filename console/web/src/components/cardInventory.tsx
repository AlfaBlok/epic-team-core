import { SentBackCardView } from "@/components/sentBack";
import { useEffect, useState, type ReactNode } from "react";
import type { PendingItem, ReviewItem, WaitingItem } from "@/api";
import { FyiCard, MonitorAlertCard, StatusItemRow, WaitingCard } from "@/components/waiting";
import { PostReviewCard, ReviewCard } from "@/components/review";
import { AskSet } from "@/components/askSet";
import { LaptopCard, MacCards, type LaptopRow } from "@/components/laptopSwitch";
import { AdvisorSetCard, CampaignGoalCard, GoalTalkCard, TeamDigestCard, TeamIdeaCard, TeamSupportCard } from "@/components/teamCards";
import type { TeamCard } from "@/api/teamcard-types";
import { ConnectCard } from "@/components/connectCards";
import type { ConnectCard as ConnectItem } from "@/api/types";

/**
 * E948-S60 (the owner 2026-11-12 18:27Z: "Let's do an inventory of all the … cards that can possibly exist"): every card type
 * the inbox (both skins, EpicTeam and SocialApp) can render, read from the code's card switch, each with a sample
 * (fixture) so every type shows even when none is live. The inventory page (/cards/inventory) renders them at 390 and
 * 1280 px; cardInventory.test.tsx renders each one and fails when one has no feedback block, when the block is not the
 * card's end, when a card says "Not now", and when a card component the source renders is missing from this list.
 *
 * `component` names the component the source renders (the test checks each named root exists in the code).
 */
export interface CardType {
  id: string;
  name: string;
  /** where he meets it */
  where: string;
  component: "WaitingCard" | "FyiCard" | "StatusItemRow" | "MonitorAlertCard" | "AskSet" | "ReviewCard" | "OldCard" | "PostReviewCard" | "LaptopCard" | "MacCards" | "TeamDigestCard" | "TeamSupportCard" | "TeamIdeaCard" | "GoalTalkCard" | "CampaignGoalCard" | "AdvisorSetCard" | "ConnectCard" | "SentBackCardView";
  /**
   * E948-S69 (the owner 2026-11-13, vn_9e6f5fa4: "understand the different types of cards that we have ... and have clarity
   * over the buttons"): what the card asks of him. A `decision` card's buttons are its options, each named by what happens
   * next, plus Voice and Text: never Mark complete, never a lone Send my pick (cardInventory.test.tsx holds it).
   */
  kind: CardKind;
  /** the buttons it shows, in his words: the one table (the inventory page and docs/review-cards.md). */
  buttons: string;
  render: () => ReactNode;
}
export type CardKind = "decision" | "review" | "do" | "answer" | "key" | "news";
export const KIND_NAME: Record<CardKind, string> = {
  decision: "Decision",
  review: "Review",
  do: "Do",
  answer: "Answer",
  key: "Key",
  news: "For your information",
};

const SINCE = "2026-11-12T10:00:00Z";

export const sampleAsk = (over: Partial<WaitingItem> = {}): WaitingItem =>
  ({
    id: "sample_ask",
    code: "E900-A1",
    source: "ask",
    state: "open",
    who: "the owner",
    row: "E900-S1",
    milestoneId: "ms_sample",
    milestoneTitle: "EPIC-900: Sample project",
    nodeKey: "ms_sample/E900-S1",
    repo: "sample-repo",
    path: "docs/spines/sample.md",
    title: "A sample question",
    ask: "provide",
    question: "Which address should the sign-up mail come from?",
    options: [],
    contextLinks: [],
    owner: { kind: "delivery-manager", assignmentId: "as_sample", personaName: "Delivery Manager", label: "Delivery Manager", threadId: "th_sample" },
    since: SINCE,
    decidable: false,
    ...over,
  }) as WaitingItem;

/** E946-A29 as it reads now: three choices (A, B, your own number), the team's recommendation first. */
export const A29_OPTIONS = ["A posts out on time, 14 of 14 this week", "B people talking to us about testing, 5 this week", "your own number"];
export const sampleA29 = (): WaitingItem =>
  sampleAsk({
    id: "sample_a29",
    code: "E946-A29",
    ask: "decide",
    milestoneTitle: "EPIC-946: SocialApp launch",
    title: "This week's one number",
    question: "You decide: this week's one number is A, approved posts out on time, or B, people talking to us about testing.",
    options: A29_OPTIONS,
    recommendation: A29_OPTIONS[1],
  });

const FACE = {
  project: { name: "EpicTeam", url: "https://team.example.com/" },
  goal: { text: "Every card takes feedback", code: "EPIC-900" },
  tasks: { done: 1, total: 2 },
  title: "A sample page was built so you can check every card at phone size.",
  taskGoal: "You can see every card the team can send you.",
  delivered: [
    { ok: true, text: "Every card shows its feedback box." },
    { ok: false, text: "The social board cards come next." },
  ],
  evidence: { url: "https://team.example.com/cards/inventory", label: "Open the inventory" },
  tree: [],
  next: [],
  closesGoal: false,
  openInGoal: [],
  source: "the owner, 12 Nov 18:27: every card needs a feedback button.",
  decision: "Is the inventory complete? The team recommends yes: answer with Mark complete, or say what is missing below.",
};

export const sampleReview = (over: Partial<ReviewItem> = {}): ReviewItem =>
  ({
    id: "sample_review",
    title: "A sample finished task",
    liveUrl: "https://team.example.com/cards/inventory",
    ref: "E900-S1",
    repo: "sample-repo",
    path: "docs/spines/sample.md",
    milestoneId: "ms_sample",
    state: "review",
    status: "review",
    createdAt: "2026-11-12",
    verdict: { kind: "card" },
    face: FACE,
    ...over,
  }) as unknown as ReviewItem;

const samplePost = (kind?: string): ReviewItem =>
  sampleReview({
    id: kind ? "sample_reply" : "sample_post",
    title: kind ? "A reply in a thread" : "A held post",
    face: undefined,
    post: {
      tenantId: "social",
      repo: "sample-social",
      id: kind ? "P-0002" : "P-0001",
      ...(kind ? { kind } : {}),
      platform: "X",
      slot: "2026-11-30 14:00",
      title: kind ? "Reply: how we test with real users" : "Three things we learned in week one",
      text: "We shipped two posts and heard nothing back. Here is what we change this week.",
      images: [],
      project: { name: "SocialApp" },
      campaign: "First testers",
      pageUrl: "/posts/P-0001",
      ...(kind ? { thread: { title: "Who tests social tools?", numbers: "12 replies" } } : {}),
    },
  } as Partial<ReviewItem>);

const sampleStatus = (kind: "mark_ready" | "stalled"): PendingItem =>
  kind === "stalled"
    ? // E948-S204: a goal whose team is off asks "Should a team member work on it?"
      ({ id: "sample_stalled", kind, state: "alarm", milestoneId: "ms_sample", title: "3 steps ready, nobody on. Switch on Delivery Manager?", detail: "3 steps ready on Get 5 testers. Delivery Manager is switched off, so nobody wakes on it.", goal: "Get 5 testers", switchOn: [{ assignmentId: "as_sample", persona: "Delivery Manager" }], since: SINCE } as PendingItem)
    : ({ id: `sample_${kind}`, kind, state: "open", milestoneId: "ms_sample", title: "Start the sign-up page", detail: "It waits for your ready stamp.", since: SINCE, path: "docs/spines/sample.md" }) as PendingItem;

/** E948-S200: a held ask drawn as a status card, its question a yes or no (the E907-S32 card). */
const sampleStatusAsk = (): PendingItem =>
  ({ id: "sample_status_ask", kind: "ask", ask: "approve", code: "E900-A7", state: "open", milestoneId: "ms_sample", title: "E900-S7 the import row line", question: "You approve: one private test notes repo and a token for it, used only by our staging copy. Why: staging has no storage today.", since: SINCE }) as PendingItem;

const sampleAlert = (): PendingItem =>
  ({
    id: "sample_alert",
    kind: "monitor_alert",
    state: "alarm",
    milestoneId: "ms_sample",
    title: "Monitor alert: the nightly post check stopped",
    detail: "No check for 26 hours.",
    since: SINCE,
    monitor: { why: "stopped", next: "The team restarts it at its next wake.", asks: [] },
  }) as unknown as PendingItem;

const macRow = (page: boolean): LaptopRow => ({
  key: page ? "mac_page" : "mac_nopage",
  title: page ? "Sign in to the X account on your Mac" : "Export the Bitwarden folder",
  repo: "team-repo",
  code: page ? "E900-A2" : "E900-A3",
  minutes: 3,
  redLine: false,
  since: SINCE,
  command: "Open the Claude app, start a new session and paste the ticket text.",
  ...(page ? { step: { pageId: "sp_sample", step: "1", state: "todo" as const, notes: [] } } : {}),
});

/** Every card type, in the order of the inbox. */
/** E948-S66: the team's own cards (a scorecard's digest, an idea, a goal to set), samples. */
const teamSample = (over: Partial<TeamCard>): TeamCard => ({ id: "tc_sample", kind: "idea", scorecard: "sample-testers", scorecardName: "5 testers using SocialApp", by: "Strategist", at: SINCE, day: "2026-11-12", title: "A sample", ...over });
export const sampleDigest = () =>
  teamSample({ id: "tc_sample_digest", kind: "digest", by: "Performance", title: "5 testers using SocialApp went greener: 3 of 7 lines are green, up from 2.", digest: { greens: 3, total: 7, prevGreens: 2, prevTotal: 7, prevDay: "2026-11-11", trend: "greener", reasons: [{ text: "Two people applied to be testers", url: "https://example.com/testers/" }, { text: "The tester call went out on X" }], lines: [{ label: "People apply to be testers", state: "green", value: "2 this week", was: "red" }] } });
/** a help desk's day: the inbound mails sorted by product, drafted or needing the owner. */
export const sampleSupport = () =>
  teamSample({ id: "tc_sample_support", kind: "support", by: "Help desk", title: "Support on 2026-11-13: 3 mails, 1 needs you", support: { products: [{ product: "Memo", mails: 2 }, { product: "SocialApp", mails: 1 }], drafted: 2, needsYou: 1, items: [{ product: "Memo", subject: "Voice notes do not show up from Sam", state: "drafted" }, { product: "Memo", subject: "Re: Your setup from Lee", state: "drafted" }, { product: "SocialApp", subject: "Charged twice from Kim", state: "needs you", note: "Why you: money back" }], links: [{ label: "Open your Gmail Drafts", url: "https://mail.google.com/mail/u/0/#drafts" }] } });
export const sampleIdea = () => teamSample({ id: "tc_sample_idea", title: "Invite the five people who replied last week straight to a call.", idea: { gain: "Testers about a week sooner", recommend: "Do it this week: the team writes the invites." } });
export const sampleGoal = () =>
  teamSample({ id: "tc_sample_goal", kind: "goal", by: "Gap finder", scorecard: "sample-memory", scorecardName: "Memory live", title: "Memory live has no number for paying users yet.", goal: { unset: "How many paying users, by when", options: [{ goal: "3 paying users by December 1", number: "3" }, { goal: "10 paying users by December 15", number: "10" }], recommend: 0 } });

/** E948-S59: the Senior advisor's week, one marked set. */
export const sampleAdvisor = () =>
  teamSample({ id: "tc_sample_advisor", kind: "advisor", by: "Senior advisor", scorecard: undefined, scorecardName: undefined, title: "Two moves this week toward the first of 5 testers.", advisor: { week: "2026-W46", weekLabel: "9 to 15 November", items: [{ id: "a1", title: "Set up the first tester's campaign by hand this week.", why: "No outside tester yet.", spine: "docs/spines/sample.md" }, { id: "a2", title: "Post every day without your laptop, and count replies.", spine: "docs/spines/sample.md" }] } });

/** a Google account the team needs connected (the inbox's Connect card, server auth/connects.ts). */
export const sampleConnect = (): ConnectItem => ({
  id: "sample-youtube",
  title: "Connect the Writer's YouTube",
  what: "The Writer posts the week's Shorts to this channel.",
  account: "writer@example.com",
  channel: { name: "Writer", handle: "@WriterShorts" },
  gives: ["upload videos", "read the channel's views"],
  connected: false,
  startUrl: "https://example.com/connect/sample-youtube/start",
  inbox: true,
});

export const CARD_TYPES: CardType[] = [
  { id: "decide-options", kind: "decision", buttons: "One button per option, its own words, the recommended one filled. Park. Snooze. Voice · Text.", name: "Decide: pick one of several options (E946-A29)", where: "Inbox, Waiting on you", component: "WaitingCard", render: () => <WaitingCard item={sampleA29()} showMilestone /> },
  { id: "decide-choice-link", kind: "decision", buttons: "See the options above one button per option, the team's pick filled. Park. Snooze. Voice · Text.", name: "Decide: a choice shows its options (E948-S151)", where: "Inbox, Waiting on you", component: "WaitingCard", render: () => <WaitingCard item={sampleAsk({ id: "sample_choice_link", ask: "decide", question: "You decide: which sidebar for your objectives, A, B or C?", contextText: "You asked for mockups. Mockups on your real objectives, at phone and laptop size: https://example.com/", options: ["Pick A: build A, no numbers", "Pick B: build B, number in the ring", "Pick C: build C, number on the edge"], recommendation: "Pick A: build A, no numbers" } as Partial<WaitingItem>)} /> },
  { id: "decide-listed-semicolons", kind: "decision", buttons: "One button per listed option, the team's pick filled. Park. Snooze. Voice · Text.", name: "Decide: options written with semicolons (E946-A31)", where: "Inbox, Waiting on you", component: "WaitingCard", render: () => <WaitingCard item={sampleAsk({ id: "sample_a31", ask: "decide", question: "Agree this plan for the testers and start the three-day experiment tomorrow, Friday 13 Nov? The team recommends yes.", options: ["yes as it stands", "yes with changes said in the page's feedback box", "no"], recommendation: "yes as it stands" })} /> },
  { id: "decide-no-options", kind: "decision", buttons: "Yes, <the action> · No, built from the question, the team's pick filled. Park. Snooze. Voice · Text.", name: "Decide: an ask that lists no options", where: "Inbox, Waiting on you", component: "WaitingCard", render: () => <WaitingCard item={sampleAsk({ id: "sample_a31_bare", ask: "decide", question: "Agree this plan for the testers and start the three-day experiment tomorrow, Friday 13 Nov? The team recommends yes.", options: ["Yes, agree this plan for the testers", "No"], optionsDerived: true, recommendation: "Yes, agree this plan for the testers" } as Partial<WaitingItem>)} /> },
  { id: "decide-yes-no", kind: "decision", buttons: "Yes: go ahead · No: drop it. Park. Snooze. Voice · Text.", name: "Decide: a yes or no question", where: "Inbox, Waiting on you", component: "WaitingCard", render: () => <WaitingCard item={sampleAsk({ id: "sample_yesno", ask: "decide", question: "Should the team post twice a day this week?" })} /> },
  { id: "answer", kind: "answer", buttons: "Park. Snooze. Voice · Text. His answer box is open from the start, Send under it.", name: "Answer: words, a key place or a screenshot", where: "Inbox, Waiting on you", component: "WaitingCard", render: () => <WaitingCard item={sampleAsk()} /> },
  { id: "approve", kind: "decision", buttons: "Yes: go ahead · No: drop it. Park. Snooze. Voice · Text.", name: "Approve: a recommendation the team wants your yes on", where: "Inbox, Waiting on you", component: "WaitingCard", render: () => <WaitingCard item={sampleAsk({ id: "sample_approve", ask: "approve", decidable: true, question: "Approve sending the week's report to the testers?", recommendation: "Approve" })} /> },
  { id: "do", kind: "do", buttons: "Done · Stuck. Park. Snooze. Voice · Text.", name: "Do: steps only you can do, then Done or Stuck", where: "Inbox, Waiting on you", component: "WaitingCard", render: () => <WaitingCard item={sampleAsk({ id: "sample_do", ask: "do", question: "Turn on two-step sign-in for the X account.", steps: "1. Open X settings · 2. Turn on two-step sign-in", stepsLink: { label: "steps", url: "https://example.com/steps/two-step" } } as Partial<WaitingItem>)} /> },
  { id: "key", kind: "key", buttons: "The private box and Save key. Park. Snooze.", name: "Key: paste a secret into its private box", where: "Inbox, Waiting on you", component: "WaitingCard", render: () => <WaitingCard item={sampleAsk({ id: "sample_key", question: "Paste the Mailgun sending key.", secret: { app: "socialapp", name: "MAILGUN_KEY" } } as Partial<WaitingItem>)} /> },
  { id: "persona-request", kind: "decision", buttons: "One button per option, a bare Yes or No gets its next step. Voice · Text.", name: "Persona request: a persona asks you directly", where: "Inbox, Waiting on you", component: "WaitingCard", render: () => <WaitingCard item={sampleAsk({ id: "sample_nj", source: "needs_jordi", needsJordiId: "nj_sample", ask: "decide", question: "Can the Writer use your photo on the about page?", options: ["Yes", "No, use the logo"] } as Partial<WaitingItem>)} /> },
  { id: "improvement", kind: "decision", buttons: "Yes: go ahead · No: drop it. Park. Snooze. Voice · Text.", name: "Improvement request from another world", where: "Inbox, Waiting on you", component: "WaitingCard", render: () => <WaitingCard item={sampleAsk({ id: "sample_impr", ask: "approve", decidable: true, question: "SocialApp asks for a bulk schedule button.", improvement: { to: "EpicTeam", doneMeans: "Testers schedule ten posts at once." } } as Partial<WaitingItem>)} /> },
  { id: "answered", kind: "news", buttons: "None: it shows his answer being written. Voice · Text.", name: "Answered: your answer is being written", where: "Inbox, Answered", component: "WaitingCard", render: () => <WaitingCard item={sampleAsk({ id: "sample_answered", state: "answered", answer: "hello@example.com" })} /> },
  { id: "fyi", kind: "news", buttons: "Reverse. Voice · Text.", name: "Decided for you: the team decided, you can reverse it", where: "Inbox, Decided for you", component: "FyiCard", render: () => <FyiCard item={sampleAsk({ id: "sample_fyi", decidedBy: "Delivery Manager", question: "Posts go out at 14:00 UTC.", answer: "Chosen because most replies came then." })} /> },
  { id: "do-browser", kind: "do", buttons: "Copy the prompt · Done · Stuck. Park. Snooze. Voice · Text.", name: "Do: a step in your own browser, with a prompt for Claude in Chrome", where: "Inbox, Waiting on you", component: "WaitingCard", render: () => <WaitingCard item={sampleAsk({ id: "sample_do_browser", ask: "do", question: "Download one GoDaddy receipt as a PDF.", steps: "1. Open https://account.godaddy.com/receipts and sign in · 2. Save the receipt as a PDF", browserPrompt: "Open https://account.godaddy.com/receipts/view/4176093069 in this browser, where I am signed in. Save the receipt as a PDF and email it to me with the subject Alpha GoDaddy receipt 4176093069." } as Partial<WaitingItem>)} /> },
  { id: "status-ready", kind: "do", buttons: "Mark ready for delivery. Voice · Text.", name: "Do: stamp a task ready", where: "Inbox, Waiting on you", component: "StatusItemRow", render: () => <StatusItemRow item={sampleStatus("mark_ready")} /> },
  { id: "status-ask-yes-no", kind: "decision", buttons: "Yes: go ahead · No: drop it · Open the whole card. Voice · Text.", name: "Decision: an ask shown as a short card, a yes or no question (E948-S200)", where: "Inbox, Waiting on you", component: "StatusItemRow", render: () => <StatusItemRow item={sampleStatusAsk()} /> },
  { id: "status-stalled", kind: "decision", buttons: "Switch on · Leave it off. Voice · Text.", name: "Decision: a goal whose team is off, should a team member work on it (E948-S204)", where: "Inbox, Waiting on you", component: "StatusItemRow", render: () => <StatusItemRow item={sampleStatus("stalled")} /> },
  { id: "monitor-alert", kind: "news", buttons: "None: it opens the check. Voice · Text.", name: "Alert: a check stopped or is late", where: "Inbox, top", component: "MonitorAlertCard", render: () => <MonitorAlertCard item={sampleAlert()} /> },
  {
    id: "ask-set",
    kind: "decision",
    buttons: "Per line: Yes: make it a task · Ask a question · No: drop it. Then Yes to all: make them tasks · Park · Snooze.",
    name: "A persona's set of recommendations",
    where: "Inbox, Waiting on you",
    component: "AskSet",
    render: () => (
      <AskSet
        group={{
          persona: "Strategist",
          items: [
            sampleAsk({ id: "sample_set1", code: "E900-A4", ask: "approve", decidable: true, question: "Post the tester call on Reddit." }),
            sampleAsk({ id: "sample_set2", code: "E900-A5", ask: "approve", decidable: true, question: "Reply to the three open threads." }),
          ],
        }}
      />
    ),
  },
  // a card he sent back shows while a worker builds its next round: he swipes it away, his Voice and Text still work
  { id: "sent-back", kind: "news", buttons: "Swipe or x takes it off the list. Voice · Text.", name: "Sent back: a card you sent back, a worker on it now", where: "Inbox, Sent back, in progress", component: "SentBackCardView", render: () => <SentBackCardView card={{ id: "rv_sample_sent_back", ref: "E907-S3", repo: "sample", path: "docs/spines/sample.md", title: "The sample page was made clearer.", state: "in_progress", iteration: 2, words: "Make it shorter, and show the picture first.", since: SINCE, worker: { run: "run_sample", persona: "Ticket worker", host: "host1", startedAt: SINCE, live: true } }} /> },
  { id: "review", kind: "review", buttons: "Mark complete · Park · Snooze · Voice · Text.", name: "Review: a finished task to accept or send back", where: "Inbox, Waiting for your review", component: "ReviewCard", render: () => <ReviewCard item={sampleReview()} /> },
  // E948-S53 (the owner, vn_ebf81fab: "Mark complete, close the goal"): the last open part of a goal says on its own button that it closes the goal; no live card may be one tonight, so the sample shows it
  {
    id: "review-last-part",
    kind: "review",
    buttons: "Mark complete, close the goal · Park · Snooze · Voice · Text.",
    name: "Review: the last open part of a goal (Mark complete, close the goal)",
    where: "Inbox, Waiting for your review",
    component: "ReviewCard",
    render: () => (
      <ReviewCard
        item={sampleReview({
          id: "sample_last_part",
          face: {
            ...FACE,
            tasks: { done: 2, total: 2 },
            title: "The social board cards got their feedback box, the last part of this goal.",
            delivered: [
              { ok: true, text: "Every card shows its feedback box." },
              { ok: true, text: "The social board cards have it too." },
            ],
            closesGoal: true,
            decision: "Is the goal done? The team recommends yes: Mark complete closes the goal, or say what is missing below.",
          },
        } as Partial<ReviewItem>)}
      />
    ),
  },
  // E979-G20261113 iteration 2 (the owner 2026-11-14, vn_78c963b6: "start the 6. And if I switch one off, start 5. Mark complete is ambiguous"): a persona's follow-ups as switches
  {
    id: "review-switches",
    kind: "review",
    buttons: "Start N, counting the switches that are on (Close, start nothing when all are off) · Park · Snooze · Voice · Text.",
    name: "Review: a persona's follow-ups, each switched on or off (Start N)",
    where: "Inbox, Waiting for your review",
    component: "ReviewCard",
    render: () => (
      <ReviewCard
        item={sampleReview({
          id: "sample_switches",
          face: {
            ...FACE,
            title: "Gap finder checked ten of your voice notes a day later and found three asks that still need a task.",
            delivered: [{ ok: true, text: "Each of the three open asks has a switch below." }],
            next: [
              { title: "Write a house rule that every site looks clean and simple", recommend: "start", target: "EPIC-901", targetName: "One look for every product" },
              { title: "List what our servers must do and measure each", recommend: "start", target: "EPIC-906", targetName: "The team runs unattended" },
              { title: "Give each new social account a first post", recommend: "start", target: "EPIC-946", targetName: "First testers" },
            ],
            decision: "Switch on the follow-ups you want. We recommend all three.",
          },
        } as Partial<ReviewItem>)}
      />
    ),
  },
  // E948-S83 (the owner, third time, ^e-f43544: "We're still not getting the button names that make sense for the tasks"): a finished task's next steps, each Start now or Park, read Start N too
  {
    id: "review-next-steps",
    kind: "review",
    buttons: "Start N, counting the steps set to Start now (Close, start nothing when all are parked) · Park · Snooze · Voice · Text.",
    name: "Review: a finished task with next steps, each Start now or Park (Start N)",
    where: "Inbox, Waiting for your review",
    component: "ReviewCard",
    render: () => (
      <ReviewCard
        item={sampleReview({
          id: "sample_next_steps",
          face: {
            ...FACE,
            title: "The sign-up page went live, and six next steps were found while building it.",
            delivered: [{ ok: true, text: "The sign-up page is live." }],
            next: [
              { title: "Add a welcome email", recommend: "start" },
              { title: "Show the price on the page", recommend: "start" },
              { title: "Ask for a phone number", recommend: "start" },
              { title: "Count the sign-ups each day", recommend: "start" },
              { title: "Add a short demo clip", recommend: "start" },
              { title: "Translate the page to Spanish", recommend: "start" },
            ],
            decision: "Start the six next steps? We recommend all six.",
          },
        } as Partial<ReviewItem>)}
      />
    ),
  },
  // E948-S69 (the owner 2026-11-13, vn_9e6f5fa4, on this very card: "we cannot have a button that says Mark complete when the card is about a decision"): the used-car lookup card, its decision as its buttons
  {
    id: "review-decision",
    kind: "decision",
    buttons: "Yes: plan it · No: park it, the team's pick filled. Park. Snooze. Voice · Text. Never Mark complete.",
    name: "Decide: a finished piece that asks a decision (the used-car lookup)",
    where: "Inbox, Waiting for your review",
    component: "ReviewCard",
    render: () => (
      <ReviewCard
        item={sampleReview({
          id: "sample_decision",
          face: {
            ...FACE,
            project: { name: "Mini businesses" },
            title: "The boring business page was redrawn with diagrams first, and the used-car price idea now fills most of it.",
            taskGoal: "Pick one proven business earning 15 to 30 thousand monthly that our agents could copy.",
            delivered: [
              { ok: true, text: "The first phone screen is one drawn chart of the five businesses with our pick boxed." },
              { ok: true, text: "The chosen car price idea is now most of the page, drawn as flows and charts." },
            ],
            next: [{ title: "used-car price lookups for Spain", recommend: "start" }],
            source: "Your WhatsApp voice note of 12 November, why don't we do something boring, can we copy some guy?",
            decision: "Do we build the used-car price lookup for Spain for 30 days? The team recommends yes, stopping unless three people pay.",
          },
        } as Partial<ReviewItem>)}
      />
    ),
  },
  {
    id: "review-decision-options",
    kind: "decision",
    buttons: "The card's own options, each Answer: next step. Park. Snooze. Voice · Text. Never Mark complete.",
    name: "Decide: a finished piece with its own options",
    where: "Inbox, Waiting for your review",
    component: "ReviewCard",
    render: () => (
      <ReviewCard
        item={sampleReview({
          id: "sample_decision_options",
          face: {
            ...FACE,
            title: "Three ways to find the first testers were tried for a week each.",
            next: [],
            decision: "Which way do we keep? The team recommends Replies, the cheapest per tester.",
            options: ["Replies: keep answering threads", "Posts: keep the daily post", "Neither: stop and rethink"],
          },
        } as Partial<ReviewItem>)}
      />
    ),
  },
  {
    id: "review-words-option",
    kind: "review",
    buttons: "Yes: keep it. No: say what to change opens the box, nothing sent until Send. Park. Snooze. Voice · Text.",
    name: "Review: a No that asks for your words",
    where: "Inbox, Waiting for your review",
    component: "ReviewCard",
    render: () => (
      <ReviewCard
        item={sampleReview({
          id: "sample_words_option",
          face: {
            ...FACE,
            title: "The console made a test customer's server in its own cloud account.",
            next: [],
            decision: "Is making the server in their account at that price right? We recommend yes.",
            options: ["Yes: keep it", "No: say what to change"],
          },
        } as Partial<ReviewItem>)}
      />
    ),
  },
  { id: "review-old", kind: "review", buttons: "Open it. Park. Voice · Text.", name: "Review from an older release (no card face)", where: "Inbox, Waiting for your review", component: "OldCard", render: () => <ReviewCard item={sampleReview({ id: "sample_old", face: undefined })} /> },
  { id: "held-post", kind: "review", buttons: "Schedule · Changes wanted · Decline.", name: "SocialApp: a held post waiting for you", where: "Inbox, Waiting for your review (both skins)", component: "PostReviewCard", render: () => <PostReviewCard item={samplePost()} /> },
  { id: "held-reply", kind: "review", buttons: "Schedule this reply · Changes wanted · Decline.", name: "SocialApp: a reply in a thread waiting for you", where: "Inbox, Waiting for your review (both skins)", component: "PostReviewCard", render: () => <PostReviewCard item={samplePost("outreach")} /> },
  { id: "mac-ticket", kind: "do", buttons: "Copy the text · Done · Stuck or changes wanted.", name: "Mac: a ticket Claude on your Mac does", where: "Inbox, Needs Mac agent", component: "LaptopCard", render: () => <LaptopCard row={macRow(true)} n={1} /> },
  { id: "mac-no-page", kind: "do", buttons: "Copy the text. Voice · Text.", name: "Mac: a ticket whose page is not written yet", where: "Inbox, Needs Mac agent", component: "MacCards", render: () => <MacCards rows={[macRow(false)]} /> },
  { id: "team-digest", kind: "news", buttons: "Seen. Voice · Text.", name: "Digest: a scorecard greener or redder, and why", where: "Inbox, Scorecard digests", component: "TeamDigestCard", render: () => <TeamDigestCard card={sampleDigest()} /> },
  { id: "team-support", kind: "news", buttons: "Seen. Voice · Text.", name: "Support: the day's mails by product, drafted or needing you", where: "Inbox, Ideas and digests from the team", component: "TeamSupportCard", render: () => <TeamSupportCard card={sampleSupport()} /> },
  { id: "team-idea", kind: "decision", buttons: "Go ahead. Park. Voice · Text.", name: "Idea: a way to reach a goal faster, the gain, our recommendation", where: "Inbox, Ideas", component: "TeamIdeaCard", render: () => <TeamIdeaCard card={sampleIdea()} /> },
  { id: "team-advisor", kind: "decision", buttons: "Accept all on top, then Accept · Decline per suggestion. Voice · Text on each.", name: "Senior advisor: the week's suggestions as one set", where: "Inbox, From the Senior advisor", component: "AdvisorSetCard", render: () => <AdvisorSetCard card={sampleAdvisor()} /> },
  { id: "connect", kind: "do", buttons: "Connect with Google, in this browser. Voice · Text.", name: "Connect: one tap to let the team use a Google account", where: "Inbox, top (and the Connections page)", component: "ConnectCard", render: () => <ConnectCard c={sampleConnect()} /> },
  { id: "team-goal", kind: "decision", buttons: "One button per goal, the recommended one marked. Park. Voice · Text.", name: "Goal: a goal that is not set, two or three to pick from", where: "Inbox, Goals to set", component: "GoalTalkCard", render: () => <GoalTalkCard card={sampleGoal()} /> },
  { id: "campaign-goal", kind: "answer", buttons: "Open the campaign. Voice · Text: his number in words or by voice.", name: "Goal: a campaign with no goal number of his yet", where: "Inbox, Goals to set", component: "CampaignGoalCard", render: () => <CampaignGoalCard t={{ name: "Testers campaign", app: "social", openUrl: "https://social.example/campaigns/testers", text: "It has no number yet. What number would tell you it worked?" }} /> },
];

/**
 * E948-S83 iteration 2 (the owner 2026-11-14 23:38Z: "There should always be one button which is to park"): every card that waits
 * on him shows Park beside its own buttons, except these, each with why (cardInventory.test.tsx holds both lists).
 * "For your information" cards ask nothing, so they need no Park.
 */
export const NO_PARK: Record<string, string> = {
  "persona-request": "a persona's request is not written in a spine yet, so there is no line to park it on: follow-up",
  "status-ready": "a draft task: leaving it unstamped already keeps it parked",
  "status-ask-yes-no": "the short form of an ask: Park sits on its whole card, one tap away",
  "status-stalled": "Leave it off is its park: the goal is paused until you switch it on",
  "held-post": "a held post never goes out without your Schedule: it already waits",
  "held-reply": "a held reply never goes out without your Schedule: it already waits",
  "mac-ticket": "a Mac ticket waits on the Mac list until you run it",
  "mac-no-page": "a Mac ticket waits on the Mac list until you run it",
  connect: "it stays until the account is connected, and the connect list lives on the server, not on a task line to park",
  "campaign-goal": "the question lives in the campaign's own world until its number is set: nothing here to park it on",
  "team-advisor": "the week's suggestions close with the week; Park per suggestion is a follow-up",
};

/**
 * Cards elsewhere that are not inbox cards, each with the reason (the test lists them so none is forgotten).
 * Steps pages carry their own note box with voice (EPIC-987 kit); the social board's post cards open the post page.
 */
export const NOT_INBOX_CARDS: { name: string; where: string; why: string }[] = [
  { name: "Social board post card (Pipeline)", where: "SocialApp, a campaign's Posts board", why: "a board item that opens the post page; its open card has Give feedback (a draft) or the live post's feedback box, this block comes later: follow-up" },
  { name: "Social board idea card", where: "SocialApp, Ideas", why: "its own feedback box with the same microphone; this block comes later: follow-up" },
  { name: "Plan spot", where: "Credits page", why: "the plan and its Buy button, a page panel that asks nothing of you" },
  { name: "Pinned page", where: "Pages list, Pinned", why: "a pinned page with Refresh, Rename and Unpin, a list row that asks nothing of you" },
  { name: "Steps page step", where: "a steps page (EPIC-987 kit)", why: "a page, not a card: every step has Done, Stuck and a note box with voice" },
];

/** the page: every card at 390 px and at 1280 px, each in a frame at that real width (the phone layout is the phone's). */
export function CardInventoryPage() {
  const frame = new URLSearchParams(window.location.search).get("frame");
  useEffect(() => {
    document.title = "Every card type · EpicTeam";
  }, []);
  // A link to one card (#<card id>) opens on that card: the cards render after load, so the browser's own jump misses it.
  // In a frame the frame scrolls itself (never its parent); the page passes the anchor to both frames and shows them.
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const target = CARD_TYPES.some((c) => `#${c.id}` === hash) ? hash : "";
  useEffect(() => {
    if (!target) return;
    const t = window.setTimeout(() => {
      if (frame) {
        const el = document.getElementById(target.slice(1));
        if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 8);
      } else document.querySelector("[data-testid=inventory-frames]")?.scrollIntoView({ block: "start" });
    }, 300);
    return () => window.clearTimeout(t);
  }, [frame, target]);
  // the cards are samples: their presses do nothing here (no sample reaches a real project). E948-S83: the follow-up
  // switches (On / Off, Start now / Park) only change the card on screen, so they work here: switch one off, Start 6 reads Start 5.
  const inert = (e: React.SyntheticEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest("button, a, input[type=radio], input[type=checkbox]") && !t.closest("[data-feedback-mic], textarea, [data-testid=review-switch], [data-testid=review-switch-start], [data-testid=review-switch-park]")) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  const list = (
    <ol className="grid list-none gap-6 p-0" onClickCapture={inert}>
      {CARD_TYPES.map((c, i) => (
        <li key={c.id} className="grid min-w-0 gap-2" id={c.id} data-card-type={c.id}>
          <div className="text-xs text-muted-foreground">
            {i + 1}. <span className="font-medium text-foreground">{c.name}</span> · {c.where}
          </div>
          {c.render()}
        </li>
      ))}
    </ol>
  );
  if (frame) return <main className="mx-auto max-w-3xl bg-background p-3 text-foreground">{list}</main>;
  return (
    <main className="mx-auto grid max-w-[1700px] gap-6 bg-background p-4 text-foreground">
      <header className="grid gap-2">
        <h1 className="text-xl font-semibold">Every card type the team can send you: {CARD_TYPES.length}, each ending with the feedback block.</h1>
        <div className="rounded-lg border p-3 text-sm">
          A decision card answers with its options, each named by what happens next, never Mark complete. Every card that waits on you has Park: not now, nothing decided, back in a month or whenever you bring it back. Every card ends the same way: its buttons in one row, then Voice (one tap records, the next sends) and Text (opens the box with a screenshot and Send). Samples only: pressing here sends nothing.
          {/* E948-S69: the one table of card types and their buttons. On a phone each row stacks as a block (no squeezed columns, nothing cut); a table from sm up. */}
          <table className="mt-2 block w-full border-collapse text-left sm:table" data-testid="card-button-table">
            <thead className="hidden sm:table-header-group">
              <tr className="border-b text-muted-foreground">
                <th className="py-1 pr-3 font-medium">Card type</th>
                <th className="py-1 pr-3 font-medium">It asks you to</th>
                <th className="py-1 font-medium">Its buttons</th>
              </tr>
            </thead>
            <tbody className="block sm:table-row-group">
              {CARD_TYPES.map((c, i) => (
                <tr key={c.id} className="grid gap-0.5 border-b py-2 align-top sm:table-row sm:py-0" data-kind={c.kind}>
                  <td className="block break-words sm:table-cell sm:py-1 sm:pr-3">
                    {i + 1}. <a className="font-medium underline sm:font-normal" href={`#${c.id}`}>{c.name}</a>
                  </td>
                  <td className="block break-words sm:table-cell sm:py-1 sm:pr-3">
                    <span className="text-muted-foreground sm:hidden">It asks you to: </span>
                    {KIND_NAME[c.kind]}
                  </td>
                  <td className="block break-words sm:table-cell sm:py-1">
                    <span className="text-muted-foreground sm:hidden">Its buttons: </span>
                    {c.buttons}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-muted-foreground" data-testid="no-park">Without Park: {Object.entries(NO_PARK).map(([id, why]) => `${CARD_TYPES.find((c) => c.id === id)?.name ?? id} (${why})`).join("; ")}.</p>
          <p className="mt-2 text-muted-foreground">Not inbox cards: {NOT_INBOX_CARDS.map((n) => `${n.name} (${n.why})`).join("; ")}.</p>
        </div>
      </header>
      <section className="flex flex-wrap items-start gap-6" data-testid="inventory-frames">
        <figure className="grid min-w-0 max-w-full gap-1">
          <figcaption className="text-sm font-medium">Phone, 390 px</figcaption>
          <iframe title="Every card at 390 px" src={`?frame=390${target}`} className="h-[90vh] w-[390px] max-w-full rounded-lg border" data-testid="inventory-390" />
        </figure>
        <figure className="grid min-w-0 flex-1 gap-1">
          <figcaption className="text-sm font-medium">Computer, 1280 px</figcaption>
          <iframe title="Every card at 1280 px" src={`?frame=1280${target}`} className="h-[90vh] w-[1280px] max-w-full rounded-lg border" data-testid="inventory-1280" />
        </figure>
      </section>
    </main>
  );
}
