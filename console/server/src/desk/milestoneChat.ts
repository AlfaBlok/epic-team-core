import { execFile } from "node:child_process";
import path from "node:path";
import type { Milestone, Persona } from "../store.js";
import { DEFAULT_DESK_REPO, readRemit } from "./desk.js";
import { createChatSession, DeskError, migrateDeskSessions, type ChatSession, type SessionDeps } from "./session.js";
import { milestoneWorld } from "../tenancy/world.js";
import { hooks, type JobRoute } from "../plug/hooks.js";
import { createJobChat, type JobChat } from "./jobChat.js";
import { DEFAULT_TENANT } from "../db.js";
import { listRepos } from "../adapters/repos.js";
import { intakeSection, type IntakeRunner } from "./packIntake.js";
import { homeRepo, homeWorld, ownerName } from "../identity.js";

/**
 * the milestone chat. Every milestone page has a Chat tab on ONE long-lived T3 thread for that milestone (key
 * `milestone:<id>`), run by the shared "Repo desk" persona in the milestone repo's T3 project. Same engine as the Team desk
 * (session.ts): launched on first open, reused, relaunched with a summary when T3 lost it, told new endpoint lists by a
 * versioned update. Two milestones of the same repo get two threads; nested milestones overlap on purpose (the owner picks the level).
 *
 * Hooks for the next rows: passes a `[since your last message]` block as `send(..., prefix)`; reads the
 * `X-Console-Run: milestone-chat:<id>` header every call from this chat carries (`chatCaller`) to keep it inside its subtree, and
 * opened ask answers (v2). Marks and stamps stay the owner's.
 */
export const REPO_DESK_PERSONA_NAME = "Repo desk";
export const MILESTONE_SEED_MARKER = "[repo-desk seed]";
export const MILESTONE_UPDATE_MARKER = "[repo-desk update]";
/**
 * Raise when milestoneEndpointLines changes: every live milestone thread gets one `[repo-desk update]`. 5 = desk intake;
 * 6 = dispatch `no_credits` (a world's pick goes through its credits gate); 7 = (L-37) an Add on the owner's ask is ready;
 * 8 = rework, voice notes recorded in this chat (`🎙 Voice note (Chat)`): his chat message, spoken; 11 = a note on a Brief slide rebuilds it (POST …/slide);
 * 13 =: his words that go beyond this milestone are handed on (the console tells the Team desk for a voice note);
 * 14 =: a wheel note from the Company view, marked handled once placed;
 * 15 =: one request, one ticket row: each message of his carries a request id; it goes on exactly one row.
 */
export const MILESTONE_SEED_VERSION = 16;
/** The bind view pasted into the seed is capped (a root spine's Current State can be long; the thread re-reads it anyway). */
export const BIND_MAX_CHARS = 8_000;
export const milestoneKey = (id: string) => `milestone:${id}`;
/** Header value every console call from a milestone chat carries. */
export const milestoneRunHeader = (id: string) => `milestone-chat:${id}`;
/** The milestone a request comes from, when its X-Console-Run header names a milestone chat (scope guard). */
export const chatCaller = (header: string | undefined): string | undefined => /^milestone-chat:(\S+)$/i.exec((header ?? "").trim())?.[1];

/** Remit used when docs/personas/repo-desk.md is not in the checkout yet. */
const FALLBACK_REMIT =
  `You are a Repo desk: ${ownerName()}'s chat about one milestone of one repo. You know this repo, the milestone's epic subtree and what happened lately ` +
  "(spines, git log, runs, asks) in depth and answer about it in plain words. You shape and place new work under this milestone, and run, steer or stop " +
  `its personas only through the console's endpoints. On ${ownerName()}'s request you manage this milestone: dispatch workers through the console's chat dispatch, ` +
  "verify their diff and checks, integrate and deploy per the repo's rules; you never write code yourself. Anything above or beside this milestone goes to " +
  "that milestone's chat or the Team desk. Reply short, plain words, links first.";

export interface MilestoneChatDeps extends SessionDeps {
  publicUrl: string;
  /** the job route (a customer workspace on its own job servers chats there); default hooks.jobRoute. */
  jobRoute?: JobRoute;
  reposRoot: string;
  /** Repo whose docs/personas/repo-desk.md seeds the persona (the console's own repo). */
  deskRepo?: string;
  milestone: (id: string) => Milestone | undefined;
  /** The milestone's checkout and its spine path inside it. */
  locate: (m: Milestone) => Promise<{ repoDir?: string; rel?: string }>;
  /** `spines.py --bind <rel>` output for the seed; undefined when it cannot run. */
  bind?: (repoDir: string, rel: string) => Promise<string | undefined>;
  /** the "since your last message" block for a message sent now (undefined = nothing new). */
  since?: (m: Milestone, sinceIso: string) => Promise<string | undefined>;
  /** a pack's desk intake text (`pack.py <pack> --wake-text`); undefined = no intake section. */
  intake?: IntakeRunner;
}

/** Runs `python3 <skillDir>/scripts/spines.py --bind <rel>` in the checkout. */
export function spinesBindRunner(skillDir: string, timeoutMs = 30_000) {
  const script = path.join(skillDir, "scripts", "spines.py");
  return (repoDir: string, rel: string) =>
    new Promise<string | undefined>((resolve) => {
      execFile("python3", [script, "--bind", rel], { cwd: repoDir, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? undefined : stdout));
    });
}

/** What a repo desk may call (seed + every `[repo-desk update]`). Raise MILESTONE_SEED_VERSION when it changes. */
/** `world`: the milestone's world; the wheel notes (the owner's companies, in the home repo) are the home world's routes only. */
export function milestoneEndpointLines(base: string, m: Pick<Milestone, "id">, world?: string): string[] {
  const h = `-H 'X-Console-Run: ${milestoneRunHeader(m.id)}' -H 'content-type: application/json'`;
  return [
    `What you may call, and only these for run control (never a raw send into another persona's thread, so runs, Activity and retries stay true). Act only on this milestone and the epics below it: the console refuses anything else with 403 \`out_of_scope\` and names the milestone chat (or the Team desk) to use; pass that on to ${ownerName()} with its link, do not retry.`,
    `- Find ids: \`GET ${base}/api/milestones/${m.id}\`, \`GET /api/assignments?milestoneId=${m.id}\`, \`GET /api/runs?milestoneId=${m.id}&limit=10\` (also \`assignmentId=\`, \`parentRunId=\` for a wake's child workers): a run with outcome \`running\` is in flight. \`GET /api/milestones/${m.id}/tree\` is the console's view of the subtree.`,
    `- Run now: \`curl -sS -X POST ${base}/api/assignments/<assignment id>/run-now ${h} -d '{"note":"<one-off instruction>"}'\``,
    `- Steer a run (a persona's wake or a child worker, by run id): \`curl -sS -X POST ${base}/api/runs/<run id>/steer ${h} -d '{"message":"<text>"}'\`; a persona by assignment: \`POST /api/assignments/<assignment id>/steer\` with the same body.`,
    `- Stop a run: \`curl -sS -X POST ${base}/api/runs/<run id>/stop ${h} -d '{"reason":"<why, in ${ownerName()}'s words>","withWorkers":false}'\` (\`withWorkers: true\` only when ${ownerName()} says "and its workers"). Nothing resumes by itself; there is no Pause.`,
    `- Add under this milestone when ${ownerName()} asks for something (L-37: his ask is READY by default): \`curl -sS -X POST ${base}/api/milestones/${m.id}/tree/add ${h} -d '{"kind":"row|done_means|epic","title":"<short>","line":"<one line>","path":"<child spine, optional>","chat":"<his words from this chat, verbatim>"}'\`. The console checks \`chat\` against his messages in this thread, writes it ready with a Decisions row quoting him (a Done-means line also gets a ready row) and wakes the Delivery manager. \`"draft":true\` only when he says so ("just register it", "as a draft"); without his words it is a draft: never ready your own ideas. The console commits and pushes.`,
    `- Dispatch a worker, only when ${ownerName()} asks in this chat: put the row in the ledger first, then \`curl -sS -X POST ${base}/api/milestones/${m.id}/chat/dispatch ${h} -d '{"ticket":"<row id>","summary":"<what it does>","path":"<child spine, optional>"}'\` → \`parentRunId\`, \`childRunId\`, \`providerInstanceId\`, \`briefRules\`, \`steps\`: follow \`steps\` (delegate_task, PATCH threadId, on return verify + integrate + PATCH + \`$EPICSPINE_DISPATCHER done <seat>\`). More workers for the same request: pass \`"parentRunId"\`. \`"dryRun":true\` records the runs without a worker. 409 \`claimed\`: another persona's run works that row (the Delivery manager's wake skips yours the same way): leave it; 409 \`no_seat\`/\`ceiling\`: queued, tell ${ownerName()}; 409 \`no_credits\`: this world is out of credits, nothing started, tell ${ownerName()}. Integrate only the workers you dispatched (root L-3). Rows in flight: \`GET ${base}/api/milestones/${m.id}/claims\`.`,
    `- A social campaign (the repo has \`Pack: social\`, this milestone's spine has \`## Campaign plan\` or its children do): on ${ownerName()}'s word, rename it \`curl -sS -X POST ${base}/api/tenants/<world>/campaigns/${m.id}/rename ${h} -d '{"name":"<his name>"}'\`, replace its plan \`POST …/campaigns/${m.id}/plan\` \`{"plan":"<the whole ## Campaign plan body>"}\`, retire it (pause and hide, nothing deleted) \`POST …/campaigns/${m.id}/retire\`, undo \`POST …/campaigns/${m.id}/restore\`; a new campaign in this repo \`POST ${base}/api/tenants/<world>/campaigns/named\` \`{"repo":"<repo>","name":"<his name>","plan":{…},"roles":["Writer",…],"template":true}\` (it starts from the campaign template, \`GET …/campaigns/template\`). \`<world>\` is \`GET ${base}/api/me\` \`tenant.id\`. A campaign outside this milestone's subtree is 403 \`out_of_scope\`.`,
    `- A campaign's one-pager (the first parts of its \`## Campaign plan\`: Why this campaign, The bet, What we measure, What we hope, My calls, Not doing, Approval). ${ownerName()} owns every line: never write his parts or replace them through \`…/plan\`. When he asks to draft it (the Brief tab's Draft it with me sends "Help me draft this campaign's one-pager"): read the plan, data/brief.md, the message house, the last 14 days of the posts ledger with their numbers and his feedback notes; ask him at most five plain questions (why, the bet, the numbers he hopes for by the end, what we must never do, how he judges a post), then hold the draft for him: \`curl -sS -X POST ${base}/api/tenants/<world>/campaigns/${m.id}/onepager/draft ${h} -d '{"fields":{"why":"…","bet":"…","measure":"…","hope":"…","calls":"- …","notDoing":"…","approval":"…"}}'\` (Approval: one line from the brief's hold rules). It lands on his review list as a normal card: his Approve makes it his, or he edits it on the Brief tab and saves; a second call replaces the draft under the same row. Tell him it waits on his review list; never call it his decision.`,
    `- A note on a Brief slide: a message from ${ownerName()} that starts \`[slide <n>: <title> · file <file> · ref <ref>]\` comes from the campaign's Brief deck ("This slide"). Rebuild that slide only: rewrite the section at that ref the way he asks (keep what he did not ask to change, use his words where he gave them, short plain lines), then write it: \`curl -sS -X POST ${base}/api/tenants/<world>/campaigns/${m.id}/slide ${h} -d '{"file":"<file>","ref":"<ref>","body":"<the new section body, Markdown, without its heading>","note":"<his note, verbatim>"}'\`. The console commits it with a Decisions row and a History line; ${ownerName()} then presses Keep or Undo on the slide. A change of intent also gets its Observations line (the filing rule). Reply first \`Landed: Brief, slide <n>\` linking ${base}/milestones/${m.id}?tab=brief&slide=<n>, then one line on what changed. 409 \`no_change\`: tell him the slide already says that. A message from the deck's "Whole campaign" box is ordinary campaign feedback: file it by the filing rule and say where it landed (\`Landed: <part>, <where>\`).`,
    `- A note on a Product tab slide: a message from ${ownerName()} that starts \`[product slide <n>: <title> · file <file>]\` comes from the campaign's Product tab. The console has already filed it, verbatim, as a \`Product note\` Decisions row of this campaign's spine with a History line, and shows it under that slide: never file it a second time. Act on it: when it answers what the slide proposes, or an open ask about it, register his answer the usual way (the respond call below, his words verbatim) and carry it out; when he asks for a change to the product deck, change that part of <file> (only what he asked) and commit it with a Decisions row quoting him; a change of intent also gets its Observations line (the filing rule). Reply first \`Landed: Product, slide <n>\` linking ${base}/milestones/${m.id}?tab=product&slide=<n>, then one line on what you did.`,
    `- One request, one ticket row (the kernel): each message of ${ownerName()}'s here (a typed line, a voice note) is one request with one id (\`ch_…\` typed, \`vn_…\` a voice note); this chat shows under his message the ticket it is on, and \`curl -sS ${base}/api/requests?hours=6 ${h}\` lists them (\`chat\` \`milestone:${m.id}\` is this chat) with the rows holding each. It lands on exactly one ticket row: an Add from his words writes \`request <id>\` on the new row by itself; his words added to an existing row get \`request <id>\` beside them on that row's line; never on two rows (another row that needs the same words says \`part of <that row>\`, without the id).`,
    `- A goal he talks about becomes an objective to measure (his voice note of 2026-11-24 06:11Z: "let's translate this into objectives and results that we will measure"; his card note of 07:15Z: "Extend this to epic social"): when ${ownerName()} talks here about a goal that no objective or campaign key result covers yet, propose it back for his yes: ONE objective \`Product: Verb ...\` (2 to 6 plain words after the colon) with 2 to 4 key results, each a plain sentence holding the number we will count (\"20 startups sign up for free credits every week\", never \"5 testers\"). \`python3 ~/github/${homeRepo()}/scripts/objective_proposal.py check --name \"<objective>\" --kr \"<key result>\" ...\` until it passes; then \`ask ... --milestone ${m.id} --row <row> --dry\` prints the ask: POST that body to \`${base}/api/needs-owner\` ${h}. One approve card on his inbox; his yes: the objective and the build of its checks are one row.`,
    `- Open asks: \`GET ${base}/api/waiting-on-owner?milestoneId=${m.id}\` (each item has an \`id\`, the code, the question).`,
    `- Register an answer ${ownerName()} gave you in THIS chat (never one you decided): \`curl -sS -X POST ${base}/api/waiting-on-owner/<item id>/respond ${h} -d '{"kind":"answer","text":"<his answer>","via":"milestone-chat","chat":"<his words from this chat, verbatim>","milestoneId":"${m.id}"}'\` (\`kind\` approve, deny or feedback for approve asks: feedback = he wants changes, his words in \`text\`, and the work reopens; words on an approve ask are never an approval, E67). The console checks \`chat\` against his messages in this thread, writes the spine line \`(by ${ownerName()} via milestone chat)\` and wakes the persona who asked. 409 \`not_in_chat\`: ask him to say it here. One answer closes many: the console also closes every other open ask his answer clearly settles, quoting him; a few seconds later \`curl -sS ${base}/api/owner-responses?itemId=<item id> ${h}\` shows \`settles.line\` (what it also closed, and any maybes): tell him that line in one sentence.`,
    `- Marking an outcome and stamping an epic ready stay ${ownerName()}'s own taps on ${base}/milestones/${m.id}: the console refuses them from this chat; give him the link.`,
    `- Ticket detail: Discuss on a ledger row or a run opens THIS chat, and ${ownerName()}'s message then starts with \`[page: <milestone> · <row id or run id>]\`: answer about that item here yourself (read its ledger row, ticket file and runs fresh); no other thread is launched for it.`,
    ...(!world || world === homeWorld() ? [
      `- A wheel note: a message whose \`[page: …]\` reads \`Company view · <company> · <Build|Promo|Operations> wheel (<company id>/<wheel>…)\` is ${ownerName()}'s note dropped in that wheel of a company on the Company view (typed, or a voice note). Act on it like any message from him (his ask is ready, L-37). It stays in the wheel's inbox until it is handled: once you placed it (a row added, an answer given, or passed on), mark it: \`curl -sS -X POST ${base}/api/companies/notes/<note id>/handled ${h}\` (the id is \`wn_…\` in the page hint for a typed note, the \`vn_…\` of a voice note; \`GET ${base}/api/companies/notes\` lists the open ones).`,
    ] : []),
    `- Links: \`GET ${base}/api/desk/links?repo=<checkout name>&path=<spine path>\` returns \`markReady\` and \`spine\`.`,
    "- The EpicSpine skill dir on this host is `~/.claude/skills/epic-spine` (else `~/.agents/skills/epic-spine`): `spines.py`, `spine_new.py`.",
    `- Desk intake: when ${ownerName()}'s message is about a repo whose AGENTS.md has \`Pack: <name>\` (e.g. \`Pack: social\`), file it by that pack's intake rule: the \`## Desk intake\` section below when there is one, else \`python3 <skill dir>/scripts/pack.py <name> --wake-text\` (read it fresh). Sort the message into one kind, write it where the kind says, and reply first with where it landed: the file and section as a link, the line written, who acts next, undo; a kind you cannot tell gets one line back, never a guess.`,
    `- Voice notes: a message from ${ownerName()} that starts \`🎙 Voice note (Chat)\` is a note he recorded in this chat (tap to start, tap to finish), transcribed by the console, with an \`Audio:\` link to his recording. It is exactly his typed message, spoken: act on it as on his chat words, every rule as usual; allow for speech-to-text slips; reply in text.`,
    `- Beyond this milestone: handle the part of his message that belongs here; anything he says about other milestones, products or rows is not dropped. For a voice note the console already hands the rest to the Team desk (a \`📎 Also in this note\` line there); say in one line that the rest went to the Team desk. For typed words, update those rows yourself when they are in this milestone's repo, else tell him in one line that the Team desk takes it and drop one desk inbox note in the world's home repo (\`python3 ~/github/${homeRepo()}/scripts/desk_note.py send\`, about \`Also in ${ownerName()}'s chat: <topics>\`, his words in the body).`,
    `- A message that starts with \`${MILESTONE_UPDATE_MARKER}\` comes from the console, not from ${ownerName()}: act on it as written; ${ownerName()} does not see it.`,
  ];
}

export function milestoneSeed(o: {
  persona: Pick<Persona, "name" | "remit">;
  milestone: Pick<Milestone, "id" | "title" | "repo">;
  publicUrl: string;
  repoDir?: string;
  rel?: string;
  bind?: string;
  summary?: string;
  intake?: string;
  /** the milestone's world (milestoneEndpointLines) */
  world?: string;
}): string {
  const base = o.publicUrl.replace(/\/+$/, "");
  const m = o.milestone;
  const repoName = o.repoDir ? path.basename(o.repoDir) : m.repo;
  const bind = o.bind?.trim();
  return [
    MILESTONE_SEED_MARKER,
    `You are ${o.persona.name} for the milestone "${m.title}" of the repo ${repoName}, a persona on ${ownerName()}'s agent team. This thread is your one long-lived session: ` +
      `${ownerName()}'s chat about this milestone. Every message he sends arrives here; an optional first line \`[page: <hint>]\` says which console page he is looking at. Stay in this one thread.`,
    "",
    "## Your remit",
    o.persona.remit.trim(),
    "",
    "## This milestone",
    `- Milestone: ${m.title} (console id ${m.id}, page ${base}/milestones/${m.id})`,
    `- Repo: ${repoName}${o.repoDir ? `, checked out at ${o.repoDir} (read it there: \`git -C ${o.repoDir} log --oneline -20\`, the spines)` : ""}`,
    `- Spine: ${o.rel ?? "(none found)"}; your scope is this epic and every epic below it.`,
    o.repoDir && o.rel
      ? `- Re-read the state before answering about it: \`python3 <skill dir>/scripts/spines.py --bind ${o.rel}\` and \`--active --repo ${o.repoDir}\`, run in ${o.repoDir}; never trust an earlier answer from this thread for the current state.`
      : "- Re-read the spines before answering about the state; never trust an earlier answer from this thread for the current state.",
    "",
    "## Console",
    `Console API: ${base}/api. Send -H 'X-Console-Run: ${milestoneRunHeader(m.id)}' -H 'content-type: application/json' on every call you make, so the console knows the caller is this chat, not ${ownerName()}.`,
    ...milestoneEndpointLines(base, m, o.world),
    ...(o.intake ? ["", o.intake.trim()] : []),
    ...(bind ? ["", `## Where it stands at launch (\`spines.py --bind ${o.rel}\`)`, bind.length > BIND_MAX_CHARS ? `${bind.slice(0, BIND_MAX_CHARS)}\n… (cut; run it yourself for the rest)` : bind] : []),
    ...(o.summary ? ["", "## What happened before this session", o.summary.trim()] : []),
    "",
    "Reply to this message with one line: `Repo desk ready.`",
  ].join("\n");
}

/** `remit`: the persona's current remit, sent with every version (it replaces the seed's). */
export function milestoneUpdateMessage(publicUrl: string, m: Pick<Milestone, "id">, remit?: string, intake?: string, world?: string): string {
  return [
    `${MILESTONE_UPDATE_MARKER} v${MILESTONE_SEED_VERSION}`,
    "The console's endpoint list for this chat changed. This list replaces the one in your first message; use it from now on.",
    ...(remit?.trim() ? ["", "## Your remit (replaces the one in your first message)", remit.trim()] : []),
    "",
    ...milestoneEndpointLines(publicUrl.replace(/\/+$/, ""), m, world),
    ...(intake?.trim() ? ["", intake.trim()] : []),
    "",
    "Reply with exactly: `Updated.`",
  ].join("\n");
}

export function createMilestoneChats(d: MilestoneChatDeps) {
  migrateDeskSessions(d.db); // desk_outbox (idempotent; the desk runs it too)
  const deskRepo = d.deskRepo ?? DEFAULT_DESK_REPO;
  const chats = new Map<string, { sig: string; chat: ChatSession }>();
  /** the intake rule of the milestone repo's packs, links on its GitHub remote. */
  const intakeFor = (repoDir: string): Promise<string | undefined> => {
    if (!d.intake) return Promise.resolve(undefined);
    const name = path.basename(repoDir);
    const remote = listRepos(d.reposRoot).find((r) => path.resolve(r.path) === path.resolve(repoDir))?.remote;
    return intakeSection({ name, path: repoDir, remote }, d.intake).catch(() => undefined);
  };

  /** The chat engine of a milestone (one per id; rebuilt only when its repo or title changed, the thread stays the key's). */
  function chatFor(m: Milestone): ChatSession {
    const tenant = milestoneWorld(d.db, m.id); // the Repo desk of the milestone's world
    const sig = `${m.repo}\n${m.title}\n${tenant}`;
    const have = chats.get(m.id);
    if (have && have.sig === sig) return have.chat;
    const chat = createChatSession(d, {
      key: milestoneKey(m.id),
      repo: m.repo,
      title: `${REPO_DESK_PERSONA_NAME} · ${m.title}`,
      personaName: REPO_DESK_PERSONA_NAME,
      tenant,
      remit: () => readRemit(d.reposRoot, deskRepo, "repo-desk.md", FALLBACK_REMIT),
      seedMarker: MILESTONE_SEED_MARKER,
      updateMarker: MILESTONE_UPDATE_MARKER,
      seedVersion: MILESTONE_SEED_VERSION,
      seed: async ({ persona, summary }) => {
        const { repoDir, rel } = await d.locate(m).catch(() => ({}) as { repoDir?: string; rel?: string });
        const bind = repoDir && rel ? await d.bind?.(repoDir, rel).catch(() => undefined) : undefined;
        const intake = repoDir ? await intakeFor(repoDir) : undefined;
        return hooks.worldPrompt(milestoneSeed({ persona, milestone: m, publicUrl: d.publicUrl, repoDir, rel, bind, summary, intake, world: tenant }), { tenant, personaId: chat.persona().id, consoleUrl: d.publicUrl });
      },
      // the persona's remit rides along (the Personas page owns it; a remit change reaches live threads with the version).
      update: async () => {
        const { repoDir } = await d.locate(m).catch(() => ({}) as { repoDir?: string });
        const intake = repoDir ? await intakeFor(repoDir) : undefined;
        return hooks.worldPrompt(milestoneUpdateMessage(d.publicUrl, m, chat.persona().remit, intake, tenant), { tenant, personaId: chat.persona().id, consoleUrl: d.publicUrl });
      },
      unavailable: "The milestone chat needs the console's T3 connection (the cycle is off on this console).",
    });
    chats.set(m.id, { sig, chat });
    return chat;
  }

  /**
   * a project of a customer workspace whose jobs run on its own job servers chats there too (jobChat.ts: each turn
   * a short job with the workspace's own AI), never on a T3 thread of ours. Undefined for every other milestone.
   */
  let route: JobRoute | undefined | null = null;
  const jobChats = new Map<string, JobChat>();
  function jobChatFor(id: string): JobChat | undefined {
    const world = milestoneWorld(d.db, id);
    if (!world || world === DEFAULT_TENANT) return undefined;
    if (route === null) route = d.jobRoute ?? hooks.jobRoute(d.db);
    if (!route?.chat || !route.handles(world)) return undefined;
    let jc = jobChats.get(id);
    if (!jc) {
      const r = route;
      jc = createJobChat(d.db, r, {
        key: milestoneKey(id),
        world,
        personaId: () => get(id).persona().id,
        seed: () => {
          const m = d.milestone(id);
          if (!m) throw new DeskError(404, "not_found", `no milestone ${id}`);
          const per = get(id).persona();
          return hooks.worldPrompt(milestoneSeed({ persona: per, milestone: m, publicUrl: r.base, world }), { tenant: world, personaId: per.id, consoleUrl: r.base, job: true });
        },
      });
      jobChats.set(id, jc);
    }
    return jc;
  }

  const get = (id: string): ChatSession => {
    const m = d.milestone(id);
    if (!m) throw new DeskError(404, "not_found", `no milestone ${id}`);
    return chatFor(m);
  };

  /** since the owner's previous message in this chat (first one: since the thread started); never blocks the send. */
  async function sinceFor(id: string, chat: ChatSession): Promise<string | undefined> {
    const m = d.milestone(id);
    const s = chat.current();
    if (!d.since || !m || !s) return undefined;
    try {
      const last = (await chat.jordiMessages(Number.POSITIVE_INFINITY)).at(-1)?.at; // his previous message, however old
      return await d.since(m, last ?? s.createdAt);
    } catch {
      return undefined;
    }
  }

  return {
    chatFor: get,
    jobChatFor,
    /** the chat a page reads: the job chat of a workspace on its own servers, else the T3 chat. */
    reader: (id: string): Pick<ChatSession, "view" | "earlier"> => jobChatFor(id) ?? get(id),
    view: (id: string) => (jobChatFor(id) ?? get(id)).view(),
    send: async (id: string, text: string, page?: string, clientRequestId?: string) => {
      const own = jobChatFor(id);
      if (own) return own.send(text, page, clientRequestId);
      // a customer workspace's project chat never starts an agent on our shared servers and seats (the shared-host
      // gate, as its Team desk: hosted desk/worldDesk.ts); it opens when its chat runs on the workspace's own servers.
      if (hooks.worldWakeGate()(milestoneWorld(d.db, id)))
        throw new DeskError(409, "world_needs_box", "Your team's chat starts when it runs on your workspace's own servers. Your projects and your team's jobs keep working.");
      const chat = get(id);
      return chat.send(text, page, clientRequestId, await sinceFor(id, chat));
    },

    /**
     * Background pass: sends queued while T3 was down. No endpoint update from here any
     * more; pushing one to every live milestone thread after a version bump resumed 7 idle Claude sessions on the main server in
     * 12 min. A thread gets the current list when its chat is next opened or written to (syncSeed in ensureLive).
     */
    async tick(): Promise<void> {
      // sends queued while T3 was down, for chats nobody has open
      const queued = d.db.prepare("SELECT DISTINCT desk_key FROM desk_outbox WHERE desk_key LIKE 'milestone:%' AND sent_at IS NULL AND failed_at IS NULL").all() as { desk_key: string }[];
      for (const r of queued) {
        const m = d.milestone(r.desk_key.slice("milestone:".length));
        if (m) await chatFor(m).flushQueued().catch(() => undefined);
      }
    },
  };
}

export type MilestoneChats = ReturnType<typeof createMilestoneChats>;
