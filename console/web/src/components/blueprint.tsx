import { api } from "@/api";
import type { ObjectiveBlueprint } from "@/api/pursuit-types";
import { ErrorBox, Loading } from "@/components/common";
import { ChatMarkdown, inline } from "@/lib/chatMarkdown";
import { useQuery } from "@/lib/data";

/**
 * an EpicTeam objective's Blueprint chapter, the build-out's twin of the social product's message house (his 28 Nov
 * 12:47Z words, Log/2026-11-28.md#^e-497258: "some hard truths about the project we're building ... basic blueprints, just
 * like we have a messaging pillar"). What is being built in one line, then its hard truths beside its parts.
 */
export function BlueprintTab({ id }: { id: string }) {
  const { data, error, loading } = useQuery<ObjectiveBlueprint>(() => (api.getObjectiveBlueprint ? api.getObjectiveBlueprint(id) : Promise.resolve({ path: "", present: false, truths: [], parts: [] })), [id]);
  if (error) return <ErrorBox error={error} />;
  if (loading || !data) return <Loading />;
  return <BlueprintView data={data} />;
}

export function BlueprintView({ data }: { data: ObjectiveBlueprint }) {
  return (
    <div className="grid gap-6">
      <OwnBlueprint data={data} />
      {data.engine && (
        <details className="rounded-xl border bg-card p-4" data-testid="blueprint-engine">
          <summary className="cursor-pointer text-sm font-medium">How every app is built: the engine's blueprint</summary>
          <div className="mt-3 min-w-0 overflow-x-auto text-sm">
            <ChatMarkdown text={data.engine.text} />
          </div>
        </details>
      )}
    </div>
  );
}

function OwnBlueprint({ data }: { data: ObjectiveBlueprint }) {
  if (!data.present)
    return (
      <section className="grid gap-1.5 rounded-xl border border-dashed bg-card p-4" data-testid="blueprint" data-present="false">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Blueprint</div>
        <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">None written yet. The objective's manager writes its hard truths and its blueprint in {data.path}.</p>
      </section>
    );
  const list = (title: string, items: string[], testId: string, tone: string) => (
    <div className="grid content-start gap-2" data-testid={testId}>
      <h3 className="text-sm font-medium">{title}</h3>
      {items.length ? (
        <ul className="grid gap-2">
          {items.map((x) => (
            <li key={x} className={`border-l-2 ${tone} pl-2.5 text-sm leading-relaxed text-foreground [overflow-wrap:anywhere]`}>
              {inline(x)}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">None written yet.</p>
      )}
    </div>
  );
  return (
    <section className="grid gap-4 rounded-xl border bg-card p-4" data-testid="blueprint" data-present="true">
      {data.what && (
        <p className="text-base font-medium leading-relaxed text-foreground [overflow-wrap:anywhere]" data-testid="blueprint-what">
          {data.what}
        </p>
      )}
      <div className="grid gap-5 sm:grid-cols-2">
        {list("Hard truths", data.truths, "blueprint-truths", "border-foreground/60")}
        {list("Blueprint", data.parts, "blueprint-parts", "border-emerald-700/70")}
      </div>
    </section>
  );
}
