import { Children, createContext, isValidElement, useContext, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";

/**
 * The owner said "the inbox takes about 10 s and jumps". Every section fetches at once and the stack shows them all in
 * one frame once every one is in (SlotStack); before, sections showed top to bottom one by one, which he saw as the
 * page loading in steps. Measured on production 20:52Z: the other
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
 * the sections in page order, drawn all at once (the owner 18 Nov, vn_6fc46536: "The page needs to load up with everything
 * ... we cannot have the page look like it's loaded with only two sections and then sections kind of showing up as
 * they go"). Every section mounts at once and fetches; until every one of them is in, one skeleton shaped like the
 * sections holds the place (a bar per section, the height they had last time in this browser); then every section shows
 * in the same frame. A section that never says ready shows with the rest after SLOT_GIVE_UP_MS.
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
  const all = items.every((el) => ready[el.props.name]);
  // once drawn, a stack stays drawn: a section added later (a filter turned on) never hides the rest again
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    if (all) setDrawn(true);
  }, [all]);
  const shown = all || drawn;
  const [held] = useState(() => rememberedHeight(name, typeof window === "undefined" ? 0 : Math.round(window.innerHeight * 0.8)));
  const ref = useRemember(name, shown);
  return (
    <div ref={ref} data-testid="inbox-stack" data-ready={shown ? "yes" : "no"} aria-busy={!shown || undefined}>
      {!shown && items.length > 0 && <StackSkeleton count={items.length} height={held} />}
      {items.map((el) => (
        <SlotView key={el.props.name} {...el.props} shown={shown} isIn={!!ready[el.props.name]} next={false} done={markOf(el.props.name)} />
      ))}
    </div>
  );
}

/** the inbox while its sections load: one quiet bar per section (a header's height), nothing else, no text. */
function StackSkeleton({ count, height }: { count: number; height: number }) {
  return (
    <div data-testid="inbox-skeleton" aria-label="Loading" style={{ minHeight: height || undefined }}>
      {Array.from({ length: Math.min(count, 7) }, (_, i) => (
        <div key={i} className="mb-7 h-11 animate-pulse rounded-lg bg-muted/50" />
      ))}
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

function SlotView({ name, fallback = 0, ready, children, shown, isIn, next, done }: SlotProps & { shown: boolean; isIn?: boolean; next: boolean; done: () => void }) {
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
      <div data-testid="inbox-slot" data-slot={name} data-ready={shown ? "yes" : "no"} data-in={isIn ? "yes" : "no"} aria-busy={!shown || undefined}>
        {next && held > 0 && <div className="mb-6 animate-pulse rounded-lg bg-muted/50" style={{ height: held }} data-testid="slot-placeholder" aria-label="Loading" />}
        {/* mounted (it fetches and says when it is in) but out of sight until it shows. */}
        <div ref={ref} hidden={!shown}>
          {children}
        </div>
      </div>
    </SlotReady.Provider>
  );
}
