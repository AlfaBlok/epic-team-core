import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { FoldSection, useSectionOpen } from "@/components/homeSection";
import { memoryName } from "@/lib/identity";
import { GOAL_GRAPH_PATH, memoryPagePath } from "@/lib/routePaths";
export { GOAL_GRAPH_PATH, memoryPagePath };

/**
 * the repo pages under /landing/ (docs/landing/, built by build.py) open inside
 * the console, under a header that says which of his two memories each one shows, with a way back:
 * - the goal graph (/goal-graph): the team's work tree in the code repo repo, epics, rows and asks built towards goals;
 *   measures how his voice notes land there, one report per note with Wrong place taps;
 * - his the memory service memory (/memory-memory): his own durable memory, notes and pages by topic, not organised by goals; the page
 *   shows its root branches (read only).
 * Round 4 (the owner, vn_e3c358a1: "I'm confused about what this is … I don't understand what this is about."): the header
 * keeps only the way back (Team home, all voice notes); the tabs between the two memories and the deck link are gone, and
 * the report itself opens with one sentence saying what it is (docs/landing/build.py).
 * The page itself stays a repo file (L-45), served by the console's /landing/ route; a direct visit to a /landing/ page
 * redirects here (server landing.ts), so every old link opens inside the console.
 */
/** the memory page's console path: the memory service's name and "-memory" */

/** The /landing/ file a console path shows: /goal-graph → index, /goal-graph/notes/<id> → that report, /memory-memory → memory. */
export function landingFileOf(consolePath: string): string | undefined {
  const p = consolePath.replace(/\/+$/, "");
  if (p === `/${memoryPagePath()}`) return "/landing/memory/index.html";
  if (p === `/${GOAL_GRAPH_PATH}`) return "/landing/index.html";
  const m = p.match(new RegExp(`^/${GOAL_GRAPH_PATH}/notes/([\\w-]{1,80})$`));
  return m ? `/landing/notes/${m[1]}.html` : undefined;
}

/** The console path of a /landing/ page (the inverse of landingFileOf; undefined for a page the console does not frame). */
export function consolePathOf(landingPath: string): string | undefined {
  const p = landingPath.replace(/\/index\.html$/, "/");
  if (p === "/landing/" || p === "/landing") return `/${GOAL_GRAPH_PATH}`;
  if (p === "/landing/memory/") return `/${memoryPagePath()}`;
  const m = p.match(/^\/landing\/notes\/([\w-]{1,80})\.html$/);
  return m ? `/${GOAL_GRAPH_PATH}/notes/${m[1]}` : undefined;
}

type Which = "graph" | "memory";
const whichOf = (consolePath: string): Which => (consolePath.startsWith(`/${memoryPagePath()}`) ? "memory" : "graph");

export function GoalGraphPage() {
  const loc = useLocation();
  const navigate = useNavigate();
  const file = landingFileOf(loc.pathname);
  const which = whichOf(loc.pathname);
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number>();

  // The frame fills the screen below the header, so the report's own sticky bar (its green button) stays in view.
  useEffect(() => {
    const fit = () => {
      const top = frame.current?.getBoundingClientRect().top ?? 0;
      setHeight(Math.max(360, Math.floor(window.innerHeight - top - 8)));
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [file]);

  // A link inside the report: another framed page moves the console's own address (so Back and a shared link work); a page
  // elsewhere on the console opens in the console; another site opens in a new tab.
  const onLoad = () => {
    const win = frame.current?.contentWindow;
    if (!win) return;
    let doc: Document;
    try {
      doc = win.document;
    } catch {
      return;
    }
    const here = consolePathOf(win.location.pathname);
    if (here && here !== loc.pathname.replace(/\/+$/, "")) navigate(here + win.location.hash, { replace: true });
    doc.addEventListener("click", (ev) => {
      const a = (ev.target as Element | null)?.closest?.("a");
      if (!a || !a.href || ev.defaultPrevented || ev.metaKey || ev.ctrlKey) return;
      const url = new URL(a.href, win.location.href);
      if (url.origin !== window.location.origin) {
        ev.preventDefault();
        window.open(url.href, "_blank", "noopener");
        return;
      }
      if (url.pathname === win.location.pathname) return;
      const to = consolePathOf(url.pathname) ?? (url.pathname.startsWith("/landing/") ? undefined : url.pathname);
      if (!to) return;
      ev.preventDefault();
      navigate(to + url.hash);
    });
  };

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="goal-graph-page">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <Link to="/" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground" data-testid="goal-graph-back">
          <ArrowLeft className="h-4 w-4" />
          Team home
        </Link>
        {which === "graph" && loc.pathname.includes("/notes/") && (
          <Link to={`/${GOAL_GRAPH_PATH}`} className="text-muted-foreground hover:text-foreground" data-testid="goal-graph-all">
            All voice notes
          </Link>
        )}
      </div>
      {file ? (
        <iframe
          key={file}
          ref={frame}
          src={file + loc.hash}
          title={which === "memory" ? `Your ${memoryName()} memory` : "Where your voice notes went"}
          onLoad={onLoad}
          className="w-full rounded-lg border bg-[#F5F3EE]"
          style={{ height: height ?? 600 }}
          data-testid="goal-graph-frame"
        />
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="goal-graph-missing">
          No such page. <Link to={`/${GOAL_GRAPH_PATH}`} className="underline">See all voice notes</Link>.
        </p>
      )}
    </div>
  );
}

/** Team home: where to find the two pages, one line each saying which memory it is. */
export function GoalGraphLinks() {
  const [open, setOpen] = useSectionOpen("goal-graph-links", true);
  return (
    <FoldSection title="Your voice notes and your memory" count={2} testId="goal-graph-links" open={open} onToggle={setOpen}>
      <ul className="grid gap-2 sm:grid-cols-2">
        <li className="min-w-0 rounded-lg border bg-card px-3 py-2">
          <Link to={`/${GOAL_GRAPH_PATH}`} className="font-medium hover:underline" data-testid="home-goal-graph">
            Where your voice notes went
          </Link>
          <p className="text-sm text-muted-foreground">Each thing you said and the task it became, so you can catch what landed wrong.</p>
        </li>
        <li className="min-w-0 rounded-lg border bg-card px-3 py-2">
          <Link to={`/${memoryPagePath()}`} className="font-medium hover:underline" data-testid="home-memory-page">
            {memoryName()} memory: how your own memory is structured
          </Link>
          <p className="text-sm text-muted-foreground">Your notes and pages in {memoryName()}, by topic, not by goal. Read only here.</p>
        </li>
      </ul>
    </FoldSection>
  );
}
