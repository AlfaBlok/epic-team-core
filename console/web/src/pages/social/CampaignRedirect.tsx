import { Navigate, useSearchParams } from "react-router-dom";
import { ErrorBox, Loading } from "@/components/common";
import { useCampaigns } from "@/lib/campaign";
import { useProject } from "@/lib/project";
import { ALL_PIPELINE_PATH } from "./nav";

/**
 * in the social skin the old screens lead to the campaign's
 * tab: Pipeline, Calendar, Ideas and Topics → Pipeline; Directions and Campaign brief → Brief & directions; History, Digest
 * and Weekly report → History. `?repo=` picks the campaign (else the first pinned one with a milestone). No campaign yet:
 * the Team home, where New campaign starts one.
 */
export function CampaignRedirect({ tab }: { tab: "pipeline" | "brief" | "history" }) {
  const [params] = useSearchParams();
  const { data, error, loading } = useCampaigns();
  const project = useProject();
  if (error) return <ErrorBox error={error} />;
  if (loading || !data) return <Loading />;
  const repo = params.get("repo");
  // the Pipeline without a campaign named is every campaign's board.
  if (tab === "pipeline" && !repo) return <Navigate to={`/${ALL_PIPELINE_PATH}`} replace />;
  // the default campaign is the selected project's.
  const cards = data.campaigns.filter((c) => c.milestoneId && !c.retired && (!project.current || c.repo === project.current.repo));
  const card = cards.find((c) => c.repo === repo || c.remote === repo) ?? cards[0];
  if (!card) return <Navigate to="/" replace />;
  const q = new URLSearchParams(tab === "pipeline" ? {} : { tab });
  if (tab === "history" && params.get("date")) q.set("date", params.get("date")!);
  return <Navigate to={`/milestones/${encodeURIComponent(card.milestoneId!)}${q.toString() ? `?${q}` : ""}`} replace />;
}
