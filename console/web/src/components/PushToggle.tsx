import { useCallback, useEffect, useState } from "react";
import { Bell, BellRing, Loader2 } from "lucide-react";
import { api, type PushInfo } from "@/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useSkin } from "@/lib/skin";

/**
 * phone notifications from the installed app. One tap on "Turn on notifications" asks the phone, subscribes this
 * device and hands the subscription to the console (stored per login); afterwards a small bell says they are on and sends a
 * test to this device only. iPhone: only from the installed app (Add to Home Screen, iOS 16.4+), so Safari gets a hint.
 * Shows nothing where it cannot work (no service worker, another world's login, no key on the console).
 */

/** how long a note ("Notifications are on.", "Test sent…") stays before it goes. */
export const PUSH_NOTE_MS = 5_000;

type State =
  | { kind: "hidden" }
  | { kind: "install" }
  | { kind: "blocked" }
  | { kind: "off"; info: PushInfo }
  | { kind: "on"; info: PushInfo; endpoint: string };

const supported = () => typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const isIos = () => typeof navigator !== "undefined" && /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = () =>
  typeof window !== "undefined" && (window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true);

export function keyBytes(b64url: string): Uint8Array {
  const b64 = (b64url + "=".repeat((4 - (b64url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

const deviceName = () => {
  const ua = navigator.userAgent;
  const what = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : "browser";
  return `${what}${standalone() ? " app" : ""}`;
};

export function usePushToggle() {
  const social = useSkin().id === "social"; // a world's desk: the team's notifications are the owner's world's only
  const [state, setState] = useState<State>({ kind: "hidden" });
  const [busy, setBusy] = useState<string>();
  const [note, setNote] = useState<string>();

  const check = useCallback(async () => {
    try {
      if (social || (!supported() && !(isIos() && !standalone()))) return setState({ kind: "hidden" });
      const info = await api.getPush();
      if (!info.configured || !info.publicKey || !info.notifies) return setState({ kind: "hidden" });
      if (!supported()) return setState({ kind: "install" });
      const reg = await navigator.serviceWorker.register("/sw.js");
      const sub = await reg.pushManager.getSubscription();
      if (sub && info.endpoints.includes(sub.endpoint)) return setState({ kind: "on", info, endpoint: sub.endpoint });
      if (Notification.permission === "denied") return setState({ kind: "blocked" });
      setState({ kind: "off", info });
    } catch {
      setState({ kind: "hidden" });
    }
  }, [social]);
  useEffect(() => void check(), [check]);
  // a note shows once, then goes
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(undefined), PUSH_NOTE_MS);
    return () => clearTimeout(t);
  }, [note]);

  const turnOn = useCallback(async () => {
    if (state.kind !== "off") return;
    setBusy("Turning on…");
    setNote(undefined);
    try {
      // iOS asks only from a tap: the permission prompt comes first, before any other wait.
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setState({ kind: perm === "denied" ? "blocked" : "off", ...(perm === "denied" ? {} : { info: state.info }) } as State);
        setNote(perm === "denied" ? undefined : "Notifications were not allowed.");
        return;
      }
      const reg = (await navigator.serviceWorker.getRegistration("/")) ?? (await navigator.serviceWorker.register("/sw.js"));
      await navigator.serviceWorker.ready;
      const old = await reg.pushManager.getSubscription();
      const sub = old ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(state.info.publicKey!) as BufferSource }));
      await api.subscribePush(sub.toJSON(), deviceName());
      setState({ kind: "on", info: { ...state.info, devices: state.info.devices + 1, endpoints: [...state.info.endpoints, sub.endpoint] }, endpoint: sub.endpoint });
      setNote("Notifications are on.");
    } catch (e) {
      setNote(`Could not turn them on: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(undefined);
    }
  }, [state]);

  const test = useCallback(async () => {
    if (state.kind !== "on") return;
    setBusy("Sending a test…");
    setNote(undefined);
    try {
      const r = await api.testPush(state.endpoint);
      setNote(r.ok ? "Test sent to this device." : `Test not sent: ${r.error ?? "unknown"}`);
    } catch (e) {
      setNote(`Test not sent: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(undefined);
    }
  }, [state]);

  /** The header's bell, once notifications are on (tap = a test to this device). */
  const bell =
    state.kind === "on" ? (
      <button
        type="button"
        onClick={() => void test()}
        disabled={!!busy}
        className="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent sm:size-9"
        title="Notifications are on. Tap to send a test to this device."
        aria-label="Notifications are on. Send a test to this device."
        data-testid="push-bell"
      >
        {busy ? <Loader2 className="h-[18px] w-[18px] animate-spin" /> : <BellRing className="h-[18px] w-[18px]" />}
      </button>
    ) : null;

  /** The one-line offer above the chat (off, blocked, or the install hint on an iPhone's Safari). */
  const banner =
    state.kind === "off" || state.kind === "blocked" || state.kind === "install" || note ? (
      <div className={cn("flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm")} data-testid="push-banner">
        {state.kind === "off" && (
          <>
            <Bell className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">Get a notification on this phone when the desk answers you or something waits on you.</span>
            <Button size="sm" onClick={() => void turnOn()} disabled={!!busy} data-testid="push-turn-on">
              {busy ? (
                <>
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" /> {busy}
                </>
              ) : (
                "Turn on notifications"
              )}
            </Button>
          </>
        )}
        {state.kind === "blocked" && <span>Notifications are blocked for this app. Allow them in the phone's Settings, Notifications, then open the app again.</span>}
        {state.kind === "install" && <span>For notifications on this iPhone, add the app to your Home Screen (Share, then Add to Home Screen) and open it from there.</span>}
        {note && <span className="w-full text-muted-foreground" data-testid="push-note">{note}</span>}
      </div>
    ) : null;

  return { state: state.kind, bell, banner };
}
