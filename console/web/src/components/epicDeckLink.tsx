import { Link } from "react-router-dom";
import { Presentation } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * the deck lives on its
 * milestone and on each epic, never in the sidebar. `button` is a page header's action; otherwise a small tree-row link.
 */
export function EpicDeckLink({ href, button, title, testId = "epic-deck-link" }: { href: string; button?: boolean; title?: string; testId?: string }) {
  const tip = title ?? "This epic's deck: its goal, where it stands, the plan and everything made for it";
  if (button)
    return (
      <Button asChild size="sm" variant="outline">
        <Link to={href} data-testid={testId} title={tip}>
          <Presentation /> Epic deck
        </Link>
      </Button>
    );
  return (
    <Link to={href} className="inline-flex items-center gap-0.5 text-xs text-sky-700 hover:underline dark:text-sky-400" data-testid={testId} title={tip}>
      <Presentation className="h-3 w-3" /> Epic deck
    </Link>
  );
}
