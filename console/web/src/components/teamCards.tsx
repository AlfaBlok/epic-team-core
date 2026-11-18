import { Fragment, useState, type ReactNode } from "react";
import { ObjectiveName } from "@/components/objectiveName";
import { ParkButton } from "@/components/parkButton";
import { scorecardHref as scorecardHref0, SET_NAME } from "@/lib/scorecards";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "@/api";
import type { AdvisorItem, TeamCard, TeamCardKind, TeamCardsBody } from "@/api/teamcard-types";
import { mutate, useQuery } from "@/lib/data";
import { useInboxSearch } from "@/lib/inboxSearch";
import { CARD_TITLE, CardMeta, CardShell } from "@/components/cardShell";
import { CardFeedback } from "@/components/cardFeedback";
import { SentOr, SentRow } from "@/components/sentRow";
import { markSent, useKeepSent } from "@/lib/sentRows";
import { CARD_LINK, CardButton } from "@/components/ui/cardButton";
import { FoldSection, useSectionOpen } from "@/components/homeSection";
import { useSlotReady } from "@/components/slot";
import { useGoalTalk } from "@/components/campaignGoals";
import { askCard, SectionCallButton, teamCard } from "@/voice/SectionCall";
import { cn } from "@/lib/utils";

/**
 * E948-S66 (the owner, vn_fe52ef4a 2026-11-12 22:19Z: the inbox carries what is blocked on him, strategic ideas to reach
 * the goal faster, a goal conversation where a goal is unset, and per-scorecard digests, greener or redder and why; "I
 * like the look and feel, change the information"). Three card kinds the team makes on its own, each on the one card
 * shell with the one feedback block (L-2: no new colours, pills or frames):
 *
 *   Digest  a scorecard's wheel: its numbers against the last digest, greener or redder, the two or three reasons
 *   Idea    the idea, the gain, the team's recommendation; Go ahead, or his words
 *   Goal    the goal that is unset, two or three proposed goals with numbers; pick one, or his words
 *
 * The record is docs/inbox/cards.json of the code repo (server/src/inbox/teamCards.ts); his answer is one commit there and
 * the persona that made the card reads it on its next wake.
 */

export const TEAM_KIND_WORD: Record<TeamCardKind, string> = { digest: "Digest", idea: "Idea", goal: "Goal", advisor: "Suggestion" };
export const TEAM_SECTION_TITLE: Record<TeamCardKind, string> = { digest: "Scorecard digests", idea: "Ideas to reach a goal faster", goal: "Goals to set", advisor: "From the Senior advisor" };
export const TREND_WORD = { greener: "Greener", redder: "Redder", same: "No change", first: "First digest" } as const;

/** the card's goal set, opened on its key result when it names one (every card points at its objective and key result). */
const scorecardHref = (c: Pick<TeamCard, "scorecard" | "keyResult">, kr = c.keyResult) => (c.scorecard ? `${scorecardHref0(c.scorecard)}${kr ? `?kr=${encodeURIComponent(kr)}` : ""}` : undefined);

/** E948-S130: a team card's place in a list and its Sent row (`data-inbox-card`). */
export const teamSlot = (c: Pick<TeamCard, "id">) => `team:${c.id}`;
const teamSaid = (a: { text?: string; pick?: number; via: "text" | "voice" | "button" }) =>
  a.text === TEAM_PARKED ? "Parked for later" : a.pick !== undefined ? "Goal picked" : a.via === "voice" ? "Voice note sent to the team" : a.via === "text" ? "Your words went to the team" : "Answered";

function answerWords(c: TeamCard): string {
  const a = c.answer;
  if (!a) return "";
  const picked = a.pick !== undefined && c.goal ? c.goal.options[a.pick]?.goal : undefined;
  return [picked ? `Picked: ${picked}` : "", a.text].filter(Boolean).join(". ");
}

/** the meta line: the kind word, the scorecard, who made it, its age. */
function Meta({ card, noBy }: { card: TeamCard; noBy?: boolean }) {
  const href = scorecardHref(card);
  return (
    <CardMeta kind={TEAM_KIND_WORD[card.kind]} since={card.at} data-testid="team-card-meta">
      {card.scorecardName || card.scorecard ? (
        href ? (
          <Link className="hover:text-foreground hover:underline" to={href} data-testid="team-card-scorecard">
            {/* the product as its small tinted label, as everywhere an objective's name shows (vn_c2d7cc29) */}
            <ObjectiveName name={card.scorecardName ?? card.scorecard ?? ""} layout="inline" after={card.keyResult ? ` › ${card.keyResult}` : undefined} />
          </Link>
        ) : (
          <ObjectiveName name={card.scorecardName ?? card.scorecard ?? ""} layout="inline" />
        )
      ) : null}
      {noBy ? null : <span>by {card.by}</span>}
      {card.world ? <span data-testid="team-card-world">from {card.world}</span> : null}
    </CardMeta>
  );
}

function A({ href, children }: { href: string; children: ReactNode }) {
  const inside = href.startsWith("/");
  return inside ? (
    <Link to={href} className="underline decoration-foreground/25 underline-offset-[3px] hover:decoration-current">
      {children}
    </Link>
  ) : (
    <a href={href} target="_blank" rel="noreferrer" className="underline decoration-foreground/25 underline-offset-[3px] hover:decoration-current">
      {children}
    </a>
  );
}

/** the card's answer state: pressing a button or Send answers; the card says so and leaves on the next refresh. */
function useAnswer(card: TeamCard, onAnswered?: (c: TeamCard) => void) {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string | undefined>(card.answer ? answerWords(card) : undefined);
  const answer = async (key: string, a: { text?: string; pick?: number; via: "text" | "voice" | "button"; attachments?: string[] }) => {
    setBusy(key);
    setError(undefined);
    try {
      const r = await mutate(() => api.answerTeamCard(card.id, a), "inbox");
      setDone(answerWords(r.card));
      // E948-S130 (vn_4f13161d): a team card he answered (a button, Park, his words or a voice note) collapses in place to
      // its green Sent row with Add comment, like every card; before, it said "saved" and vanished 2.5 s later
      markSent(teamSlot(card), { said: teamSaid(a), title: card.title });
      onAnswered?.(r.card);
    } catch (e) {
      setError(`Not saved: ${(e as Error).message}`);
      throw e;
    } finally {
      setBusy(undefined);
    }
  };
  return { busy, error, done, answer };
}

/**
 * E948-S83 iteration 2: Park on a team card (an idea, a goal to set): his press is the card's answer in its repo file,
 * "Parked: not now", so it leaves his inbox and the card's maker reads that nothing was decided on its next wake.
 */
function TeamPark({ st }: { st: ReturnType<typeof useAnswer> }) {
  return <ParkButton disabled={!!st.busy || st.done !== undefined} onPark={() => void st.answer("park", { text: TEAM_PARKED, via: "button" }).catch(() => {})} />;
}
export const TEAM_PARKED = "Parked: not now. Nothing is decided; bring it back when it matters.";

function Answered({ text }: { text?: string }) {
  if (text === undefined) return null;
  return (
    <p className="mt-2 text-xs text-muted-foreground" data-testid="team-card-answered">
      Your answer is saved ✓{text ? ` ${text}` : ""}
    </p>
  );
}

/** The owner 2026-11-15: the feedback box is one of the answer's options, so it sits right under the
 * buttons with no grey line explaining them ("more fluff about what I think the buttons mean, and then feedback"). */
function Feedback({ card, answer, actions }: { card: TeamCard; answer: ReturnType<typeof useAnswer>["answer"]; actions?: ReactNode }) {
  return (
    <CardFeedback
      origin={`team-card:${card.id}`}
      title={card.title}
      refName={card.id}
      className="mt-3.5"
      actions={actions}
      send={(words, files, via) => answer("words", { text: words, via, ...(files.length ? { attachments: files } : {}) })}
    />
  );
}

/** a scorecard's daily digest: its numbers against the last digest, greener or redder, and why. */
export function TeamDigestCard(props: { card: TeamCard; onAnswered?: (c: TeamCard) => void }) {
  return (
    <SentOr slot={teamSlot(props.card)}>
      <TeamDigestBody {...props} />
    </SentOr>
  );
}

function TeamDigestBody({ card, onAnswered }: { card: TeamCard; onAnswered?: (c: TeamCard) => void }) {
  const d = card.digest!;
  const st = useAnswer(card, onAnswered);
  const changed = (d.lines ?? []).filter((l) => l.was);
  return (
    <CardShell kind="digest" className="text-sm" data-testid="team-card" data-team-kind="digest">
      <Meta card={card} />
      <div className={CARD_TITLE}>{card.title}</div>
      <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1" data-testid="digest-numbers">
        <span className="text-[15px] font-medium tabular-nums text-foreground">
          {d.greens} of {d.total} green
        </span>
        {d.prevGreens !== undefined && d.prevTotal !== undefined && (
          <span className="text-xs tabular-nums text-muted-foreground">
            was {d.prevGreens} of {d.prevTotal}
            {d.prevDay ? ` on ${d.prevDay}` : ""}
          </span>
        )}
        <span className="text-xs font-medium text-foreground" data-testid="digest-trend">
          {TREND_WORD[d.trend]}
        </span>
      </div>
      <div className="mt-2 text-xs text-muted-foreground">Why</div>
      <ol className="mt-0.5 grid list-decimal gap-0.5 pl-5 text-sm leading-relaxed text-foreground/85" data-testid="digest-reasons">
        {d.reasons.map((r, i) => (
          <li key={i}>
            {r.keyResult && card.scorecard ? (
              <Link to={scorecardHref(card, r.keyResult)!} className="underline decoration-foreground/25 underline-offset-[3px] hover:decoration-foreground" data-testid="digest-reason-kr">
                {r.text}
              </Link>
            ) : r.url ? (
              <A href={r.url}>{r.text}</A>
            ) : (
              r.text
            )}
          </li>
        ))}
      </ol>
      {changed.length > 0 && (
        <ul className="mt-2 grid gap-0.5 text-xs text-muted-foreground" data-testid="digest-changed">
          {changed.map((l) => (
            <li key={l.label}>
              {l.label}: {l.was} to {l.state}
              {l.value ? `, ${l.value}` : ""}
            </li>
          ))}
        </ul>
      )}
      {/* the link to check sits above the button, so he opens the thing before he answers. */}
      {scorecardHref(card) && (
        <Link to={scorecardHref(card)!} className={CARD_LINK} data-testid="digest-open">
          Open the {SET_NAME.one.toLowerCase()}
        </Link>
      )}
      <Feedback
        card={card}
        answer={st.answer}
        actions={
          st.done === undefined && (
            <CardButton variant="outline" disabled={!!st.busy} pending={st.busy === "seen"} pendingLabel="Saving…" onClick={() => void st.answer("seen", { text: "Seen", via: "button" }).catch(() => {})} data-testid="digest-seen">
              Seen
            </CardButton>
          )
        }
      />
      <Answered text={st.done} />
      {st.error && <div className="mt-1 text-xs text-destructive">{st.error}</div>}
    </CardShell>
  );
}

/** a strategic idea: the idea, the gain, the team's recommendation; Go ahead, or his words. */
export function TeamIdeaCard(props: { card: TeamCard; onAnswered?: (c: TeamCard) => void }) {
  return (
    <SentOr slot={teamSlot(props.card)}>
      <TeamIdeaBody {...props} />
    </SentOr>
  );
}

function TeamIdeaBody({ card, onAnswered }: { card: TeamCard; onAnswered?: (c: TeamCard) => void }) {
  const i = card.idea!;
  const st = useAnswer(card, onAnswered);
  return (
    <CardShell kind="idea" className="text-sm" data-testid="team-card" data-team-kind="idea">
      <Meta card={card} />
      <div className={CARD_TITLE}>{card.title}</div>
      <dl className="mt-2 grid gap-1 text-sm leading-relaxed">
        <div>
          <dt className="inline text-muted-foreground">Gain: </dt>
          <dd className="inline text-foreground/85" data-testid="idea-gain">
            {i.gain}
          </dd>
        </div>
        <div>
          <dt className="inline text-muted-foreground">We recommend: </dt>
          <dd className="inline text-foreground/85" data-testid="idea-recommend">
            {i.recommend}
          </dd>
        </div>
      </dl>
      {i.links && (
        <div className="mt-1.5 flex flex-wrap gap-x-3 text-xs">
          {i.links.map((l) => (
            <A key={l.url} href={l.url}>
              {l.label}
            </A>
          ))}
        </div>
      )}
      <Feedback
        card={card}
        answer={st.answer}
        actions={
          st.done === undefined && (
            <>
              <CardButton disabled={!!st.busy} pending={st.busy === "go"} pendingLabel="Saving…" onClick={() => void st.answer("go", { text: "Go ahead", via: "button" }).catch(() => {})} data-testid="idea-go">
                Go ahead
              </CardButton>
              <TeamPark st={st} />
            </>
          )
        }
      />
      <Answered text={st.done} />
      {st.error && <div className="mt-1 text-xs text-destructive">{st.error}</div>}
    </CardShell>
  );
}

/** the recommended option in plain words for the decision line ("the first one"). */
const ORDINAL = ["first", "second", "third", "fourth"];
/** the one question a goal card asks: which goal, and the team's pick. */
export function goalQuestion(g: NonNullable<TeamCard["goal"]>): string {
  const rec = g.recommend !== undefined && g.options[g.recommend] ? ORDINAL[g.recommend] : undefined;
  return `Which goal do we set?${rec ? ` We recommend the ${rec} one.` : ""}`;
}

/** the "Your decision" box every decision card ends with, right above the buttons that answer it. */
export function DecisionBox({ children }: { children: ReactNode }) {
  return (
    <div className="mt-3 rounded-lg border border-emerald-700/40 bg-emerald-50/60 px-3 py-2 dark:border-emerald-400/40 dark:bg-emerald-950/30" data-testid="goal-decision">
      <div className="text-xs font-medium text-emerald-800 dark:text-emerald-300">Your decision</div>
      <div className="text-[15px] font-medium leading-snug text-foreground">{children}</div>
    </div>
  );
}

/**
 * a goal conversation: the goal that is unset, two or three proposed goals with numbers; pick one, or his words.
 * E948-S110 (the owner 2026-11-15, vn_43d1c51e: "Goals to set should just be cards like everybody else. I don't understand
 * why there is like an entry or like an entry list"): the card has the shape of every decision card in his inbox: where it
 * came from, what is not set, the link to check, Your decision, then one row of answer buttons (the team's pick filled),
 * Park and Give feedback, then the same feedback box with its microphone. No stacked list of options.
 */
export function GoalTalkCard(props: { card: TeamCard; onAnswered?: (c: TeamCard) => void }) {
  return (
    <SentOr slot={teamSlot(props.card)}>
      <GoalTalkBody {...props} />
    </SentOr>
  );
}

function GoalTalkBody({ card, onAnswered }: { card: TeamCard; onAnswered?: (c: TeamCard) => void }) {
  const g = card.goal!;
  const st = useAnswer(card, onAnswered);
  const box = `goal-feedback-${card.id}`;
  return (
    <CardShell kind="goal" className="text-sm" data-testid="team-card" data-team-kind="goal">
      <Meta card={card} noBy />
      <div className={CARD_TITLE}>{card.title}</div>
      <p className="mt-2 text-[13px] leading-snug text-foreground/80" data-testid="goal-source">
        <span className="font-medium text-foreground">Came from: </span>
        {card.by}, reading {card.scorecardName ? `the ${card.scorecardName} goal` : "this goal"}.
      </p>
      <p className="mt-1 text-sm leading-relaxed text-muted-foreground" data-testid="goal-unset">
        Not set yet: {g.unset}
      </p>
      {/* the links to check before the answer, never between its buttons and the feedback */}
      {g.links?.map((l) => (
        <div key={l.url} className="flex">
          {l.url.startsWith("/") ? (
            <Link to={l.url} className={CARD_LINK} data-testid="goal-link">
              Open the {l.label.toLowerCase()}
            </Link>
          ) : (
            <a href={l.url} target="_blank" rel="noreferrer" className={CARD_LINK} data-testid="goal-link">
              Open the {l.label.toLowerCase()} ↗
            </a>
          )}
        </div>
      ))}
      <DecisionBox>{goalQuestion(g)}</DecisionBox>
      <div className="mt-3.5 grid min-w-0 gap-2" data-card-answer="">
        <div id={box}>
          <Feedback
            card={card}
            answer={st.answer}
            actions={
            <div className="contents" data-testid="goal-options" data-card-buttons="decision">
              {g.options.map((o, n) => (
                <CardButton
                  key={n}
                  variant={g.recommend === n ? "default" : "outline"}
                  className={cn("h-auto min-h-8 shrink whitespace-normal py-1.5 text-left [overflow-wrap:anywhere]", st.done !== undefined && card.answer?.pick === n && "ring-2 ring-foreground/40")}
                  disabled={!!st.busy || st.done !== undefined}
                  pending={st.busy === `pick${n}`}
                  pendingLabel="Saving…"
                  title={`${o.number}${g.recommend === n ? ", we recommend this one" : ""}`}
                  onClick={() => void st.answer(`pick${n}`, { pick: n, text: "", via: "button" }).catch(() => {})}
                  data-testid="goal-option"
                  data-recommended={g.recommend === n ? "yes" : "no"}
                >
                  {o.goal}
                </CardButton>
              ))}
                {st.done === undefined && <TeamPark st={st} />}
              </div>
            }
          />
        </div>
      </div>
      <Answered text={st.done} />
      {st.error && <div className="mt-1 text-xs text-destructive">{st.error}</div>}
    </CardShell>
  );
}

/**
 * E948-S110: a campaign whose goal number is not his yet, as the same goal card (no line in a list): its question in the
 * Your decision box, the campaign to open, and the one feedback box; his words go to the Team desk, which tells the campaign.
 */
export function CampaignGoalCard({ t }: { t: { name: string; openUrl: string; app: string; text: string } }) {
  return (
    <SentOr slot={`goal:${t.openUrl}`}>
      <CampaignGoalBody t={t} />
    </SentOr>
  );
}

function CampaignGoalBody({ t }: { t: { name: string; openUrl: string; app: string; text: string } }) {
  return (
    <CardShell kind="goal" className="text-sm" data-testid="goal-talk-line" data-team-kind="goal">
      <CardMeta kind={TEAM_KIND_WORD.goal}>
        <span>{t.name}</span>
      </CardMeta>
      <div className={CARD_TITLE}>{t.name} has no goal number of yours yet.</div>
      <div className="flex">
        <a href={t.openUrl} target="_blank" rel="noreferrer" className={CARD_LINK} data-testid="goal-link">
          Open the campaign ↗
        </a>
      </div>
      <DecisionBox>{t.text}</DecisionBox>
      <div className="mt-3.5 grid min-w-0 gap-2" data-card-answer="">
        <CardFeedback origin={`campaign-goal:${t.openUrl}`} title={`${t.name} goal`} refName={t.name} className="mt-0" sent={{ slot: `goal:${t.openUrl}` }} />
      </div>
    </CardShell>
  );
}

/** the set's header words: who and which week (his "how do I distinguish this?"). */
export const advisorWeek = (c: TeamCard) => `week of ${c.advisor?.weekLabel ?? c.advisor?.week ?? c.day}`;

/**
 * E948-S59 (the owner 2026-11-12: "Did this ever happen? And how do I distinguish this? In the inbox when this guy sends
 * me some suggestions."): the Senior advisor's suggestions of one week as one marked set. A header names the Senior advisor
 * and the week, with Accept all; each suggestion is its own card on the one shell with Accept, Decline and its answer box.
 * Accept writes a ready row on the suggestion's spine first (server/src/inbox/advisorCards.ts), then the card says which.
 */
export function AdvisorSetCard(props: { card: TeamCard; onAnswered?: (c: TeamCard) => void }) {
  return (
    <SentOr slot={teamSlot(props.card)}>
      <AdvisorSetBody {...props} />
    </SentOr>
  );
}

function AdvisorSetBody({ card, onAnswered }: { card: TeamCard; onAnswered?: (c: TeamCard) => void }) {
  const [set, setSet] = useState(card.advisor!);
  const st = useAnswer(card);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const left = set.items.filter((i) => !i.verdict);
  const send = async (key: string, v: Parameters<typeof api.advisorVerdict>[1]) => {
    setBusy(key);
    setError(undefined);
    try {
      const r = await mutate(() => api.advisorVerdict(card.id, v), "inbox");
      if (r.card.advisor) setSet(r.card.advisor);
      if (r.failed?.length) setError(`Not accepted yet: ${r.failed.map((f) => f.reason).join("; ")}`);
      const took = !r.failed?.length;
      if (r.card.advisor && !r.card.advisor.items.some((i) => !i.verdict)) {
        const rows = r.card.advisor.items.flatMap((i) => (i.verdict?.state === "accepted" && i.verdict.row ? [i.verdict.row] : []));
        markSent(teamSlot(card), { said: v.verdict === "accept" ? "Accepted" : v.verdict === "decline" ? "Declined" : "Answered", title: card.title, ...(rows.length ? { detail: `Ready tasks: ${rows.join(", ")}` } : {}) });
        onAnswered?.(r.card);
      }
      return took;
    } catch (e) {
      setError(`Not saved: ${(e as Error).message}`);
      throw e;
    } finally {
      setBusy(undefined);
    }
  };
  const week = advisorWeek({ ...card, advisor: set });
  return (
    <section className="grid min-w-0 gap-3" data-testid="advisor-set" data-week={set.week}>
      <CardShell kind="advisor" className="text-sm" data-testid="team-card" data-team-kind="advisor">
        <CardMeta kind="Suggestions" since={card.at} data-testid="advisor-header">
          <span>from the Senior advisor</span>
          <span data-testid="advisor-week">{week}</span>
          <span>
            {set.items.length} suggestion{set.items.length === 1 ? "" : "s"}
          </span>
        </CardMeta>
        <div className={CARD_TITLE}>{card.title}</div>
        {set.page && (
          <div className="mt-1.5 text-xs">
            <A href={set.page}>The Senior advisor&apos;s page for this week</A>
          </div>
        )}
        <Feedback
          card={card}
          answer={st.answer}
          actions={
            left.length > 0 && (
              <CardButton disabled={!!busy} pending={busy === "all"} pendingLabel={`Accepting ${left.length}…`} onClick={() => void send("all", { verdict: "accept", via: "button" }).catch(() => {})} data-testid="advisor-accept-all">
                Accept all {left.length}: make them tasks
              </CardButton>
            )
          }
        />
        {!left.length && (
          <p className="mt-2 text-xs text-muted-foreground" data-testid="team-card-answered">
            Your answer is saved ✓ every suggestion has it
          </p>
        )}
        {error && busy === undefined && <div className="mt-1 text-xs text-destructive">{error}</div>}
        <Answered text={st.done} />
      </CardShell>
      <ol className="grid min-w-0 gap-3" data-testid="advisor-items">
        {set.items.map((i, n) => (
          <li key={i.id} className="min-w-0">
            <AdvisorSuggestion card={card} item={i} n={n + 1} of={set.items.length} week={week} busy={busy} send={send} />
          </li>
        ))}
      </ol>
    </section>
  );
}

type SuggestionProps = { card: TeamCard; item: AdvisorItem; n: number; of: number; week: string; busy?: string; send: (key: string, v: Parameters<typeof api.advisorVerdict>[1]) => Promise<boolean> };

/** E948-S130: one suggestion he answered (Accept, Decline or his words) collapses to its own green Sent row, like every card. */
function AdvisorSuggestion(props: SuggestionProps) {
  const slot = `${teamSlot(props.card)}:${props.item.id}`;
  const send: SuggestionProps["send"] = async (key, v) => {
    if (!(await props.send(key, v))) return false;
    markSent(slot, { said: v.verdict === "accept" ? "Accepted: made a task" : v.verdict === "decline" ? "Declined: the team drops it" : v.via === "voice" ? "Voice note sent to the team" : "Your words went to the team", title: props.item.title });
    return true;
  };
  return (
    <SentOr slot={slot}>
      <AdvisorSuggestionBody {...props} send={send} />
    </SentOr>
  );
}

function AdvisorSuggestionBody({ card, item, n, of, week, busy, send }: SuggestionProps) {
  const v = item.verdict;
  return (
    <CardShell kind="advisor-item" className="text-sm" data-testid="advisor-item" data-item={item.id} data-verdict={v?.state ?? "open"}>
      <CardMeta kind={TEAM_KIND_WORD.advisor} since={card.at}>
        <span>
          {n} of {of}
        </span>
        <span>
          Senior advisor, {week}
        </span>
      </CardMeta>
      <div className={CARD_TITLE}>{item.title}</div>
      {(item.why || item.done) && (
        <dl className="mt-2 grid gap-1 text-sm leading-relaxed">
          {item.why && (
            <div>
              <dt className="inline text-muted-foreground">Why: </dt>
              <dd className="inline text-foreground/85">{item.why}</dd>
            </div>
          )}
          {item.done && (
            <div>
              <dt className="inline text-muted-foreground">Done means: </dt>
              <dd className="inline text-foreground/85">{item.done}</dd>
            </div>
          )}
        </dl>
      )}
      {v ? (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="advisor-item-verdict">
          {v.state === "accepted" ? `Accepted ✓ ${v.row ? `it is the ready task ${v.row}` : ""}` : "Declined ✓ the team drops it"}
          {v.text ? `. ${v.text}` : ""}
        </p>
      ) : null}
      {(item.notes ?? []).map((x) => (
        <p key={x.at} className="mt-1 text-xs text-muted-foreground" data-testid="advisor-item-note">
          You said: {x.text}
        </p>
      ))}
      <CardFeedback
        origin={`team-card:${card.id}:${item.id}`}
        title={item.title}
        refName={`${card.id} ${item.id}`}
        className="mt-3.5"
        actions={
          v ? undefined : (
            <>
              <CardButton disabled={!!busy} pending={busy === `a:${item.id}`} pendingLabel="Saving…" onClick={() => void send(`a:${item.id}`, { verdict: "accept", items: [item.id], via: "button" }).catch(() => {})} data-testid="advisor-accept">
                Accept: make it a task
              </CardButton>
              <CardButton variant="outline" disabled={!!busy} pending={busy === `d:${item.id}`} pendingLabel="Saving…" onClick={() => void send(`d:${item.id}`, { verdict: "decline", items: [item.id], via: "button" }).catch(() => {})} data-testid="advisor-decline">
                Decline: drop it
              </CardButton>
            </>
          )
        }
        send={(words, files, via) => send(`n:${item.id}`, { verdict: "note", items: [item.id], text: words, via, ...(files.length ? { attachments: files } : {}) })}
      />
    </CardShell>
  );
}

/** E948-S130: each team card kind collapses to its own Sent row (teamSlot) once he answered it. */
export function TeamCardView({ card, onAnswered }: { card: TeamCard; onAnswered?: (c: TeamCard) => void }) {
  if (card.kind === "advisor" && card.advisor) return <AdvisorSetCard card={card} onAnswered={onAnswered} />;
  if (card.kind === "digest" && card.digest) return <TeamDigestCard card={card} onAnswered={onAnswered} />;
  if (card.kind === "idea" && card.idea) return <TeamIdeaCard card={card} onAnswered={onAnswered} />;
  if (card.kind === "goal" && card.goal) return <GoalTalkCard card={card} onAnswered={onAnswered} />;
  return null;
}

/** the words a search looks through on a team card. */
export function teamCardText(c: TeamCard): string {
  return [c.title, c.scorecardName, c.by, c.advisor?.weekLabel, ...(c.advisor?.items ?? []).flatMap((i) => [i.title, i.why]), c.digest?.reasons.map((r) => r.text).join(" "), c.idea?.gain, c.idea?.recommend, c.goal?.unset, c.goal?.options.map((o) => o.goal).join(" "), c.answer?.text].filter(Boolean).join(" ").toLowerCase();
}

export function useTeamCards(scorecard?: string) {
  return useQuery<TeamCardsBody>(() => api.listTeamCards({ scorecard }), [scorecard], { tag: "inbox" });
}

/**
 * The inbox sections for the team's cards, in his order (22:19Z): ideas, then goals to set, then digests. `kinds` keeps only
 * those (the inbox's Show filter); `scorecard` keeps one scorecard's cards (a scorecard's own inbox). A kind with no
 * open card shows nothing.
 */
export function TeamCardsSections({ kinds = ["advisor", "idea", "goal", "digest"], scorecard, extra }: { kinds?: TeamCardKind[]; scorecard?: string; extra?: Partial<Record<TeamCardKind, ReactNode>> }) {
  const { data, error } = useTeamCards(scorecard);
  useSlotReady(!!data || !!error);
  const search = useInboxSearch();
  const [gone, setGone] = useState<Set<string>>(new Set());
  const q = search.active ? search.q.trim().toLowerCase() : "";
  const open = (data?.open ?? []).filter((c) => !gone.has(c.id) && (!q || teamCardText(c).includes(q)));
  // `extra` (the campaigns' goal talk, the since-yesterday lines) shows before each kind's cards even while
  // the cards are not in (or their route is missing), so the owner's order holds: ideas, goal talk, digest.
  return (
    <>
      {kinds.map((k) => (
        <Fragment key={k}>
          {extra?.[k]}
          {data && <KindSection kind={k} cards={open.filter((c) => c.kind === k)} onAnswered={(c) => setGone((s) => new Set(s).add(c.id))} />}
        </Fragment>
      ))}
    </>
  );
}

function KindSection({ kind, cards, onAnswered }: { kind: TeamCardKind; cards: TeamCard[]; onAnswered: (c: TeamCard) => void }) {
  const [open, setOpen] = useSectionOpen(`team-${kind}`);
  const kept = useKeepSent(cards, teamSlot, `team-${kind}`);
  if (!kept.length) return null;
  return (
    <FoldSection title={TEAM_SECTION_TITLE[kind]} count={cards.length} tone="info" testId={`team-cards-${kind}`} open={open} onToggle={setOpen}>
      <ul className="grid min-w-0 grid-cols-1 gap-[18px]" data-testid={`team-cards-${kind}-list`}>
        <TeamCardRows rows={kept} onAnswered={onAnswered} />
      </ul>
    </FoldSection>
  );
}

/**
 * the owner (2026-11-15: "either I'm reviewing something or I am unblocking something ... why do we have
 * two sets of goals to be set?"): the Inbox's few sections. Goals to set is one list, the campaigns' goal questions and
 * the team's goal cards together, and counts in red as waiting on him; the team's ideas, the Senior advisor's suggestions
 * and the scorecard digests are one list for his review, in green. Never a grey count: a list with nothing in it hides.
 */
export const INBOX_SECTION_TITLE = { goal: "Goals to set", team: "Ideas and digests from the team" } as const;
export const TEAM_GROUP_KINDS: TeamCardKind[] = ["advisor", "idea", "digest"];

/**
 * what Goals to set's count is made of, in his words: "7 of your 13 objectives still need a goal, and 8 campaigns
 * need a number." `obj` (the server's goalObjectives) gives how many active objectives he has; absent, the cards alone.
 */
export function goalsSplit(objectiveCards: number, campaignLines: number, obj?: { active: number; needGoal: number }): string {
  const n = obj?.needGoal ?? objectiveCards;
  const objs = obj ? `${n} of your ${obj.active} objectives ${n === 1 ? "still needs" : "still need"} a goal` : `${n} ${n === 1 ? "objective needs" : "objectives need"} a goal`;
  if (!campaignLines) return `${objs}.`;
  const camps = `${campaignLines} ${campaignLines === 1 ? "campaign needs" : "campaigns need"} a number`;
  return n || obj ? `${objs}, and ${camps}.` : `${camps[0].toUpperCase()}${camps.slice(1)}.`;
}

export function InboxGoalsToSet({ scorecard }: { scorecard?: string }) {
  const { data, error } = useTeamCards(scorecard);
  const { talk, ready, needle } = useGoalTalk();
  useSlotReady((!!data || !!error) && ready);
  const search = useInboxSearch();
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [open, setOpen] = useSectionOpen("inbox-goals-to-set");
  const q = search.active ? search.q.trim().toLowerCase() : "";
  const cards = (data?.open ?? []).filter((c) => c.kind === "goal" && !gone.has(c.id) && (!q || teamCardText(c).includes(q)));
  // a goal set's own inbox (scorecard) is that set's cards only: the campaigns' questions belong to the whole Inbox.
  const lines = scorecard ? [] : talk;
  const count = cards.length + lines.length;
  const rows = useKeepSent(cards, teamSlot, "inbox-goals");
  if (!count && !rows.length) return null;
  return (
    <FoldSection
      title={INBOX_SECTION_TITLE.goal}
      count={count}
      tone="needs-you"
      testId="inbox-goals-to-set"
      open={open || !!needle}
      onToggle={setOpen}
      call={count > 0 && <SectionCallButton section={INBOX_SECTION_TITLE.goal} testId="inbox-goals-to-set" onOpen={() => setOpen(true)} cards={() => [...lines.map((t) => askCard({ id: t.openUrl, title: `${t.name}: ${t.text}`, where: t.name, url: t.openUrl })), ...cards.map(teamCard)]} />}
    >
      {/* The owner on a call ("is there a relation between these 15 numbers?"): the count is two kinds of goal,
          said on the section, so it is never read as his objectives: his objectives still needing a goal, then his campaigns. */}
      {!scorecard && <p className="mb-2 text-xs text-muted-foreground" data-testid="goals-to-set-split">{goalsSplit(cards.length, lines.length, data?.goalObjectives)}</p>}
      {/* E948-S110: every goal to set is one card, the campaigns' questions and the team's goal cards alike. */}
      <ul className="grid min-w-0 grid-cols-1 gap-[18px]" data-testid="team-cards-goal-list">
        {lines.map((t) => (
          <li key={t.openUrl} className="min-w-0" data-inbox-card={`goal-talk:${t.openUrl}`}>
            <CampaignGoalCard t={t} />
          </li>
        ))}
        <TeamCardRows rows={rows} onAnswered={(x) => setGone((s) => new Set(s).add(x.id))} />
      </ul>
    </FoldSection>
  );
}

/**
 * E948-S130: a list of team cards where each one he answered stays as its green Sent row in the place it had (after the
 * refetch drops it and after a reload), like Blocked on you and the review lists.
 */
function TeamCardRows({ rows, onAnswered }: { rows: ReturnType<typeof useKeepSent<TeamCard>>; onAnswered: (c: TeamCard) => void }) {
  return (
    <>
      {rows.map(({ slot, item: c, sent }) => (
        <li key={slot} className="min-w-0" data-team-kind={c?.kind} data-inbox-card={slot}>
          {sent ? <SentRow slot={slot} entry={sent} /> : c && <TeamCardView card={c} onAnswered={onAnswered} />}
        </li>
      ))}
    </>
  );
}

export function InboxIdeasAndDigests({ kinds = TEAM_GROUP_KINDS, scorecard }: { kinds?: TeamCardKind[]; scorecard?: string }) {
  const { data, error } = useTeamCards(scorecard);
  useSlotReady(!!data || !!error);
  const search = useInboxSearch();
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [open, setOpen] = useSectionOpen("inbox-team-cards");
  const q = search.active ? search.q.trim().toLowerCase() : "";
  const all = (data?.open ?? []).filter((c) => kinds.includes(c.kind) && !gone.has(c.id) && (!q || teamCardText(c).includes(q)));
  // his old order inside the one list: the Senior advisor's suggestions, then ideas, then digests.
  const cards = kinds.flatMap((k) => all.filter((c) => c.kind === k));
  const rows = useKeepSent(cards, teamSlot, "inbox-team");
  if (!rows.length) return null;
  return (
    <FoldSection
      title={INBOX_SECTION_TITLE.team}
      count={cards.length}
      tone="review"
      testId="inbox-team-cards"
      open={open || !!q}
      onToggle={setOpen}
      call={cards.length > 0 && <SectionCallButton section={INBOX_SECTION_TITLE.team} testId="inbox-team-cards" onOpen={() => setOpen(true)} cards={() => cards.map(teamCard)} />}
    >
      <ul className="grid min-w-0 grid-cols-1 gap-[18px]" data-testid="inbox-team-cards-list">
        <TeamCardRows rows={rows} onAnswered={(x) => setGone((s) => new Set(s).add(x.id))} />
      </ul>
    </FoldSection>
  );
}

/** what the inbox shows: all, or one of its sections (his "each kind filterable"); kept in the address as ?show=. */
export const INBOX_SHOW = ["all", "blocked", "goal", "review", "team"] as const;
/** the old one-kind choices (?show=idea …) still open, as that kind inside its list; no button of their own. */
const OLD_SHOW = ["advisor", "digest", "idea"] as const;
export type InboxShow = (typeof INBOX_SHOW)[number] | (typeof OLD_SHOW)[number];
export const SHOW_WORD: Record<(typeof INBOX_SHOW)[number], string> = { all: "All", blocked: "Blocked", goal: "Goals to set", review: "Review", team: "Ideas and digests" };

export function useInboxShow(): [InboxShow, (s: InboxShow) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get("show");
  const show = ([...INBOX_SHOW, ...OLD_SHOW] as readonly string[]).includes(raw ?? "") ? (raw as InboxShow) : "all";
  const set = (s: InboxShow) => {
    const next = new URLSearchParams(params);
    if (s === "all") next.delete("show");
    else next.set("show", s);
    setParams(next, { replace: true });
  };
  return [show, set];
}

/** the Show line on top of the inbox: plain words, the chosen one in ink (no pills, no colours: L-2). */
export function InboxShowFilter({ show, onChange, counts }: { show: InboxShow; onChange: (s: InboxShow) => void; counts?: Partial<Record<InboxShow, number>> }) {
  return (
    <nav className="mb-3 flex flex-wrap items-center gap-x-1 gap-y-1 text-[13px]" aria-label="Show" data-testid="inbox-show">
      <span className="mr-1 text-xs text-muted-foreground">Show</span>
      {INBOX_SHOW.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onChange(s)}
          aria-pressed={show === s}
          data-testid={`inbox-show-${s}`}
          className={cn(
            "min-h-8 rounded-md px-2",
            show === s ? "font-medium text-foreground underline decoration-foreground/40 underline-offset-[5px]" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {SHOW_WORD[s]}
          {counts?.[s] ? <span className="ml-1 tabular-nums text-muted-foreground">{counts[s]}</span> : null}
        </button>
      ))}
    </nav>
  );
}

/** which inbox parts a Show choice keeps: `goals` the Goals to set list, `kinds` the kinds in the ideas and digests list. */
export function showKeeps(show: InboxShow): { blocked: boolean; review: boolean; rest: boolean; goals: boolean; kinds: TeamCardKind[] } {
  if (show === "all") return { blocked: true, review: true, rest: true, goals: true, kinds: TEAM_GROUP_KINDS };
  return {
    blocked: show === "blocked",
    review: show === "review",
    rest: false,
    goals: show === "goal",
    kinds: show === "team" ? TEAM_GROUP_KINDS : show === "advisor" || show === "digest" || show === "idea" ? [show] : [],
  };
}
