import path from "node:path";
import { currentPress, noteWriteSteps, outsideTally, type EditInput, type SpineWrite, type SpineWriter } from "./spineWrite.js";

/**
 * press writes that land close together share one commit
 * and one push. About 6 s of every press was the repo's commit checks (gitleaks alone starts in 1.3 s on the main server), the push
 * (2-3.5 s) and the fetch (1.2 s), paid once per press, one press after another.
 *
 * An edit marked `group: true` (the review buttons, goal Reopen, an ask's Snooze) waits up to `lingerMs` for other grouped
 * edits to the same checkout, then all of them go to the writer's `edits` as one batch: the guards and the fetch once,
 * each edit applied in order, the hooks once, one push (rebased on a push race as before), and every press gets that
 * commit. Edits that arrive while a batch is being written wait for it and go together in the next one, so a burst of
 * presses costs one write more than a single press, not one per press. Everything else (and a writer with no `edits`)
 * passes straight through. What a press guarantees is unchanged: it lands with a commit or keeps its reason, presses on
 * one card land in the order pressed (the press worker never runs two of one card at once), and a refused commit
 * writes the edits one by one so one press never sinks another.
 */
export const GROUP_LINGER_MS = 120;
/** At most this many edits in one commit (the rest go in the next batch, straight after). */
export const GROUP_MAX = 20;

interface Waiting {
  o: EditInput;
  asked: number;
  /** When its batch began to be written (the wait before it is the press's `lock` step). */
  started?: number;
  done: (w: SpineWrite) => void;
}

export interface GroupedWriter extends SpineWriter {
  /** Batches written since start and the edits they carried (for the press log line and /api/write-health). */
  batches(): { batches: number; edits: number; largest: number };
}

export function groupEdits(inner: SpineWriter, o: { lingerMs?: number; max?: number; log?: (m: string) => void } = {}): GroupedWriter {
  const linger = o.lingerMs ?? GROUP_LINGER_MS;
  const max = o.max ?? GROUP_MAX;
  const queues = new Map<string, { items: Waiting[]; timer?: ReturnType<typeof setTimeout>; running: boolean }>();
  const stats = { batches: 0, edits: 0, largest: 0 };

  async function flush(key: string): Promise<void> {
    const q = queues.get(key);
    if (!q) return;
    q.timer = undefined;
    if (q.running || !q.items.length) return;
    q.running = true;
    const batch = q.items.splice(0, max);
    const started = Date.now();
    for (const b of batch) b.started = started;
    try {
      // the batch is written for several requests: its steps go to each press below, not to whichever one started it
      const ws = await outsideTally(() =>
        batch.length === 1 || !inner.edits ? Promise.all(batch.map((b) => inner.edit(b.o))) : inner.edits(batch.map((b) => b.o)),
      );
      stats.batches++;
      stats.edits += batch.length;
      stats.largest = Math.max(stats.largest, batch.length);
      if (batch.length > 1) o.log?.(`spine write: ${batch.length} press writes to ${key} in one batch (${ws.filter((w) => w.status === "written").length} written${ws[0]?.sha ? `, ${ws[0].sha}` : ""})`);
      batch.forEach((b, i) => b.done(ws[i] ?? { status: "failed", reason: "the batch returned no result for this edit", path: b.o.path }));
    } catch (e) {
      for (const b of batch) b.done({ status: "failed", reason: (e as Error).message, path: b.o.path });
    } finally {
      q.running = false;
      // what came in while this batch was written has waited already: write it now
      if (q.items.length) void flush(key);
      else if (!q.timer) queues.delete(key);
    }
  }

  function edit(e: EditInput): Promise<SpineWrite> {
    if (!e.group) return inner.edit(e);
    // the press this edit writes (the press worker's context) goes into the commit as a `Press:` trailer
    const press = e.press ?? currentPress();
    if (press) e = { ...e, press };
    const key = path.resolve(e.repoDir);
    const q = queues.get(key) ?? { items: [], running: false };
    queues.set(key, q);
    const asked = Date.now();
    const item: Waiting = { o: e, asked, done: () => undefined };
    const p = new Promise<SpineWrite>((done) => {
      item.done = done;
      q.items.push(item);
    });
    if (!q.running && !q.timer) q.timer = setTimeout(() => void flush(key), linger);
    // back in this press's own request: its tally gets the batch's steps, `lock` its wait for the batch (the linger, the
    // batch before it) and `write` from its own ask to its result
    return p.then((w) => {
      noteWriteSteps({ lock: (item.started ?? asked) - asked, ...w.ms, write: Date.now() - asked });
      return w;
    });
  }

  return {
    answer: (i) => inner.answer(i),
    change: (i) => inner.change(i),
    revert: (i) => inner.revert(i),
    scaffold: (i) => inner.scaffold(i),
    edit,
    ...(inner.edits ? { edits: (l: EditInput[]) => inner.edits!(l) } : {}),
    ...(inner.pushes ? { pushes: inner.pushes } : {}),
    batches: () => ({ ...stats }),
  };
}
