import { useState } from "react";
import { Link } from "react-router-dom";
import { api, type Milestone, type ProductNote } from "@/api";
import { Button } from "@/components/ui/button";
import { FoldSection } from "@/components/homeSection";
import { useChatAttach } from "@/components/ChatAttach";
import { WordsBox } from "@/components/WordsBox";
import { useQuery } from "@/lib/data";
import { productSlideNote } from "@/lib/totems";
import { worldId } from "@/lib/useSocial";
import { cn } from "@/lib/utils";
import { campaignVoiceBase, shortTo, useAnswerVoice } from "@/voice/AnswerVoice";
import { ownerName } from "@/lib/identity";

/**
 * (a social world repo's desk note; the owner on their: "make a proposal I can examine on a post (on the deck?)
 * I'll give answer in situ"): the Brief slide's note box on every Product tab slide. Send files the note, verbatim, to the
 * campaign's spine (a `Product note` Decisions row with the slide named, one History line), then hands it to the campaign
 * chat, as a Brief note goes, which acts on it. His past notes on the slide show under the box, read from the spine.
 */
export type ProductSlideRef = { n: number; title: string; file: string };

const fmtDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** The campaign's filed product notes (GET …/totems), plus the ones sent from this page since it loaded. */
export function useProductNotes(m: Pick<Milestone, "id">) {
  const q = useQuery(async () => api.getCampaignTotems(await worldId(), m.id), [m.id]);
  const [added, setAdded] = useState<ProductNote[]>([]);
  const all = [...(q.data?.productNotes ?? []), ...added.filter((a) => !(q.data?.productNotes ?? []).some((x) => x.date === a.date && x.slide === a.slide && x.note === a.note))];
  return { all, add: (n: ProductNote) => setAdded((xs) => [...xs, n]) };
}

export function ProductNoteBox({ m, s, notes, onFiled }: { m: Pick<Milestone, "id">; s: ProductSlideRef; notes: ProductNote[]; onFiled: (n: ProductNote) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string; chat?: boolean }>();
  const files = useChatAttach({ enabled: true, disabled: busy });
  const mine = notes.filter((x) => x.file === s.file && x.slide === s.title).reverse();
  /** Files the words to the spine, then hands them to the campaign chat; throws only when the filing failed. */
  const deliver = async (words: string) => {
    setBusy(true);
    setNote(undefined);
    try {
      const r = await api.fileProductNote(await worldId(), m.id, { file: s.file, slide: s.title, note: words });
      const last = r.notes[r.notes.length - 1];
      if (last) onFiled(last);
      setText("");
      try {
        if (files.ids.length) await api.sendMilestoneChatMessage(m.id, productSlideNote(s, words), undefined, undefined, files.ids);
        else await api.sendMilestoneChatMessage(m.id, productSlideNote(s, words));
        files.clear();
        setNote({ ok: true, chat: true, text: "Filed in the objective's spine and sent to its chat, which acts on it." });
      } catch (e) {
        setNote({ ok: true, text: `Filed in the objective's spine. Its chat did not get it: ${(e as Error).message}` });
      }
    } catch (e) {
      setNote({ ok: false, text: `Not filed: ${(e as Error).message}` });
      throw e;
    } finally {
      setBusy(false);
    }
  };
  const send = () => {
    if ((!text.trim() && !files.ids.length) || !files.ready) return;
    void deliver(text.trim() || "(a screenshot, no words)").catch(() => undefined);
  };
  // the one voice control: what is typed goes out before the spoken words, through this box's own Send.
  // on the campaign's own voice routes (its world's switch and budget), so the mic shows in every world that has voice.
  const voice = useAnswerVoice({ origin: `product:${m.id}:${s.file}:${s.title}`, to: shortTo(`Product slide ${s.n}: ${s.title}`), page: `product slide ${s.n}`, base: campaignVoiceBase(m.id), typed: text, deliver, disabled: busy });
  const [open, setOpen] = useState(true);
  return (
    <div className="grid min-w-0 items-start gap-3 lg:grid-cols-[minmax(0,1fr)_20rem]" data-testid="product-feedback">
      <section className="grid gap-2 rounded-lg border p-3" data-testid="product-note">
        <h3 className="text-sm font-semibold">Your answer or note on this slide</h3>
        <p className="text-xs text-muted-foreground">It is filed in the campaign's spine with this slide named, and the campaign chat acts on it.</p>
        <WordsBox label="Your note on this slide" rows={2} boxClassName="min-h-16" value={text} onChange={setText} files={files} voice={voice} placeholder="For example: Yes to this metric, but count only testers who log in." testid="product-note-box" />
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={busy || !files.ready || (!text.trim() && !files.ids.length)} pending={busy} pendingLabel="Sending…" onClick={send} data-testid="product-note-send">
            Send
          </Button>
          {note && (
            <span role="status" className={cn("text-xs", note.ok ? "text-emerald-700 dark:text-emerald-400" : "text-destructive")}>
              {note.text}{" "}
              {note.chat && (
                <Link to="?tab=chat" className="underline">
                  In Chat
                </Link>
              )}
            </span>
          )}
        </div>
      </section>
      <FoldSection title="Your notes on this slide" count={mine.length} testId="product-notes" open={open} onToggle={setOpen} className="mb-0">
        {mine.length ? (
          <ul className="grid gap-2 text-xs">
            {mine.map((x, k) => (
              <li key={k} className="[overflow-wrap:anywhere]" data-testid="product-note-line">
                <span className="text-muted-foreground">{fmtDay(x.date)}</span> {x.noteBy === `${ownerName()}'s` ? "" : "(a test) "}
                {x.note}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">No notes on this slide yet.</p>
        )}
      </FoldSection>
    </div>
  );
}
