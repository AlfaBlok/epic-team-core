import { Suspense, lazy, type ComponentType, type ReactNode } from "react";
import { Loading } from "@/components/common";

/**
 * The first download stays small: every screen but Home and the sidebar loads its own small script the first time it opens, so a cold open
 * downloads only what the first screen needs. `lazyPage(() => import("@/pages/Chat"), "ChatPage")` is a component that
 * shows Loading… (or `fallback`, e.g. null for a dialog) until its script is in.
 *
 * After a console release the old page's scripts are gone from the server: a page opened before it that now opens a
 * screen for the first time reloads once to the new build (reloadForNewBuild), never a blank screen.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyPage<M extends { [k in K]: ComponentType<any> }, K extends string>(load: () => Promise<M>, name: K, fallback: ReactNode = <Loading />): M[K] {
  const Inner = lazy(() =>
    load().then(
      (m) => ({ default: m[name] }),
      (err: unknown) => {
        if (reloadForNewBuild()) return new Promise<never>(() => undefined); // the reload takes over
        throw err;
      },
    ),
  );
  const Shown = Inner as unknown as ComponentType<object>;
  function LazyPage(props: object) {
    return (
      <Suspense fallback={fallback}>
        <Shown {...props} />
      </Suspense>
    );
  }
  LazyPage.displayName = `Lazy(${name})`;
  return LazyPage as M[K];
}

export const CHUNK_RELOADED_KEY = "console-chunk-reloaded";

/**
 * A screen's script failed to load: most often a release replaced the build this tab runs. Reload once per build (the
 * entry script names it), so a real outage shows the page's error instead of a reload loop. Returns whether it reloads.
 */
export function reloadForNewBuild(win: Window | undefined = typeof window === "undefined" ? undefined : window): boolean {
  if (!win) return false;
  const build = Array.from(win.document.querySelectorAll<HTMLScriptElement>("script[src]")).map((s) => s.getAttribute("src") ?? "").find((s) => /\/assets\/index-/.test(s)) ?? "dev";
  try {
    if (win.sessionStorage.getItem(CHUNK_RELOADED_KEY) === build) return false;
    win.sessionStorage.setItem(CHUNK_RELOADED_KEY, build);
  } catch {
    return false;
  }
  win.location.reload();
  return true;
}

/** Vite's own signal that a preloaded script failed (the same case): reload once instead of a half-loaded page. */
export function installChunkReload(win: Window = window) {
  win.addEventListener("vite:preloadError", (e) => {
    if (reloadForNewBuild(win)) e.preventDefault();
  });
}
