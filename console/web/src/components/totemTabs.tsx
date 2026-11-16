import { api } from "@/api";
import type { ProductMap, Totem, TotemMaps } from "@/api/totem-types";
import { ErrorBox, Loading } from "@/components/common";
import { ChatMarkdown } from "@/lib/chatMarkdown";
import { useQuery } from "@/lib/data";

/**
 * Root L-77 (the owner, 2026-11-16: "these totems ... they have oftentimes a dedicated tab on the
 * UX. So if a totem is the marketing plan, and that becomes a mandatory node ... if we had a tree, then the UX knows how
 * to display the tree"). The objective's product map (docs/totems/<product>.json) gives each hardwired totem its tab:
 * a page shows its text, a table its rows, a tree its branches; one with nothing written yet is shown empty, saying where
 * it will live. Totems whose tab already exists (Plan, Key results, Inbox, Pages, Social kit) keep that tab.
 */

export const useTotemMaps = () => useQuery<TotemMaps>(() => api.getTotems(), []);

/** the objective's product map: by the objective's id, else its declared product. */
export function productOfObjective(maps: TotemMaps | undefined, objective: string | undefined, product?: string): ProductMap | undefined {
  if (!maps || !objective) return undefined;
  return maps.products.find((p) => p.objectives.includes(objective)) ?? (product ? maps.products.find((p) => p.product === product) : undefined);
}

/** the tabs the product's totems add (one each, in the map's order), leaving the tabs the screen already has. */
export function totemTabs(p: ProductMap | undefined, existing: readonly string[]): { id: string; label: string; totem: Totem }[] {
  if (!p) return [];
  return p.totems.filter((t) => !existing.includes(t.tab)).map((t) => ({ id: t.tab, label: t.name, totem: t }));
}

export function TotemTab({ product, totem }: { product: string; totem: Totem }) {
  const { data, error, loading } = useQuery(() => api.getTotem(product, totem.id), [product, totem.id]);
  if (error) return <ErrorBox error={error} />;
  if (loading || !data) return <Loading />;
  return (
    <section className="grid min-w-0 gap-3" data-testid="totem-tab" data-totem={totem.id} data-empty={data.empty ? "yes" : "no"}>
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b pb-2">
        <h2 className="text-base font-medium">{data.name}</h2>
        <span className="text-xs text-muted-foreground">
          A totem: always here. {data.live ? <a className="underline" href={data.live} target="_blank" rel="noreferrer">Open it live</a> : null}
        </span>
      </header>
      {data.empty ? (
        <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground" data-testid="totem-empty">
          Nothing written here yet. It lives in {data.where}. Its personas fill it.
        </div>
      ) : data.markdown ? (
        <div className="min-w-0 text-sm leading-relaxed">
          <ChatMarkdown text={data.markdown} />
        </div>
      ) : data.rows ? (
        <div className="min-w-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                {(data.headers ?? []).map((h, i) => (
                  <th key={i} className="py-1.5 pr-3 font-normal">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r, i) => (
                <tr key={i} className="border-b last:border-0 align-top">
                  {r.map((c, j) => (
                    <td key={j} className="py-1.5 pr-3">
                      {/^(green|red)$/.test(c) ? <span className={c === "green" ? "text-emerald-700" : "text-red-700"}>{c}</span> : c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : data.tree ? (
        <ul className="grid gap-2 text-sm">
          {data.tree.map((b, i) => (
            <li key={i}>
              <div className="font-medium">{b.label}</div>
              <ul className="ml-3 mt-1 grid gap-1 border-l pl-3">
                {b.children.map((c) => (
                  <li key={c.id} className="flex gap-2">
                    <span className="shrink-0 tabular-nums text-muted-foreground">{c.status}</span>
                    <span className="min-w-0">{c.label}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      ) : null}
      <footer className="grid gap-0.5 text-xs text-muted-foreground">
        {data.read ? <div>Personas read it at the start: {data.read}.</div> : null}
        {data.write ? <div>And write back at the end: {data.write}.</div> : null}
        <div>Lives in {data.where}.</div>
      </footer>
    </section>
  );
}
