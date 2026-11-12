import { Link } from "react-router-dom";
import { PageHeader } from "@/components/common";
import { TeamPage } from "@/pages/Team";
import { useOperatorPages } from "@/lib/settingsPath";

/**
 * Settings: his team's setup, red lines and what he builds on top (they left the Inbox, the owner 2026-11-11:
 * "Don't stuff everything into Team!"), then every operator page, then projects and team activity.
 */
export function SettingsPage() {
  const pages = useOperatorPages();
  return (
    <>
      <PageHeader title="Settings" description="Your team's setup, your priorities and what you build, then every operator page." />
      <TeamPage
        section="settings"
        between={
          pages.length > 0 && (
            <section className="mt-6" data-testid="operator-pages">
              <h2 className="mb-3 text-[15px] font-semibold">Operator pages</h2>
              <div className="divide-y rounded-xl border bg-card">
                {pages.map((p) => (
                  <div key={p.to} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
                    <Link to={p.to} className="min-w-0 flex-1 basis-40 text-sm underline decoration-foreground/25 underline-offset-[3px] hover:decoration-current" data-testid={p.testId}>
                      {p.label}
                    </Link>
                    <span className="text-xs text-muted-foreground">{p.what}</span>
                  </div>
                ))}
              </div>
            </section>
          )
        }
      />
    </>
  );
}
