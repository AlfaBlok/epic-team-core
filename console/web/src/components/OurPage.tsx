import { useNavigate, useSearchParams } from "react-router-dom";
import { linkKind, ourPagePath } from "@/lib/inPlaceLinks";

/**
 * A page of ours the app does not draw (a steps page, a landing page, a file), shown inside the installed app on its own
 * screen (the owner 25 Nov 14:57Z, vn_982a8bd6: a link "opens a brand new instance of the app ... the back button does not
 * work"). Opening it with window.open made Android start a second copy of the app (the URL is in the app's scope); loading
 * it in the app's window ended a voice note. Here it is a screen like any other: the app's Back returns to the card, a note
 * being recorded goes on, nothing reloads.
 *
 *   card ──tap──▶ /open?u=/steps/view/abc  (this screen: the page in a frame, the app's top bar and Back above it)
 *                     │ a link inside the page: an app screen → the router; another page of ours → this screen;
 *                     ▼ another site → a new window (out of the app's scope, so the phone shows it over the app)
 */
export function OurPage() {
  const [q] = useSearchParams();
  const navigate = useNavigate();
  const u = q.get("u") ?? "";
  // only a page of ours: a path on this origin the app does not draw (never another site, never javascript:)
  const ok = u.startsWith("/") && !u.startsWith("//") && linkKind(u) === "page";
  if (!ok)
    return (
      <p className="p-6 text-sm text-muted-foreground" data-testid="our-page-refused">
        This address is not a page of ours.
      </p>
    );
  const hook = (f: HTMLIFrameElement) => {
    let doc: Document | null = null;
    try {
      doc = f.contentDocument;
    } catch {
      return; // not ours after all: leave it alone
    }
    if (!doc || (doc as Document & { __ourPageHooked?: boolean }).__ourPageHooked) return;
    (doc as Document & { __ourPageHooked?: boolean }).__ourPageHooked = true;
    doc.addEventListener(
      "click",
      (e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
        if (!a || a.hasAttribute("download") || (a.getAttribute("href") ?? "").startsWith("#")) return;
        const kind = linkKind(a.href, window.location.origin);
        if (!kind) return;
        e.preventDefault();
        const to = new URL(a.href, window.location.origin);
        if (kind === "route") navigate(to.pathname + to.search + to.hash);
        else if (kind === "page") navigate(ourPagePath(to.pathname + to.search + to.hash));
        else window.open(to.href, "_blank", "noopener");
      },
      true,
    );
  };
  return (
    <iframe
      key={u}
      src={u}
      title="Page"
      data-testid="our-page"
      className="block h-[calc(100dvh-7.5rem)] w-full border-0 bg-white md:h-[calc(100dvh-4.5rem)]"
      onLoad={(e) => hook(e.currentTarget)}
    />
  );
}
