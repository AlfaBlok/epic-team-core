import { Link } from "react-router-dom";
import { PageHeader } from "@/components/common";
import { TeamPage } from "@/pages/Team";
import { useOperatorPages } from "@/lib/settingsPath";
import { TranscriptionSettings } from "@/components/transcriptionSettings";
import { HOSTED_SETTINGS } from "@/lib/hostedPlug";

/**
 * Settings: only what the owner changes (root L-80, the owner: "settings is about things where the
 * user has to input something... If the user is not inputting something, it's not a setting"): his red lines (edit,
 * delete), the pages where he adds or replaces something, and the project actions. Read-only pages (Seats, Hosts,
 * Applications, Voice feedback, the Dashboard) are in the menu's tools list; never add a read-only thing here.
 */
export function SettingsPage() {
  const pages = useOperatorPages();
  return (
    <>
      <PageHeader title="Settings" description="Only what you change: red lines, keys, sign-ins, skills, credits." />
      <TeamPage
        section="settings"
        dashboard={false}
        between={
          <>
          {/* the model his voice notes are written out with, its paid backup, and what it cost (his own console only). */}
          <TranscriptionSettings />
          {/* the hosted layer's own inputs, when it has any. */}
          {HOSTED_SETTINGS.map((Section, i) => (
            <Section key={i} />
          ))}
          {pages.length > 0 && (
            <section className="mt-6" data-testid="operator-pages">
              <h2 className="mb-3 text-[15px] font-semibold">What you can change</h2>
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
          )}
          </>
        }
      />
    </>
  );
}

/**
 * the old dashboard panels (setup checklist, what you build, activity, project cards, personas): read-only, so they
 * left Settings (root L-80) for this page in the menu's tools list. Nothing on it was deleted.
 */
export function DashboardPage() {
  return (
    <>
      <PageHeader title="Dashboard" description="Project cards, personas and what the team did." />
      <TeamPage section="settings" dashboard redLines={false} />
    </>
  );
}
