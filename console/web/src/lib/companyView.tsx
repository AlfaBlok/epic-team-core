import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "@/api";
import { useQuery } from "@/lib/data";

/**
 * the Company view is parked (the owner 2026-11-12: "I never specified a company view, it was an idea … This is
 * something for the future. Now focus is making each wheel turn"). It shows only when the server says so (/api/me
 * `companyView`, set by CONSOLE_COMPANY_VIEW=1); absent, unread or failed = parked. The code stays; one line turns it on.
 */
export function useCompanyView(): boolean {
  const { data: me } = useQuery(() => (api.getMe ? api.getMe() : Promise.resolve(undefined)), []);
  return !!me?.companyView;
}

/** the route guard: the Company view's pages render only while it is on; parked, one plain line and the way home. */
export function CompanyGate({ children }: { children: ReactNode }) {
  const { data: me, loading } = useQuery(() => (api.getMe ? api.getMe() : Promise.resolve(undefined)), []);
  if (me?.companyView) return <>{children}</>;
  if (loading && !me) return null;
  return (
    <div className="mx-auto max-w-xl p-6 text-[15px] leading-snug text-gray-900 dark:text-gray-100" data-testid="company-view-off">
      <h1 className="mb-2 text-lg font-semibold">The Company view is parked</h1>
      <p className="mb-3">It was an idea for later. Each project's own page is where its work goes for now.</p>
      <Link to="/" className="font-semibold underline">
        Back to the Team home
      </Link>
    </div>
  );
}
