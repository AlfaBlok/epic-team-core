import { DEFAULT_TENANT, type DB } from "../db.js";
import type { Identity } from "./identity.js";
import { hasOwnerPower } from "./owner.js";

/**
 * what CONSOLE_AUTH=on allows, per request (shadow judges the same and only logs). Four rules, in order:
 *  1. OPEN paths need no identity: health, login/setup, the login page, the Mac's one-time auth-sync URLs (the token in
 *     the URL is the credential, plan §2).
 *  2. Anything else needs an identity (session, agent token or the home world legacy trust): else 401 (pages redirect to /login).
 *  3. Cross-tenant ids: a path naming a milestone, persona, assignment, run, ask, response, host or tenant that exists in
 *     another world answers 404, as a missing id does (D2), whatever the handler does after. Same-world and unknown ids
 *     pass through unchanged.
 *  4. Worlds other than the home world reach only TENANT_SAFE routes: the ones served by's scoped store (milestones,
 *     personas, assignments, runs, asks, tenants, the world's posts ledger) plus /me and /access. Every other route (desk, cycle bootstrap, inbox writes,
 *     spines, secrets, usage…; not the browser routes since) still reads the db globally, so it answers 403 `world_scope` until its own slice
 *     scopes it (S5, S6, S9, convergence) and adds it here with a cross-tenant test. Deny by default: a new route
 *     is the home world-only until someone proves it scoped. A path no route serves is judged too (the judge runs before routing):
 *     a world's guess at a missing route logs world_scope under shadow and answers 404 after it.
 */
export type Verdict = { allow: true } | { allow: false; status: 401 | 403 | 404; reason: string; message: string };

const OPEN: [string, RegExp][] = [
  ["GET", /^\/api\/health$/],
  ["GET", /^\/api\/me$/], // answers {identity: none} instead of 401, so the web app can show the login link
  ["POST", /^\/api\/access\/(login|logout|setup|handoff|handoff\/peek)$/], // handoff = a one-time switch link to the other host; peek = what it would do, unspent
  ["GET", /^\/api\/auth-sync\/[^/]+$/],
  ["POST", /^\/api\/auth-sync\/[^/]+\/(upload|fail)$/],
  ["POST", /^\/api\/auth-sync\/rs[0-9a-f]{32}\/start$/], // the owner's Mac list runner starts one row's Re-sync (the link is the credential)
  ["GET", /^\/auth-sync\/[^/]+$/],
  ["GET", /^\/login$/],
  // Google and GitHub sign-in and sign-up (auth/oauth.ts): which buttons this site shows, the hop to the provider and
  // back (state bound to this browser and host), the world chooser for a login in several worlds, and the TEST provider's
  // page (off unless CONSOLE_OAUTH_TEST=1 outside production).
  ["GET", /^\/api\/access\/oauth\/providers$/],
  ["GET", /^\/api\/access\/oauth\/(google|github|test)\/(start|callback)$/],
  ["GET|POST", /^\/api\/access\/oauth\/test\/authorize$/],
  ["POST", /^\/api\/access\/oauth\/(pick(\/peek)?|making)$/],
  // email sign-up (a confirm link) and password reset (auth/emailAccess.ts): the customer sites only, rate-limited,
  // one-time links bound to the site; status says whether this site shows the email forms
  ["GET", /^\/api\/access\/email\/status$/],
  ["POST", /^\/api\/access\/email\/(signup|confirm|reset|reset\/finish)$/],
  // the YouTube Allow link (auth/youtubeConnect.ts): the hop to Google, its follow-ups, names-only status;
  // a stranger's Allow is refused at the channel check
  ["GET", /^\/api\/access\/oauth\/youtube\/(start|enable|finish|status)$/],
  // the one-button connects (auth/connects.ts): the hop to the provider's consent page, from the inbox card
  ["GET", /^\/api\/access\/oauth\/connect\/[a-z0-9-]{2,40}\/start$/],
  // the favicon set (web/public) is open, as a gated page redirects crawlers and browsers to /login and their icon fetch carries no identity
  // + the social product's violet set; + the 16/32 px tab icons and the share image (a crawler has no session)
  // + the web app manifest (Add to Home Screen fetches it without the session cookie)
  ["GET", /^\/(favicon(-social)?\.(ico|svg)|favicon-(16|32)(-social)?\.png|icon-(social-)?\d+\.png|apple-touch-icon(-social)?\.png|og-image(-social)?\.png|manifest(-social)?\.webmanifest)$/],
  ["GET", /^\/sw\.js$/], // the installed app's service worker (phone notifications); a static script, no data
  // the owner's one-tap Approve or Deny of one password-manager login read (hosted mcp/vaultApprovals.ts); the token in
  // the path is the credential, single-use, 10 minutes.
  ["GET|POST", /^\/api\/public\/vault-ok\/[a-f0-9]{32}$/],
  // the screenshot on a go-on ask's page (where the last failed sign-in stopped), behind the same token
  ["GET", /^\/api\/public\/vault-ok\/[a-f0-9]{32}\/shot\.png$/],
  ["GET", /^\/api\/public\/pv$/], // epicspine.dev's page-view counter, a 1x1 image (siteKpis.ts: known pages only, no cookie, nothing about the visitor kept)
  ["POST", /^\/api\/public\/testers$/], // the tester signup form on epicspine.dev (testers.ts guards it)
  ["POST", /^\/api\/public\/stripe\/tester$/], // the Stripe webhook of the tester link (signature-checked in stripeTesters.ts)
  ["POST", /^\/api\/public\/stripe\/team$/], // the Stripe webhook of Epic Team's own account (signature-checked in stripeTeam.ts)
  // a recipient's voice feedback link: the page and its record/send calls; the token in the path is the credential
  // (voiceFeedback.ts). Public through Traefik on our site only after the owner's yes.
  ["GET", /^\/api\/public\/feedback\/[\w-]{10,40}$/],
  ["POST", /^\/api\/public\/feedback\/[\w-]{10,40}\/notes(\/fbn_[a-f0-9]{8}\/(parts\/\d{1,2}|finish|discard))?$/],
  // a steps page's Done switches (steps/steps.ts): the kit script and style, and the page's ticks by its token
  // (the token in the path is the credential, as a feedback link's; the tick writes the owning spine, tells the desk, wakes the owner).
  ["GET", /^\/steps-kit\.(js|css)$/],
  // the app's face (Inter, web/public/fonts) for the open pages served outside the app: the voice feedback page
  ["GET", /^\/fonts\/inter-(400|600)\.woff2$/],
  ["GET", /^\/api\/public\/steps\/[\w-]{20,40}$/],
  ["POST", /^\/api\/public\/steps\/[\w-]{20,40}\/ticks$/],
  // a Mac ticket asks the Team desk by its page token and polls the answer (steps/deskQuestions.ts)
  ["POST", /^\/api\/public\/steps\/[\w-]{20,40}\/questions$/],
  ["GET", /^\/api\/public\/steps\/[\w-]{20,40}\/questions\/q_[a-f0-9]{12}$/],
  // a step's private box: writes only the key names its page registered (steps/steps.ts `paste`)
  ["POST", /^\/api\/public\/steps\/[\w-]{20,40}\/secret$/],
  // a note's screenshot (attached or pasted in a note box): pictures only, stored in the page's world
  ["POST|OPTIONS", /^\/api\/public\/steps\/[\w-]{20,40}\/files$/],
  // the voice button of a step's note box: its recorder page and the record/send calls (voice/notes.ts open form:
  // no list, no audio, every note `fill`); the page token in the path is the credential, as for the ticks.
  ["GET", /^\/api\/public\/steps\/[\w-]{20,40}\/voice$/],
  ["GET", /^\/api\/public\/steps-keep\.js$/], // the kit's in-place recorder's keep (voice/keepJs.ts, a static script, no data)
  ["POST", /^\/api\/public\/steps\/[\w-]{20,40}\/voice\/notes(\/vn_[a-f0-9]{8}\/(segments\/\d{1,3}|finish|discard))?$/],
  ["POST", /^\/api\/hooks\/memory\/voice-note$/], // the memory service's voice-note push (host/tailnet/docker-bridge peer + HMAC, desk/voiceNotes.ts)
  // option A: a world's signed delivery (that connection's whsec_ HMAC, 5-min window, event dedupe; 404 unless
  // the hosted module's switch is on; a hosted services module). Public through Traefik only after the owner's yes.
  ["POST", /^\/api\/hooks\/memory\/zcn_[a-f0-9]{16}$/],
  // the memory service helper's one read-only question, signed the same way (one per helper run, 20 a day; a hosted services module).
  ["POST", /^\/api\/hooks\/memory\/zcn_[a-f0-9]{16}\/ask$/],
];

const ID = "[^/]+";
/**
 * the words that name a route under a collection (GET /api/runs/stats, POST /api/needs-owner/carry), never a
 * record's id. ROW_ID is an id under milestones, personas, assignments, runs and needs-owner that is none of them, so a
 * `/<collection>/${ROW_ID}` rule never lets a named route through by accident (a plain /runs/:id once let /runs/active,
 * /runs/hosts and /runs/stats through the door): each named route is listed by its name where it is allowed.
 * The hosted door walk test fails when a registered route's word slips through an id rule.
 */
export const NAMED_SEGMENTS = ["active", "hosts", "stats", "carry", "retire"] as const;
const ROW_ID = `(?!(?:${NAMED_SEGMENTS.join("|")})(?:/|$))[^/]+`;
export const TENANT_SAFE: [string, RegExp][] = [
  ["GET|POST", /^\/api\/(milestones|personas|assignments|runs|needs-owner)$/],
  ["GET|PATCH|PUT|DELETE", new RegExp(`^/api/(milestones|personas|assignments)/${ROW_ID}$`)],
  ["GET|PATCH", new RegExp(`^/api/(runs|needs-owner)/${ROW_ID}$`)],
  // the Runs page's and Team home's charts, each counted over the request-scoped store (the world's own runs only)
  ["GET", /^\/api\/runs\/(active|hosts|stats)$/],
  ["POST", new RegExp(`^/api/needs-owner/${ID}/supersede$`)],
  // run control by one id (cycle/routes.ts, cycle/service.ts): the wake stub and its prompt, the wake check, Run now
  // (the Unblocker wakes its Delivery Manager), steer and stop read and write only that assignment's or run's rows (rule 3
  // 404s another world's id); the prompt's lists (asks, claims, child epics) keep to the milestone's world. routeList.test.ts
  ["POST", new RegExp(`^/api/assignments/${ID}/(wake|run-now|steer)$`)],
  ["GET", new RegExp(`^/api/assignments/${ID}/(wake-check|cycle)$`)],
  ["POST", new RegExp(`^/api/runs/${ID}/(steer|stop|workers)$`)], // workers: the main server launch, refused 409 unless CONSOLE_CAP_FALLBACK=1
  // the Repo desk (a milestone chat, with its world's token) and the owner's chat page. Each reads and writes only the
  // path milestone's rows, checkout and chat (rule 3 404s another world's id); Add writes its spine; dispatch picks with
  // `--world` (credits gate); an answer finds its ask only in the caller's world and supersedes Needs the owner rows only there;
  // links keep to the world's checkouts (filter). The Team desk's own routes (desk/placements, desk/stamp,
  // tickets/session) stay the home world's: the Team desk is the platform's one thread, and no world's seed names them. routeList2.test.ts
  ["GET|POST", new RegExp(`^/api/milestones/${ID}/chat/messages$`)],
  // a campaign chat's Call (voice/routes.ts mountCampaignVoice): one Voice per path milestone, scoped to its world
  // (own month cap, one call at a time) and to its calls (another milestone's call id is a 404), relaying to that milestone's
  // chat; quick status lists only the milestone's world's rows. Rule 3 404s another world's milestone. routeList5.test.ts
  ["GET", new RegExp(`^/api/milestones/${ID}/voice/(state|calls)$`)],
  ["POST", new RegExp(`^/api/milestones/${ID}/voice/calls$`)],
  ["POST", new RegExp(`^/api/milestones/${ID}/voice/calls/${ID}/(beat|usage|end|ask)$`)],
  ["GET", new RegExp(`^/api/milestones/${ID}/voice/calls/${ID}/(status|ask/${ID})$`)],
  // Hang up the world's call a page does not hold: ends only the Voice's own world's active call (voice.ts endActive).
  ["POST", new RegExp(`^/api/(milestones/${ID}/voice|tenants/${ID}/desk/voice)/active/end$`)],
  // voice notes in a campaign's chat (voice/notes.ts: rows keyed by the Voice's world and milestone, so another
  // world's note id is a 404) and the world's team desk (desk/worldDesk.ts mountWorldDesk + its Call and notes): the
  // path world must be the caller's (the request-scoped store's getTenant; another world is a 404). socialFavicon.test.ts
  ["GET|POST", new RegExp(`^/api/(milestones/${ID}/voice|tenants/${ID}/desk/voice)/notes$`)],
  ["POST", new RegExp(`^/api/(milestones/${ID}/voice|tenants/${ID}/desk/voice)/notes/${ID}/(segments/\\d+|finish|discard)$`)],
  ["GET", new RegExp(`^/api/(milestones/${ID}/voice|tenants/${ID}/desk/voice)/notes/${ID}/audio$`)],
  ["GET|POST", new RegExp(`^/api/tenants/${ID}/desk/messages$`)],
  // the world desk's own relay (his part for the paired desk crosses at once; only its own call, app.ts).
  ["POST", new RegExp(`^/api/tenants/${ID}/desk/pass$`)],
  // Play on a desk reply (voice/speak.ts): stateless, reads and writes nothing, the words come from the page.
  ["POST", /^\/api\/voice\/speak$/],
  ["GET", new RegExp(`^/api/tenants/${ID}/desk/voice/(state|calls)$`)],
  ["POST", new RegExp(`^/api/tenants/${ID}/desk/voice/calls$`)],
  ["POST", new RegExp(`^/api/tenants/${ID}/desk/voice/calls/${ID}/(beat|usage|end|ask)$`)],
  ["GET", new RegExp(`^/api/tenants/${ID}/desk/voice/calls/${ID}/(status|ask/${ID})$`)],
  ["POST", new RegExp(`^/api/milestones/${ID}/(tree/add|chat/dispatch)$`)],
  ["POST", new RegExp(`^/api/waiting-on-owner/${ID}/respond$`)],
  ["POST", new RegExp(`^/api/waiting-on-owner/${ID}/snooze$`)], // same world check as respond
  // one item whole (an opened Answered row): the same world-scoped list as GET /waiting-on-owner, then that id.
  ["GET", new RegExp(`^/api/waiting-on-owner/${ID}$`)],
  // a monitor alert's ask actions: the path milestone is the caller's (rule 3); the relay acts in the ask's world
  // only for a member login, the owner login of an internal world with the same owner, or the console host
  // (status/alertActions.ts actAs), then through the routes above. alertWhoseUnblockingAsk.test.ts
  ["POST", new RegExp(`^/api/milestones/${ID}/alert-asks/${ID}/(respond|snooze|secret)$`)],
  ["GET", /^\/api\/desk\/links$/],
  ["GET", new RegExp(`^/api/tenants(/${ID})?$`)],
  ["GET", new RegExp(`^/api/tenants/${ID}/social$`)], // read through the scoped store's getTenant
  // the day's digest and its once-a-day send read only the path's world (social/digest.ts: worldRepos through the
  // world's store; the note goes to the owner's Team desk, as for the home world); rule 3 404s another world's id. helpersRequestHostX.test.ts
  ["GET", new RegExp(`^/api/tenants/${ID}/social/digest$`)],
  ["POST", new RegExp(`^/api/tenants/${ID}/social/digest/send$`)],
  ["GET", new RegExp(`^/api/tenants/${ID}/credits$`)], // the world's own balance + ledger (writes stay platform-only)
  ["POST", new RegExp(`^/api/tenants/${ID}/plan/checkout$`)], // a world buys its own €49 Epic Team plan (owner login only, below)
  ["GET", new RegExp(`^/api/tenants/${ID}/plan$`)], // may the world buy the paid plan, has it paid (the Buy button)
  // the world's own lists by path (app.ts: a store for the path's tenant in every auth mode, rule 3 404s another
  // world) and its provider default (one tenants row, the path's; the PUT stays the platform's). routeList4.test.ts
  ["GET", new RegExp(`^/api/tenants/${ID}/(milestones|personas|assignments|runs|provider)$`)],
  // read views scoped by world (store-backed, inbox/usage SQL, tenancy/world.ts list filters); perWorldRoutesConsole.test.ts
  ["GET", /^\/api\/(waiting-on-owner|owner-responses|messages|owner-activity|usage|status|next-wake|moving-now|tickets|repos|threads|desk\/placements)$/],
  ["GET", new RegExp(`^/api/milestones/${ID}/(tree|status|approvals|claims|run-commits|backlog)$`)],
  ["GET|POST", /^\/api\/access\/(tokens|switch)$/],
  ["DELETE", new RegExp(`^/api/access/tokens/${ID}$`)],
  // the browser routes go to the caller's world's own instance (browser/worlds.ts), never another world's.
  ["POST", /^\/api\/auth-sync$/],
  ["GET", /^\/api\/auth\/sites$/],
  ["GET", /^\/api\/auth\/reach$/], // Setup: sign-in metadata of the instances the world's team reads (no cookies)
  ["GET", /^\/api\/auth\/egress$/], // the egresses' online state (no addresses)
  ["GET", /^\/api\/persona-templates$/], // generic templates (files in the code repo/personas/templates, no world data)
  // the team skills library (the code repo skills/team-skills.json, no world data) for the persona editor's pick-list; its
  // used-by lists come from the request-scoped store (the caller's world's personas only). manifestEdits.test.ts
  // a world's owner adds (preview, add) and removes the world's OWN skills: teamSkills.ts keeps a world
  // caller to its own repo's skills/world-skills.json and its own personas (the team library stays read-only to it); owner_only
  // below. routeScope.test.ts
  ["GET", /^\/api\/team-skills$/],
  ["POST", /^\/api\/team-skills(\/preview)?$/],
  ["DELETE", new RegExp(`^/api/team-skills/${ID}$`)],
  ["GET", new RegExp(`^/api/auth/sites/${ID}/audit$`)],
  ["DELETE", new RegExp(`^/api/auth/sites/${ID}$`)],
  ["GET|POST|DELETE", /^\/api\/team-browser\/mcp$/],
  // a world's own secret backend (secrets/worlds.ts): names of its keys only, writes to its own store; worldStoreEncryptedPer.test.ts
  ["GET|POST", /^\/api\/secrets$/],
  ["POST", /^\/api\/secrets\/check$/],
  ["POST", new RegExp(`^/api/waiting-on-owner/${ID}/secret$`)],
  // what the social skin (the social site, a world's login) calls, found by the shadow on Campaigns. Campaigns and the
  // social writes key on the path's world (social/campaigns.ts `world`/`candidates`, social/write.ts `target`: worldRepos +
  // forTenant; rule 3 404s another world's id); per-milestone writes and reads act on the path milestone only; the rest read
  // through the request-scoped store (another world's milestone id in a query or body is a 404 under on) or the repo
  // filters (repos/:name/*, spine-tree). GET /cycle is the cycle's on/off + public URL, no world data. the home world-only on purpose:
  // the Team desk (desk/messages, the platform's one thread), POST /milestones/bootstrap (launches on any checkout), platform
  // credits writes; the social skin never calls them for another world (Chat points at the campaign's chat, Add is the
  // campaign wizard, credits admin shows only to the platform). routeList3.test.ts
  ["GET", new RegExp(`^/api/tenants/${ID}/campaigns(/repos|/template)?$`)],
  ["POST", new RegExp(`^/api/tenants/${ID}/campaigns(/preview)?$`)],
  // named campaigns inside a repo: create (a spine in one of the path world's own social repos, its milestone and
  // the copies of that world's assignments), rename, plan, retire and restore act on a milestone of the path world only
  // (social/campaigns.ts `world` + the world's store getMilestone: another world's milestone is a 404). campaignSpine.test.ts
  ["POST", new RegExp(`^/api/tenants/${ID}/campaigns/named$`)],
  ["POST", new RegExp(`^/api/tenants/${ID}/campaigns/${ID}/(rename|plan|retire|restore|onepager|onepager/draft)$`)], // the one-pager (Save as the owner; a held draft)
  // the five tabs read the campaign's epic file (totems) and write a slide (the campaign chat's rebuild), Keep,
  // Undo and a proposal's Add to the brief / Not now, through the same campaignMilestone (path world only). totemsRead.test.ts
  ["GET", new RegExp(`^/api/tenants/${ID}/campaigns/${ID}/totems$`)],
  // the campaign's Plan tab reads its marketing plan (the spine's Plan section) through the same campaignMilestone.
  ["GET", new RegExp(`^/api/tenants/${ID}/campaigns/${ID}/plan$`)],
  // the owner writes the Plan's eight sections (the campaign's own spine, through the same campaignMilestone).
  ["POST", new RegExp(`^/api/tenants/${ID}/campaigns/${ID}/plan/sections$`)],
  ["POST", new RegExp(`^/api/tenants/${ID}/campaigns/${ID}/(slide|slide/keep|slide/undo|observation|product-note)$`)], // product-note, a Product tab slide note
  // a one-off job (Add job): a new spine in one of the path world's own repos (social/campaigns.ts `world` +
  // worldRepos), its milestone and persona assignment in that world's store; another world's id is a 404. socialFavicon.test.ts
  ["POST", new RegExp(`^/api/tenants/${ID}/jobs$`)],
  // revise (Change it) and restore (Don't post's Undo) ride the same handle → target as approve and drop.
  // approve (with or without feedback) and the Approve every post switch (`approval`) go through the same
  // social/write.ts `handle` → `target` (worldRepos + forTenant of the path's world); the Publisher / Writer they wake is one
  // of that world's assignments on that repo. socialGitIdentity.test.ts (both directions)
  ["POST", new RegExp(`^/api/tenants/${ID}/social/(brief|directions|ideas|assets|approval)$`)],
  // a post's diagram, read from the path world's social repo only (social/route.ts worldRepos,
  // `?repo=` must be one of its repos, files under data/assets only). socialGitIdentity.test.ts
  ["GET", new RegExp(`^/api/tenants/${ID}/social/file$`)],
  // the Pipeline's live numbers, read from the path world's social repo only (social/metrics.ts worldRepos + socialRepo).
  ["GET", new RegExp(`^/api/tenants/${ID}/social/metrics$`)],
  // the onboarding scorecard, read from the path world only (onboarding/scorecard.ts worldRepos; its own browser, vault, logins).
  ["GET", new RegExp(`^/api/tenants/${ID}/onboarding$`)],
  // the performance view (daily KPI series, best post), read from the path world's social repo only (social/kpis.ts worldRepos + socialRepo).
  ["GET", new RegExp(`^/api/tenants/${ID}/social/kpis$`)],
  // the site numbers (daily counts only, no email): the path world's plan decides; a tester's world gets shown: false.
  ["GET", new RegExp(`^/api/tenants/${ID}/site-kpis$`)],
  // the product deck, the metrics catalog and each campaign's target, read from the path world's social repo only (social/motion.ts worldRepos + socialRepo); the site numbers only for a world on plan internal.
  ["GET", new RegExp(`^/api/tenants/${ID}/social/motion$`)],
  // a post's page reads its history from the path world's social repo only (social/history.ts worldRepos + socialRepo).
  ["GET", new RegExp(`^/api/tenants/${ID}/social/posts/${ID}/history$`)],
  // the Messages page and a chat's history read the path world's social repos only (social/messages.ts worldRepos);
  // its buttons write through social/write.ts `handle` → `target` (the path world's repos), like the post buttons below.
  ["GET", new RegExp(`^/api/tenants/${ID}/social/messages$`)],
  ["GET", new RegExp(`^/api/tenants/${ID}/social/chats/${ID}/history$`)],
  ["POST", new RegExp(`^/api/tenants/${ID}/social/(messages/${ID}/(send|revise|drop|restore|text)|chats/${ID}/(draft|accept|done|reopen|undo))$`)],
  ["POST", new RegExp(`^/api/tenants/${ID}/social/(ideas/${ID}(/drop|/feedback)?|posts/${ID}/(feedback|text|pull|release|approve|drop|revise|restore|post-now)|style-rules/${ID}/undo)$`)],
  ["POST", new RegExp(`^/api/milestones/${ID}/(settle|unsettle|mark|stamp|refresh|approvals)$`)],
  ["GET", new RegExp(`^/api/milestones/${ID}/freshness$`)],
  ["PUT", new RegExp(`^/api/milestones/${ID}/approvals/${ID}$`)],
  ["POST", new RegExp(`^/api/milestones/${ID}/approvals/${ID}/revoke$`)],
  ["GET", /^\/api\/(freshness|cycle|unblocker-stats|tickets\/sessions|spine-tree)$/],
  ["GET", new RegExp(`^/api/repos/${ID}/(spines|docs)$`)],
  ["POST", /^\/api\/(messages|waiting-on-owner\/request-asks)$/],
  ["POST", new RegExp(`^/api/owner-responses/${ID}/(deliver|change)$`)],
  // the review list ("Done, waiting for your review", Team home in both skins). Review/review.ts reads the
  // spine rows of the request-scoped store's milestones only, so another world's card id is not found (404); POST is a
  // refresh hint that stores nothing. routeJudge.test.ts (both directions)
  ["GET|POST", /^\/api\/review-items$/],
  ["GET", /^\/api\/red-line$/], // the world's own red line (its milestones' checkouts only)
  // the feed's goal headers, read from the same request-scoped store's spines as the cards.
  ["GET", /^\/api\/review-goals(\/closed)?$/],
  // Q3: Reopen finds the goal among the caller's world's closed goals only (another world's key is a 404)
  ["POST", /^\/api\/review-goals\/reopen$/],
  // after a card closes. Comment and reopen act only on a repo the request-scoped store's milestones read (another
  // world's repo is a 404); undo takes back only a press saved in the caller's world, or an answer on its own milestone;
  // Recently closed lists the caller's world's presses only. undoWindowCardPress.test.ts
  ["POST", /^\/api\/(closed-cards\/comment|review-items\/reopen)$/],
  ["POST", new RegExp(`^/api/(presses|owner-responses)/${ID}/undo$`)],
  // a press's state, so the page can say it landed (or why not); a world reads only its own presses (mount.ts)
  ["GET", new RegExp(`^/api/presses/${ID}$`)],
  ["GET", /^\/api\/closed-cards$/],
  // the pills. counts.ts reads the request-scoped store's milestones, its world's status view (viewWorld) and review rows
  // (worldGuard), and only that world's chats (its desk key + its milestones' keys); chat/seen marks the caller's desk or one of
  // its own milestones (another world's id is a 404). unreadRule.test.ts (both directions)
  ["GET", /^\/api\/counts$/],
  // the world switcher's per-world counts: the caller's own world, plus (a login only) each world its memberships
  // name, each read inside that world's own scope (counts.ts). Never a world the login does not belong to. getApiCountsWorlds.test.ts
  ["GET", /^\/api\/counts\/worlds$/],
  // the world's desk inboxes (desk/inbox.ts): only the repos the request-scoped store's milestones name. getApiCountsWorlds.test.ts
  ["GET", /^\/api\/desk\/inbox$/],
  ["POST", /^\/api\/chat\/seen$/],
  // chat attachments (desk/attachments.ts): rows keyed by the request's world, so another world's id is a 404;
  // the upload is the owner's from his page (notJordi). whatChatTakes.test.ts (both directions)
  ["POST", /^\/api\/chat\/attachments$/],
  // the links line of uploaded files, found among the request's world's rows only (cardText: another world's id is a 404)
  ["POST", /^\/api\/chat\/attachments\/line$/],
  ["GET", new RegExp(`^/api/chat/attachments/${ID}(/agent)?(/[\\w.-]+)?$`)],
  // snooze too: every action finds the row among the caller's world's rows (another world's id is a 404).
  ["POST", new RegExp(`^/api/review-items/${ID}/(recheck|approve|complete|relaunch|deny|snooze)$`)],
  // a card's screenshot, served from the row's repo; the card is found among the caller's world's rows only.
  ["GET", new RegExp(`^/api/review-items/${ID}/screenshot$`)],
  // "Asked, no row yet" (Team home, both skins). status/askedNoRow.ts lists only the caller's world's milestones
  // (store.tenant), memoized per world. routeJudge2.test.ts (both directions)
  ["GET", /^\/api\/asked-no-row$/],
  // many humans (people/routes.ts): the roster, inboxes and board are read from the caller's own world's repos
  // (worldRepos of the session's tenant); the owner-only parts are checked in the handlers; stepFormatReadsBack.test.ts
  ["GET", /^\/api\/people(\/(goals|inbox|board))?$/],
  ["POST", /^\/api\/people\/(invite|escalate-due)$/],
  ["DELETE", /^\/api\/people\/logins\/[\w.-]+$/],
  ["POST", /^\/api\/people\/asks\/[\w.-]+\/[A-Za-z0-9-]+\/(answer|approve|send-back|not-sure|seen)$/],
  ["GET", /^\/api\/orphan-commits$/], // per world, as asked-no-row
  // the team's inbox cards (inbox/teamCards.ts). A card world (cardWorlds, the owner's own social world) reads
  // and posts only its own idea cards, kept in its own repo; any other world gets 403 world_scope; advisor verdicts stay the
  // home world's (the owner's inbox). teamCardsWorlds.test.ts (both directions)
  ["GET|POST", /^\/api\/inbox\/team-cards$/],
  // the owner answers a card world's idea card from that world's skin (Go ahead, his words): the handler finds
  // the card in the caller world's own file only (another world's id or a home card: 404) and refuses its agent tokens.
  ["POST", /^\/api\/inbox\/team-cards\/[\w.-]+\/answer$/],
  // rework (the owner's review: services per world, added and signed in on the console): mcp/services.ts acts only on the
  // caller's world (servicesWorld: a token's or login's own; only the platform names another with ?world=); a service id of
  // another world answers 404; writes are the world's owner's (ownerRefusal: never a token or a member). The hub (mcp/hub.ts)
  // answers a customer world's credential only for its own runs, and a run reaches only its world's services. reworkServicesRowsPer.test.ts
  ["GET|POST", /^\/api\/mcp\/services$/],
  ["DELETE", new RegExp(`^/api/mcp/services/${ID}$`)],
  ["PUT", new RegExp(`^/api/mcp/services/${ID}/access$`)],
  ["POST", new RegExp(`^/api/mcp/services/${ID}/test$`)],
  ["PUT|DELETE", new RegExp(`^/api/mcp/services/${ID}/secret/${ID}$`)],
  ["POST", /^\/api\/mcp\/hub$/],
  // option A: Voice notes from the memory service (a hosted services module) act only on the caller's world (servicesWorld, as
  // services: only the platform names another with ?world=); the OAuth callback finds its world by the one-time state and
  // refuses a caller that may not act for it; writes are the owner's. voiceNotesMemorySign.test.ts
  ["GET", /^\/api\/connections\/memory(\/callback)?$/],
  ["POST", /^\/api\/connections\/memory\/(connect|test|disconnect|backfill)$/],
  ["PUT", /^\/api\/connections\/memory\/settings$/],
];
/**
 * the door's own list (deny by default). A door session (CONSOLE_PLATFORM_DOOR: the owner's login let into the
 * home world on a customer site, auth/gate.ts) is the home world, and many TENANT_SAFE handlers answer the home world with
 * the PLATFORM's view (secrets/worlds.ts falls through to every app's keys; services, browser, credits, usage, threads,
 * tokens…). So a door session reaches only the routes below, each read through the request-scoped store, the review
 * rows or one milestone's chat (never a home-world branch to a platform file); everything else is 403 platform_private.
 * Writes are the card buttons and a milestone chat only: no persona, epic or run changes, no wakes, no keys.
 * A route joins this list only with a check in the hosted door walk test (it seeds the platform stores).
 */
export const DOOR_SAFE: [string, RegExp][] = [
  ["GET", /^\/api\/(milestones|personas|assignments|runs|needs-owner)$/],
  ["GET", new RegExp(`^/api/(milestones|personas|assignments|runs|needs-owner)/${ROW_ID}$`)],
  // the run charts the door reads, by name: the Team home's wake numbers and the Runs page's Active agents, both
  // the home world's own runs. Not /runs/hosts: which of the platform's servers ran what is the private console's.
  ["GET", /^\/api\/runs\/(active|stats)$/],
  ["GET", new RegExp(`^/api/milestones/${ID}/(tree|status|approvals|claims|run-commits|backlog|freshness)$`)],
  ["GET", new RegExp(`^/api/tenants(/${ID})?$`)],
  ["GET", new RegExp(`^/api/tenants/${ID}/(milestones|personas|assignments|runs)$`)],
  // a milestone's chat (desk/routes.ts: that milestone's own thread; rule 3 404s another world's id) and its attachments
  ["GET|POST", new RegExp(`^/api/milestones/${ID}/chat/messages$`)],
  ["POST", /^\/api\/chat\/(seen|attachments|attachments\/line)$/],
  ["GET", new RegExp(`^/api/chat/attachments/${ID}(/agent)?(/[\\w.-]+)?$`)],
  // the cards: asks waiting on the owner and the review list, with their buttons
  ["GET", /^\/api\/(waiting-on-owner|owner-responses|asked-no-row|counts|counts\/worlds|status|next-wake|moving-now)$/],
  ["GET", new RegExp(`^/api/waiting-on-owner/${ID}$`)],
  ["POST", new RegExp(`^/api/waiting-on-owner/${ID}/(respond|snooze)$`)],
  ["GET|POST", /^\/api\/review-items$/],
  ["GET", /^\/api\/review-goals(\/closed)?$/],
  ["POST", /^\/api\/(review-goals\/reopen|closed-cards\/comment|review-items\/reopen)$/],
  ["GET", /^\/api\/closed-cards$/],
  ["POST", new RegExp(`^/api/review-items/${ID}/(recheck|approve|complete|relaunch|deny|snooze)$`)],
  ["GET", new RegExp(`^/api/review-items/${ID}/screenshot$`)],
  ["POST", new RegExp(`^/api/(presses|owner-responses)/${ID}/undo$`)],
  ["GET", new RegExp(`^/api/presses/${ID}$`)],
  // generic lists with no world data
  ["GET", /^\/api\/(persona-templates|team-skills)$/],
  // the home world's top-level Chat through the door is its own world desk (hosted desk/worldDesk.ts: a door session gets
  // the home world's own desk thread `world-desk:<home>`, never the Team desk's platform thread); rule 3 404s another world.
  ["GET|POST", new RegExp(`^/api/tenants/${ID}/desk/messages$`)],
  // the home world's own idea cards only (inbox/teamCards.ts doorSession: the home file's idea cards, never a
  // card world's, never a digest, goal or advisor card) and the owner's answer on one of them.
  ["GET", /^\/api\/inbox\/team-cards$/],
  ["POST", /^\/api\/inbox\/team-cards\/[\w.-]+\/answer$/],
];
/**
 * routes the door reaches that a customer world does not have yet. Each handler cuts its answer to the home
 * world's own data in a door session (app.ts doorBook: the epic decks read only the checkouts the home world's own
 * milestones name, never another world's repo). Read only. A route joins only with a check in the hosted door walk test.
 */
export const DOOR_ONLY: [string, RegExp][] = [
  ["GET", /^\/api\/(decks|deck-cards)$/],
  ["GET", /^\/api\/deck\/[\w.-]+\/[\w.%-]+$/],
  ["GET", /^\/api\/deck-of\/[\w.%-]+$/],
];

/**
 * owner powers. Under `on` these need an owner login (any world: its
 * handler keeps it to that world) or the console host's own owner token (auth/owner.ts); legacy trust without a
 * credential and every agent token get 403 `owner_only`, whatever the handler would do. Agent tokens, secret writes,
 * service changes, world make / remove, and settings (credits, provider default, mail, team skills, rubric, campaigns
 * opened for a world). WORLD_AGENT_SECRETS: a world's own agent tokens still add keys to that world's store (the
 * handler keeps them to their world's apps); the home world's agent tokens do not.
 */
const WORLD_AGENT_SECRETS: [string, RegExp][] = [
  ["POST", /^\/api\/secrets$/],
  ["POST", new RegExp(`^/api/waiting-on-owner/${ID}/secret$`)],
];
const OWNER_ONLY: [string, RegExp][] = [
  ["GET|POST", /^\/api\/access\/tokens$/],
  ["DELETE", new RegExp(`^/api/access/tokens/${ID}$`)],
  ["GET", /^\/api\/access\/events$/],
  ["POST", /^\/api\/secrets$/],
  ["POST", new RegExp(`^/api/waiting-on-owner/${ID}/secret$`)],
  ["POST", /^\/api\/mcp\/services$/],
  ["DELETE", new RegExp(`^/api/mcp/services/${ID}$`)],
  ["PUT", new RegExp(`^/api/mcp/services/${ID}/access$`)],
  ["PUT|DELETE", new RegExp(`^/api/mcp/services/${ID}/secret/${ID}$`)],
  ["PUT", /^\/api\/mcp\/mail\/settings$/],
  ["POST", /^\/api\/connections\/memory\/(connect|test|disconnect|backfill)$/],
  ["PUT", /^\/api\/connections\/memory\/settings$/],
  ["GET", /^\/api\/connections\/memory\/callback$/],
  ["POST|DELETE", new RegExp(`^/api/testers/${ID}/world$`)],
  ["DELETE", new RegExp(`^/api/testers/${ID}$`)],
  ["POST", /^\/api\/platform\/credits\/grant$/],
  ["PUT", /^\/api\/platform\/credits\/(gate|plan)$/],
  ["POST", new RegExp(`^/api/tenants/${ID}/credits/grant$`)],
  ["PUT", new RegExp(`^/api/tenants/${ID}/credits/gate$`)],
  ["POST", new RegExp(`^/api/tenants/${ID}/plan/checkout$`)], // money: an owner login, never an agent token
  ["PUT", new RegExp(`^/api/job-worlds/${ID}$`)], // a coupon turns a world's job servers on (money), owner only
  ["PUT", new RegExp(`^/api/tenants/${ID}/provider$`)],
  ["POST", /^\/api\/team-skills(\/preview)?$/],
  ["DELETE", new RegExp(`^/api/team-skills/${ID}$`)],
  ["POST", /^\/api\/platform\/campaigns$/],
  ["POST", /^\/api\/platform\/persona-tokens$/],
  ["PUT|DELETE", new RegExp(`^/api/rubric-settings(/${ID})?$`)],
];

/**
 * the owner's objectives: the owner's login on the social site lands in the owner's own social world, which read none of
 * them (403 world_scope, an empty sidebar). The objectives are the platform owner's, read from the home repo's scorecards
 * and pursuits, so an owner login in one of the owner's own worlds (plan internal: never a customer's or a tester's world)
 * reads them too. Read only. ownerWorldObjectives.test.ts
 */
const OWNER_WORLD_READS: [string, RegExp][] = [
  ["GET", /^\/api\/(scorecards|pursuits)$/],
  // an objective's Social kit tab on the social site: its kit.json, previews and fonts, read only
  ["GET", new RegExp(`^/api/pursuits/${ID}/kit(/(previews|fonts)/[\\w.-]+)?$`)],
  // an objective's Plan tab, read from the campaign spine it names.
  ["GET", new RegExp(`^/api/pursuits/${ID}/plan$`)],
  // the Products section on the social site: each product's words, its kit, previews and fonts, read only
  ["GET", /^\/api\/products$/],
  ["GET", new RegExp(`^/api/products/${ID}(/kit(/(previews|fonts)/[\\w.-]+)?)?$`)],
];
const isOwnersOwnWorld = (db: DB, identity: Identity): boolean => {
  if (identity.kind !== "session" || identity.role !== "owner" || identity.door) return false;
  try {
    return (db.prepare("SELECT plan FROM tenants WHERE id = ?").get(identity.tenant) as { plan?: string } | undefined)?.plan === "internal";
  } catch {
    return false;
  }
};

const matches = (rules: [string, RegExp][], method: string, path: string) =>
  rules.some(([m, re]) => m.split("|").includes(method) && re.test(path));

export const isOpen = (method: string, path: string) => matches(OPEN, method === "HEAD" ? "GET" : method, path);
export const isTenantSafe = (method: string, path: string) => matches(TENANT_SAFE, method === "HEAD" ? "GET" : method, path);
export const isDoorSafe = (method: string, path: string) => matches(DOOR_SAFE, method === "HEAD" ? "GET" : method, path);
/** a door-only route (DOOR_ONLY): the door reaches it, its handler scoped to the home world's own data. */
export const isDoorOnly = (method: string, path: string) => matches(DOOR_ONLY, method === "HEAD" ? "GET" : method, path);
export const isOwnerOnly = (method: string, path: string) => matches(OWNER_ONLY, method === "HEAD" ? "GET" : method, path);
const ownerPowerFor = (identity: Identity, method: string, path: string) =>
  hasOwnerPower(identity, "on") || (identity.kind === "token" && identity.tenant !== DEFAULT_TENANT && matches(WORLD_AGENT_SECRETS, method, path));

/** Path segments that are not ids (literal sub-routes beside `/:id`). */
const LITERAL = new Set(["bootstrap"]);
const OWNER_SQL: Record<string, string> = {
  milestones: "SELECT tenant_id AS t FROM milestones WHERE id = ?",
  personas: "SELECT tenant_id AS t FROM personas WHERE id = ?",
  assignments: "SELECT m.tenant_id AS t FROM assignments a JOIN milestones m ON m.id = a.milestone_id WHERE a.id = ?",
  runs: "SELECT tenant_id AS t FROM runs WHERE id = ?",
  "needs-owner": "SELECT tenant_id AS t FROM needs_jordi WHERE id = ?",
  "owner-responses": "SELECT tenant_id AS t FROM jordi_responses WHERE id = ?",
  hosts: "SELECT tenant_id AS t FROM hosts WHERE id = ?",
  tenants: "SELECT id AS t FROM tenants WHERE id = ?",
};

/** The world that owns the id a path names, when it names one that exists; undefined otherwise. */
export function ownerOfPath(db: DB, path: string): string | undefined {
  const m = /^\/api\/([a-z-]+)\/([^/]+)/.exec(path);
  if (!m || !(m[1] in OWNER_SQL) || LITERAL.has(m[2])) return undefined;
  let id: string;
  try {
    id = decodeURIComponent(m[2]);
  } catch {
    return undefined;
  }
  try {
    return (db.prepare(OWNER_SQL[m[1]]).get(id) as { t: string } | undefined)?.t;
  } catch {
    return undefined; // a table a test db lacks: no owner to compare
  }
}

export function judge(db: DB, identity: Identity, method: string, path: string): Verdict {
  if (isOpen(method, path)) return { allow: true };
  if (identity.kind === "none")
    return { allow: false, status: 401, reason: "login_required", message: "log in to the console (or call with an agent token)" };
  // a path-limited token (the seats' team-gmail MCP token) reaches its paths only.
  if (identity.kind === "token" && identity.paths && !identity.paths.includes(path))
    return { allow: false, status: 403, reason: "token_scope", message: `this token reaches ${identity.paths.join(", ")} only` };
  const owner = ownerOfPath(db, path);
  if (owner !== undefined && owner !== identity.tenant)
    return { allow: false, status: 404, reason: "cross_tenant", message: `no route or id ${path} in this world` };
  // a door session into the home world (customer site) is judged like a customer world's, and more: only DOOR_SAFE.
  const door = identity.kind === "session" && !!identity.door;
  const doorOnly = door && isDoorOnly(method, path);
  if (door && path.startsWith("/api/") && !doorOnly && !(isTenantSafe(method, path) && isDoorSafe(method, path)))
    return { allow: false, status: 403, reason: "platform_private", message: "the platform is managed from the private console" };
  if (
    !doorOnly &&
    (identity.tenant !== DEFAULT_TENANT || door) &&
    path.startsWith("/api/") &&
    !isTenantSafe(method, path) &&
    !(matches(OWNER_WORLD_READS, method === "HEAD" ? "GET" : method, path) && isOwnersOwnWorld(db, identity))
  )
    return { allow: false, status: 403, reason: "world_scope", message: "this part of the console is not available in this world yet" };
  // owner powers need an owner login or the host owner token; never bare legacy trust or an agent token.
  if (isOwnerOnly(method, path) && !ownerPowerFor(identity, method, path))
    return {
      allow: false,
      status: 403,
      reason: "owner_only",
      message: "owner only: log in as the world's owner (the console host sends its host owner token); legacy trust and agent tokens cannot do this",
    };
  return { allow: true };
}
