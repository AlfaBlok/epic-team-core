import { useEffect, useMemo, useState } from "react";
import { api, type Milestone } from "@/api";
import { mutate } from "@/lib/data";
import { splitBigRoots } from "@/lib/bigRoots";

export type FocusPatch = { id: string; bigRoot: number | null };
export type FocusNote = { ok: boolean; text: string };

/**
 * the one client path for focus changes (pin, unpin, reorder), shared by Team home and the milestone page
 * header. Every change is a PATCH bigRoot, which the server's team-state writer commits to state/big-roots.json.
 * A saved focus change shows at once: the list refetch takes seconds on production (the PATCH itself waits for the team
 * repo push), so each saved position is laid over the list until a fetched list carries it, and the next position counts it.
 * An overlay older than 30 s gives way to the fetched list (the file may have changed elsewhere since).
 * `pressed` names the control that spins ("<milestone id>:<pin|unpin|up|down>"); `note` is the result.
 */
export function useFocusSave(fetched: Milestone[] | undefined) {
  const [saved, setSaved] = useState<Record<string, { pos: number | null; at: number }>>({});
  const list = useMemo(() => fetched?.map((m) => (m.id in saved ? { ...m, bigRoot: saved[m.id].pos ?? undefined } : m)), [fetched, saved]);
  useEffect(() => {
    if (fetched)
      setSaved((o) => Object.fromEntries(Object.entries(o).filter(([id, s]) => Date.now() - s.at < 30_000 && fetched.some((m) => m.id === id && (m.bigRoot ?? null) !== s.pos))));
  }, [fetched]);
  const { roots, rest } = splitBigRoots(list);
  const [busy, setBusy] = useState(false);
  const [pressed, setPressed] = useState<string>();
  const [note, setNote] = useState<FocusNote>();
  const setFocus = async (key: string, what: string, patches: FocusPatch[]) => {
    if (busy || !patches.length) return;
    setBusy(true);
    setPressed(key);
    setNote({ ok: true, text: `${what}: saving to your team repo…` });
    try {
      let repoSave: { status?: string; sha?: string; reason?: string } | undefined;
      await mutate(async () => {
        for (const p of patches) {
          const out = (await api.updateMilestone(p.id, { bigRoot: p.bigRoot })) as { teamState?: typeof repoSave };
          repoSave = out.teamState ?? repoSave;
          setSaved((o) => ({ ...o, [p.id]: { pos: p.bigRoot, at: Date.now() } }));
        }
      });
      const repo = !repoSave ? "" : repoSave.status === "written" ? ` Saved in your team repo${repoSave.sha ? ` (${repoSave.sha.slice(0, 7)})` : ""}.` : ` Not saved in your team repo yet (${repoSave.reason ?? repoSave.status}); the console retries.`;
      setNote({ ok: !repoSave || repoSave.status === "written", text: `${what}.${repo}` });
    } catch (e) {
      setNote({ ok: false, text: `${what} failed: ${(e as Error).message}` });
    } finally {
      setBusy(false);
      setPressed(undefined);
    }
  };
  return { list, roots, rest, busy, pressed, note, setFocus };
}
