import { useEffect, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PHONE_TAP } from "@/components/common";
import { cn } from "@/lib/utils";
import { useCallTab } from "@/voice/CallProvider";
import { useNoteTab } from "@/voice/NoteProvider";

/**
 * his installed app had been open
 * for days and still ran the JavaScript from before two deploys. An open page now notices a newer build and picks it up.
 *
 * Detect: when the page comes back (visible again, or the window gets focus) and every 5 minutes while it is visible, it asks
 * for the app page (index.html, never from a cache) and compares its entry script (/assets/index-<hash>.js) with the one this
 * page loaded. No server change: the hash is the build. A failed fetch, a login page or anything without an entry is ignored.
 * Act: a newer build reloads the page when it comes back, if nothing would be lost (no typed words in a box, no file waiting
 * to be sent, no voice note or call on). The 5-minute check reloads too, under the same rule, once nobody has touched the
 * page for IDLE_MS (an app left open on screen; never under a click or a scroll). Otherwise one small bar says "A new
 * version is live." with a Reload button.
 * Never in dev (production builds only). Never a loop: a build is reloaded for at most once per tab (sessionStorage).
 */
export const CHECK_EVERY_MS = 5 * 60_000;
/** Focus events come often (a click back into the window): one check per this long. */
export const FOCUS_GAP_MS = 30_000;
/** The 5-minute check reloads a visible page only after this long with no key, click, touch or scroll. */
export const IDLE_MS = 2 * 60_000;
export const RELOADED_KEY = "console-build-reloaded";
/**
 * a build check not answered in this long is given up: his phone off its network kept the one check
 * in flight for good, so the page never saw the new build and ran the old app for hours after the fix was live.
 */
export const CHECK_TIMEOUT_MS = 10_000;

const ENTRY = /<script\b[^>]*\bsrc="([^"]*\/assets\/index-[^"]+?\.js(?:\?[^"]*)?)"/i;

/** The entry script an index.html names (its path only), or undefined (a login page, an error page). */
export function entryOf(html: string): string | undefined {
  const m = ENTRY.exec(html);
  if (!m) return undefined;
  try {
    return new URL(m[1], "http://x").pathname;
  } catch {
    return undefined;
  }
}

/** The entry script this page runs. */
export function loadedEntry(doc: Document = document): string | undefined {
  for (const s of Array.from(doc.querySelectorAll<HTMLScriptElement>("script[src]"))) {
    const src = s.getAttribute("src") ?? "";
    if (/\/assets\/index-[^/]+\.js/.test(src)) return entryOf(`<script src="${src}">`);
  }
  return undefined;
}

const TEXT_INPUT = /^(text|search|email|url|tel|number|password|)$/;

/** Words or files the user has put in and not sent: a reload would lose them. */
export function hasUnsent(doc: Document = document): boolean {
  // a box that keeps its own words across a reload (the chat's draft lives in sessionStorage) loses nothing: a typed but
  // unsent chat line no longer keeps the whole app on an old build
  const kept = (e: Element) => !!e.closest("[data-draft-kept]");
  for (const t of Array.from(doc.querySelectorAll("textarea"))) if (t.value.trim() && !kept(t)) return true;
  for (const i of Array.from(doc.querySelectorAll("input"))) if (TEXT_INPUT.test(i.type) && !i.readOnly && i.value.trim()) return true;
  for (const e of Array.from(doc.querySelectorAll<HTMLElement>("[contenteditable='true'], [contenteditable='']"))) if (e.textContent?.trim()) return true;
  return !!doc.querySelector("[data-testid='chat-attach-item']");
}

export interface BuildWatchDeps {
  fetch: typeof fetch;
  doc: Document;
  win: Window;
  storage?: Pick<Storage, "getItem" | "setItem">;
  reload: () => void;
  /** A voice note or call is on (the tab's). */
  busy: () => boolean;
  now?: () => number;
}

/** The watcher: one per tab. `onNewer` tells the bar a newer build waits (undefined: none). */
export class BuildWatch {
  private loaded: string | undefined;
  private newer: string | undefined;
  private lastFocus = -Infinity;
  private lastInput = -Infinity;
  private inflight?: Promise<void>;
  private listeners = new Set<(n: string | undefined) => void>();

  constructor(private d: BuildWatchDeps) {
    this.loaded = loadedEntry(d.doc);
  }

  get current() {
    return this.loaded;
  }
  get pending() {
    return this.newer;
  }

  subscribe(fn: (n: string | undefined) => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /** Ask the server for the app page; a newer entry is remembered. Failures and odd answers are ignored. */
  check(): Promise<void> {
    if (!this.loaded) return Promise.resolve();
    this.inflight ??= (async () => {
      try {
        const signal = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(CHECK_TIMEOUT_MS) : undefined;
        const r = await this.d.fetch("/", { cache: "no-store", credentials: "same-origin", headers: { Accept: "text/html" }, ...(signal ? { signal } : {}) });
        if (!r.ok || r.redirected) return;
        const e = entryOf(await r.text());
        if (e && e !== this.loaded && e !== this.newer) {
          this.newer = e;
          for (const l of this.listeners) l(e);
        }
      } catch {
        /* offline, a proxy page: try again later */
      } finally {
        this.inflight = undefined;
      }
    })();
    return this.inflight;
  }

  /** Nothing would be lost by a reload now. */
  safe(): boolean {
    return !this.d.busy() && !hasUnsent(this.d.doc);
  }

  private reloadedFor(): string | null {
    try {
      return this.d.storage?.getItem(RELOADED_KEY) ?? null;
    } catch {
      return null;
    }
  }

  /** Reload for the newer build if it is safe and this tab has not reloaded for it already. True: reloading. */
  tryReload(): boolean {
    const n = this.newer;
    if (!n || this.d.doc.visibilityState !== "visible" || !this.safe() || this.reloadedFor() === n) return false;
    try {
      this.d.storage?.setItem(RELOADED_KEY, n);
    } catch {
      return false; // no way to remember it: never risk a loop
    }
    this.d.reload();
    return true;
  }

  /** The page came back (visible, or focus): check, then reload if a newer build waits and nothing would be lost. */
  async back(kind: "visible" | "focus"): Promise<void> {
    const now = (this.d.now ?? Date.now)();
    if (kind === "focus" && now - this.lastFocus < FOCUS_GAP_MS) return;
    this.lastFocus = now;
    await this.check();
    this.tryReload();
  }

  /**
   * his Refresh press: look for a newer build now and, if one is live, move onto it at once (asked for by hand, so not
   * held by the once-per-tab rule; still never under a voice note or call). True: reloading.
   */
  async refreshNow(): Promise<boolean> {
    await this.check();
    const n = this.newer;
    if (!n || this.d.busy()) return false;
    try {
      this.d.storage?.setItem(RELOADED_KEY, n);
    } catch {
      /* storage off: a by-hand press cannot loop */
    }
    this.d.reload();
    return true;
  }

  /** The user touched the page (a key, click, touch or scroll). */
  input(): void {
    this.lastInput = (this.d.now ?? Date.now)();
  }

  /** The 5-minute check: look for a newer build; reload if nobody has touched the page for IDLE_MS and nothing would be lost. */
  async tick(): Promise<void> {
    if (this.d.doc.visibilityState !== "visible") return;
    await this.check();
    if ((this.d.now ?? Date.now)() - this.lastInput >= IDLE_MS) this.tryReload();
  }

  /** Hook the page's events and the 5-minute check; returns the unhook. */
  start(): () => void {
    const { doc, win } = this.d;
    const seen = () => {
      if (doc.visibilityState === "visible") void this.back("visible");
    };
    const focus = () => void this.back("focus");
    const input = () => this.input();
    const INPUTS = ["keydown", "pointerdown", "touchstart", "wheel", "scroll"] as const;
    // back from the back-forward cache or back online (his phone's network came back): check at once
    const back = () => void this.back("visible");
    doc.addEventListener("visibilitychange", seen);
    win.addEventListener("focus", focus);
    win.addEventListener("pageshow", back);
    win.addEventListener("online", back);
    for (const e of INPUTS) win.addEventListener(e, input, { passive: true, capture: true });
    const t = win.setInterval(() => void this.tick(), CHECK_EVERY_MS);
    return () => {
      doc.removeEventListener("visibilitychange", seen);
      win.removeEventListener("focus", focus);
      win.removeEventListener("pageshow", back);
      win.removeEventListener("online", back);
      for (const e of INPUTS) win.removeEventListener(e, input, { capture: true });
      win.clearInterval(t);
    };
  }
}

const sessionStore = (): Storage | undefined => {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
};

/** the app's one build watch (set by NewBuild), so a page's Refresh can move onto a newer build. */
let appWatch: BuildWatch | undefined;
/**
 * a by-hand Refresh: ask the service worker to look for a new version, and reload onto a newer build when one is live.
 * True: the page is reloading (the caller need not read again).
 */
export async function refreshApp(): Promise<boolean> {
  try {
    const reg = typeof navigator !== "undefined" ? await navigator.serviceWorker?.getRegistration?.("/") : undefined;
    void reg?.update().catch(() => undefined);
  } catch {
    /* no worker */
  }
  return appWatch ? appWatch.refreshNow() : false;
}

/** In the app (inside the call and note owners): watches for a newer build; shows the Reload bar when it cannot reload itself. */
export function NewBuild(props: { enabled?: boolean; deps?: Partial<BuildWatchDeps> }) {
  const enabled = props.enabled ?? import.meta.env.PROD;
  const notes = useNoteTab();
  const calls = useCallTab();
  const [watch] = useState(() =>
    enabled
      ? new BuildWatch({
          fetch: (...a) => fetch(...a),
          doc: document,
          win: window,
          storage: sessionStore(),
          reload: () => window.location.reload(),
          busy: () => notes.busy() || calls.busy(),
          ...props.deps,
        })
      : undefined,
  );
  const [newer, setNewer] = useState<string>();
  const [hidden, setHidden] = useState<string>();
  useEffect(() => {
    if (!watch) return;
    appWatch = watch;
    const off = watch.subscribe(setNewer);
    const unhook = watch.start();
    return () => {
      off();
      unhook();
      if (appWatch === watch) appWatch = undefined;
    };
  }, [watch]);
  if (!newer || hidden === newer) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-[max(0.5rem,env(safe-area-inset-top))] z-50 flex justify-center px-3" data-testid="new-build">
      <div role="status" aria-live="polite" className="pointer-events-auto flex items-center gap-2 rounded-full border bg-background/95 py-1 pl-3 pr-1 text-sm shadow-md backdrop-blur">
        <span>A new version is live.</span>
        <Button
          type="button"
          size="sm"
          className={cn(PHONE_TAP, "h-7 gap-1 rounded-full")}
          data-testid="new-build-reload"
          onClick={() => {
            try {
              sessionStore()?.setItem(RELOADED_KEY, newer);
            } catch {
              /* storage off */
            }
            (props.deps?.reload ?? (() => window.location.reload()))();
          }}
        >
          <RefreshCw className="size-3.5" /> Reload
        </Button>
        <Button type="button" size="sm" variant="ghost" className={cn(PHONE_TAP, "h-7 w-7 rounded-full p-0 max-sm:min-w-11")} aria-label="Hide" data-testid="new-build-hide" onClick={() => setHidden(newer)}>
          <X className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
