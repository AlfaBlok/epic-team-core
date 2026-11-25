import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { installedApp } from "@/components/backArrow";
import { installInPlaceLinks } from "@/lib/inPlaceLinks";
import { noteEngineCode } from "@/voice/voiceCode";

/**
 * The app's one link rule (lib/inPlaceLinks): an app screen opens in the app (the installed app: in place, so Back returns
 * to the card), every other page opens a new window, in the installed app and in a browser tab alike.
 * The recorder's code is fetched once the app is idle, so a note started later (after a link, a release, a
 * flaky connection) never waits on or fails to fetch it.
 */
export function InPlaceLinks({ installed = installedApp }: { installed?: () => boolean }) {
  const navigate = useNavigate();
  const nav = useRef(navigate);
  nav.current = navigate;
  useEffect(() => installInPlaceLinks((to) => nav.current(to), { installed: installed() }), [installed]);
  useEffect(() => {
    const w = window as Window & { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number };
    const fetchCode = () => void Promise.resolve(noteEngineCode()).catch(() => undefined);
    const t = setTimeout(() => (w.requestIdleCallback ? w.requestIdleCallback(fetchCode, { timeout: 10000 }) : fetchCode()), 4000);
    return () => clearTimeout(t);
  }, []);
  return null;
}
