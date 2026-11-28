import { homeRepo, ownerName, socialProduct, workerHost } from "../identity.js";
import { CARD_LIMITS as L } from "./card.js";
/**
 * the card fields every row that reaches review carries, with one good and one bad example.
 * Shared by the wake prompt (REVIEW_RULE) and the worker brief (cycle/prompts.ts ROW_CLOSE_RULE).
 */
export const CARD_FIELDS_RULE =
  `A row in \`review\` becomes ${ownerName()}'s card only when it passes the review gate (format: docs/review-cards.md in ${homeRepo()}): ` +
  "(1) its Next Action has `confirm: yes` (anything he cannot open and judge himself, like plumbing or a fix another card covers, closes `done (no confirm: <why>)` instead; a small sure change he will meet in use says `confirm: auto — <why>` and closes itself once its card is whole; a result he asked for, a list, shortlist or analysis, is always `confirm: yes`); " +
  `(2) a card file \`docs/cards/<row>.md\` in its repo holds the card fields as front matter, about half the words cards used to carry: \`row\`, \`title\` (one complete sentence in the past tense, ${L.title} words or fewer: what was made and what it is for), ` +
  `\`goal\` (the task's goal, ${L.goal} words or fewer), \`delivered\` (${L.deliveredMin} to ${L.deliveredMax} lines, each \`✓\` or \`✗\` with the reason, ${L.delivered} words or fewer each), ` +
  "`evidence` (the live thing or an evidence page, never GitHub, never a dry run, pointed at the one section, row or number to look at: on our own pages, the page hub's and the console's, a bare page link is held as \"point the link at the thing\", so add `#<id>` or `?focus=<id or words>`, which scrolls to it and highlights it), " +
  `\`look\` (one plain line under the link saying what to look at there, ${L.look} words or fewer, required with a link to our own pages), ` +
  "`screenshot` (an image of the evidence in the repo), `source` (where it came from, right under the title: his key words in quotes with their date and a link to the note or card, or who raised it and why, " + L.source + " words or fewer), `decision` (the one decision or ask for him: one plain question he answers, then the team's recommendation, " + L.decision + " words or fewer, the card ends with it; a card missing source or decision is held back as \"card needs rewriting\"), and when they apply `name` (a short task name for the tree), `after` (what the team does next), `next` (`start: <step>` / `park: <step>`), `completes: <Done-means id> | goal` (only when it finishes that and no other row of the goal is still open: else the gate sends the card back), `options` (only on a card that asks a decision: 2 to 4 buttons, each `<answer>: <what happens next>` like `Yes: plan it` and `No: park it`; a decision card never shows Mark complete, and one whose decision asks `Do we …?` gets those two by itself); " +
  "(3) its epic has a `Goal sentence:` line and its root spine a `Project name:` line. Card text is plain words for a normal human: no `;`, `(`, `/` outside links, no row codes, file paths or the word approve. " +
  "One page, one card: rows that open the same page from the same unmerged branch are one deliverable and get one card; fold the others into it and close them `done (folded into <row>)`. " +
  "A row that fails never reaches him: it comes back to you as \"needs evidence\" or \"card needs rewriting\" and wakes the Delivery manager. " +
  `Quality check (E948-S62): before his card shows, a check on ${workerHost()} sets ${ownerName()}'s own words (the row's quotes, the Decisions lines citing his notes) beside the result point by point and opens the evidence at 390 and 1280 px; a point you missed without a ✗ line saying so holds the card as "not what he asked", a squashed or text-first page as "failed the visual check" (fix the result, then run \`python3 scripts/card_qc.py --repo <checkout> --row <row> --commit\` on ${workerHost()}, or wait for its 15-minute timer); its laptop screen becomes the card's picture. ` +
  "Good (the Notes connect card): title \"A Notes logo and connect page were made for AI directory listings.\", goal \"Every directory can point people to Notes in one click.\", " +
  "delivered \"✓ [notes.example.com/connect](https://notes.example.com/connect) is live with steps for five AI tools.\" and \"✓ The N logo exists in every size directories ask for.\", evidence https://notes.example.com/connect with its screenshot. " +
  "Bad (never again): \"Cluster F (violation 8 + grey runs monitoring, desk_placement, ask_memory): Unblocker rubric settings and run-reported state into the repo\": codes, brackets, jargon, no verb, nothing he can open.";

/**
 * (the owner 2026-11-08: "learn to update feature list of service when we build something new successfully"):
 * the service's feature list (docs/features/epicteam.json for EpicTeam; epicspine.dev/team/ and /deck/all#features read it)
 * grows with every approved feature. In the worker's row-close rule and the wake's review rule.
 * and names its hero journey in the catalog (docs/features/hero-journeys.json) as planned.
 * the wake checks none is left out (the code repo scripts/feature_gap.py, skip reasons in docs/features/not-features.json).
 */
export const FEATURE_LIST_RULE =
  `Feature list: when ${ownerName()} closes a row done (approved) for something new a user can see, add it to the service's feature list in the same change or the next wake: ` +
  `one line in \`docs/features/<service>.json\` of the service's repo (EpicTeam: ${homeRepo()} docs/features/epicteam.json, ${socialProduct()}: ${homeRepo()} docs/features/${socialProduct().toLowerCase()}.json; public words in title and text, the rows that built it in \`rows\`), ` +
  "then run epicspine-skill `tools/feature_list.py` so epicspine.dev shows it too. A row whose card goes to review for such a feature drafts that line in the same change. " +
  `Hero journey: the same row names its journey in ${homeRepo()} docs/features/hero-journeys.json as \`planned\` (one entry: public title, steps, the rows, the live screen); planned makes no clip. ` +
  `Clips: a video or clip is made only when it carries one of the messages of a marketing plan ${ownerName()} approved, a message his approved campaign Plan still gives a video (the Plan lists posts and videos per message; ${homeRepo()} \`python3 scripts/plan_videos.py list\`), made by that campaign's Video Maker, or he asks for that video by name; its storyboard names which in \`why\` and the render tool refuses one without it. No other persona makes a promotional clip. Evidence for his review is a screenshot or a plain screen recording, never a branded clip. ` +
  `Check: every wake runs ${homeRepo()} \`python3 scripts/feature_gap.py\`; each approved row it names gets its feature line, or, when a user sees nothing new (plumbing, a fix, research, a demo clip), a skip reason in ${homeRepo()} docs/features/not-features.json.`;

