import { homeRepo, ownerName, socialProduct } from "../identity.js";
/**
 * the card fields every row that reaches review carries, with one good and one bad example.
 * Shared by the wake prompt (REVIEW_RULE) and the worker brief (cycle/prompts.ts ROW_CLOSE_RULE).
 */
export const CARD_FIELDS_RULE =
  `A row in \`review\` becomes ${ownerName()}'s card only when it passes the review gate (format: docs/review-cards.md in ${homeRepo()}): ` +
  "(1) its Next Action has `confirm: yes` (anything he cannot open and judge himself, like plumbing or a fix another card covers, closes `done (no confirm: <why>)` instead); " +
  "(2) a card file `docs/cards/<row>.md` in its repo holds the card fields as front matter: `row`, `title` (one complete sentence in the past tense, 20 words or fewer: what was made and what it is for), " +
  "`goal` (the task's goal, 20 words or fewer), `delivered` (2 to 4 lines, each `✓` or `✗` with the reason, 20 words or fewer each), `evidence` (the live thing or an evidence page, never GitHub, never a dry run), " +
  "`screenshot` (an image of the evidence in the repo), and when they apply `name` (a short task name for the tree), `after` (what the team does next), `next` (`start: <step>` / `park: <step>`), `completes: <Done-means id> | goal` (only when it finishes that); " +
  "(3) its epic has a `Goal sentence:` line and its root spine a `Project name:` line. Card text is plain words for a normal human: no `;`, `(`, `/` outside links, no row codes, file paths or the word approve. " +
  "One page, one card: rows that open the same page from the same unmerged branch are one deliverable and get one card; fold the others into it and close them `done (folded into <row>)`. " +
  "A row that fails never reaches him: it comes back to you as \"needs evidence\" or \"card needs rewriting\" and wakes the Delivery manager. " +
  "Good (the Notes connect card): title \"The Notes logo and a how to connect page were created for MCP and AI directory listings.\", goal \"Every directory gets a page and a logo to point at, so people can add Notes in one click.\", " +
  "delivered \"✓ [notes.example.com/connect](https://notes.example.com/connect) is live, with steps for Claude, ChatGPT, Cursor, VS Code and Gemini.\" and \"✓ The N logo exists in the sizes directories ask for.\", evidence https://notes.example.com/connect with its screenshot. " +
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
  `Hero journey: the same row names its journey in ${homeRepo()} docs/features/hero-journeys.json as \`planned\` (one entry: public title, steps, the rows, the live screen), so it is recorded as a short clip. ` +
  `Check: every wake runs ${homeRepo()} \`python3 scripts/feature_gap.py\`; each approved row it names gets its feature line, or, when a user sees nothing new (plumbing, a fix, research, a demo clip), a skip reason in ${homeRepo()} docs/features/not-features.json.`;

