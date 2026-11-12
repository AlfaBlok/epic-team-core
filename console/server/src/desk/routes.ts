import { compress } from "hono/compress";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { DeskError, PAGE_HINT_MAX, type Desk } from "./desk.js";
import type { MilestoneChats } from "./milestoneChat.js";
import { readChat, viewOpts } from "./session.js";
import { PlacementError, PLACED_KINDS } from "./placements.js";
import { notJordi } from "../status/mark.js";
import type { RepoIndex } from "./repoIndex.js";
import { AttachError, ATTACH_MAX_PER_MESSAGE } from "./attachLimits.js";
import type { Attachments } from "./attachments.js";
import { ownerName } from "../identity.js";

const sendIn = z.object({
  text: z.string(),
  /** The page the owner is looking at ("M5 · Milestone"), sent along as a hint. */
  page: z.string().max(PAGE_HINT_MAX * 2).optional(),
  clientRequestId: z.string().trim().max(120).optional(),
  /** ids of files he uploaded first (POST /api/chat/attachments); the console adds their links to the text. */
  attachments: z.array(z.string().trim().max(40)).max(ATTACH_MAX_PER_MESSAGE).optional(),
});

/** The Team desk's console headers: the desk downloads an attachment with them. */
export const TEAM_DESK_FETCH = "-H 'X-Console-Run: team-desk'";

const placeIn = z.object({
  repo: z.string().trim().min(1).max(200),
  path: z.string().trim().min(1).max(500),
  kind: z.enum(PLACED_KINDS as [string, ...string[]]),
  itemId: z.string().trim().max(60).optional(),
  title: z.string().trim().max(300).optional(),
});

/** the Chat page's two calls. The desk thread is launched on the first one that needs it. */
/** `said` hears each of the owner's Team desk messages once T3 took it or queued it (voice/cross.ts passes a part across). */
export function mountDesk(api: Hono, desk: Desk, milestoneChats?: MilestoneChats, repoIndex?: RepoIndex, attachments?: Attachments, said?: (text: string, clientRequestId?: string, pending?: boolean) => void) {
  const guard = (fn: (c: Context) => Promise<Response>) => async (c: Context) => {
    try {
      return await fn(c);
    } catch (e) {
      if (e instanceof DeskError || e instanceof PlacementError || e instanceof AttachError) return c.json({ error: { code: e.code, message: e.message } }, e.status);
      throw e;
    }
  };

  const withFiles = (text: string, ids: string[], where: string) => {
    if (!attachments) throw new AttachError(400, "no_attachments", `${where} takes no attachments on this console`);
    // the Team desk calls with its run header; a milestone chat's repo desk with its world's token (its seed says how)
    return attachments.compose(text, ids, where === "the desk chat" ? TEAM_DESK_FETCH : undefined);
  };
  /** the owner's message from a chat page:, a chat message is the owner's words (stamps and answers rest on them), so never a persona or a token. */
  const jordiSend = (where: string, send: (c: Context, m: z.infer<typeof sendIn>) => Promise<{ threadId: string; pending: boolean }>) =>
    guard(async (c) => {
      const refused = notJordi((n) => c.req.header(n));
      if (refused) return c.json({ error: { code: "jordi_only", message: `only ${ownerName()} writes in ${where}, from the console page in his browser (no token, no run header)` } }, 403);
      const p = sendIn.safeParse(await c.req.json().catch(() => undefined));
      if (!p.success) return c.json({ error: { code: "validation_error", message: "text (string) is required; attachments (up to 8 ids) is optional" } }, 400);
      // his files go along as links in the text (a message may be files alone)
      const m = p.data.attachments?.length ? { ...p.data, text: withFiles(p.data.text, p.data.attachments, where) } : p.data;
      const r = await send(c, m);
      return c.json(r, r.pending ? 202 : 201);
    });

  api.get("/desk/messages", compress(), guard(async (c) => c.json(await readChat(desk, viewOpts((n) => c.req.query(n))))));
  api.post(
    "/desk/messages",
    jordiSend("the desk chat", async (_c, m) => {
      const r = await desk.send(m.text, m.page, m.clientRequestId);
      said?.(m.text, m.clientRequestId, r.pending);
      return r;
    }),
  );

  // the milestone page's Chat tab: same shape as the desk's, on that milestone's own repo-desk thread.
  if (milestoneChats) {
    api.get("/milestones/:id/chat/messages", compress(), guard(async (c) => c.json(await readChat(milestoneChats.chatFor(c.req.param("id") ?? ""), viewOpts((n) => c.req.query(n))))));
    api.post("/milestones/:id/chat/messages", jordiSend("a milestone chat", (c, m) => milestoneChats.send(c.req.param("id") ?? "", m.text, m.page, m.clientRequestId)));
  }

  // what the desk placed (registered by it, or by Add when it is the caller) and whether its [delivered] note went out.
  api.get("/desk/placements", guard(async (c) => c.json(desk.placements.list())));
  api.post(
    "/desk/placements",
    guard(async (c) => {
      const p = placeIn.safeParse(await c.req.json().catch(() => undefined));
      if (!p.success) return c.json({ error: { code: "validation_error", message: "repo, path and kind (epic | row | done_means) are required" } }, 400);
      const placed = desk.placements.place({ ...p.data, kind: p.data.kind as (typeof PLACED_KINDS)[number] });
      // say when the milestone's Delivery Manager is off, so the desk tells the owner in the same reply.
      const delivery = await desk.deliveryOf(p.data.repo, p.data.path.replace(/^\.\//, ""));
      return c.json({ ...placed, ...(delivery ? { delivery, ...(delivery.notice ? { notice: delivery.notice } : {}) } : {}) }, 201);
    }),
  );
  // the repo index, read from stored rows (no git here); ?format=json for the entries. Refresh runs in the background.
  if (repoIndex) {
    api.get("/desk/repos", (c) => (c.req.query("format") === "json" ? c.json({ scans: repoIndex.scans(), repos: repoIndex.entries() }) : c.text(repoIndex.markdown(), 200, { "content-type": "text/markdown; charset=utf-8" })));
    api.post("/desk/repos/refresh", (c) => {
      void repoIndex.refresh().catch((e) => console.error("repo index:", e));
      return c.json({ started: true }, 202);
    });
  }
  // Run the background pass now (the endpoint-list update when the seed version moved, delivered notes); the same pass runs every minute.
  api.post("/desk/sweep", guard(async (c) => c.json((await desk.tick()) ?? { delivered: 0, noted: 0 })));
  // The console page where the owner marks a draft epic ready (the stamp stays his own tap), and the spine on GitHub.
  api.get(
    "/desk/links",
    guard(async (c) => {
      const repo = c.req.query("repo");
      const rel = c.req.query("path");
      if (!repo || !rel) return c.json({ error: { code: "validation_error", message: "repo (a checkout name) and path are required" } }, 400);
      return c.json(await desk.links(repo, rel.replace(/^\.\//, "")));
    }),
  );
}
