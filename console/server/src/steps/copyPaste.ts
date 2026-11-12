import { ownerName } from "../identity.js";
/**
 * the team never hands the owner terminal lines to copy. A step that needs commands on his Mac is
 * a Mac-agent ticket (scripts/laptop_ticket.py: bootstrap TEXT for a new session of the Claude app, which runs them and asks
 * his OK); a command that truly must stay manual says in large words where it runs and was tested in zsh and bash.
 *
 * This finds what breaks that rule in a steps page (HTML) or an ask or card (text): a command block meant for the owner.
 * A block is allowed when it is for the agent (`data-for="agent"`), or when it names where it runs (`data-runs-on`) and
 * was tested in both shells (`data-tested-in="zsh and bash"`); in text, when the ask carries `runs on: …` and names zsh and bash.
 */

/** Command words that start a terminal line (after an optional prompt `$ ` / `% ` and `sudo`). */
const SHELL = new Set(
  (
    "curl wget brew npm npx pnpm yarn bun deno pip pip3 pipx uv uvx python python3 node git gh ssh scp rsync sftp cd export source " +
    "chmod chown mkdir rm cp mv cat echo printf ls open defaults launchctl security xcode-select softwareupdate docker kubectl " +
    "stripe vercel wrangler firebase gcloud aws az op bw claude codex sh bash zsh osascript pbcopy pbpaste tailscale systemctl " +
    "journalctl secret ln touch tar unzip openssl gpg ssh-keygen ssh-add kill pkill ps lsof xattr spctl plutil cargo make terraform " +
    "env set unset alias crontab mas nvm"
  ).split(" "),
);

export interface CopyPasteBlock {
  /** Where it was found: `pre`, `code`, `cmd` (an element whose class says command), `fence` or `inline` (text). */
  kind: string;
  /** Its first command line, cut to 120 characters. */
  line: string;
}

const unescape = (s: string) =>
  s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");

/** The first line of `text` that reads as a terminal command, else undefined. `inline`: a short code span needs an argument too. */
export function commandLine(text: string, inline = false): string | undefined {
  for (const raw of text.split(/\n|(?:\s+&&\s+)|;\s+/)) {
    const line = raw.trim().replace(/^(?:[$%❯>]\s+)/, "");
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    const words = line.split(/\s+/);
    let i = 0;
    while (i < words.length && /^[A-Z_][A-Z0-9_]*=\S*$/.test(words[i])) i++; // FOO=bar cmd …
    if (words[i] === "sudo") i++;
    const w = (words[i] ?? "").replace(/^\.\//, "");
    if (!SHELL.has(w)) continue;
    const rest = words.slice(i + 1);
    if (inline && !rest.length) continue;
    // a prose word that happens to be a command ("open the page", "set it up") reads on as English
    if (rest.length && /^(the|a|an|it|this|that|your|my|up|to|on|in|with|and|or|for|of)$/i.test(rest[0])) continue;
    return line.slice(0, 120);
  }
  return undefined;
}

const attr = (tag: string, name: string) => new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag)?.slice(2).find((x) => x !== undefined);

/** Allowed: for the agent, or it says where it runs and was tested in zsh and bash. */
function allowed(openTag: string): boolean {
  if ((attr(openTag, "data-for") ?? "").toLowerCase() === "agent") return true;
  const where = attr(openTag, "data-runs-on");
  const tested = (attr(openTag, "data-tested-in") ?? "").toLowerCase();
  return !!where?.trim() && /\bzsh\b/.test(tested) && /\bbash\b/.test(tested);
}

/** Copy-paste terminal blocks for the owner in a steps page's HTML. */
export function copyPasteInHtml(html: string): CopyPasteBlock[] {
  const out: CopyPasteBlock[] = [];
  let rest = html.replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<style\b[\s\S]*?<\/style>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  // an agent's part (a <details> or any element marked data-for="agent") is not for the owner
  rest = rest.replace(/<(details|div|section|pre|code)\b[^>]*\sdata-for\s*=\s*["']agent["'][^>]*>[\s\S]*?<\/\1>/gi, "");
  const scan = (re: RegExp, kind: string, inline = false) => {
    rest = rest.replace(re, (all: string, open: string, body: string) => {
      if (!allowed(open)) {
        const line = commandLine(unescape(body), inline);
        if (line) out.push({ kind, line });
      }
      return "";
    });
  };
  scan(/(<pre\b[^>]*>)([\s\S]*?)<\/pre>/gi, "pre");
  scan(/(<textarea\b[^>]*>)([\s\S]*?)<\/textarea>/gi, "pre");
  scan(/(<(?:div|p|span)\b[^>]*\sclass\s*=\s*["'][^"']*\b(?:cmd|command|terminal|shell)\b[^"']*["'][^>]*>)([\s\S]*?)<\/(?:div|p|span)>/gi, "cmd");
  scan(/(<code\b[^>]*>)([\s\S]*?)<\/code>/gi, "code", true);
  return out;
}

/** Copy-paste terminal steps for the owner in an ask's or a card's text (markdown: fences and inline code). */
export function copyPasteInText(text: string): CopyPasteBlock[] {
  const out: CopyPasteBlock[] = [];
  // an ask that says where its one command runs and that it was tested in both shells keeps it (L-54's last resort)
  if (/\bruns on\s*:/i.test(text) && /\bzsh\b/i.test(text) && /\bbash\b/i.test(text)) return out;
  let rest = text.replace(/```[^\n]*\n([\s\S]*?)```/g, (_a, body: string) => {
    const line = commandLine(body);
    if (line) out.push({ kind: "fence", line });
    return "";
  });
  rest.replace(/`([^`\n]+)`/g, (_a, body: string) => {
    const line = commandLine(body, true);
    if (line) out.push({ kind: "inline", line });
    return "";
  });
  return out;
}

/** The refusal's words: what was found and what to do instead (plain, for the agent that made it). */
export function copyPasteProblem(found: CopyPasteBlock[]): string | undefined {
  if (!found.length) return undefined;
  const list = found.slice(0, 3).map((f) => `"${f.line}"`).join(", ");
  return (
    `it hands ${ownerName()} terminal lines to copy (${list}${found.length > 3 ? ` and ${found.length - 3} more` : ""}): never do that (root L-54). ` +
    "Make it a Mac-agent ticket (scripts/laptop_ticket.py: bootstrap text he pastes into a new session of the Claude app, which runs the commands and asks his OK), " +
    "or run it yourself on the server. A command that truly must stay his says where in large words (`data-runs-on=\"On your Mac, in the Terminal app\"`) and was tested in zsh and bash (`data-tested-in=\"zsh and bash\"`)."
  );
}
