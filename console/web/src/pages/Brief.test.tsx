// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppRoutes } from "@/App";
import { SidebarNav } from "@/components/Layout";
import { SKINS, SkinProvider, type Skin } from "@/lib/skin";
import { BriefPage } from "@/pages/Brief";
import { api } from "@/api";
import { ApiError } from "@/api/real";
import type { Assignment, Milestone, Persona, SocialData, SocialExport, SocialPost, SocialWriteResult } from "@/api/types";
import { emptySocialExport } from "@/lib/social";
import { briefInput, formFromExport, formProblems, personaCadences } from "@/lib/brief";
import { landsAt } from "@/test/landsAt";

// the Campaign brief screen (deck v3 slide 7) and the Assets library, over the pack export and the S6 write API.

let line = 10;
const post = (p: Partial<SocialPost>): SocialPost => ({
  id: null, date: null, persona: null, kind: null, platform: null, community: null, slot: null, title: null, text: null, format: null, assets: [], topic: null,
  highlight: null, messages: [], idea: null, checks: null, link: null, replies: null, metrics: null, result: null, feedback: null, status: null, _line: line++, ...p,
});

const exportOf = (generatedAt = "2026-10-27T10:00:00Z"): SocialExport => {
  const d = emptySocialExport("/repos/social");
  d.generatedAt = generatedAt;
  d.brief = {
    ...d.brief,
    objective: "Memo becomes a known voice in the AI memory space.",
    targets: "- Threads 7 a week",
    audience: "Developers who use several AI agents.",
    voice: ["Reddit: you, first person, casual."],
    style_rules: ["Disclose in line 1-2"],
    never_say: ["competitors as worse"],
    key_messages: [
      { id: "1", message: "One memory for every agent", weight: "over", source: null, carried_by: ["P-0139", "P-0141"], _line: 20 },
      { id: "2", message: "A librarian, not a dump", weight: "normal", source: null, carried_by: [], _line: 21 },
    ],
    formats: [
      { format: "text", share: 60, example: "P-0139", _line: 30 },
      { format: "diagram", share: 40, example: null, _line: 31 },
    ],
    examples: [{ link: "https://reddit.com/r/AI_Agents/1", verdict: "like", why: "a question", _line: 40 }],
    hold_rules: [{ id: "R1", match: "a post that names a competitor", why: null, _line: 50 }],
  };
  d.posts = [post({ id: "P-0139", status: "posted", link: "https://x.com/z/139", title: "one memory" }), post({ id: "P-0141", status: "draft", title: "draft" })];
  d.assets = [{ id: "A-1", kind: "diagram", file: "data/assets/A-1-one-memory.png", made_by: "Sam", source: "one memory, 3 tools", cuts: null, used_by: ["P-0139"], _line: 7 }];
  return d;
};
const DATA: SocialData = { tenantId: "social", repo: "social", data: exportOf() };

const milestones = [
  { id: "ms_1", repo: "Acme/social", title: "Memo social" },
  { id: "ms_2", repo: "home_repo", title: "other repo" },
] as unknown as Milestone[];
const personas = [
  { id: "p_w", name: "Writer" },
  { id: "p_s", name: "Scout" },
  { id: "p_x", name: "Builder" },
] as unknown as Persona[];
const assignments = [
  { id: "a1", milestoneId: "ms_1", personaId: "p_w", cadence: { type: "fixed_time", timeOfDay: "10:00", weekdays: [1, 2, 3, 4, 5] }, enabled: true },
  { id: "a2", milestoneId: "ms_1", personaId: "p_s", cadence: { type: "interval", everyMinutes: 60 }, enabled: true },
  { id: "a3", milestoneId: "ms_2", personaId: "p_x", cadence: { type: "interval", everyMinutes: 30 }, enabled: true },
] as unknown as Assignment[];

const result = (data: SocialExport, o: Partial<SocialWriteResult> = {}): SocialWriteResult => ({
  tenantId: "social", repo: "social", data, action: "brief", id: "objective", commit: "8b41e07aaaa", push: { state: "pushed" }, files: [], ...o,
});

const serve = () => {
  vi.spyOn(api as Required<typeof api>, "getMe").mockResolvedValue({ mode: "off", identity: { kind: "none" }, tenant: null, worlds: [] } as never); // no identity (auth off) → the home world
  vi.spyOn(api, "getSocial").mockResolvedValue(DATA);
  vi.spyOn(api, "listMilestones").mockResolvedValue(milestones);
  vi.spyOn(api, "listAssignments").mockResolvedValue(assignments);
  vi.spyOn(api, "listPersonas").mockResolvedValue(personas);
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const page = async () => {
  serve();
  render(
    <SkinProvider skin={SKINS.social}>
      <MemoryRouter>
        <BriefPage />
      </MemoryRouter>
    </SkinProvider>,
  );
  await screen.findByDisplayValue("Memo becomes a known voice in the AI memory space.");
  await screen.findAllByTestId("cadence-row");
};

describe("lib/brief", () => {
  it("cadence per persona: only the campaign repo's assignments, grouped by persona name", () => {
    expect(personaCadences("social", milestones, assignments, personas).map((c) => [c.persona, c.cadence.type, c.mixed])).toEqual([
      ["Scout", "interval", false],
      ["Writer", "fixed_time", false],
    ]);
    expect(personaCadences(null, milestones, assignments, personas)).toEqual([]);
  });

  it("Save body = only the changed sections; lists split by line; shares as numbers; new rows without ids", () => {
    const base = formFromExport(exportOf(), personaCadences("social", milestones, assignments, personas));
    expect(briefInput(base, base)).toBeUndefined();
    const f = {
      ...base,
      never_say: "competitors as worse\n- hype\n\n",
      formats: [...base.formats, { format: "clip", share: "0", example: "" }],
      hold_rules: [...base.hold_rules, { id: null, match: "number claims", why: "" }],
      cadence: { ...base.cadence, Scout: { type: "interval" as const, everyMinutes: 120 } },
    };
    expect(briefInput(f, base)).toEqual({
      never_say: ["competitors as worse", "hype"],
      formats: [
        { format: "text", share: 60, example: "P-0139" },
        { format: "diagram", share: 40, example: null },
        { format: "clip", share: 0, example: null },
      ],
      hold_rules: [
        { id: "R1", match: "a post that names a competitor", why: null },
        { id: null, match: "number claims", why: null },
      ],
      cadence: [{ persona: "Scout", cadence: { type: "interval", everyMinutes: 120 } }],
    });
    expect(formProblems({ ...f, formats: [{ format: "", share: "x", example: "" }], cadence: { Writer: { type: "fixed_time", timeOfDay: "10:00", weekdays: [] } } })).toEqual([
      "format 1: name the format or remove the row",
      "format 1: share is a number 0-100",
      "cadence Writer: a time (HH:MM) and at least one day",
    ]);
  });
});

describe("T34-S7 Campaign brief screen", () => {
  it("shows every field from the export: key messages with weight and carried-by links, formats total, examples, hold rules, cadences, assets with used by", async () => {
    await page();
    expect(screen.getByLabelText("Targets")).toHaveProperty("value", "- Threads 7 a week");
    expect(screen.getByLabelText("Audience")).toHaveProperty("value", "Developers who use several AI agents.");
    expect(screen.getByLabelText("Never say")).toHaveProperty("value", "competitors as worse");
    const km = screen.getAllByTestId("key-message");
    expect(km).toHaveLength(2);
    expect(within(km[0]).getByLabelText("Weight 1")).toHaveProperty("value", "over");
    const by0 = within(km[0]).getByTestId("carried-by");
    expect(by0.textContent).toContain("2 posts");
    expect(within(by0).getByText("P-0139").closest("a")?.getAttribute("href")).toBe("https://x.com/z/139");
    expect(within(by0).getByText("P-0141").closest("a")).toBeNull(); // a draft: no live link
    expect(within(km[1]).getByTestId("carried-by").textContent).toContain("0 posts");
    expect(screen.getByTestId("formats-total").textContent).toBe("total 100%");
    expect(screen.getAllByTestId("example-row")).toHaveLength(1);
    expect(screen.getByLabelText("Hold rule 1")).toHaveProperty("value", "a post that names a competitor");
    expect(screen.getAllByTestId("cadence-row").map((r) => r.textContent)).toEqual([expect.stringContaining("Scoutnow every 1 h"), expect.stringContaining("Writernow weekdays at 10:00")]);
    const asset = screen.getByTestId("asset-row");
    expect(asset.textContent).toContain("A-1");
    expect(asset.textContent).toContain("one memory, 3 tools");
    expect(within(screen.getByTestId("asset-used-by")).getByText("P-0139").closest("a")?.getAttribute("href")).toBe("https://x.com/z/139");
    expect(screen.getByTestId("brief-save")).toHaveProperty("disabled", true);
  });

  it("one Save sends the changed sections to the brief action and shows the commit; the form reloads from the answer", async () => {
    await page();
    const saved = exportOf("2026-10-27T11:00:00Z");
    saved.brief.objective = "Memo heard by builders.";
    const write = vi.spyOn(api, "socialWrite").mockResolvedValue(result(saved));
    fireEvent.change(screen.getByLabelText("Objective"), { target: { value: "Memo heard by builders." } });
    fireEvent.change(screen.getByLabelText("Weight 2"), { target: { value: "under" } });
    fireEvent.change(screen.getByLabelText("Scout every minutes"), { target: { value: "180" } });
    expect(screen.getByTestId("brief-status").textContent).toBe("unsaved: objective, key_messages, cadence");
    fireEvent.click(screen.getByTestId("brief-save"));
    await waitFor(() => expect(screen.getByTestId("brief-status").textContent).toBe("saved · commit 8b41e07"));
    expect(write).toHaveBeenCalledWith(
      "social",
      {
        action: "brief",
        body: {
          objective: "Memo heard by builders.",
          key_messages: [
            { id: "1", message: "One memory for every agent", weight: "over", source: null },
            { id: "2", message: "A librarian, not a dump", weight: "under", source: null },
          ],
          cadence: [{ persona: "Scout", cadence: { type: "interval", everyMinutes: 180 } }],
        },
      },
      "social",
    );
    expect(screen.getByLabelText("Objective")).toHaveProperty("value", "Memo heard by builders.");
  });

  it("a 422 shows the pack's issue lines inline and keeps the edits", async () => {
    await page();
    vi.spyOn(api, "socialWrite").mockRejectedValue(
      new ApiError(422, "the pack refuses this change: data/brief.md:12: Share: not a percent", "invalid", ["data/brief.md:12: Share: not a percent", "data/brief.md:13: Format: unknown"]),
    );
    fireEvent.change(screen.getByLabelText("Hold rule 1"), { target: { value: "a number claim" } });
    fireEvent.click(screen.getByTestId("brief-save"));
    const box = await screen.findByTestId("brief-issues");
    expect(within(box).getAllByTestId("brief-issues-line").map((l) => l.textContent)).toEqual(["data/brief.md:12: Share: not a percent", "data/brief.md:13: Format: unknown"]);
    expect(screen.getByLabelText("Hold rule 1")).toHaveProperty("value", "a number claim");
    expect(screen.getByTestId("brief-status").textContent).toBe("unsaved: hold_rules");
  });

  it("problems the screen can see block Save (empty message, formats that do not parse); added rows go out without ids", async () => {
    await page();
    fireEvent.click(screen.getByRole("button", { name: "Key message" }));
    expect(screen.getByTestId("brief-problems").textContent).toContain("key message 3: write the message or remove the row");
    expect(screen.getByTestId("brief-save")).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByLabelText("Key message 3"), { target: { value: "Durable state" } });
    fireEvent.change(screen.getByLabelText("Share 1"), { target: { value: "50" } });
    expect(screen.getByTestId("formats-total").textContent).toBe("total 90% (should come to 100%)");
    const write = vi.spyOn(api, "socialWrite").mockResolvedValue(result(exportOf("2026-10-27T12:00:00Z")));
    fireEvent.click(screen.getByTestId("brief-save"));
    await waitFor(() => expect(write).toHaveBeenCalled());
    const body = (write.mock.calls[0][1] as { body: { key_messages: unknown[] } }).body;
    expect(body.key_messages[2]).toEqual({ id: null, message: "Durable state", weight: "normal", source: null });
  });

  it("Assets library: upload sends the file + kind + description and lists the new asset from the answer", async () => {
    await page();
    const after = exportOf("2026-10-27T13:00:00Z");
    after.assets = [...after.assets, { id: "A-2", kind: "clip", file: "data/assets/A-2-demo.mp4", made_by: "Sam", source: "demo", cuts: null, used_by: [], _line: 8 }];
    const up = vi.spyOn(api, "socialUpload").mockResolvedValue(result(after, { action: "asset add", id: "A-2", commit: "c0ffee0000", info: { id: "A-2", file: "data/assets/A-2-demo.mp4", kind: "clip" } }));
    const file = new File(["x"], "demo.mp4", { type: "video/mp4" });
    fireEvent.change(screen.getByLabelText("Asset file"), { target: { files: [file] } });
    fireEvent.change(screen.getByLabelText("Asset kind"), { target: { value: "clip" } });
    fireEvent.change(screen.getByLabelText("Asset description"), { target: { value: "demo" } });
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    await waitFor(() => expect(screen.getAllByTestId("asset-row")).toHaveLength(2));
    expect(up).toHaveBeenCalledWith("social", { file, kind: "clip", source: "demo" }, "social");
    expect(screen.getByTestId("upload-done").textContent).toBe("A-2 added · commit c0ffee0");
    expect(screen.getByText("Assets library · 2")).toBeTruthy();
  });

  it("an upload the server refuses shows its message inline", async () => {
    await page();
    vi.spyOn(api, "socialUpload").mockRejectedValue(new ApiError(400, "file: .sh is not an asset type", "validation_error"));
    fireEvent.change(screen.getByLabelText("Asset file"), { target: { files: [new File(["x"], "run.sh")] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    expect((await screen.findByTestId("upload-issues")).textContent).toContain(".sh is not an asset type");
  });

  it("a world with no social repo says so", async () => {
    serve();
    vi.spyOn(api, "getSocial").mockResolvedValue({ tenantId: "acme", repo: null, data: emptySocialExport() });
    render(
      <MemoryRouter>
        <BriefPage />
      </MemoryRouter>,
    );
    expect((await screen.findByText(/No social repo in this workspace yet/)).textContent).toContain("pack init social");
  });
});

describe("T34-S7 brief in the skin", () => {
  const app = (skin: Skin, at: string) =>
    render(
      <SkinProvider skin={skin}>
        <MemoryRouter initialEntries={[at]}>
          <SidebarNav />
          <AppRoutes />
        </MemoryRouter>
      </SkinProvider>,
    );

  it("social: /brief leads to the campaign's Brief & directions tab, no menu entry (T58-S3); console: neither", async () => {
    serve();
    expect(await landsAt("/brief")).toBe("/milestones/m1?tab=brief");
    expect(screen.queryByRole("link", { name: "Campaign brief" })).toBeNull();
    cleanup();
    serve();
    app(SKINS.console, "/brief");
    expect(screen.queryByText("Campaign brief")).toBeNull();
  });
});
