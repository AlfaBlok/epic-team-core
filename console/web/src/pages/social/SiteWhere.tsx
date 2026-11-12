import type { SiteWhere } from "@/api/types";
import { cn } from "@/lib/utils";

/**
 * beside a visit or sign-up number, the site it counts and its address, the address a link to that page.
 */
export function Where({ where, className }: { where?: SiteWhere[]; className?: string }) {
  if (!where?.length) return null;
  return (
    <span className={cn("text-xs text-muted-foreground [overflow-wrap:anywhere]", className)} data-testid="where">
      {where.map((w, i) => (
        <span key={w.address}>
          {i > 0 && ", "}
          {w.name}{" "}
          <a href={w.url} target="_blank" rel="noreferrer" className="text-foreground underline decoration-muted-foreground/40 underline-offset-2 hover:decoration-foreground">
            {w.address}
          </a>
        </span>
      ))}
    </span>
  );
}
