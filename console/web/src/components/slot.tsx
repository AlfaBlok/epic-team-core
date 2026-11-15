import { Children, createContext, isValidElement, useContext, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";

/**
 * The owner said "the inbox takes about 10 s and jumps". The Inbox's sections load on their own and
 * never jump. Every section fetches at once; a section shows only when it is in AND every section above it is shown,
 * so a section that grows never moves one already on screen. The next section to come holds its place with a shimmer
 * of the height it had last time in this browser (capped at one screen). Measured on production 20:52Z: the other
 * world's band landed at 3.7 s and pushed the inbox down 255 px; on a first visit the Blocked cards (2,400 px on a
 * phone) pushed the Review section that was already showing (CLS 0.43 to 0.80).
 */
const HEIGHT_STORE = "inbox.slot.h.";
/** a section that never says ready (an error path, an old component) shows anyway after this. */
export const SLOT_GIVE_UP_MS = 10_000;

const SlotReady = createContext<(() => void) | undefined>(undefined);

/** the section inside a Slot calls this with its loaded state; outside a Slot it does nothing. */
export function useSlotReady(ready: boolean) {
  const done = useContext(SlotReady);
  useEffect(() => {
    if (ready) done?.();
  }, [done, ready]);
}

export function rememberedHeight(name: string, fallback: number): number {
  try {
    const raw = window.localStorage.getItem(HEIGHT_STORE + name);
    const v = Number(raw);
    return raw !== null && Number.isFinite(v) && v >= 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

/** `ready`: a section with nothing to load (its place in the order only). */
type SlotProps = { name: string; fallback?: number; ready?: boolean; children: ReactNode };

/** one section's place (inside a SlotStack, or alone). */
export function Slot(p: SlotProps) {
  return <SlotStack>{p.children === undefined ? null : <SlotMarker {...p} />}</SlotStack>;
}
/** a Slot as a child of SlotStack (the stack reads its props). */
export function SlotMarker(_: SlotProps): ReactElement | null {
  return null;
}

/**
 * the sections in page order: each shows once it and all above it are in. The stack as a whole holds its last height
 * (one screen on a first visit) until every section is in, so what sits below it (a footer) never slides down.
 */
export function SlotStack({ children, name = "stack" }: { children: ReactNode; name?: string }) {
  const items = Children.toArray(children).filter((c): c is ReactElement<SlotProps> => isValidElement(c) && (c.type === SlotMarker || c.type === Slot));
  const [ready, setReady] = useState<Record<string, true>>({});
  const marks = useMemo(() => new Map<string, () => void>(), []);
  const markOf = (name: string) => {
    let m = marks.get(name);
    if (!m) marks.set(name, (m = () => setReady((r) => (r[name] ? r : { ...r, [name]: true }))));
    return m;
  };
  let above = true;
  const all = items.every((el) => ready[el.props.name]);
  const [held] = useState(() => rememberedHeight(name, typeof window === "undefined" ? 0 : window.innerHeight));
  const ref = useRemember(name, all);
  return (
    <div ref={ref} data-testid="inbox-stack" style={all || items.length < 2 ? undefined : { minHeight: held }}>
      {items.map((el) => {
        const { name } = el.props;
        const isReady = !!ready[name];
        const shown = above && isReady;
        const next = above && !isReady;
        above = shown;
        return <SlotView key={name} {...el.props} shown={shown} next={next} done={markOf(name)} />;
      })}
    </div>
  );
}

/** once shown, a box's height is remembered for the next open (up to one screen and a bit). */
function useRemember(name: string, shown: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!shown || !el || typeof ResizeObserver === "undefined") return;
    const save = () => {
      try {
        const cap = Math.round(window.innerHeight * 1.2);
        window.localStorage.setItem(HEIGHT_STORE + name, String(Math.min(cap, Math.round(el.getBoundingClientRect().height))));
      } catch {
        /* private mode: nothing remembered */
      }
    };
    save();
    const ro = new ResizeObserver(save);
    ro.observe(el);
    return () => ro.disconnect();
  }, [shown, name]);
  return ref;
}

function SlotView({ name, fallback = 0, ready, children, shown, next, done }: SlotProps & { shown: boolean; next: boolean; done: () => void }) {
  const [held] = useState(() => rememberedHeight(name, fallback));
  const ref = useRemember(name, shown);
  useEffect(() => {
    if (ready) done();
  }, [ready, done]);
  useEffect(() => {
    const t = setTimeout(done, SLOT_GIVE_UP_MS);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <SlotReady.Provider value={done}>
      <div data-testid="inbox-slot" data-slot={name} data-ready={shown ? "yes" : "no"} aria-busy={!shown || undefined}>
        {next && held > 0 && <div className="mb-6 animate-pulse rounded-lg bg-muted/50" style={{ height: held }} data-testid="slot-placeholder" aria-label="Loading" />}
        {/* mounted (it fetches and says when it is in) but out of sight until it shows. */}
        <div ref={ref} hidden={!shown}>
          {children}
        </div>
      </div>
    </SlotReady.Provider>
  );
}
