import { Component, type ErrorInfo, type ReactNode } from "react";
import { useLocation } from "react-router-dom";

/**
 * with no boundary, an exception while drawing any
 * page unmounted the whole app and left only the dark background, with nothing to say what happened. Now an error shows a
 * clear state (what broke, Reload) and the console log keeps the stack. `scope` = "page": the nav stays, only the page is
 * replaced, and opening another page clears it (`resetKey`); "app": everything, the last line of defence.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; scope: "page" | "app"; resetKey?: string }, { error?: Error; key?: string }> {
  state: { error?: Error; key?: string } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(props: { resetKey?: string }, state: { error?: Error; key?: string }) {
    // a page error is that page's: another page (resetKey) draws again
    if (state.key !== props.resetKey) return { key: props.resetKey, error: state.key === undefined ? state.error : undefined };
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`console ${this.props.scope} error:`, error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" data-testid={`error-boundary-${this.props.scope}`} className="mx-auto my-8 max-w-xl rounded-lg border border-destructive/50 bg-card p-4 text-sm text-card-foreground">
        <p className="font-medium">{this.props.scope === "app" ? "The console stopped drawing." : "This page stopped drawing."}</p>
        <p className="mt-1 text-muted-foreground">Nothing was lost: your chats and work are on the server. Reload to try again.</p>
        <p className="mt-2 break-words font-mono text-xs text-muted-foreground">{error.message || String(error)}</p>
        <button type="button" className="mt-3 rounded-md border px-3 py-1.5 hover:bg-accent" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}

/** one page's boundary, reset when the path changes. */
export function PageBoundary({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return (
    <ErrorBoundary scope="page" resetKey={pathname}>
      {children}
    </ErrorBoundary>
  );
}
