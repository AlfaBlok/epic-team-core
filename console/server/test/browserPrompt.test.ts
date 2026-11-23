import { describe, expect, it } from "vitest";
import { askGateProblem, browserPromptFault, browserPromptProblem, isBrowserTask, BROWSER_PROMPT_FROM } from "../src/inbox/askGate.js";
import { parseAsks } from "../src/inbox/asks.js";
import { askLine } from "../src/inbox/raise.js";

/**
 * (his voice note vn_e166481b on TAX-A20, the GoDaddy receipt, 23 Nov: "can this type of task, which can be done via
 * Claude with the extension, come with a prompt that I can paste?"): a `do` ask whose step happens in his own signed-in
 * browser says so and carries one plain prompt for Claude in Chrome, or is a Mac agent ticket; the gate holds one without.
 */
const GODADDY =
  "You do: download one GoDaddy receipt (order 4176093069) as a PDF. Why: it is the last invoice missing from Alpha's books. — " +
  "context: GoDaddy's receipt opens only after your sign-in — why Sam: the GoDaddy sign-in lives in your Chrome; the Team Browser has no GoDaddy session — " +
  "steps: 1. open https://account.godaddy.com/receipts/view/4176093069 and sign in; 2. save it as a PDF — about: GoDaddy receipt for Alpha's books";
const PROMPT =
  "Open https://account.godaddy.com/receipts/view/4176093069 in this browser, where I am signed in to GoDaddy. Save the receipt as a PDF and email it to me with the subject Alpha GoDaddy receipt 4176093069.";
const line = (extra = "", since = BROWSER_PROMPT_FROM) => `## Waiting on\n- [ask TAX-A30: do @Sam since ${since} row TAX-S8] ${GODADDY}${extra}`;

describe("a browser step carries a prompt for Claude in Chrome", () => {
  it("reads `browser:` off the ask line whole, links kept", () => {
    const [a] = parseAsks(line(` — browser: Open [the receipt](https://account.godaddy.com/receipts/view/4176093069) in this browser, where I am signed in, save it as a PDF and email it to me.`));
    expect(a.browser).toBe("Open the receipt https://account.godaddy.com/receipts/view/4176093069 in this browser, where I am signed in, save it as a PDF and email it to me.");
    expect(a.question).not.toMatch(/browser:/);
  });

  it("holds a signed-in browser step with no prompt, and names the fix and his words", () => {
    const [a] = parseAsks(line());
    expect(isBrowserTask(a)).toBe(true);
    const p = askGateProblem(a);
    expect(p).toMatch(/no prompt for Claude in Chrome/);
    expect(p).toMatch(/browser:/);
    expect(p).toMatch(/needs Mac agent/);
    expect(p).toMatch(/vn_e166481b/);
  });

  it("lets it through with a plain prompt, or as a Mac agent ticket", () => {
    expect(askGateProblem(parseAsks(line(` — browser: ${PROMPT}`))[0])).toBeUndefined();
    expect(browserPromptProblem(parseAsks(line(" — label: needs Mac agent"))[0])).toBeUndefined();
  });

  it("leaves asks raised before the rule, answered asks and non-browser asks alone", () => {
    expect(browserPromptProblem(parseAsks(line("", "2026-11-23"))[0])).toBeUndefined();
    expect(browserPromptProblem({ ask: "do", question: "Plug the camera into the Mac at the office.", since: BROWSER_PROMPT_FROM })).toBeUndefined();
    expect(browserPromptProblem({ ask: "decide", question: "Sign in to https://x.com and pick a handle?", since: BROWSER_PROMPT_FROM })).toBeUndefined();
    expect(browserPromptProblem({ ...parseAsks(line())[0], state: "answered" })).toBeUndefined();
    // a sign-in for the Team Browser itself has its own Sync card
    expect(browserPromptProblem({ ask: "do", question: "Sign in to https://x.com in the Team Browser, it says signed out.", since: BROWSER_PROMPT_FROM })).toBeUndefined();
  });

  it("holds a prompt that is too short, has no page, holds a terminal line or a secret", () => {
    expect(browserPromptFault("Get the receipt.")).toMatch(/too short/);
    expect(browserPromptFault("Open my GoDaddy account where I am signed in and save the last receipt as a PDF for me.")).toMatch(/no page/);
    expect(browserPromptFault(`${PROMPT} Then run git add receipt.pdf and push it.`)).toBeUndefined(); // words about git, not a command line
    expect(browserPromptFault(`${PROMPT} Then: curl -O https://example.com/r.pdf`)).toMatch(/terminal line/);
    expect(browserPromptFault(`${PROMPT} Use \`python3 save.py\` after.`)).toMatch(/terminal line/);
    expect(browserPromptFault(`${PROMPT} If asked, password: hunter2xyz`)).toMatch(/secret/);
    expect(browserPromptFault(`${PROMPT} The key is sk-ant-abcdefghijklmnop1234.`)).toMatch(/secret/);
    expect(browserPromptFault(PROMPT)).toBeUndefined();
  });

  it("the console's own raise writes the prompt as one field, and the API gate reads it", () => {
    const l = askLine("X-A1", { question: GODADDY.replace(/ — about:.*$/, ""), askedBy: "a persona", kind: "do", browser: `${PROMPT} — then tell me it is done.` }, "2000-01-01");
    expect(l).toMatch(/— browser: Open https:\/\/account\.godaddy\.com\/receipts\/view\/4176093069.*[,-] then tell me it is done\./);
    const [a] = parseAsks(`## Waiting on\n${l}`).map(({ since: _s, ...x }) => x);
    expect(a.browser).toMatch(/then tell me it is done/);
    expect(browserPromptProblem(a)).toBeUndefined();
    const [b] = parseAsks(`## Waiting on\n${askLine("X-A1", { question: GODADDY.replace(/ — about:.*$/, ""), askedBy: "a persona", kind: "do" }, "2000-01-01")}`).map(({ since: _s, ...x }) => x);
    expect(browserPromptProblem(b)).toMatch(/no prompt for Claude in Chrome/);
  });
});

describe("a skill that does not know `browser:` yet", () => {
  it("takes the prompt off the field it glued it to", async () => {
    const { fromSpinesEntry, unglueBrowser } = await import("../src/inbox/asks.js");
    const a = unglueBrowser(fromSpinesEntry({ code: "TAX-A30", ask: "do", question: "download it", steps: `1. open the receipt — browser: ${PROMPT}` })!);
    expect(a.steps).toBe("1. open the receipt");
    expect(a.browser).toBe(PROMPT);
  });
});
