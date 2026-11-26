import { leanJson } from "./leanJson.js";
import { answerCache } from "./answerCache.js";
import { productsAdded } from "./voice/productNamed.js";
import { phased } from "./timerPhase.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { headSha } from "./gitRefs.js";
import { Hono, type Context } from "hono";
import { compress } from "hono/compress";
/** the GET lists the Inbox opens with (gzipped when the browser takes it; tiny answers stay plain). */
export const INBOX_LISTS = ["/waiting-on-owner", "/waiting-on-owner/:id", "/review-items", "/personas", "/status", "/milestones/:id/status", "/owner-activity", "/laptop"];
import { HTTPException } from "hono/http-exception";
import type { ZodSchema, z } from "zod";
import { DEFAULT_TENANT, defaultDbPath, ensureTenancy, openDb, type DB } from "./db.js";
import { createStore, forTenant, UnknownReference, type Milestone, type Persona, type Run } from "./store.js";
import * as s from "./schemas.js";
import { logToggle, toggleActorFor, worldToggleRefusal } from "./assignmentToggle.js";
import { locate } from "./adapters/milestone.js";
import { listRepos, resolveRepo } from "./adapters/repos.js";
import { pursuitsDirFor, putFirst } from "./inbox/priorityAsk.js";
import { doorSession } from "./auth/owner.js";
import { mountLanding, mountLandingMarks } from "./landing.js";
import { ownerSeatFree, readSeats, seatBlockerFor } from "./adapters/seats.js";
import { movingLimit, stalledWake, STALL_WATCH_BY, unaccountedReady, readyUnstartedText, READY_REBOOK_MARK } from "./cycle/movement.js";
import { runStats, runsOfMilestones, wakesDidSomething } from "./runStats.js";
import { activeSeries, BUCKETS, dayBounds, localDay, validTimeZone } from "./activeAgents.js";
import { createMovement } from "./cycle/movementRoutes.js";
import { createIdleWatch } from "./cycle/wheelIdle.js";
import { currentStateFor, doctrineFor, docTitleFor, dodFor, invalidateSpines, outcomeFor, softSpines, SPINES_TIMEOUT_MS, type SpinesJson } from "./adapters/spines.js";
import { deriveVerdict, runCommitsLookup, type RunCommit } from "./adapters/outcome.js";
import { buildTree, subtree, treeTodoSection, type Tree } from "./adapters/tree.js";
import { DEFAULT_OWNER, ownerOf } from "./tenancy/owner.js";
import { activeGrantsFor } from "./cycle/grants.js";
import { hisViewsFor, workerBriefRules, type HisView } from "./cycle/prompts.js";
import { contextMissing, readTicketContext } from "./cycle/ticketContext.js";
import { readWhereWeAre, whereWeAreSection } from "./whereWeAre.js";
import { keyResultPlanText, planSection, readWheelPlan } from "./wheelPlan.js";
import { runStateFor } from "./cycle/runState.js";
import { readySteps, wakeEnding } from "./cycle/wakeEnding.js";
import { FAILED_WAKES_IN_A_ROW, failedWakesAction, failedWakesQuestion, openFailedWakesAsk, wakeStreak } from "./cycle/failedWakes.js";
import { repeatStreak } from "./cycle/repeat.js";
import { followUp } from "./cycle/followUp.js";
import { childEpicsFor, childReadyRows } from "./cycle/children.js";
import { textHash } from "./cycle/skipUnchanged.js";
import { listTemplates } from "./personaTemplates.js";
import { templateForWorkspace, workspaceOwner } from "./tenancy/workspaceText.js";
import { mountUnblockerStats } from "./cycle/unblockerStats.js";
import { mountWakeStats } from "./cycle/wakeStats.js";
import { ownerOnly as ownerOnlyAsk } from "./cycle/ownerOnly.js";
import { commentHash, evidenceHash, mountAskMemory, readAskMemory, rememberChecks, withCarriedChecks } from "./cycle/askMemory.js";
import { bindRubricRepo, mountRubric, rubricOfRun, rubricProblem, stampRubric } from "./cycle/rubric.js";
import { spinesRoutes, trackedIn } from "./routes/spines.js";
import { deriveMilestone, readConfigFromEnv, readRoutes, type ReadConfig } from "./routes/read.js";
import { createCycle, SETTLED_REASON, type CycleOptions, type RunState } from "./cycle/service.js";
import { mountCycle } from "./cycle/routes.js";
import { createDesk, migrateDesk } from "./desk/desk.js";
import { BIG_ROOTS_FILE, createTeamState, TEAM_REPO_DEFAULT, teamRepoWrites } from "./team/teamState.js";
import { createMilestoneRecord, RecordError } from "./team/milestoneRecord.js";
import { createPersonaRecord } from "./team/personaRecord.js";
import { createAssignmentRecord } from "./team/assignmentRecord.js";
import { packIntakeRunner } from "./desk/packIntake.js";
import { mountDesk } from "./desk/routes.js";
import { deliveryFor } from "./desk/delivery.js";
import { createRepoIndex, type RepoScan } from "./desk/repoIndex.js";
import { createMilestoneChats, spinesBindRunner } from "./desk/milestoneChat.js";
import { sinceBlock } from "./desk/since.js";
import { mountChatScope } from "./desk/scope.js";
import { claimsFor, claimsSection, mountChatDispatch, rowClaimRefusal, rowOf } from "./desk/dispatch.js";
import { DEFAULT_MAX_WORKERS, NOTE_ACK_RULE, dispatchOrderSection, hasStandingDuty, noteAck, redFirstLine } from "./wakePrompt.js";
import { roomyMaxFromEnv } from "./cycle/workerRoom.js";
import { getWorkerLaunch } from "./cycle/workerLaunch.js";
import { readyRows } from "./adapters/nightQueue.js";
import { mountInbox } from "./inbox/routes.js";
import { mountBriefing } from "./briefing.js";
import { anthropicReworder, mountRedLineEdit, openAiReworder, type Reworder } from "./inbox/redLineEdit.js";
import { withCounts, objectiveOf, worldObjectiveDefs, worldObjectives, worldPriorities, worldRedLines } from "./inbox/jordiPriority.js";
import { readBuilding } from "./building.js";
import { repoKey } from "./adapters/repoNames.js";
import { createPursuits, effortForSpine, epicHeading, objectiveIds, priorityLines } from "./pursuits.js";
import { mapSection, productFor, readMaps, totemView } from "./totemMap.js";
import { createHomeTabs, readHomeFile, readHomeWheels } from "./homeFiles.js";
import { spawnHostStats } from "./spawnHost.js";
import { createPlacer } from "./homePlace.js";
import { wheelTrackers } from "./trackers.js";
import { readConsumption } from "./consumption.js";
import { isStepId, isStepLabel, labelEdit, PERSONA_LOG_LABELS, readPersonaLog } from "./personaLog.js";
import { hasOwnerPower } from "./auth/owner.js";
import { storePersonas, wheelReader } from "./wheel.js";
import { createProducts } from "./products.js";
import { createPriorityMode, epicOfRow, PRIORITY_BY, PRIORITY_CODE, type PriorityMode } from "./cycle/priorityMode.js";
import { mountPriority } from "./cycle/priorityRoutes.js";
import { mountPursuitWrites, withMilestones } from "./pursuitRoutes.js";
import { workspaceDataDir } from "./workspaceData.js";
import { DEFAULT_DM_CADENCE, deliveryManagerOf, isGap, isTestWorld, milestoneGaps, objectiveGaps, type ObjectiveIn } from "./personaGaps.js";
import { personaRows, standingRow, standingRowSection } from "./status/personaRows.js";
import { cardRepoOf, listCards as listTeamCards, mountTeamCards, parseDoc as parseTeamCards, TEAM_CARDS_FILE } from "./inbox/teamCards.js";
import { worldRepos } from "./worldRepos.js";
import { chatSection, inForceWords, readHisWords } from "./desk/hisObjectives.js";
import { campaignObjective, readPlot, readPursuits, readWheel, yourPartSection } from "./yourPart.js";
import { chaptersLine, keyResultLines, objectiveCards, objectivesBlock, objectivesOneLine, readChapters, readRedLines, type ObjectivesInput } from "./objectives.js";
import { inboxWarmHealth } from "./warmInbox.js";
import { keptJson, sendPrepared } from "./keptJson.js";
import { ticketIndex } from "./tickets/ticketIndex.js";
import { SCORECARD_DIR, type ScorecardsBody, applyLiveKeyResults, buildScorecards, createGreenHistory, createSpineFileReader, createWorkFinder } from "./scorecards.js";
import { createOneOffs } from "./oneOffs.js";
import { createOutcomes, mountOutcomes, outcomesIn, OutcomeError } from "./outcomes.js";
import { setOutcomeDefsDir } from "./outcomeDefs.js";
import { createAskLog, mountAskLog, type WaitingLike } from "./asks/askLog.js";
import { createPagesReader, mountPinnedAddresses, pinnedStatus } from "./pagesIndex.js";
import { mountPagePins } from "./pagePins.js";
import { mountAudioStore } from "./voice/audioStore.js";
import { createVoiceNotesReader } from "./voiceNotesIndex.js";
import { createXStatsReader } from "./xStats.js";
import { createPostStats } from "./postStats.js";
import { createLeases, mountClaims } from "./review/leases.js";
import { createCheckoutSync, mountCheckoutSync, type CheckoutSync } from "./status/checkoutSync.js";
import { createJobServers, mountJobServers, type JobServers } from "./status/jobServers.js";
import { createReview, liveCheckDepsFromEnv, mountReview, reviewItemsOf, runReview, type LiveCheckDeps } from "./review/review.js";
import { createAgentWake } from "./review/agentWake.js";
import type { PostReview } from "./review/postCards.js";
import { createWebPush, mountWebPush, vapidFromEnv, type PushTransport, type Vapid } from "./notify/webpush.js";
import { asksFrom, isTestItem, reviewNotices, teamLink, type Sender } from "./notify/notice.js";
import { addDecisionRow } from "./review/followups.js";
import { cachedSudoRead as sudoRead, secretSourceHealth } from "./secretCache.js";
import { readyAndReviewRows, type AskContext, type MemoryLookup, type VoiceNoteList } from "./plug/memory.js";
import { companyPathStaysOff, companyViewOn } from "./plug/companyView.js";
import { ensurePeople, mountPeople, mountPersonGate } from "./people/routes.js";
import { anthropicStructurer, createFeedback, mountFeedback, openAiStructurer, STRUCTURE_MODEL, type Structurer } from "./voiceFeedback.js";
import { anthropicJudge, openAiJudge, type Judge } from "./inbox/settles.js";
import { anthropicPairJudge, borderlinePairs, callOf, EPIC_JUDGE_SYSTEM, EPIC_SURE, epicMerged, judgePairs, MEANING_BORDER, MEANING_SURE, mergedPairs, startSameMeaningJudge, type PairJudge } from "./inbox/sameMeaning.js";
import { anthropicSpokenJudge, mountSpokenAnswers } from "./inbox/spokenAnswers.js";
import type { WaitingItem } from "./inbox/waiting.js";
import { anthropicStoreFile, ANTHROPIC_TEXT_MODEL, textModelProvider } from "./textModel.js";
import { anthropicQcJudge, mountQcJudge, type QcJudge } from "./review/qc.js";
import { secretFromFile } from "./auth/signedHook.js";
import { createTokenWatch, type TokenFile, type TokenWatch } from "./t3/tokenWatch.js";
import { mountPlugs, type BrowserOptions, type CreditNotice, type DiskWatch, type AskWorderShape, type HostedPlug, type PackCheck, type Notifier, type KeyResultNow, type WorldDesksArea, type MemoryArea } from "./plug/hosted.js";
import { hooks, openForJobs, registeredPlugs } from "./plug/hooks.js";
import type { SecretPut } from "./plug/keys.js";
import { askLine, raiseAsk, retireAsk, type RaiseDeps } from "./inbox/raise.js";
import { askGateProblem, heldAsksSection, staleAsksSection } from "./inbox/askGate.js";
import { heldToRoute, routedHeldSection, type HeldOfGoal } from "./inbox/heldRoute.js";
import { decideButtonsProblem } from "./inbox/decideChoices.js";
import { datedReport, heldWhat, monitorValue, monitorWhat, writeMonitoring } from "./repoState/monitoringLine.js";
import { carryNeedsJordi } from "./inbox/carry.js";
import { carryE62s8 } from "./repoState/carryE62s8.js";
import { createSpineWriter, type SpineWrite, type SpineWriter } from "./inbox/spineWrite.js";
import { groupEdits } from "./inbox/groupWrite.js";
import { cloneDirFor, createCloneWriter } from "./inbox/writeClone.js";
import { cardFromPresses, createPresses } from "./press/presses.js";
import { mountPresses, whoPressed, type PressWorker } from "./press/mount.js";
import { createAfterClose, mountAfterClose } from "./review/afterClose.js";
import { heldCard, heldRowBrief } from "./press/heldRow.js";
import { createSentBack, mountSentBack } from "./review/sentBack.js";
import { createPickup, PICKUP_TICK_MS, type Pickup } from "./review/pickup.js";
import type { WorkerLaunchInput } from "./cycle/workerLaunch.js";
import { computeReviewRows, rowClaimIn, TEST_REPO, TEST_ROW, type ReviewPayload } from "./review/rows.js";
import { createPressTest, PRESS_TEST_RUN, pressTestHome, type PressTest, type ListLeak } from "./press/dailyTest.js";
import { mountApprovals, wakeDeliveryManager } from "./approvals.js";
import { createSteps, keyInIndex, mountSteps } from "./steps/steps.js";
import { createDeskQuestions, deskQuestionsSection, mountDeskQuestions, type DeskQuestions } from "./steps/deskQuestions.js";
import { stepVoicePage } from "./steps/stepVoice.js";
import { mountStepsView } from "./steps/stepView.js";
import { secureDeep, setSecurePages } from "./steps/secureLinks.js";
import { KEEP_JS } from "./voice/keepJs.js";
import { copyPasteInText, copyPasteProblem } from "./steps/copyPaste.js";
import { alertReasons, askLookupIn, askRefs, monitorAlerts, monitorAlertSection, refKey, worldHost } from "./status/monitorAlert.js";
import { askedNoRowFor, askedNoRowSection, dedupeAsked, mountAskedNoRow, subtree as spineSubtree, type AskedNoRow } from "./status/askedNoRow.js";
import { gitRun, mountOrphanCommits, orphanCommitsIn, orphanSection, sinceFor, type OrphanCommit } from "./status/orphanCommits.js";
import { cliRunner, libraryRepo, mountTeamSkills, readLibrary, readWorldSkills, wakeSkillCheck, type CliRun, type WorldSkillsOf } from "./teamSkills.js";
import { threadRefusal, worldOfAssignment, worldOfRun } from "./cycle/threadBinding.js";
import { citedAskCodes, isDeliveryManager, managerState, isUnblocker, parseAsks, unblockerChecksProblem } from "./inbox/asks.js";
import { answeredReferences, isDm, waitingAndDefects, waitingAndHeld, waitingOnJordi, type WaitingDeps } from "./inbox/waiting.js";
import { releaseHeld } from "./cycle/held.js";
import { createUsageCollector, type UsageOptions } from "./usage/collector.js";
import { createStatus, mountStatus, coverOfIn, statusRows } from "./status/routes.js";
import { createAlertHandBack } from "./status/alertHandBack.js";
import type { PendingItem } from "./status/compute.js";
import { ANSWER_IN_WORDS, askButtons, goalLabel, reviewButtons, type InboxCard, type ObjectiveCard } from "./voice/inbox.js";
import { worldCallContext } from "./voice/worldContext.js";
import { createInboxSearch, SEARCH_MAX_CHARS } from "./inbox/search.js";
import { mountAlertActions } from "./status/alertActions.js";
import { mountMorningRead } from "./desk/morning.js";
import { asksForSettle, deskOnly, mountMark, notJordi, SETTLE_OK, SETTLE_REFUSED } from "./status/mark.js";
import { mountStamp } from "./status/stamp.js";
import { mountTreeAdd } from "./status/add.js";
import { createTicketSessions, migrateTicketSessions, mountTicketSessions } from "./tickets/sessions.js";
import { selfReadied } from "./cycle/selfReady.js";
import { readyToMarkOf } from "./status/autoSettle.js";
import { redCount } from "./status/compute.js";
import { mountUsage, runLiveUsageLookup, runUsageLookup } from "./usage/routes.js";
import { mountFreshness, type FreshnessMount } from "./routes/freshness.js";
import { createNewAskWaker, defaultCadenceFor, gitAuthorRun, type NewAskWaker } from "./cycle/newAskWake.js";
import { gitOut, headKeptLog } from "./freshness.js";
import { connectedRepo, mountWorldRepo, worldRepoDir } from "./tenancy/worldRepo.js";
import { createBook, bookStore, followBook, BOOK_TTL_MS } from "./book/service.js";
import { indexerLimitsFromEnv, launchIndexer, type IndexerHandle, type IndexerLaunchMode } from "./indexer/launch.js";
import { ensureIndexerTables, indexerBeat, kvAt, kvSet, sendToIndexer } from "./indexer/queue.js";
import { persistedSpinesRunner } from "./indexer/spinesCache.js";
import { slimBook, type Book, type BookEpic } from "./book/build.js";
import { milestoneBook } from "./book/milestone.js";
import { bookUrls, bookWithChecks, createLinkChecker, type Fetcher } from "./book/links.js";
import { createBookRefresh, realProbe, REFRESH_HOUR_UTC, type ProbeRunner } from "./book/refresh.js";
import { readBigRocks, BIG_ROCKS_FILE } from "./deck/bigRocks.js";
import { arcFor, readArcs } from "./deck/arcs.js";
import { deckList, epicDeck, findEpic, deckCode, deckHref, type DeckRef, type DeckTrendPoint, type EpicDeck } from "./deck/build.js";
import { createDeckNotify, DECK_UPDATES_FILE, type DeckNotify } from "./deck/notify.js";
import { deckWorkers, rocksAbout, utcHourText, type DeckAbout } from "./deck/about.js";
import { createRepoPuller, gitRunner, type PullResult } from "./cycle/repoPull.js";
import { mountProviders } from "./providers/routes.js";
import { noticeRef, parseNoticeRef } from "./plug/marks.js";
import { ensureAuth } from "./auth/schema.js";
import { authModeFromEnv, credentialWorld, currentAuth, outsideRequest, runWithAuth, type AuthMode } from "./auth/identity.js";
import { customerHosts, mountAuth, requestHost, socialHosts } from "./auth/gate.js";
import { mountOAuth, storeCreds } from "./auth/oauth.js";
import { mountWorldGithub } from "./tenancy/worldGithub.js";
import { socialHead, TEAM_HEAD } from "./brand.js";
import { requestScopedStore } from "./auth/scopedStore.js";
import { createAttachments, mountAttachments } from "./desk/attachments.js";
import { createVoiceNoteRelay, defaultMemoryHookSecretFile, mountVoiceHook, mountVoiceNotes, TRANSCRIPT_MAX, voiceNoteMessage } from "./desk/voiceNotes.js";
import { byMilestonePriority, byObjective, storeRanks, worldRanks } from "./inbox/priority.js";
import { createAfterCall } from "./voice/afterCall.js";
import { CALL_TRANSCRIPT_HEAD, createVoice, VoiceError, INBOX_TOOLS, OBJECTIVE_TOOLS, OPENING_LINE, PRESS_TOOL, VOICE_TOOLS, voiceInstructions, openAiMinter, openAiStoreFile, quickStatusText, type DeskPort, type Minter, type Voice } from "./voice/voice.js";
import { mountCampaignVoice, mountCoachVoice, mountOwnCall, mountVoice, mountWorldDeskVoice } from "./voice/routes.js";
import { elevenlabsTranscriber, localTranscriber, mountTranscription, pickedTranscriber } from "./voice/transcription.js";
import { elevenCalls, type ElevenCalls } from "./voice/elevenAgent.js";
import { mountReplyVoice } from "./voice/speak.js";
import { mountListenPage, mountReplyNote } from "./voice/replyNote.js";
import { BRIEFING_AGENT_NAME, BRIEFING_GREETING, BRIEFING_PAGE, BRIEFING_TOOLS, briefingInstructions, briefingKnows, briefingNoteText, briefingSince } from "./voice/briefing.js";
import { marketingAgentName, marketingBrief, MARKETING_GREETING, MARKETING_PAGE, MARKETING_TOOLS, marketingInstructions, marketingKnows, marketingNoteText, marketingRelayIn } from "./voice/marketing.js";
import { strategyAgentName, strategyBrief, STRATEGY_GREETING, STRATEGY_PAGE, STRATEGY_TOOLS, strategyInstructions, strategyKnows, strategyNoteText, teamProduct } from "./voice/teamStrategy.js";
import { COACH_AGENT_NAME, COACH_GREETING, COACH_PAGE, COACH_TOOLS, coachInstructions, coachKnows, relayIn, teamRelayText } from "./voice/coach.js";
import { anthropicSpillJudge, createVoiceSpill, openAiSpillJudge, type SpillAcross, type SpillJudge, type VoiceSpill } from "./voice/spill.js";
import { anthropicCrossJudge, createDeskCross, openAiCrossJudge, parsePairs, productWork, type CrossJudge, type DeskCross } from "./voice/cross.js";
import { anthropicTouchConfirm, anthropicTouchJudge, createNoteTouch, isTyped, openAiTouchConfirm, openAiTouchJudge, TOUCH_GRACE_MS, type NoteTouch, type TouchCard, type TouchConfirm, type TouchJudge } from "./voice/touch.js";
import { addMarks } from "./review/noteMarks.js";
import { createVoiceNotes, DELIVER_WINDOW_MS, geminiTranscriber, mountVoiceNotesRec, voiceSendHealth, type Transcriber, type VoiceNote, type VoiceNotes } from "./voice/notes.js";
import { writeUndeliveredNote } from "./voice/undeliveredNote.js";
import { campaignQuickStatus, milestoneInstructions, milestoneTools } from "./voice/milestoneCall.js";
import { createChatUnread } from "./desk/unread.js";
import { DeskError, TEAM_KEY, type DeskMessage } from "./desk/session.js";
import { mountCounts } from "./counts.js";
import { deskInboxSection, mountDeskInbox, readInbox, urgentOpenNotes } from "./desk/inbox.js";
import { deskNoteLines, serverWheelReader, wheelFaults } from "./cycle/wakeNews.js";
import { createNoteCross, type NoteCross } from "./desk/noteCross.js";
import { citeOf, handImprovement, improvementsOutSection, improvementsTakenSection, resolveImprovementTarget, type WorldRow } from "./inbox/improvement.js";
import { bookBrief, briefing, treeBrief, type TreeEntry } from "./voice/brief.js";
import { ownerOfPath } from "./auth/routeScope.js";
import { ensureWorldStamps, milestoneWorld, mountWorldFilters, repoWorlds } from "./tenancy/world.js";
import { worldClaims } from "./tenancy/repoScope.js";
import { configureRepoScope, milestoneRepoRefusal } from "./tenancy/repoScope.js";
import { createSpineReads } from "./spineReads.js";
import { createMilestoneInfoMemo } from "./milestoneList.js";
import { treeOff, type TreeOff } from "./adapters/treeOff.js";
import { createReadModelHost, type ReadModelHost } from "./readModel/host.js";
import { driftLine, type DriftResult } from "./readModel/drift.js";
import type { AnswerJobs } from "./inbox/answerJobs.js";
import { viewWaiting, computeWaiting, computeStatus, type WaitingPayload } from "./readModel/views.js";
import { sameRepo } from "./adapters/repoNames.js";
import { homeRepo, homeWorld, type HostId, keyFile, mainHost, memoryName, ownerName, ownerPattern, sites as siteConfig, socialProduct, socialWorld, workerHost } from "./identity.js";
import { identityIndex, originFile } from "./identityPage.js";
import { chatCopyMessages, createRequestRows, hisMessages, requestsIn } from "./desk/requests.js";
import { saidInAny, saidRequest, saidWords } from "./desk/said.js";

/** an API request slower than this is logged (the bar Blocked on you is held to). */
export const SLOW_REQUEST_MS = 1_000;
/**
 * the path a slow request line names, plus a chat read's `before` and `limit` (an older page and the newest
 * messages share one path, and only the query tells them apart). No other query value is logged (it may hold a token).
 */
export function slowPath(u: URL): string {
  const keep = ["before", "limit"].filter((k) => u.searchParams.has(k)).map((k) => `${k}=${encodeURIComponent(u.searchParams.get(k)!.slice(0, 12))}`);
  return keep.length && /\/(desk|chat)\/messages$/.test(u.pathname) ? `${u.pathname}?${keep.join("&")}` : u.pathname;
}

/** the owner's own milestone Call (voice/milestoneCall.ts): also what a one-team console's every Call reads. */
const MILESTONE_CALL = { instructions: (n: string) => milestoneInstructions(n), tools: (n?: string) => milestoneTools(n ?? "") };

/** the one-team core has no memory service (the services plug reads the memory service). */
const NO_MEMORY = "this console has no memory service (the services plug)";

/** the one-team core has the Team desk only: every world desk call answers 404 (the tenancy plug makes them). */
const ONE_TEAM_DESKS: WorldDesksArea = {
  chatFor: () => {
    throw new DeskError(404, "not_found", "this console has one team: no world desks");
  },
  view: async () => {
    throw new DeskError(404, "not_found", "this console has one team: no world desks");
  },
  send: async () => {
    throw new DeskError(404, "not_found", "this console has one team: no world desks");
  },
  tick: async () => undefined,
  runHeader: (w) => `world-desk:${w}`,
  bearer: () => "",
  mount: () => undefined,
};

class ApiError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 422 | 502,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

async function body<T extends ZodSchema>(c: Context, schema: T, fill?: (raw: unknown) => unknown): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, "invalid_json", "request body must be valid JSON");
  }
  if (fill) raw = fill(raw);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ApiError(400, "validation_error", "invalid request body", parsed.error.issues);
  return parsed.data;
}

/** ?includeSettled=true|1 (default false) shows settled milestones in list endpoints. */
const includeSettled = (c: Context) => ["true", "1"].includes(c.req.query("includeSettled") ?? "");
/** the repo whose root spine is the Team desk's Epic Book (the desk call's book brief). */
const DESK_BOOK_REPO = homeRepo();

function found<T>(v: T | undefined, what: string, id: string): T {
  if (v === undefined) throw new ApiError(404, "not_found", `${what} ${id} not found`);
  return v;
}

/** icon path → the social product's file (web/public), served on the social hosts. */
export const SOCIAL_ICONS: Record<string, string> = {
  "/favicon.svg": "favicon-social.svg",
  "/favicon.ico": "icon-social-192.png",
  "/apple-touch-icon.png": "apple-touch-icon-social.png",
  "/icon-192.png": "icon-social-192.png",
  "/icon-512.png": "icon-social-512.png",
  // logo C's 16/32 px tab icons and the 1200x630 share image
  "/favicon-16.png": "favicon-16-social.png",
  "/favicon-32.png": "favicon-32-social.png",
  "/og-image.png": "og-image-social.png",
  // the home-screen app's name and icons
  "/manifest.webmanifest": "manifest-social.webmanifest",
};

/** a static file read once per (path, mtime, size), with its gzip (text types over 1 kB) and an ETag. */
const staticFiles = new Map<string, { key: string; raw: Buffer; gzip?: Buffer; br?: Buffer; etag: string }>();
function staticFile(file: string): { raw: Buffer; gzip?: Buffer; br?: Buffer; etag: string } {
  const st = fs.statSync(file);
  const key = `${st.mtimeMs}:${st.size}`;
  const have = staticFiles.get(file);
  if (have?.key === key) return have;
  const raw = fs.readFileSync(file);
  const text = /\.(?:html|js|mjs|css|json|svg|txt|webmanifest)$/.test(file);
  // The build writes a brotli copy beside each hashed script and style (<file>.br, best quality, made once on
  // the build host, ~16% smaller than gzip); served to browsers that accept br, never compressed here at run time.
  const brFile = `${file}.br`;
  const br = text && fs.existsSync(brFile) ? fs.readFileSync(brFile) : undefined;
  const out = { key, raw, ...(text && raw.length > 1024 ? { gzip: zlib.gzipSync(raw, { level: 6 }) } : {}), ...(br ? { br } : {}), etag: `"${createHash("sha1").update(raw).digest("base64url").slice(0, 20)}"` };
  staticFiles.set(file, out);
  return out;
}

/** index.html with the social product's head, made once per index version (same caching as the file it comes from). */
const socialIndexes = new Map<string, { raw: Buffer; gzip?: Buffer; etag: string }>();
function socialIndex(f: { raw: Buffer; etag: string }): { raw: Buffer; gzip?: Buffer; etag: string } {
  const have = socialIndexes.get(f.etag);
  if (have) return have;
  const raw = Buffer.from(socialHead(f.raw.toString("utf8")));
  const out = { raw, ...(raw.length > 1024 ? { gzip: zlib.gzipSync(raw, { level: 6 }) } : {}), etag: `"${createHash("sha1").update(raw).digest("base64url").slice(0, 20)}"` };
  socialIndexes.clear();
  socialIndexes.set(f.etag, out);
  return out;
}

function contentType(file: string): string {
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
    ".webmanifest": "application/manifest+json",
  };
  return types[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

/** The credit account's key for the Claude text calls: the store file, never a generic ANTHROPIC_API_KEY from the unit's env. */
const anthropicKey = async () => process.env.CONSOLE_ANTHROPIC_API_KEY || (await sudoRead(anthropicStoreFile()));

export function createApp(
  db: DB,
  opts: { /** the hosted layer's plugs (default hostedFromEnv: ours, none with CONSOLE_ONE_TEAM=1). */ hosted?: readonly HostedPlug[]; staticDir?: string; /** the landing reports' folder (default docs/landing in the code repo checkout). */ landingDir?: string; read?: ReadConfig; cycle?: CycleOptions; browser?: BrowserOptions;
    /** tester worlds' own Team Browser instances (tests fake the runner); default from env, off unless CONSOLE_BROWSER_INSTANCES=on. */ browserInstances?: { enabled?: boolean; [k: string]: unknown };
    /** `secret put` runner (tests fake it). */ secretPut?: SecretPut;
    /** Secrets page sources (tests point them at fixtures; the secrets plug reads them). */ secrets?: { put?: SecretPut; [k: string]: unknown };
    /** token usage per run (no scanner = nothing collected); sweepMs starts the periodic sweep. */ usage?: UsageOptions & { sweepMs?: number; /** live read of running runs every liveMs (0/unset = off) */ liveMs?: number };
    /** source freshness (pull on open, ls-remote poll, Refresh); off unless enabled. */ freshness?: FreshnessMount;
    /** new ask wakes the Unblocker (on with the cycle; enabled: false turns it off; headWatchMs: watch HEAD of every checkout). */
    /** the lease sweep (an expired claim gives its row back to ready); 0 / absent = off (tests). */
    leases?: { everyMs?: number };
    /** the red line rewording from his words (tests pass their own; default the console's text model). */
    redLineReword?: Reworder;
    /** the card quality check's model (tests pass a fake). */
    qcJudge?: QcJudge;
    /** compare every tracked checkout with origin/main this often; out of sync over 5 min alerts. 0 / absent = off (tests). */
    checkoutSync?: { everyMs?: number; afterMs?: number; /** self-healing pull of a checkout left behind (default on) */ heal?: false };
    /** the worker server's home volume free space (`df` over the worker server ssh); no probe = off. */
    hostDisk?: { everyMs?: number; probe?: () => Promise<string>; minFreePct?: number };
    /** the worker server's CPU, load and memory for the Hosts page's caps (sshHostLoad). */
    hostLoad?: { probe?: () => Promise<string> };
    /** job servers' records from box/provision.py (status lines, alerts, spend) in `dir`; no dir = off. */
    jobServers?: { everyMs?: number; dir?: string };
    /**
     * the T3 MCP tokens' expiry (warn WARN_DAYS before) and any 401 from T3, at /api/health `t3Tokens`. Files:
     * `files`, else every host's `token_file` in the hosts table. Absent = off (tests).
     */
    t3Tokens?: { everyMs?: number; files?: () => TokenFile[] };
    /** the review gate sweep (rows that are not cards wake their Delivery manager once); 0 / absent = off (tests). */
    reviewGate?: { everyMs?: number; closeEveryMs?: number };
    newAskWake?: { enabled?: boolean; debounceMs?: number; headWatchMs?: number; git?: (dir: string, args: string[]) => Promise<string>; pull?: (dir: string) => Promise<unknown> };
    /** desk background pass (endpoint-list update, delivered notes) every this many ms; off unless set. */ deskTickMs?: number;
    /** the Company view's uptime checks (each company's ops sites and EpicBooks); period, 0 / absent = off (tests). */
    uptimeProbe?: { everyMs?: number };
    /** the social product KPI recorder (data/kpi-daily.md in each social repo, once per UTC day); check period, 0 / absent = off (tests, staging). */ kpiRecord?: { everyMs?: number };
    /** the launch board, run from the code repo checkout (tests fake `run`); everyMs 0 / absent = no timer (it still runs on the first read). */
    launchBoard?: { everyMs?: number; run?: () => Promise<string>; cacheFile?: string };
    /** reads GitHub's daily views of the public code page (gh api); absent = off (tests). */
    siteCodeViews?: ((repo: string) => Promise<{ date: string; count: number }[]>) | null;
    /** reads GitHub's referring sites of the public code page (gh api), for backlinks; absent = off (tests). */
    siteReferrers?: ((repo: string) => Promise<string[]>) | null;
    /** the owner's team state repo (CONSOLE_TEAM_REPO checkout, default `team`): sync period (unset = no timer; writes on a big-root change still happen). */ teamState?: { repo?: string; everyMs?: number; /** May this boot commit and push to the team repo (default teamRepoWrites(process.env)). */ write?: boolean };
    /** the desk's repo index: per-host scanner (none = rows stay as stored) and refresh period (unset = no background refresh). */ repoIndex?: { scan?: RepoScan; everyMs?: number };
    /** stall watch: real Run nows only when enabled (CONSOLE_STALL_WATCH=on) and the cycle is on; dry list always. */ stallWatch?: { enabled: boolean; everyMs?: number };
    /**
     * a passive console on a database another console owns (shared staging): it reads the stored views and never
     * resumes the owner's work at boot (answer jobs, the press outbox, the stall watch timer) or shares its T3 reads.
     */
    passive?: boolean;
    /** start each periodic job at its own phase (timerPhase.ts) so they never fire in the same second. */
    timerPhases?: boolean;
    /**
     * tenant scope of the store (CONSOLE_TENANT; unset = unscoped, today's behaviour). Only the store is scoped:
     * modules reading the db directly (inbox, desk, cycle side tables) stay global until S3 puts the session's tenant on
     * each request. Set to `the home world` it must answer exactly as unset while every row is the home world's.
     */ tenant?: string;
    /** milestone tree memo TTL in ms (CONSOLE_TREE_TTL_MS; 0 = no memo, no coalescing). */ treeTtlMs?: number;
    /** the goals list keeps each milestone's info and refreshes it in the background after this many ms (CONSOLE_MILESTONE_LIST_MS; 0 = off). */ milestoneListMs?: number;
    /** where trees are built off the loop (default: the console's tree worker, when its bundle is there). */ treeOff?: TreeOff;
    /**
     * read model: waiting-on-you lists and statuses served from console.db, kept current off the request path.
     * `worker` (index.ts; needs dbPath) | `in-process` (tests) | `none` (default here and CONSOLE_READ_MODEL=off: computed per request as before).
     */
    /**
     * spines.py, the read model's refresher and the Epic Book's build run in the indexer, a
     * separate niced, CPU-capped process this console starts (indexer/launch.ts; `unit` = a systemd user unit, `child` =
     * a child process); the console only reads their results from console.db. Needs readModel.dbPath. Unset = in process.
     */
    /** E948-S206: the pair judge (tests); unset = Claude Haiku on the console's key. */
    sameMeaningJudge?: PairJudge;
    /** E948-S206 round 3: the judge of two cards of one epic (tests pass their own). */
    sameSubjectJudge?: PairJudge;
    indexer?: { mode: IndexerLaunchMode; port: string | number; revision?: string; onLaunched?: (h: IndexerHandle) => void };
    readModel?: {
      mode?: "worker" | "in-process" | "none";
      dbPath?: string;
      tickMs?: number;
      patchTtlMs?: number;
      onHost?: (h: ReadModelHost) => void;
      /** drift check (readModel/drift.ts): period (unset/0 = off), first run, confirm wait; `alert` sends the owner a WhatsApp on drift. */
      drift?: { everyMs?: number; firstAfterMs?: number; confirmAfterMs?: number; alert?: boolean };
    };
    /**
     * answers: `ack` saved (index.ts: reply once stored, the spine write and wake run after) | done (default: the
     * reply waits for them); retryMs = the job's pauses between tries; onJobs hands the job runner to index.ts (drain on SIGTERM).
     */
    answers?: { ack?: "saved" | "done"; retryMs?: number[]; onJobs?: (j: AnswerJobs) => void };
    /** one answer closes many (inbox/settles.ts): true = with the OpenAI model check; a judge for tests; absent = off. */
    settle?: boolean | { judge?: Judge };
    /** many humans (people/): the time-limit sweep every tickMs (0 or unset = only on the owner's request). */
    people?: { tickMs?: number };
    /**
     * a voice note filed on one item (a card's box, a slide's note, a milestone chat) is read by a small model, and
     * what it says beyond that item goes to the world's Team desk as one line (voice/spill.ts). true = the OpenAI model check;
     * a judge (and timer) for tests; absent = off. Needs the cycle (the desk thread) to tell anything.
     */
    voiceSpill?: boolean | { judge?: SpillJudge; sweepMs?: number };
    /**
     * the owner's message to one desk (EpicTeam's Team desk, the social product's world desk) is read by a small model, and the
     * part that belongs to the other desk crosses at once as one message quoting him (voice/cross.ts). true = the OpenAI model
     * check and CONSOLE_DESK_PAIRS; a judge, pairs and timer for tests; absent = off. Needs the cycle (the desk threads).
     * that automatic part runs only with `auto: true` (CONSOLE_DESK_CROSS=1, on the owner's word); otherwise the
     * Team desk passes a part itself through POST /api/desk/pass (the relay).
     */
    deskCross?: boolean | { judge?: CrossJudge; sweepMs?: number; pairs?: string; auto?: boolean };
    /**
     * a long note of the owner's (WhatsApp, the Team desk's Chat, a card's box) is read by a small model next to the
     * cards in his inbox; each card it touches is marked updated or stale in its spine and its owner is woken with his words
     * (voice/touch.ts). true = the console's text model; a judge for tests; absent = off. Wakes and the desk line need the cycle.
     */
    noteTouch?: boolean | { judge?: TouchJudge; confirm?: TouchConfirm; graceMs?: number };
    /**
     * the press log and outbox (press/). tickMs: how often the worker retries presses not landed yet (0 or unset =
     * no timer; tests call the worker); retryMs / giveUpMs: its backoff; onWorker hands the worker to index.ts / tests.
     */
    presses?: { tickMs?: number; retryMs?: number[]; giveUpMs?: number; /** how often a kept press is tried (tests) */ heldRetryMs?: number; onWorker?: (w: PressWorker) => void; answerFirst?: boolean };
    /**
     * press writes commit in the console's checkout and push in the background (retried; a commit that cannot be
     * rebased puts its presses back in the outbox), and skip the hooks after an in-process secret check. Off in tests by
     * default; production turns it on unless CONSOLE_PUSH_BACKGROUND=0 (index.ts).
     */
    backgroundPush?: boolean;
    /** the daily press test: tick period (0/absent = no timer; index.ts sets it), the TEST repo, and fakes for tests. */
    pressTest?: { tickMs?: number; repo?: string; now?: () => number; pollMs?: number; landingLimitMs?: number; recheckMs?: number; sleep?: (ms: number) => Promise<void> };
    /**
     * spine writes go through the console's own clone of each checkout (inbox/writeClone.ts) under
     * `root`; unset = the shared checkout as before (tests, and CONSOLE_WRITE_CLONE=off in index.ts).
     */
    writeClones?: { root: string; enabled?: boolean };
    /** CONSOLE_AUTH off (default) | shadow | on (D12); see auth/identity.ts. */ auth?: AuthMode;
    /** master key file of the world secret stores (CONSOLE_WORLD_SECRETS_KEY; tests use a temp file). */ worldSecretsKey?: string;
    /** the run-end pack check (tests fake it; default runs `pack.py validate` over the run's commits). */ packCheck?: PackCheck;
    /**
     * Team services (the services plug, hosted/services.ts): the Gmail backend and the status probes, the memory service
     * entry reader, its voice-note lister, the mailbox user, poll period and secret store (tests fake them).
     */
    mcp?: { memoryLookup?: MemoryLookup; voiceNoteList?: VoiceNoteList; mailTickMs?: number; [k: string]: unknown };
    /** Epic Book: rebuild age (ms), git runner (tests fake it), and a background build at start (index.ts). */
    book?: { ttlMs?: number; git?: (dir: string, args: string[]) => Promise<string>; prewarmAfterMs?: number; tickMs?: number };
    /** warm the milestone trees this long after the start (index.ts sets it; absent = no warm-up); onDone for tests and the log. */
    /** `after`: start only once it settles (index.ts passes the inbox warm-up, so the owner's first reads come first). */
    /** `gapMs`: a pause between two milestones, so requests waiting meanwhile are answered first. */
    warmTrees?: { afterMs?: number; gapMs?: number; after?: Promise<unknown>; onDone?: (r: { milestones: number; ms: number }) => void };
    /** how old a GET /moving-now answer may be (ms, default 10 s; 0 = built per request). */
    movingMemoMs?: number;
    /** the books' daily refresh: tick period (0/absent = no timer; index.ts sets it), probe and pull (tests fake them). */
    bookRefresh?: { tickMs?: number; probe?: ProbeRunner; pull?: (dir: string) => Promise<PullResult>; now?: () => number };
    /** compare the epic decks with docs/status/deck-updates.md every tickMs (0/absent = never, as in tests). */
    deckNotify?: { tickMs?: number; now?: () => number };
    /** check the books' deliverable links every tickMs (0/absent = never, as in tests); fetch is injectable. */
    linkCheck?: { tickMs?: number; fetch?: Fetcher };
    /** the fallback that picks up an answer of his nobody worked looks every this many ms (0 = off; default 5 min in production). */
    pickupMs?: number;
    /** review list: the live check (tests fake fetch/revision; default loopback for the console's own names + app/REVISION). */
    review?: { live?: LiveCheckDeps };
    /** how old the unread snapshot may get before a /counts read starts a new pass (default 20 s; tests 0). */
    chatUnread?: { staleMs?: number };
    /** WhatsApp alerts: tick period (0/absent = no timer; index.ts sets it), and a fake sender for tests. */
    whatsapp?: { tickMs?: number; sender?: () => Promise<Sender | undefined>; now?: () => Date; /** key-result check gap (default 10 min with tickMs, 0 = off). */ keyResultsMs?: number };
    /** phone notifications: the desk pass period (0/absent = no timer; index.ts sets it), and fakes for tests. */
    webPush?: { deskTickMs?: number; vapid?: () => Promise<Vapid | undefined>; transport?: (v: Vapid) => PushTransport; now?: () => Date; deskGraceMs?: number };
    /** poll the memory service for the owner's new voice notes and post them to the desk every this many ms (0/absent = no timer). */
    voiceNotes?: { tickMs?: number; now?: () => Date; hookSecret?: () => string | undefined; hookNowSec?: () => number; hookRetryMs?: number[] };
    /**
     * option A: Voice notes from the memory service per world (a hosted services module). `enabled` defaults to
     * the hosted module's own switch (off in production until the owner's yes), the memory service's URL and where it
     * delivers (the production site). Tests pass fetch, store and later.
     */
    /** Chat voice notes forwarded to the owner's the memory service (a hosted services module); off unless `enabled` (index.ts: not on staging or a dev copy). Tests pass fetch, join and later. */
    memoryForward?: { enabled?: boolean; tickMs?: number; memoryUrl?: string; fetch?: typeof fetch; join?: (files: string[], out: string) => Promise<void>; later?: (fn: () => Promise<unknown>) => void };
    memoryConnections?: { enabled?: () => boolean; memoryUrl?: string; hookBase?: string; fetch?: typeof fetch; now?: () => Date; later?: (fn: () => Promise<unknown>) => void };
    /** who words the memory service helper's answer (a hosted services module): true = the small model on the console's OpenAI key; a worder for tests; absent = the plain answer. */
    memoryAsk?: { worder?: AskWorderShape | true };
    /** Call the desk: the OpenAI client-key minter and the clock (tests fake both). */
    voice?: { mint?: Minter; /** the ElevenLabs Agents door (tests fake it; off in tests unless given). */ eleven?: ElevenCalls; /** the objectives coach's door (tests). */ coachEleven?: ElevenCalls; /** the briefing call's door (tests). */ briefingEleven?: ElevenCalls; /** the senior marketing call's door (tests). */ marketingEleven?: ElevenCalls; /** the team product's strategy call's door (tests). */ strategyEleven?: ElevenCalls; now?: () => number; /** how often ended calls are checked (0 = only by tests' tick). */ afterCallTickMs?: number; /** how often accepted voice notes not yet posted are finished again (0 = off; tests). */ resumeNotesMs?: number; /** rework: voice notes' transcriber and audio folder (tests). */ transcribe?: Transcriber; notesDir?: string; /** voice feedback's structurer (tests). */ structure?: Structurer; /** the reply voice (tests). */ speak?: Parameters<typeof mountReplyVoice>[1] };
    /** where chat attachments are kept (tests). */
    chatAttachmentsDir?: string;
    /**
     * team skills: the code repo checkout (default CONSOLE_TEAM_SKILLS_REPO, else the code repo under the repos root), the
     * `team-skills.py` runner (tests fake it) and the wake check (index.ts turns it on; off = the wake only lists the skills).
     */
    teamSkills?: { repoDir?: string; cli?: CliRun; wakeCheck?: boolean; syncHosts?: (HostId)[]; worker?: { ssh: string; sshKey?: string; knownHosts: string } } } = {},
) {
  const tenantScope = opts.tenant ?? (process.env.CONSOLE_TENANT || undefined);
  // one store object, scoped per request to the caller's world when CONSOLE_AUTH=on (auth/scopedStore.ts).
  const store = requestScopedStore(db, createStore(db, { tenant: tenantScope }));
  const read0 = opts.read ?? readConfigFromEnv();
  // with the indexer running, spines.py output comes from its cache in console.db (one read, parsed once per run).
  const indexer =
    opts.indexer && opts.readModel?.dbPath && read0.spines
      ? launchIndexer({
          mode: opts.indexer.mode,
          port: opts.indexer.port,
          limits: indexerLimitsFromEnv(),
          config: {
            dbPath: opts.readModel.dbPath,
            reposRoot: read0.reposRoot,
            ...(read0.skillDir ? { skillDir: read0.skillDir } : {}),
            ...(process.env.CONSOLE_SPINES_FIXTURE ? { spinesFixture: process.env.CONSOLE_SPINES_FIXTURE } : {}),
            ...(tenantScope ? { tenant: tenantScope } : {}),
            authOn: (opts.auth ?? authModeFromEnv()) === "on",
            ...(opts.teamState?.repo ? { teamRepo: opts.teamState.repo } : {}),
            ...(opts.indexer.revision ? { revision: opts.indexer.revision } : {}),
            ...(process.env.CONSOLE_BOOK_PREWARM === "0" ? { bookTickMs: 0 } : {}),
            ...(process.env.CONSOLE_SPINES_REMOTE ? { spinesRemote: process.env.CONSOLE_SPINES_REMOTE } : {}),
          },
        })
      : undefined;
  if (indexer) {
    ensureIndexerTables(db);
    opts.indexer?.onLaunched?.(indexer);
  }
  const indexerAlive = () => (indexerBeat(db)?.ageMs ?? Infinity) < 60_000;
  const read: ReadConfig = indexer && read0.spines ? { ...read0, spines: persistedSpinesRunner(db, { alive: indexerAlive, fallback: read0.spines }) } : read0;
  configureRepoScope(db, read.reposRoot); // world milestones resolve only to their world's own checkouts
  // the spine reads (spines.py view, trees, derived fields) live in spineReads.ts, shared with the read-model worker.
  // the console's trees are built in a worker thread (adapters/treeOff.ts), not on the request loop
  const treeWorker = opts.treeOff ?? treeOff();
  const reads = createSpineReads({ db, store, reposRoot: read.reposRoot, spines: read.spines, treeTtlMs: opts.treeTtlMs, treeOff: treeWorker });
  const { soft, spinesFor, locateDir, treeFor, docTitleOf, withDerived, withOutcome } = reads;
  // the goals list (GET /milestones) answers each milestone's last info at once and refreshes it off the request
  const listInfo = createMilestoneInfoMemo({
    compute: async (m: Milestone) => {
      const { doctrine: _d, ...out } = await withOutcome(m, 1_500);
      return out;
    },
    dirOf: locateDir,
    freshMs: opts.milestoneListMs ?? (process.env.CONSOLE_MILESTONE_LIST_MS ? Number(process.env.CONSOLE_MILESTONE_LIST_MS) : 10_000),
  });
  // a stopped monitor item's ask may sit in another world (a social world repo's Reddit waits on the code repo/): an unscoped read.
  const monitorAskLookup = askLookupIn(createStore(db, { tenant: tenantScope }), (m) => treeFor(m, 1_500), worldHost, (m) => resolveRepo(read.reposRoot, m.repo)?.name);
  /** the Delivery Manager's wake section for its milestone's stopped / overdue monitor items. */
  const monitorAlertsOf = async (m: Milestone): Promise<string | undefined> => {
    const info = await withOutcome(m, 1_500);
    const t = Date.now();
    const refs = (info.monitoring ?? []).filter((x) => alertReasons(x, t).why.length).flatMap(askRefs);
    const asks = refs.length ? await monitorAskLookup(m, refs).catch(() => undefined) : undefined;
    const sections = [
      monitorAlertSection(monitorAlerts(info.monitoring, t, (r) => asks?.get(refKey(r))), t),
      // the milestone's checkout has been out of sync with origin for over 5 min
      checkoutSync?.section(resolveRepo(read.reposRoot, m.repo)?.path),
      // the daily press test of the owner's buttons failed (the code repo's Delivery Manager)
      resolveRepo(read.reposRoot, m.repo)?.name === homeRepo() ? pressTest?.section() : undefined,
      // the worker server's home volume is under 15% free (the code repo's Delivery Manager)
      resolveRepo(read.reposRoot, m.repo)?.name === homeRepo() ? hostDisk?.section() : undefined,
    ].filter(Boolean);
    return sections.length ? sections.join("\n\n") : undefined;
  };
  // the read model (waiting-on-you lists and statuses kept in console.db by a background worker); set below.
  let readModel: ReadModelHost | undefined;
  let onDrift: ((r: DriftResult) => void) | undefined; // set once the WhatsApp notifier exists (below)
  /** A write to or pull of a checkout: drop its spines.py output and the memoized trees built from it. */
  const dropSpines = (dir: string) => {
    reads.drop(dir);
    listInfo.drop(dir);
    book?.invalidate();
    readModel?.dirty(dir);
    // the screens read tickets from the index: rebuild it for this checkout, then read again
    void ticketIndex().refresh(dir).then(() => readModel?.dirty(dir));
  };
  /**
   * a pull of a checkout (freshness poll, pull on open, Refresh, a run's end, a new-ask pull). Reads keep the
   * last spines.py output and trees while the new ones build in the background (spines.py for the code repo takes 13-23 s
   * on the main server, and the first read after a pull waited for it: 10 s). The console's own spine writes keep `dropSpines`.
   */
  const pulledSpines = (dir: string) => {
    reads.drop(dir, { stale: true });
    listInfo.drop(dir);
    book?.invalidate();
    readModel?.dirty(dir, { stale: true }); // a pull is re-read within the rescan gap
    void ticketIndex().refresh(dir).then(() => readModel?.dirty(dir, { stale: true }));
    const ranks = worldRanks(store, read.reposRoot);
    void reads
      .rewarm(dir, (ms) => [...ms].sort((a, b) => (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity)))
      .catch((e) => console.warn(`trees rewarm ${path.basename(dir)}: ${e instanceof Error ? e.message : e}`));
  };
  const book = !read.spines
    ? undefined
    : indexer
      ? followBook({ store: bookStore(db), ask: (rebuild) => sendToIndexer(db, { type: "book", ...(rebuild ? { rebuild: true } : {}) }) })
      : createBook({
        repos: () => listRepos(read.reposRoot),
        spines: read.spines,
        git: opts.book?.git ?? gitOut(30_000),
        ttlMs: opts.book?.ttlMs ?? (process.env.CONSOLE_BOOK_TTL_MS ? Number(process.env.CONSOLE_BOOK_TTL_MS) : BOOK_TTL_MS),
        store: bookStore(db), // rework: a restart serves the last book at once
      });
  const slims = new WeakMap<Book, Book>();
  const slimOf = (b: Book) => slims.get(b) ?? (slims.set(b, slimBook(b)), slims.get(b)!);
  if (book && opts.book?.prewarmAfterMs !== undefined) setTimeout(() => void book.prewarm(), opts.book.prewarmAfterMs).unref();
  if (book && opts.book?.tickMs) book.start(opts.book.tickMs); // rework: rebuilt on a spine/git change, read or not
  // does each deliverable in the books still answer? Checked in the background, never on a request.
  const links = book ? createLinkChecker(opts.linkCheck?.fetch ? { fetch: opts.linkCheck.fetch } : {}) : undefined;
  if (book && links && opts.linkCheck?.tickMs) {
    const checkLinks = () => {
      void book
        .get()
        .then((v) => (v.book ? links.run(bookUrls(v.book)) : 0))
        .catch(() => undefined);
    };
    setTimeout(checkLinks, Math.min(opts.linkCheck.tickMs, 60_000)).unref?.();
    setInterval(checkLinks, opts.linkCheck.tickMs).unref?.();
  }
  const runCommits = runCommitsLookup();
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof ApiError)
      return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status);
    if (err instanceof UnknownReference)
      return c.json({ error: { code: "unknown_reference", message: err.message } }, 400);
    if (err instanceof HTTPException) return c.json({ error: { code: "http_error", message: err.message } }, err.status);
    console.error(err);
    return c.json({ error: { code: "internal", message: "internal server error" } }, 500);
  });

  const api = new Hono();
  /** wake runs whose finish was refused once for ready rows with no worker or reason (in memory; a restart only re-refuses once). */
  const readyRefused = new Set<string>();
  // the Inbox's lists go out gzipped (1.78 MB of JSON took ~30 s on a throttled phone; ~10x smaller packed).
  // Registered first, so it is the outermost layer: every filter that rewrites a list's JSON runs inside it.
  const packed = compress();
  for (const p of INBOX_LISTS) api.get(p, packed);
  // every other JSON answer goes out with an ETag (an unchanged list is a 304 with no body) and gzipped: an owner's phone
  // on a slow relay link spent up to 30 s on the sidebar's 30 s re-reads (~920 KB a round) before this.
  api.use("*", leanJson());
  // login, sessions, agent tokens and the CONSOLE_AUTH gate, registered before every other route.
  ensureAuth(db);
  // worlds other than the home world (and the platform's own social world) wake no agent on a shared host.
  // a world whose wakes run on its own job servers (model A) is let through: its wakes never reach a shared host.
  const jobRoute = opts.cycle?.jobRoute ?? hooks.jobRoute(db);
  const worldHold = opts.cycle?.worldHold ?? openForJobs(hooks.worldWakeGate(), jobRoute);
  // an EpicTeam sign-up's billing state, known once the tester worlds are mounted below.
  let billingOf: ((world: string) => string | undefined) | undefined;
  const auth = mountAuth(app, api, { db, store, mode: opts.auth ?? authModeFromEnv(), worldHold, billingOf: (w) => billingOf?.(w) });
  // a login linked to a People handle (not the owner) reaches only its own inbox and goals.
  ensurePeople(db);
  mountPersonGate(app, { db, mode: opts.auth ?? authModeFromEnv() });
  // list filters by the caller's world for repo/thread/placement lists (before the routes they wrap).
  mountWorldFilters(api, { db, reposRoot: read.reposRoot, world: () => store.tenant });

  // every API request over 1 s is one journal line (path, status, ms): the console kept no request times, so
  // a "did not answer in 30 s" left nothing to read afterwards. Streams (events) are skipped.
  api.use("*", async (c, next) => {
    const t0 = performance.now();
    await next();
    const ms = Math.round(performance.now() - t0);
    if (ms > SLOW_REQUEST_MS && !c.res.headers.get("content-type")?.startsWith("text/event-stream"))
      console.warn(`slow request: ${c.req.method} ${slowPath(new URL(c.req.url))} ${c.res.status} ${ms} ms`);
  });
  // any write that went through re-checks the console rows the read model's lists read (cheap: a fingerprint).
  api.use("*", async (c, next) => {
    await next();
    if (c.req.method !== "GET" && c.res.status < 400) readModel?.dirty();
  });
  // every press on the owner's buttons is logged, and the review buttons are saved first and retried
  // until they land (press/mount.ts); before every route it wraps. The clone status is bound once the writer exists.
  const presses = createPresses(db, { ...(opts.presses?.retryMs ? { retryMs: opts.presses.retryMs } : {}), ...(opts.presses?.giveUpMs ? { giveUpMs: opts.presses.giveUpMs } : {}), ...(opts.presses?.heldRetryMs !== undefined ? { heldRetryMs: opts.presses.heldRetryMs } : {}) });
  let cloneStatus: () => unknown = () => ({ enabled: false });
  // set below once the spine writer (its background pushes) and the review list (a card's row) exist
  let pressPushes: import("./inbox/spineWrite.js").BackgroundPushes | undefined;
  let cardOfPress: ((id: string) => { repo: string; path: string; ref: string; title?: string; milestoneId?: string } | undefined) | undefined;
  let flagHeldRow: ((p: import("./press/presses.js").Press & { request?: import("./press/presses.js").PressRequest }) => Promise<string | undefined>) | undefined;
  const pressWorker = mountPresses(api, {
    db,
    presses,
    fetch: (req) => app.fetch(req),
    authMode: opts.auth ?? authModeFromEnv(),
    clones: () => ({ ...(cloneStatus() as object), ...(pressPushes ? { pushing: pressPushes.pending() } : {}) }),
    answerFirst: !!opts.presses?.answerFirst,
    pushes: () => pressPushes,
    cardOf: (id) => cardOfPress?.(id),
    // a press kept for a row read two ways wakes the row's owner the same minute, never only the repair timer
    onHeld: (p) => flagHeldRow?.(p),
  });
  // the world wake gate's on/off shows here so a check (deploy, regression) can confirm it without a login.
  // and the last read-model drift check (the cache rebuilt from the repo and compared): ok, when, how many views.
  // set below, once the WhatsApp alert path exists.
  let checkoutSync: CheckoutSync | undefined;
  /** the objectives' key results now (set where the Objectives page's scorecards are built). */
  let keyResultsNow: (() => Promise<KeyResultNow[]>) | undefined;
  // set once the objectives watch exists (below): the Delivery Manager wake reads its milestone's objectives.
  let objectivesOf: ((m: Milestone) => Promise<{ section?: string; idle: string[] }>) | undefined;
  // the owner's objectives block (objectives.ts), set below once the scorecards exist; every home-world wake opens with it.
  let ownerObjectivesNow: (() => Promise<{ block: string; line: string; chapters?: string }>) | undefined;
  // the same live objectives as nodes, for the Team desk's [his objectives] block (it follows the one list).
  let ownerObjectivesInput: (() => Promise<ObjectivesInput>) | undefined;
  // set below, once the WhatsApp alert path exists.
  let hostDisk: DiskWatch | undefined;
  // what an outside probe last said about the console's answer times (POST /health/answer-speed; off until one reports).
  let answerSpeed: { state: "off" | "ok" | "slow"; at?: string; since?: string; worstMs?: number; page?: string } = { state: "off" };
  let t3Tokens: TokenWatch | undefined;
  let jobServers: JobServers | undefined;
  // set below, once the review buttons and the spine writer exist.
  let pressTest: PressTest | undefined;
  // the hosted plugs mounted below (plug/hosted.ts); [] = the bare one-team core.
  let plugsMounted: string[] = [];
  const hostedPlugs = opts.hosted ?? registeredPlugs(); // the hosted layer's plugs ([] = the bare one-team core)
  api.get("/health", (c) => {
    const d = readModel?.drift();
    const drift = !readModel
      ? { state: "off" as const }
      : !d
        ? { state: "pending" as const }
        : { state: d.ok ? ("ok" as const) : d.error ? ("error" as const) : ("drift" as const), at: d.at, checked: d.checked, skipped: d.skipped, differ: d.differ.length, ms: d.ms };
    // today's presses and the failures of the last 24 h (details: /api/write-health)
    const h = presses.health(1);
    // `busy` = presses being written now plus due now, plus 1 while the daily press test runs (deploy.sh waits for
    // 0 before a restart, so a restart never cuts a press or the test's run in half)
    const b = pressWorker.busy();
    const testing = pressTest?.running() ? 1 : 0;
    const pressHealth = { today: h.today.presses, failedToday: h.today.failed, failed24h: h.failed24h, landing: h.pending.length, busy: b.inFlight + b.due + testing, answerFirst: !!opts.presses?.answerFirst };
    // the indexer's heartbeat (ok while it beat in the last minute).
    const beat = indexer ? indexerBeat(db) : undefined;
    const indexerHealth = !indexer
      ? { state: "off" as const }
      : !beat
        ? { state: "pending" as const, how: indexer.how }
        : { state: beat.ageMs < 60_000 ? ("ok" as const) : ("stale" as const), how: indexer.how, at: beat.at, pid: beat.pid, startedAt: beat.startedAt, repos: beat.repos, runs: beat.runs, seeded: beat.seeded, book: beat.book ?? null, scans: beat.scans ?? null, saved: beat.saved ?? null };
    return c.json({ ok: true, inboxWarm: inboxWarmHealth(), worldWakeGate: hooks.worldWakeGateState().on ? "on" : "off", drift, indexer: indexerHealth, checkoutSync: checkoutSync?.health() ?? { state: "off" }, presses: pressHealth, pressTest: pressTest?.health() ?? { state: "off" }, vps3Disk: hostDisk?.health() ?? { state: "off" }, answerSpeed, t3Tokens: t3Tokens?.health() ?? { state: "off" }, jobServers: jobServers?.health() ?? { state: "off" }, voiceSend: voiceSendHealth(db), box: process.env.CONSOLE_BOX === "1" ? { state: "on", team: process.env.CONSOLE_TENANT } : { state: "off" }, keys: secretSourceHealth(), spawnHost: spawnHostStats(), treeWorker: { state: treeWorker.available() ? "on" : "off", ...treeWorker.stats() }, plugs: plugsMounted }); // one-team mode; plugs
  });
  // the last drift check in full (which views differ, where, stored vs rebuilt).
  api.get("/read-model/drift", (c) => c.json({ last: readModel?.drift() ?? null }));
  // set once the cycle exists (below); every pull that moved a checkout tells it, so a new ask wakes the Unblocker.
  let newAsks: NewAskWaker | undefined;
  // set once the objectives caches exist (below): a pull of the workspace data repo drops them.
  let objectivesPulled: ((dir: string) => boolean) | undefined;
  // registered first so its pull-on-open middleware runs before the milestone routes below.
  mountFreshness(api, {
    ...opts.freshness,
    // a re-pull that lands only marks the trees stale (served until rebuilt), so opening a page starts it and
    // does not wait (it waited up to 3 s: House decision 3.0-4.5 s on each open after 60 s idle).
    reopenWaitMs: opts.freshness?.reopenWaitMs ?? 0,
    // with the read model, opening the waiting list starts the pull but never waits for it (the worker re-reads after).
    noWaitOn: () => !!readModel,
    store,
    reposRoot: read.reposRoot,
    treeFor: (m) => treeFor(m),
    invalidate: (dir) => {
      // the workspace data checkout holds no spines: only the objectives caches built from it are dropped
      if (objectivesPulled?.(dir)) return;
      pulledSpines(dir);
      newAsks?.repoMoved(dir);
    },
  });

  // cycle (T3 sync, run-now, wake, bootstrap). Off unless opts.cycle.enabled (CONSOLE_CYCLE_ENABLED).
  const cycleOpts = opts.cycle ?? { enabled: false, publicUrl: "http://127.0.0.1:8750" };
  const inboxDeps: WaitingDeps = { store, reposRoot: read.reposRoot, treeFor: (m) => treeFor(m, 1_500), homeThread: (id) => cycle.getLink(id)?.threadId, threadEnvironment: (t) => cycle.threadEnvironment(t), teamRepo: opts.teamState?.repo };
  const treeTodo = async (m: Milestone) => {
    try {
      if (!m.path) return undefined;
      const tree = await treeFor(m);
      // answers at canonical asks of other epics that this milestone's spines reference.
      const items = await waitingOnJordi(inboxDeps, { milestoneId: m.id }).catch(() => undefined);
      const referenced = items ? await answeredReferences(inboxDeps, m, items).catch(() => []) : [];
      // answers come from the spine only (its `[answered]` lines, in the tree); an answer the console could not
      // write is no answer here: the ask is still open in the spine (the owner's card shows the error and Retry).
      return treeTodoSection(tree, 30, referenced);
    } catch {
      return undefined; // the wake never fails on the tree
    }
  };
  // active standing approvals of the milestone (spines.py `grants`); none when spines.py is missing or slow.
  const grants = async (m: Milestone) => {
    const { rel, spines } = await spinesFor(m);
    return spines && rel ? activeGrantsFor(spines, rel) : [];
  };
  /** the spine's run_state; undefined when spines.py is missing, slow or older than the field (wake as before). */
  /** open Done-means lines in the milestone's runnable spines that no ledger row covers. */
  const askedOf = async (m: Milestone, softMs = 4_000): Promise<AskedNoRow[]> => {
    const { loc, rel, spines } = await spinesFor(m, softMs);
    return loc && rel && spines ? askedNoRowFor(m, loc.repo.path, rel, spines) : [];
  };
  /**
   * a repo's orphan commits belong to one milestone, its home: the one on the repo's root spine (`…/root.md`), else
   * the oldest. `ms` = the milestones of one world, unsettled and not paused. A milestone with a Delivery Manager
   * (on, or auto-parked) comes first, so the orphans reach a wake; a root spine also by its other names (`EPIC_SPINE.md`,
   * `-….md`, `EPIC.md`).
   */
  const orphanGit = gitRun(20_000);
  const hasDm = (m: Milestone) =>
    store.listAssignments({ milestoneId: m.id }).some((a) => (a.enabled || (!!a.parkedAt && a.parkedReason !== SETTLED_REASON)) && isDeliveryManager(store.getPersona(a.personaId)?.name));
  const orphansOf = async (ms: Milestone[]): Promise<OrphanCommit[]> => {
    const homes = new Map<string, { m: Milestone; dir: string; name: string }>();
    for (const m of ms) {
      const r = resolveRepo(read.reposRoot, m.repo);
      if (!r) continue;
      const had = homes.get(r.path);
      const rank = (x: Milestone) => (hasDm(x) ? 2 : 0) + (/(^|\/)(?:root|EPIC_SPINE|EPIC-0[\w-]*|EPIC0?)\.md$/i.test(x.path ?? "") ? 1 : 0);
      if (!had || rank(m) > rank(had.m)) homes.set(r.path, { m, dir: r.path, name: r.name });
    }
    const since = sinceFor(Date.now());
    const lists = await Promise.all(
      [...homes.values()].map(async (h) =>
        (await orphanCommitsIn(orphanGit, h.dir, since).catch(() => [])).map((c): OrphanCommit => ({
          milestoneId: h.m.id,
          milestoneTitle: h.m.title,
          repo: h.name,
          sha: c.sha,
          short: c.sha.slice(0, 7),
          author: c.author,
          date: c.date,
          subject: (c.message.split("\n")[0] ?? "").slice(0, 200),
        })),
      ),
    );
    return lists.flat();
  };
  const orphanMilestones = (world: string) => store.listMilestones().filter((m) => (store.worldOfMilestone?.(m.id) ?? DEFAULT_TENANT) === world && !m.paused);
  /**
   * the world's home goal, whose Delivery Manager takes the held asks other goals left (the overall check):
   * the console's own repo on its root spine first, then any root spine, then the oldest goal.
   */
  const heldHomeOf = (world: string): string | undefined => {
    const ms = orphanMilestones(world).filter((x) => !x.settledAt && x.repo);
    const root = (x: Milestone) => /(^|\/)root\.md$/i.test(x.path ?? "");
    const own = (x: Milestone) => resolveRepo(read.reposRoot, x.repo)?.name === homeRepo();
    return (ms.find((x) => own(x) && root(x)) ?? ms.find(root) ?? ms[0])?.id;
  };
  /** every goal's held asks in the world, with whether its own Delivery Manager is on, routed per heldToRoute. */
  const routedHeldOf = async (world: string) => {
    const home = heldHomeOf(world);
    if (!home) return [];
    const goals: HeldOfGoal[] = [];
    for (const g of orphanMilestones(world).filter((x) => !x.settledAt)) {
      const held = (await waitingAndHeld(inboxDeps, g).catch(() => ({ held: [] }))).held;
      if (!held.length) continue;
      const managerOn = managerState(store, g.id) === "on";
      goals.push({ milestoneId: g.id, title: g.title, managerOn, held });
    }
    return heldToRoute(goals, home);
  };
  /** the Delivery Manager's section on its repo's orphan commits (only the repo's home milestone gets it). */
  // the social skin is a hosted plug (hosted/social.ts): the pack export, the launch board, the Publisher's
  // pre-check and wake sections, the social routes, site numbers, campaigns; the one-team core has none of them.
  const socialArea = hostedPlugs.find((p) => p.social)?.social?.({ db, reposRoot: read.reposRoot, packRunner: read.packRunner });
  const agentTeamDir = () => resolveRepo(read.reposRoot, homeRepo())?.path;
  // the launch board inside the console (launch/board.ts): the script runs from the code repo's checkout.
  const launchBoard = socialArea?.launch({ run: opts.launchBoard?.run, cacheFile: opts.launchBoard?.cacheFile, everyMs: opts.launchBoard?.everyMs, teamDir: agentTeamDir });
  /**
   * reds with no open row go to the Delivery Manager whose milestone tree holds the owning epic, the smallest such
   * tree of the world's unpaused milestones on the same repo (so the root milestone does not repeat its children's).
   */
  const launchDraftsOf = async (m: Milestone): Promise<string | undefined> => {
    if (!launchBoard?.hasDrafts()) return undefined;
    const r = resolveRepo(read.reposRoot, m.repo);
    if (r?.name !== homeRepo()) return undefined;
    const treeOf = async (x: Milestone) => {
      const { rel, spines } = await spinesFor(x, 4_000).catch(() => ({}) as Awaited<ReturnType<typeof spinesFor>>);
      return rel && spines ? new Set(spineSubtree(spines, rel).map((n) => n.path)) : new Set<string>();
    };
    const mine = await treeOf(m);
    const others = await Promise.all(
      orphanMilestones(store.worldOfMilestone?.(m.id) ?? DEFAULT_TENANT)
        .filter((x) => x.id !== m.id && resolveRepo(read.reposRoot, x.repo)?.path === r.path)
        .map(treeOf),
    );
    return launchBoard.section(mine, (spine) => others.some((t) => t.has(spine) && t.size < mine.size));
  };
  const orphanSectionOf = async (m: Milestone): Promise<string | undefined> =>
    orphanSection((await orphansOf(orphanMilestones(store.worldOfMilestone?.(m.id) ?? DEFAULT_TENANT))).filter((c) => c.milestoneId === m.id));
  /**
   * the desk inbox section of a Delivery Manager wake: only the repo's home milestone in its world (the one on the
   * root spine, else the oldest, as orphan commits) reads `desk/inbox/` of its checkout, so one wake answers each note.
   */
  /** the Mac tickets' desk questions (made with the steps pages below; the wake reads it later). */
  let deskQs: DeskQuestions | undefined;
  /** the milestone's checkout when it is its repo's home milestone in its world (the one on the root spine, else the oldest). */
  const homeCheckoutOf = (m: Milestone) => {
    const r = resolveRepo(read.reposRoot, m.repo);
    if (!r) return undefined;
    const root = (x: Milestone) => /(^|\/)root\.md$/i.test(x.path ?? "");
    const world = store.worldOfMilestone?.(m.id) ?? DEFAULT_TENANT;
    const same = orphanMilestones(world).filter((x) => resolveRepo(read.reposRoot, x.repo)?.path === r.path);
    const home = same.find(root) ?? same[0];
    return home?.id === m.id ? r : undefined;
  };
  const serverWheel = serverWheelReader(process.env.CONSOLE_SERVER_WHEEL_URL ?? (siteConfig().serverWheelUrl || undefined));
  const deskInboxOf = async (m: Milestone): Promise<string | undefined> => {
    const r = homeCheckoutOf(m);
    if (!r) return undefined;
    const world = store.worldOfMilestone?.(m.id) ?? DEFAULT_TENANT;
    const notes = readInbox(r.path);
    // the improvement requests this world handed to others (their state read from each builder's inbox), and the
    // ones it took from others and has not told done yet.
    const out = improvementsOutSection(world, worldsWithHome().filter((w) => w.world !== world).flatMap((w) => readInbox(w.checkout).map((note) => ({ world: w.world, repo: w.name, note }))));
    const parts = [deskInboxSection(notes, r.name), improvementsTakenSection(notes), out].filter((x): x is string => !!x);
    return parts.length ? parts.join("\n\n") : undefined;
  };
  /** a world's home checkout (the milestone on a root spine, else its oldest), where its desk inbox is. */
  const worldHome = (world: string) => {
    // the world's own store: an answer job runs in the caller's request scope, where `store` sees only the caller's world
    const ms = forTenant(db, world).listMilestones().filter((x) => x.repo && !x.paused);
    const home = ms.find((x) => /(^|\/)root\.md$/i.test(x.path ?? "")) ?? ms[0];
    const r = home ? resolveRepo(read.reposRoot, home.repo) : undefined;
    return home && r ? { world, checkout: r.path, name: r.name, remote: r.remote, policyPath: home.path || "docs/spines/root.md" } : undefined;
  };
  const worldsWithHome = () =>
    (db.prepare("SELECT id FROM tenants").all() as { id: string }[]).map((t) => worldHome(t.id)).filter((x): x is NonNullable<ReturnType<typeof worldHome>> => !!x);
  const runState = async (m: Milestone): Promise<RunState | undefined> => {
    const { rel, spines } = await spinesFor(m);
    return spines && rel ? runStateFor(spines, rel) : undefined;
  };
  /** raw text of a spine line in the milestone's checkout ("" when unreadable). */
  const nonEmpty = <K extends string>(k: K, v: string) => (v ? ({ [k]: v } as Record<K, string>) : {});
  const askLineText = (m: Milestone, rel: string | undefined, line: number | undefined) => {
    const dir = rel && line !== undefined ? resolveRepo(read.reposRoot, m.repo)?.path : undefined;
    if (!dir) return "";
    try {
      return fs.readFileSync(path.join(dir, rel!), "utf8").split("\n")[line!] ?? "";
    } catch {
      return "";
    }
  };
  // usage per run, read from its transcript when the run ends (cycle hook below) and by a periodic sweep.
  // credits per world; each collected run is debited once at its provider's price (credits/ledger.ts).
  // the credits gate's owner notice is an ask in the held milestone's spine (inbox/raise.ts), taken out of the
  // spine when credits are back; nothing about it is stored as an ask in console.db. (Called at wake / release time, after
  // the spine writer below exists.)
  const creditNotice = (): CreditNotice => ({
    raise: async (m, t) => {
      const r = await raiseAsk(raiseDeps(), m, { question: t.question, proposedAction: t.proposedAction, askedBy: "the credits gate" });
      if (r.status !== "written") {
        console.warn(`credits notice ${m.id}: not written into the spine (${r.reason}); the held run says why the team paused`);
        return undefined;
      }
      return noticeRef(m.id, r.path, r.code);
    },
    retire: async (ref) => {
      const n = parseNoticeRef(ref);
      const m = n ? store.getMilestone(n.milestoneId) : undefined;
      if (!n || !m) return;
      const w = await retireAsk(raiseDeps(), m, n.path, n.code, "credits are back (top-up or grant); the team wakes again");
      if (w.status !== "written") console.warn(`credits notice ${n.code}: still in ${n.path} (${w.reason})`);
    },
  });
  // credits are the billing plug's (hosted/billing.ts); the one-team core charges nothing and holds no wake.
  const credits = hostedPlugs.find((p) => p.credits)?.credits?.({ db, store, notice: creditNotice });
  const usage = createUsageCollector(db, { ...opts.usage, onCollected: (ids) => credits?.debit(ids) });
  if (opts.usage?.sweepMs) phased(opts.timerPhases, "usage", () => {
    const sweepMs = opts.usage!.sweepMs!;
    usage.start(sweepMs, opts.usage!.liveMs ?? 0);
    // the debit sweep (anything a pass missed) and the monthly plan grants, on the usage sweep's clock
    const tick = () => {
      try {
        credits?.debit();
        credits?.monthly();
      } catch (e) {
        console.error("credits tick:", (e as Error).message);
      }
    };
    const t = setInterval(tick, sweepMs);
    t.unref();
  });
  const usageOf = runUsageLookup(db);
  const liveUsageOf = runLiveUsageLookup(db);
  // the asks an Unblocker wake must report on (state open, coded), as /waiting-on-owner?milestoneId= lists them.
  const openAsksOf = async (m: Milestone) =>
    (await waitingOnJordi(inboxDeps, { milestoneId: m.id }))
      .filter((i) => i.source === "ask" && i.state === "open" && i.code)
      .map((i) => ({
        code: i.code!,
        kind: i.ask,
        ...(i.path ? { path: i.path } : {}),
        ...(i.line !== undefined ? { line: i.line + 1 } : {}),
        // the ask line's text (and what was parsed from it) feeds the Unblocker's skip-if-unchanged fingerprint.
        textHash: textHash([askLineText(m, i.path, i.line), i.question, i.steps ?? "", i.unblocks ?? "", i.recommendation ?? ""].join("\n")),
        // the owner's comments on the card and the files the line links to feed the per-ask memory's fingerprint.
        ...nonEmpty("commentHash", commentHash(db, i.id)),
        ...nonEmpty("evidenceHash", i.path ? evidenceHash(askLineText(m, i.path, i.line), i.path, resolveRepo(read.reposRoot, m.repo)?.path) : ""),
        // when the line was written, so the Unblocker numbers can time ask → verdict from the run log.
        ...(i.since ? { since: i.since } : {}),
        // an ask only the owner can do is carried as left, never woken for.
        ...(ownerOnlyAsk(i.ask, i.whyYou) ? { ownerOnly: ownerOnlyAsk(i.ask, i.whyYou)! } : {}),
      }));
  // the pack export (hosted/social.ts), handed to the other plugs untouched.
  const social = socialArea?.source;
  // the Team Browser is a hosted plug (hosted/browser.ts: instances per world, their keys, the sign-in proxy);
  // the one-team core has none (wakes list no instance, no /api/auth* routes).
  const browserArea = hostedPlugs.find((p) => p.browser)?.browser?.({ api, db, options: opts.browser, instances: opts.browserInstances });
  // Team services: the memory service, Gmail and the team mailbox, WhatsApp, the services hub. The services plug's
  // (hosted/services.ts); the one-team core has no memory service, sends no WhatsApp and reads no mailbox.
  // the owner's Approve on a vault read wakes the asking run's owner at once (the cycle is made below; called later).
  const wakeRun = cycleOpts.enabled
    ? (runId: string, note: string) =>
        outsideRequest(async () => {
          const r = store.getRun(runId);
          const m = r?.milestoneId ? store.getMilestone(r.milestoneId) : undefined;
          return m ? wakeDeliveryManager({ store, cycle, homeThread: (a) => cycle.getLink(a)?.threadId }, m, note) : undefined;
        })
    : undefined;
  const services = hostedPlugs.find((p) => p.services)?.services?.({ api, db, options: opts.mcp, reposRoot: read.reposRoot, ...(wakeRun ? { wakeRun } : {}) });
  const memory: MemoryLookup = opts.mcp?.memoryLookup ?? services?.memory ?? (async () => ({ error: NO_MEMORY, unreachable: false }));
  // the persona's team skills at wake (use_when lines; with wakeCheck on, a missing one fails the wake).
  const skillsRepo = opts.teamSkills?.repoDir ?? libraryRepo(read.reposRoot);
  const skillsCli = opts.teamSkills?.cli ?? cliRunner({ repoDir: skillsRepo, worker: opts.teamSkills?.worker });
  // a world's checkouts here (its valid claims) and the one it keeps its own skills in: the one named after
  // the world (a tester world's `<repos root>/<world id>`, a social world repo's memory-ai/a social world repo), else its oldest.
  const worldCheckouts = (world: string) => [...worldClaims(db, read.reposRoot)].filter(([, ws]) => ws.has(world)).map(([p]) => p);
  const worldRepo = (world: string) => {
    const ds = worldCheckouts(world);
    return ds.find((d) => path.basename(d) === world) ?? ds[0];
  };
  const worldSkillsOf: WorldSkillsOf = (m) => {
    const world = milestoneWorld(db, m.id);
    if (world === DEFAULT_TENANT) return undefined;
    try {
      return { world, skills: readWorldSkills(worldRepo(world)) };
    } catch (e) {
      return { world, skills: [], error: (e as Error).message };
    }
  };
  const worldSkillCheck = wakeSkillCheck({ repoDir: skillsRepo, cli: skillsCli, worldSkills: worldSkillsOf });
  // the main server (the console host): a repo with no T3 project yet is linked in the console's own checkout of it
  const skillCheck: typeof worldSkillCheck = (p, w) =>
    worldSkillCheck(p, w?.link && w.milestone && w.link.host === mainHost() ? { ...w, link: { ...w.link, checkout: async () => (await w.link!.checkout().catch(() => undefined)) ?? resolveRepo(read.reposRoot, w.milestone!.repo)?.path } } : w);
  const worldOf = (id: string) => store.worldOfMilestone?.(id) ?? DEFAULT_TENANT;
  // root L-77: each product's map, read fresh from the home repo's docs/totems/ (one file per product).
  const totemHome = () => resolveRepo(read.reposRoot, homeRepo())?.path;
  const totemMaps = () => readMaps(totemHome());
  /** the objective whose epics list this milestone's spine (docs/pursuits.json), for picking its product. */
  // a campaign whose spine no objective's epics or plan hold serves the objective that watches it or names its repo as its campaign.
  const objectiveOfMilestone = (m: { repo?: string; path: string }): string | undefined =>
    wheelReader(totemHome()).ofSpine(m.repo, m.path) ?? campaignObjective(readPursuits(pursuits.homeDir()), m.repo, m.path);
  const liveObjective = (id: string) => !!pursuits.doc()?.pursuits.some((p) => p.id === id && (p as { active?: boolean }).active !== false && !(p as { done?: boolean }).done);
  /** the milestone's objective; one under none (a campaign) takes its product's first live objective. */
  const objectiveFor = (m: { repo?: string; path: string }) => {
    const maps = totemMaps();
    const own = objectiveOfMilestone(m);
    const product = productFor(maps, { objective: own, repo: m.repo });
    return { maps, own, product, objective: own ?? product?.objectives.find(liveObjective) };
  };
  /** the wake message's own lines: where the objective stands (its answer now) and the owner's newest word on it. */
  const wakeFirst = (m: { repo?: string; path: string }): string => {
    const { objective } = objectiveFor(m);
    if (!objective) return "";
    const name = pursuits.doc()?.pursuits.find((p) => p.id === objective)?.name ?? objective;
    const answer = readWhereWeAre(pursuits.homeDir(), objective)?.answer?.replace(/\s+/g, " ").slice(0, 300);
    const w = inForceWords(readHisWords(read.reposRoot, homeRepo())?.objectives?.find((e) => e.id === objective));
    const out = [`Read first (${name}):`];
    if (answer) out.push(`- Where we are now: ${answer}`);
    if (w?.words) out.push(`- ${ownerName()}'s newest word on it${w.said ? ` (${w.said.slice(0, 10)})` : ""}: "${w.words.replace(/\s+/g, " ").slice(0, 240)}"`);
    const home = pursuits.homeDir();
    let card: string | null = null;
    try {
      card = home ? fs.readFileSync(path.join(home, SCORECARD_DIR, `${objective}.json`), "utf8") : null;
    } catch {
      card = null;
    }
    const red = redFirstLine(objective, card);
    if (red) out.push(red);
    return out.length > 1 ? out.join("\n") : "";
  };
  const totemMapFor = (m: { repo?: string; path: string }): string => {
    const { maps, own, product, objective } = objectiveFor(m);
    const live = liveObjective;
    // a wake whose spine sits under no objective (a campaign) reads its product's first live objective's where-we-are,
    // and the owner's newest words on its objectives (the Chat tab).
    // the objective's one where-we-are rides beside the map: read first, rewritten last.
    const name = objective ? pursuits.doc()?.pursuits.find((p) => p.id === objective)?.name : undefined;
    const where = whereWeAreSection(pursuits.homeDir(), objective, name, homeRepo());
    // and its plan, per key result: how each gets to green (vn_9c02d869: "when an agent reads this, he gets the plan").
    const plan = planSection(pursuits.homeDir(), objective, name);
    const named = (product?.objectives ?? []).filter(live).map((id) => pursuits.doc()?.pursuits.find((p) => p.id === id)?.name ?? "");
    const words = own || !named.length ? "" : chatSection(readHisWords(read.reposRoot, homeRepo()), named.join("\n"), homeRepo());
    return mapSection(maps, product) + (where ? "\n\n" + where : "") + (plan ? "\n\n" + plan : "") + (words ? "\n\n" + words : "");
  };
  // the owner's pursuits (docs/pursuits.json of the code repo): scorecard, totems, moving or stalled, and the effort
  // each rank buys (pursuits.ts); only the home world's milestones follow it.
  const pursuits = createPursuits({ reposRoot: read.reposRoot, board: () => launchBoard?.board() ?? null, git: headKeptLog(gitOut(20_000)) });
  // products, each defined once (docs/scorecard/products.json: its deck and its kit); objectives name theirs.
  const products = createProducts({ reposRoot: read.reposRoot, pursuits: () => pursuits.get() });
  const pursuitEffort = (m: Milestone) => {
    if (worldOf(m.id) !== DEFAULT_TENANT) return null;
    const doc = pursuits.doc();
    const e = doc ? effortForSpine(doc, m.repo, m.path) : null;
    return e && doc ? { ...e, minWakeMinutes: doc.effort.minWakeMinutes } : null;
  };
  /** a milestone's priority lines: the pursuit epics of its repo that are not another milestone's own spine. */
  const pursuitPriority = (m: Milestone) => {
    if (worldOf(m.id) !== DEFAULT_TENANT) return "";
    const doc = pursuits.doc();
    if (!doc) return "";
    const others = store.listMilestones().filter((x) => x.id !== m.id && repoKey(x.repo.split("/").pop()!) === repoKey(m.repo.split("/").pop()!));
    return priorityLines(doc, m.repo, (p) => p !== m.path.replace(/^\.\//, "") && others.some((x) => x.path.replace(/^\.\//, "") === p));
  };
  // priority mode: made after the cycle (it sends through it); the cycle reads it lazily.
  let priority: PriorityMode | undefined;
  /** EPIC-<n> → its best pursuit rank, from each pursuit epic's spine heading; 5 min memo. */
  let rankMemo: { at: number; ranks: Map<string, number | null> } | undefined;
  const epicRanks = () => {
    if (rankMemo && Date.now() - rankMemo.at < 300_000) return rankMemo.ranks;
    const ranks = new Map<string, number | null>();
    const doc = pursuits.doc();
    for (const p of doc?.pursuits ?? [])
      for (const e of p.epics) {
        const dir = resolveRepo(read.reposRoot, e.repo)?.path;
        if (!dir) continue;
        let code: string | undefined;
        try {
          code = epicHeading(fs.readFileSync(path.join(dir, e.path), "utf8")).code;
        } catch {
          continue;
        }
        const r = code && doc ? (effortForSpine(doc, e.repo, e.path)?.rank ?? null) : null;
        if (code && (!ranks.has(code) || (r !== null && (ranks.get(code) ?? 1e9) > r))) ranks.set(code, r);
      }
    rankMemo = { at: Date.now(), ranks };
    return ranks;
  };
  /** the fallback (made further down, once review and the spine writer exist); Hosts reads what it holds. */
  const pickupRef: { current?: Pickup } = {};
  /** the objective of his a ticket moves (his order, 0 = his first): the work queue and Hosts sort by it, through
   * the inbox's own lookup (its red line, its key result, its epic, its repo, its words), so the queue and his inbox agree.
   * A row of another world, or on none of his objectives, is undefined. The house world's rows (house_decision) rank by
   * House even though they live in another repo. The lookup is read at most every 10 s (a drain pass reads it per row). */
  let queueLookupMemo: { at: number; lookup: ReturnType<typeof worldPriorities> } | undefined;
  const queueObjectiveOf = (m: Milestone | undefined, row: { ticket: string; title?: string | null; repo?: string }): { n: number; name: string } | undefined => {
    if (m && worldOf(m.id) !== DEFAULT_TENANT) return undefined;
    if (!queueLookupMemo || Date.now() - queueLookupMemo.at > 10_000) queueLookupMemo = { at: Date.now(), lookup: worldPriorities(store, read.reposRoot) };
    const repo = row.repo ?? (m ? (resolveRepo(read.reposRoot, m.repo)?.name ?? m.repo) : undefined);
    const o = queueLookupMemo.lookup?.({ ...(repo ? { repo } : {}), row: row.ticket, ref: row.ticket, ...(row.title ? { title: row.title } : {}) })?.objective;
    return o ? { n: o.n, name: o.name } : undefined;
  };
  const cycle = createCycle(db, store, {
    effortFor: pursuitEffort,
    priorityFor: (m) => [priority?.promptLines() ?? "", pursuitPriority(m)].filter(Boolean).join("\n"),
    // ready rows in his objectives' order (each row's own key result first, then its epic, its repo, its words)
    dispatchOrder: (m, rows) => {
      if (worldOf(m.id) !== DEFAULT_TENANT) return "";
      const defs = worldObjectiveDefs(store, read.reposRoot);
      const repo = resolveRepo(read.reposRoot, m.repo)?.name ?? m.repo;
      return defs.length ? dispatchOrderSection(byObjective(rows.map((r) => ({ ...r, repo, ref: r.id })), (r) => objectiveOf(defs, r))) : "";
    },
    // a queued row's objective (its key result, epic, repo, words), so his first objective leads the queue by default
    queueObjective: (m, row) => queueObjectiveOf(m, row)?.n,
    // milestones in his objectives' order (ties inside one objective), never a hand-set rank
    milestoneRanks: () => worldRanks(store, read.reposRoot, {}),
    wakeHold: (id) => priority?.holdsWake(id),
    seatsFile: read.seatsFile,
    teamSkills: opts.teamSkills?.wakeCheck
      ? skillCheck
      : async (p, w) => {
          try {
            const lib = [...readLibrary(skillsRepo), ...((w?.milestone && worldSkillsOf(w.milestone)?.skills) || [])];
            return { ok: true, use: Object.fromEntries(lib.filter((s) => p.skills.includes(s.name)).map((s) => [s.name, s.use_when])) };
          } catch {
            return { ok: true, use: {} };
          }
        },
    // The last probe result only (the Services page probes): a wake never waits on a service.
    teamServices: async (p, runId) => services?.wakeSection(p.id, runId),
    // Publisher / Responder cadence and timed wakes run a model only when the ledger or inbox shows work.
    wakeGate: socialArea?.wakeGate({
      repoDir: (m) => resolveRepo(read.reposRoot, m.repo)?.path,
      worldOf,
      // The world's own instance first; then the home world's, where the personas' user-scope team-browser MCP reads today.
      // a world the console made a browser for (a tester world) reads only its own, never the home world's.
      browserUrls: (m) => browserArea?.urlsFor(store.worldOfMilestone(m.id) ?? DEFAULT_TENANT) ?? [],
      browserHeaders: (url) => browserArea?.headersFor(url) ?? {},
    }),
    onRunEnded: (runId) => {
      usage.runEnded(runId);
      void failedWakesCard(runId).catch((e) => console.error(`failed wakes card ${runId}:`, e));
    },
    creditGate: (a, m) => credits?.gate(a, m), // per-world gate, default off; the home world never held (hosted/billing.ts)
    // the wake also lists the rows other personas' running child runs claim (the repo desk's, the DM's).
    treeTodo: async (m) => [await treeTodo(m), claimsSection(claimsFor(store, m))].filter(Boolean).join("\n\n") || undefined,
    treeFor,
    grants,
    runState,
    askedNoRow: async (m) => askedNoRowSection(await askedOf(m)), // open Done-means lines no row covers
    // asks the gate kept from the owner, and asks open more than 3 days, to close, withdraw or ask again
    heldAsks: async (m) => {
      const { items, held } = await waitingAndHeld(inboxDeps, m);
      // the world's home goal also takes the held asks other goals' managers left (off, or 2 h untouched).
      const routed = heldHomeOf(worldOf(m.id)) === m.id ? routedHeldSection(await routedHeldOf(worldOf(m.id)), resolveRepo(read.reposRoot, m.repo)?.name ?? m.repo ?? "") : undefined;
      return [heldAsksSection(held), routed, staleAsksSection(items)].filter(Boolean).join("\n\n") || undefined;
    },
    heldRoutedDue: async () => {
      const worlds = new Set(store.listMilestones().map((x) => worldOf(x.id)));
      const out: Array<{ milestoneId: string; key: string; at: string }> = [];
      for (const w of worlds) {
        const home = heldHomeOf(w);
        if (!home) continue;
        for (const h of await routedHeldOf(w)) {
          const at = h.why === "manager off" || !h.since ? new Date(Date.now() - 60_000).toISOString() : new Date(Date.parse(h.since) + 2 * 3_600_000).toISOString();
          out.push({ milestoneId: home, key: `${h.repo}/${h.code ?? h.path}`, at });
        }
      }
      return out;
    },
    orphanCommits: orphanSectionOf, // commits on main that name no ticket
    orphansDue: async () => {
      // every world's orphans, for the orphan sweep that wakes the home milestone's Delivery Manager
      const worlds = new Set(store.listMilestones().map((m) => store.worldOfMilestone?.(m.id) ?? DEFAULT_TENANT));
      return (await Promise.all([...worlds].map((w) => orphansOf(orphanMilestones(w))))).flat();
    },
    // every world's open urgent desk notes, for the sweep that wakes its home Delivery Manager at once
    urgentNotesDue: async () => {
      // every repo of every world, its home milestone picked as deskInboxOf does (root spine, else the first)
      const worlds = new Set(store.listMilestones().map((m) => store.worldOfMilestone?.(m.id) ?? DEFAULT_TENANT));
      const out: Array<{ milestoneId: string; file: string; at: string }> = [];
      for (const w of worlds) {
        const homes = new Map<string, Milestone>();
        for (const m of orphanMilestones(w)) {
          const dir = resolveRepo(read.reposRoot, m.repo)?.path;
          if (dir && (!homes.has(dir) || (/(^|\/)root\.md$/i.test(m.path ?? "") && !/(^|\/)root\.md$/i.test(homes.get(dir)!.path ?? "")))) homes.set(dir, m);
        }
        for (const [dir, h] of homes) out.push(...urgentOpenNotes(dir).map((n) => ({ milestoneId: h.id, file: n.file, at: n.at })));
      }
      return out;
    },
    launchDrafts: launchDraftsOf, // launch board reds with no owner row
    objectives: async (m) => (objectivesOf ? objectivesOf(m) : { idle: [] }), // its objectives below green; an idle one is news
    totemMap: async (m) => totemMapFor(m),
    // every persona of every world is told its chapters (the ones it reads and writes), the plot and its objective with its key results.
    yourPart: async (m, p) => {
      const { maps, product, objective, own } = objectiveFor(m);
      // a wheel of the social world is that product's campaign, whichever product it talks about
      const social = worldOf(m.id) === socialWorld();
      const of = social ? maps.products.find((x) => [x.name, x.product].some((n) => n.toLowerCase() === socialProduct().toLowerCase())) : product;
      const wheel = readWheel(totemHome(), of?.product ?? (social ? socialProduct() : undefined));
      const raw = objective ? readPursuits(pursuits.homeDir()).find((x) => x.id === objective) : undefined;
      const node = objective ? (await ownerObjectivesInput?.().catch(() => undefined))?.nodes.find((n) => n.id === objective) : undefined;
      const how = own ? "it names this campaign or its repo" : "no objective names this campaign: its product's first live objective";
      return yourPartSection({
        persona: p.name,
        milestone: m.title,
        repo: m.repo?.split("/").pop(),
        template: of?.repos[0],
        wheel,
        plot: readPlot(locateDir(m) ?? resolveRepo(read.reposRoot, m.repo)?.path, m.path),
        objective: objective ? { id: objective, name: raw?.name ?? node?.name ?? objective, greenWhen: raw?.greenWhen, keyResults: node?.keyResults ?? [], how } : undefined,
      });
    },
    // every persona commit names its row (its standing row from docs/functions/catalog.json)
    // a customer's workspace (its plan is not internal) has no row of ours: our catalog's standing rows are for our own worlds
    commitRow: (p, m) => {
      const w = worldOf(m.id);
      const ours = w === DEFAULT_TENANT || (db.prepare("SELECT plan FROM tenants WHERE id = ?").get(w) as { plan?: string } | undefined)?.plan === "internal";
      return ours && personaRows(pursuits.homeDir()).size ? standingRowSection(p.name, standingRow(pursuits.homeDir(), p.name), m.path) : undefined;
    },
    wakeFirst: (m) => wakeFirst(m), // the product's map: read its totems first, write back last (root L-77)
    ownerObjectives: async (m) => (ownerObjectivesNow && worldOf(m.id) === DEFAULT_TENANT ? ownerObjectivesNow() : undefined), // his objectives open every wake and brief
    // a persona that names an objective works its epics only
    objectiveOf: async (id) => {
      const p = (await pursuits.get()).pursuits.find((x) => x.id === id);
      return p ? { name: p.name, epics: p.epics.map((e) => `${e.repo}: ${e.path}`) } : undefined;
    },
    deskInbox: deskInboxOf, // notes other worlds dropped in this repo's desk/inbox/
    // the home Delivery Manager's open faults (open desk notes, its red server-wheel key results) are a part of its wake fingerprint
    wakeNews: async (m) => {
      const r = homeCheckoutOf(m);
      if (!r) return [];
      const repo = path.basename(r.path);
      return [...deskNoteLines(readInbox(r.path)), ...wheelFaults(await serverWheel(), repo, homeRepo())];
    },
    // Mac ticket questions to the Team desk still waiting for an answer (steps/deskQuestions.ts)
    deskQuestions: async (m, base) => (deskQs ? deskQuestionsSection(deskQs.listOpen([m.id]), base) : undefined),
    createMilestone: async (input) => withDeliveryManager(await recordFirst(() => recordedMilestones().createMilestone(input))), // every goal has a persona
    monitorAlerts: monitorAlertsOf,
    readyToMark: readyToMarkOf((m) => withOutcome(m, 1_500)), // cadence / timed wakes skip a milestone waiting for the owner's mark
    // child epics of the milestone's spine, each with the enabled persona of its own milestone (if any).
    children: async (m) => {
      const { rel, spines } = await spinesFor(m);
      if (!spines || !rel) return undefined;
      const norm = (p: string) => p.replace(/^\.\//, "");
      const world = store.worldOfMilestone(m.id); // only the milestone's own world names a child's persona
      const tree = await treeFor(m, 1_500, spines).catch(() => undefined);
      const kids = childEpicsFor(spines, rel, (child) => {
        for (const cm of store.listMilestones().filter((x) => sameRepo(x.repo, m.repo) && x.path && norm(x.path) === child && store.worldOfMilestone(x.id) === world)) {
          const on = store.listAssignments({ milestoneId: cm.id }).find((x) => x.enabled);
          if (on) return store.getPersona(on.personaId)?.name ?? on.personaId;
        }
        return undefined;
      });
      // each child's ready rows by id, for its PICK UP line.
      return tree && kids ? kids.map((c) => ({ ...c, ready: childReadyRows(tree, c.path) })) : kids;
    },
    // only answers in a spine count (referenced canonical asks); a console copy of an unwritten answer is none.
    referencedAnswers: async (m) => {
      const items = await waitingOnJordi(inboxDeps, { milestoneId: m.id });
      return (await answeredReferences(inboxDeps, m, items)).length;
    },
    openAsks: openAsksOf,
    // a pack repo's wake names the persona's pack role, what it may write and the EPICSPINE_PERSONA to commit with.
    ...(read.skillDir && socialArea
      ? {
          packSection: async (m: Milestone, p: Persona, since?: string) => { const dir = locateDir(m) ?? resolveRepo(read.reposRoot, m.repo)?.path; return dir ? socialArea.packSection(read.skillDir!, dir, m, p, since, worldOf) : undefined; },
          // the Writer brief, right after the prompt's first line (built from the cached pack export).
          roleBrief: async (m: Milestone, p: Persona, since?: string) => { const dir = locateDir(m) ?? resolveRepo(read.reposRoot, m.repo)?.path; return dir ? socialArea.roleBrief(read.skillDir!, dir, m, p, since, worldOf) : undefined; },
        }
      : {}),
    // the run-end pull targets the checkout this console reads and drops its spines.py cache.
    repoDir: (m) => resolveRepo(read.reposRoot, m.repo)?.path,
    onRepoPulled: (dir) => {
      pulledSpines(dir);
      newAsks?.repoMoved(dir);
    },
    worldHold,
    jobRoute,
    ...cycleOpts,
  });
  // the read model (readModel/host.ts). Worlds kept warm: every world with milestones when logins scope the store
  // (CONSOLE_AUTH=on), else the console's own scope.
  {
    const mode = (indexer || opts.passive) && opts.readModel?.mode && opts.readModel.mode !== "none" ? ("external" as const) : (opts.readModel?.mode ?? "none");
    const authOn = (opts.auth ?? authModeFromEnv()) === "on";
    if (mode !== "none")
      readModel = createReadModelHost({
        db,
        mode,
        worlds: () => (authOn ? (db.prepare("SELECT DISTINCT tenant_id AS t FROM milestones").all() as { t: string }[]).map((r) => r.t) : [tenantScope ?? ""]),
        refresher: { reposRoot: read.reposRoot, spines: read.spines, ...(tenantScope ? { tenant: tenantScope } : {}), homeThread: (id) => cycle.getLink(id)?.threadId, ...(opts.teamState?.repo ? { teamRepo: opts.teamState.repo } : {}) },
        ...(read.spines ? { spines: read.spines } : {}),
        ...(opts.readModel?.dbPath ? { worker: { dbPath: opts.readModel.dbPath, reposRoot: read.reposRoot, ...(read.skillDir ? { skillDir: read.skillDir } : {}), ...(process.env.CONSOLE_SPINES_FIXTURE ? { spinesFixture: process.env.CONSOLE_SPINES_FIXTURE } : {}), ...(tenantScope ? { tenant: tenantScope } : {}), ...(opts.teamState?.repo ? { teamRepo: opts.teamState.repo } : {}) } } : {}),
        ...(opts.passive ? {} : { runningRuns: () => (db.prepare("SELECT id FROM runs WHERE outcome = 'running'").all() as { id: string }[]).map((r) => r.id) }),
        t3State: (id) => cycle.runT3State(id),
        ...(opts.readModel?.tickMs !== undefined ? { tickMs: opts.readModel.tickMs } : {}),
        ...(opts.readModel?.patchTtlMs !== undefined ? { patchTtlMs: opts.readModel.patchTtlMs } : {}),
        ...(opts.readModel?.drift?.everyMs
          ? {
              drift: {
                everyMs: opts.readModel.drift.everyMs,
                ...(opts.readModel.drift.firstAfterMs !== undefined ? { firstAfterMs: opts.readModel.drift.firstAfterMs } : {}),
                ...(opts.readModel.drift.confirmAfterMs !== undefined ? { confirmAfterMs: opts.readModel.drift.confirmAfterMs } : {}),
                onResult: (r: DriftResult) => onDrift?.(r),
              },
            }
          : {}),
      });
    if (readModel) opts.readModel?.onHost?.(readModel);
  }
  /** The world a view is read under: the caller's (CONSOLE_AUTH=on), else the console's own scope. */
  const viewWorld = () => store.tenant ?? "";
  /** One milestone's open list (as `waitingOnJordi`) from the stored view when there is a read model. */
  const waitingFor = async (milestoneId: string) => {
    if (!readModel) return waitingOnJordi(inboxDeps, { milestoneId });
    const k = { kind: "waiting" as const, world: viewWorld(), milestoneId, includeSettled: false };
    return viewWaiting((await readModel.view(k, () => computeWaiting(inboxDeps, k))).payload as WaitingPayload, {});
  };
  // a new open ask after a pull wakes the milestone's switched-on Unblocker (debounced, one wake per batch).
  if (cycleOpts.enabled && cycleOpts.t3 && opts.newAskWake?.enabled !== false) {
    const git = opts.newAskWake?.git ?? gitOut(10_000);
    newAsks = createNewAskWaker({
      db,
      store,
      openAsks: cycleOpts.openAsks ?? openAsksOf,
      grants: cycleOpts.grants ?? grants,
      repoDir: cycleOpts.repoDir ?? ((m) => resolveRepo(read.reposRoot, m.repo)?.path),
      authorRun: gitAuthorRun(git),
      // read the asks as pushed, not as last synced (an ask answered meanwhile wakes nobody); the pull drops the spines cache.
      pull: opts.newAskWake?.pull ?? createRepoPuller({ git: (dir, args) => gitOut(120_000)(dir, args).then(() => undefined), recover: gitOut(120_000), onPulled: pulledSpines }).pull,
      wake: (id, note, noteBy) => cycle.runNow(id, { instructions: note, instructionsBy: noteBy }),
      debounceMs: opts.newAskWake?.debounceMs,
    });
    if (opts.newAskWake?.headWatchMs) newAsks.watchHeads((dir) => { const sha = headSha(dir); return sha ? Promise.resolve(sha) : git(dir, ["rev-parse", "HEAD"]).then((x) => x.trim()); }, opts.newAskWake.headWatchMs); // HEAD from.git, no git child per repo per tick
  }
  // registered before the routes it guards: a milestone chat's run control, Add and ticket detail stay inside its subtree.
  const chatScope = mountChatScope(api, {
    store,
    publicUrl: cycle.publicUrl,
    locate: async (m) => {
      const { loc, rel } = await spinesFor(m, 4_000);
      return { repoDir: loc?.repo.path, rel };
    },
    treePaths: (m) => treePaths(m),
  });
  mountCycle(api, store, cycle);
  priority = createPriorityMode(db, store, {
    base: cycle.publicUrl,
    send: (run, text) => cycle.sendToRun(run, text),
    rankOf: (row) => {
      const epic = epicOfRow(row);
      return epic ? (epicRanks().get(epic) ?? null) : null;
    },
    wake: cycleOpts.enabled ? (id, note) => cycle.runNowRequest(id, { instructions: note, instructionsBy: PRIORITY_BY }) : undefined,
    isManager: (a) => a.enabled && isDeliveryManager(store.getPersona(a.personaId)?.name),
  });
  mountPriority(api, priority, ownerName);
  if (!opts.passive && cycleOpts.enabled) {
    const pt = setInterval(() => void priority?.tick().catch((e) => console.error("priority mode tick:", e instanceof Error ? e.message : e)), 60_000);
    pt.unref?.();
  }
  // Team desk: one long-lived T3 thread, shown by the Chat page (no console chat store).
  migrateDesk(db);
  // every desk chat (Team, repo, world) runs on its persona's host, like a wake (cycle clientFor: the worker server over the tunnel).
  // one request, one row: which ticket rows hold each of his requests (one request, one row), read from the epic files under the repos root.
  const requestRows = createRequestRows({ reposRoot: () => read.reposRoot, wanted: () => [...hisMessages(db, Date.now() - 14 * 86_400_000).map((m) => ({ id: m.request, words: m.text })), ...chatCopyMessages(read.reposRoot)] });
  const deskHosts = {
    requestRows,
    clientFor: (h: HostId) => {
      if (!cycleOpts.enabled) return undefined;
      if (h === mainHost()) return cycleOpts.t3;
      if (!cycleOpts.worker) return undefined;
      cycleOpts.worker.touchTunnel(); // opens the forward when down (never starts the box)
      return cycleOpts.worker.client;
    },
    dispatcherFor: (h: HostId) => cycleOpts.hostDispatchers?.[h] ?? cycleOpts.dispatcher,
    environmentIdFor: (h: HostId) => cycle.hostEnvironment(h),
  };
  // both desks carry the desk intake rule of repos with a pack on (pack.py <pack> --wake-text).
  const intake = read.skillDir ? packIntakeRunner(read.skillDir) : undefined;
  // The milestone page that shows a spine (its own, or the one whose tree holds it).
  const spineMilestone = async (repoName: string, rel: string): Promise<string | undefined> => {
    const mine = store.listMilestones({ includeSettled: true }).filter((m) => m.path && resolveRepo(read.reposRoot, m.repo)?.name === repoName);
    const norm = (p: string) => p.replace(/^\.\//, "");
    const own = mine.find((m) => norm(m.path!) === rel);
    if (own) return own.id;
    for (const m of mine) if ((await treePaths(m).catch(() => new Set<string>())).has(rel)) return m.id;
    return undefined;
  };
  const desk = createDesk({
    db,
    store,
    // the desk persona made on first need gets its file too (the record is set up just below; called later)
    personaCreated: (p, world) => void personaRecord.write(world, p, `add ${p.name}`).catch((e) => console.warn(`personas: desk persona ${p.name} not written: ${(e as Error).message}`)),
    t3: cycleOpts.enabled ? cycleOpts.t3 : undefined,
    dispatcher: cycleOpts.dispatcher,
    startGate: cycleOpts.startGate,
    seatBlocked: seatBlockerFor(read.seatsFile), // a desk on a limited seat moves before the owner's send
    ownerSeat: () => ownerSeatFree(read.seatsFile), // the Team desk moves to the seat kept for him
    publicUrl: cycle.publicUrl,
    reposRoot: read.reposRoot,
    repo: process.env.CONSOLE_DESK_REPO || undefined,
    environmentId: () => cycle.hostEnvironment(mainHost()),
    ...deskHosts,
    intake,
    delivery: (id) => deliveryFor(store, id),
    // The milestone page that shows a spine (its own, or the one whose tree holds it): where the owner marks a draft epic ready.
    milestoneFor: spineMilestone,
    objectives: async () => ownerObjectivesInput?.(),
  });
  // one repo-desk thread per milestone (same engine, key milestone:<id>), in the milestone repo's T3 project.
  const milestoneChats = createMilestoneChats({
    db,
    jobRoute, // a customer workspace on its own job servers chats there
    store,
    t3: cycleOpts.enabled ? cycleOpts.t3 : undefined,
    dispatcher: cycleOpts.dispatcher,
    startGate: cycleOpts.startGate,
    seatBlocked: seatBlockerFor(read.seatsFile), // a desk on a limited seat moves before the owner's send
    publicUrl: cycle.publicUrl,
    reposRoot: read.reposRoot,
    deskRepo: process.env.CONSOLE_DESK_REPO || undefined,
    environmentId: () => cycle.hostEnvironment(mainHost()),
    ...deskHosts,
    milestone: (id) => store.getMilestone(id),
    locate: async (m) => {
      const { loc, rel } = await spinesFor(m, 4_000);
      return { repoDir: loc?.repo.path, rel };
    },
    ...(read.skillDir ? { bind: spinesBindRunner(read.skillDir) } : {}),
    intake,
    since: (m, sinceIso) =>
      sinceBlock(
        {
          db,
          store,
          locate: async (mm) => {
            const { loc, rel } = await spinesFor(mm, 2_000);
            return { repoDir: loc?.repo.path, rel };
          },
          tree: (mm) => treeFor(mm, 2_000),
        },
        m,
        sinceIso,
      ),
  });
  // the repo index the desk reads (GET /api/desk/repos); git runs only in its background refresh.
  const repoIndex = createRepoIndex({ db, store, scan: opts.repoIndex?.scan, publicUrl: cycle.publicUrl });
  if (opts.repoIndex?.everyMs) repoIndex.start(opts.repoIndex.everyMs);
  // screenshots and files in every chat (uploaded first, sent as links the desk opens; served within the world).
  const attachments = createAttachments({
    db,
    dir: opts.chatAttachmentsDir ?? process.env.CONSOLE_CHAT_ATTACHMENTS_DIR ?? path.join(path.dirname(defaultDbPath()), "chat-attachments"),
    world: () => store.tenant ?? DEFAULT_TENANT,
    publicUrl: cycle.publicUrl,
  });
  mountAttachments(api, attachments);
  // a message for one desk with a part for the other desk (EpicTeam ↔ the social product): that part crosses at once.
  const deskTell = (w: string, text: string, id: string): Promise<true | string> =>
    w === DEFAULT_TENANT ? desk.tell(text, id) : worldDesks.send(w, text, undefined, id).then(() => true as const);
  /** His message is in that desk's thread (T3 shows a queued message only once its turn starts). */
  const deskLanded = async (w: string, head: string): Promise<boolean> => {
    const flat = (t: string) => t.replace(/\s+/g, " ").trim();
    const v = await (w === DEFAULT_TENANT ? desk.view() : worldDesks.view(w));
    return v.messages.some((m) => m.role === "user" && flat(m.text).includes(flat(head)));
  };
  // the last three small text calls (cross-world check, voice spill check, the memory service ask wording) on the same
  // CONSOLE_TEXT_MODEL_PROVIDER as's two; a judge or worder a test passes in wins (here and in the probe).
  const textOpenAiKey = async () => process.env.OPENAI_API_KEY || (await sudoRead(openAiStoreFile()));
  const onClaude = textModelProvider() === "anthropic";
  const crossOpt = opts.deskCross === true ? {} : opts.deskCross || undefined;
  const spillOpt = opts.voiceSpill === true ? {} : opts.voiceSpill || undefined;
  const textCrossJudge: CrossJudge = crossOpt?.judge ?? (onClaude ? anthropicCrossJudge(anthropicKey) : openAiCrossJudge(textOpenAiKey));
  const textSpillJudge: SpillJudge = spillOpt?.judge ?? (onClaude ? anthropicSpillJudge(anthropicKey) : openAiSpillJudge(textOpenAiKey));
  const textAsk = services?.askWorder({ onClaude, anthropicKey, openAiKey: textOpenAiKey, worder: opts.memoryAsk?.worder }); // (hosted/services.ts)
  const askModel = textAsk?.model ?? "";
  const deskCross: DeskCross | undefined = crossOpt
    ? createDeskCross({
        db,
        judge: textCrossJudge,
        auto: crossOpt.auto === true,
        ...(cycleOpts.enabled ? { tell: deskTell, landed: deskLanded } : {}),
        pairs: crossOpt.pairs ?? process.env.CONSOLE_DESK_PAIRS,
        ...(opts.voice?.now ? { now: opts.voice.now } : {}),
      })
    : undefined;
  // a desk note one paired desk's world drops in the other's desk inbox shows in the receiving desk's chat, and
  // the sending desk's chat gets a receipt once it is placed (the same delivery as the relay, posted by the console).
  const noteCross: NoteCross | undefined =
    deskCross && cycleOpts.enabled && process.env.CONSOLE_NOTE_CROSS !== "0"
      ? createNoteCross({ db, pairs: parsePairs(crossOpt?.pairs ?? process.env.CONSOLE_DESK_PAIRS), across: deskCross.across, home: (w) => worldHome(w) })
      : undefined;
  if (deskCross && cycleOpts.enabled && (crossOpt?.sweepMs ?? 60_000) > 0)
    setInterval(
      () =>
        void (noteCross?.sweep().catch((e) => console.error("desk note cross:", e)) ?? Promise.resolve())
          .then(() => deskCross.sweep())
          .catch((e) => console.error("desk cross sweep:", e)),
      crossOpt?.sweepMs ?? 60_000,
    ).unref();
  // made below, once the review list and the asks can be read; a desk message reaches it through deskSaid.
  let noteTouch: NoteTouch | undefined;
  /** E942-S174 the same pass on given words, writing nothing (set below with the pass). */
  let touchTry: ((x: { words: string; after?: string; typed?: boolean; cards?: TouchCard[] }) => Promise<unknown>) | undefined;
  const touchGraceMs = typeof opts.noteTouch === "object" && opts.noteTouch.graceMs !== undefined ? opts.noteTouch.graceMs : TOUCH_GRACE_MS;
  const touchWhere = (text: string) => (/^🎙 Voice note \(WhatsApp/.test(text) ? "WhatsApp" : /^🎙 Voice note \(Chat\)/.test(text) ? "the Team desk Chat" : "a message to the Team desk");
  const deskSaid = (world: string, text: string, requestId?: string, pending?: boolean) => {
    void deskCross?.said({ world, words: text, ...(requestId ? { requestId } : {}), ...(pending ? { pending } : {}) }).catch((e) => console.error("desk cross:", e));
    // a typed message is read too, from TOUCH_MIN_TYPED_WORDS words: the stale-card mark is not only for voice notes
    // E942-S174 read after a grace window, so a message he takes back right after marks nothing
    void noteTouch?.heard({ world, words: text, where: touchWhere(text), typed: isTyped(text), ...(requestId ? { id: requestId } : {}) }, { graceMs: touchGraceMs }).catch((e) => console.error("note touch:", e));
  };
  // his Chat voice notes posted but not in the desk's chat yet (set once the voice notes are made, below).
  let teamUndelivered: () => VoiceNote[] = () => [];
  mountDesk(api, desk, milestoneChats, repoIndex, attachments, (text, crid, pending) => deskSaid(DEFAULT_TENANT, text, crid, pending), () => teamUndelivered());
  // the relay. The Team desk itself decides a part of the owner's words is the paired the social product desk's work and
  // passes it here, quoting him; no router decides for it. Only the Team desk's own call (header X-Console-Run: team-desk).
  /** The relay's body, the same for the Team desk and a world desk (each desk passes the other desk's part itself). */
  const passFrom = async (c: Context, world: string) => {
    const b = (await c.req.json().catch(() => undefined)) as { about?: unknown; quote?: unknown; clientRequestId?: unknown } | undefined;
    const quote = typeof b?.quote === "string" ? b.quote.trim() : "";
    if (!quote || quote.length > TRANSCRIPT_MAX) return c.json({ error: { code: "validation_error", message: `quote (${ownerName()}'s words, up to ${TRANSCRIPT_MAX} characters) is required; about (a few words) and clientRequestId are optional` } }, 400);
    // the summary names only the product his words name (16 Nov: a summary named the memory product, his words named none).
    const added = productsAdded(typeof b?.about === "string" ? b.about : "", quote);
    if (added.length)
      return c.json({ error: { code: "product_not_in_quote", message: `about names ${added.join(", ")} but ${ownerName()}'s quoted words do not. Name only the product his words name (or quote the sentence where he names it); when his words name none, pass nothing and ask him one open question on an inbox card (root L-66: "Tell me how you think about <it>.")` } }, 422);
    const r = await deskCross?.pass({
      world,
      quote,
      about: typeof b?.about === "string" ? b.about.slice(0, 300) : "",
      ...(typeof b?.clientRequestId === "string" && b.clientRequestId.trim() ? { requestId: b.clientRequestId.trim().slice(0, 120) } : {}),
    });
    if (!r) return c.json({ error: { code: "no_desk_across", message: `this console has no desk paired with ${world}'s desk (CONSOLE_DESK_PAIRS); drop a desk note instead (scripts/desk_note.py send)` } }, 409);
    return c.json({ id: r.id, state: r.state, to: r.to.world, product: r.to.product, url: r.to.url }, r.state === "passed" ? 201 : 202);
  };
  api.post("/desk/pass", async (c) => {
    const refused = deskOnly((n) => c.req.header(n));
    if (refused) return c.json({ error: { code: "desk_only", message: refused } }, 403);
    return passFrom(c, DEFAULT_TENANT);
  });
  /** A world desk's token header for a curl the console hands it (its seed's curls get the same through withWorldAuth). */
  const deskBearer = (w: string): { auth?: string } => {
    try {
      return { auth: worldDesks.bearer(w, worldDesks.chatFor(w).persona().id) };
    } catch {
      return {};
    }
  };
  // a world desk's own relay (the social product's desk passes EpicTeam's part at once too): only that desk's own call, in its world.
  api.post("/tenants/:id/desk/pass", async (c) => {
    const w = c.req.param("id") ?? "";
    const run = (c.req.header("x-console-run") ?? "").trim().toLowerCase();
    if (w === DEFAULT_TENANT || run !== worldDesks.runHeader(w).toLowerCase() || c.req.header("x-run-id") || (store.tenant ?? DEFAULT_TENANT) !== w)
      return c.json({ error: { code: "desk_only", message: `only world ${w}'s own desk passes from here (header X-Console-Run: ${worldDesks.runHeader(w)}, its world's token, no run id); the Team desk uses /api/desk/pass` } }, 403);
    return passFrom(c, w);
  });
  // a world's team desk (the social skin's top-level Chat): one thread across the world's campaigns, its own persona and token.
  // many worlds are the tenancy plug's (hosted/tenancy.ts); the one-team core has the Team desk only.
  const tenancy = hostedPlugs.find((p) => p.tenancy)?.tenancy?.();
  const worldDesks: WorldDesksArea = tenancy?.worldDesks({
    db,
    jobRoute, // a customer workspace on its own job servers chats there
    store,
    t3: cycleOpts.enabled ? cycleOpts.t3 : undefined,
    dispatcher: cycleOpts.dispatcher,
    startGate: cycleOpts.startGate,
    seatBlocked: seatBlockerFor(read.seatsFile),
    publicUrl: cycle.publicUrl,
    reposRoot: read.reposRoot,
    deskRepo: process.env.CONSOLE_DESK_REPO || undefined,
    environmentId: () => cycle.hostEnvironment(mainHost()),
    ...deskHosts,
  }) ?? ONE_TEAM_DESKS;
  if (tenancy) worldDesks.mount(api, store, attachments, deskSaid);
  // the repo desk dispatches workers for its milestone on the owner's request (parent + child runs, scope + claims checked).
  // the live claim in a row's Owner cell, read from the milestone's checkout (checked before a worker starts).
  const rowClaimOf = (ref: string, m: Milestone) => {
    const dir = locateDir(m) ?? resolveRepo(read.reposRoot, m.repo)?.path;
    return dir ? rowClaimIn(dir, ref) : undefined;
  };
  mountChatDispatch(api, {
    claimIn: rowClaimOf,
    store,
    scope: chatScope,
    dispatcher: cycleOpts.dispatcher,
    publicUrl: cycle.publicUrl,
    worldOf: (m) => milestoneWorld(db, m.id),
    persona: (m) => milestoneChats.chatFor(m.id).persona(),
    chatThread: (m) => milestoneChats.chatFor(m.id).current()?.threadId,
    maxWorkers: cycleOpts.maxWorkersPerMilestone ?? DEFAULT_MAX_WORKERS,
  });
  // the Team page's Moving now strip and the stall watch (dry list always; real Run nows behind the flag).
  const movement = createMovement({
    store,
    memoMs: opts.movingMemoMs ?? 10_000, // one strip build per world per 10 s, however many tabs poll it
    // effort follows priority: a top pursuit's idle epic is nudged sooner, a parked one never.
    effortFor: (repo, p) => {
      const doc = pursuits.doc();
      return doc ? effortForSpine(doc, repo, p) : null;
    },
    treeFor: (m) => treeFor(m, 1_500),
    repoDir: (m) => resolveRepo(read.reposRoot, m.repo)?.path,
    seats: () => {
      try {
        return read.seatsFile ? readSeats(read.seatsFile) : undefined;
      } catch {
        return undefined;
      }
    },
    waiting: (m) => waitingFor(m.id), // the [waits on] resolver names an idle epic's open ask
    runNow: cycleOpts.enabled ? async (id, note) => (await cycle.runNowRequest(id, { instructions: note, instructionsBy: STALL_WATCH_BY })).run : undefined,
    paused: () => priority?.holdsWake(""),
    enabled: !!opts.stallWatch?.enabled && cycleOpts.enabled,
    log: (msg) => console.log(msg),
  });
  movement.mount(api);
  if (!opts.passive) phased(opts.timerPhases, "stallWatch", () => movement.start(opts.stallWatch?.everyMs ?? 10 * 60_000));
  // one [delivered] note per closed placement and the sends queued while T3 was down (the endpoint-list update goes when a chat is next opened, not from here).
  if (opts.deskTickMs && cycleOpts.enabled) {
    const tick = () =>
      void Promise.all([desk.tick(), milestoneChats.tick().catch((e) => console.error("milestone chat tick:", e)), worldDesks.tick().catch((e) => console.error("world desk tick:", e))]);
    setTimeout(tick, 5_000).unref();
    setInterval(tick, opts.deskTickMs).unref();
  }
  // Hosts view: cached status of the main server/the worker server (never starts the worker server) and the Wake the worker server button (hosted/hosts.ts).
  const hostsArea = hostedPlugs.find((p) => p.hosts)?.hosts?.();
  hostsArea?.mountView({
    api,
    store,
    enabled: cycleOpts.enabled,
    t3: cycleOpts.t3,
    dispatcher: cycleOpts.dispatcher,
    worker: cycleOpts.worker,
    hostOf: (assignmentId) => {
      const link = cycle.getLink(assignmentId);
      if (link) return link.host;
      const a = store.getAssignment(assignmentId);
      return a ? store.getPersona(a.personaId)?.host : undefined;
    },
    runT3State: cycle.runT3State,
    staleRunMs: cycleOpts.staleRunMs,
    // every cap on how many agents run, and the waiting queue
    ...(opts.hostLoad?.probe ? { hostLoad: opts.hostLoad.probe } : {}),
    maxWorkers: (() => {
      const base = cycleOpts.maxWorkersPerMilestone ?? DEFAULT_MAX_WORKERS;
      return { base, roomy: cycleOpts.workerRoom ? roomyMaxFromEnv(undefined, base) : base };
    })(),
    workerLaunch: (runId: string) => getWorkerLaunch(db, runId),
    sentBack: () => pickupRef.current?.waiting() ?? [],
    objectiveOf: (q) => queueObjectiveOf(q.milestoneId ? store.getMilestone(q.milestoneId) : undefined, q),
    readyRows: async () => {
      const ms = store.listMilestones().filter((m) => !m.paused && m.repo);
      const trees = await Promise.all(ms.map((m) => treeFor(m, 1_500).then((t) => ({ m, t })).catch(() => undefined)));
      const out: { id: string; title: string; repo?: string; nextAction?: string; since?: string }[] = [];
      for (const x of trees) {
        if (!x) continue;
        const repo = resolveRepo(read.reposRoot, x.m.repo)?.name ?? x.m.repo;
        for (const n of readyRows(x.t)) {
          if (n.kind !== "ticket") continue;
          out.push({ id: n.id, title: n.title, repo, ...(n.nextAction ? { nextAction: n.nextAction } : {}), ...(n.since ? { since: n.since } : {}) });
        }
      }
      return out;
    },
  });
  // waiting-on-the owner inbox + messages (inbox/routes.ts).
  // One spine writer (one git lock per checkout) for inbox answers and the Secrets ledger.
  let clones: ReturnType<typeof createCloneWriter> | undefined;
  const sharedWriter = createSpineWriter({
    onHeal: (h) => console.warn(`spine write: ${h.repoDir} held ${h.dropped.length} local commit(s) origin lacks by SHA, its own unpushed ones or ones origin already holds rewritten (${h.dropped.slice(0, 5).join("; ")}${h.dropped.length > 5 ? "; …" : ""}): kept on ${h.backup}, main reset to origin`),
    // press writes answer at the local commit; the push follows in the background, the shared checkout after it
    backgroundPush: !!opts.backgroundPush,
    // CONSOLE_PRESS_HOOKS=full runs the repo's hooks on every press commit again (rollback of the secret check)
    pressHooks: process.env.CONSOLE_PRESS_HOOKS === "full" ? "full" : "scan",
    onPushed: (dir) => clones?.pushedFrom(dir),
    onDropped: (d) => {
      const n = presses.requeue(d.presses, `its commit could not be pushed (${d.reason.slice(0, 200)}); written again on the fresh spine`);
      if (n) void pressWorker.tick().catch((e) => console.warn(`press outbox: ${(e as Error).message}`));
    },
  });
  // writes commit and push from the console's own clone; the shared checkout follows.
  clones = opts.writeClones ? createCloneWriter(sharedWriter, { root: opts.writeClones.root, enabled: opts.writeClones.enabled !== false }) : undefined;
  if (clones && opts.backgroundPush) void clones.resumePushes().catch((e) => console.warn(`spine write: resuming pushes: ${(e as Error).message}`));
  pressPushes = sharedWriter.pushes;
  // press writes landing close together share one commit and push (inbox/groupWrite.ts)
  const spine: SpineWriter = groupEdits(clones ?? sharedWriter, { log: (m) => console.log(m) });
  // many humans: the People roster from the root spine, an inbox per human, the owner's board,
  // two-step approval, Not sure and the time limit (people/).
  mountPeople(api, app, {
    db,
    store,
    reposRoot: read.reposRoot,
    mode: opts.auth ?? authModeFromEnv(),
    spine,
    addMember: (i) => auth.addMember(i),
    createSetup: (e) => auth.createSetup(e),
    written: (dir) => dropSpines(dir),
    ...(opts.people?.tickMs ? { tickMs: opts.people.tickMs } : {}),
  });
  cloneStatus = () => (clones ? { enabled: clones.enabled, root: opts.writeClones!.root, lagging: clones.lagging(), fallbacks: clones.fallbacks() } : { enabled: false });
  // the Unblocker rubric lives in the repo: the global settings in the team repo's
  // state/unblocker-rubric.json, a milestone's override on its spine's `Unblocker rubric:` line (cycle/rubric.ts).
  const teamDir = () => {
    const p = path.join(read.reposRoot, opts.teamState?.repo || TEAM_REPO_DEFAULT);
    return fs.existsSync(path.join(p, ".git")) ? p : undefined;
  };
  const spineOfMilestone = (id: string) => {
    const m = store.getMilestone(id);
    const dir = m?.path ? (locateDir(m) ?? resolveRepo(read.reposRoot, m.repo)?.path) : undefined;
    return m?.path && dir ? { dir, path: m.path } : undefined;
  };
  bindRubricRepo(db, { teamDir, spineOf: spineOfMilestone, writer: spine, invalidate: dropSpines });
  // the owner's own team state (big roots, the desk's placements and chat) kept in its private repo (the team repo).
  // the tracked milestones and the owner's marks on them live in each world's team repo (state/milestones.json).
  // Only a boot that may write the team repo (the production unit) records there; a local or staging boot keeps it in console.db.
  const teamWrites = opts.teamState?.write ?? teamRepoWrites();
  const milestoneRecord = createMilestoneRecord({ db, reposRoot: read.reposRoot, teamRepo: opts.teamState?.repo, writer: spine, log: (msg) => console.log(msg), off: !teamWrites });
  if (!opts.passive) milestoneRecord.apply(); // a passive console never writes the repo's records into the shared database
  // each persona is a file in the same team repo (state/personas/<name>.md), written first, read back each pass.
  const personaRecord = createPersonaRecord({ db, dirOf: milestoneRecord.dirOf, writer: spine, log: (msg) => console.log(msg) });
  if (!opts.passive) personaRecord.apply(); // a passive console never writes the repo's records into the shared database
  // assignments (cadence, the owner's switch, write grants) and access (service switches, send caps) in the same repo.
  const assignmentRecord = createAssignmentRecord({ db, dirOf: milestoneRecord.dirOf, writer: spine, log: (msg) => console.log(msg) });
  if (!opts.passive) assignmentRecord.apply(); // a passive console never writes the repo's records into the shared database
  const recordedAssignments = () => assignmentRecord.recorded(store);
  /** Store writes to milestones that record first; a file not written is a 409 / 502 and nothing changed. */
  const recordedMilestones = () => milestoneRecord.recorded(store);
  const recordedPersonas = () => personaRecord.recorded(store);
  /**
   * (the owner: "a wheel without a persona is not going to turn"): a milestone created in any
   * world gets that world's Delivery Manager the moment it exists, switched off by default, recorded in the team repo first.
   * A failure never undoes the milestone: GET /api/persona-gaps and the objectives screen flag it.
   */
  const withDeliveryManager = async (m: Milestone): Promise<Milestone> => {
    try {
      if (store.listAssignments({ milestoneId: m.id }).some((a) => isDm(store.getPersona(a.personaId)?.name))) return m;
      const dm = deliveryManagerOf(store.listPersonas());
      if (dm) await recordFirst(() => recordedAssignments().createAssignment({ milestoneId: m.id, personaId: dm.id, cadence: DEFAULT_DM_CADENCE, enabled: false }));
      else console.warn(`no Delivery Manager persona in the world of ${m.id}: the persona check flags it`);
    } catch (e) {
      console.warn(`Delivery Manager not assigned to ${m.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return m;
  };
  const recordFirst = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof RecordError) throw new ApiError(e.status === "failed" ? 502 : 409, e.status === "failed" ? "repo_write_failed" : "repo_write_refused", e.message);
      throw e;
    }
  };
  const team = createTeamState({
    db,
    reposRoot: read.reposRoot,
    repo: opts.teamState?.repo,
    beforeApply: () => void (milestoneRecord.apply(), personaRecord.apply(), assignmentRecord.apply()),
    writer: spine,
    placements: desk.placements,
    transcript: cycleOpts.enabled ? () => desk.transcript() : undefined,
    log: (msg) => console.log(msg),
    readOnly: !teamWrites,
  });
  // a passive console (shared staging) leaves these to the database's own console
  if (!opts.passive) team.restorePlacements();
  // big-root positions come back from state/big-roots.json at boot with the other files, not only on the
  // first team-state pass (15 s later, and never without a timer), so a rebuilt console.db is whole from its first read.
  if (!opts.passive) team.applyBigRoots();
  if (opts.teamState?.everyMs) {
    const tick = () =>
      void team
        .sync()
        .then((r) => Object.keys(r).length && console.log(`team state: ${JSON.stringify(r)}`))
        .catch((e) => console.error("team state:", e));
    setTimeout(tick, 15_000).unref();
    setInterval(tick, opts.teamState.everyMs).unref();
  }
  /** a console change that touches the owner's big roots goes to the team repo (`teamState` in the answer; none = no checkout). */
  // the file first, with the milestones as they will be; not written = the caller's 409 / 502, nothing changed.
  const bigRootsWrite = async (why: string, ms?: Milestone[]) => {
    const w = await team.bigRootsChanged(why, ms).catch((e): SpineWrite => ({ status: "failed", reason: (e as Error).message }));
    if (w && w.status !== "written") throw new ApiError(w.status === "failed" ? 502 : 409, w.status === "failed" ? "repo_write_failed" : "repo_write_refused", `${BIG_ROOTS_FILE} not written (${w.reason ?? w.status}); nothing changed`);
    return w ? { teamState: { file: BIG_ROOTS_FILE, status: w.status, ...(w.sha ? { sha: w.sha } : {}) } } : {};
  };
  /** the home world's milestones after a change to one of them (`m` replaces its row; `drop` takes it out). */
  const homeAfter = (m: Milestone | undefined, drop?: string) => {
    const all = createStore(db, { tenant: DEFAULT_TENANT }).listMilestones({ includeSettled: true }).filter((x) => x.id !== drop && x.id !== m?.id);
    return m && !drop ? [...all, m] : all;
  };
  // the Epic Books' daily refresh (pull, capability probe committed through the spine writer, rebuild), recorded.
  const bookRefresh = book
    ? createBookRefresh({
        db,
        repos: () => listRepos(read.reposRoot),
        book,
        invalidate: dropSpines,
        pull: opts.bookRefresh?.pull ?? createRepoPuller({ git: (dir, args) => gitOut(120_000)(dir, args).then(() => undefined) }).pull,
        probe: opts.bookRefresh?.probe ?? realProbe({ base: process.env.CONSOLE_BROWSER_API || undefined }),
        writer: spine,
        ...(opts.bookRefresh?.now ? { now: opts.bookRefresh.now } : {}),
      })
    : undefined;
  if (bookRefresh && opts.bookRefresh?.tickMs) phased(opts.timerPhases, "bookRefresh", () => bookRefresh.start(opts.bookRefresh!.tickMs!));
  // the secret store is a hosted plug (hosted/secrets.ts: Secrets page, per-world stores); the
  // one-team core keeps no keys (no Secrets routes, a key ask answers that nothing was stored).
  const secretsArea = hostedPlugs.find((p) => p.secrets)?.secrets?.({ api, db, reposRoot: read.reposRoot, spine, secretPut: opts.secretPut, secrets: opts.secrets, worldSecretsKey: opts.worldSecretsKey });
  // "done, waiting for your review" next to "waiting on you" on the Team home.
  // a card is a spine row in `review` (the read model's review view); the owner's buttons write the row.
  // held posts are cards in the same list (bound once the social writer is mounted, below)
  let postReview: PostReview | undefined;
  // a card the owner approved closes the open asks it clearly settles (bound once the inbox is mounted, below)
  let settleApproved: ((r: { ref: string; repo: string; path: string; title: string; by: string; sha?: string }) => void) | undefined;
  // the asks log, bound once it is made (below): a duplicate tap on a review card writes into it
  let askLogRef: { duplicate: (d: { ref: string; repo: string; row: string; what: string; words: string; at?: string }) => Promise<unknown> } | undefined;
  const review = createReview(db, {
    store,
    posts: () => postReview,
    onApproved: () => settleApproved,
    // E948-S139: a card closed as Duplicate or already answered goes into the ask gate's repeat memory (the asks log)
    onDuplicate: () => (d) => askLogRef?.duplicate(d),
    reposRoot: read.reposRoot,
    writer: spine,
    ...(readModel ? { readModel } : {}),
    world: viewWorld,
    cycle: cycle.enabled ? cycle : undefined,
    live: opts.review?.live ?? liveCheckDepsFromEnv({ port: Number(process.env.PORT || 8750), host: process.env.HOST, repoDir: resolveRepo(read.reposRoot, homeRepo())?.path }),
    wrote: dropSpines,
    // New iteration on a held one-pager draft goes to its campaign's chat (the Repo desk that drafted it).
    chatRelaunch: (mid, text) => milestoneChats.send(mid, text, undefined, `onepager-relaunch:${mid}:${Date.now()}`),
    // test goals' rows show as cards on staging only
    showTest: process.env.REVIEW_SHOW_TEST_CARDS === "1",
    // the daily press test's presses say so in the TEST commits (they said "the owner")
    who: () => {
      const i = currentAuth()?.identity;
      return i?.kind === "legacy" && i.peer === PRESS_TEST_RUN ? "the daily press test" : ownerName();
    },
  });
  mountReview(api, review, store, attachments, () => worldPriorities(store, read.reposRoot));
  // the card quality check's model (scripts/card_qc.py on the worker host sends the screens and his words)
  mountQcJudge(api, opts.qcJudge ?? anthropicQcJudge(anthropicKey));
  // a card whose row left review before his press (another press, the team moved it) is found in its earlier
  // landed presses (their answer holds the card's row), so his words still land on that row and are never refused.
  cardOfPress = (id) => review.card(id) ?? cardFromPresses(db, id);
  // after a card closes: Add comment (a last thought, any time later) and Bring it back once the press landed.
  const afterClose = createAfterClose({ db, showTest: process.env.REVIEW_SHOW_TEST_CARDS === "1", store, reposRoot: read.reposRoot, writer: spine, cycle: cycle.enabled ? cycle : undefined, wrote: dropSpines, ...(attachments ? { attachments } : {}), who: () => (currentAuth()?.identity?.kind === "legacy" && (currentAuth()?.identity as { peer?: string }).peer === PRESS_TEST_RUN ? "the daily press test" : ownerName()) });
  mountAfterClose(api, afterClose);
  flagHeldRow = async (p) => {
    const card = heldCard(p, (id) => review.cardFresh(id));
    if (!card) return undefined;
    return afterClose.flagRow({ kind: "review", ...card }, heldRowBrief(p, card), `held-row:${card.repo}:${card.ref}:${(p.heldAt ?? p.at).slice(0, 13)}`);
  };
  // every card he sent back stays on his inbox, marked in progress with its worker, until it returns to review
  const sentBackDeps = { store, reposRoot: read.reposRoot, goals: () => review.goals(), rows: () => review.rows(), recent: (o: { days: number; limit: number; world?: string }) => afterClose.recent(o), world: () => whoPressed().tenant };
  mountSentBack(api, sentBackDeps);
  // (the owner 23 Nov 00:29Z): a card he sent back that the team closed is reopened, and any answer of his with
  // no worker and no new round after 15 minutes gets its worker from the console itself, through the one work queue.
  const pickup = createPickup({
    store,
    reposRoot: read.reposRoot,
    list: () => createSentBack(sentBackDeps).list(),
    recent: (o) => afterClose.recent(o),
    writer: spine,
    wrote: dropSpines,
    cancel: (runId: string, why: string) => void store.updateRun(runId, { outcome: "idle", endedAt: new Date().toISOString(), summary: why }),
    ...(cycle.enabled ? { launch: (aid: string, i: WorkerLaunchInput) => cycle.launchPickup(aid, i), wake: (aid: string, o: { instructions: string; instructionsBy: string }, key: string) => cycle.runNowRequest(aid, o, key) } : {}),
  });
  pickupRef.current = pickup;
  api.get("/pickup", (c) => c.json({ afterMin: pickup.afterMin, everyMs: PICKUP_TICK_MS, last: pickup.last() ?? null, waiting: pickup.waiting() }));
  const pickupMs = opts.pickupMs ?? (opts.passive || process.env.VITEST || process.env.CONSOLE_STAGING === "1" || process.env.CONSOLE_PICKUP === "0" ? 0 : PICKUP_TICK_MS);
  if (pickupMs > 0 && cycle.enabled) {
    const run = () => void outsideRequest(() => pickup.tick().catch((e) => console.error("pickup:", e instanceof Error ? e.message : e)));
    setTimeout(run, 90_000).unref();
    setInterval(run, pickupMs).unref();
  }
  // the owner's red line (docs/pursuits.json `redLines` when it holds them, else the Prioritizer's docs/priorities.json), the band on top of the Team home.
  // several named lines (`redLines`, the first leads); `redLine` stays the first one for older screens.
  // a line's live counts (the memory service's public counts) are read here, at most once an hour.
  api.get("/red-line", async (c) => {
    const redLines = await withCounts(worldRedLines(store, read.reposRoot)); // counts: hooks.counts (hosted: remoteCounts)
    return c.json({ redLine: redLines[0] ?? null, redLines });
  });
  // the order the inbox follows by itself: his objectives in his order (docs/pursuits.json); the first one's items lead every list.
  api.get("/inbox-first", (c) => c.json({ objectives: worldObjectives(store, read.reposRoot) }));
  //..S9: the Company view (its companies, the Promo, Operations and Build wheels, the social product worlds' items) and
  //'s uptime checks every 5 minutes (opts.uptimeProbe, off in tests): the tenancy plug's (hosted/tenancy.ts).
  const buildSpinesOf = read.spines ? softSpines(read.spines) : undefined;
  // parked by the owner 2026-11-12 (company level is for the future): off unless CONSOLE_COMPANY_VIEW=1 (companies.ts).
  const companyViewOff = async (c: Context, next: () => Promise<void>) => {
    if (companyViewOn() || companyPathStaysOff(c.req.path)) return next();
    return c.json({ error: { code: "company_view_off", message: "the Company view is parked (CONSOLE_COMPANY_VIEW is off)" } }, 404);
  };
  if (tenancy) {
    api.use("/companies", companyViewOff);
    api.use("/companies/*", companyViewOff);
  }
  tenancy?.mountCompanies({
    api,
    db,
    reposRoot: read.reposRoot,
    social,
    sitesDaily: (w) => socialArea?.sitesDaily(store, w) ?? [],
    spinesOf: async (dir) => (buildSpinesOf ? buildSpinesOf(dir, 4_000) : undefined),
    memberships: (userId) => auth.memberships(userId),
    get: (p) => Promise.resolve(app.fetch(new Request(`http://console.local/api${p}`, { method: "GET" }))),
    uptimeEveryMs: companyViewOn() ? opts.uptimeProbe?.everyMs : undefined,
  });
  // what the owner builds (docs/building.json of the code repo), each list's named campaigns and what waits on him, read from the spines.
  api.get("/building", (c) => c.json({ lists: readBuilding(read.reposRoot) }));
  // the owner's pursuits (docs/pursuits.json of the code repo): scorecard, totems, moving or stalled (pursuits.ts).
  // one-offs: rows titled `One-off:` in the home repo's spines and every row of docs/spines/one-offs.md, by stage.
  const oneOffs = createOneOffs({ reposRoot: read.reposRoot });
  api.get("/one-offs", (c) => c.json(oneOffs.get()));
  // one request, one row: his requests in every chat (the Team desk, each objective's chat, each workspace desk) with the ticket rows
  // holding each one now, from the chats' last views; the hosted request check adds them.
  api.get("/requests", async (c) => {
    const hours = Math.min(168, Math.max(1, Number(c.req.query("hours")) || 24));
    await requestRows.ready();
    return c.json(requestsIn(db, requestRows, Date.now() - hours * 3_600_000));
  });
  // the outcome log: one line per real outcome in docs/outcomes/<day>.jsonl of the run's repo (root L-45),
  // written by the run PATCH's `outcomes` or POST /api/outcomes, read back filterable by persona, product, row, kind, day.
  // what counts as an outcome, per persona: the home repo's docs/outcomes/what-counts.json.
  setOutcomeDefsDir(resolveRepo(read.reposRoot, homeRepo())?.path);
  const outcomes = createOutcomes({ store, reposRoot: read.reposRoot, writer: spine, spineOf: (id) => spineOfMilestone(id), wrote: (dir) => dropSpines(dir) });
  mountOutcomes(api, () => outcomes, store);
  // the asks log: every ask to the owner (what, why only him, tries and minutes, his verdict, the ask gate's dry run) in
  // the home repo's docs/asks/log.jsonl, swept every 10 min from the inbox, the answers and the steps pages.
  const askLog = createAskLog({
    db,
    dir: () => resolveRepo(read.reposRoot, homeRepo())?.path,
    writer: spine,
    wrote: (dir) => dropSpines(dir),
    log: (msg) => console.log(msg),
    // the Mac list as the laptop switch reads it (hosted layer; a console without it, or a list not read, closes no ticket)
    macOpen: async () => {
      const ctx = { mode: opts.auth ?? authModeFromEnv(), identity: { kind: "legacy" as const, tenant: DEFAULT_TENANT, peer: "asks-log", host: true as const }, via: "gateway" as const };
      const scoped = ctx.mode === "on" ? { ...ctx, scope: DEFAULT_TENANT } : ctx;
      const res = await runWithAuth(scoped, async () => app.fetch(new Request("http://console.local/api/laptop", { headers: { "x-console-run": "asks-log" } })));
      if (!res.ok) return undefined;
      const v = (await res.json()) as { tasks?: { row?: string }[]; done?: { row?: string }[]; held?: string[]; tasksError?: string };
      if (v.tasksError || !Array.isArray(v.tasks) || !Array.isArray(v.held)) return undefined;
      const rows = [...v.tasks, ...(v.done ?? [])].map((t) => t.row).filter((r): r is string => !!r);
      // an empty list may be a page that failed to build: close nothing on it
      return rows.length + v.held.length ? new Set([...rows, ...v.held.map((k) => k.split("#").pop()!)]) : undefined;
    },
    asks: async () => {
      const ctx = { mode: opts.auth ?? authModeFromEnv(), identity: { kind: "legacy" as const, tenant: DEFAULT_TENANT, peer: "asks-log", host: true as const }, via: "gateway" as const };
      const scoped = ctx.mode === "on" ? { ...ctx, scope: DEFAULT_TENANT } : ctx;
      const res = await runWithAuth(scoped, async () => app.fetch(new Request("http://console.local/api/waiting-on-owner?includeSettled=1", { headers: { "x-console-run": "asks-log" } })));
      if (!res.ok) throw new Error(`inbox list: HTTP ${res.status}`);
      return (await res.json()) as WaitingLike[];
    },
  });
  mountAskLog(api, () => askLog);
  askLogRef = askLog;
  if (!opts.passive && teamWrites && !process.env.VITEST) askLog.start(Number(process.env.CONSOLE_ASK_LOG_MS ?? 600_000));
  // a workspace connected to a repo that holds a workspace reads that repo's own objectives and key results
  // (its checkout's docs/pursuits.json and scorecards), never the home world's (routeScope: connected worlds only).
  const worldGoals = new Map<string, { pursuits: ReturnType<typeof createPursuits>; at: number }>();
  const connectedWorld = () => {
    const w = credentialWorld();
    const c = w && w !== DEFAULT_TENANT ? connectedRepo(db, w) : undefined;
    return w && c && !c.made ? w : undefined; // a new repo made from the starter keeps Get set up
  };
  const worldPursuits = (w: string) => {
    let e = worldGoals.get(w);
    if (!e || Date.now() - e.at > 30 * 60_000) {
      e = { pursuits: createPursuits({ reposRoot: read.reposRoot, board: () => null, git: gitOut(20_000), home: w, repoDir: worldRepoDir(read.reposRoot, db, w) }), at: Date.now() };
      worldGoals.set(w, e);
    }
    return e.pursuits;
  };
  const worldScorecards = async (w: string) => {
    const dirOf = worldRepoDir(read.reposRoot, db, w);
    const spine = createSpineFileReader(dirOf);
    const file = (id: string) => {
      const dir = dirOf(w);
      if (!dir || !/^[\w-]{1,80}$/.test(id)) return undefined;
      try {
        return fs.readFileSync(path.join(dir, SCORECARD_DIR, `${id}.json`), "utf8");
      } catch {
        return undefined;
      }
    };
    return buildScorecards(withMilestones(await worldPursuits(w).get(), forTenant(db, w)), spine, { file, work: createWorkFinder(dirOf, spine), homeRepo: w });
  };
  mountWorldRepo(api, { db, reposRoot: read.reposRoot, worldOf: credentialWorld });
  // Connect GitHub for a customer workspace (the owner allows the app on GitHub, then picks or makes
  // one repo). Mounted before mountOAuth: both answer GitHub's one callback, this one only for a state it made.
  const githubCreds = storeCreds({});
  mountWorldGithub(api, {
    db,
    reposRoot: read.reposRoot,
    worldOf: credentialWorld,
    creds: () => githubCreds("github", "team"),
    ...(secretsArea
      ? {
          storeKey: async (name: string, value: string, note: string) => {
            const r = await secretsArea.addKey({ app: "agent-team-console", name, value, note, replace: true });
            return r.ok ? { ok: true as const } : { ok: false as const, message: `${r.code}: ${r.message}` };
          },
          readKey: (name: string) => sudoRead(keyFile(name)),
          keyFile,
        }
      : {}),
  });
  api.get("/pursuits", async (c) => {
    const w = connectedWorld();
    if (w) return c.json(withMilestones(await worldPursuits(w).get(), forTenant(db, w)));
    return c.json(withMilestones(await pursuits.get(), store, pursuitEffort));
  });
  // goal sets: every pursuit a scorecard, its epics scorecards inside it, each with its queue and the codes its inbox matches.
  const scorecardSpine = createSpineFileReader((name) => resolveRepo(read.reposRoot, name)?.path);
  // one file per goal set: docs/scorecards/<pursuit id>.json in the home repo (its Objective and declared rows).
  const scorecardFile = (id: string) => {
    const home = pursuits.homeDir();
    if (!home || !/^[\w-]{1,80}$/.test(id)) return undefined;
    try {
      return fs.readFileSync(path.join(home, SCORECARD_DIR, `${id}.json`), "utf8");
    } catch {
      return undefined;
    }
  };
  const scorecardWork = createWorkFinder((name) => resolveRepo(read.reposRoot, name)?.path, scorecardSpine);
  // rows turned green today and this week: a small file beside the console's database (launch-board.json's folder).
  const greenHistory = createGreenHistory(process.env.CONSOLE_GOAL_SETS_HISTORY || (opts.launchBoard?.cacheFile ? path.join(path.dirname(opts.launchBoard.cacheFile), "goal-sets-history.json") : undefined));
  // one build shared by every reader for 20 s (the kept answer below, the idle marks, the objectives block, key results):
  // each was its own full build, about 0.25 s of CPU on a quiet host, seconds on a busy one.
  const scorecardsBuilt = answerCache<ScorecardsBody>({ ttlMs: 20_000 });
  const scorecardsNow = () =>
    scorecardsBuilt.get("home", async () => applyLiveKeyResults(buildScorecards(withMilestones(await pursuits.get(), store, pursuitEffort), scorecardSpine, { file: scorecardFile, work: scorecardWork, homeRepo: homeRepo() })));
  // objectives below green, idle or not: the idle pill, and the Delivery Manager's regular wake reads its milestone's.
  const idleWatch = createIdleWatch({
    scorecards: scorecardsNow,
    claims: () =>
      store
        .listMilestones()
        .filter((m) => worldOf(m.id) === DEFAULT_TENANT && !m.settledAt)
        .flatMap((m) => store.listRunningChildRuns(m.id).map((r) => ({ ticket: rowOf(r.summary), runId: r.id, assignmentId: r.assignmentId, persona: "", milestoneId: r.milestoneId ?? m.id, summary: r.summary }))),
    waiting: (id) => waitingFor(id),
    held: async (id) => {
      const m = store.getMilestone(id);
      return m ? (await waitingAndHeld(inboxDeps, m)).held : [];
    },
    milestoneRepo: (id) => store.getMilestone(id)?.repo,
  });
  objectivesOf = (m) => idleWatch.forMilestone(m.id);
  idleWatch.mount(api);
  // the home world's scorecards, read by every open tab and the sidebar: kept ready in the background, so
  // the request only sends bytes. Rebuilt when a spine, a scorecard file or the objectives file changes (checked every
  // 15 s, at most one build a minute) and every 3 minutes whatever changed (milestones, asks, idle marks).
  const keptScorecards = keptJson({
    build: async () => greenHistory(await idleWatch.decorate(await scorecardsNow())),
    checkMs: 15_000,
    minGapMs: 60_000,
    everyMs: 3 * 60_000,
    // a restart serves the last good scorecards at once and rebuilds behind them (beside console.db)
    ...(opts.readModel?.dbPath && process.env.CONSOLE_KEPT_FILES !== "off" ? { file: path.join(path.dirname(opts.readModel.dbPath), "kept", "scorecards.json") } : {}),
    signature: () => {
      const home = pursuits.homeDir();
      const inHome = (rel: string) => {
        try {
          return `${rel}@${fs.statSync(path.join(home ?? "", rel)).mtimeMs}`;
        } catch {
          return `${rel}@none`;
        }
      };
      let cards: string[] = [];
      try {
        cards = home ? fs.readdirSync(path.join(home, SCORECARD_DIR)).sort().map((f) => inHome(`${SCORECARD_DIR}/${f}`)) : [];
      } catch {
        /* no scorecards folder */
      }
      return [inHome("docs/pursuits.json"), ...cards, scorecardSpine.signature()].join("|");
    },
    log: (m) => console.warn(m),
  });
  api.get("/scorecards", async (c) => {
    const w = connectedWorld();
    if (w) return c.json(await worldScorecards(w));
    return sendPrepared(c, await keptScorecards.get());
  });
  // the ticket index, read only (scripts/ticket_index.py builds it from every spine; the Board, Key results
  // and Inbox read their rows from it). ?repo= ?state= ?world= ?id= ?open=1; the home world's only (routeScope).
  // Beside GET /tickets (the Tickets page's ticket files and issues, routes/read.ts), never in its place.
  api.get("/tickets/index", (c) => {
    const q = (k: string) => c.req.query(k)?.trim() || undefined;
    const index = ticketIndex();
    const tickets = index.tickets({ repo: q("repo"), state: q("state")?.toLowerCase(), world: q("world"), id: q("id"), open: q("open") === "1" });
    return c.json({ index: index.stats() ?? null, count: tickets.length, tickets });
  });
  // an objective's one where-we-are: docs/scorecards/<id>.md beside its key results, the top of its Context tab.
  api.get("/scorecards/:id/where-we-are", (c) => {
    const w = connectedWorld();
    const v = readWhereWeAre(w ? worldRepoDir(read.reposRoot, db, w)(w) : pursuits.homeDir(), c.req.param("id"));
    return v ? c.json(v) : c.json({ error: { code: "not_found" } }, 404);
  });
  // an objective's Plan tab: its wheel's plan, how each key result gets to green (steps, owners, dates), from the
  // `plan` block of docs/scorecards/<id>.json.
  api.get("/pursuits/:id/plan", (c) => {
    const w = connectedWorld();
    const v = readWheelPlan(w ? worldRepoDir(read.reposRoot, db, w)(w) : pursuits.homeDir(), c.req.param("id"));
    return v ? c.json(v) : c.json({ error: { code: "not_found", message: `no objective ${c.req.param("id")}` } }, 404);
  });
  // his objectives as every agent rereads them (the objectives screen's lights and today's count, his words from
  // his words per objective, the Red lines): one block, kept a minute, for every home-world wake, the worker rules and GET /objectives.
  let objectivesMemo: { at: number; v: { block: string; line: string; chapters?: string } } | undefined;
  let objectivesInputMemo: { at: number; v: Promise<ObjectivesInput> } | undefined;
  // the last finished build: a reader after the minute gets it at once while one rebuild runs (a rebuild took up to
  // 68 s on a busy main server and every reader waited on it, his chat sends too).
  let objectivesInputLast: ObjectivesInput | undefined;
  ownerObjectivesInput = () => {
    if (!objectivesInputMemo || Date.now() - objectivesInputMemo.at >= 60_000) {
      const v = (async () => greenHistory(await idleWatch.decorate(await scorecardsNow())) as ObjectivesInput)();
      objectivesInputMemo = { at: Date.now(), v };
      v.then((x) => (objectivesInputLast = x)).catch(() => (objectivesInputMemo = undefined));
    }
    return objectivesInputLast ? Promise.resolve(objectivesInputLast) : objectivesInputMemo.v;
  };
  ownerObjectivesNow = async () => {
    if (objectivesMemo && Date.now() - objectivesMemo.at < 60_000) return objectivesMemo.v;
    const body = await ownerObjectivesInput!();
    const home = pursuits.homeDir();
    const plot = home ? readHisWords(path.dirname(home), path.basename(home)) : undefined;
    //: every wake and worker is told its chapters at birth, read from each product's graph file.
    const chapters = chaptersLine(readChapters(home));
    const v = { block: objectivesBlock(body, plot, readRedLines(home), chapters), line: objectivesOneLine(body, plot), chapters };
    objectivesMemo = { at: Date.now(), v };
    return v;
  };
  // every milestone and objective (every world, his other worlds too) with no Delivery Manager turning it.
  api.get("/persona-gaps", async (c) => {
    const caller = credentialWorld();
    if (caller && caller !== DEFAULT_TENANT) return c.json({ error: { code: "not_found", message: "the persona check is the home world's" } }, 404);
    const all = createStore(db);
    const world = (id: string) => all.worldOfMilestone(id) ?? DEFAULT_TENANT;
    const body = await pursuits.get().catch(() => undefined);
    const home = pursuits.homeDir();
    let other: ObjectiveIn[] = [];
    try {
      const f = home ? (JSON.parse(fs.readFileSync(path.join(home, "docs/pursuits.json"), "utf8")) as { otherWorlds?: { id: string; name: string; repo: string; spine: string }[] }) : {};
      other = (f.otherWorlds ?? []).map((w) => ({ id: w.id, name: w.name, epics: [{ repo: w.repo, spine: w.spine }] }));
    } catch {
      /* no file: his pursuits only */
    }
    const objectives: ObjectiveIn[] = [...(body?.pursuits ?? []).filter((p) => !p.parked).map((p) => ({ id: p.id, name: p.name, epics: p.epics })), ...other];
    const every = [...objectiveGaps(objectives, all, world), ...milestoneGaps(all, world)];
    const gaps = every.filter((g) => !isTestWorld(g.world));
    return c.json({ ok: !gaps.some(isGap), gaps, testsLeftOut: every.length - gaps.length, checked: { objectives: objectives.length, milestones: all.listMilestones().filter((m) => !m.settledAt && !m.paused).length }, at: new Date().toISOString() });
  });
  api.get("/objectives", async (c) => c.text(((await ownerObjectivesNow!().catch(() => undefined))?.block || "No objectives read.") + "\n"));
  // each objective's key results as the page shows them (its file's, a ticked Done-means box green), for the
  // WhatsApp line when one turns green or red. A TEST objective (its id or its repo says test) is marked TEST.
  keyResultsNow = async () =>
    (await scorecardsNow()).nodes.flatMap((n) =>
      (n.keyResults ?? []).map((k) => ({
        key: `${n.id}|${k.label}`,
        objective: n.headline ?? n.objective ?? n.name,
        label: k.label,
        state: k.state,
        ...(k.value ? { value: k.value } : {}),
        ...(k.note ? { note: k.note } : {}),
        ...(k.doneMeans ? { doneMeans: k.doneMeans } : {}),
        ...(isTestItem({ repo: n.spineRef?.repo ?? n.repo, code: n.id }) ? { test: true } : {}),
      })),
    );
  // his order and his park switch, one commit each in the code repo (the file is the record, root L-45).
  // his objectives and scorecards live in the workspace data repo: when a pull moves it, the next read shows the change.
  objectivesPulled = (dir) => {
    const home = pursuits.homeDir();
    const data = home ? path.resolve(workspaceDataDir(home)) : undefined;
    if (!data || data === path.resolve(home!) || data !== path.resolve(dir)) return false;
    pursuits.clear();
    scorecardsBuilt.clear();
    objectivesMemo = undefined;
    void keptScorecards.refresh();
    return true;
  };
  mountPursuitWrites(api, { writer: spine, repo: () => pursuits.homeDir(), who: () => ownerName(), wrote: (dir) => (pursuits.clear(), dropSpines(dir), scorecardsBuilt.clear(), void keptScorecards.refresh()) });
  // the team's own inbox cards (a digest per scorecard a day, strategic ideas, goal conversations), docs/inbox/cards.json.
  // a card world's (the social world's) idea cards live in one of its own repos; the world is already a card world's
  // (code-chosen), so its repos are looked up unscoped: the owner's inbox reads them from the home world.
  const cardStore = createStore(db);
  mountTeamCards(api, { writer: spine, repo: () => pursuits.homeDir(), objectives: () => objectiveIds(pursuits.homeDir()), worldRepo: (w) => cardRepoOf(w, worldRepos(db, cardStore, read.reposRoot, w)), rowOf: (by) => standingRow(pursuits.homeDir(), by) });
  // every one-off page the team serves, grouped by repo and epic (docs/pages/registry.json, pagesIndex.ts).
  const pagesList = createPagesReader({ reposRoot: read.reposRoot });
  // a page on a steps page's host opens its secure copy, where Voice records at the first press
  api.get("/pages", (c) => c.json(secureDeep(pagesList.get())));
  api.get("/pages/pinned", (c) => c.json(secureDeep({ pinned: pagesList.pinnedList() })));
  // a pinned page's last refresh, and its Refresh button (reruns the unit its repo entry names, on the page host).
  api.get("/pages/pinned/:port/status", async (c) => {
    const p = pagesList.pinned({ port: Number(c.req.param("port")) });
    return p ? c.json(await pinnedStatus(p)) : c.json({ error: "no pinned page on that port" }, 404);
  });
  api.post("/pages/pinned/:port/refresh", async (c) => {
    const p = pagesList.pinned({ port: Number(c.req.param("port")) });
    if (!p) return c.json({ error: "no pinned page on that port" }, 404);
    if (!p.refresh) return c.json({ error: "this page has no refresh in its entry" }, 409);
    const s = await pinnedStatus(p, fetch, "POST");
    return c.json(s, s.error ? 502 : 202);
  });
  // pin, rename or unpin a page with a plain name, one commit to docs/pages/registry.json (pagePins.ts).
  mountPagePins(api, { writer: spine, repo: () => resolveRepo(read.reposRoot, homeRepo())?.path, who: () => ownerName() });
  // a pinned page's short address (the console/scorecard) opens the page; anything else falls through to the app.
  mountPinnedAddresses(app, (slug) => pagesList.pinned({ slug }), secureDeep);
  // the owner's voice notes in one place with the rows made from each (docs/voice-notes/index.json, voiceNotesIndex.ts).
  const voiceNotesList = createVoiceNotesReader({ reposRoot: read.reposRoot });
  api.get("/voice-notes", (c) => c.json(voiceNotesList.get(c.req.query("product") || undefined)));
  // X stats of the team's six accounts, one file a day (data/x-stats/<date>.json, scripts/x_stats.py).
  const xStats = createXStatsReader({ reposRoot: read.reposRoot });
  api.get("/x-stats", (c) => c.json(xStats.get(c.req.query("date") || undefined)));
  // the one store of every post's numbers per day (post_stats, loaded from those files): a campaign's status is read
  // here (?date&product&campaign&channel&message&group=message|channel|message-channel|campaign|post).
  const postStats = createPostStats({ db, reposRoot: read.reposRoot });
  api.get("/post-stats", (c) => {
    const q = (k: string) => c.req.query(k) || undefined;
    return c.json(postStats.query({ date: q("date"), product: q("product"), campaign: q("campaign"), channel: q("channel"), message: q("message"), group: q("group") }));
  });
  // the rules every worker brief carries verbatim, fresh from this release (a manager's brief helper reads them);
  // ?repo=<row's repo>&title=<row title> adds the owner's view only for a row on its topic (docs/his-views.json)
  // root L-77: the map. Every product's totems (the hardwired nodes of its data graph), one totem's content
  // for its tab on the objective screen (an empty one says where it will live), and the section a wake prompt carries.
  api.get("/totems", (c) => c.json(totemMaps()));
  api.get("/totems/:product/prompt", (c) => {
    const maps = totemMaps();
    const p = maps.products.find((x) => x.product === c.req.param("product"));
    return p ? c.text(mapSection(maps, p) + "\n") : c.json({ error: "not_found" }, 404);
  });
  api.get("/totems/:product/:totem", (c) => {
    const v = totemView({ maps: totemMaps(), product: c.req.param("product"), totem: c.req.param("totem"), repoDir: (r) => resolveRepo(read.reposRoot, r)?.path, board: () => launchBoard?.board() ?? null });
    return v ? c.json(v) : c.json({ error: "not_found" }, 404);
  });
  // every file homed in a tab, listed for that tab (docs/totems/<product>.json wheel tabs' `homes`), newest
  // first, each opening read-only below /api/homes/file/<repo>/<path>. The owner's two worlds only: the home world
  // (an objective's Pages) and the social world (a campaign's History); any other world gets none.
  const homeTabs = createHomeTabs({ wheels: () => readHomeWheels(totemHome()), repoDir: (r) => resolveRepo(read.reposRoot, r)?.path });
  const placeHomes = createPlacer(totemHome);
  const homesHome = () => { const w = credentialWorld(); return !w || w === DEFAULT_TENANT || w === socialWorld(); };
  api.get("/homes/file/:repo/*", async (c) => {
    if (!homesHome()) return c.json({ error: { code: "not_found" } }, 404);
    const repo = c.req.param("repo");
    const prefix = `/api/homes/file/${repo}/`;
    const at = c.req.path.indexOf(prefix);
    const rel = at < 0 ? "" : decodeURIComponent(c.req.path.slice(at + prefix.length));
    const a = await readHomeFile({ wheels: readHomeWheels(totemHome()), repo, rel, repoDir: resolveRepo(read.reposRoot, repo)?.path });
    if (a.status !== 200) return c.json({ error: a.error }, a.status);
    const headers: Record<string, string> = { "content-type": a.type, "cache-control": "private, max-age=60", "x-content-type-options": "nosniff" };
    // a team page runs in its own origin, never with the console's sign-in (scripts and links still work).
    if (a.sandbox) headers["content-security-policy"] = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms";
    return c.body(typeof a.body === "string" ? a.body : new Uint8Array(a.body), 200, headers);
  });
  api.get("/homes/:product/:tab", async (c) => {
    if (!homesHome()) return c.json({ error: { code: "not_found" } }, 404);
    const product = c.req.param("product"), tab = c.req.param("tab");
    // `all`: that tab of every product that has one (an objective of any product shows the pages made for it).
    const b = product === "all" ? await homeTabs.all(tab) : await homeTabs.get(product, tab);
    // each file with the objective it was made for when its row's spine sits in no objective's tree (homePlace.ts).
    return b ? c.json({ ...b, entries: placeHomes(b.entries) }) : c.json({ error: { code: "not_found" } }, 404);
  });
  // a wheel's tracker tables (shortlists: entries, status, columns), the frame's, its product's and its own.
  // the wheel as one record: objective, key results, map, trackers, plan and personas joined in one place
  // (wheel.ts); scripts/wheel.py reads these. Home world only, as the objectives file is.
  const wheels = () => wheelReader(totemHome(), storePersonas(createStore(db)));
  const homeOnly = () => { const w = credentialWorld(); return !w || w === DEFAULT_TENANT; };
  api.get("/wheels", (c) => (homeOnly() ? c.json({ wheels: wheels().all() }) : c.json({ error: { code: "not_found" } }, 404)));
  api.get("/wheels/:id", (c) => {
    const w = homeOnly() ? wheels().one(c.req.param("id")) : null;
    return w ? c.json(w) : c.json({ error: { code: "not_found" } }, 404);
  });
  api.get("/trackers/:wheel", (c) => {
    const v = wheelTrackers(totemHome(), c.req.param("wheel"));
    return v ? c.json(v) : c.json({ error: "not_found" }, 404);
  });
  // the wheel's persona log (every step an agent took on it, what and why, asked or chosen) and his label on
  // a step nobody asked for, one tap, committed to the home repo (personaLog.ts); `milestone:<id>` reads a campaign's.
  // the wheel's Consumption chapter: its share of his whole AI subscription and of what was used this week,
  // and each persona's part with what it made true, from docs/consumption/latest.json (consumption.ts); `all` for every wheel.
  api.get("/consumption/:wheel", (c) => {
    if (!homeOnly()) return c.json({ error: { code: "not_found" } }, 404);
    return c.json(readConsumption(totemHome(), c.req.param("wheel")));
  });
  api.get("/persona-log/:wheel", (c) => {
    if (!homeOnly()) return c.json({ error: { code: "not_found" } }, 404);
    const days = Math.min(30, Math.max(1, Number(c.req.query("days")) || 7));
    return c.json(readPersonaLog(totemHome(), c.req.param("wheel"), days));
  });
  api.post("/persona-log/labels", async (c) => {
    // a person's login in the home world labels (the owner's, plain or not); an agent's token or a host's trust never does
    const a = currentAuth();
    const person = (a?.identity?.kind === "session" && !a.identity.door) || (a?.mode === "off" && hasOwnerPower(a?.identity, a?.mode));
    if (!homeOnly() || !person) return c.json({ error: { code: "forbidden", message: "only the owner labels a step" } }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { id?: unknown; label?: unknown };
    if (!isStepId(body.id) || !isStepLabel(body.label)) return c.json({ error: { code: "validation_error", message: "id (a run id) and label (correct, incorrect or clear)" } }, 400);
    const home = totemHome();
    if (!home) return c.json({ error: { code: "conflict", message: "no checkout of the home repo: nothing written" } }, 409);
    const id = body.id, label = body.label;
    const w = await spine.edit({
      repoDir: home,
      path: PERSONA_LOG_LABELS,
      label: `persona log label ${id}`,
      edit: (text) => ({
        text: labelEdit(text, id, label, ownerName()),
        msg: `Persona log: ${ownerName()} labelled ${id.slice(0, 12)} ${label} (via console)`,
        body: `${ownerName()} labelled one step of the persona log on a wheel's Log tab. Labels live in ${PERSONA_LOG_LABELS}, never in console.db.`,
      }),
    });
    if (w.status !== "written") return c.json({ error: { code: w.status === "failed" ? "git_failed" : "conflict", message: `nothing written: ${w.reason ?? w.status}` } }, w.status === "failed" ? 502 : 409);
    return c.json({ id, label, sha: w.sha }, 201);
  });
  api.get("/worker-rules", async (c) => {
    const owned = await ownerObjectivesNow?.().catch(() => undefined);
    const line = owned?.line;
    const repo = c.req.query("repo"), title = c.req.query("title");
    let views: HisView[] = [];
    if (repo || title) {
      const home = resolveRepo(read.reposRoot, homeRepo())?.path;
      try {
        views = hisViewsFor({ repo, title }, JSON.parse(fs.readFileSync(`${home}/docs/his-views.json`, "utf8")).views ?? []);
      } catch { views = []; }
    }
    return c.text(workerBriefRules(line || undefined, views, owned?.chapters || undefined).map((r) => `"${r}"`).join("\n") + "\n");
  });
  // the row's "Context to read first" (docs/context/<row>.md in its repo), the section every worker brief opens with.
  // It ends with the key result the row hangs under (or that it hangs under none and how to place it).
  api.get("/ticket-context", async (c) => {
    const row = c.req.query("row") ?? "", repo = c.req.query("repo") || homeRepo();
    const text = readTicketContext(resolveRepo(read.reposRoot, repo)?.path, row);
    let kr = "";
    try {
      kr = ownerObjectivesInput ? keyResultLines(await ownerObjectivesInput(), row, repo, (id, n) => keyResultPlanText(readWheelPlan(pursuits.homeDir(), id)?.keyResults.find((k) => k.kr === n))) + "\n" : "";
    } catch {
      kr = "";
    }
    return c.text((text ?? contextMissing(row, repo)) + kr, text ? 200 : 404);
  });
  // a pursuit's social kit, shown inside the console on the pursuit's own page (its kit.json, previews and fonts).
  api.get("/pursuits/:id/kit", (c) => {
    const k = pursuits.kit(c.req.param("id"));
    return k ? c.json(k) : c.json({ error: "no_kit" }, 404);
  });
  api.get("/pursuits/:id/kit/:kind/:name", async (c) => {
    const kind = c.req.param("kind");
    if (kind !== "previews" && kind !== "fonts") return c.json({ error: "not_found" }, 404);
    const f = await pursuits.kitFile(c.req.param("id"), kind, c.req.param("name"));
    return f ? c.body(new Uint8Array(f.body), 200, { "Content-Type": f.type, "Cache-Control": "private, max-age=300" }) : c.json({ error: "not_found" }, 404);
  });
  // the Products section: each product's deck parts, its kit and the objectives naming it.
  api.get("/products", async (c) => c.json(await products.list()));
  api.get("/products/:id", async (c) => {
    const p = await products.one(c.req.param("id"));
    return p ? c.json(p) : c.json({ error: "not_found" }, 404);
  });
  api.get("/products/:id/kit", (c) => {
    const k = products.kit(c.req.param("id"));
    return k ? c.json(k) : c.json({ error: "no_kit" }, 404);
  });
  api.get("/products/:id/kit/:kind/:name", async (c) => {
    const kind = c.req.param("kind");
    if (kind !== "previews" && kind !== "fonts") return c.json({ error: "not_found" }, 404);
    const f = await products.kitFile(c.req.param("id"), kind, c.req.param("name"));
    return f ? c.body(new Uint8Array(f.body), 200, { "Content-Type": f.type, "Cache-Control": "private, max-age=300" }) : c.json({ error: "not_found" }, 404);
  });
  // the owner's "wrong place" marks on a landing report's tree, one commit each in the code repo (landing.ts).
  mountLandingMarks(api, { writer: spine, repo: () => resolveRepo(read.reposRoot, homeRepo())?.path, who: () => ownerName(), wrote: dropSpines });

  // who holds each row (GET /api/claims, the home world) and the lease sweep: a lease that ran out (no commit naming
  // the row) gives the row back to ready through the spine writer; the Delivery Manager's next wake re-dispatches it.
  const leases = createLeases({ store: () => homeStore, reposRoot: read.reposRoot, writer: spine, git: headKeptLog(gitOut(20_000)), wrote: dropSpines, log: (m) => console.warn(m) });
  mountClaims(api, () => leases);
  if (opts.leases?.everyMs) phased(opts.timerPhases, "leases", () => leases.start(opts.leases!.everyMs!));
  // "Commits with no ticket" on the Team home, per world.
  mountOrphanCommits(api, { world: () => store.tenant ?? DEFAULT_TENANT, list: async (world) => orphansOf(orphanMilestones(world)) });
  // "Asked, no row yet" on the Team home. Per world (TENANT_SAFE): the caller's world's milestones only.
  launchBoard?.mount(api); // GET /api/launch-board (the home world only: routeScope's default; hosted/social.ts)
  mountAskedNoRow(api, {
    world: () => store.tenant ?? DEFAULT_TENANT,
    list: async (world) => {
      const ms = store.listMilestones().filter((m) => (store.worldOfMilestone?.(m.id) ?? DEFAULT_TENANT) === world && !m.paused);
      // A cold spines.py read takes seconds after a deploy: wait for it (the section loads on its own), say when one is missing.
      const lists = await Promise.all(
        ms.map(async (m) => {
          const { loc, rel, spines } = await spinesFor(m, 10_000).catch(() => ({}) as Awaited<ReturnType<typeof spinesFor>>);
          if (!loc || !rel) return null; // no spine file in a checkout: nothing to list
          return spines ? { repoDir: loc.repo.path, rel, items: askedNoRowFor(m, loc.repo.path, rel, spines) } : undefined;
        }),
      );
      return { items: dedupeAsked(lists.filter((l): l is NonNullable<typeof l> => !!l)), partial: !!soft && lists.includes(undefined) };
    },
  });
  // the two text calls on the provider CONSOLE_TEXT_MODEL_PROVIDER picks (textModel.ts), built once: the settle
  // check, the feedback structurer and GET/POST /api/text-model below share them.
  const textProvider = textModelProvider();
  const openAiKey = async () => process.env.OPENAI_API_KEY || (await sudoRead(openAiStoreFile()));
  const textJudge: Judge = textProvider === "anthropic" ? anthropicJudge(anthropicKey) : openAiJudge(openAiKey);
  // his words on a card answer its asks (read only; the card presses each answer through its own route).
  mountSpokenAnswers(api, { ...(textProvider === "anthropic" && !process.env.VITEST ? { judge: anthropicSpokenJudge(anthropicKey) } : {}) });
  // E948-S206: cards that ask the same in other words: Haiku judges the close pairs the inbox builders queue, once a minute.
  const pairJudge = opts.sameMeaningJudge ?? anthropicPairJudge(anthropicKey);
  const epicJudge = opts.sameSubjectJudge ?? anthropicPairJudge(anthropicKey, fetch, undefined, EPIC_JUDGE_SYSTEM);
  if (!opts.passive && !process.env.VITEST && process.env.CONSOLE_SAME_MEANING !== "off") startSameMeaningJudge(pairJudge, 60_000, (m) => console.log(m), 120_000, epicJudge);
  // judge pairs now (scripts/duplicate_taps.py measures his taps with it; at most 60 a call), and what it merged or left borderline.
  api.post("/inbox/same-meaning", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { pairs?: unknown; system?: unknown; epic?: unknown };
    const pairs = (Array.isArray(b.pairs) ? b.pairs : [])
      .filter((p): p is { a: string; b: string; refA?: string; refB?: string } => !!p && typeof (p as { a?: unknown }).a === "string" && typeof (p as { b?: unknown }).b === "string")
      .slice(0, 60)
      .map((p) => ({ a: p.a.slice(0, 4000), b: p.b.slice(0, 4000), ...(typeof p.refA === "string" ? { refA: p.refA.slice(0, 80) } : {}), ...(typeof p.refB === "string" ? { refB: p.refB.slice(0, 80) } : {}) }));
    if (!pairs.length) return c.json({ error: "pairs: [{a, b}] needed" }, 400);
    try {
      // calibration: a trial prompt judges the pairs once and is never kept (the cache holds the shipped prompt's verdicts only)
      if (typeof b.system === "string" && b.system.trim()) {
        const trial = await anthropicPairJudge(anthropicKey, fetch, undefined, b.system.slice(0, 4000))(pairs);
        return c.json({ trial: true, verdicts: trial.map((v) => ({ same: v.same, confidence: v.confidence, call: callOf({ ...v }) })) });
      }
      // E948-S206 round 3: `epic: true` judges cards of one epic on the overlap question (its own cache and bar)
      const epic = b.epic === true;
      const verdicts = epic ? await judgePairs(epicJudge, pairs, undefined, "epic") : await judgePairs(pairJudge, pairs);
      return c.json({ sure: epic ? EPIC_SURE : MEANING_SURE, border: MEANING_BORDER, ...(epic ? { epic: true } : {}), verdicts: verdicts.map((v) => ({ key: v.key, same: v.same, confidence: v.confidence, call: v.call })) });
    } catch (e) {
      return c.json({ error: String((e as Error)?.message ?? e).slice(0, 300) }, 502);
    }
  });
  api.get("/inbox/same-meaning", (c) => c.json({ sure: MEANING_SURE, border: MEANING_BORDER, epicSure: EPIC_SURE, borderline: borderlinePairs().slice(0, 100), merged: mergedPairs().slice(0, 100), sameSubject: epicMerged().slice(0, 100) }));
  const textStructurer: Structurer = opts.voice?.structure ?? (textProvider === "anthropic" ? anthropicStructurer(anthropicKey) : openAiStructurer(openAiKey));
  // the owner edits a red line (typed or a voice note, reworded by the same text model) or deletes it, from its slim
  // row on top of Team home; docs/pursuits.json, the root Red line lines and an Decisions row, one commit.
  mountRedLineEdit(api, {
    writer: spine,
    reposRoot: read.reposRoot,
    reword: opts.redLineReword ?? (textProvider === "anthropic" ? anthropicReworder(anthropicKey) : openAiReworder(openAiKey)),
    who: () => ownerName(),
    wrote: dropSpines,
  });
  // his briefing: what he says on each objective (or campaign) is filed on it, his words file and a Decisions line.
  mountBriefing(api, { writer: spine, reposRoot: read.reposRoot, milestone: (id) => store.getMilestone(id), who: () => ownerName(), wrote: dropSpines });
  // which provider the two text calls use, and one probe call of either on TEST text (and of the
  // cross-world check, the voice spill check and the memory service ask wording) (writes nothing, files
  // nothing, one call per 20 s): the proof that a call goes through the credit account, and a check after a rollback.
  let textProbeAt = 0;
  api.get("/text-model", (c) => c.json({ provider: textProvider, model: textProvider === "anthropic" ? ANTHROPIC_TEXT_MODEL : STRUCTURE_MODEL }));
  api.post("/text-model/probe", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const str = (k: string) => (typeof b[k] === "string" ? (b[k] as string).slice(0, 4000) : "");
    const kinds = ["structure", "settle", "cross", "spill", "ask"];
    if (typeof b.kind !== "string" || !kinds.includes(b.kind)) return c.json({ error: { code: "validation_error", message: `kind is ${kinds.join(", ")}` } }, 400);
    if (Date.now() - textProbeAt < 20_000) return c.json({ error: { code: "too_many", message: "one probe per 20 s" } }, 429);
    textProbeAt = Date.now();
    const t0 = Date.now();
    const base = { provider: textProvider, model: b.kind === "ask" ? askModel : textProvider === "anthropic" ? ANTHROPIC_TEXT_MODEL : STRUCTURE_MODEL, kind: b.kind };
    try {
      if (b.kind === "cross") {
        if (!str("words")) return c.json({ error: { code: "validation_error", message: "words is required" } }, 400);
        const social = str("from") === socialProduct();
        const side = (product: string) => ({ world: "TEST", product, url: "" });
        const toMilestones = str("campaigns").split(";").map((t) => t.trim()).filter(Boolean);
        const r = await textCrossJudge({ from: side(social ? socialProduct() : TEAM_HEAD.name), to: side(social ? TEAM_HEAD.name : socialProduct()), toMilestones, words: str("words") });
        return c.json({ ...base, ms: Date.now() - t0, result: r });
      }
      if (b.kind === "spill") {
        if (!str("words")) return c.json({ error: { code: "validation_error", message: "words is required" } }, 400);
        const r = await textSpillJudge({ id: "text-model-probe", world: "TEST", where: str("where") || "TEST probe", words: str("words") });
        return c.json({ ...base, ms: Date.now() - t0, result: r });
      }
      if (b.kind === "ask") {
        if (!str("question")) return c.json({ error: { code: "validation_error", message: "question is required" } }, 400);
        if (!textAsk) return c.json({ error: { code: "off", message: "this console has no memory helper (the services plug)" } }, 503);
        const r = await textAsk.worder(str("question"), str("context") || "THE WORLD'S STATUS\nTEST probe: no context given.", []);
        return c.json({ ...base, model: r.model, ms: Date.now() - t0, costUsd: r.costUsd, result: { answer: r.answer, refs: r.refs } });
      }
      if (b.kind === "structure") {
        if (!str("transcript")) return c.json({ error: { code: "validation_error", message: "transcript is required" } }, 400);
        const r = await textStructurer(str("transcript"), { who: str("who") || "TEST probe", product: str("product") || "TEST", campaign: str("campaign") || "TEST" });
        return c.json({ ...base, ms: Date.now() - t0, costUsd: r.costUsd, result: r.structure });
      }
      if (!str("question") || !str("answer") || !str("openQuestion")) return c.json({ error: { code: "validation_error", message: "question, answer and openQuestion are required" } }, 400);
      const src = { kind: "ask" as const, question: str("question"), answerKind: "answer" as const, words: str("answer"), label: "TEST probe" };
      const cand = { id: "text-model-probe", source: "ask", question: str("openQuestion"), code: "TEST" } as unknown as WaitingItem;
      const r = await ((typeof opts.settle === "object" && opts.settle.judge) || textJudge)(src, cand, [{ kind: "near-question", why: str("links") || "TEST probe" }]);
      return c.json({ ...base, ms: Date.now() - t0, result: r });
    } catch (e) {
      return c.json({ ...base, ms: Date.now() - t0, error: { code: "model_failed", message: String((e as Error)?.message ?? e).slice(0, 300) } }, 502);
    }
  });
  const inbox = mountInbox(api, { db, store, cycle, deps: inboxDeps, spine, attachments, recordAssignments: (s) => assignmentRecord.recorded(s), ...(opts.passive ? { resumeJobs: false } : {}),
    ...(opts.answers?.ack ? { answerAck: opts.answers.ack } : {}), ...(opts.answers?.retryMs ? { answerRetryMs: opts.answers.retryMs } : {}),
    onAnswerJob: (id, s) => presses.answerJob(id, s), // an answer's press follows its job
    onAnswerUndone: (id) => void presses.undoRef(id, "brought back before it was written"),
    // one answer closes many (index.ts turns it on; true = the model check on the console's OpenAI key)
    ...(!opts.settle ? {} : { settle: opts.settle === true ? { judge: textJudge } : opts.settle }),
    // his yes on an improvement request hands it to the builder world's desk (inbox/improvement.ts)
    improvement: async (r) => {
      const it = r.item;
      if (!it.improvement || !it.code || !it.repo) return { ok: false, retry: false, error: "the improvement request has no code or repo" };
      const mid = it.milestoneId ?? r.milestoneId;
      const fromWorld = (mid ? store.worldOfMilestone?.(mid) : undefined) ?? DEFAULT_TENANT;
      const worlds = db.prepare("SELECT id, skin, plan, owner_handle AS owner, paused FROM tenants").all() as WorldRow[];
      const to = resolveImprovementTarget(it.improvement.to, fromWorld, worlds, parsePairs(crossOpt?.pairs ?? process.env.CONSOLE_DESK_PAIRS));
      if (typeof to !== "string") return { ok: false, retry: false, error: to.error };
      const target = worldHome(to);
      if (!target) return { ok: false, retry: true, error: `the world ${to} has no home checkout on this host` };
      const fromRepo = resolveRepo(read.reposRoot, it.repo);
      const h = await handImprovement(
        {
          fromWorld,
          replyTo: fromRepo?.remote ?? it.repo,
          repo: it.repo,
          code: it.code,
          question: it.question ?? it.title ?? "",
          improvement: it.improvement,
          ...(it.unblocks ? { unblocks: it.unblocks } : {}),
          ...(it.contextText ? { context: it.contextText } : {}),
          answer: r.text,
          approvedOn: r.createdAt.slice(0, 10),
          toWorld: to,
          ...(citeOf([it.question, it.contextText, it.whyYou, it.recommendation, it.detail]) ? { cites: citeOf([it.question, it.contextText, it.whyYou, it.recommendation, it.detail]) } : {}),
        },
        target,
        spine,
      );
      if ("reason" in h) return { ok: false, retry: h.state === "failed", error: h.reason };
      return { ok: true, note: `${target.name}:${h.rel}` };
    },
    // his Yes on a priority ask puts its objective first in the objectives file (inbox/priorityAsk.ts)
    priority: async (r) => {
      const it = r.item;
      if (!it.putFirst) return { ok: false, retry: false, error: "not a priority ask" };
      const own = it.repo ? resolveRepo(read.reposRoot, it.repo)?.path : undefined;
      const dir = pursuitsDirFor(own, pursuits.homeDir());
      const h = await putFirst({ dir, objective: it.putFirst.objective, ...(it.code ? { code: it.code } : {}), by: ownerName(), words: r.text }, spine);
      if (h.ok && dir) (pursuits.clear(), dropSpines(dir), scorecardsBuilt.clear(), void keptScorecards.refresh());
      return h;
    },
    invalidate: (dir) => dropSpines(dir), deskChat: {
      // a world's own desk answers from its own thread (his typed words and voice-note transcripts alike).
      jordiSaid: async (chat, world) => {
        if (!world) return desk.jordiSaid(chat);
        try {
          return saidInAny(await worldDesks.chatFor(world).jordiMessages(), chat);
        } catch {
          return false;
        }
      },
    }, ...(readModel ? { readModel } : {}), ...(secretsArea ? { keys: secretsArea.keys } : {}),
    milestoneChat: {
      caller: chatScope.caller,
      refusal: (callerId, item) => {
        const m = item.milestoneId ? store.getMilestone(item.milestoneId) : undefined;
        return chatScope.refusal(callerId, m, m?.path && item.path ? item.path : undefined);
      },
      jordiSaid: async (callerId, chat) => saidInAny(await milestoneChats.chatFor(callerId).jordiMessages(), chat),
    },
    ...(opts.secretPut ? { secretPut: opts.secretPut } : {}) });
  opts.answers?.onJobs?.(inbox.jobs);
  // presses a restart cut off are due again; the worker retries what has not landed.
  if (!opts.passive) pressWorker.resume();
  if (opts.presses?.tickMs && !opts.passive) pressWorker.start(opts.presses.tickMs);
  opts.presses?.onWorker?.(pressWorker);
  // one server-computed status per milestone (outcome, flow, pending items); GET /status, /milestones/:id/status.
  // a big root tracked inside another milestone's spine is worked by that milestone's personas.
  const coverOf = coverOfIn(store, (m) => treeFor(m, 1_500));
  // a milestone's items come from the trees of every milestone of its world (asks it references), so a cold
  // read of any of their repos makes its status loading.
  const coldOf = (sf: NonNullable<typeof soft>) => ({
    mark: sf.mark,
    missed: (m: Milestone, mark: number) => {
      const world = store.worldOfMilestone?.(m.id);
      const dirs = new Set(store.listMilestones({ includeSettled: true }).filter((x) => x.id === m.id || store.worldOfMilestone?.(x.id) === world).map(locateDir));
      return [...dirs].some((dir) => !!dir && sf.missedSince(dir, mark));
    },
  });
  if (inbox.settle) {
    const settle = inbox.settle;
    settleApproved = (r) => {
      if (r.by !== DEFAULT_OWNER) return; // the daily press test's presses settle nothing
      const remote = resolveRepo(read.reposRoot, r.repo)?.remote;
      void settle({
        kind: "review",
        repo: r.repo,
        path: r.path,
        row: r.ref,
        question: r.title,
        answerKind: "approve",
        words: `Approved on his review card: ${r.title}`,
        label: `review ${r.repo}/${r.ref}`,
        ...(remote ? { link: `https://github.com/${remote}/blob/${r.sha ?? "HEAD"}/${r.path}` } : {}),
        owner: DEFAULT_OWNER,
      })
        .then((x) => x.line && console.log(`review ${r.repo}/${r.ref}: one answer closes many: ${x.line}`))
        .catch((e) => console.warn(`review ${r.repo}/${r.ref}: one answer closes many: ${(e as Error).message}`));
    };
  }
  const status = createStatus({ db, store, milestoneInfo: withOutcome, treeFor: (m) => treeFor(m, 1_500), waiting: (f) => waitingAndDefects(inboxDeps, f), t3State: cycle.runT3State, coverOf, askLookup: monitorAskLookup, priorities: () => worldPriorities(store, read.reposRoot), ...(soft ? { cold: coldOf(soft) } : {}) });
  mountStatus(api, status, store, readModel);
  // the owner: "I can't take action on it so what's it doing there?": a stopped or overdue Monitoring item that names
  // no open ask for him is out of his Blocked on you (web) and goes back to its team: one desk note in its repo, once
  // per alert, read by that repo's Delivery Manager, who asks him one real question or clears it.
  // Every world's stored status (both products alike); CONSOLE_ALERT_HANDBACK_MS (0 = off), default 15 min.
  const alertHandBackMs = Number(process.env.CONSOLE_ALERT_HANDBACK_MS ?? (opts.passive || process.env.CONSOLE_STAGING === "1" ? 0 : 15 * 60_000));
  const allWorldsStore = createStore(db);
  const alertHandBack = createAlertHandBack({
    items: async () => {
      if (!readModel) return ((await status.all({ includeSettled: false })).items ?? []) as PendingItem[];
      const worlds = new Set(["", ...(db.prepare("SELECT DISTINCT tenant_id AS t FROM milestones").all() as { t: string }[]).map((r) => r.t)]);
      const seen = new Map<string, PendingItem>();
      for (const world of worlds) {
        const v = readModel.peek<{ items?: PendingItem[] }>({ kind: "status", world, includeSettled: false });
        for (const it of v?.payload?.items ?? []) if (!seen.has(it.id)) seen.set(it.id, it);
      }
      return [...seen.values()];
    },
    target: (id) => {
      const m = allWorldsStore.getMilestone(id);
      if (!m?.repo || m.paused || m.settledAt) return undefined;
      const r = resolveRepo(read.reposRoot, m.repo);
      if (!r) return undefined;
      return { world: allWorldsStore.worldOfMilestone?.(m.id) ?? DEFAULT_TENANT, checkout: r.path, replyTo: r.remote ?? m.repo, policyPath: m.path || "docs/spines/root.md", milestoneTitle: m.title };
    },
    writer: spine,
    log: (l) => console.log(l),
  });
  if (alertHandBackMs > 0) setInterval(() => void outsideRequest(() => alertHandBack.tick().catch((e) => console.error("alert hand-back:", e instanceof Error ? e.message : e))), alertHandBackMs).unref();
  // the owner 2026-11-12 21:17Z: the search box on top of the Inbox filters every section at once. Answers from
  // the lists the Inbox already reads (asks' stored view, his answers, review cards, status rows, voice-note index).
  const inboxSearch = createInboxSearch(async () => {
    const [asks, cards, snoozedCards, st] = await Promise.all([
      inbox.searchSources(),
      review.list({ state: "review" }),
      review.list({ state: "snoozed" }),
      statusRows(status, store, readModel),
    ]);
    return { ...asks, review: [...cards, ...snoozedCards] as unknown as Record<string, unknown>[], status: st.items as Record<string, unknown>[], voice: voiceNotesList.get().notes };
  });
  api.get("/inbox/search", async (c) => {
    const q = (c.req.query("q") ?? "").trim();
    if (q.length > SEARCH_MAX_CHARS) return c.json({ error: { code: "validation_error", message: `q is at most ${SEARCH_MAX_CHARS} characters` } }, 400);
    const r = await inboxSearch.search(q);
    c.header("Server-Timing", `search;dur=${r.tookMs}`);
    return c.json(r);
  });
  // a counted monitor alert's ask actions, relayed to the ask's own inbox route in its own world.
  mountAlertActions(api, {
    db,
    store,
    alertAsks: async (m) => {
      const info = await withOutcome(m, 1_500);
      const t = Date.now();
      const refs = (info.monitoring ?? []).filter((x) => alertReasons(x, t).why.length).flatMap(askRefs);
      return refs.length ? [...(await monitorAskLookup(m, refs)).values()] : [];
    },
    fetch: (r) => app.fetch(r),
  });
  // the pills (Team red + green, Chat unread, each sidebar milestone) in one small answer; unread from the live chats.
  const chatUnread = cycleOpts.enabled
    ? createChatUnread({
        db,
        detach: outsideRequest,
        ...(opts.chatUnread?.staleMs !== undefined ? { staleMs: opts.chatUnread.staleMs } : {}),
        chatOf: (key) => {
          if (key === TEAM_KEY) return desk;
          if (key.startsWith("milestone:")) return milestoneChats.chatFor(key.slice("milestone:".length));
          if (key.startsWith("world-desk:")) return worldDesks.chatFor(key.slice("world-desk:".length));
          return undefined;
        },
      })
    : undefined;
  mountCounts(api, {
    store,
    status: async () => {
      const k = { kind: "status" as const, world: viewWorld(), includeSettled: false };
      if (!readModel) return status.all();
      const v = await readModel.view(k, () => computeStatus(status, store, k) as ReturnType<typeof status.all>);
      return { ...v.payload, asOf: v.asOf };
    },
    review,
    ...(chatUnread ? { unread: chatUnread } : {}),
    memberships: (userId) => auth.memberships(userId), // the world switcher
  });
  mountDeskInbox(api, { store, resolve: (repo) => resolveRepo(read.reposRoot, repo) }); // the world's desk-to-desk notes
  /**
   * a deploy restarts the console (49 restarts in 6 h on 2026-11-02) and the first tree read after it took
   * 17-26 s on the main server (spines.py cold, then every tree of the world for the waiting list). After a start, read each
   * unsettled milestone's tree the way GET /milestones/:id/tree does (spines.py output, tree, waiting list, summary),
   * focus milestones first, one at a time so the main server is not flooded. A request meanwhile shares the build in flight
   * (tree memo, spines.py cache); later changes are dropped by the usual invalidation (pull, write), never here.
   */
  const warmTrees = async () => {
    const t0 = Date.now();
    const ranks = worldRanks(store, read.reposRoot);
    const ms = store
      .listMilestones()
      .filter((m) => !!m.path && !m.settledAt)
      .sort((a, b) => (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity));
    const gapMs = opts.warmTrees?.gapMs ?? 0;
    for (const [i, m] of ms.entries()) {
      if (i && gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
      try {
        await spinesFor(m, SPINES_TIMEOUT_MS); // the real spines.py output, so the stored tree is not the bare doc parse
        await status.paintedTree(m, await treeFor(m));
      } catch {
        /* a milestone that fails here fails on its page too; the next one still warms */
      }
    }
    return { milestones: ms.length, ms: Date.now() - t0 };
  };
  if (opts.warmTrees?.afterMs !== undefined) {
    const onDone = opts.warmTrees.onDone ?? ((r) => console.log(`trees warm: ${r.milestones} milestones in ${(r.ms / 1000).toFixed(1)} s`));
    const afterMs = opts.warmTrees.afterMs;
    void (opts.warmTrees.after ?? Promise.resolve()).catch(() => undefined).then(() =>
      setTimeout(() => void warmTrees().then(onDone, (e) => console.warn(`trees warm failed: ${e instanceof Error ? e.message : e}`)), afterMs).unref(),
    );
  }
  // what waits on the owner (the badge's open items) and E48's review list also reach him on WhatsApp.
  const homeStore = createStore(db, { tenant: DEFAULT_TENANT }); // the owner's world's review rows
  // rows in review that are not cards (they close themselves, need evidence, or their card needs rewriting)
  // wake their milestone's Delivery manager once each; the owner never sees them. Read for the owner's world, outside any request.
  // with the read model, so the self-close each minute reads the stored review view as meant (it had none
  // here, so every minute it re-read every spine on this thread: ~1.1 s on the main server, logged as a timer that did not yield).
  const gateReview = createReview(db, { store: homeStore, reposRoot: read.reposRoot, writer: spine, wrote: dropSpines, ...(readModel ? { readModel } : {}), live: opts.review?.live ?? liveCheckDepsFromEnv({ port: Number(process.env.PORT || 8750), host: process.env.HOST, repoDir: resolveRepo(read.reposRoot, homeRepo())?.path }) });
  const reviewGate = createAgentWake({ db, store: homeStore, agents: () => gateReview.list({ state: "agents", wait: true }), closeSelf: () => gateReview.closeSelf(), ...(cycle.enabled ? { cycle } : {}), log: (m) => console.warn(m) });
  // a long note marks the cards in the owner's inbox it touches (rows in review, open asks) and wakes their owners.
  const touchOpt = opts.noteTouch === true ? {} : opts.noteTouch || undefined;
  if (touchOpt) {
    const touchJudge: TouchJudge = touchOpt.judge ?? (onClaude ? anthropicTouchJudge(anthropicKey) : openAiTouchJudge(textOpenAiKey));
    const oneLine = (t: string) => t.replace(/\s+/g, " ").trim();
    // E942-S174 a test's own judge decides alone unless it brings its own second look
    const touchConfirm: TouchConfirm | undefined = touchOpt.confirm ?? (touchOpt.judge ? undefined : onClaude ? anthropicTouchConfirm(anthropicKey) : openAiTouchConfirm(textOpenAiKey));
    // the owner's own inbox (world the home world): the review cards and his open asks
    const touchCards = async (world: string): Promise<TouchCard[]> => {
        if (world !== DEFAULT_TENANT) return [];
        const rows = (await gateReview.list({ state: "feed" }))
          .filter((i) => i.kind !== "post" && i.verdict.kind === "card" && !i.test && !i.backlogSince)
          .map((i): TouchCard => ({ kind: "row", ref: i.ref, title: i.face?.title || i.title, about: oneLine(i.face?.taskGoal ?? i.summary ?? "").slice(0, 300), ...(i.face?.about ? { topic: i.face.about } : {}), repo: i.repo, path: i.path, ...(i.milestoneId ? { milestoneId: i.milestoneId } : {}), current: i.status, text: `${i.title} ${i.status} ${i.summary ?? ""}` }));
        const asks = (await waitingAndDefects({ ...inboxDeps, store: homeStore }, { world: DEFAULT_TENANT }).catch(() => ({ items: [] as Awaited<ReturnType<typeof waitingAndDefects>>["items"] }))).items
          .filter((a) => a.source === "ask" && a.state === "open" && !!a.code && !!a.repo && !!a.path && !a.snoozedUntil)
          .map((a): TouchCard => ({ kind: "ask", ref: a.code!, title: oneLine(a.question ?? a.title).slice(0, 200), about: oneLine(a.title ?? "").slice(0, 200), ...(a.about ? { topic: a.about } : {}), repo: a.repo!, path: a.path!, ...(a.milestoneId ? { milestoneId: a.milestoneId } : {}), current: a.question ?? "", text: `${a.question ?? ""} ${a.title ?? ""} ${a.contextText ?? ""}` }));
        return [...rows, ...asks];
    };
    // E942-S174 a dry run of the same pass (same model, same two looks, same grace rule) on a throwaway table: marks, wakes and tells nothing
    touchTry = async (x) => {
      const scratch = openDb(":memory:");
      try {
        const marks: { ref: string; kind: string; quote: string; why: string }[] = [];
        let t: NoteTouch | undefined = undefined;
        t = createNoteTouch({
          db: scratch,
          judge: touchJudge,
          ...(touchConfirm ? { confirm: touchConfirm } : {}),
          sleep: async () => void (x.after ? await t?.heard({ world: DEFAULT_TENANT, words: x.after, where: "a message to the Team desk", typed: true }) : undefined),
          cards: async () => x.cards ?? (await touchCards(DEFAULT_TENANT)),
          mark: async (_r, _p, m) => (marks.push(...m.map(({ ref, kind, quote, why }) => ({ ref, kind, quote, why }))), true),
        });
        const state = await t.heard({ world: DEFAULT_TENANT, words: x.words, where: x.typed ? "a message to the Team desk" : "a try", typed: !!x.typed, id: "try" }, { graceMs: 1 });
        return { state: state ?? "short", marks, pass: t.recent(1)[0] ?? null };
      } finally {
        scratch.close();
      }
    };
    noteTouch = createNoteTouch({
      db,
      judge: touchJudge,
      ...(touchConfirm ? { confirm: touchConfirm } : {}),
      cards: touchCards,
      mark: async (repo, rel, marks) => {
        const dir = resolveRepo(read.reposRoot, repo)?.path;
        if (!dir) return `no checkout for ${repo}`;
        const refs = marks.map((m) => m.ref).join(", ");
        const w = await spine.edit({
          repoDir: dir,
          path: rel,
          label: `voice note marks ${refs}`,
          edit: (text) => {
            const r = addMarks(text, marks);
            if (!r.added) return { skip: "already marked" };
            const at = marks[0].at;
            return {
              text: r.text,
              msg: `${ownerName()}'s voice note of ${at} marks ${refs} (${marks.map((m) => m.kind).join(", ")})`,
              body: `His long voice note (${marks[0].note}) touches ${marks.length} card(s) in his inbox. The console added one Decisions line per card in ${rel}; each card shows "${marks.some((m) => m.kind === "stale") ? "stale" : "updated"}" until its owner moves the row or rewrites the ask (core/console/server/src/voice/touch.ts).`,
            };
          },
        });
        if (w.status === "written" || (w.status === "skipped" && w.reason === "already marked")) {
          dropSpines(dir);
          return true;
        }
        return `${w.status}: ${w.reason ?? ""}`.slice(0, 200);
      },
      ...(cycle.enabled
        ? {
            wake: async (mid: string, text: string, key: string) => {
              const m = homeStore.getMilestone(mid);
              if (!m || m.paused) return "milestone paused or gone";
              const a = homeStore.listAssignments({ milestoneId: mid }).find((x) => x.enabled && !x.parkedAt && isDm(homeStore.getPersona(x.personaId)?.name));
              if (!a) return "no Delivery manager on it";
              await cycle.runNowRequest(a.id, { instructions: text, instructionsBy: "voice note" }, key);
              return true as const;
            },
            tell: deskTell,
          }
        : {}),
      log: (m) => console.warn(m),
    });
  }
  if (opts.reviewGate?.everyMs) phased(opts.timerPhases, "reviewGate", () => reviewGate.start(opts.reviewGate!.everyMs!, opts.reviewGate!.closeEveryMs ?? 60_000));
  // phone notifications from the installed app (Web Push): the Team desk's answers and's new items.
  const webPush = createWebPush(db, {
    vapid: opts.webPush?.vapid ?? (() => vapidFromEnv()),
    ...(opts.webPush?.transport ? { transport: opts.webPush.transport } : {}),
    ...(opts.webPush?.now ? { now: opts.webPush.now } : {}),
    ...(opts.webPush?.deskGraceMs !== undefined ? { deskGraceMs: opts.webPush.deskGraceMs } : {}),
    ...(chatUnread ? { desk: () => chatUnread.peek(TEAM_KEY) } : {}),
  });
  mountWebPush(api, webPush);
  if (opts.webPush?.deskTickMs) setInterval(() => void outsideRequest(() => webPush.deskTick()), opts.webPush.deskTickMs).unref();
  // the home world's review rows as the inbox reads them (the read model's stored view, the review route's key), so the
  // notifier's ticks do not rebuild every row on this thread (about 2 s each in a production profile)
  const homeReviewItems = async () => {
    const k = { kind: "review" as const, world: homeStore.tenant ?? "" };
    const rows = readModel ? ((await readModel.view(k, async () => computeReviewRows(homeStore, read.reposRoot))).payload as ReviewPayload).rows : undefined;
    return reviewItemsOf(db, homeStore, read.reposRoot, rows);
  };
  // WhatsApp to the owner and the skill's sends (hosted/services.ts); the one-team core sends none.
  const whatsapp: Notifier = services?.whatsapp({
    api,
    push: (pending) => webPush.items(pending),
    sources: async () => {
      // the stored Team status (the worker keeps it current), never a fresh build on this thread every 2 min.
      const k = { kind: "status" as const, world: viewWorld(), includeSettled: false };
      const all = readModel ? (await readModel.view(k, () => computeStatus(status, store, k) as ReturnType<typeof status.all>)).payload : await status.all();
      return [
        ...asksFrom(all.items, (id) => store.worldOfMilestone?.(id) ?? DEFAULT_TENANT, (id) => store.getMilestone(id)?.title, (id) => store.getMilestone(id)?.repo),
        ...reviewNotices(await homeReviewItems()),
      ];
    },
    options: opts.whatsapp,
    store: homeStore,
    setSkills: (id, skills) => recordFirst(() => personaRecord.recorded(homeStore).updatePersona(id, { skills })),
    // a ready notice told or refused is a Decisions line on its row's spine (root L-45: the repo is the source).
    readyNote: async (r, line) => {
      const dir = resolveRepo(read.reposRoot, r.repo)?.path;
      if (!dir) return `no checkout for ${r.repo}`;
      const w = await spine.edit({
        repoDir: dir,
        path: r.path,
        label: `ready notice ${r.row}`,
        edit: (text, date) => {
          const next = addDecisionRow(text, { date, outcome: line.outcome, decision: line.decision, summary: line.summary, evidence: `${teamLink()}/api/notify/ready`, revisit: "never" });
          return next === undefined ? { skip: "no Decisions table" } : { text: next, msg: `${r.row}: ready notice ${line.outcome}`, body: `${line.decision}\n\nThe console's ready notice (hosted notify/whatsapp.ts readyPass).` };
        },
      });
      if (w.status === "written") dropSpines(dir);
      return w.status;
    },
  }) ?? { alert: async () => undefined, tick: async () => undefined };
  // a console checkout ahead of or behind origin for over 5 min is an alert (log, /api/health, the Delivery
  // Manager's wake and, in production, one WhatsApp per episode); it was silent while the main server's the code repo stayed diverged.
  checkoutSync = createCheckoutSync({
    dirs: () => [...new Set(store.listMilestones({ includeSettled: false }).flatMap((m) => resolveRepo(read.reposRoot, m.repo)?.path ?? []))],
    // the console's own write clones too, alarming when one is ahead of origin
    ...(clones?.enabled && opts.writeClones
      ? { clones: () => [...new Set(store.listMilestones({ includeSettled: false }).flatMap((m) => resolveRepo(read.reposRoot, m.repo)?.path ?? []))].map((shared) => ({ shared, clone: clones!.cloneOf(shared) ?? cloneDirFor(opts.writeClones!.root, shared) })) }
      : {}),
    git: gitOut(15_000),
    ...(opts.checkoutSync?.afterMs !== undefined ? { afterMs: opts.checkoutSync.afterMs } : {}),
    // a checkout left behind is pulled by the self-healing puller (cycle/syncRecover.ts) every 5 min until it follows main
    ...(opts.checkoutSync?.heal === false ? {} : { heal: createRepoPuller({ git: gitRunner(120_000), onPulled: pulledSpines }).pull }),
    log: (m) => console.warn(m),
    alert: (text) => {
      if (opts.readModel?.drift?.alert) void whatsapp.alert("checkout-sync", `${text}\nConsole spine writes to it are refused until it matches. Details: ${teamLink()}/api/checkout-sync`);
    },
  });
  mountCheckoutSync(api, () => checkoutSync!);
  if (opts.checkoutSync?.everyMs) checkoutSync.start(opts.checkoutSync.everyMs);
  // the worker server's home volume under 15% free is an alert (log, /api/health `vps3Disk`, the Delivery Manager's wake and,
  // in production, one WhatsApp per episode); it filled to 99% on 2026-11-08 and broke new worktrees unseen.
  if (opts.hostDisk?.probe && hostsArea) {
    hostDisk = hostsArea.diskWatch({
      probe: opts.hostDisk.probe,
      ...(opts.hostDisk.minFreePct !== undefined ? { minFreePct: opts.hostDisk.minFreePct } : {}),
      log: (m) => console.warn(m),
      alert: (text) => {
        if (opts.readModel?.drift?.alert) void whatsapp.alert(`${workerHost()}-disk`, `${text}\nDetails: ${teamLink()}/api/health`);
      },
    });
    if (opts.hostDisk.everyMs) hostDisk.start(opts.hostDisk.everyMs);
  }
  hostsArea?.mountDisk(api, () => hostDisk);
  // the 30-day T3 MCP tokens (the main server's expired unseen on 2026-11-12 and stalled every wake on it with a
  // 401): warn 5 days before, and a 401 from T3 is an alert line at once (log, /api/health `t3Tokens`, one WhatsApp per episode).
  if (opts.t3Tokens) {
    const listed = opts.t3Tokens.files;
    t3Tokens = createTokenWatch({
      files:
        listed ??
        (() =>
          (db.prepare("SELECT id, token_file FROM hosts WHERE token_file IS NOT NULL AND token_file <> '' ORDER BY id").all() as { id: string; token_file: string }[]).map((h) => ({
            host: h.id,
            file: h.token_file.replace(/^~(?=\/)/, os.homedir()),
          }))),
      log: (m) => console.warn(m),
      alert: (kind, text) => {
        if (opts.readModel?.drift?.alert) void whatsapp.alert(kind, `${text}\nDetails: ${teamLink()}/api/health`);
      },
    });
    if (opts.t3Tokens.everyMs) t3Tokens.start(opts.t3Tokens.everyMs);
  }
  // job servers (model A): box/provision.py's alerts reach the owner once each (production), every customer's
  // status line and today's spend at GET /api/job-servers.
  if (opts.jobServers?.dir) {
    jobServers = createJobServers({
      dir: opts.jobServers.dir,
      log: (m) => console.warn(m),
      alert: (kind, text) => {
        if (opts.readModel?.drift?.alert) void whatsapp.alert(kind, `${text}\nDetails: ${teamLink()}/api/job-servers`);
      },
    });
    if (opts.jobServers.everyMs) jobServers.start(opts.jobServers.everyMs);
  }
  mountJobServers(api, () => jobServers);
  // an outside probe (the worker server, every minute) reports whether the console's answers stayed over its bar for its
  // hold time: `slow` starts one episode (log, /api/health `answerSpeed`, in production one WhatsApp alarm per episode,
  // capped by the notifier), `ok` ends it. Home world and host only, like every route not on the tenant-safe list.
  api.post("/health/answer-speed", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { state?: unknown; worstMs?: unknown; minutes?: unknown; page?: unknown };
    if (b.state !== "slow" && b.state !== "ok") throw new ApiError(400, "validation_error", "state must be slow or ok");
    const at = new Date().toISOString();
    const worstMs = Math.max(0, Math.round(Number(b.worstMs) || 0));
    const minutes = Math.max(0, Math.round(Number(b.minutes) || 0));
    const page = typeof b.page === "string" && /^https?:\/\//.test(b.page) ? b.page.slice(0, 200) : undefined;
    const was = answerSpeed.state;
    if (b.state === "slow") {
      answerSpeed = { state: "slow", at, since: was === "slow" ? answerSpeed.since : at, worstMs: Math.max(worstMs, was === "slow" ? (answerSpeed.worstMs ?? 0) : 0), ...(page ? { page } : {}) };
      if (was !== "slow") {
        const text = `The team console is slow: its answers took over 5 s for ${minutes || 5} minutes (worst ${(worstMs / 1000).toFixed(1)} s).${page ? ` Live probe: ${page}` : ""}`;
        console.warn(`answer speed: ${text}`);
        if (opts.readModel?.drift?.alert) void whatsapp.alert("console-slow", `${text}\nDetails: ${teamLink()}/api/health`);
      }
    } else {
      if (was === "slow") console.warn(`answer speed: back under the bar (slow since ${answerSpeed.since})`);
      answerSpeed = { state: "ok", at };
    }
    return c.json({ ok: true, answerSpeed });
  });
  // the daily press test presses every review button kind on TEST rows (dailyTest.ts), as the console host
  // through the app's own routes, so each press goes through the press log, the clone writer and the outbox like the owner's.
  {
    const hostCtx = () => {
      const mode = opts.auth ?? authModeFromEnv();
      return { mode, identity: { kind: "legacy" as const, tenant: DEFAULT_TENANT, peer: PRESS_TEST_RUN, host: true as const }, ...(mode === "on" ? { scope: DEFAULT_TENANT } : {}), via: "gateway" as const };
    };
    const call = (method: string, p: string, body?: unknown) =>
      runWithAuth(hostCtx(), async () =>
        app.fetch(new Request(`http://console.local/api${p}`, { method, headers: { "content-type": "application/json", "x-console-run": PRESS_TEST_RUN }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })),
      );
    const testName = opts.pressTest?.repo ?? process.env.CONSOLE_PRESS_TEST_REPO ?? "e67-feedback-test";
    const testRepo = () => {
      const r = resolveRepo(read.reposRoot, testName);
      return r ? { name: r.name, dir: r.path } : undefined;
    };
    const isTest = (repo: string | undefined, code: string | undefined) => (!!repo && TEST_REPO.test(repo)) || (!!code && TEST_ROW.test(code));
    const getJson = async (p: string) => {
      const r = await call("GET", p);
      if (!r.ok) throw new Error(`GET ${p}: HTTP ${r.status}`);
      return (await r.json()) as unknown;
    };
    pressTest = createPressTest({
      presses,
      writer: spine,
      testRepo,
      teamRepo: () => resolveRepo(read.reposRoot, homeRepo())?.path,
      rowId: (rel, ref) => {
        const t = testRepo();
        return t ? computeReviewRows(homeStore, read.reposRoot).rows.find((r) => resolveRepo(read.reposRoot, r.repo)?.path === t.dir && r.path === rel && r.ref === ref)?.id : undefined;
      },
      goalKey: (rel) => {
        const t = testRepo();
        return t ? computeReviewRows(homeStore, read.reposRoot).closedGoals?.find((g) => resolveRepo(read.reposRoot, g.repo)?.path === t.dir && g.path === rel)?.key : undefined;
      },
      press: async (p, body) => {
        const res = await call("POST", p, body);
        let json: unknown;
        try {
          json = await res.json();
        } catch {
          json = undefined;
        }
        // the press id from the header, else from the 202 body (production's answer reached the test without the header)
        const id = res.headers.get("x-press-id") ?? (json as { press?: { id?: unknown } } | undefined)?.press?.id;
        return { status: res.status, ...(typeof id === "string" && id ? { pressId: id } : {}), json };
      },
      clones: () => cloneStatus() as { lagging?: unknown[]; fallbacks?: { at: string }[] },
      // what the owner sees: the review list, the goals (open and closed) and the inbox, as the pages read them
      leaks: async () => {
        const out: ListLeak[] = [];
        for (const i of (await getJson("/review-items")) as { repo?: string; ref?: string }[]) if (isTest(i.repo, i.ref)) out.push({ list: "review list", what: i.ref ?? "?" });
        for (const g of (await getJson("/review-goals")) as { repo?: string; code?: string; key?: string }[]) if (isTest(g.repo, undefined)) out.push({ list: "goals", what: g.code ?? g.key ?? "?" });
        for (const g of (await getJson("/review-goals/closed")) as { repo?: string; code?: string }[]) if (isTest(g.repo, undefined)) out.push({ list: "closed goals", what: g.code ?? "?" });
        for (const a of (await getJson("/waiting-on-owner")) as { repo?: string; code?: string; state?: string }[])
          if (a.state !== "done" && isTest(a.repo, a.code)) out.push({ list: "inbox", what: a.code ?? "?" });
        return out;
      },
      invalidate: dropSpines,
      raise: async (question) => {
        const team = resolveRepo(read.reposRoot, homeRepo())?.path;
        const m = team ? homeStore.listMilestones({}).find((x) => resolveRepo(read.reposRoot, x.repo)?.path === team) : undefined;
        if (!m) return { status: "skipped", reason: `no ${homeRepo()} milestone on this console` };
        const r = await raiseAsk({ db, store: homeStore, reposRoot: read.reposRoot, writer: spine, invalidate: dropSpines }, m, { question, askedBy: "the daily press test (console)", row: pressTestHome().row }, pressTestHome().spine);
        return r.status === "written" ? { status: r.status, code: r.code } : { status: r.status, reason: r.reason };
      },
      ...(opts.pressTest?.now ? { now: opts.pressTest.now } : {}),
      ...(opts.pressTest?.pollMs !== undefined ? { pollMs: opts.pressTest.pollMs } : {}),
      ...(opts.pressTest?.landingLimitMs !== undefined ? { landingLimitMs: opts.pressTest.landingLimitMs } : {}),
      ...(opts.pressTest?.recheckMs !== undefined ? { recheckMs: opts.pressTest.recheckMs } : {}),
      ...(opts.pressTest?.sleep ? { sleep: opts.pressTest.sleep } : {}),
    });
    // GET: the last runs and whether today's is due; POST runs one now (202, in the background; ?wait=1 answers with the run)
    api.get("/press-test", (c) => c.json({ running: pressTest!.running(), due: pressTest!.due(), health: pressTest!.health(), runs: pressTest!.runs() }));
    api.post("/press-test/run", async (c) => {
      if (c.req.query("wait") === "1") return c.json(await pressTest!.run("manual"));
      const was = pressTest!.running();
      void pressTest!.run("manual").catch(() => undefined);
      return c.json({ started: !was, running: true }, 202);
    });
    if (opts.pressTest?.tickMs) pressTest.start(opts.pressTest.tickMs);
  }
  // drift between the cache and the repo reaches the owner on WhatsApp (the console's alert path), once per set of
  // differing views a day; staging and dev copies only log (index.ts leaves `alert` off there).
  {
    let last: { sig: string; at: number } | undefined;
    onDrift = (r) => {
      if (r.ok || !opts.readModel?.drift?.alert) return;
      const sig = r.error ? `error:${r.error}` : r.differ.map((x) => x.key).sort().join("|");
      const t = Date.now();
      if (last && last.sig === sig && t - last.at < 24 * 3600_000) return;
      last = { sig, at: t };
      void whatsapp.alert("drift", `Team console: ${driftLine(r)}\nThe repo is the source (root L-45); details: ${teamLink()}/api/read-model/drift`);
    };
  }
  // Call the desk. The console mints a 1-minute OpenAI client key per call (caps, off switch), answers the
  // voice's quick status from the stored Team status, relays its questions into the desk thread and meters the cost.
  // every call starts briefed: the root tree (top-level milestones: code, one-line goal, status, priority order)
  // and the Epic Book summary at the call's level (the desk: the root book; a milestone: its own page). Read from the
  // stored book (never a build on the call's path beyond its soft wait; voice.ts drops a briefing slower than 3 s).
  const builtBook = async () => (book ? (await book.get()).book : null);
  const epicOf = (b: Book | null, m: Milestone): BookEpic | undefined => {
    if (!b || !m.path) return undefined;
    const loc = locate(read.reposRoot, m);
    const repoName = "error" in loc ? loc.repo?.name ?? m.repo.split("/").pop()! : loc.repo.name;
    return b.repos.find((r) => r.name === repoName)?.epics.find((e) => e.path === m.path);
  };
  const worldTree = (b: Book | null, world: string): TreeEntry[] =>
    store
      .listMilestones()
      .filter((m) => milestoneWorld(db, m.id) === world)
      .map((m) => {
        const e = world === DEFAULT_TENANT ? epicOf(b, m) : undefined;
        return { ...(e ? { code: e.code } : {}), title: m.titleSetAt || !e ? m.title : e.title, goal: e?.goal ?? null, status: e?.status ?? null, ...(m.bigRoot != null ? { rank: m.bigRoot } : {}) };
      });
  /** The Team desk's root book: the code repo's root spine (the desk's own repo). */
  const deskBrief = async () => {
    const b = await builtBook();
    const repo = b?.repos.find((r) => r.name === DESK_BOOK_REPO);
    const root = repo?.root ? repo.epics.find((e) => e.path === repo.root) : undefined;
    return briefing([treeBrief(worldTree(b, DEFAULT_TENANT)), root ? bookBrief(root, { level: "the root (the whole team)" }) : null]);
  };
  const milestoneBrief = async (id: string, world: string) => {
    if (world !== DEFAULT_TENANT) return briefing([treeBrief(worldTree(null, world), { who: "this world's", noun: "campaigns" })], "campaigns");
    const b = await builtBook();
    const m = store.getMilestone(id);
    const e = m ? epicOf(b, m) : undefined;
    return briefing([treeBrief(worldTree(b, world)), e ? bookBrief(e, { level: "this milestone", ...(m?.titleSetAt ? { title: m.title } : {}) }) : null]);
  };
  /**
   * his inbox as the Team desk's call walks it, read when a call starts: the review cards in his review list's
   * order (GET /review-items: his level, then milestone priority), then the open questions waiting on him (the status
   * batch's open items of his world), test rows left out. Each card carries what its face shows him.
   */
  const voiceInbox = async (): Promise<InboxCard[]> => {
    const ms = store.listMilestones({ includeSettled: true });
    const titles = new Map(ms.map((m) => [m.id, m.title]));
    const home = (id?: string) => !id || (store.worldOfMilestone?.(id) ?? DEFAULT_TENANT) === DEFAULT_TENANT;
    const items = (await review.list({ state: "review" })).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.ref.localeCompare(b.ref));
    const reviews: InboxCard[] = byMilestonePriority(items, storeRanks(store, read.reposRoot), worldPriorities(store, read.reposRoot))
      .filter((i) => home(i.milestoneId) && !isTestItem({ repo: i.repo, code: i.ref, title: i.title }))
      .map((i) => {
        const f = i.face;
        return {
          kind: "review" as const,
          id: i.id,
          ...(i.ref ? { code: i.ref } : {}),
          title: f?.title || i.title,
          ...(i.milestoneId && titles.has(i.milestoneId) ? { where: titles.get(i.milestoneId) } : {}),
          ...(f?.source ? { source: f.source } : {}),
          ...(f?.taskGoal ? { goal: f.taskGoal } : {}),
          ...(f?.delivered?.length ? { delivered: f.delivered.map((d) => `${d.ok === false ? "✗" : "✓"} ${d.text}`) } : {}),
          ...(f?.evidence?.label ? { evidence: f.evidence.label } : i.liveUrl ? { evidence: i.liveUrl } : {}),
          ...(f?.decision ? { decision: f.decision } : {}),
          ...(f?.options?.length ? { options: f.options } : {}),
          ...(f?.evidence?.url ? { link: { label: f.evidence.label || "Evidence", url: f.evidence.url } } : {}),
          // the buttons the voice may press for him on his spoken yes (the page presses them as his own).
          buttons: reviewButtons(f),
        };
      });
    const k = { kind: "status" as const, world: viewWorld(), includeSettled: false };
    const all = readModel ? (await readModel.view(k, () => computeStatus(status, store, k) as ReturnType<typeof status.all>)).payload : await status.all();
    const seen = new Set<string>();
    const asks: InboxCard[] = [];
    for (const i of all.items as PendingItem[]) {
      if (i.state !== "open" || seen.has(i.id) || !home(i.milestoneId) || isTestItem({ repo: i.repo, code: i.code, title: i.title })) continue;
      seen.add(i.id);
      asks.push({
        kind: "ask",
        id: i.id,
        ...(i.code ? { code: i.code } : {}),
        title: i.title,
        ...(titles.has(i.milestoneId) ? { where: titles.get(i.milestoneId) } : {}),
        ...(i.question && i.question !== i.title ? { question: i.question } : {}),
        milestoneId: i.milestoneId,
        // only an ask he answers with his words or a yes; a monitor alert, a stalled goal or a mark goes to the desk.
        buttons: i.kind === "ask" || i.kind === "needs_jordi" ? askButtons(i.ask, i.question ?? i.title) : [],
      });
    }
    // the goals to set and the team's ideas, after the asks, as his inbox shows them (voice/SectionCall teamCard).
    let team: InboxCard[] = [];
    try {
      const dir = pursuits.homeDir();
      const doc = dir ? parseTeamCards(fs.readFileSync(path.join(dir, TEAM_CARDS_FILE), "utf8")) : undefined;
      const open = doc ? listTeamCards(doc, { now: new Date().toISOString(), ...(objectiveIds(dir) ? { objectives: objectiveIds(dir)! } : {}) }).open : [];
      team = [...open.filter((c) => c.kind === "goal"), ...open.filter((c) => c.kind === "idea")].map((c) => {
        const goals = c.goal?.options ?? [];
        const links = c.goal?.links ?? c.idea?.links;
        return {
          kind: c.kind === "goal" ? ("goal" as const) : ("team" as const),
          id: c.id,
          title: c.title,
          ...(c.source ? { source: c.source } : {}),
          ...(c.goal ? { question: `${c.goal.unset}. Options: ${goals.map((g, n) => `${n + 1}) ${goalLabel(g)}`).join("; ")}` } : {}),
          ...(c.goal?.recommend !== undefined && goals[c.goal.recommend] ? { recommend: goalLabel(goals[c.goal.recommend]) } : {}),
          ...(c.idea ? { question: c.idea.gain, recommend: c.idea.recommend } : {}),
          ...(links?.length ? { evidence: links.map((l) => l.label).join(", "), link: links[0] } : {}),
          buttons: [...goals.map(goalLabel), ANSWER_IN_WORDS],
        };
      });
    } catch {
      /* no team cards file: the walk has the reviews and asks */
    }
    return [...reviews, ...asks, ...team];
  };
  // his objectives for the call: the last read at once (a cold read takes about 2 s, the call waits at most 3 s for all its
  // context together), refreshed behind it; read once at boot so the first call has them too.
  let lastObjectives = "";
  const readObjectives = async () => {
    const line = (await ownerObjectivesNow?.().catch(() => undefined))?.line;
    if (line) lastObjectives = line.split(" ; ").join("\n");
    return lastObjectives;
  };
  const voiceObjectives = async () => {
    const fresh = readObjectives();
    return lastObjectives || fresh;
  };
  // the same objectives one by one for the call's briefing (light, key results, where it stands, his words);
  // the last read at once, refreshed behind it, like the line above.
  let lastObjectiveCards: ObjectiveCard[] = [];
  const readObjectiveCards = async () => {
    const body = await ownerObjectivesInput?.().catch(() => undefined);
    if (!body) return lastObjectiveCards;
    const home = pursuits.homeDir();
    const plot = home ? readHisWords(path.dirname(home), path.basename(home)) : undefined;
    lastObjectiveCards = objectiveCards(body, plot);
    return lastObjectiveCards;
  };
  const voiceObjectiveCards = async () => {
    const fresh = readObjectiveCards();
    return lastObjectiveCards.length ? lastObjectiveCards : fresh;
  };
  setTimeout(() => void readObjectiveCards(), 6_000).unref?.();
  setTimeout(() => void readObjectives(), 5_000).unref?.();
  // voice calls are off unless the `calls`
  // setting (PUT /api/voice/settings {calls}) or CONSOLE_VOICE_CALLS=on turns them on; tests keep the old default.
  const callsDefault: "on" | "off" = process.env.CONSOLE_VOICE_CALLS === "on" || (process.env.VITEST && process.env.CONSOLE_VOICE_CALLS !== "off") ? "on" : "off";
  const voiceMint = opts.voice?.mint ?? openAiMinter(async () => process.env.OPENAI_API_KEY || (await sudoRead(openAiStoreFile())));
  // The owner asked for voice calls back on through ElevenLabs: calls go through ElevenLabs Agents on the grant.
  // One agent on the account, its id kept in voice_settings; CONSOLE_VOICE_ELEVEN=off goes back to OpenAI's realtime voice.
  const voiceEleven: ElevenCalls | undefined =
    opts.voice?.eleven ??
    (process.env.VITEST || process.env.CONSOLE_VOICE_ELEVEN === "off"
      ? undefined
      : elevenCalls({
          key: async () => process.env.ELEVENLABS_API_KEY || (await sudoRead(keyFile("ELEVENLABS_API_KEY"))),
          prompt: voiceInstructions,
          firstMessage: () => OPENING_LINE,
          tools: () => [...VOICE_TOOLS, ...INBOX_TOOLS, PRESS_TOOL, ...OBJECTIVE_TOOLS] as any,
          known: {
            get: () => (db.prepare("SELECT value FROM voice_settings WHERE key = 'eleven_agent_id'").get() as { value: string } | undefined)?.value,
            set: (id) => void db.prepare("INSERT INTO voice_settings (key, value) VALUES ('eleven_agent_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(id),
          },
        }));
  const voice = createVoice({
    db,
    mint: voiceMint,
    eleven: voiceEleven,
    desk: { send: (t, page, crid) => desk.send(t, page, crid), view: () => desk.view() },
    onEnded: (id) => void memoryForward?.enqueueCall(id),
    envOff: process.env.CONSOLE_VOICE === "off",
    envModel: process.env.CONSOLE_VOICE_MODEL || undefined,
    callsDefault,
    ...(opts.voice?.now ? { now: opts.voice.now } : {}),
    brief: deskBrief,
    inbox: voiceInbox,
    objectives: voiceObjectives,
    objectiveCards: voiceObjectiveCards,
    quickStatus: async () => {
      const k = { kind: "status" as const, world: viewWorld(), includeSettled: false };
      const all = readModel ? (await readModel.view(k, () => computeStatus(status, store, k) as ReturnType<typeof status.all>)).payload : await status.all();
      const title = (id: string) => store.getMilestone(id)?.title;
      const waiting = [...asksFrom(all.items, (id) => store.worldOfMilestone?.(id) ?? DEFAULT_TENANT, title), ...reviewNotices(await homeReviewItems()).map((r) => ({ ...r, title: `review: ${r.title}` }))];
      const stuck = [
        ...all.milestones.filter((m) => m.flow.word === "stalled").map((m) => ({ title: "no one is moving it", milestone: title(m.milestoneId), why: m.flow.reason })),
        ...all.items.filter((i) => i.kind === "stalled" || i.kind === "failed_run").map((i) => ({ title: i.title, milestone: title(i.milestoneId) })),
      ];
      const working = all.milestones.filter((m) => m.flow.word === "working").map((m) => ({ milestone: title(m.milestoneId) ?? m.milestoneId, what: m.flow.run?.summary?.slice(0, 120) || m.flow.reason }));
      // the owner's milestones (his world) in priority order, big roots first, each with its state and what waits on him.
      const ranks = worldRanks(store, read.reposRoot, {});
      const rank = (id: string) => ranks.get(id) ?? Number.MAX_SAFE_INTEGER;
      const milestones = [...all.milestones].sort((a, b) => rank(a.milestoneId) - rank(b.milestoneId)).flatMap((st) => {
        const m = store.getMilestone(st.milestoneId);
        if (!m || (store.worldOfMilestone?.(m.id) ?? DEFAULT_TENANT) !== DEFAULT_TENANT) return [];
        const open = (st.items ?? []).filter((i) => i.state === "open");
        return [{ title: m.title, word: st.flow.word, needsYou: open.length, waits: open.slice(0, 2).map((i) => (i.code ? `${i.code} ${i.title}` : i.title)), ...(m.bigRoot != null ? { bigRoot: m.bigRoot } : {}), ...(st.progress ? { pct: st.progress.pct } : {}) }];
      });
      return { text: quickStatusText({ milestones, waiting, stuck, working }), waiting: waiting.length, stuck: stuck.length, working: working.length, milestones: milestones.length };
    },
  });
  // a campaign chat's Call (the social skin's desk; any world): the same call routes and engine, one Voice per milestone,
  // scoped to its world (own month cap, one call at a time) and to that milestone (its calls, its chat, its world's quick status).
  const campaignVoices = new Map<string, Voice>();
  const worldVoices = new Map<string, Voice>();
  const voiceBase = {
    db,
    mint: voiceMint,
    eleven: voiceEleven,
    onEnded: (id: string) => void memoryForward?.enqueueCall(id),
    envOff: process.env.CONSOLE_VOICE === "off",
    envModel: process.env.CONSOLE_VOICE_MODEL || undefined,
    callsDefault,
    ...(opts.voice?.now ? { now: opts.voice.now } : {}),
  };
  const noStatus = async () => ({ text: "", waiting: 0, stuck: 0, working: 0 });
  /**
   * The world's own voice without a campaign: its settings (its cap; what PUT /api/voice/settings {world} writes) and,
   * the Call on its team desk (/api/tenants/:id/desk/voice): the Team desk's voice fenced to the world, relaying to its desk.
   */
  const worldVoice = (world: string) => {
    let v = worldVoices.get(world);
    if (!v) {
      const name = () => store.getTenant(world)?.name || world;
      worldVoices.set(
        world,
        (v =
          world === DEFAULT_TENANT
            ? createVoice({ ...voiceBase, scope: { world }, quickStatus: noStatus })
            : createVoice({
                ...voiceBase,
                scope: { world },
                instructions: () => (socialArea?.worldDeskCall ?? MILESTONE_CALL).instructions(name()),
                tools: () => (socialArea?.worldDeskCall ?? MILESTONE_CALL).tools(name()),
                desk: { send: (t, page, crid) => worldDesks.send(world, t, page, crid), view: () => worldDesks.view(world) },
                quickStatus: () => worldDeskStatus(world),
                brief: () => briefing([treeBrief(worldTree(null, world), { who: "this world's", noun: "campaigns" })], "campaigns"),
                context: () => worldCallKnows(world),
              })),
      );
    }
    return v;
  };
  /**
   * what a social world's call (its world desk's or one campaign's) knows before it starts: every campaign of the
   * world with its plan's key results, the newest daily briefing and the Strategist's daily lines, read from its repo.
   */
  const worldCallKnows = (world: string) => {
    const { campaigns, repoDir } = worldCampaigns(world);
    return worldCallContext({ world: store.getTenant(world)?.name || world, campaigns, ...(repoDir ? { repoDir } : {}) });
  };
  /** a world's campaigns in its order, each with its spine and newest briefing, and the world's repo (its calls read these). */
  const worldCampaigns = (world: string) => {
    const dirOf = worldRepoDir(read.reposRoot, db, world);
    const dir = (name?: string | null) => (name ? (dirOf(name) ?? resolveRepo(read.reposRoot, name)?.path) : undefined);
    const ranks = worldRanks(store, read.reposRoot, {});
    const mine = store
      .listMilestones()
      .filter((m) => milestoneWorld(db, m.id) === world)
      .sort((a, b) => (ranks.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (ranks.get(b.id) ?? Number.MAX_SAFE_INTEGER));
    const campaigns = mine.map((m) => {
      const d = dir(m.repo);
      let spine: string | undefined;
      try {
        if (d && m.path) spine = fs.readFileSync(path.join(d, m.path), "utf8");
      } catch {
        /* unreadable spine: the campaign is still named */
      }
      const code = m.path === "docs/spines/root.md" ? null : (spine ? (/^#\s+(EPIC-\d+):/m.exec(spine)?.[1] ?? null) : null);
      const briefing = m.repo ? socialArea?.callBriefing?.({ repo: m.repo, code }) : undefined;
      return { title: m.title, ...(spine ? { spine } : {}), ...(briefing ? { briefing } : {}) };
    });
    const repoDir = dir(world) ?? dir(mine.find((m) => m.repo)?.repo);
    return { campaigns, repoDir };
  };
  /** quick status for a world desk's Call: the world's campaigns and jobs (pinned first), what waits, what is stuck. */
  const worldDeskStatus = async (world: string) => {
    const k = { kind: "status" as const, world: viewWorld(), includeSettled: false };
    const all = readModel ? (await readModel.view(k, () => computeStatus(status, store, k) as ReturnType<typeof status.all>)).payload : await status.all();
    const mine = (id: string) => milestoneWorld(db, id) === world;
    const title = (id: string) => store.getMilestone(id)?.title;
    const ranks = worldRanks(store, read.reposRoot, {});
    const rank = (id: string) => ranks.get(id) ?? Number.MAX_SAFE_INTEGER;
    const ms = all.milestones.filter((m) => mine(m.milestoneId)).sort((a, b) => rank(a.milestoneId) - rank(b.milestoneId));
    const milestones = ms.map((st) => {
      const m = store.getMilestone(st.milestoneId);
      const open = (st.items ?? []).filter((i) => i.state === "open");
      return { title: m?.title ?? st.milestoneId, word: st.flow.word, needsYou: open.length, waits: open.slice(0, 2).map((i) => (i.code ? `${i.code} ${i.title}` : i.title)), ...(m?.bigRoot != null ? { bigRoot: m.bigRoot } : {}), ...(st.progress ? { pct: st.progress.pct } : {}) };
    });
    const waiting = all.items.filter((i) => i.state === "open" && mine(i.milestoneId)).map((i) => ({ title: i.title, ...(i.code ? { code: i.code } : {}), milestone: title(i.milestoneId) }));
    const stuck = [
      ...ms.filter((m) => m.flow.word === "stalled").map((m) => ({ title: "no one is moving it", milestone: title(m.milestoneId), why: m.flow.reason })),
      ...all.items.filter((i) => (i.kind === "stalled" || i.kind === "failed_run") && mine(i.milestoneId)).map((i) => ({ title: i.title, milestone: title(i.milestoneId) })),
    ];
    const working = ms.filter((m) => m.flow.word === "working").map((m) => ({ milestone: title(m.milestoneId) ?? m.milestoneId, what: m.flow.run?.summary?.slice(0, 120) || m.flow.reason }));
    const text = quickStatusText({ milestones, waiting, stuck, working })
      .replace(new RegExp(String.raw`${ownerPattern()}'s focus milestones`, "g"), "pinned campaigns")
      .replace(/focus milestones/g, "pinned campaigns")
      .replace(new RegExp(String.raw`Waiting on ${ownerPattern()}`, "g"), "Waiting on you")
      .replace(new RegExp(String.raw`waits on ${ownerPattern()}`, "g"), "waits on you");
    return { text, waiting: waiting.length, stuck: stuck.length, working: working.length, milestones: milestones.length };
  };
  /** Quick status for a campaign's Call: this campaign first, then its world's others; only rows of the milestone's world. */
  const campaignStatus = async (world: string, milestoneId: string, as: "campaign" | "milestone" = "campaign") => {
    const k = { kind: "status" as const, world: viewWorld(), includeSettled: false };
    const all = readModel ? (await readModel.view(k, () => computeStatus(status, store, k) as ReturnType<typeof status.all>)).payload : await status.all();
    const mine = (id: string) => milestoneWorld(db, id) === world;
    const title = (id: string) => store.getMilestone(id)?.title;
    const said = (st: (typeof all.milestones)[number]) => {
      const open = (st.items ?? []).filter((i) => i.state === "open");
      return { title: title(st.milestoneId) ?? st.milestoneId, word: st.flow.word, needsYou: open.length, waits: open.slice(0, 2).map((i) => (i.code ? `${i.code} ${i.title}` : i.title)), ...(st.progress ? { pct: st.progress.pct } : {}) };
    };
    // in priority order (focus milestones first, in the owner's order), as the briefing's root tree.
    const ranks = worldRanks(store, read.reposRoot, {});
    const rank = (id: string) => ranks.get(id) ?? Number.MAX_SAFE_INTEGER;
    const ms = all.milestones.filter((m) => mine(m.milestoneId)).sort((a, b) => rank(a.milestoneId) - rank(b.milestoneId));
    const self = ms.find((m) => m.milestoneId === milestoneId);
    return campaignQuickStatus({
      campaign: self ? said(self) : { title: title(milestoneId) ?? milestoneId, word: "nothing_to_do" },
      others: ms.filter((m) => m.milestoneId !== milestoneId).map(said),
      waiting: all.items.filter((i) => i.state === "open" && mine(i.milestoneId)).map((i) => ({ title: i.title, ...(i.code ? { code: i.code } : {}), milestone: title(i.milestoneId) })),
      stuck: [
        ...ms.filter((m) => m.flow.word === "stalled").map((m) => ({ title: "no one is moving it", milestone: title(m.milestoneId), why: m.flow.reason })),
        ...all.items.filter((i) => (i.kind === "stalled" || i.kind === "failed_run") && mine(i.milestoneId)).map((i) => ({ title: i.title, milestone: title(i.milestoneId) })),
      ],
      working: ms.filter((m) => m.flow.word === "working").map((m) => ({ milestone: title(m.milestoneId) ?? m.milestoneId, what: m.flow.run?.summary?.slice(0, 120) || m.flow.reason })),
    }, as);
  };
  const campaignVoice = (id: string): Voice | undefined => {
    const m = store.getMilestone(id); // the request's world: another world's id is not found
    if (!m) return undefined;
    let v = campaignVoices.get(m.id);
    if (!v) {
      const world = milestoneWorld(db, m.id);
      v = createVoice({
        ...voiceBase,
        scope: { world, milestoneId: m.id },
        // one of the owner's own milestones (a Team home card's Call) is a milestone, not a campaign.
        instructions: () => (world === DEFAULT_TENANT ? MILESTONE_CALL : socialArea?.campaignCall ?? MILESTONE_CALL).instructions(store.getMilestone(m.id)?.title ?? m.title),
        tools: () => (world === DEFAULT_TENANT ? MILESTONE_CALL : socialArea?.campaignCall ?? MILESTONE_CALL).tools(store.getMilestone(m.id)?.title ?? m.title),
        desk: { send: (t, page, crid) => milestoneChats.send(m.id, t, page, crid), view: () => milestoneChats.view(m.id) },
        quickStatus: () => campaignStatus(world, m.id, world === DEFAULT_TENANT ? "milestone" : "campaign"),
        brief: () => milestoneBrief(m.id, world),
        ...(world === DEFAULT_TENANT ? {} : { context: () => worldCallKnows(world) }),
      });
      campaignVoices.set(m.id, v);
    }
    return v;
  };
  // a customer workspace on its own job servers never uses our voice key (OpenAI calls and note transcripts): its
  // Call runs on the browser's own speech and its chat on its own AI (desk/jobChat.ts), so our call and note routes refuse it.
  const ownVoice = (world: string | undefined) => !!world && world !== DEFAULT_TENANT && !!jobRoute?.handles(world);
  const OWN_VOICE = { error: { code: "own_voice", message: "This workspace talks on its own server and AI: its Call uses your browser's own speech, on the Chat page." } };
  api.use("/tenants/:id/desk/voice/*", async (c, next) => (c.req.method !== "GET" && ownVoice(c.req.param("id")) ? c.json(OWN_VOICE, 409) : next()));
  api.use("/milestones/:id/voice/*", async (c, next) => (c.req.method !== "GET" && ownVoice(milestoneWorld(db, c.req.param("id") ?? "")) ? c.json(OWN_VOICE, 409) : next()));
  mountVoice(api, voice, { world: () => store.tenant, worldVoice });
  // Settings > Transcription (his model pick, the paid backup switch, the model in use, the last 30 days' cost).
  mountTranscription(api, { db, callsOn: () => voice.callsOn(), world: () => store.tenant, home: DEFAULT_TENANT, refuse: (c) => notJordi((n) => c.req.header(n)), ...(opts.voice?.now ? { now: opts.voice.now } : {}) });
  mountCampaignVoice(api, campaignVoice);
  // Play on a desk reply speaks it in the team's local voice on the worker server (free); down = the browser's best voice.
  mountReplyVoice(api, opts.voice?.speak);
  // the desk's answer to his voice note comes back as a short voice note too (ElevenLabs, the narration voice, the grant).
  const elevenKey = async () => process.env.ELEVENLABS_API_KEY || (await sudoRead(keyFile("ELEVENLABS_API_KEY")));
  const replyNotesDir = process.env.CONSOLE_REPLY_NOTES_DIR ?? path.join(path.dirname(defaultDbPath()), "reply-notes");
  mountReplyNote(api, { key: elevenKey, dir: replyNotesDir, ...(opts.voice?.now ? { now: opts.voice.now } : {}) });
  mountListenPage(app, replyNotesDir); // the briefing's "Listen: <link>", a player page behind the login
  // the objectives coach (/coach): its own ElevenLabs agent, his objectives read only, his words relayed to a desk.
  const coachEleven: ElevenCalls | undefined =
    opts.voice?.coachEleven ??
    (process.env.VITEST || process.env.CONSOLE_VOICE_ELEVEN === "off"
      ? undefined
      : elevenCalls({
          name: COACH_AGENT_NAME,
          tags: ["epicteam", "objectives-coach"],
          key: elevenKey,
          prompt: coachInstructions,
          firstMessage: COACH_GREETING,
          tools: () => COACH_TOOLS as any,
          known: {
            get: () => (db.prepare("SELECT value FROM voice_settings WHERE key = 'eleven_coach_agent_id'").get() as { value: string } | undefined)?.value,
            set: (id) => void db.prepare("INSERT INTO voice_settings (key, value) VALUES ('eleven_coach_agent_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(id),
          },
        }));
  let coachRelays = 0;
  const coachVoice = createVoice({
    ...voiceBase,
    eleven: coachEleven,
    // the coach runs on ElevenLabs only: never OpenAI's paid realtime voice.
    mint: async () => {
      throw new VoiceError(409, "coach_eleven_only", "The objectives coach runs on ElevenLabs only, and ElevenLabs calls are off on this console.");
    },
    scope: { world: DEFAULT_TENANT },
    instructions: coachInstructions,
    tools: () => COACH_TOOLS as any,
    desk: { send: (t, page, crid) => desk.send(t, page, crid), view: () => desk.view() },
    quickStatus: noStatus,
    objectiveCards: voiceObjectiveCards,
    context: async () => coachKnows(await voiceObjectiveCards()),
    walkRule: () => "",
    relay: async (callId, args) => {
      const r = relayIn(args);
      const n = ++coachRelays;
      if (r.desk === "team") {
        await desk.send(teamRelayText(callId, r), COACH_PAGE, `coach-${callId}-${n}`);
        console.log(`[voice] ${callId} coach relayed his words to the Team desk`);
        return { desk: "team", state: "sent", result: "Passed to the Team desk. Tell him in a few words." };
      }
      const p = await deskCross?.pass({ world: DEFAULT_TENANT, quote: r.words, about: COACH_PAGE, requestId: `coach-${callId}-${n}` });
      if (!p) {
        // no social desk paired on this console: his words still reach the Team desk, which passes them on itself.
        await desk.send(teamRelayText(callId, { ...r, note: `For the social desk: pass only these words of his there (no desk across on this console). ${r.note}`.trim() }), COACH_PAGE, `coach-${callId}-${n}`);
        return { desk: "team", state: "sent", result: "The social desk is not reachable from here: passed to the Team desk, which hands it on. Tell him in a few words." };
      }
      console.log(`[voice] ${callId} coach relayed his words to the social desk (${p.state})`);
      return { desk: "social", state: p.state, result: "Passed to the social desk, his words only. Tell him in a few words." };
    },
  });
  mountCoachVoice(api, coachVoice, { world: () => store.tenant });
  // the briefing call (/briefing): its own ElevenLabs agent tells him the desk's news since his last briefing (what
  // shipped, what waits on him) and takes his notes, each one request on the Team desk. The coach's call path, reused.
  const briefingEleven: ElevenCalls | undefined =
    opts.voice?.briefingEleven ??
    (process.env.VITEST || process.env.CONSOLE_VOICE_ELEVEN === "off"
      ? undefined
      : elevenCalls({
          name: BRIEFING_AGENT_NAME,
          tags: ["epicteam", "briefing-call"],
          key: elevenKey,
          prompt: briefingInstructions,
          firstMessage: BRIEFING_GREETING,
          tools: () => BRIEFING_TOOLS as any,
          known: {
            get: () => (db.prepare("SELECT value FROM voice_settings WHERE key = 'eleven_briefing_agent_id'").get() as { value: string } | undefined)?.value,
            set: (id) => void db.prepare("INSERT INTO voice_settings (key, value) VALUES ('eleven_briefing_agent_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(id),
          },
        }));
  const briefingLast = () => (db.prepare("SELECT value FROM voice_settings WHERE key = 'briefing_last_at'").get() as { value: string } | undefined)?.value;
  let briefingNotes = 0;
  const briefingVoice = createVoice({
    ...voiceBase,
    eleven: briefingEleven,
    // where the next briefing starts: this call's start, once it ended with words in it.
    onEnded: (id: string) => {
      voiceBase.onEnded(id);
      const r = db.prepare("SELECT started_at FROM voice_calls WHERE id = ?").get(id) as { started_at: string } | undefined;
      if (r) db.prepare("INSERT INTO voice_settings (key, value) VALUES ('briefing_last_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(r.started_at);
    },
    mint: async () => {
      throw new VoiceError(409, "briefing_eleven_only", "The briefing call runs on ElevenLabs only, and ElevenLabs calls are off on this console.");
    },
    scope: { world: DEFAULT_TENANT },
    instructions: briefingInstructions,
    tools: () => BRIEFING_TOOLS as any,
    desk: { send: (t, page, crid) => desk.send(t, page, crid), view: () => desk.view() },
    quickStatus: noStatus,
    context: async () => {
      const now = opts.voice?.now?.() ?? Date.now();
      const since = briefingSince(briefingLast(), now);
      const home = (mid?: string) => !mid || (store.worldOfMilestone?.(mid) ?? DEFAULT_TENANT) === DEFAULT_TENANT;
      const shipped = outcomes.all().filter((x) => x.at >= since && home(x.milestoneId));
      const waiting = await voiceInbox().catch(() => [] as InboxCard[]);
      return briefingKnows({ since, now, shipped, waiting });
    },
    walkRule: () => "",
    relay: async (callId, args) => {
      const words = typeof args.words === "string" ? args.words.replace(/\s+/g, " ").trim().slice(0, 6000) : "";
      if (!words) throw new VoiceError(400, "no_words", "words (his words, as he said them) are required");
      const note = typeof args.note === "string" ? args.note.trim().slice(0, 600) : "";
      const n = ++briefingNotes;
      await desk.send(briefingNoteText(callId, { words, note }), BRIEFING_PAGE, `briefing-${callId}-${n}`);
      console.log(`[voice] ${callId} briefing note ${n} sent to the Team desk`);
      return { desk: "team", state: "sent", result: "Passed to the Team desk as one request. Tell him in a few words." };
    },
  });
  mountOwnCall(api, "/voice/briefing", briefingVoice, { world: () => store.tenant }, "The briefing call");
  // the senior marketing call (/marketing): its own ElevenLabs agent talks the social product's strategy with him (the
  // number one blocker, each campaign's plan) from the marketing brief, its objectives and the campaigns' own plans;
  // his words go to the social desk (campaigns, posts, channels) or the Team desk. The coach's call path, reused.
  const marketingEleven: ElevenCalls | undefined =
    opts.voice?.marketingEleven ??
    (process.env.VITEST || process.env.CONSOLE_VOICE_ELEVEN === "off"
      ? undefined
      : elevenCalls({
          name: marketingAgentName(),
          tags: [socialProduct().toLowerCase(), "marketing-call"],
          key: elevenKey,
          prompt: marketingInstructions,
          firstMessage: MARKETING_GREETING,
          tools: () => MARKETING_TOOLS as any,
          known: {
            get: () => (db.prepare("SELECT value FROM voice_settings WHERE key = 'eleven_marketing_agent_id'").get() as { value: string } | undefined)?.value,
            set: (id) => void db.prepare("INSERT INTO voice_settings (key, value) VALUES ('eleven_marketing_agent_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(id),
          },
        }));
  let marketingNotes = 0;
  // the marketing call's live numbers: one read at a time, reused for 3 min; opening /marketing starts one (its state GET),
  // so the read is mostly done when he presses Call. The call's start waits up to MARKETING_CONTEXT_MS for it.
  const marketingNumbers = (() => {
    let last: { at: number; text: string } | undefined;
    let pending: Promise<string> | undefined;
    const FRESH_MS = 3 * 60_000;
    const go = (campaigns?: { title: string; spine?: string }[], homeDir?: string): Promise<string> => {
      if (!socialArea?.callNumbers) return Promise.resolve("");
      if (pending) return pending;
      let list = campaigns;
      try {
        list ??= worldCampaigns(socialWorld()).campaigns;
      } catch {
        list = [];
      }
      const p = socialArea
        .callNumbers({ store, world: socialWorld(), homeDir: homeDir ?? resolveRepo(read.reposRoot, homeRepo())?.path, browserUrls: browserArea?.urlsFor(DEFAULT_TENANT) ?? [], browserHeaders: (u) => browserArea?.headersFor(u) ?? {}, campaigns: list })
        .then((text) => ((last = { at: Date.now(), text }), text))
        .catch((e) => `The numbers could not be read for this call: ${(e as Error).message.slice(0, 160)}.`)
        .finally(() => (pending = undefined));
      pending = p;
      return p;
    };
    return {
      warm: () => void (last && Date.now() - last.at < FRESH_MS ? undefined : go()),
      read: async (campaigns: { title: string; spine?: string }[], homeDir?: string) => (last && Date.now() - last.at < FRESH_MS ? last.text : await go(campaigns, homeDir)),
    };
  })();
  const marketingVoice = createVoice({
    ...voiceBase,
    eleven: marketingEleven,
    mint: async () => {
      throw new VoiceError(409, "marketing_eleven_only", `The ${socialProduct()} briefer runs on ElevenLabs only, and ElevenLabs calls are off on this console.`);
    },
    scope: { world: DEFAULT_TENANT },
    contextWaitMs: Number(process.env.CONSOLE_MARKETING_CONTEXT_MS) || 25_000, // live reads (the Team Browser) take seconds
    instructions: marketingInstructions,
    tools: () => MARKETING_TOOLS as any,
    desk: { send: (t, page, crid) => desk.send(t, page, crid), view: () => desk.view() },
    quickStatus: noStatus,
    context: async () => {
      const home = resolveRepo(read.reposRoot, homeRepo())?.path;
      let brief: string | undefined;
      try {
        if (home) brief = fs.readFileSync(path.join(home, marketingBrief()), "utf8");
      } catch {
        /* no brief on this console: the call still has the objectives and the campaigns */
      }
      let campaigns: string | undefined;
      let list: { title: string; spine?: string }[] = [];
      try {
        campaigns = worldCallKnows(socialWorld());
        list = worldCampaigns(socialWorld()).campaigns;
      } catch {
        /* no social world on this console */
      }
      // the owner asked for posts best and worst, Reddit replies, engagement, views, DMs, tester invites and
      // next steps, read live; the read the page's opening started (under 3 min old) or a fresh one, a part that fails says so.
      const numbers = await marketingNumbers.read(list, home);
      return marketingKnows({ brief, objectives: await voiceObjectiveCards(), campaigns, numbers });
    },
    walkRule: () => "",
    relay: async (callId, args) => {
      let r: ReturnType<typeof marketingRelayIn>;
      try {
        r = marketingRelayIn(args);
      } catch (e) {
        throw new VoiceError(400, "bad_relay", (e as Error).message);
      }
      const n = ++marketingNotes;
      if (r.desk === "social") {
        const p = await deskCross?.pass({ world: DEFAULT_TENANT, quote: r.words, about: MARKETING_PAGE, requestId: `marketing-${callId}-${n}` });
        if (p) {
          console.log(`[voice] ${callId} marketing note ${n} passed to the social desk (${p.state})`);
          return { desk: "social", state: p.state, result: "Passed to the social desk, his words only. Tell him in a few words." };
        }
      }
      // the Team desk: his note about building, or (no social desk paired here) his words for the social desk.
      await desk.send(marketingNoteText(callId, r, r.desk === "social"), MARKETING_PAGE, `marketing-${callId}-${n}`);
      console.log(`[voice] ${callId} marketing note ${n} sent to the Team desk`);
      return { desk: "team", state: "sent", result: r.desk === "social" ? "The social desk is not reachable from here: passed to the Team desk, which hands it on. Tell him in a few words." : "Passed to the Team desk as one request. Tell him in a few words." };
    },
  });
  mountOwnCall(api, "/voice/marketing", marketingVoice, { world: () => store.tenant, onState: () => marketingNumbers.warm() }, `The ${socialProduct()} briefer`);
  // the team product's strategy call (/strategy): its own ElevenLabs agent sets the team product's launch
  // strategy with him from the strategy brief (the launch timeline, what ready waits on, the questions) and its
  // objectives; his words go to the Team desk or the social desk. The marketing call's tools and relay, reused.
  const strategyEleven: ElevenCalls | undefined =
    opts.voice?.strategyEleven ??
    (process.env.VITEST || process.env.CONSOLE_VOICE_ELEVEN === "off"
      ? undefined
      : elevenCalls({
          name: strategyAgentName(),
          tags: [teamProduct().toLowerCase(), "strategy-call"],
          key: elevenKey,
          prompt: strategyInstructions,
          firstMessage: STRATEGY_GREETING,
          tools: () => STRATEGY_TOOLS as any,
          known: {
            get: () => (db.prepare("SELECT value FROM voice_settings WHERE key = 'eleven_strategy_agent_id'").get() as { value: string } | undefined)?.value,
            set: (id) => void db.prepare("INSERT INTO voice_settings (key, value) VALUES ('eleven_strategy_agent_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(id),
          },
        }));
  let strategyNotes = 0;
  const strategyVoice = createVoice({
    ...voiceBase,
    eleven: strategyEleven,
    mint: async () => {
      throw new VoiceError(409, "strategy_eleven_only", "The strategy call runs on ElevenLabs only, and ElevenLabs calls are off on this console.");
    },
    scope: { world: DEFAULT_TENANT },
    instructions: strategyInstructions,
    tools: () => STRATEGY_TOOLS as any,
    desk: { send: (t, page, crid) => desk.send(t, page, crid), view: () => desk.view() },
    quickStatus: noStatus,
    context: async () => {
      const home = resolveRepo(read.reposRoot, homeRepo())?.path;
      let brief: string | undefined;
      try {
        if (home) brief = fs.readFileSync(path.join(home, strategyBrief()), "utf8");
      } catch {
        /* no brief on this console: the call still has the objectives */
      }
      return strategyKnows({ brief, objectives: await voiceObjectiveCards() });
    },
    walkRule: () => "",
    relay: async (callId, args) => {
      let r: ReturnType<typeof marketingRelayIn>;
      try {
        r = marketingRelayIn(args);
      } catch (e) {
        throw new VoiceError(400, "bad_relay", (e as Error).message);
      }
      const n = ++strategyNotes;
      if (r.desk === "social") {
        const p = await deskCross?.pass({ world: DEFAULT_TENANT, quote: r.words, about: STRATEGY_PAGE, requestId: `strategy-${callId}-${n}` });
        if (p) {
          console.log(`[voice] ${callId} strategy note ${n} passed to the social desk (${p.state})`);
          return { desk: "social", state: p.state, result: "Passed to the social desk, his words only. Tell him in a few words." };
        }
      }
      await desk.send(strategyNoteText(callId, r, r.desk === "social"), STRATEGY_PAGE, `strategy-${callId}-${n}`);
      console.log(`[voice] ${callId} strategy note ${n} sent to the Team desk`);
      return { desk: "team", state: "sent", result: r.desk === "social" ? "The social desk is not reachable from here: passed to the Team desk, which hands it on. Tell him in a few words." : "Passed to the Team desk as one request. Tell him in a few words." };
    },
  });
  mountOwnCall(api, "/voice/strategy", strategyVoice, { world: () => store.tenant }, "The strategy call");
  // the world desk's Call (same call routes and engine); the home world's Call is the Team desk's /api/voice.
  mountWorldDeskVoice(api, (c) => {
    const w = c.req.param("id") ?? "";
    return w !== DEFAULT_TENANT && store.getTenant(w) ? worldVoice(w) : undefined;
  });
  // each ended call is checked once it settled: what he asked, what the call did (each press and its
  // landing commit, each desk question and its answer), any gap; one line to the desk the call was on, with its memory link (voice/afterCall.ts).
  const afterCall = createAfterCall({
    db,
    deskOf: (c) =>
      c.milestone_id
        ? { send: (t, page, crid) => milestoneChats.send(c.milestone_id!, t, page, crid), view: () => milestoneChats.view(c.milestone_id!) }
        : c.tenant_id && c.tenant_id !== DEFAULT_TENANT
          ? { send: (t, page, crid) => worldDesks.send(c.tenant_id!, t, page, crid), view: () => worldDesks.view(c.tenant_id!) }
          : { send: (t, page, crid) => desk.send(t, page, crid), view: () => desk.view() },
    kept: (id) => memoryForward?.callKept?.(id),
    ...(opts.voice?.now ? { now: opts.voice.now } : {}),
  });
  const afterCallMs = opts.voice?.afterCallTickMs ?? (process.env.VITEST ? 0 : 60_000);
  if (afterCallMs > 0) setInterval(() => void afterCall.tick().catch((e) => console.error("[voice] after-call check:", e)), afterCallMs).unref();
  // rework (the owner's review): voice notes in every chat (the Team desk, a milestone's or campaign's chat): recorded in
  // segments by the page, transcribed once each (gpt-4o-mini-transcribe), posted as his message; the cost is in the voice budget.
  const notesDir = opts.voice?.notesDir ?? process.env.CONSOLE_VOICE_NOTES_DIR ?? path.join(path.dirname(defaultDbPath()), "voice-notes");
  // ElevenLabs Scribe first (his grant; Settings > Transcription picks), our own Whisper on the worker server
  // when it fails (free); the team's shared Gemini key only when ours fails too and his paid backup is on, each such
  // part an alarm. OpenAI is no longer asked.
  const transcribeUrl = process.env.CONSOLE_TRANSCRIBE_URL ?? siteConfig().transcribeUrl;
  const transcribe =
    opts.voice?.transcribe ??
    pickedTranscriber({
      db,
      ours: (m) => localTranscriber(transcribeUrl, () => m),
      eleven: elevenlabsTranscriber(async () => process.env.ELEVENLABS_API_KEY || (await sudoRead(keyFile("ELEVENLABS_API_KEY")))),
      paid: geminiTranscriber(async () => process.env.GEMINI_API_KEY || (await sudoRead(keyFile("GEMINI_API_KEY")))),
      onBackup: (why, file) => {
        const text = `Our own transcription failed on ${file}, so the paid backup (Gemini) wrote it out. Why: ${why.slice(0, 200)}`;
        console.warn(`[voice] ${text}`);
        if (opts.readModel?.drift?.alert) void whatsapp.alert("transcribe-backup", `${text}\nSettings: ${teamLink()}/settings#transcription`);
      },
    });
  const notesOf = new WeakMap<Voice, VoiceNotes>();
  // a posted Chat note also goes to the world's the memory service (made below, with the memory service connections); never awaited.
  let memoryForward: MemoryArea["forward"];
  let memoryConns: MemoryArea | undefined; // made below, with the voice note relay
  // a note filed on one item hands what else he said to the world's Team desk (voice/spill.ts); off without the cycle.
  const voiceSpill: VoiceSpill | undefined = spillOpt
    ? createVoiceSpill({
        db,
        judge: textSpillJudge,
        // a card note in a paired world: the other desk's part goes back to this desk with its relay call (L-55).
        ...(deskCross
          ? {
              across: (w: string): SpillAcross | undefined => {
                const p = deskCross.across(w);
                if (!p) return undefined;
                const base = cycle.publicUrl.replace(/\/+$/, "");
                return {
                  here: p.from.product,
                  hereIs: productWork(p.from.product),
                  there: p.to.product,
                  thereIs: productWork(p.to.product),
                  passUrl: w === DEFAULT_TENANT ? `${base}/api/desk/pass` : `${base}/api/tenants/${w}/desk/pass`,
                  passHeader: `X-Console-Run: ${w === DEFAULT_TENANT ? "team-desk" : worldDesks.runHeader(w)}`,
                  ...(w === DEFAULT_TENANT ? {} : deskBearer(w)),
                };
              },
            }
          : {}),
        ...(cycleOpts.enabled
          ? { tell: deskTell }
          : {}),
        ...(opts.voice?.now ? { now: opts.voice.now } : {}),
      })
    : undefined;
  if (voiceSpill && cycleOpts.enabled && (spillOpt?.sweepMs ?? 60_000) > 0) setInterval(() => void voiceSpill.sweep().catch((e) => console.error("voice spill sweep:", e)), spillOpt?.sweepMs ?? 60_000).unref();
  // companies set on screen and a wheel's notes (the home world only): the tenancy plug's (hosted/tenancy.ts).
  const companyNotes = tenancy?.mountCompanyWrites({
    api,
    reposRoot: read.reposRoot,
    spine,
    send: (mid, t, page, crid) =>
      mid ? milestoneChats.send(mid, t, page, crid) : desk.send(t, page, crid).then((r) => (deskSaid(DEFAULT_TENANT, t, crid, r.pending), r)),
    hasMilestone: (id) => !!store.getMilestone(id),
  });
  const wheelFiled = (f: { id: string; world: string; milestoneId?: string; fill: boolean; page?: string; words: string; audio: string }) => {
    if (f.fill || f.world !== DEFAULT_TENANT) return;
    void companyNotes?.filedVoice(f).catch((e) => console.error("wheel note:", e));
  };
  /** `chat`: where a posted (not card) note lands is the world's Team desk itself, which reads all of it: no spill. */
  // a posted Chat note is checked in its chat's thread (its head line names the note id) before it counts as delivered.
  // "queued": the note waits to go in, held by the console while T3 is down or in T3's own queue while the desk is busy; a
  // re-send then would only add a copy (22 Nov: 13 copies of one note, a fresh request id per re-send while T3 was down).
  const inChat =
    (read: () => Promise<{ messages: { role: string; text: string }[]; queued?: { text: string }[]; stale?: boolean }>, t3Queued?: () => Promise<string[]>) =>
    async (id: string): Promise<boolean | "queued" | undefined> => {
      const v = await read();
      if (v.messages.some((m) => m.role === "user" && m.text.includes(id))) return true;
      if (v.queued?.some((q) => q.text.includes(id))) return "queued";
      // "absent" (false) only from a live read with T3's queue listed; T3 down, unreachable, stale or a queue
      // that could not be listed is "cannot tell", so the note keeps its one request id (22 Nov: 23 copies of vn_59852983)
      if ((v as { t3?: unknown }).t3 || (v as { unreachable?: unknown }).unreachable || v.stale) return undefined;
      if (!t3Queued) return undefined;
      const inQueue = await t3Queued().catch(() => undefined);
      if (!inQueue) return undefined;
      if (inQueue.some((t) => t.includes(id))) return "queued";
      return false;
    };
  // the note's world's Delivery Manager gets one desk-inbox line (its home checkout), and production one WhatsApp alert.
  const undeliveredLine = (u: { id: string; world: string; tries: number; ms: number; gaveUp: boolean; postedAt: string; words: string }) => {
    const text = u.gaveUp ? `Voice note ${u.id} is still not in the chat after ${u.tries} re-sends; the console keeps re-sending it.` : `Voice note ${u.id} showed Sent but is not in the chat ${Math.round(u.ms / 60_000)} min later; the console is re-sending it.`;
    console.warn(`[voice] ${text}`);
    if (opts.readModel?.drift?.alert) void whatsapp.alert("voice-send-undelivered", `${text}\nDetails: ${teamLink()}/api/health`);
    const home = worldHome(u.world);
    if (!home || opts.passive) return;
    void writeUndeliveredNote({ ...u, replyTo: home.remote ?? home.name, day: new Date().toISOString().slice(0, 10) }, home, spine)
      .then((r) => console.log(`[voice] ${u.id} not delivered: desk note ${r}`))
      .catch((e) => console.error(`[voice] ${u.id} desk note failed:`, e instanceof Error ? e.message : e));
  };
  const notesFor = (v: Voice, desk: Pick<DeskPort, "send">, chat: "team-desk" | "milestone", seen?: (id: string) => Promise<boolean | "queued" | undefined>) => {
    let n = notesOf.get(v);
    if (!n)
      notesOf.set(
        v,
        (n = createVoiceNotes({
          db,
          voice: v,
          desk,
          transcribe,
          dir: notesDir,
          onPosted: (id) => void memoryForward?.enqueue(id),
          ...(seen ? { seen } : {}),
          onUndelivered: undeliveredLine,
          // a note (or part) neither OpenAI nor Gemini turned into words: one WhatsApp to the owner with its audio
          // (kind voice-note-unheard, outside the alert caps, once a note); the desk already got the line with the link.
          onUnheard: (u) => {
            const text = `Your voice note ${u.id} could not be transcribed${u.parts.length < u.of ? ` (${u.parts.length} of ${u.of} parts)` : ""}: our Whisper and the paid backup both failed. Audio: ${u.audio}${u.error ? `\nWhy: ${u.error.slice(0, 200)}` : ""}`;
            console.warn(`[voice] ${text}`);
            if (opts.readModel?.drift?.alert) void whatsapp.alert("voice-note-unheard", text);
          },
          // tap stop to Sent over 3 s, or an accepted note still not posted: a log line, /api/health `voiceSend`
          // and, in production, one WhatsApp per episode (the notifier's per-kind gap).
          onSlow: (x) => {
            const where = x.parts ? ` Where it went: ${Object.entries(x.parts).map(([k, v]) => `${k} ${v}`).join(", ")}.` : "";
            const text = x.kind === "slow" ? `Voice note ${x.id} took ${(x.ms / 1000).toFixed(1)} s from tap stop to Sent (the limit is 3 s).${where}` : `Voice note ${x.id} was Sent ${Math.round(x.ms / 60_000)} min ago but is not in the chat yet; the console keeps retrying it.`;
            console.warn(`[voice] ${text}`);
            if (opts.readModel?.drift?.alert) void whatsapp.alert(`voice-send-${x.kind}`, `${text}\nDetails: ${teamLink()}/api/health`);
          },
          ...(voiceSpill
            ? {
                onFiled: (f) => {
                  wheelFiled(f);
                  // a long note filed anywhere marks the cards it touches (the Team desk Chat's own reaches it through deskSaid too; one pass per note id)
                  if (f.fill || chat !== "team-desk")
                    void noteTouch?.heard({ id: f.id, world: f.world, words: f.words, where: f.fill ? `${f.page ?? "a card"}` : "a milestone chat", ref: f.id }).catch((e) => console.error("note touch:", e));
                  if (!f.fill && chat === "team-desk") return;
                  const title = f.milestoneId ? store.getMilestone(f.milestoneId)?.title : undefined;
                  const where = f.fill ? `${f.page ?? "a card"}${title ? ` (in ${title})` : ""}` : `the ${title ?? "milestone"} chat`;
                  void voiceSpill
                    .filed({ id: f.id, world: f.world, ...(f.milestoneId ? { milestoneId: f.milestoneId } : {}), where, words: f.words, audio: f.audio })
                    .catch((e) => console.error("voice spill:", e));
                },
              }
            : { onFiled: wheelFiled }),
          ...(opts.voice?.now ? { now: opts.voice.now } : {}),
        })),
      );
    return n;
  };
  const teamDeskNotes = () =>
    notesFor(voice, { send: (t, page, crid) => desk.send(t, page, crid).then((r) => (deskSaid(DEFAULT_TENANT, t, crid, r.pending), r)) }, "team-desk", inChat(() => desk.view(), desk.t3QueuedTexts));
  const worldDeskNotes = (w: string) =>
    notesFor(worldVoice(w), { send: (t, page, crid) => worldDesks.send(w, t, page, crid).then((r) => (deskSaid(w, t, crid, r.pending), r)) }, "team-desk", inChat(() => worldDesks.view(w)));
  teamUndelivered = () => ((store.tenant ?? DEFAULT_TENANT) === DEFAULT_TENANT ? teamDeskNotes().undelivered() : []);
  mountVoiceNotesRec(api, "/voice", (c) =>
    (store.tenant ?? DEFAULT_TENANT) === DEFAULT_TENANT
      ? teamDeskNotes()
      : c.json({ error: { code: "world_scope", message: `the Team desk is only on ${ownerName()}'s own console` } }, 403),
  );
  // voice notes in a world's team desk.
  mountVoiceNotesRec(api, "/tenants/:id/desk/voice", (c) => {
    const w = c.req.param("id") ?? "";
    if (w === DEFAULT_TENANT || !store.getTenant(w)) return c.json({ error: { code: "not_found", message: `no world desk ${w}` } }, 404);
    return worldDeskNotes(w);
  });
  // every recording of his findable by note id, any world, for a video snippet later (voice/audioStore.ts).
  mountAudioStore(api, db);
  mountVoiceNotesRec(api, "/milestones/:id/voice", (c) => {
    const id = c.req.param("id") ?? "";
    const v = campaignVoice(id);
    if (!v) return c.json({ error: { code: "not_found", message: `milestone ${id} not found` } }, 404);
    const mid = v.scope.milestoneId!;
    return notesFor(v, { send: (t, page, crid) => milestoneChats.send(mid, t, page, crid) }, "milestone", inChat(() => milestoneChats.view(mid)));
  });
  // a note shown Sent (its audio safe here) whose words or post did not go (a failed post, a restart in
  // between) is finished by the console itself, once a minute, in whichever chat it was recorded.
  const resumeNotes = async () => {
    const scopes = db
      .prepare(
        "SELECT DISTINCT tenant_id, milestone_id FROM voice_notes WHERE (accepted_at IS NOT NULL AND state IN ('recording', 'failed') AND finish_tries < 30) OR (state = 'posted' AND delivered_at IS NULL AND post_json IS NOT NULL AND posted_at >= ?)",
      )
      .all(new Date(Date.now() - DELIVER_WINDOW_MS).toISOString()) as { tenant_id: string; milestone_id: string | null }[];
    for (const sc of scopes) {
      let n: VoiceNotes | undefined;
      if (sc.milestone_id) {
        const v = campaignVoice(sc.milestone_id);
        if (v) n = notesFor(v, { send: (t, page, crid) => milestoneChats.send(v.scope.milestoneId!, t, page, crid) }, "milestone", inChat(() => milestoneChats.view(v.scope.milestoneId!)));
      } else if (sc.tenant_id === DEFAULT_TENANT) n = (store.tenant ?? DEFAULT_TENANT) === DEFAULT_TENANT ? teamDeskNotes() : undefined;
      else if (store.getTenant(sc.tenant_id)) n = worldDeskNotes(sc.tenant_id);
      await n?.resume().catch((e) => console.error("[voice] resume notes:", e));
      // a posted note not in its chat 2 min on is re-sent, shown "not delivered yet, retrying", and named.
      await n?.deliverCheck().catch((e) => console.error("[voice] delivery check:", e));
    }
  };
  const resumeMs = opts.voice?.resumeNotesMs ?? (process.env.VITEST ? 0 : 60_000);
  if (resumeMs > 0) setInterval(() => void resumeNotes().catch((e) => console.error("[voice] resume notes:", e)), resumeMs).unref();
  if (opts.whatsapp?.tickMs) setInterval(() => void whatsapp.tick(), opts.whatsapp.tickMs).unref();
  // a key result turning green or red is one WhatsApp line (the notifier keeps what he was told, its caps and
  // quiet hours); read every 10 min with the WhatsApp tick on, never on this thread in tests.
  // the objectives screen's list (its order, its key results) for the picture of the lights.
  const objectivesNow = async () => greenHistory(await idleWatch.decorate(await scorecardsNow())) as unknown as ObjectivesInput;
  whatsapp.useObjectives?.(objectivesNow); // the evening brief picture reads the same list
  const keyResultsTick = async () => {
    if (!whatsapp.keyResults || !keyResultsNow) return undefined;
    return whatsapp.keyResults(await keyResultsNow(), objectivesNow);
  };
  const keyResultsMs = opts.whatsapp?.keyResultsMs ?? (opts.whatsapp?.tickMs ? 10 * 60_000 : 0);
  if (keyResultsMs) setInterval(() => void outsideRequest(() => keyResultsTick().catch(() => undefined)), keyResultsMs).unref();
  api.post("/notify/whatsapp/key-results/check", async (c) => c.json((await keyResultsTick().catch((e) => ({ held: (e as Error).message }))) ?? { held: "off" }));
  api.post("/notify/whatsapp/key-results/test", async (c) => {
    if (!whatsapp.keyResultTest || !keyResultsNow) return c.json({ ok: false, error: "off" }, 409);
    const r = await whatsapp.keyResultTest(await keyResultsNow(), objectivesNow);
    return c.json(r, r.ok ? 200 : r.error === "not_configured" ? 409 : r.error?.startsWith("rate_limited") ? 429 : 502);
  });
  // the picture of the objectives' lights, now (the evening brief links it): {id, url, bytes}.
  api.post("/notify/whatsapp/lights-picture", async (c) => {
    if (!whatsapp.lightsPicture) return c.json({ error: "off" }, 409);
    const b = (await c.req.json().catch(() => ({}))) as { changes?: { key: string; label: string; objective: string; from: string; to: string }[]; test?: boolean };
    const r = await whatsapp.lightsPicture(await objectivesNow(), { ...(Array.isArray(b.changes) ? { changes: b.changes } : {}), ...(b.test ? { test: true } : {}) });
    return r ? c.json(r) : c.json({ error: "no picture" }, 500);
  });
  // the owner marks the outcome (writes ## Outcome, Status, a Decisions row through the same spine writer).
  mountMark(api, {
    store,
    spine,
    locate: async (m) => {
      const { loc, rel, spines } = await spinesFor(m, 4_000);
      return { repoDir: loc?.repo.path, rel, outcome: spines && rel ? outcomeFor(spines, rel) : null };
    },
    invalidate: (dir) => dropSpines(dir),
    status: (m) => status.one(m),
    deskAsk: (chat) => desk.jordiAsk(chat), // the Team desk marks on the owner's own chat request
    settle: (id) => recordedMilestones().setSettled(id, true),
  });
  // Repo-relative spine paths in a milestone's tree (a stamp or an Add on a child epic's node names its path).
  const treePaths = async (m: Milestone) => {
    const out = new Set<string>();
    const visit = (n: { kind: string; path?: string; children: { kind: string; path?: string; children: unknown[] }[] }) => {
      if (n.kind === "spine" && n.path) out.add(n.path.replace(/^\.\//, ""));
      n.children.forEach((c) => visit(c as typeof n));
    };
    visit((await treeFor(m, 4_000)).root);
    return out;
  };
  // the owner stamps a Planning epic ready for delivery (or moves it back): Status + a Decisions row, same writer and guard.
  mountStamp(api, {
    store,
    spine,
    locate: async (m) => {
      const { loc, rel } = await spinesFor(m, 4_000);
      return { repoDir: loc?.repo.path, rel };
    },
    treePaths,
    invalidate: (dir) => dropSpines(dir),
    deskAsk: (chat) => desk.jordiAsk(chat),
    memory, // the stamp citing the owner's voice note reads it here
  });
  // Add on a tree node: a ledger row, Done-means line or child epic, through the same writer (the desk calls it too).
  mountTreeAdd(api, {
    store,
    spine,
    delivery: (id) => deliveryFor(store, id), // the answer says when the work will not be delivered
    skillDir: read.skillDir,
    locate: async (m) => {
      const { loc, rel } = await spinesFor(m, 4_000);
      return { repoDir: loc?.repo.path, rel };
    },
    treePaths,
    invalidate: (dir) => dropSpines(dir),
    // the desk's Add with the owner's words is his ask (ready); a ready Add wakes the DM as the Approvals tab does.
    // his words from any of his desk messages of the last 24 h count, not only the newest one.
    deskAsk: (chat) => desk.jordiWords(chat),
    chatSaid: async (header, chat) => {
      const callerId = chatScope.caller(header);
      if (!callerId || saidWords(chat).length < 8) return false;
      return saidRequest(await milestoneChats.chatFor(callerId).jordiMessages(), chat);
    },
    wake: (m, instructions) => wakeDeliveryManager({ store, cycle, homeThread: (id) => cycle.getLink(id)?.threadId }, m, instructions),
    // An Add the desk makes is its placement (the delivered note follows it); the owner's own Add on the page is not.
    onAdded: (a, header) => {
      if ((header("x-console-run") ?? "").trim().toLowerCase() !== "team-desk") return;
      try {
        desk.placements.place({ repo: path.basename(a.repoDir), path: a.kind === "epic" ? (a.newPath ?? a.path) : a.path, kind: a.kind, ...(a.id ? { itemId: a.id } : {}), title: a.title });
      } catch (e) {
        console.error("desk placement not recorded:", e);
      }
    },
  });
  // ticket sessions; no launch any more, POST answers with the milestone chat about the row (the desk calls it too).
  migrateTicketSessions(db);
  ensureTenancy(db); // tenant_id on the side tables created above (idempotent)
  mountTicketSessions(
    api,
    createTicketSessions({
      db,
      store,
      publicUrl: cycle.publicUrl,
      reposRoot: read.reposRoot,
      locate: async (m) => {
        const { loc, rel } = await spinesFor(m, 4_000);
        return { repoDir: loc?.repo.path, rel };
      },
      treePaths,
      environmentId: () => cycle.hostEnvironment(mainHost()),
    }),
  );
  secretsArea?.mount(); // Secrets page, other worlds first (hosted/secrets.ts)
  // the Team skills screen (library from the code repo skills/team-skills.json; add/remove: the owner, the home world, commit + push + sync).
  const unscoped = createStore(db);
  mountTeamSkills(api, {
    repoDir: skillsRepo,
    cli: skillsCli,
    spine,
    personas: () => store.listPersonas(),
    allPersonas: () => unscoped.listPersonas(),
    // through the persona's file first; a refused write leaves the persona as it was (logged)
    detach: (id, skills) => personaRecord.recorded(unscoped).updatePersona(id, { skills }).catch((e) => console.warn(`team skills: detach from ${id}: ${(e as Error).message}`)),
    worldRepo,
    worldCheckouts,
    ...(opts.teamSkills?.syncHosts ? { syncHosts: opts.teamSkills.syncHosts } : {}),
  });
  // Approvals tab: list / add / edit / revoke standing approvals (same spine writer and lock), then wake the DM.
  mountApprovals(api, {
    store,
    cycle,
    spine,
    spinesFor: async (m, softMs) => {
      const { loc, rel, spines } = await spinesFor(m, softMs);
      return { repoDir: loc?.repo.path, rel, spines };
    },
    invalidate: (dir) => dropSpines(dir),
    homeThread: (id) => cycle.getLink(id)?.threadId,
  });

  // Milestones
  // nonGreen and verdict, each milestone's last info at once (listInfo, refreshed in the background). The list omits doctrine.
  // settled milestones are hidden unless ?includeSettled=true; each row carries settledAt.
  // ?tenant=<world> keeps one world's milestones (the Team desk acts only on the home world's; the rest are other worlds').
  api.get("/milestones", async (c) =>
    c.json(
      await Promise.all(
        store.listMilestones({ includeSettled: includeSettled(c) }).filter((m) => !c.req.query("tenant") || store.worldOfMilestone(m.id) === c.req.query("tenant")).map((m) => listInfo.get(m)),
      ),
    ),
  );
  // ?nodeKey= re-roots the tree at that node (node view) with its own counts; `tracked` maps spine paths in
  // the milestone's repo to the milestone tracking each (Track as milestone / link).
  api.get("/milestones/:id/tree", async (c) => {
    const m = found(store.getMilestone(c.req.param("id")), "milestone", c.req.param("id"));
    // colors from the pending items (a node with an open item is red; red count = open items).
    const tree = await status.paintedTree(m, await treeFor(m));
    const nodeKey = c.req.query("nodeKey");
    const hit = nodeKey ? found(subtree(tree, nodeKey), "node", nodeKey) : undefined;
    const out = hit ? { ...hit, counts: { ...hit.counts, red: redCount(hit.root) } } : tree;
    const loc = m.path ? locate(read.reposRoot, m) : undefined;
    const repo = loc && "repo" in loc ? loc.repo : undefined;
    // `stale` while a newer tree (after a pull) is being built, `builtAt` when this one was.
    const info = reads.treeInfo(m);
    const fresh = info ? { builtAt: new Date(info.builtAt).toISOString(), ...(info.stale ? { stale: true } : {}) } : {};
    return c.json({ ...out, ...fresh, ...(repo ? { repo: repo.name, ...(repo.remote ? { remote: repo.remote } : {}), tracked: trackedIn(read.reposRoot, store, repo) } : {}) });
  });
  // `world` (the milestone's tenant) lets the page offer the Epic Book only on the home world's own milestones.
  api.get("/milestones/:id", async (c) => {
    const m = await withOutcome(found(store.getMilestone(c.req.param("id")), "milestone", c.req.param("id")));
    return c.json({ ...m, world: store.worldOfMilestone(m.id) ?? DEFAULT_TENANT });
  });
  // spine commits made during each run of the milestone (spine + its linked pages' dirs), keyed by run id.
  api.get("/milestones/:id/run-commits", async (c) => {
    const m = found(store.getMilestone(c.req.param("id")), "milestone", c.req.param("id"));
    const { loc, rel, spines } = await spinesFor(m);
    if (!loc || !rel) return c.json({} as Record<string, RunCommit[]>);
    const pages = (spines && doctrineFor(spines, rel)?.pages) ?? [];
    // A page in the spine's own folder counts by itself; a page elsewhere brings its folder (the linked docs dir).
    const own = path.posix.dirname(rel);
    const paths = [...new Set([rel, ...pages.map((p) => (path.posix.dirname(p.path) === own ? p.path : path.posix.dirname(p.path)))])].filter(
      (p) => p && p !== ".",
    );
    // one log per milestone; each commit attributed to one run (Run: trailer > child ticket id > wake).
    return c.json(await runCommits(loc.repo.path, paths, store.listRuns({ milestoneId: m.id, limit: 100 })));
  });
  // settle / unsettle: the spine and the derived status/verdict are untouched; the mark is in the team repo's
  // state/milestones.json first (recordFirst), then console.db.
  // settle only once the outcome is marked (accomplished, partially, superseded); unsettle always.
  const settleOne = async (c: Context, id: string, settled: boolean) => {
    const cur = found(store.getMilestone(id), "milestone", id);
    if (settled && !cur.settledAt) {
      const word = (await status.one(cur)).outcome.word;
      if (!SETTLE_OK.has(word)) throw new ApiError(409, "not_accomplished", SETTLE_REFUSED, { outcome: word });
    }
    const { doctrine: _d, ...out } = await withOutcome(found(await recordFirst(() => recordedMilestones().setSettled(id, settled)), "milestone", id), 1_500);
    return c.json(out);
  };
  // settling is the owner's verdict: a chat (the Team desk or a milestone chat) never settles by this route; the Team desk
  // settles through POST /desk/settle on his own newest desk message, milestone chats not at all.
  const chatSettle = (settled: boolean) => async (c: Context) => {
    if ((c.req.header("x-console-run") ?? "").trim())
      throw new ApiError(403, "jordi_only", `a chat cannot ${settled ? "settle" : "unsettle"} a milestone here: ${ownerName()} does it on the console page, or asks the Team desk (POST /api/desk/settle)`);
    return settleOne(c, c.req.param("id")!, settled);
  };
  api.post("/milestones/:id/settle", chatSettle(true));
  api.post("/milestones/:id/unsettle", chatSettle(false));
  // the Team desk settles / unsettles on the owner's own chat request (same check as the desk stamp and mark).
  api.post("/desk/settle", async (c) => {
    const refused = deskOnly((n) => c.req.header(n));
    if (refused) throw new ApiError(403, "desk_only", refused);
    const b = ((await c.req.json().catch(() => undefined)) ?? undefined) as Record<string, unknown> | undefined;
    if (!b) throw new ApiError(400, "invalid_json", "request body must be valid JSON");
    if (typeof b.milestoneId !== "string") throw new ApiError(400, "validation_error", "milestoneId is required");
    if (typeof b.chat !== "string") throw new ApiError(400, "validation_error", `chat (${ownerName()}'s words from his desk message, verbatim) is required`);
    if (b.settled !== undefined && typeof b.settled !== "boolean") throw new ApiError(400, "validation_error", "settled must be true or false");
    const settled = b.settled !== false;
    found(store.getMilestone(b.milestoneId), "milestone", b.milestoneId);
    const ask = await desk.jordiAsk(b.chat);
    if (typeof ask === "string") throw new ApiError(403, "not_asked", `${ask}: the desk settles only on ${ownerName()}'s own newest message`);
    if (!asksForSettle(ask.text, settled))
      throw new ApiError(403, "not_asked", `${ownerName()}'s newest desk message does not ask to ${settled ? "settle" : "unsettle"}: he says it here, or does it in the milestone's Settings`);
    return settleOne(c, b.milestoneId, settled);
  });
  /** a world names only one of its own checkouts; the home world keeps every repo it names. */
  const ownRepo = (repo: string | undefined) => {
    const why = repo === undefined ? undefined : milestoneRepoRefusal(db, read.reposRoot, store.tenant, repo);
    if (why) throw new ApiError(404, "repo_not_found", why);
  };
  api.post("/milestones", async (c) => {
    const input = await body(c, s.milestoneCreate);
    ownRepo(input.repo);
    const made = await withDeliveryManager(await recordFirst(() => recordedMilestones().createMilestone({ ...input, bigRoot: null }))); // with its Delivery Manager
    // a big root's position goes to state/big-roots.json first, then console.db.
    let tw = {};
    if (input.bigRoot != null && store.worldOfMilestone(made.id) === homeWorld()) {
      tw = await bigRootsWrite(`${made.title} added at ${input.bigRoot}`, homeAfter({ ...made, bigRoot: input.bigRoot }));
      store.updateMilestone(made.id, { bigRoot: input.bigRoot });
    }
    const { doctrine: _d, ...out } = await withOutcome(store.getMilestone(made.id)!, 1_500);
    return c.json({ ...out, ...tw }, 201);
  });
  const patchMilestone = async (c: Context) => {
    const id = c.req.param("id")!;
    const { title, ...p } = await body(c, s.milestonePatch);
    const cur = found(store.getMilestone(id), "milestone", id);
    ownRepo(p.repo);
    // a title that differs from the spine's own marks it explicit (it wins from then on); an empty title or
    // the spine's title clears the mark (the stored title is kept, the spine's shows).
    let titleP: { title?: string; titleSetAt?: string | null } = {};
    if (title !== undefined) {
      const { loc, rel, spines } = await spinesFor(cur, 1_500);
      const doc = docTitleOf(spines, rel, loc);
      if (!title) titleP = { titleSetAt: null };
      else if (title === doc) titleP = { title, titleSetAt: null };
      else if (title !== cur.title || !cur.titleSetAt) titleP = { title, titleSetAt: new Date().toISOString() };
    }
    // a reorder, add, removal or rename of a big root is written to the team repo's state/big-roots.json, and
    // first, as is every other change (state/milestones.json); console.db changes only once both are written.
    const after = { ...cur, ...p, ...(titleP.title !== undefined ? { title: titleP.title } : {}), ...(p.bigRoot !== undefined ? { bigRoot: p.bigRoot ?? undefined } : {}) } as Milestone;
    const touched = (p.bigRoot !== undefined && (p.bigRoot ?? null) !== (cur.bigRoot ?? null)) || (after.title !== cur.title && (cur.bigRoot != null || after.bigRoot != null));
    const tw = touched && store.worldOfMilestone(id) === homeWorld() ? await bigRootsWrite(`${after.title} ${after.bigRoot != null ? `at ${after.bigRoot}` : "made ordinary"}`, homeAfter(after)) : {};
    const { doctrine: _d, ...out } = await withOutcome(found(await recordFirst(() => recordedMilestones().updateMilestone(id, { ...p, ...titleP })), "milestone", id), 1_500);
    return c.json({ ...out, ...tw });
  };
  api.patch("/milestones/:id", patchMilestone);
  api.put("/milestones/:id", patchMilestone);
  /**
   * the Team desk keeps the owner's priority order. One call puts every big root in a new order (positions 1..n)
   * in ONE commit to state/big-roots.json, quoting his words in `why`; console.db follows only once the file is written (L-45).
   * The same set as now, no pin or unpin here (that stays PATCH bigRoot). `line` is the one line the desk says back.
   */
  api.put("/big-roots/order", async (c) => {
    const refused = deskOnly((n) => c.req.header(n));
    if (refused) throw new ApiError(403, "desk_only", refused);
    const b = ((await c.req.json().catch(() => undefined)) ?? undefined) as Record<string, unknown> | undefined;
    if (!b) throw new ApiError(400, "invalid_json", "request body must be valid JSON");
    const why = typeof b.why === "string" ? b.why.replace(/\s+/g, " ").trim() : "";
    if (!why) throw new ApiError(400, "validation_error", `why (${ownerName()}'s words that changed the priority, verbatim) is required`);
    if (!Array.isArray(b.order) || !b.order.every((x) => typeof x === "string")) throw new ApiError(400, "validation_error", "order must be a list of milestone ids, most pressing first");
    const order = b.order as string[];
    const all = createStore(db, { tenant: DEFAULT_TENANT }).listMilestones({ includeSettled: true });
    const roots = all.filter((m) => m.bigRoot != null).sort((x, y) => x.bigRoot! - y.bigRoot! || x.createdAt.localeCompare(y.createdAt));
    const ids = new Set(roots.map((m) => m.id));
    const extra = order.filter((id) => !ids.has(id));
    const missing = roots.filter((m) => !order.includes(m.id));
    if (extra.length || missing.length || new Set(order).size !== order.length)
      throw new ApiError(400, "not_same_roots", `order must list every big root once and nothing else${extra.length ? `; not a big root: ${extra.join(", ")}` : ""}${missing.length ? `; missing: ${missing.map((m) => `${m.id} (${m.title})`).join(", ")}` : ""} (pin or unpin with PATCH /api/milestones/<id> bigRoot)`);
    const byId = new Map(roots.map((m) => [m.id, m]));
    const next = order.map((id, i) => ({ ...byId.get(id)!, bigRoot: i + 1 }));
    const line = `Priorities now: ${next.map((m) => `${m.bigRoot} ${m.title}`).join(", ")}.`;
    const out = next.map((m) => ({ position: m.bigRoot, title: m.title, milestoneId: m.id }));
    if (next.every((m) => byId.get(m.id)!.bigRoot === m.bigRoot)) return c.json({ changed: false, order: out, line });
    const moved = order.filter((id, i) => roots[i]?.id !== id).length ? "reordered" : "renumbered";
    const tw = await bigRootsWrite(`${moved} by the Team desk: ${next.map((m) => `${m.bigRoot} ${m.title}`).join(", ")} (${ownerName()}: "${why.slice(0, 200)}")`, [...all.filter((m) => !byId.has(m.id)), ...next]);
    const a9 = createStore(db, { tenant: DEFAULT_TENANT });
    for (const m of next) a9.updateMilestone(m.id, { bigRoot: m.bigRoot });
    return c.json({ changed: true, order: out, line, ...tw });
  });
  api.delete("/milestones/:id", async (c) => {
    const id = c.req.param("id");
    const was = store.getMilestone(id);
    const world = was ? store.worldOfMilestone(id) : undefined;
    found(was, "milestone", id);
    if (was?.bigRoot != null && world === homeWorld()) await bigRootsWrite(`${was.title} removed`, homeAfter(undefined, id)); // file first
    await recordFirst(() => recordedMilestones().deleteMilestone(id));
    return c.body(null, 204);
  });

  // Personas
  api.get("/personas", (c) => c.json(store.listPersonas()));
  // worlds (read-only; scoped like the store). S3 adds /api/me, S5 the second tenant.
  api.get("/tenants", (c) => c.json(store.listTenants()));
  api.get("/tenants/:id", (c) => c.json(found(store.getTenant(c.req.param("id")), "tenant", c.req.param("id"))));
  //..S27,: the social routes and the one write API (hosted/social.ts).
  socialArea?.mountRoutes({
    api,
    store,
    skillDir: read.packSkillDir,
    wake: cycleOpts.enabled ? async (id, note) => (await cycle.runNowRequest(id, { instructions: note, instructionsBy: ownerName() })).run : undefined,
    recordAssignments: (s) => assignmentRecord.recorded(s), // a brief's cadence goes to the team repo first
    teamDir: agentTeamDir,
  });
  // GET /tenants/:id/onboarding, the social product scorecard (six ticks read from live state,'s wizard).
  const instanceWorld = (url: string) => browserArea?.worldOf(url);
  const ownBrowser = (w: string) => browserArea?.own(w);
  tenancy?.mountOnboarding({
    api,
    db,
    store,
    reposRoot: read.reposRoot,
    social,
    ownBrowser,
    lentBrowsers: (w) => (browserArea?.urlsFor(w) ?? []).filter((u) => u !== ownBrowser(w)),
    siteHeaders: (url) => {
      const w = instanceWorld(url);
      return w ? browserArea?.headersOfWorld(w) ?? {} : {};
    },
    // sign-in counts only on the product's customer site; the EpicTeam side reads the world's servers.
    customerSites: () => customerHosts(process.env),
    hosts: (w) => {
      try {
        return (db.prepare("SELECT id FROM hosts WHERE tenant_id = ? ORDER BY id").all(w) as { id: string }[]).map((h) => h.id);
      } catch {
        return [];
      }
    },
  });
  // the site numbers and the hourly KPI read, held posts as cards, campaigns, the digest (hosted/social.ts).
  const sites = socialArea?.mountSites({
    api,
    store,
    skillDir: read.packSkillDir,
    codeViews: opts.siteCodeViews ?? null,
    referrers: opts.siteReferrers ?? null,
    kpiEveryMs: opts.kpiRecord?.everyMs,
    browserUrls: (w) => browserArea?.urlsFor(w) ?? [],
    browserHeaders: (url) => browserArea?.headersFor(url) ?? {},
    record: { milestones: (ts) => milestoneRecord.recorded(ts), personas: (ts) => personaRecord.recorded(ts), assignments: (ts) => assignmentRecord.recorded(ts) },
    socialUrl: process.env.CONSOLE_SOCIAL_URL || (process.env.CONSOLE_STAGING === "1" ? cycle.publicUrl : siteConfig().socialUrl),
    digestBase: process.env.CONSOLE_SOCIAL_URL || cycle.publicUrl,
    notify: cycleOpts.enabled ? (text, id) => desk.tell(text, id) : undefined,
    spine, // a posting number saved from Settings commits through the spine writer
    ownerName,
  });
  postReview = sites?.postReview;
  const campaigns = sites?.campaigns;
  // the social product tester signup (public form on epicspine.dev → this db, a `[tester]` note to the owner's desk, /testers list).
  // the Testers page (hosted/tenancy.ts).
  // the hosted layer may raise a decide ask in a spine of one of its checkouts and read its answer back from the file
  // (the spine is the record; the console's one writer commits it).
  const spineAsks = {
    raise: async (o: { repo: string; path: string; question: string; row?: string; askedBy: string }) => {
      const home = resolveRepo(read.reposRoot, o.repo);
      if (!home) return { error: `no ${o.repo} checkout` };
      const ms = store.listMilestones().filter((m) => resolveRepo(read.reposRoot, m.repo)?.path === home.path);
      const m = ms.find((x) => x.path.replace(/^\.\//, "") === o.path) ?? ms.find((x) => /(?:^|\/)root\.md$/.test(x.path)) ?? ms[0];
      if (!m) return { error: `no milestone in ${o.repo} to raise the ask in` };
      const r = await raiseAsk(raiseDeps(), m, { question: o.question, askedBy: o.askedBy, row: o.row, kind: "decide" }, o.path);
      return r.status === "written" ? { code: r.code } : { error: r.reason };
    },
    read: (o: { repo: string; path: string; code: string }) => {
      const home = resolveRepo(read.reposRoot, o.repo);
      if (!home) return undefined;
      let text = "";
      try {
        text = fs.readFileSync(path.join(home.path, o.path), "utf8");
      } catch {
        return undefined;
      }
      if (new RegExp(`\\[superseded\\s+${o.code}\\b`).test(text)) return { state: "superseded" as const };
      const a = parseAsks(text).find((x) => x.code === o.code);
      return a ? { state: a.state === "open" ? ("open" as const) : ("answered" as const), answer: a.answer ?? undefined } : undefined;
    },
  };
  tenancy?.mountTesters({ api, db, notify: cycleOpts.enabled ? (text, id) => desk.tell(text, id) : undefined, spineAsks });
  // the overnight read's three morning items, one Team desk message a day (scripts/overnight_read.py morning).
  mountMorningRead(api, { db, notify: cycleOpts.enabled ? (text, id) => desk.tell(text, id) : undefined });
  // the "I'm on my laptop" switch (laptop.ts): Mac tasks first in the inbox while on, one Team desk line each way,
  // and the runs held on egress:laptop woken when it goes on.
  hostsArea?.mountLaptop(api, {
    db,
    notify: cycleOpts.enabled ? (text, id) => desk.tell(text, id) : undefined,
    release: (egress) => releaseHeld(store, egress).woken.length,
    // each task's step on its Mac ticket page, so the inbox card and the page show and write one state
    stepOf: (t, step) => {
      const p = (t.page ? stepsApi.byId(t.page) : undefined) ?? (t.url ? stepsApi.byUrl(t.url) : undefined);
      return p ? stepsApi.stepView(p, step) : undefined;
    },
  });
  // customer voice feedback by link (voiceFeedback.ts): transcribed only, structured, filed in the world's repo.
  const feedback = createFeedback({
    db,
    transcribe,
    structure: textStructurer,
    budget: (w) => {
      const st = worldVoice(w).state();
      // a customer's feedback link follows the platform's switch, not the world's own voice switch (that is the owner's).
      return { monthUsd: st.monthUsd, monthCapUsd: st.limits.monthCapUsd, enabled: st.enabled || !!st.worldOff };
    },
    repoOf: (w) => (w === DEFAULT_TENANT ? resolveRepo(read.reposRoot, homeRepo())?.path : worldRepo(w)),
    writer: spine,
    tell: cycleOpts.enabled ? (w, text, id) => (w === DEFAULT_TENANT ? desk.tell(text, id) : worldDesks.send(w, text, undefined, id).then(() => true as const)) : undefined,
    pageBase: process.env.CONSOLE_TEAM_URL || teamLink(),
    ...(opts.voice?.now ? { now: opts.voice.now } : {}),
  });
  mountFeedback(api, feedback, {
    world: () => store.tenant ?? DEFAULT_TENANT,
    by: () => (currentAuth()?.identity?.kind === "token" ? "an agent" : ownerName()),
    repoOf: (w) => (w === DEFAULT_TENANT ? resolveRepo(read.reposRoot, homeRepo())?.path : worldRepo(w)),
    ...(process.env.CONSOLE_FEEDBACK_URL ? { linkBase: process.env.CONSOLE_FEEDBACK_URL } : {}),
  });
  // steps pages with a Done switch per step (steps/steps.ts): a tick writes the owning spine, tells the desk, wakes the owner.
  const stepsApi = createSteps({
      db,
      writer: spine,
      repoDir: (name) => resolveRepo(read.reposRoot, name)?.path,
      milestoneFor: spineMilestone,
      wake: cycleOpts.enabled
        ? async (id, note) => {
            const m = store.getMilestone(id);
            return m ? wakeDeliveryManager({ store, cycle, homeThread: (a) => cycle.getLink(a)?.threadId }, m, note) : undefined;
          }
        : undefined,
      // a wake is tried until a run starts; these read and mark its runs.
      runOf: (id) => store.getRun(id),
      noteRun: (id, text) => {
        const r = store.getRun(id);
        if (r && !r.summary.includes(text)) store.updateRun(id, { summary: `${r.summary} ${text}` });
      },
      findRun: (mid, since, note) => store.listRuns({ milestoneId: mid, since, limit: 50 }).find((r) => r.instructions === note)?.id,
      tell: cycleOpts.enabled ? (w, text, id) => (w === DEFAULT_TENANT ? desk.tell(text, id) : worldDesks.send(w, text, undefined, id).then(() => true as const)) : undefined,
      invalidate: (dir) => dropSpines(dir),
      // a step's private box stores through the ask card's own key path, and refuses a name already set.
      pasteKey: inbox.pasteKey,
      ...(secretsArea ? { addKey: secretsArea.addKey } : {}), // (hosted/secrets.ts)
      hasKey: (world, app, name) => (world === DEFAULT_TENANT ? keyInIndex(app, name) : !!secretsArea?.hasWorldKey(world, app, name)),
      // the copy-paste gate reads the page over the tailnet (5 s; not reachable = not checked yet)
      fetchPage: async (url) => {
        const r = await fetch(url, { signal: AbortSignal.timeout(5_000), redirect: "follow" }).catch(() => undefined);
        return r?.ok ? (await r.text()).slice(0, 2_000_000) : undefined;
      },
    });
  // a note's screenshots are kept like Chat's attachments, in the page's world
  // every link the console hands out to a steps page (or a page beside it on its host) opens its secure copy
  setSecurePages(() => stepsApi.lite().filter((p) => (p.world || DEFAULT_TENANT) === DEFAULT_TENANT));
  mountSteps(api, stepsApi, { add: (b, t, n, w) => attachments.add(b, t, n, w), line: (ids, w) => attachments.cardText("", ids, w) });
  // a Mac agent asks the Team desk by its ticket page's token, the Delivery manager answers, the agent polls
  deskQs = createDeskQuestions({
    db,
    byToken: (t) => stepsApi.byToken(t),
    milestoneFor: spineMilestone,
    wake: cycleOpts.enabled
      ? async (id, note) => {
          const m = store.getMilestone(id);
          return m ? wakeDeliveryManager({ store, cycle, homeThread: (a) => cycle.getLink(a)?.threadId }, m, note) : undefined;
        }
      : undefined,
    tell: cycleOpts.enabled ? (w, text, id) => (w === DEFAULT_TENANT ? desk.tell(text, id) : worldDesks.send(w, text, undefined, id).then(() => true as const)) : undefined,
    base: cycle.publicUrl.replace(/\/+$/, ""),
  });
  mountDeskQuestions(api, deskQs);
  // the voice button of every step's note box (steps-kit.js opens this page on the console's https origin): the page
  // token is the credential; the note is transcribed like a card answer (fill: the memory service once, the spill to the desk) and the
  // page files the words as the step's note through the same ticks route.
  const stepPage = (c: Context) => stepsApi.byToken(c.req.param("token") ?? "");
  mountVoiceNotesRec(
    api,
    "/public/steps/:token/voice",
    (c) => {
      const p = stepPage(c);
      if (!p) return c.json({ error: { code: "not_found", message: "no steps page has this token" } }, 404);
      return p.world === DEFAULT_TENANT
        ? notesFor(voice, { send: (t, page, crid) => desk.send(t, page, crid).then((r) => (deskSaid(DEFAULT_TENANT, t, crid, r.pending), r)) }, "team-desk")
        : notesFor(worldVoice(p.world), { send: (t, page, crid) => worldDesks.send(p.world, t, page, crid).then((r) => (deskSaid(p.world, t, crid, r.pending), r)) }, "team-desk");
    },
    { audioBase: "/api/voice/notes" },
  );
  // the kit's in-place recorder keeps each note in the browser until the console has it (the same keep as the voice pages)
  api.get("/public/steps-keep.js", (c) => {
    c.header("Access-Control-Allow-Origin", "*");
    c.header("Cache-Control", "public, max-age=300");
    return c.body(KEEP_JS, 200, { "content-type": "text/javascript; charset=utf-8" });
  });
  api.get("/public/steps/:token/voice", (c) => {
    const p = stepPage(c);
    const step = (c.req.query("step") ?? "").trim();
    const ok = p && /^[\w.-]{1,40}$/.test(step);
    c.header("Cache-Control", "no-store");
    return c.html(stepVoicePage({ ...(ok ? { page: { title: p.title } } : {}), step, stepTitle: (c.req.query("title") ?? "").replace(/\s+/g, " ").trim().slice(0, 120) }), ok ? 200 : 404);
  });
  if (process.env.CONSOLE_STAGING !== "1") setInterval(() => void feedback.tick().catch(() => undefined), 5 * 60_000).unref();
  // one action on the Testers page turns a signup into a working world (world, credits, campaign, login, first draft).
  const testerWorlds = tenancy?.mountTesterWorlds({
    api,
    db,
    reposRoot: read.reposRoot,
    campaigns,
    socialUrl: process.env.CONSOLE_SOCIAL_URL || (process.env.CONSOLE_STAGING === "1" ? cycle.publicUrl : siteConfig().socialUrl),
    // the platform's own starter notes into a customer's workspace (first draft, own server ready) are signed by the console, never by the owner
    wake: cycleOpts.enabled ? async (id, note) => (await cycle.runNowRequest(id, { instructions: note, instructionsBy: "the console (sign-up)" })).run : undefined,
    browser: browserArea?.forWorlds, // the tester worlds' own instances and keys (hosted/browser.ts)
    consoleUrl: process.env.CONSOLE_PUBLIC_URL || cycle.publicUrl,
    wakeHold: worldHold,
    notify: cycleOpts.enabled ? (text) => void desk.tell(text, `signup-${Date.now()}`).catch(() => undefined) : undefined,
  });
  // Google and GitHub sign-up and sign-in on the customer sites (cloud.epicteam.app, app.social.app).
  billingOf = testerWorlds?.billingOf;
  mountOAuth(api, {
    db,
    auth,
    signup: testerWorlds?.makeSignupWorld ?? (async () => { throw new Error("this console has one team: sign-ups make no new world"); }),
    // the YouTube Allow stores its three keys the Secrets page way (store only, replacing an older Allow's)
    ...(secretsArea
      ? {
          storeKey: async (name: string, value: string, note: string) => {
            const r = await secretsArea.addKey({ app: "agent-team-console", name, value, note, replace: true });
            return r.ok ? { ok: true as const } : { ok: false as const, message: `${r.code}: ${r.message}` };
          },
        }
      : {}),
  });
  // the hosted layer's plugs (billing: tester link, team plan; plug/hosted.ts). One-team console
  // (CONSOLE_ONE_TEAM=1) mounts none. Way back: the two mountStripe* calls inline here, as in hosted/billing.ts.
  plugsMounted = mountPlugs(hostedPlugs, {
    api,
    db,
    publicUrl: process.env.CONSOLE_PUBLIC_URL || cycle.publicUrl,
    hasTenant: (id) => !!store.getTenant(id),
    makeWorld: testerWorlds?.makeWorld,
    setUpTeam: testerWorlds?.setUpTeamWorld,
    notify: cycleOpts.enabled ? (text, id) => desk.tell(text, id) : undefined,
  });
  // templates for the New persona picker; a customer workspace reads them with its owner's name (tenancy/workspaceText.ts)
  api.get("/persona-templates", (c) => {
    const owner = workspaceOwner(db, store.tenant);
    return c.json(listTemplates().map((t) => templateForWorkspace(t, owner)));
  });
  api.get("/personas/:id", (c) => c.json(found(store.getPersona(c.req.param("id")), "persona", c.req.param("id"))));
  // the persona's file in the team repo first (recordFirst), then console.db.
  api.post("/personas", async (c) => {
    const input = await body(c, s.personaCreate);
    return c.json(await recordFirst(() => recordedPersonas().createPersona(input)), 201);
  });
  const patchPersona = async (c: Context) => {
    const id = c.req.param("id")!;
    const p = await body(c, s.personaPatch);
    // exactly one persona of a world holds whatsapp-notify: ticking it here takes it off the others first.
    const notifySkill = services?.notifySkill;
    if (notifySkill && p.skills?.includes(notifySkill) && !store.getPersona(id)?.skills.includes(notifySkill))
      for (const o of store.listPersonas()) if (o.id !== id && o.skills.includes(notifySkill)) await recordFirst(() => recordedPersonas().updatePersona(o.id, { skills: o.skills.filter((x) => x !== notifySkill) }));
    return c.json(found(await recordFirst(() => recordedPersonas().updatePersona(id, p)), "persona", id));
  };
  api.patch("/personas/:id", patchPersona);
  api.put("/personas/:id", patchPersona);
  api.delete("/personas/:id", async (c) => {
    const id = c.req.param("id");
    found(store.getPersona(id), "persona", id);
    await recordFirst(() => recordedPersonas().deletePersona(id));
    return c.body(null, 204);
  });

  // Assignments
  api.get("/assignments", (c) =>
    c.json(
      store.listAssignments({ milestoneId: c.req.query("milestoneId"), personaId: c.req.query("personaId") }),
    ),
  );
  api.get("/assignments/:id", (c) =>
    c.json(found(store.getAssignment(c.req.param("id")), "assignment", c.req.param("id"))),
  );
  // what the next cadence wake would see (fingerprint parts) and whether it would skip; read-only.
  api.get("/assignments/:id/wake-check", async (c) => c.json(found(await cycle.wakeCheck(c.req.param("id")), "assignment", c.req.param("id"))));
  // no cadence given → the persona's default (the Unblocker's 6 h backstop, otherwise 2 h).
  api.post("/assignments", async (c) => {
    const fill = (raw: unknown) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || (raw as { cadence?: unknown }).cadence !== undefined) return raw;
      const personaId = (raw as { personaId?: unknown }).personaId;
      return { ...raw, cadence: defaultCadenceFor(typeof personaId === "string" ? store.getPersona(personaId)?.name : undefined) };
    };
    const input = await body(c, s.assignmentCreate, fill);
    return c.json(await recordFirst(() => recordedAssignments().createAssignment(input)), 201); // the team repo first
  });
  const patchAssignment = async (c: Context) => {
    const id = c.req.param("id")!;
    const p = await body(c, s.assignmentPatch);
    // A manual toggle (either way) ends an auto-park: a hand-disabled assignment is never re-armed.
    const unpark = p.enabled === undefined ? {} : { parkedAt: null, parkedReason: null };
    const before = store.getAssignment(id);
    const who = currentAuth()?.identity;
    // a world's persona token switches its own world's assignments only with write there (rule 3 holds the world).
    const refused = before && p.enabled !== undefined && p.enabled !== before.enabled ? worldToggleRefusal(db, who, id) : undefined;
    if (refused) return c.json({ error: "toggle_refused", message: refused }, 403);
    const after = found(await recordFirst(() => recordedAssignments().updateAssignment(id, { ...p, ...unpark })), "assignment", id);
    if (before) logToggle(db, before, after, toggleActorFor(db, c.req.header("x-console-actor"), who));
    return c.json(store.getAssignment(id) ?? after);
  };
  api.patch("/assignments/:id", patchAssignment);
  api.put("/assignments/:id", patchAssignment);
  api.delete("/assignments/:id", async (c) => {
    const id = c.req.param("id");
    found(store.getAssignment(id), "assignment", id);
    await recordFirst(() => recordedAssignments().deleteAssignment(id)); // the team repo first
    return c.body(null, 204);
  });
  // POST /assignments/:id/run-now and /wake live in cycle/routes.ts.

  // Runs
  /**
   * does this run's `blocked` cite an open ask (spine ask code), or did the run raise an ask through the API that is
   * still open in the spine (the raise log names its code; open or not is the spine's)? Fails open if the spines
   * cannot be read.
   */
  const blockedHasAsk = async (run: { id: string; assignmentId: string; milestoneId?: string }, summary: string) => {
    const milestoneId = run.milestoneId ?? store.getAssignment(run.assignmentId)?.milestoneId;
    if (!milestoneId) return true;
    const raised = store
      .listNeedsJordi({ milestoneId })
      .filter((n) => n.runId === run.id && n.supersededBy && n.supersededBy !== "moot")
      .map((n) => n.supersededBy!.split("/").pop()!.toUpperCase());
    const cited = [...new Set([...citedAskCodes(summary), ...raised])];
    if (!cited.length) return false;
    try {
      const items = await waitingOnJordi(inboxDeps, { milestoneId });
      return items.some((i) => i.source === "ask" && i.state === "open" && i.code && cited.includes(i.code.toUpperCase()));
    } catch {
      return true;
    }
  };
  /** a running run carries `t3`, the last thread state the reconciler read (no extra T3 read per request). */
  const withT3 = <R extends { id: string; outcome: string }>(r: R) => {
    const t3 = r.outcome === "running" ? cycle.runT3State(r.id) : undefined;
    const u = r.outcome === "running" ? undefined : usageOf(r.id);
    const live = r.outcome === "running" ? liveUsageOf(r.id) : undefined; // tokens so far
    const steers = cycle.steersOf(r.id);
    return { ...r, ...(t3 ? { t3 } : {}), ...(u ? { usage: u } : {}), ...(live ? { usageLive: live } : {}), ...(steers ? { steers } : {}) };
  };
  const runsQuery = (c: Context) => {
    const limitQ = c.req.query("limit");
    const limit = limitQ === undefined ? undefined : Number(limitQ);
    if (limit !== undefined && !(Number.isInteger(limit) && limit > 0 && limit <= 5000))
      throw new ApiError(400, "validation_error", "limit must be an integer between 1 and 5000");
    // `since` = runs started at or after it, every one (no 500-row cap unless `limit` is given).
    const sinceQ = c.req.query("since");
    if (sinceQ !== undefined && Number.isNaN(Date.parse(sinceQ))) throw new ApiError(400, "validation_error", "since must be an ISO date-time");
    return {
      milestoneId: c.req.query("milestoneId"),
      assignmentId: c.req.query("assignmentId"),
      parentRunId: c.req.query("parentRunId"),
      since: sinceQ === undefined ? undefined : new Date(sinceQ).toISOString(),
      limit,
    };
  };
  api.get("/runs", (c) => {
    // `?top=20|50|all` (optionally with milestoneId): the newest wakes with their child runs and the wake
    // count, `{ runs, total }`, so the Runs page's Show 20 / 50 / all loads only what it shows. Without it, as before.
    const topQ = c.req.query("top");
    if (topQ !== undefined) {
      const top = movingLimit(topQ);
      const r = store.listRunsTop({ top, milestoneId: c.req.query("milestoneId") });
      return c.json({ runs: r.runs.map(withT3), total: r.total });
    }
    return c.json(store.listRuns(runsQuery(c)).map(withT3));
  });
  // the Team home's wake counts (per milestone card, per persona) from the same newest 500 runs `GET /api/runs`
  // sends, and its footer's "n of m wakes in 24 h did something" from every run of the last 24 h (`?since=`), without
  // sending either list (~935 KB + ~685 KB → a few KB): only the numbers and each latest wake.
  api.get("/runs/stats", (c) => {
    const now = new Date();
    const s = runStats(store.listRuns(), store.listAssignments(), now);
    const last = <T extends { last?: Run }>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.last ? { ...v, last: withT3(v.last) } : v]));
    // `?milestones=a,b` (the social skin's selected project) counts the footer over those milestones' runs only.
    const only = c.req.query("milestones")?.split(",").filter(Boolean);
    const day = store.listRuns({ since: new Date(now.getTime() - 86_400_000).toISOString() });
    const wakes24h = wakesDidSomething(runsOfMilestones(day, store.listAssignments(), only), now);
    return c.json({ milestones: last(s.milestones), personas: last(s.personas), wakes24h });
  });
  // the Runs page's Active agents chart for one day in the viewer's timezone (`?day=YYYY-MM-DD&tz=Area/City`,
  // default today in UTC; `bucket=1|5|10|15` minutes, default 1): one number per bucket and the peak, never the runs.
  // World-scoped like /runs: the social skin charts its own world's runs only.
  api.get("/runs/active", (c) => {
    const tz = c.req.query("tz") || "UTC";
    if (!validTimeZone(tz)) throw new ApiError(400, "validation_error", `unknown timezone ${tz}`);
    const now = new Date();
    const day = c.req.query("day") || localDay(now, tz);
    const bucket = Number(c.req.query("bucket") ?? 1);
    if (!(BUCKETS as readonly number[]).includes(bucket)) throw new ApiError(400, "validation_error", `bucket must be one of ${BUCKETS.join(", ")}`);
    let bounds: { start: number; end: number };
    try {
      bounds = dayBounds(day, tz);
    } catch (e) {
      throw new ApiError(400, "validation_error", (e as Error).message);
    }
    const runs = store.listRunsActiveBetween(new Date(bounds.start).toISOString(), new Date(bounds.end).toISOString());
    return c.json(activeSeries(runs, { day, tz, now, bucketMinutes: bucket }));
  });
  hostsArea?.mountRunHosts(api, store); // GET /runs/hosts: live runs by host (hosted/hosts.ts)
  // one world's own lists by path, scoped to the path's world in every auth mode (a store for that tenant, not
  // the request's): what a world's personas, DM and checks read with its token (the shadow logged /tenants/a social world repo/
  // assignments|runs, 2026-10-31T22:53Z). Rule 3 404s a caller of another world; an unknown world is a 404.
  const worldStore = (c: Context) => {
    const id = c.req.param("id")!;
    if (!store.getTenant(id)) throw new ApiError(404, "not_found", `tenant ${id} not found`);
    return createStore(db, { tenant: id });
  };
  api.get("/tenants/:id/milestones", (c) => c.json(worldStore(c).listMilestones({ includeSettled: includeSettled(c) })));
  api.get("/tenants/:id/personas", (c) => c.json(worldStore(c).listPersonas()));
  api.get("/tenants/:id/assignments", (c) =>
    c.json(worldStore(c).listAssignments({ milestoneId: c.req.query("milestoneId"), personaId: c.req.query("personaId") })),
  );
  api.get("/tenants/:id/runs", (c) => c.json(worldStore(c).listRuns(runsQuery(c)).map(withT3)));
  // the platform's lookup of which world owns the id an API path names (rule 3's own query), so check-curl.sh sends
  // that world's token or refuses the call. the home world-only (not TENANT_SAFE): another world never learns of ids not its own.
  api.get("/owner", (c) => {
    const p = c.req.query("path");
    if (!p || !p.startsWith("/api/")) throw new ApiError(400, "validation_error", "path must be an /api/ path");
    return c.json({ path: p, owner: ownerOfPath(db, p.split("?")[0]) ?? null });
  });
  api.get("/runs/:id", (c) => c.json(withT3(found(store.getRun(c.req.param("id")), "run", c.req.param("id")))));
  /**
   * `blocked` means the owner must act, so it needs an open ask code in the summary (or an open
   * Needs the owner item of the run). A `blocked` citing none (or only answered codes) is a wait on a time or condition: it is
   * stored as `monitoring`, next check = its retryAt, and the reported word kept in `reportedOutcome`.
   */
  const asMonitoring = <P extends { outcome?: string; retryAt?: string | null; nextCheckAt?: string | null }>(p: P, retryAt?: string | null) => ({
    ...p,
    outcome: "monitoring" as const,
    reportedOutcome: "blocked",
    nextCheckAt: p.nextCheckAt ?? p.retryAt ?? retryAt ?? null,
  });
  /**
   * a report that ends in `monitoring` with a date ahead puts it in the spine: the milestone's
   * Current State `Monitoring:` line (written through the spine writer unless a current one is there). Status reads
   * monitoring from that line only. A line that cannot be written refuses the report (409), and nothing is recorded.
   */
  const monitoringInSpine = async (
    milestoneId: string | undefined,
    after: { outcome?: string; summary?: string; nextCheckAt?: string | null; retryAt?: string | null; until?: string | null; heldOn?: string | null },
    runId?: string,
  ) => {
    if (after.outcome !== "monitoring" || !milestoneId) return;
    const what = after.heldOn ? heldWhat(after.heldOn) : monitorWhat(after.summary);
    const report = datedReport({ what, nextCheckAt: after.nextCheckAt ?? after.retryAt ?? undefined, until: after.until ?? undefined });
    const at = report && spineOfMilestone(milestoneId);
    if (!report || !at) return; // no date ahead (status shows no monitoring either), or no spine on this host
    const w = await writeMonitoring({ writer: spine, dir: at.dir, path: at.path, runId }, report);
    if (w.status === "written") {
      if (w.sha) dropSpines(at.dir);
      return;
    }
    throw new ApiError(
      409,
      "monitoring_not_in_spine",
      `the report says monitoring, but ${at.path} has no current \`Monitoring:\` line and the console could not write it (${w.reason ?? w.status}). ` +
        `Write \`Monitoring: ${monitorValue(report)}\` in its Current State, commit and push per the repo's Integration policy, then resend this report (root L-45).`,
      { path: at.path },
    );
  };
  // a client that timed out and retries with the same clientRequestId gets the first run (200), never a second one.
  api.post("/runs", async (c) => {
    const p = await body(c, s.runCreate);
    const foreign = threadRefusal(db, worldOfAssignment(db, p.assignmentId) ?? DEFAULT_TENANT, p.threadId); // (audit N3)
    if (foreign) throw new ApiError(403, "foreign_thread", foreign);
    const replay = () => (p.clientRequestId ? store.getRunByClientRequest(p.assignmentId, p.clientRequestId) : undefined);
    const seen = replay();
    if (seen) return c.json(withT3(seen), 200);
    // a second worker for a row that already has a live session (a running child run, or a live claim in its row) is
    // refused before it starts, whoever dispatches it (a row was once dispatched twice by two Delivery Managers 2 minutes apart).
    // Priority mode's own rows are the exception: it puts every hand on them on purpose.
    const taken = rowClaimRefusal(store, { ...p, claimIn: rowClaimOf });
    const allHands = !!taken && !!priority?.active()?.rows.includes(taken.row);
    if (taken && !allHands) throw new ApiError(409, taken.code, taken.message, { row: taken.row, holder: taken.holder });
    // while priority mode is on, a worker for any row it does not name is refused (the dispatch records it first).
    const held = priority?.refusesChild(p);
    if (held) throw new ApiError(409, PRIORITY_CODE, held);
    const milestoneId = store.getAssignment(p.assignmentId)?.milestoneId;
    const blockedOk = p.outcome !== "blocked" || (await blockedHasAsk({ id: "", assignmentId: p.assignmentId, milestoneId }, p.summary));
    const created = blockedOk ? p : asMonitoring(p);
    await monitoringInSpine(milestoneId, created);
    const raced = replay(); // a repeat that arrived during the await above (no await between this check and the insert)
    if (raced) return c.json(withT3(raced), 200);
    return c.json(store.createRun(created), 201);
  });
  api.patch("/runs/:id", async (c) => {
    const id = c.req.param("id");
    // `review: {url, title?, ref?, commit?}` from older briefs is only a hint now (the card is the spine row).
    const { review: liveResult, outcomes: reportedOutcomes, ...reported } = await body(c, s.runPatch.extend({ review: runReview.optional(), outcomes: outcomesIn.optional() }));
    const run = store.getRun(id);
    const foreign = run && threadRefusal(db, worldOfRun(db, id), reported.threadId); // (audit N3)
    if (foreign) throw new ApiError(403, "foreign_thread", foreign);
    if (run) cycle.touchRun(id); // the worker is alive, whatever the reconciler can read of its thread
    // a report (outcome or summary) for a wake that is no longer running, while a newer wake of the same assignment
    // runs, belongs to that newer wake: refused, so one turn's report is never written onto two wakes (run_5064482d + run_b5d76a14).
    // An asking run is exempt (blocked, or a Needs the owner item names it): the owner's answer may finish it (consumed).
    // "names it" = the run raised an ask through the API (the raise log, ops; the ask itself is in the spine).
    const asking = (r: Run) => r.outcome === "blocked" || !!db.prepare("SELECT 1 FROM needs_jordi WHERE run_id = ? LIMIT 1").get(r.id);
    if (run && run.kind === "wake" && !run.parentRunId && run.outcome !== "running" && (reported.outcome !== undefined || reported.summary !== undefined)) {
      const newer = store
        .listRuns({ assignmentId: run.assignmentId, limit: 50 })
        .find((r) => r.id !== run.id && r.kind === "wake" && !r.parentRunId && r.outcome === "running" && r.startedAt > run.startedAt);
      // a note this wake took (queued into it, or given as its instructions) may finish after it ended: its report is
      // kept on the wake the note names, appended, never refused (every such report was once refused as superseded_wake, so the
      // same note came back up to 3 times). The wake's own outcome and end time stay as they were.
      const tookNote = (r: Run) => (r.startGuards ?? []).some((g) => g.action === "queued") || (cycle?.steersOf(r.id)?.length ?? 0) > 0;
      if (newer && !asking(run) && tookNote(run) && run.endedAt) {
        const late = (reported.summary ?? `outcome: ${reported.outcome}`).trim();
        const updated = found(
          store.updateRun(id, { summary: `${run.summary.trim()}\nlate note report (after this wake ended; wake ${newer.id} runs now): ${late}`.slice(0, 8_000) }),
          "run",
          id,
        );
        if (reportedOutcomes?.length) {
          const logged = await outcomes.record(updated, reportedOutcomes).then((r) => (outcomes.clear(), r)).catch((e) => ({ error: (e as Error).message }));
          return c.json({ ...updated, lateNoteReport: true, outcomesLogged: logged });
        }
        return c.json({ ...updated, lateNoteReport: true });
      }
      if (newer && !asking(run))
        throw new ApiError(409, "superseded_wake", `run ${id} ended (${run.outcome}); wake ${newer.id} of this assignment is running now: PATCH that run with this report, not ${id}`, {
          runId: newer.id,
        });
    }
    const p =
      run && reported.outcome === "blocked" && !(await blockedHasAsk(run, reported.summary ?? run.summary)) ? asMonitoring(reported, run.retryAt) : reported;
    const milestoneId = run?.milestoneId ?? (run ? store.getAssignment(run.assignmentId)?.milestoneId : undefined);
    // ready rows are for a persona that dispatches; a standing-duty (pack-role) persona's wake neither books a
    // follow-up for them nor is flagged for leaving them (a social world repo's Writer got a follow-up for a recruit-testers row).
    const runPersona = run && store.getPersona(run.personaId ?? store.getAssignment(run.assignmentId)?.personaId ?? "");
    const dispatches = !runPersona || !hasStandingDuty(runPersona);
    const ready = async () => {
      if (!dispatches) return [];
      const m = milestoneId ? store.getMilestone(milestoneId) : undefined;
      if (!m?.path) return undefined;
      const { rel, spines } = await spinesFor(m, 1_500);
      if (spines && rel && runStateFor(spines, rel)?.runnable === false) return []; // not runnable: idle is the honest word
      return readySteps(await treeFor(m, 1_500, spines));
    };
    // monitoring needs a date; idle only when no step is ready; a non-ending word is failed.
    const ending = await wakeEnding(p, run, ready);
    if ("error" in ending) throw new ApiError(400, "validation_error", ending.error);
    // a wake ending progressed with steps still ready books one follow-up wake (enabled, 1 per hour, depth 1).
    if (run?.outcome === "running" && ending.patch.outcome === "progressed" && run.kind === "wake" && !run.parentRunId) {
      const f = followUp({
        run,
        outcome: ending.patch.outcome,
        assignment: store.getAssignment(run.assignmentId),
        milestone: milestoneId ? store.getMilestone(milestoneId) : undefined,
        runs: store.listRuns({ assignmentId: run.assignmentId, limit: 50 }),
        ready: (await ready().catch(() => undefined)) ?? [],
        now: Date.now(),
      });
      if (f.note) ending.patch = { ...ending.patch, summary: `${ending.patch.summary ?? run.summary} ${f.note}`.trim(), ...(f.book ? { retryAt: f.at } : {}) };
    }
    // an Unblocker's finishing PATCH reports every ask that was open when its wake prompt was built.
    const finishing = (p.outcome !== undefined && p.outcome !== "running") || !!p.endedAt;
    // only the asks new or changed at wake time must be reported; carried ones get their remembered `left`.
    const unblockerFinish = !!run?.openAsks && finishing && (p.outcome ?? run!.outcome) !== "failed" && isUnblocker(store.getPersona(run!.personaId ?? "")?.name);
    if (unblockerFinish) {
      const assessed = run!.openAsks!.filter((a) => !a.carriedFrom);
      const own = p.checks !== undefined ? p.checks : run!.checks;
      const problem = unblockerChecksProblem(assessed, own);
      if (problem) throw new ApiError(400, "checks_incomplete", problem, { openAsks: assessed.map((a) => a.code) });
      // each assessed ask carries its rubric scores; an answer stands only when it clears the rubric (outside the hard floor).
      const rubric = rubricOfRun(db, run!.id, milestoneId);
      const broken = rubricProblem(assessed, own, rubric);
      if (broken) throw new ApiError(400, "rubric", broken, { threshold: rubric.threshold, minFactor: rubric.minFactor, weights: rubric.weights });
      const stamped = stampRubric(own ?? [], rubric);
      ending.patch = {
        ...ending.patch,
        ...(own ? { checks: stamped } : {}),
        ...(run!.openAsks!.some((a) => a.carriedFrom) ? { checks: withCarriedChecks(run!.openAsks!, stamped, milestoneId ? readAskMemory(db, milestoneId) : []) } : {}),
      };
    }
    const noteAckPatch: { noteAck?: string } = {};
    // a run that carried a note must say what it did about it (`note: done|not done: <why>`) before it finishes.
    if (run?.instructions && finishing && !run.endedAt && (p.outcome ?? run.outcome) !== "failed") {
      const ack = noteAck(p.summary ?? run.summary);
      if (!ack)
        throw new ApiError(400, "note_unacknowledged", `this run carried ${run.instructionsBy ?? ownerName()}'s note: ${NOTE_ACK_RULE} The note: ${run.instructions}`);
      noteAckPatch.noteAck = ack;
    }
    // ready work always starts: a Delivery manager wake leaving ready rows with no worker and no written reason is
    // refused once (the rows listed back into the same wake); a second such finish is kept, flagged and the next wake booked now.
    let unstarted: string[] = [];
    const endWord = p.outcome ?? run?.outcome;
    if (run && finishing && !run.endedAt && run.kind === "wake" && !run.parentRunId && endWord !== "failed" && endWord !== "stopped" && endWord !== "running") {
      const persona = store.getPersona(run.personaId ?? store.getAssignment(run.assignmentId)?.personaId ?? "")?.name;
      if (isDeliveryManager(persona)) {
        const m = milestoneId ? store.getMilestone(milestoneId) : undefined;
        const claimed = new Set(m ? claimsFor(store, m).map((x) => x.ticket) : []);
        const steps = ((await ready().catch(() => undefined)) ?? []).filter((x) => !claimed.has(x));
        const launchedRows = store.listRuns({ parentRunId: id, limit: 100 }).flatMap((r) => [r.summary.trim().split(/\s+/)[0]?.replace(/[:,.;]+$/, "") ?? "", rowOf(r.summary) ?? ""]).filter(Boolean);
        unstarted = unaccountedReady({ ready: steps, launchedRows, summary: p.summary ?? run.summary }); // the wake's own words, never a console note
        if (unstarted.length && !readyRefused.has(id)) {
          readyRefused.add(id);
          throw new ApiError(400, "ready_unstarted", readyUnstartedText(unstarted), { rows: unstarted });
        }
        if (unstarted.length)
          ending.patch = {
            ...ending.patch,
            retryAt: new Date().toISOString(),
            summary: `${ending.patch.summary ?? run.summary} [console: ${READY_REBOOK_MARK}: ${unstarted.join(", ")}; next wake booked now to start them or write their reasons]`.trim(),
          };
      }
    }
    // NO_SELF_READY: a finished run whose commits turned a spine or row from draft to ready is flagged (background).
    if (run && finishing && milestoneId) {
      const m = store.getMilestone(milestoneId);
      if (m?.path)
        void spinesFor(m, 4_000)
          .then(async ({ loc }) => (loc ? selfReadied(loc.repo.path, run.id, run.startedAt) : []))
          .then((lines) => lines.length && store.updateRun(id, { selfReadied: lines }))
          .catch(() => undefined);
    }
    // in a pack repo, each commit of the run is validated as the persona's pack role; a failure marks it rule broken (never a revert).
    if (run && finishing && !run.endedAt && read.skillDir) {
      const m = milestoneId ? store.getMilestone(milestoneId) : undefined;
      const dir = m ? (locateDir(m) ?? resolveRepo(read.reposRoot, m.repo)?.path) : undefined;
      const persona = store.getPersona(run.personaId ?? store.getAssignment(run.assignmentId)?.personaId ?? "");
      if (dir && persona)
        void (opts.packCheck ?? socialArea?.packCheck)?.({ skillDir: read.skillDir, repoDir: dir, runId: run.id, since: run.startedAt, persona })
          .then((rb) => rb && store.updateRun(id, { ruleBroken: rb }))
          .catch(() => undefined);
    }
    // a wake ending with the same report as the wakes before it is marked repeating (n in a row, since when).
    const repeatPatch: { repeating?: number | null; repeatSince?: string | null } = {};
    if (run && finishing && run.kind === "wake" && !run.parentRunId) {
      const ended = { ...run, ...ending.patch, outcome: ending.patch.outcome ?? run.outcome, summary: ending.patch.summary ?? run.summary } as Run;
      const streak = repeatStreak(ended, store.listRuns({ assignmentId: run.assignmentId, limit: 50 }));
      repeatPatch.repeating = streak?.n ?? null;
      repeatPatch.repeatSince = streak?.since ?? null;
    }
    // a Delivery manager wake that launched nothing while unclaimed rows read ready names its one blocker, else it is flagged stalled.
    const stalledPatch: { stalled?: string | null } = {};
    if (run && finishing && !run.endedAt && run.kind === "wake" && !run.parentRunId) {
      const persona = store.getPersona(run.personaId ?? store.getAssignment(run.assignmentId)?.personaId ?? "")?.name;
      if (isDeliveryManager(persona)) {
        const m = milestoneId ? store.getMilestone(milestoneId) : undefined;
        const claimed = new Set(m ? claimsFor(store, m).map((x) => x.ticket) : []);
        const steps = ((await ready().catch(() => undefined)) ?? []).filter((x) => !claimed.has(x));
        const summary = ending.patch.summary ?? run.summary;
        const why = stalledWake({
          persona,
          outcome: ending.patch.outcome ?? run.outcome,
          summary,
          // a ready row with a written reason (`not started <row>: …`) is accounted for, not stalled
          ready: unaccountedReady({ ready: steps, launchedRows: [], summary }),
          launched: store.listRuns({ parentRunId: id, limit: 50 }).length,
        });
        stalledPatch.stalled =
          (unstarted.length ? `left ${unstarted.length} ready row${unstarted.length === 1 ? "" : "s"} with no worker or reason after a refusal: ${unstarted.slice(0, 5).join(", ")}${unstarted.length > 5 ? ", …" : ""}` : why) ?? null;
      }
    }
    if (run && ending.patch.outcome === "monitoring")
      await monitoringInSpine(
        milestoneId,
        {
          outcome: "monitoring",
          summary: ending.patch.summary ?? run.summary,
          nextCheckAt: ending.patch.nextCheckAt !== undefined ? ending.patch.nextCheckAt : run.nextCheckAt,
          retryAt: ending.patch.retryAt !== undefined ? ending.patch.retryAt : run.retryAt,
          until: ending.patch.until !== undefined ? ending.patch.until : run.until,
          heldOn: ending.patch.heldOn !== undefined ? ending.patch.heldOn : run.heldOn,
        },
        id,
      );
    const updated = found(store.updateRun(id, { ...ending.patch, ...noteAckPatch, ...repeatPatch, ...stalledPatch }), "run", id);
    if (unblockerFinish && milestoneId) rememberChecks(db, updated, milestoneId); // the per-ask memory
    // a report naming a live result is a hint that its row changed: the spines are re-read; nothing is stored.
    if (liveResult) review.hint(updated.milestoneId ?? milestoneId);
    // the outcome log: the run's outcomes go into its repo's day file; a write that fails never fails the report.
    if (reportedOutcomes?.length) {
      const logged = await outcomes
        .record(updated, reportedOutcomes)
        .then((r) => (outcomes.clear(), r))
        .catch((e) => ({ error: e instanceof OutcomeError ? `${e.code}: ${e.message}` : (e as Error).message }));
      return c.json({ ...updated, outcomesLogged: logged });
    }
    return c.json(updated);
  });

  // the Team Browser says an egress is back (offline → online); wake the personas held on it (switched-off ones stay off).
  api.post("/egress/:name/online", (c) => {
    const name = c.req.param("name");
    if (!/^[a-z0-9_-]{1,40}$/.test(name)) throw new ApiError(400, "validation_error", "egress name must be [a-z0-9_-]");
    return c.json(releaseHeld(store, name));
  });

  // Needs the owner (root L-45): an ask raised through the API is written into the asker's spine as a coded
  // `[ask <code>: …]` line (inbox/raise.ts, through the one spine writer); the inbox reads it from the spine like any other
  // ask. The needs_jordi table is only the log of what was raised (ops): the read path never reads it.
  const raiseDeps = (): RaiseDeps => ({ db, store, reposRoot: read.reposRoot, writer: spine, invalidate: dropSpines });
  // a persona whose last 3 wakes failed raises one inbox card in its milestone's spine; its next working wake takes it out.
  async function failedWakesCard(runId: string): Promise<void> {
    const run = store.getRun(runId);
    if (!run || run.kind !== "wake" || run.parentRunId) return;
    const a = store.getAssignment(run.assignmentId);
    const m = a && store.getMilestone(a.milestoneId);
    const p = a && store.getPersona(a.personaId);
    if (!m || !p || !m.path) return;
    const streak = wakeStreak(store.listRuns({ assignmentId: a.id, limit: 30 }));
    if (!streak) return;
    const question = failedWakesQuestion(p.name, m.title);
    if (streak.state === "failed") {
      const r = await raiseAsk(raiseDeps(), m, { question, proposedAction: failedWakesAction(streak.runs), askedBy: "the console's failed-wakes watch", runId, kind: "decide" });
      if (r.status === "written" && !r.reason) console.warn(`[ALERT] ${p.name} on ${m.title}: ${FAILED_WAKES_IN_A_ROW} failed wakes in a row, ask ${r.code}`);
      return;
    }
    const dir = resolveRepo(read.reposRoot, m.repo)?.path;
    const f = dir ? path.join(dir, m.path) : undefined;
    const code = f && fs.existsSync(f) ? openFailedWakesAsk(fs.readFileSync(f, "utf8"), question) : undefined;
    if (code) await retireAsk(raiseDeps(), m, m.path, code, `the ${p.name} woke again (run ${runId})`, true);
  }
  api.get("/needs-owner", (c) => {
    const status = c.req.query("status");
    if (status !== undefined && !s.needsJordiFilterStatus.safeParse(status).success)
      throw new ApiError(400, "validation_error", "status must be open, approved, denied or superseded");
    return c.json(store.listNeedsJordi({ status, milestoneId: c.req.query("milestoneId") }));
  });
  api.get("/needs-owner/:id", (c) =>
    c.json(found(store.getNeedsJordi(c.req.param("id")), "needs-owner item", c.req.param("id"))),
  );
  api.post("/needs-owner", async (c) => {
    const p = await body(c, s.needsJordiCreate);
    // an ask never hands the owner terminal lines to copy
    const copyPaste = copyPasteProblem(copyPasteInText(p.question));
    if (copyPaste) throw new ApiError(422, "copy_paste_steps", `the ask was not raised: ${copyPaste}`);
    // a decide ask whose card would show no option buttons is refused (the owner: "only ask feedback").
    const parsedAsk = parseAsks(`## Waiting on\n${askLine("X-A1", { question: p.question, proposedAction: p.proposedAction, askedBy: "a persona", ...(p.kind ? { kind: p.kind } : {}), ...(p.browser ? { browser: p.browser } : {}) }, "2000-01-01")}`)[0];
    const noButtons = parsedAsk ? decideButtonsProblem(parsedAsk) : undefined;
    if (noButtons) throw new ApiError(422, "decide_no_options", `the ask was not raised: ${noButtons}. Nothing was written and ${ownerName()} sees nothing.`);
    const m = found(store.getMilestone(p.milestoneId), "milestone", p.milestoneId);
    const run = p.runId ? found(store.getRun(p.runId), "run", p.runId) : undefined;
    const a = run ? store.getAssignment(run.assignmentId) : undefined;
    const persona = a ? store.getPersona(a.personaId)?.name : undefined;
    // an ask that does not name what of the owner's it answers, re-states his answer or carries a go-live
    // date he did not set is refused before anything is written; the reason goes back to the persona, never to him.
    const gate = askGateProblem(parseAsks(`## Waiting on\n${askLine("X-A1", { question: p.question, proposedAction: p.proposedAction, askedBy: "a persona", ...(p.kind ? { kind: p.kind } : {}), ...(p.browser ? { browser: p.browser } : {}) }, "2000-01-01")}`).map(({ since: _old, ...x }) => x)[0] ?? { ask: "unknown", question: p.question });
    if (gate) {
      console.log(`ask gate: refused an ask from ${persona ?? (run ? `run ${run.id}` : "an API caller")} on ${m.id}: ${gate.slice(0, 120)}`);
      throw new ApiError(422, "ask_not_his", `the ask was not raised: ${gate}. Nothing was written and ${ownerName()} sees nothing.`);
    }
    const r = await raiseAsk(
      raiseDeps(),
      m,
      { question: p.question, proposedAction: p.proposedAction, askedBy: persona ?? (run ? `run ${run.id}` : "an API caller"), ...(run ? { runId: run.id } : {}), ...(p.row ? { row: p.row } : {}), ...(p.kind ? { kind: p.kind } : {}), ...(p.about ? { about: p.about } : {}), ...(p.browser ? { browser: p.browser } : {}) },
      p.path,
    );
    if (r.status !== "written")
      throw new ApiError(409, "spine_write_refused", `the ask was not raised: the console could not write it into ${r.repo && r.path ? `${r.repo}/${r.path}` : "a spine"} (${r.reason}). Nothing was recorded. Write the coded ask line under \`## Waiting on\` of your spine yourself, or call again once that is fixed.`, { reason: r.reason, ...(r.repo ? { repo: r.repo } : {}), ...(r.path ? { path: r.path } : {}) });
    const log = store.logRaisedAsk({ runId: run?.id ?? null, milestoneId: m.id, question: p.question, proposedAction: p.proposedAction, by: `${r.repo}/${r.code}` });
    return c.json({ ...log, ask: { code: r.code, repo: r.repo, path: r.path, line: r.line, ...(r.sha ? { sha: r.sha } : {}), ...(r.reason ? { note: r.reason } : {}) } }, 201);
  });
  // the raiser takes its own ask out once it is moot (the Team Browser: the site reads signed in again). Only an
  // ask line the console wrote and still open; anything else answers 409 with the reason. the home world / host only.
  api.post("/needs-owner/retire", async (c) => {
    const p = await body(c, s.needsJordiRetire);
    const m = found(store.getMilestone(p.milestoneId), "milestone", p.milestoneId);
    const w = await retireAsk(raiseDeps(), m, p.path, p.code, p.why, true);
    if (w.status !== "written") throw new ApiError(409, "not_retired", `${p.code} was not taken out: ${w.reason ?? w.status}`);
    return c.json({ status: w.status, code: p.code, path: p.path, ...(w.sha ? { sha: w.sha } : {}) });
  });
  // carry-over (once per console): open Needs the owner rows go into their spines as coded asks, then the table is a log.
  // `{"dry":true}` says what it would write. the home world / host only (not TENANT_SAFE).
  api.post("/needs-owner/carry", async (c) => {
    const raw = (await c.req.text()).trim();
    let dry = false;
    try {
      dry = raw ? JSON.parse(raw)?.dry === true : false;
    } catch {
      throw new ApiError(400, "invalid_json", "send {} or {\"dry\":true}");
    }
    const lines = await carryNeedsJordi({ db, store, deps: inboxDeps, raise: raiseDeps() }, { dry });
    const counts = lines.reduce<Record<string, number>>((a, l) => ({ ...a, [l.action]: (a[l.action] ?? 0) + 1 }), {});
    console.log(`needs-owner carry${dry ? " (dry)" : ""}: ${JSON.stringify(counts)}`);
    return c.json({ dry, counts, lines });
  });
  // carry-over (once per console): each world's assignments and access into state/assignments.json and
  // state/access.json. `{"dry":true}` says what it would write. the home world / host only (not TENANT_SAFE).
  api.post("/e62s7/carry", async (c) => {
    const raw = (await c.req.text()).trim();
    let dry = false;
    try {
      dry = raw ? JSON.parse(raw)?.dry === true : false;
    } catch {
      throw new ApiError(400, "invalid_json", "send {} or {\"dry\":true}");
    }
    const lines = await assignmentRecord.carry({ dry });
    console.log(`e62s7 carry${dry ? " (dry)" : ""}: ${JSON.stringify(lines)}`);
    return c.json({ dry, lines });
  });
  // carry-over (once per console): each world's personas as files in its team repo (state/personas/), one commit
  // per world. `{"dry":true}` says what it would write. the home world / host only (not TENANT_SAFE).
  api.post("/e62s6/carry", async (c) => {
    const raw = (await c.req.text()).trim();
    let dry = false;
    try {
      dry = raw ? JSON.parse(raw)?.dry === true : false;
    } catch {
      throw new ApiError(400, "invalid_json", "send {} or {\"dry\":true}");
    }
    const lines = await personaRecord.carry({ dry });
    console.log(`e62s6 carry${dry ? " (dry)" : ""}: ${JSON.stringify(lines)}`);
    return c.json({ dry, lines });
  });
  // carry-over (once per console): each world's tracked milestones and their marks into its team repo's
  // state/milestones.json. `{"dry":true}` says what it would write. the home world / host only (not TENANT_SAFE).
  api.post("/e62s5/carry", async (c) => {
    const raw = (await c.req.text()).trim();
    let dry = false;
    try {
      dry = raw ? JSON.parse(raw)?.dry === true : false;
    } catch {
      throw new ApiError(400, "invalid_json", "send {} or {\"dry\":true}");
    }
    const lines = await milestoneRecord.carry({ dry });
    console.log(`e62s5 carry${dry ? " (dry)" : ""}: ${JSON.stringify(lines)}`);
    return c.json({ dry, lines });
  });
  // carry-over (once per console): rubric rows → repo, monitoring reports → spine lines, placement state columns
  // dropped (read from the spine). `{"dry":true}` says what it would do. the home world / host only (not TENANT_SAFE).
  api.post("/e62s8/carry", async (c) => {
    const raw = (await c.req.text()).trim();
    let dry = false;
    try {
      dry = raw ? JSON.parse(raw)?.dry === true : false;
    } catch {
      throw new ApiError(400, "invalid_json", "send {} or {\"dry\":true}");
    }
    const lines = await carryE62s8({ db, store, writer: spine, spineOf: spineOfMilestone, placements: desk.placements, invalidate: dropSpines }, { dry });
    const counts = lines.reduce<Record<string, number>>((a, l) => ({ ...a, [`${l.part}: ${l.action}`]: (a[`${l.part}: ${l.action}`] ?? 0) + 1 }), {});
    console.log(`e62s8 carry${dry ? " (dry)" : ""}: ${JSON.stringify(counts)}`);
    return c.json({ dry, counts, lines });
  });
  // a raised ask is answered (or retired) at its spine line, never on this table.
  const gone = (c: Context) =>
    c.json({ error: { code: "gone", message: `Needs ${ownerName()} items are spine asks now: answer one with POST /api/waiting-on-owner/<item id>/respond; retire one by editing its line in the spine` } }, 410);
  api.patch("/needs-owner/:id", gone);
  api.post("/needs-owner/:id/supersede", gone);

  // Books are the home world's: another world's milestone has none (its id answers 404 on /book/:key, as a missing one does).
  const homeMilestones = () =>
    store.listMilestones({ includeSettled: true }).filter((x) => (store.worldOfMilestone(x.id) ?? DEFAULT_TENANT) === DEFAULT_TENANT);
  /** The milestone's book cut from the built Epic Book, with's last-updated (the last good daily refresh). */
  const bookOf = (b: Book, m: Milestone) => {
    const loc = locate(read.reposRoot, m);
    const repoName = "error" in loc ? loc.repo?.name ?? m.repo.split("/").pop()! : loc.repo.name;
    // The console's name rule: a title saved in Settings wins, else the spine's own title.
    return milestoneBook(b, { id: m.id, ...(m.titleSetAt ? { title: m.title } : {}), repoName, path: m.path }, { refreshedAt: bookRefresh?.lastOkAt() ?? null, now: (opts.bookRefresh?.now ?? Date.now)(), links });
  };
  /** books none of whose sources moved in 2 days: stuck items on /book (the owner's radar). */
  const staleBooks = (b: Book) =>
    homeMilestones()
      .filter((m) => m.path && !m.settledAt)
      .flatMap((m) => {
        const mb = bookOf(b, m);
        return mb && mb.updated.stale ? [{ milestoneId: m.id, title: mb.milestone.title, repo: mb.repo.name, updatedAt: mb.updated.at }] : [];
      });

  // Epic Book: GET /book, every repo's spines as one "where are we" (the home world only: auth/routeScope.ts denies by default).
  api.get("/book", compress(), async (c) => {
    if (!book) return c.json({ error: { code: "spines_unavailable", message: "EpicSpine spines.py is not installed on the console host" } }, 503);
    const v = await book.get();
    // rework: refreshedAt = the newest of the last daily refresh and the last rebuild (spine/git change, timer);
    // dailyRefreshAt keeps the daily pull + probe on its own.
    const daily = bookRefresh?.lastOkAt() ?? null;
    const refreshedAt = [daily, v.book?.builtAt ?? null].filter((x): x is string => !!x).sort().pop() ?? null;
    return c.json(v.book ? { ...v, book: bookWithChecks(slimOf(v.book), links), staleBooks: staleBooks(v.book), refreshedAt, dailyRefreshAt: daily } : v);
  });
  // the books' daily refresh: GET its last runs and whether today's is due; POST runs one now (202, in the background).
  api.get("/book-refresh", (c) => {
    if (!bookRefresh) return c.json({ error: { code: "spines_unavailable", message: "EpicSpine spines.py is not installed on the console host" } }, 503);
    return c.json({ running: bookRefresh.running(), due: bookRefresh.due(), lastOkAt: bookRefresh.lastOkAt() ?? null, runs: bookRefresh.list(10) });
  });
  api.post("/book-refresh", (c) => {
    if (!bookRefresh) return c.json({ error: { code: "spines_unavailable", message: "EpicSpine spines.py is not installed on the console host" } }, 503);
    const was = bookRefresh.running();
    void bookRefresh.run("manual").catch(() => undefined);
    return c.json({ started: !was, running: true }, 202);
  });
  // Epic Book per milestone: GET /book/<milestone id, or the repo's name for its root milestone>, the human page's
  // data (narrative from Goal, Done means and Current State; the plan tree), cut from the same cached book (the home world only).
  api.get("/book/:key", compress(), async (c) => {
    if (!book) return c.json({ error: { code: "spines_unavailable", message: "EpicSpine spines.py is not installed on the console host" } }, 503);
    const key = c.req.param("key");
    const all = homeMilestones();
    const byRepo = all.filter((x) => x.path && (sameRepo(x.repo, key) || sameRepo(x.repo.split("/").pop(), key)));
    const m = all.find((x) => x.id === key) ?? byRepo.find((x) => /(^|\/)(root\.md|EPIC-0[^/]*\.md)$/i.test(x.path)) ?? byRepo[0];
    if (!m) throw new ApiError(404, "not_found", `milestone ${key} not found`);
    const v = await book.get();
    if (!v.book) return c.json({ book: null, building: v.building, milestoneId: m.id });
    const mb = bookOf(v.book, m);
    if (!mb) throw new ApiError(404, "not_found", `no spine ${m.path} in ${m.repo.split("/").pop()}'s book yet`);
    return c.json({ book: mb, building: v.building });
  });

  // the epic decks and the big rocks board, cut from the same cached book (the home world only).
  const teamRepoDir = () => resolveRepo(read.reposRoot, homeRepo())?.path;
  const rocksNow = () => readBigRocks(teamRepoDir());
  const repoNameOf = (m: Milestone) => {
    const loc = locate(read.reposRoot, m);
    return "error" in loc ? loc.repo?.name ?? m.repo.split("/").pop()! : loc.repo.name;
  };
  const bigRootsNow = () =>
    homeMilestones()
      .filter((m) => m.path && !m.settledAt && m.bigRoot != null)
      .sort((a, b) => a.bigRoot! - b.bigRoot! || a.createdAt.localeCompare(b.createdAt))
      .map((m) => ({ id: m.id, repoName: repoNameOf(m), path: m.path!, ...(m.titleSetAt ? { title: m.title } : {}) }));
  /** The console milestone that tracks a spine (its Epic Book), when one does. */
  const milestoneOfSpine = (repoName: string, p: string) => homeMilestones().find((m) => m.path === p && repoNameOf(m) === repoName)?.id;
  const deckOf = (b: Book, ref: DeckRef, notify?: { trend(r: DeckRef): DeckTrendPoint[] }): EpicDeck | null => {
    const repo = b.repos.find((r) => r.name === ref.repo);
    const e = repo && findEpic(repo, ref.code);
    if (!repo || !e) return null;
    const canonical = { repo: repo.name, code: deckCode(e) };
    return epicDeck(b, canonical, {
      rocks: rocksNow()?.rocks ?? [],
      trend: notify?.trend(canonical) ?? [],
      milestoneId: milestoneOfSpine(repo.name, e.path),
      refreshedAt: bookRefresh?.lastOkAt() ?? null,
      now: (opts.bookRefresh?.now ?? Date.now)(),
      links,
    });
  };
  const deckNotify: DeckNotify | undefined = book
    ? createDeckNotify({
        db,
        repoDir: teamRepoDir,
        writer: spine,
        ...(opts.deckNotify?.now ? { now: opts.deckNotify.now } : {}),
        decks: async (): Promise<EpicDeck[]> => {
          const v = await book.get();
          if (!v.book) return [];
          return deckList(v.book, bigRootsNow(), { rocks: rocksNow()?.rocks ?? [] }).flatMap((d) => deckOf(v.book!, d.ref, deckNotify) ?? []);
        },
      })
    : undefined;
  if (deckNotify && opts.deckNotify?.tickMs) phased(opts.timerPhases, "deckNotify", () => deckNotify.start(opts.deckNotify!.tickMs!));
  const noBook = (c: Context) => c.json({ error: { code: "spines_unavailable", message: "EpicSpine spines.py is not installed on the console host" } }, 503);
  /**
   * through the door (the owner on a customer site) the decks read only the home world's own repos: a checkout one
   * of the home world's milestones names (repoWorlds: the home world's claim), never another world's repo, never a checkout
   * no milestone names. Every deck route cuts the book with this first, so a deck, its plan, cards and links stay in them.
   */
  const doorBook = (b: Book): Book => {
    if (!doorSession()) return b;
    const claims = repoWorlds(db, read.reposRoot);
    const own = new Set(listRepos(read.reposRoot).filter((r) => claims.get(r.path)?.has(DEFAULT_TENANT)).map((r) => r.name));
    return { ...b, repos: b.repos.filter((r) => own.has(r.name)) };
  };
  // who keeps each page, from the repo (the board's `Kept by:` line, the team repo's personas and assignments).
  const teamNow = () => {
    const milestones = homeMilestones();
    const ids = new Set(milestones.map((m) => m.id));
    return { personas: store.listPersonas(), assignments: store.listAssignments().filter((a) => ids.has(a.milestoneId)), milestones };
  };
  const deckAbout = (b: Book, d: EpicDeck): DeckAbout => {
    const repo = b.repos.find((r) => r.name === d.ref.repo);
    const chain: string[] = [];
    for (let p: string | null = d.path; p && !chain.includes(p); p = repo?.epics.find((e) => e.path === p)?.parent ?? null) chain.push(p);
    const team = teamNow();
    const rocks = rocksNow();
    return {
      repo: d.ref.repo,
      spinePath: d.path,
      ...deckWorkers(chain, (p) => team.milestones.find((m) => m.path === p && repoNameOf(m) === d.ref.repo), team),
      refresh: { at: utcHourText(REFRESH_HOUR_UTC, (opts.bookRefresh?.now ?? Date.now)()), lastOkAt: bookRefresh?.lastOkAt() ?? null },
      rocks: rocks ? rocksAbout(rocks, team) : null,
    };
  };
  // GET /milestones/:id/arc: the project's three-phase plan (docs/arcs.md of the code repo), each phase with its epic's
  // status and deck from the book; null when the project has no arc.
  api.get("/milestones/:id/arc", async (c) => {
    const m = found(store.getMilestone(c.req.param("id")), "milestone", c.req.param("id"));
    const arcs = readArcs(teamRepoDir());
    if (!arcs || !m.path) return c.json({ arc: null });
    const v = book ? await book.get() : undefined;
    return c.json({ arc: arcFor(arcs, repoNameOf(m), m.path, v?.book?.repos ?? []) });
  });
  // GET /rocks: the big rocks board (docs/big-rocks.md), each rock with the decks it sits on.
  api.get("/rocks", async (c) => {
    const rocks = rocksNow();
    if (!rocks) return c.json({ rocks: null, file: BIG_ROCKS_FILE });
    const v = book ? await book.get() : undefined;
    const decks = v?.book ? deckList(v.book, bigRootsNow(), { rocks: rocks.rocks }) : [];
    return c.json({
      rocks: { ...rocks, rocks: rocks.rocks.map((r) => ({ ...r, decks: decks.filter((d) => d.rocks.includes(r.id)).map((d) => ({ ref: d.ref, href: d.href, title: d.title, kind: d.kind })) })) },
      file: BIG_ROCKS_FILE,
      about: rocksAbout(rocks, teamNow()),
    });
  });
  // GET /decks: the high-level epics with a deck (the owner's focus milestones, then the big lanes) and the cards now.
  api.get("/decks", async (c) => {
    if (!book) return noBook(c);
    const v = await book.get();
    if (!v.book) return c.json({ decks: [], cards: [], building: v.building });
    const b = doorBook(v.book);
    const rocks = rocksNow();
    const about = { refresh: { at: utcHourText(REFRESH_HOUR_UTC, (opts.bookRefresh?.now ?? Date.now)()), lastOkAt: bookRefresh?.lastOkAt() ?? null }, rocks: rocks ? rocksAbout(rocks, teamNow()) : null };
    return c.json({ decks: deckList(b, bigRootsNow(), { rocks: rocks?.rocks ?? [] }), cards: deckCardsOf(b), building: v.building, updatesFile: DECK_UPDATES_FILE, about });
  });
  const deckCardsOf = (b: Book) =>
    (deckNotify?.cards() ?? []).filter((l) => !doorSession() || b.repos.some((r) => r.name === l.ref.repo)).map((l) => {
      const repo = b.repos.find((r) => r.name === l.ref.repo);
      const e = repo && findEpic(repo, l.ref.code);
      return { ref: l.ref, href: deckHref(l.ref), title: e ? e.title.replace(/^\s*(EPIC-\d+|M\d+)\s*[:—–-]\s*/i, "") : `${l.ref.repo}/${l.ref.code}`, date: l.date, text: l.text, goals: { met: l.goalsMet, total: l.goalsTotal } };
    });
  // GET /deck-cards: the Team home's "Epic decks changed" cards (each deck's newest unseen line in deck-updates.md).
  api.get("/deck-cards", async (c) => {
    if (!book) return noBook(c);
    const v = await book.get();
    return c.json({ cards: v.book ? deckCardsOf(doorBook(v.book)) : [] });
  });
  // POST /deck-cards/seen {repo, code, date}: the owner saw a card; `· seen <date>` goes on its line (spine writer, L-45).
  api.post("/deck-cards/seen", async (c) => {
    if (!deckNotify) return noBook(c);
    const b = ((await c.req.json().catch(() => undefined)) ?? {}) as Record<string, unknown>;
    const repo = typeof b.repo === "string" ? b.repo : "";
    const code = typeof b.code === "string" ? b.code : "";
    const date = typeof b.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : "";
    if (!repo || !code || !date) throw new ApiError(400, "invalid_body", "send {repo, code, date}");
    const w = await deckNotify.seen({ repo, code }, date);
    if (w.status !== "written") return c.json({ error: { code: w.status === "failed" ? "git_failed" : "conflict", message: `not marked seen: ${w.reason ?? w.status}` } }, w.status === "failed" ? 502 : 409);
    dropSpines(teamRepoDir() ?? "");
    return c.json({ ok: true, sha: "sha" in w ? w.sha : undefined });
  });
  // POST /decks/check: compare the decks with their last lines now (the timer does it every 10 min); 202.
  api.post("/decks/check", async (c) => {
    if (!deckNotify) return noBook(c);
    const r = await deckNotify.tick();
    return c.json(r, 202);
  });
  // GET /deck/:repo/:code: one epic deck (stable URL `/deck/<repo>/<code>`; code =, M6, or the spine's file name).
  api.get("/deck/:repo/:code", compress(), async (c) => {
    if (!book) return noBook(c);
    const v = await book.get();
    if (!v.book) return c.json({ deck: null, building: v.building });
    const b = doorBook(v.book);
    const d = deckOf(b, { repo: c.req.param("repo"), code: c.req.param("code") }, deckNotify);
    if (!d) throw new ApiError(404, "not_found", `no epic ${c.req.param("code")} in ${c.req.param("repo")}'s book`);
    // a product's deck (its Epic Book) links the page where its numbers live, the numbers read now (hourly cache).
    const repo = b.repos.find((r) => r.name === d.ref.repo);
    const live = await socialArea?.livePage(repo?.remote ?? d.ref.repo);
    return c.json({ deck: d, about: deckAbout(b, d), ...(live ? { live } : {}), building: v.building });
  });
  // GET /deck-of/<milestone id, or a repo's name>, the deck of
  // that milestone's spine, so every old /book/<key> link opens its deck (the web's /book/:key redirects through it).
  api.get("/deck-of/:key", async (c) => {
    if (!book) return noBook(c);
    const key = c.req.param("key");
    const all = homeMilestones();
    const byRepo = all.filter((x) => x.path && (sameRepo(x.repo, key) || sameRepo(x.repo.split("/").pop(), key)));
    const m = all.find((x) => x.id === key) ?? byRepo.find((x) => /(^|\/)(root\.md|EPIC-0[^/]*\.md)$/i.test(x.path)) ?? byRepo[0];
    if (!m?.path) throw new ApiError(404, "not_found", `milestone ${key} not found`);
    const v = await book.get();
    if (!v.book) return c.json({ href: null, building: v.building });
    const repoName = repoNameOf(m);
    const e = doorBook(v.book).repos.find((r) => r.name === repoName)?.epics.find((x) => x.path === m.path);
    if (!e) throw new ApiError(404, "not_found", `no spine ${m.path} in ${repoName}'s book yet`);
    return c.json({ href: deckHref({ repo: repoName, code: deckCode(e) }), repo: repoName, building: v.building });
  });

  // Spines page + ad hoc node view (any spine, untracked).
  api.route("/", spinesRoutes({ reposRoot: read.reposRoot, store, run: read.spines, treeFor: (m) => treeFor(m) }));

  // read adapters: repos/docs pickers, backlog, threads, tickets, seats
  api.route("/", readRoutes(read, store, () => cycle.hostEnvironment(mainHost()), db));

  // M4 browser auth (hosted/browser.ts): forwarded to the Team Browser service, one instance per world.
  browserArea?.mount({ auth, onSitesChanged: testerWorlds?.onSitesChanged });


  mountRubric(api, db, (id) => !!store.getMilestone(id)); // GET/PUT /rubric-settings: the Unblocker's confidence rubric
  mountAskMemory(api, db); // GET /ask-memory: the Unblocker's per-ask memory (read by..S27)
  mountUnblockerStats(api, db, store); // GET /unblocker-stats: the Unblocker's numbers per milestone and window
  mountWakeStats(api, store); // GET /wake-stats?days=1: skipped / real / wasted wakes per assignment per UTC day (the home world only)
  mountUsage(api, db, () => store.tenant); // GET /usage totals (the caller's world)
  mountProviders(api, { db, store, record: (ts) => personaRecord.recorded(ts) }); // provider + model per persona, world default, price per provider; file first
  credits?.mount(api); // credits: GET balance/ledger (world-scoped), grant + gate (platform) (hosted/billing.ts)

  // the team mailbox: the owner's mail to the team address reaches the Team desk thread as his message (hosted/services.ts).
  services?.mail({
    // a reply whose subject names a row lands on it: the spines of the owner's world's checkouts (the code repo first) say
    // where the row is, the milestone whose tree holds that spine has its Delivery manager woken with his words.
    repos: () => {
      const names = new Set([homeRepo()]);
      for (const m of store.listMilestones({ includeSettled: true })) if ((store.worldOfMilestone?.(m.id) ?? DEFAULT_TENANT) === DEFAULT_TENANT && m.path) names.add(resolveRepo(read.reposRoot, m.repo)?.name ?? "");
      return [...names].flatMap((n) => {
        const r = n ? resolveRepo(read.reposRoot, n) : undefined;
        return r ? [{ name: r.name, dir: r.path }] : [];
      });
    },
    spineMilestone,
    wake: cycleOpts.enabled
      ? async (id, note) => {
          const m = store.getMilestone(id);
          if (!m) return undefined;
          const a = await wakeDeliveryManager({ store, cycle, homeThread: (x) => cycle.getLink(x)?.threadId }, m, note);
          return a && "error" in a ? { error: a.error } : a;
        }
      : undefined,
    post: async (text, page, crid) => {
      try {
        await desk.send(text, page, crid);
        return true;
      } catch (e) {
        return (e as Error).message.slice(0, 200);
      }
    },
  });
  // the owner's WhatsApp voice notes in the memory service reach the Team desk thread as his message (once per note).
  const voiceNotes = createVoiceNoteRelay({
    db,
    list: opts.mcp?.voiceNoteList ?? services?.voiceNotes ?? (async () => ({ error: NO_MEMORY })),
    read: memory,
    post: async (text, page, crid) => {
      try {
        const r = await desk.send(text, page, crid);
        deskSaid(DEFAULT_TENANT, text, crid, r.pending); // a part of his WhatsApp note for his other desk crosses too
        return true;
      } catch (e) {
        return (e as Error).message.slice(0, 200);
      }
    },
    ...(opts.voiceNotes?.now ? { now: opts.voiceNotes.now } : {}),
    ...(opts.voiceNotes?.hookRetryMs ? { hookRetryMs: opts.voiceNotes.hookRetryMs } : {}),
    // each note's transcript also goes to the owner's team repo (voice/<day>.md); no checkout = nothing copied.
    archive: (notes) => team.writeVoice(notes),
    // the status tells the truth about the push: the home world's connection, if live, and each world's path.
    connection: () => memoryConns?.summary(DEFAULT_TENANT),
    worlds: () => {
      const ws = memoryConns?.worlds() ?? [];
      return [DEFAULT_TENANT, ...ws.filter((w) => w !== DEFAULT_TENANT)].map((w) => {
        const conn = memoryConns?.summary(w);
        return { world: w, team: teamName(w), ...(conn ? { connection: conn } : {}) };
      });
    },
  });
  mountVoiceNotes(api, voiceNotes);
  // the latest long-note passes (which cards each marked, whose owner was woken), newest first.
  api.get("/desk/voice-touches", (c) => c.json({ on: !!noteTouch, passes: noteTouch?.recent(Number(c.req.query("limit") ?? 20) || 20) ?? [] }));
  // E942-S174 try the pass on given words (a past note, a test), writing nothing: {words, after?, typed?, cards?}
  api.post("/desk/voice-touches/try", async (c) => {
    if (!touchTry) return c.json({ error: { code: "off", message: "the long-note pass is off on this console" } }, 503);
    const b = (await c.req.json().catch(() => ({}))) as { words?: unknown; after?: unknown; typed?: unknown; cards?: unknown };
    const words = typeof b.words === "string" ? b.words.trim() : "";
    if (!words || words.length > 90_000) return c.json({ error: { code: "bad_request", message: "words (his note, up to 90,000 characters) is required; after, typed and cards are optional" } }, 400);
    const cards = Array.isArray(b.cards)
      ? (b.cards as Record<string, unknown>[]).slice(0, 80).map((x): TouchCard => ({ kind: x.kind === "ask" ? "ask" : "row", ref: String(x.ref ?? ""), title: String(x.title ?? ""), about: String(x.about ?? ""), ...(typeof x.topic === "string" ? { topic: x.topic } : {}), repo: "try", path: "try", current: "" }))
      : undefined;
    return c.json(await touchTry({ words, ...(typeof b.after === "string" ? { after: b.after } : {}), typed: b.typed === true, ...(cards ? { cards } : {}) }));
  });
  // run the pass on one WhatsApp note the relay already posted (a note that came before the pass, or whose pass
  // failed). The words come from the memory service, never from the caller; one pass per note, so a repeat answers its first result.
  api.post("/desk/voice-touches/run", async (c) => {
    if (!noteTouch) return c.json({ error: { code: "off", message: "the long-note pass is off on this console" } }, 503);
    const b = (await c.req.json().catch(() => ({}))) as { ref?: unknown };
    const ref = typeof b.ref === "string" ? b.ref.trim() : "";
    if (!/^Log\/[\w.-]+#\^[\w-]+$/.test(ref)) return c.json({ error: { code: "bad_request", message: `ref: a ${memoryName()} evidence ref (Log/<day>.md#^e-…)` } }, 400);
    if (!db.prepare("SELECT 1 FROM desk_voice_notes WHERE evidence_ref = ? AND state = 'posted'").get(ref)) return c.json({ error: { code: "not_found", message: "not a WhatsApp voice note the Team desk got" } }, 404);
    const got = await memory(ref);
    if ("error" in got) return c.json({ error: { code: "memory", message: got.error } }, 502);
    const state = await noteTouch.heard({ world: DEFAULT_TENANT, words: voiceNoteMessage(ref, got.entry), where: "WhatsApp", id: ref, ref, ...(got.entry.capturedAt ? { at: got.entry.capturedAt } : {}) });
    return c.json({ state: state ?? "short", pass: noteTouch.get(ref) ?? null });
  });
  // the memory service pushes each new voice note here (signed); once it has, the minute timer polls only as a 20-min safety net.
  mountVoiceHook(api, voiceNotes, {
    secret: opts.voiceNotes?.hookSecret ?? secretFromFile(defaultMemoryHookSecretFile()),
    ...(opts.voiceNotes?.hookNowSec ? { nowSec: opts.voiceNotes.hookNowSec } : {}),
  });
  const teamName = (world: string): string => {
    if (world === DEFAULT_TENANT) return "EpicTeam";
    const t = db.prepare("SELECT name, skin, plan FROM tenants WHERE id = ?").get(world) as { name: string | null; skin: string | null; plan: string | null } | undefined;
    return t?.skin === "social" && t.plan === "internal" ? socialProduct() : t?.name || world;
  };
  const worldMilestones = (world: string) =>
    db.prepare("SELECT id, title FROM milestones WHERE tenant_id = ? AND settled_at IS NULL AND paused = 0 ORDER BY title").all(world) as { id: string; title: string }[];
  /**
   * the `📞 Call with the desk` post of a call from before its transcript was stored, read back from the
   * chat it went to (a milestone's, the Team desk, or a world's desk): the whole chat once, every call post in it kept for
   * a minute, so a back-fill of many calls reads each chat once and a retry reads it afresh.
   */
  const callPosts = new Map<string, { at: number; posts: Map<string, string> }>();
  const callChatCopy = async (c: { id: string; world: string; milestoneId: string | null }): Promise<string | undefined> => {
    const key = c.milestoneId ? `milestone:${c.milestoneId}` : `world:${c.world}`;
    let k = callPosts.get(key);
    if (!k || Date.now() - k.at > 60_000) {
      const chat = c.milestoneId ? milestoneChats.chatFor(c.milestoneId) : c.world === DEFAULT_TENANT ? desk : worldDesks.chatFor(c.world);
      const posts = new Map<string, string>();
      const keep = (ms: DeskMessage[]) => {
        for (const m of ms) {
          if (!m.text?.startsWith(CALL_TRANSCRIPT_HEAD)) continue;
          const id = /\b(call_[0-9a-f]+)\s*$/.exec(m.text.split("\n")[0] ?? "")?.[1];
          if (id) posts.set(id, m.text);
        }
      };
      const v = await chat.view();
      if (v.available === false) throw new Error("the chat is not reachable");
      keep(v.messages);
      let page: { messages: DeskMessage[]; hasEarlier: boolean } = v;
      for (let i = 0; i < 200 && page.hasEarlier && page.messages.length; i++) {
        page = await chat.earlier(Math.min(...page.messages.map((m) => m.position ?? 0)), 100);
        keep(page.messages);
      }
      callPosts.set(key, (k = { at: Date.now(), posts }));
    }
    return k.posts.get(c.id);
  };
  // the memory service's helpers ask the Team desk one read-only question per run (a hosted services module). The answer is read from the
  // world's status and the spines of its milestones' repos (each epic's goal, state, next step, ready and review rows).
  const askContext = async (world: string): Promise<AskContext> => {
    const status = (await worldDeskStatus(world)).text;
    const b = await builtBook();
    const names = new Set<string>(world === DEFAULT_TENANT ? [DESK_BOOK_REPO] : []);
    const dirs = new Map<string, string>();
    for (const m of store.listMilestones().filter((x) => milestoneWorld(db, x.id) === world)) {
      const r = resolveRepo(read.reposRoot, m.repo);
      if (r) {
        names.add(r.name);
        dirs.set(r.name, r.path);
      }
    }
    for (const n of names) if (!dirs.has(n)) dirs.set(n, resolveRepo(read.reposRoot, n)?.path ?? "");
    const epics = (b?.repos ?? [])
      .filter((r) => names.has(r.name))
      .flatMap((r) =>
        r.epics
          .filter((e) => e.state !== "done")
          .map((e) => ({
            code: e.code,
            title: e.title,
            goal: e.goal,
            status: e.status,
            next: e.next,
            waitingOn: e.waitingOn,
            rows: () => {
              const dir = dirs.get(r.name);
              if (!dir) return [];
              try {
                return readyAndReviewRows(fs.readFileSync(path.join(dir, e.path), "utf8"));
              } catch {
                return [];
              }
            },
          })),
      );
    return { status, milestones: worldMilestones(world).map((m) => ({ title: m.title })), epics };
  };
  // the memory service per world, the Chat notes' forward, the memory service helper (hosted/services.ts).
  memoryConns = services?.memoryArea({
    teamName,
    worldMilestones,
    onPosted: (world, ref, capturedAt, via) => {
      if (world === DEFAULT_TENANT) voiceNotes.postedElsewhere(ref, capturedAt, via as Parameters<typeof voiceNotes.postedElsewhere>[2]);
    },
    post: async (world, deskId, text, page, crid) => {
      try {
        if (deskId === "team") {
          const r = world === DEFAULT_TENANT ? await desk.send(text, page, crid) : await worldDesks.send(world, text, page, crid);
          deskSaid(world, text, crid, r.pending); // his voice note on a world's Team desk crosses like a typed message
        } else {
          const id = deskId.startsWith("ms:") ? deskId.slice(3) : "";
          if (!worldMilestones(world).some((m) => m.id === id)) return `that desk is gone (${deskId}): pick another on Connections`;
          await milestoneChats.send(id, text, page, crid);
        }
        return true;
      } catch (e) {
        return (e as Error).message.slice(0, 200);
      }
    },
    callChat: callChatCopy,
    askContext,
    ...(opts.memoryAsk?.worder && textAsk ? { askWorder: textAsk.worder } : {}),
    pollSearches: (w) => (w === DEFAULT_TENANT ? voiceNotes.pollSearchesToday() : undefined),
    connections: opts.memoryConnections,
    forward: opts.memoryForward,
  });
  memoryForward = memoryConns?.forward;
  // The global minute poll on our own the memory service token stops once the home world's world is connected (its notes then come by push,
  // each connection running its own 20-minute safety check).
  if (opts.voiceNotes?.tickMs && cycleOpts.enabled && memoryConns)
    setInterval(() => {
      if (!memoryConns?.connected(DEFAULT_TENANT)) void voiceNotes.timerTick().catch((e) => console.error("voice notes:", e));
      void memoryConns?.tick().catch((e) => console.error("memory connections:", e));
    }, opts.voiceNotes.tickMs).unref();
  // the Services page, the services hub, the mail settings and poll, the Gmail MCP (hosted/services.ts).
  services?.mountRoutes({ recordAccess: (k, p, v, set) => assignmentRecord.access(k, p, v, set), recordCap: (p, cap, set) => assignmentRecord.mailCap(p, cap, set) }); // access file first

  hostsArea?.mountReleases(app, api); // GET /releases and /api/releases, production and staging revisions and the release log
  api.all("*", (c) => c.json({ error: { code: "not_found", message: `no route ${c.req.method} ${c.req.path}` } }, 404));
  app.route("/api", api);
  ensureWorldStamps(db); // rows written outside the scoped store take their milestone's world (after every side table exists)
  browserArea?.mountScript(app); // M4 the Mac's sync script (hosted/browser.ts)

  // the secure copy of every steps page: the tailnet page served from here, so its note boxes record in place.
  mountStepsView(app, { byId: (id) => stepsApi.byId(id) });

  // the voice-note landing reports, served from the repo (landing.ts).
  mountLanding(app, () => {
    const repo = opts.landingDir ? undefined : resolveRepo(read.reposRoot, homeRepo());
    return opts.landingDir ?? (repo && path.join(repo.path, "docs", "landing"));
  });

  // Static UI (core/console/web/dist) with SPA fallback to index.html, if it has been built.
  const staticDir = opts.staticDir && path.resolve(opts.staticDir);
  // the social hosts get the social product's violet icon set at the usual icon paths (another origin, so no cache clash),
  // before any script runs and on the server's login page too; web/public holds both sets.
  const iconHosts = socialHosts();
  if (staticDir) {
    app.get("*", (c) => {
      const onSocial = iconHosts.has(requestHost((n) => c.req.header(n)) ?? "");
      const socialIcon = onSocial ? SOCIAL_ICONS[c.req.path] : undefined;
      if (socialIcon && fs.existsSync(path.join(staticDir, socialIcon))) return c.body(fs.readFileSync(path.join(staticDir, socialIcon)), 200, { "Content-Type": contentType(socialIcon) });
      const index = path.join(staticDir, "index.html");
      if (!fs.existsSync(index)) return c.text("console UI not built (core/console/web/dist missing)", 404);
      let rel: string;
      try {
        rel = decodeURIComponent(c.req.path);
      } catch {
        return c.text("bad path", 400);
      }
      const file = path.resolve(staticDir, "." + rel);
      const inside = file === staticDir || file.startsWith(staticDir + path.sep);
      const found = inside && fs.existsSync(file) && fs.statSync(file).isFile();
      // A hashed script that is not here (a page opened before the last release asks for one of its screens)
      // gets a plain 404, never the app page as a script: the page then reloads once onto the new build (web lazyPage.tsx).
      if (!found && rel.startsWith("/assets/")) return c.text("not found", 404, { "Cache-Control": "no-store" });
      const target = found ? file : index;
      // the 1 MB bundle went out uncompressed with no cache headers, read from disk on every app open. Hashed
      // /assets/ files are immutable (cached a year); index.html is revalidated (a deploy changes it); text is gzipped once.
      // the app page on a social host names the social product in its head (title, link-preview tags, share image).
      // the app page carries the identity (owner, home world, home repo) before the bundle, so its first paint names them.
      // the steps kit's voice page opens on this console's https address (the kit names the neutral one)
      const base = target === index ? identityIndex(staticFile(target)) : target === path.join(staticDir, "steps-kit.js") ? originFile(staticFile(target)) : staticFile(target);
      const f = target === index && onSocial ? socialIndex(base) : base;
      const immutable = rel.startsWith("/assets/") && target !== index;
      const accepts = c.req.header("accept-encoding") ?? "";
      // brotli only for the hashed files as built (never a page rewritten here, like the app page or the steps kit)
      const brBody = immutable ? (f as { br?: Buffer }).br : undefined;
      const brOk = !!brBody && /\bbr\b/.test(accepts);
      const gz = !brOk && f.gzip && /\bgzip\b/.test(accepts);
      if (!immutable && c.req.header("if-none-match") === f.etag) return c.body(null, 304, { ETag: f.etag, "Cache-Control": "no-cache" });
      return c.body((brOk ? brBody! : gz ? f.gzip! : f.raw) as Uint8Array<ArrayBuffer>, 200, {
        "Content-Type": contentType(target),
        "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
        ETag: f.etag,
        Vary: "Accept-Encoding",
        ...(brOk ? { "Content-Encoding": "br" } : gz ? { "Content-Encoding": "gzip" } : {}),
      });
    });
  }

  return app;
}
