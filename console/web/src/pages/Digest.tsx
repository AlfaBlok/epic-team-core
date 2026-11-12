import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, type DigestPost, type SocialDigestView } from "@/api";
import { ApiError } from "@/api/real";
import { mutate, useQuery } from "@/lib/data";
import { worldId } from "@/lib/useSocial";
import { useCampaignScope } from "@/lib/campaign";
import { undoAction } from "@/lib/digest";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Empty, ErrorBox, Loading, PageHeader } from "@/components/common";

/**
 * the 20:00 digest page (social skin). One day of the campaign from GET /api/tenants/:id/social/digest: what went
 * out with its link and numbers, held, pulled, ideas picked up, the feedback received, the Style rules made from repeated
 * feedback (C6) each with Undo, and the Reporter's report. A note or a pull on a post is the S6 write API; so is Undo
 * (`style-rules/<id>/undo`). the owner's 20:00 message links here (`?date=`).
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const shift = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const fmt = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

function Section({ title, count, testId, children }: { title: string; count?: number; testId: string; children: React.ReactNode }) {
  return (
    <Card className="min-w-0 p-4" data-testid={testId}>
      <h2 className="mb-3 text-base font-semibold">
        {title}
        {count !== undefined && <span className="ml-2 text-sm font-normal text-muted-foreground tabular-nums">{count}</span>}
      </h2>
      {children}
    </Card>
  );
}

function errText(e: unknown) {
  if (e instanceof ApiError && e.issues?.length) return `${e.message}: ${e.issues.join("; ")}`;
  return e instanceof Error ? e.message : String(e);
}

/** One post: where, link, numbers, feedback so far; a note box and Pull (a live post is deleted on its platform, C5). */
function PostRow({ p, tenantId, repo, live }: { p: DigestPost; tenantId: string; repo: string; live: boolean }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string>();
  const [msg, setMsg] = useState<string>();
  const run = async (w: Parameters<typeof api.socialWrite>[1], done: string) => {
    setBusy(w.action);
    setMsg(undefined);
    try {
      const r = await mutate(() => api.socialWrite(tenantId, w, repo));
      const rule = r.info?.styleRule as { id: string; text: string } | undefined;
      setMsg(rule ? `${done} Repeated feedback: new Style rule ${rule.id} "${rule.text}" (undo below).` : done);
      setNote("");
    } catch (e) {
      setMsg(errText(e));
    } finally {
      setBusy(undefined);
    }
  };
  const pull = () => {
    if (live && !window.confirm(`Pull ${p.id}? The Publisher deletes the live post on ${p.platform ?? "its platform"} at once; the row and link stay.`)) return;
    void run({ action: `posts/${p.id}/pull` }, `${p.id} pulled.`);
  };
  return (
    <li className="min-w-0 py-2" data-testid="digest-post">
      <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="font-mono text-xs text-muted-foreground">{p.id}</span>
        <span className="text-muted-foreground">{[p.platform, p.community].filter(Boolean).join(" ")}</span>
        {p.link ? (
          <a href={p.link} target="_blank" rel="noreferrer" className="min-w-0 break-words underline">
            {p.title || p.link}
          </a>
        ) : (
          <span className="min-w-0 break-words">{p.title}</span>
        )}
      </div>
      <div className="text-xs text-muted-foreground">
        {[p.replies ? `${p.replies} replies` : null, p.metrics, p.status, p.result].filter(Boolean).join(" · ")}
      </div>
      {p.feedback && <div className="text-xs">Your feedback: {p.feedback}</div>}
      <form
        className="mt-1 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (note.trim()) void run({ action: `posts/${p.id}/feedback`, body: { feedback: note.trim() } }, "Feedback logged.");
        }}
      >
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="a note (e.g. shorter)" className="h-8 max-w-xs text-xs" aria-label={`note on ${p.id}`} />
        <Button type="submit" size="sm" variant="outline" disabled={!!busy || !note.trim()} pending={busy === `posts/${p.id}/feedback`} pendingLabel="Sending…">
          Note
        </Button>
        {p.status !== "pulled" && (
          <Button type="button" size="sm" variant="ghost" disabled={!!busy} pending={busy === `posts/${p.id}/pull`} pendingLabel={live ? "Deleting live post…" : "Pulling…"} onClick={pull}>
            Pull
          </Button>
        )}
      </form>
      {msg && <div className="mt-1 text-xs text-muted-foreground" data-testid="digest-post-msg">{msg}</div>}
    </li>
  );
}

function Posts({ list, tenantId, repo, live, empty }: { list: DigestPost[]; tenantId: string; repo: string; live: boolean; empty: string }) {
  if (!list.length) return <Empty>{empty}</Empty>;
  return (
    <ul className="divide-y">
      {list.map((p) => (
        <PostRow key={p.id} p={p} tenantId={tenantId} repo={repo} live={live} />
      ))}
    </ul>
  );
}

export function StyleRulesUndo({ view }: { view: SocialDigestView }) {
  const [busy, setBusy] = useState<string>();
  const [msg, setMsg] = useState<string>();
  const undo = async (id: string) => {
    setBusy(id);
    setMsg(undefined);
    try {
      await mutate(() => api.socialWrite(view.tenantId, undoAction(id), view.repo));
      setMsg(`Style rule ${id} removed.`);
    } catch (e) {
      setMsg(errText(e));
    } finally {
      setBusy(undefined);
    }
  };
  const rules = view.digest.styleRules;
  return (
    <>
      {rules.length === 0 ? (
        <Empty>No rule from repeated feedback yet. The same note twice becomes one.</Empty>
      ) : (
        <ul className="divide-y text-sm">
          {rules.map((r) => (
            <li key={r.id} className="flex min-w-0 flex-wrap items-center gap-2 py-2" data-testid="c6-rule">
              <span className="font-mono text-xs text-muted-foreground">{r.id}</span>
              <span className="min-w-0 flex-1 break-words">{r.text}</span>
              {r.new && <span className="rounded bg-emerald-500/15 px-1.5 text-[10px] font-medium uppercase text-emerald-700 dark:text-emerald-400">new</span>}
              <span className="text-xs text-muted-foreground">
                from {r.feedback.join(", ")}
                {r.posts.length ? ` on ${r.posts.join(", ")}` : ""}
              </span>
              <Button size="sm" variant="outline" disabled={!!busy} pending={busy === r.id} pendingLabel="Undoing…" onClick={() => void undo(r.id)}>
                Undo
              </Button>
            </li>
          ))}
        </ul>
      )}
      {msg && <div className="mt-2 text-xs text-muted-foreground" data-testid="c6-msg">{msg}</div>}
    </>
  );
}

const REPORT: [keyof NonNullable<SocialDigestView["digest"]["report"]>, string][] = [
  ["numbers", "Numbers"],
  ["best_worst", "Best and worst"],
  ["learned", "Learned"],
  ["highlights", "Highlights covered"],
  ["feedback", "Feedback themes"],
  ["cost", "Cost"],
];

export function DigestPage() {
  const [params, setParams] = useSearchParams();
  const want = params.get("date");
  const date = want && DAY.test(want) ? want : undefined;
  const repo = useCampaignScope()?.repo ?? params.get("repo") ?? undefined;
  const { data: view, error, loading } = useQuery(async () => api.getSocialDigest(await worldId(), date, repo), [date, repo]);
  const go = (d: string) => setParams((p) => (p.set("date", d), p));
  const d = view?.digest;

  return (
    <>
      <PageHeader
        title="Digest"
        description={d ? `${fmt(d.date)} · ${view!.repo} · what went out, what you said, what changed` : "What went out today, at 20:00 UTC."}
        actions={
          d && (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => go(shift(d.date, -1))}>
                ← {fmt(shift(d.date, -1))}
              </Button>
              <Button size="sm" variant="outline" onClick={() => go(shift(d.date, 1))}>
                {fmt(shift(d.date, 1))} →
              </Button>
            </div>
          )
        }
      />
      {error && <ErrorBox error={error} />}
      {loading && !view && <Loading />}
      {view && d && (
        <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
          <Card className="min-w-0 p-4 lg:col-span-2" data-testid="digest-counts">
            <div className="text-sm">
              {d.counts.posts} posts · {d.counts.replies} replies · {d.counts.outreach} outreach · {d.counts.held} held · {d.counts.pulled} pulled · {d.counts.feedback} notes from you
            </div>
            <div className="mt-1 text-xs text-muted-foreground" data-testid="digest-sent">
              {view.sent?.at
                ? `Sent to you in the desk chat at ${view.sent.at.slice(11, 16)} UTC.`
                : view.sent?.error
                  ? `Not sent: ${view.sent.error}`
                  : "Not sent yet: the Reporter sends it at 20:00 UTC."}
              {view.reportUrl && (
                <>
                  {" "}
                  <a href={view.reportUrl} target="_blank" rel="noreferrer" className="underline">
                    Report file
                  </a>
                </>
              )}
            </div>
          </Card>

          <Section title="Went out" count={d.posts.length} testId="digest-went-out">
            <Posts list={d.posts} tenantId={view.tenantId} repo={view.repo} live empty="No post went out this day." />
          </Section>

          <Section title="Replies and outreach" count={d.replies.length} testId="digest-replies">
            {d.replies.length === 0 ? (
              <Empty>None this day.</Empty>
            ) : (
              <ul className="divide-y text-sm">
                {d.replies.map((p) => (
                  <li key={p.id} className="min-w-0 py-1.5">
                    <span className="font-mono text-xs text-muted-foreground">{p.id}</span> {p.kind} · {p.platform}{" "}
                    {p.link && (
                      <a href={p.link} target="_blank" rel="noreferrer" className="break-all underline">
                        {p.title || "link"}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Style rules from your feedback" count={d.styleRules.length} testId="digest-style-rules">
            <StyleRulesUndo view={view} />
          </Section>

          <Section title="Held for you" count={d.held.length} testId="digest-held">
            {d.held.length === 0 ? (
              <Empty>Nothing held.</Empty>
            ) : (
              <ul className="divide-y text-sm">
                {d.held.map((p) => (
                  <li key={p.id} className="py-1.5">
                    <span className="font-mono text-xs text-muted-foreground">{p.id}</span> {p.platform} · {p.title}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {d.pulled.length > 0 && (
            <Section title="Pulled" count={d.pulled.length} testId="digest-pulled">
              <ul className="divide-y text-sm">
                {d.pulled.map((p) => (
                  <li key={p.id} className="py-1.5">
                    <span className="font-mono text-xs text-muted-foreground">{p.id}</span> {p.platform} · {p.result ?? "waiting for the Publisher to delete it"}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Section title="Ideas picked up" count={d.ideas.length} testId="digest-ideas">
            {d.ideas.length === 0 ? (
              <Empty>None this day.</Empty>
            ) : (
              <ul className="divide-y text-sm">
                {d.ideas.map((i) => (
                  <li key={i.id} className="py-1.5">
                    <span className="font-mono text-xs text-muted-foreground">{i.id}</span> {i.idea} · {i.state}
                    {i.became.length ? ` → ${i.became.join(", ")}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Feedback received" count={d.feedback.length} testId="digest-feedback">
            {d.feedback.length === 0 ? (
              <Empty>No notes this day.</Empty>
            ) : (
              <ul className="divide-y text-sm">
                {d.feedback.map((f, k) => (
                  <li key={k} className="py-1.5">
                    “{f.feedback}” <span className="text-xs text-muted-foreground">{f.landed}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Report" testId="digest-report">
            {d.report ? (
              <dl className="grid gap-2 text-sm">
                {REPORT.filter(([k]) => d.report![k]).map(([k, label]) => (
                  <div key={k}>
                    <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
                    <dd className="whitespace-pre-wrap break-words">{d.report![k]}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <Empty>The Reporter writes data/reports/{d.date}.md at 20:00 UTC.</Empty>
            )}
          </Section>
        </div>
      )}
    </>
  );
}
