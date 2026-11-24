/**
 * the voice engines' code, fetched on first use and kept. Once fetched, a call or note starts in the same tick
 * as the tap (no wait on a second call or note); before, the stand-ins (lazyCall.ts, lazyNote.ts) wait for it.
 */
type CallCode = typeof import("./engine");
type NoteCode = typeof import("./noteEngine");
let call: CallCode | undefined;
let note: NoteCode | undefined;

export const callEngineCode = (): CallCode | Promise<CallCode> => call ?? import("./engine").then((m) => (call = m));
export const noteEngineCode = (): NoteCode | Promise<NoteCode> => note ?? import("./noteEngine").then((m) => (note = m));

/** a value that is here, or a promise of it */
export const isPromise = <T,>(x: T | Promise<T>): x is Promise<T> => typeof (x as { then?: unknown })?.then === "function";
