/**
 * The browser pieces that keep a
 * call or a recording going as long as the phone lets a web page:
 *
 * - A screen wake lock that comes back. The browser drops a wake lock whenever the page is hidden (lock, app switch) and never
 *   takes it again by itself, so after the first unlock the phone would lock on its own mid-call. This one asks again each
 *   time the page is back in view, until it is released.
 * - The media session of a call: the lock screen and the notification shade show "Call with the desk" with Hang up and Mute
 *   where the browser supports those actions (Chrome on Android), and the page counts as playing media.
 *
 * What no web page can do on an iPhone: keep the microphone while the phone is locked (iOS mutes a hidden page's microphone,
 * also from a home-screen app). The engines handle that by keeping what was said and picking up again on unlock.
 */

export interface LockSentinel {
  release(): Promise<void>;
}

/** The part of `document` these helpers use (tests fake it). */
export interface PageDoc {
  readonly hidden: boolean;
  addEventListener(type: "visibilitychange", fn: () => void): void;
  removeEventListener(type: "visibilitychange", fn: () => void): void;
}

const theDoc = (): PageDoc | undefined => (typeof document === "undefined" ? undefined : document);

/** The browser's screen wake lock request, or undefined where there is none (older iPhones before iOS 16.4). */
export function screenLockRequest(): (() => Promise<LockSentinel>) | undefined {
  const wl = typeof navigator === "undefined" ? undefined : (navigator as any).wakeLock;
  return wl?.request ? () => wl.request("screen") : undefined;
}

/**
 * Hold the screen awake until `release`, taking the lock again each time the page comes back into view. Resolves to
 * undefined where the browser has no wake lock (nothing to release).
 */
export async function stickyWakeLock(request: (() => Promise<LockSentinel>) | undefined = screenLockRequest(), doc: PageDoc | undefined = theDoc()): Promise<LockSentinel | undefined> {
  if (!request) return undefined;
  let current: LockSentinel | undefined = await request().catch(() => undefined);
  let released = false;
  const again = () => {
    if (released || doc?.hidden) return;
    const old = current;
    void request()
      .then((s) => {
        if (released) return void s.release().catch(() => undefined);
        current = s;
        void old?.release().catch(() => undefined);
      })
      .catch(() => undefined);
  };
  doc?.addEventListener("visibilitychange", again);
  return {
    async release() {
      released = true;
      doc?.removeEventListener("visibilitychange", again);
      await current?.release().catch(() => undefined);
      current = undefined;
    },
  };
}

export interface SessionHandlers {
  hangup(): void;
  toggleMute(): void;
}

/** The call's media session (lock screen, notification shade); returns the undo. Absent or partial support is fine. */
export function callMediaSession(h: SessionHandlers, title = "Call with the desk"): () => void {
  const ms = typeof navigator === "undefined" ? undefined : (navigator as any).mediaSession;
  if (!ms) return () => undefined;
  const set = (action: string, fn: (() => void) | null) => {
    try {
      ms.setActionHandler(action, fn);
    } catch {
      /* this browser has no such action */
    }
  };
  try {
    const MM = (globalThis as any).MediaMetadata;
    if (MM) ms.metadata = new MM({ title, artist: "Epic Team" });
    ms.playbackState = "playing";
  } catch {
    /* metadata unsupported */
  }
  set("hangup", () => h.hangup());
  set("togglemicrophone", () => h.toggleMute());
  return () => {
    set("hangup", null);
    set("togglemicrophone", null);
    try {
      ms.metadata = null;
      ms.playbackState = "none";
    } catch {
      /* unsupported */
    }
  };
}
