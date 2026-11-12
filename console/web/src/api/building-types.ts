/** GET /api/building — what the owner builds (docs/building.json), each list's campaigns and counts read from the spines. */
export interface BuildingCount {
  /** Open asks to him (not snoozed). */
  asks: number;
  /** Rows in review: finished work for him to check. */
  review: number;
}
export interface BuildingCampaign {
  repo: string;
  code: string;
  name: string;
  path: string;
  status: string | null;
  platform: string | null;
  deck: string | null;
  waits: BuildingCount;
}
export interface BuildingList {
  id: string;
  name: string;
  line?: string;
  repos: string[];
  world?: string;
  open?: { label: string; url: string };
  waits: BuildingCount;
  repoWaits: Record<string, BuildingCount>;
  campaigns: BuildingCampaign[];
}
