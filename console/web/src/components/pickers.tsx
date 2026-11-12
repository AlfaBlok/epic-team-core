import { useState, type ReactNode } from "react";
import { PencilLine, Search } from "lucide-react";
import { api, type Repo, type RepoDoc } from "@/api";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ErrorBox, StatusBadge } from "@/components/common";
import { useQuery } from "@/lib/data";
import { cn } from "@/lib/utils";

function Option({ selected, disabled, title, onSelect, children }: { selected?: boolean; disabled?: boolean; title?: string; onSelect?: () => void; children: ReactNode }) {
  return (
    <div
      role="option"
      aria-selected={!!selected}
      aria-disabled={disabled || undefined}
      title={title}
      tabIndex={disabled ? -1 : 0}
      onClick={() => !disabled && onSelect?.()}
      onKeyDown={(e) => {
        if (!disabled && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onSelect?.();
        }
      }}
      className={cn(
        "flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-sm outline-none hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring",
        selected && "bg-accent",
        disabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
      )}
    >
      {children}
    </div>
  );
}

const listBox = "grid max-h-56 gap-0.5 overflow-y-auto rounded-md border p-1";

/** Filter repos by name or GitHub remote (case-insensitive substring). */
export function filterRepos(repos: Repo[], q: string): Repo[] {
  const s = q.trim().toLowerCase();
  return s ? repos.filter((r) => r.name.toLowerCase().includes(s) || r.remote?.toLowerCase().includes(s)) : repos;
}

/** Git checkouts on the main server (GET /api/repos), searchable. */
export function RepoPicker({ value, onChange }: { value?: Repo; onChange: (repo: Repo) => void }) {
  const { data, error, loading } = useQuery(() => api.listRepos(), []);
  const [q, setQ] = useState("");
  const repos = filterRepos(data ?? [], q);
  return (
    <div className="grid gap-1.5">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input aria-label="Search repos" className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search repos…" />
      </div>
      {error && <ErrorBox error={error} muted />}
      <div role="listbox" aria-label="Repos" className={listBox}>
        {loading && <div className="p-2 text-sm text-muted-foreground">Loading repos…</div>}
        {!loading && repos.length === 0 && <div className="p-2 text-sm text-muted-foreground">No repo matches.</div>}
        {repos.map((r) => (
          <Option key={r.path} selected={value?.path === r.path} onSelect={() => onChange(r)}>
            <span className="font-medium">{r.name}</span>
            <span className="truncate font-mono text-xs text-muted-foreground">{r.remote ?? r.path}</span>
            {r.hasEpicSpine && (
              <Badge variant="gray" className="ml-auto shrink-0">
                EpicSpine
              </Badge>
            )}
          </Option>
        ))}
      </div>
    </div>
  );
}

export type PathChoice = { kind: "doc"; doc: RepoDoc } | { kind: "custom" };

/**
 * Candidate milestone files in a repo (GET /api/repos/:name/docs), plus "Custom path…". With EpicSpine's
 * `spines.py --json`: the spine tree in order (indented by depth, status word + rollup), then orphan goal docs
 * (flagged with the reason), then ticket files. Without it (fallback): path rules, spines first, with a note.
 * Creating a new epic is the Add-milestone dialog's other mode, not an option here.
 */
export function DocPicker({ repo, choice, onChoose }: { repo: Repo; choice?: PathChoice; onChoose: (c: PathChoice) => void }) {
  const { data, error, loading } = useQuery(() => api.listRepoDocs(repo.name), [repo.name]);
  const fallback = data?.some((d) => d.via === "fallback");
  return (
    <div className="grid gap-1.5">
      {error && <ErrorBox error={error} muted />}
      {fallback && (
        <div className="text-xs text-muted-foreground" title="EpicSpine spines.py --json was missing or failed; files are matched by path instead">
          fallback: EpicSpine spine tree unavailable, files listed by path rules
        </div>
      )}
      <div role="listbox" aria-label="Spine files" className={listBox}>
        {loading && <div className="p-2 text-sm text-muted-foreground">Reading {repo.name}…</div>}
        {!loading && data?.length === 0 && <div className="p-2 text-sm text-muted-foreground">No spines or epic tickets found.</div>}
        {data?.map((d) => (
          <Option key={d.path} selected={choice?.kind === "doc" && choice.doc.path === d.path} onSelect={() => onChoose({ kind: "doc", doc: d })}>
            {!!d.depth && <span aria-hidden className="shrink-0" style={{ width: `${Math.min(d.depth, 6) * 0.9}rem` }} />}
            <Badge variant={d.kind === "spine" ? "blue" : "gray"} className="shrink-0">
              {d.kind}
            </Badge>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate">{d.title}</span>
                {d.orphan && (
                  <Badge variant="amber" className="shrink-0" title={d.orphan}>
                    orphan
                  </Badge>
                )}
              </span>
              <span className="block truncate font-mono text-xs text-muted-foreground">
                {d.path}
                {d.orphan ? ` · ${d.orphan}` : d.via === "spines" || !d.status ? "" : ` · ${d.status}`}
              </span>
            </span>
            {d.via === "spines" && d.kind === "spine" && !d.orphan && (
              <span className="flex shrink-0 items-center gap-1">
                <StatusBadge status={d.status} />
                {d.rollupStatus && (
                  <span className="text-xs text-muted-foreground" title="Aggregate of this spine and its children (rollup_status)">
                    → {d.rollupStatus}
                  </span>
                )}
              </span>
            )}
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground" title="Definition of Done / Acceptance">
              DoD {d.dod.done}/{d.dod.total}
            </span>
          </Option>
        ))}
        <Option selected={choice?.kind === "custom"} onSelect={() => onChoose({ kind: "custom" })}>
          <PencilLine className="h-4 w-4 text-muted-foreground" /> Custom path…
        </Option>
      </div>
    </div>
  );
}
