// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type Assignment, type MilestoneStatusView, type Persona, type WaitingItem } from "@/api";
import { FyiCard, OwnerActivityList, SendToDialog, WaitingCard, WaitingOnYou } from "@/components/waiting";
import { threadHref } from "@/components/common";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear(); // a fold opened in one test (Decided for you) stays open in the next otherwise
});

const item = (over: Partial<WaitingItem> = {}): WaitingItem => ({
  id: "wj_1",
  source: "ask",
  state: "open",
  who: "Sam",
  row: "T4",
  milestoneId: "ms_1",
  milestoneTitle: "E904",
  nodeKey: "ms_1/T4",
  path: "docs/E904.md",
  title: "T4 Pick the logger layout",
  ask: "decide",
  question: "Ship with one logger or two?",
  options: ["one", "two"],
  recommendation: "one",
  contextLinks: [{ label: "why", url: "https://github.com/Acme/poly-maker/blob/HEAD/docs/notes.md#loggers" }],
  owner: { kind: "delivery-manager", assignmentId: "as_1", personaName: "Delivery Manager", label: "Delivery Manager", threadId: "th_1" },
  since: new Date(Date.now() - 2 * 86400_000).toISOString(),
  decidable: false,
  ...over,
});

const wrap = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe("WaitingCard", () => {
  it("v1 decide ask: the question once as a short heading, options as a radio list recommended first and marked, details under More with owner; age in the meta", () => {
    wrap(<WaitingCard item={item({ options: ["two", "one"] })} />);
    // one short heading without the "You decide:" verb; the question is not repeated when the heading says all of it
    expect(screen.getByTestId("ask-lead").textContent).toBe("Ship with one logger or two?");
    expect(screen.queryByTestId("ask-question")).toBeNull();
    expect(screen.getByTestId("card-kind").textContent).toBe("Decide"); // the kind is a word in the meta line, not "Decide: …"
    expect(screen.getByTestId("card-meta").className).toMatch(/text-muted-foreground/);
    expect(screen.queryByTestId("ask-kind")).toBeNull(); // no kind pill
    expect(screen.getByTestId("ask-lead").className).not.toMatch(/font-semibold|font-bold/);
    // The row title is not repeated; no code without a code.
    expect(screen.queryByText("T4 Pick the logger layout")).toBeNull();
    expect(screen.queryByTestId("ask-code")).toBeNull();
    // E948-S69: a question's options are its buttons, the recommended one first and filled, never Send my pick, Approve, No or Changes wanted.
    const buttons = [...screen.getByTestId("answer-buttons").querySelectorAll("button")].map((b) => b.textContent);
    expect(buttons).toEqual(["one", "two", "Park", "Snooze"]); // E948-S83 iteration 2: Park beside the options; Snooze beside Park (the owner 2026-11-15)
    expect(screen.getAllByTestId("ask-option")[0].className).not.toMatch(/border-input/);
    expect(screen.getAllByTestId("ask-option")[1].className).toMatch(/border-input/);
    expect(screen.queryByTestId("send-pick")).toBeNull();
    expect(screen.queryByTestId("decline")).toBeNull();
    expect(screen.queryByTestId("changes-wanted")).toBeNull();
    expect(screen.queryByTestId("hint-answer")).toBeNull(); // no hint lines under the buttons
    expect(screen.getByTestId("issued-age").textContent).toBe("2 days ago");
    expect(screen.getByTestId("card-meta").contains(screen.getByTestId("issued-age"))).toBe(true);
    expect(screen.queryByTestId("waiting-details")).toBeNull(); // folded
    fireEvent.click(screen.getByTestId("ask-lead"));
    const details = screen.getByTestId("waiting-details");
    expect(details.textContent).toMatch(/docs\/E904\.md/);
    expect(details.textContent).toMatch(/Owner: Delivery Manager/);
    expect(details.textContent).not.toMatch(/waiting/); // the age is in the meta line
    expect((screen.getByText("why").closest("a") as HTMLAnchorElement).href).toMatch(/notes\.md#loggers$/);
    expect(screen.queryByRole("button", { name: /Yes: go ahead/ })).toBeNull();
  });

  it("E948-S70: a three-option decide answers with the one option pressed, never the whole options line", async () => {
    const opts = ["500 Stars a month", "250 Stars a month", "keep it closed for now"];
    const spy = vi.spyOn(api, "respondToWaiting").mockResolvedValue({ id: "jr_3", itemId: "wj_1", kind: "answer", text: opts[1]!, delivery: "sent", createdAt: new Date().toISOString() });
    wrap(<WaitingCard item={item({ question: "What does the weekly digest cost?", options: opts, recommendation: opts[0] })} />);
    for (const o of opts) expect(screen.getByRole("button", { name: o })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /·/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: opts[1]! }));
    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith("wj_1", { kind: "answer", text: "250 Stars a month", milestoneId: "ms_1", wake: true }));
    cleanup();
    // the old shape, the options read as one: no lone button sends the whole line as the answer
    wrap(<WaitingCard item={item({ options: [opts.join(" · ")], recommendation: undefined })} />);
    expect(screen.queryByRole("button", { name: opts.join(" · ") })).toBeNull();
  });

  it("E948-S69: an option's button answers with that option and the note; free text stays available", async () => {
    const spy = vi.spyOn(api, "respondToWaiting").mockResolvedValue({ id: "jr_1", itemId: "wj_1", kind: "answer", text: "two", delivery: "sent", createdAt: new Date().toISOString() });
    const { rerender } = wrap(<WaitingCard item={item()} />);
    fireEvent.click(screen.getByRole("button", { name: "two" }));
    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith("wj_1", { kind: "answer", text: "two", milestoneId: "ms_1", wake: true }));
    // saved: vn_e00f1134 the card is one green Sent row at once, in its place
    await vi.waitFor(() => expect(screen.getByTestId("sent-row")).toBeTruthy());
    expect(screen.queryByTestId("answer-buttons")).toBeNull();
    // The refresh brings the item back still open (here: the answer was not delivered): the controls are live again.
    const failed = { id: "jr_1", itemId: "wj_1", milestoneId: "ms_1", kind: "answer" as const, text: "two", delivery: "failed" as const, createdAt: new Date().toISOString() };
    rerender(<MemoryRouter><WaitingCard item={item({ response: failed })} /></MemoryRouter>);
    await vi.waitFor(() => expect((screen.getByRole("button", { name: "two" }) as HTMLButtonElement).disabled).toBe(false));
    // the note (under More) goes with the pick, still "two"...
    fireEvent.click(screen.getByTestId("ask-lead"));
    fireEvent.change(screen.getByLabelText("Feedback"), { target: { value: "after the audit" } });
    fireEvent.click(screen.getByRole("button", { name: "two" }));
    await vi.waitFor(() => expect(spy).toHaveBeenLastCalledWith("wj_1", { kind: "answer", text: "two. after the audit", milestoneId: "ms_1", wake: true }));
    cleanup();
    //... and a typed answer alone goes with the feedback block's Send (E948-S60: Not now is gone)
    wrap(<WaitingCard item={item()} />);
    expect(screen.queryByTestId("not-now")).toBeNull();
    fireEvent.change(screen.getByLabelText("Feedback"), { target: { value: "neither, wait a week" } });
    fireEvent.click(screen.getByTestId("card-feedback-send"));
    await vi.waitFor(() => expect(spy).toHaveBeenLastCalledWith("wj_1", { kind: "answer", text: "neither, wait a week", milestoneId: "ms_1", wake: true }));
  });

  it("v2 do ask: code in the foot (qualified across repos), numbered steps, the steps link, Unblocks / Effort / Recommended under More, Done sends “done”", async () => {
    const spy = vi.spyOn(api, "respondToWaiting").mockResolvedValue({ id: "jr_9", itemId: "wj_1", kind: "answer", text: "done", delivery: "sent", createdAt: new Date().toISOString() });
    const doAsk = item({
      code: "T4-A3",
      repo: "poly-maker",
      ask: "do",
      question: "Patch the archiver for 1 h on host1",
      options: undefined,
      recommendation: "do it tonight",
      steps: "1) sudo systemctl edit archiver (host1, user root) 2) restart it — done looks like: the archiver runs",
      stepsLink: { label: "runbook", url: "https://github.com/Acme/poly-maker/blob/HEAD/docs/runbooks/archiver.md#run" },
      unblocks: "S2, S3; each day waiting loses a day of ticks",
      effort: "~10 min",
      advisory: ["4 open asks in this epic (aim for ≤ 3)"],
    });
    wrap(<WaitingCard item={doAsk} qualify />);
    expect(within(screen.getByTestId("card-foot")).getByTestId("ask-code").textContent).toBe("poly-maker/T4-A3");
    expect(screen.getByTestId("ask-lead").textContent).toBe("Patch the archiver for 1 h on host1");
    expect(screen.getByTestId("card-kind").textContent).toBe("Do");
    const steps = screen.getByTestId("ask-steps");
    expect(steps.tagName).toBe("OL");
    expect([...steps.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["sudo systemctl edit archiver (host1, user root)", "restart it"]);
    expect(screen.getByTestId("ask-done-looks").textContent).toBe("Done looks like: The archiver runs");
    // the steps link is the card's one green link
    expect(screen.getByTestId("card-go").getAttribute("href")).toMatch(/archiver\.md#run$/);
    expect(screen.getByTestId("card-go").textContent).toContain("Open the steps");
    // the Copy steps button and the advisory chips are gone from the card
    expect(screen.queryByText("Unblocks:")).toBeNull();
    fireEvent.click(screen.getByTestId("ask-lead"));
    expect(screen.getByText("Unblocks:").parentElement!.textContent).toBe("Unblocks: S2, S3; each day waiting loses a day of ticks");
    expect(screen.getByText("Effort:").parentElement!.textContent).toBe("Effort: ~10 min");
    expect(screen.getByText("Recommended:").parentElement!.textContent).toBe("Recommended: do it tonight");
    // Order: kind word, heading, steps, More, foot with the code, then the controls (the buttons and the feedback, one group).
    const card = screen.getByTestId("waiting-card");
    const order = ["card-kind", "ask-lead", "ask-steps", "card-foot", "ask-code", "ask-more", "waiting-details", "answer-buttons", "card-feedback"].map((id) => card.innerHTML.indexOf(`data-testid="${id}"`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    fireEvent.click(screen.getByTestId("done"));
    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith("wj_1", { kind: "answer", text: "done", milestoneId: "ms_1", wake: true }));
    cleanup();
    // Single repo: the bare code.
    wrap(<WaitingCard item={doAsk} />);
    expect(screen.getByTestId("ask-code").textContent).toBe("T4-A3");
  });

  it("Needs Sam rows and approve asks get Approve / No (T72-S7)", async () => {
    const spy = vi.spyOn(api, "respondToWaiting").mockResolvedValue({ id: "jr_2", itemId: "nj_1", kind: "approve", text: "", delivery: "queued", deliveryError: "no one to deliver to, attach a persona", createdAt: new Date().toISOString() });
    wrap(<WaitingCard item={item({ id: "nj_1", source: "needs_jordi", ask: "approve", decidable: true, options: undefined, recommendation: undefined, proposedAction: "deploy T4" })} />);
    expect(screen.getByText("persona request")).toBeTruthy();
    fireEvent.click(screen.getByTestId("ask-lead"));
    expect(screen.getByText("deploy T4")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Yes: go ahead/ }));
    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith("nj_1", { kind: "approve", text: "", milestoneId: "ms_1", wake: true }));
    expect(await screen.findByText(/Recorded, not delivered: no one to deliver to, attach a persona/)).toBeTruthy();
    cleanup();
    wrap(<WaitingCard item={item({ code: "PLAN-4-A1", ask: "approve", options: undefined, recommendation: "approve, with both small answers yes" })} />);
    expect(screen.getByRole("button", { name: /Yes: go ahead/ })).toBeTruthy();
    expect(screen.getByTestId("decline").textContent).toBe("No: drop it");
    fireEvent.click(screen.getByTestId("ask-lead"));
    expect(screen.getByText("Recommended:").parentElement!.textContent).toBe("Recommended: approve, with both small answers yes");
  });

  const response = { id: "jr_3", itemId: "wj_1", kind: "answer" as const, text: "one", delivery: "sent" as const, createdAt: new Date().toISOString() };

  it("a persona request with options shows the options, never Approve; T72-S7: a question, so no No or Changes wanted", () => {
    wrap(<WaitingCard item={item({ id: "nj_2", source: "needs_jordi", ask: "approve", decidable: true, options: ["Yes, ship", "Wait"], recommendation: "Wait" })} />);
    expect(screen.getByRole("button", { name: /Yes, ship/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Wait/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Yes: go ahead/ })).toBeNull();
    expect(screen.queryByTestId("decline")).toBeNull();
    expect(screen.queryByTestId("changes-wanted")).toBeNull();
    expect(screen.queryByTestId("send-pick")).toBeNull();
  });

  it("T72-S7, E948-S52: an approve ask has Approve and No, no hint lines, no Answer, the feedback block open; a note goes with Approve", async () => {
    const spy = vi.spyOn(api, "respondToWaiting").mockResolvedValue({ id: "jr_7", itemId: "wj_1", kind: "approve", text: "simpler", delivery: "sent", createdAt: new Date().toISOString() });
    wrap(<WaitingCard item={item({ ask: "approve", options: undefined, recommendation: "yes" })} />);
    const set = screen.getByTestId("answer-buttons");
    expect([...set.querySelectorAll("button")].map((b) => b.textContent!.trim())).toEqual(["Yes: go ahead", "No: drop it", "Park", "Snooze"]);
    expect(set.textContent).not.toContain("Yes. The team goes ahead.");
    expect(set.textContent).not.toContain("It closes as a no. A reason is optional.");
    expect(screen.queryByRole("button", { name: /^\s*Answer$/ })).toBeNull();
    expect(screen.queryByTestId("changes-wanted")).toBeNull();
    // E948-S60: the feedback block is always open; the note travels with the button he presses
    expect(screen.getByRole("textbox")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Feedback"), { target: { value: "another iteration later, simpler" } });
    fireEvent.click(screen.getByTestId("approve"));
    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith("wj_1", { kind: "approve", text: "another iteration later, simpler", milestoneId: "ms_1", wake: true }));
  });

  it("T72-S7, E948-S52: No's first press opens the note (the reason is optional), the next closes it as a no", async () => {
    const spy = vi.spyOn(api, "respondToWaiting").mockResolvedValue({ id: "jr_9", itemId: "wj_1", kind: "deny", text: "", delivery: "sent", createdAt: new Date().toISOString() });
    wrap(<WaitingCard item={item({ ask: "approve", options: undefined })} />);
    fireEvent.click(screen.getByTestId("decline"));
    expect(screen.getByTestId("answer-decline-box")).toBeTruthy();
    expect(screen.getByLabelText("Feedback")).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
    const no = screen.getByTestId("decline") as HTMLButtonElement;
    expect(no.disabled).toBe(false); // the reason is optional
    fireEvent.click(no);
    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith("wj_1", { kind: "deny", text: "", milestoneId: "ms_1", wake: true }));
    cleanup();
    wrap(<WaitingCard item={item({ ask: "approve", options: undefined })} />);
    fireEvent.click(screen.getByTestId("decline"));
    fireEvent.change(screen.getByLabelText("Feedback"), { target: { value: "not now" } });
    fireEvent.click(screen.getByTestId("decline"));
    await vi.waitFor(() => expect(spy).toHaveBeenLastCalledWith("wj_1", { kind: "deny", text: "not now", milestoneId: "ms_1", wake: true }));
  });

  it("T72-S7, E948-S52: a do step has Done and Stuck, in that order, no hint line", () => {
    wrap(<WaitingCard item={item({ ask: "do", options: undefined, question: "Scan the QR code" })} />);
    expect([...screen.getByTestId("answer-buttons").querySelectorAll("button")].map((b) => b.textContent!.trim())).toEqual(["Done", "Stuck", "Park", "Snooze"]);
    expect(screen.queryByTestId("hint-yes")).toBeNull();
  });

  it("T67-S1: a feedback line reads as changes asked for, never as answered or done, and offers no Change answer", () => {
    wrap(<WaitingCard item={item({ ask: "approve", state: "answered", feedback: true, answer: "simpler", response: { id: "jr_8", itemId: "wj_1", kind: "feedback", text: "simpler", delivery: "sent", createdAt: new Date().toISOString(), spine: { status: "written", sha: "abc1234" } } })} />);
    const st = screen.getByTestId("answer-state");
    expect(st.getAttribute("data-outcome")).toBe("feedback");
    expect(st.textContent).toMatch(/You asked for changes: simpler\. This is not an approval/);
    expect(screen.queryByText(/Answered, pending work/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Change answer/ })).toBeNull();
  });

  it("a persona request answered: says it went to the run's thread, offers Retry delivery when it did not", () => {
    wrap(<WaitingCard item={item({ source: "needs_jordi", response })} />);
    expect(screen.getByText(/Sent to the asking run's thread/)).toBeTruthy();
    expect(screen.queryByText(/waiting for the owner to update the spine/i)).toBeNull();
    cleanup();
    wrap(<WaitingCard item={item({ source: "needs_jordi", response: { ...response, delivery: "failed", deliveryError: "t3_error: down" } })} />);
    expect(screen.getByText(/Not delivered: t3_error: down/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Retry delivery/ })).toBeTruthy();
  });

  it("T90-S2: one answer closes many: the card says in one line which other asks the same answer closed, and the maybes", () => {
    const settles = { at: "2026-11-09T20:00:00Z", closed: [{ itemId: "wj_2", code: "home_repo/T86-A2", reason: "the same X sign-in", write: { status: "written", sha: "def5678" } }], maybe: [{ itemId: "wj_3", code: "home_repo/T46-A21", reason: "it is about money" }], checked: 2, label: "home_repo/T86-A1", line: "your answer also closed home_repo/T86-A2. maybe also settles: home_repo/T46-A21" };
    const written = { ...response, spine: { status: "written" as const, sha: "abc1234", path: "docs/E904.md" }, settles };
    wrap(<WaitingCard item={item({ state: "answered", answer: "done", response: written })} />);
    expect(screen.getByTestId("answer-settles").textContent).toBe(
      "Your answer also closed home_repo/T86-A2. maybe also settles: home_repo/T46-A21. The team checks the maybes and closes only the ones your answer clearly settles.",
    );
    cleanup();
    cleanup();
    wrap(<WaitingCard item={item({ state: "answered", answer: "done", response: { ...written, settles: { ...settles, maybe: [], line: "" } } })} />);
    expect(screen.queryByTestId("answer-settles")).toBeNull();
  });

  it("answered, pending work: the [answered] line is in the spine (state from the spine), with the commit and no answer box", () => {
    const written = { ...response, spine: { status: "written" as const, sha: "abc1234", path: "docs/E904.md" } };
    wrap(<WaitingCard item={item({ state: "answered", answer: "yes", response: written })} />);
    const banner = screen.getByTestId("answer-state");
    expect(banner.textContent).toMatch(/^Answered, pending work: yes\. Written to the spine in abc1234\. The owner acts on it and marks the line done\.$/);
    expect(screen.queryByLabelText("Answer")).toBeNull();
    cleanup();
    // Answered by someone else in the spine (no console response): still pending work.
    wrap(<WaitingCard item={item({ state: "answered", answer: "yes" })} />);
    expect(screen.getByTestId("answer-state").textContent).toMatch(/^Answered, pending work: yes\. It is in the spine\./);
  });

  it("a canonical ask lists the milestones that reference it (under More), linked to the referencing line", () => {
    wrap(
      <WaitingCard
        item={item({
          code: "PLAN-10-A7",
          referencedBy: [
            { milestoneId: "ms_2", milestoneTitle: "E904 poly-maker", path: "docs/e4.md", line: 9, row: "T4-S1", via: "waits_on", gloss: "The relay rebuild", url: "https://github.com/x/poly-maker/blob/HEAD/docs/e4.md?plain=1#L10" },
            { milestoneId: "ms_3", milestoneTitle: "E905", path: "docs/e5.md", via: "unblocks" },
          ],
        })}
      />,
    );
    expect(screen.queryByTestId("ask-references")).toBeNull(); // folded
    fireEvent.click(screen.getByTestId("ask-lead"));
    const box = screen.getByTestId("ask-references");
    expect(box.textContent).toBe("Also blocks: E904 poly-maker · row T4-S1, E905 (unblocks)");
    expect(screen.getByRole("link", { name: "E904 poly-maker · row T4-S1" }).getAttribute("href")).toContain("poly-maker");
    // D19 reference line: its gloss rides on the link.
    expect(screen.getByRole("link", { name: "E904 poly-maker · row T4-S1" }).getAttribute("title")).toBe("The relay rebuild");
    cleanup();
    wrap(<WaitingCard item={item({ code: "PLAN-10-A7" })} />);
    fireEvent.click(screen.getByTestId("ask-lead"));
    expect(screen.queryByTestId("ask-references")).toBeNull();
  });

  it("done: the owner marked the line done (or deleted it)", () => {
    wrap(<WaitingCard item={item({ state: "done", answer: "one", response: { ...response, spine: { status: "written", sha: "abc1234" } } })} />);
    expect(screen.getByTestId("answer-state").textContent).toMatch(/^Done \(you answered: one\)\. The owner acted on it and marked the line done \(or removed it\) in the spine\.$/);
    expect(screen.queryByLabelText("Answer")).toBeNull();
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
  });

  it("a refused spine write shows the reason and Retry re-attempts it", async () => {
    const refused = { ...response, delivery: "queued" as const, deliveryError: "the checkout is on feature, not main", spine: { status: "skipped" as const, reason: "the checkout is on feature, not main" } };
    const spy = vi.spyOn(api, "redeliverResponse").mockResolvedValue({ ...response, spine: { status: "written", sha: "def5678" } });
    wrap(<WaitingCard item={item({ response: refused })} />);
    expect(screen.getByTestId("answer-state").textContent).toMatch(/Saved here, not written to the spine \(skipped\): the checkout is on feature, not main\./);
    expect(screen.queryByText(/Not delivered/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Retry spine write/ }));
    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith("jr_3"));
    cleanup();
    wrap(<WaitingCard item={item({ response: { ...refused, spine: { status: "failed", reason: "git push failed: auth" } } })} />);
    expect(screen.getByTestId("answer-state").textContent).toMatch(/not written to the spine \(failed\): git push failed: auth/);
    // the refused answer still woke the asker; the reason is said once, not again in the wake line
    cleanup();
    wrap(<WaitingCard item={item({ response: { ...refused, wake: { notified: "woken", runId: "run_1", persona: "Builder" } } })} />);
    expect(screen.getByTestId("wake-note").textContent).toBe("Woken Builder (run run_1). It writes the answer into the spine itself (the console could not).");
    expect((document.body.textContent ?? "").split("the checkout is on feature, not main").length - 1).toBe(1);
  });

  it("answering an ask posts the answer and names the refusal reason on the card, not an error line", async () => {
    vi.spyOn(api, "respondToWaiting").mockResolvedValue({ ...response, delivery: "queued", deliveryError: "dirty", spine: { status: "skipped", reason: "dirty" } });
    wrap(<WaitingCard item={item()} />);
    fireEvent.click(screen.getByRole("button", { name: "one" }));
    await vi.waitFor(() => expect(api.respondToWaiting).toHaveBeenCalledWith("wj_1", { kind: "answer", text: "one", milestoneId: "ms_1", wake: true }));
    expect(screen.queryByText(/Recorded, not delivered/)).toBeNull();
  });
});

// The E904 situation (Waiting on: none): Needs-the owner rows, ready (guessed) and pending (coming up), no asks.
const E904 = "docs/one-logger/E904.md";
const guess = (id: string, title: string, over: Partial<WaitingItem> = {}): WaitingItem =>
  item({
    id: `wj_${id}`,
    source: "heuristic",
    signal: "needs_column",
    ask: "unknown",
    row: undefined,
    title: `${id} ${title}`,
    question: title,
    options: undefined,
    recommendation: undefined,
    path: E904,
    repo: "poly-maker",
    spine: { path: E904, title: "E904: One logger" },
    detail: "Needs: Sam go · Status: ready",
    contextLinks: [{ label: `${E904} · row ${id}`, url: `https://github.com/Acme/poly-maker/blob/HEAD/${E904}?plain=1#L${id.length}` }],
    owner: { kind: "thread", threadId: "mcp:e4", label: "E904 manager" },
    ...over,
  });
const E4_ITEMS = [
  guess("0", "S3 patch the archiver", { signal: "red_node", detail: "Needs: Sam root · Status: waiting" }),
  guess("T7", "XL-6 market_data tables"),
  guess("T4", "XL-3 deploy in place of xz7bqe", { gate: "future", gateReason: "pending" }),
  guess("T10", "S7 retire podcek", { gate: "future", gateReason: "after T7 (not done)" }),
];

describe("WaitingOnYou", () => {
  it("T90-S2: the folded Answered row says the same answer closed other asks", async () => {
    const settles = { at: "2026-11-09T20:00:00Z", closed: [{ itemId: "wj_9", code: "home_repo/T86-A2", reason: "same", write: { status: "written" } }], maybe: [], checked: 1, label: "home_repo/T86-A1", line: "your answer also closed home_repo/T86-A2" };
    const r = { id: "jr_9", itemId: "wj_2", kind: "answer" as const, text: "done", delivery: "sent" as const, createdAt: new Date().toISOString(), spine: { status: "written" as const }, settles };
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([item(), item({ id: "wj_2", state: "answered", answer: "done", response: r })]);
    wrap(<WaitingOnYou milestoneId="ms_1" />);
    await screen.findAllByTestId("waiting-card");
    fireEvent.click(screen.getByTestId("answered-section-toggle"));
    const badge = screen.getByTestId("answered-also-closed");
    expect(badge.textContent).toBe("also closed 1");
    expect(badge.getAttribute("title")).toBe("your answer also closed home_repo/T86-A2");
  });
  it("lists structured items with a count of unanswered ones, scoped by milestone and node", async () => {
    const spy = vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([item(), item({ id: "wj_2", state: "answered", answer: "x" })]);
    wrap(<WaitingOnYou milestoneId="ms_1" nodeKey="ms_1/T4" scopeLabel="T4" />);
    expect((await screen.findAllByTestId("waiting-card")).length).toBe(1); // the answered one is under Answered
    expect(screen.queryAllByTestId("answered-row")).toHaveLength(0); // folded = the one Answered line
    fireEvent.click(screen.getByTestId("answered-section-toggle"));
    expect(screen.getAllByTestId("answered-row")).toHaveLength(1);
    expect(spy).toHaveBeenCalledWith({ milestoneId: "ms_1", nodeKey: "ms_1/T4", includeSuperseded: true });
    expect(screen.getByText("from T4 down")).toBeTruthy();
    expect(screen.getByTestId("waiting-on-you").querySelector('[data-tone="needs-you"]')?.textContent).toBe("1");
  });

  it("superseded Needs Sam rows are not cards or counted; a collapsed Superseded list shows them with their ask", async () => {
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([
      item(),
      item({ id: "nj_old", source: "needs_jordi", state: "superseded", supersededBy: "poly-maker/T4-A1", question: "Old persona request", decidable: false }),
    ]);
    wrap(<WaitingOnYou milestoneId="ms_1" />);
    expect((await screen.findAllByTestId("waiting-card")).length).toBe(1);
    expect(screen.getByTestId("waiting-on-you").querySelector('[data-tone="needs-you"]')?.textContent).toBe("1");
    expect(screen.queryByText("Old persona request")).toBeNull();
    fireEvent.click(screen.getByTestId("superseded-toggle"));
    expect(screen.getByText("Old persona request")).toBeTruthy();
    expect(screen.getByText("superseded by poly-maker/T4-A1")).toBeTruthy();
  });

  it("T13-S14 E904 with no asks: rows naming Sam with no ask get no card and no badge; future gates under a collapsed Coming up", async () => {
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue(E4_ITEMS);
    wrap(<WaitingOnYou milestoneId="ms_1" />);
    expect(await screen.findByText(/Nothing waiting on you here/)).toBeTruthy();
    expect(screen.queryAllByTestId("waiting-card")).toHaveLength(0);
    expect(screen.queryByTestId("guessed-card")).toBeNull();
    expect(screen.queryByText(/no ask written/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Ask owner to write asks/ })).toBeNull();
    expect(screen.getByTestId("waiting-on-you").querySelector('[data-tone="needs-you"]')).toBeNull();

    const coming = screen.getByTestId("coming-up");
    expect(coming.textContent?.trim()).toBe("Coming up2");
    fireEvent.click(screen.getByTestId("coming-up-toggle"));
    expect(coming.textContent).toContain("T4 XL-3 deploy in place of xz7bqe");
    expect(coming.textContent).toContain("after T7 (not done)");
  });

  it("T6-S11: with the thread's environment the links open the T3 desktop app (t3code://threads/<env>/<id>)", async () => {
    const ENV = "5359a170-5adb-4e2d-8e6a-4569a169cfd9";
    const CHILD = "thread:delegated-task:command%3Amcp%3Ae2bc%3Adelegate-task%3Arun_6f33028c-S4";
    const blocker = item({
      id: "nj_10",
      source: "needs_jordi",
      ask: "approve",
      decidable: true,
      title: "Approve?",
      question: "Approve?",
      options: undefined,
      recommendation: undefined,
      repo: undefined,
      blocksRunId: "run_43",
      blocksPersona: "E904 steward",
      contextLinks: [{ label: "run thread", url: "t3code://x", threadId: CHILD, environmentId: ENV }],
      owner: { kind: "delivery-manager", assignmentId: "as_1", label: "Delivery Manager", threadId: "mcp:home", environmentId: ENV },
    });
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([blocker]);
    wrap(<WaitingOnYou />);
    const section = await screen.findByTestId("blocking-now");
    const want = `t3code://threads/${ENV}/thread%3Adelegated-task%3Acommand%253Amcp%253Ae2bc%253Adelegate-task%253Arun_6f33028c-S4`;
    expect((within(section.firstElementChild as HTMLElement).getByText("run thread").closest("a") as HTMLAnchorElement).getAttribute("href")).toBe(want);
    const card = screen.getByTestId("waiting-card");
    fireEvent.click(within(card).getByTestId("ask-lead")); // the card's links sit under More
    expect((within(card).getByText("run thread").closest("a") as HTMLAnchorElement).getAttribute("href")).toBe(want);
    expect((within(card).getByText("(home thread)") as HTMLAnchorElement).getAttribute("href")).toBe(`t3code://threads/${ENV}/mcp%3Ahome`);
    expect(screen.queryByRole("button", { name: "Copy thread id" })).toBeNull();
  });

  it("items blocking a persona run (M2-19 fields) come first under “Blocking <persona> now” with the run thread; codes qualify across repos", async () => {
    const blocker = item({
      id: "nj_9",
      source: "needs_jordi",
      ask: "approve",
      decidable: true,
      title: "Approve the T4 deploy window?",
      question: "Approve the T4 deploy window?",
      options: undefined,
      recommendation: undefined,
      repo: undefined,
      blocksRunId: "run_42",
      blocksPersona: "E904 steward",
      contextLinks: [{ label: "run thread", url: "t3-thread://v1/th_run", threadId: "th_run" }],
    });
    const other = item({ id: "wj_5", code: "PLAN-4-A1", repo: "epicspine-skill", ask: "approve", options: undefined });
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([other, ...E4_ITEMS, blocker]);
    wrap(<WaitingOnYou />);
    const section = await screen.findByTestId("blocking-now");
    expect(section.textContent).toMatch(/^Blocking E904 steward now/);
    expect((within(section.firstElementChild as HTMLElement).getByText("run thread").closest("a") as HTMLAnchorElement).getAttribute("href")).toBe(threadHref("th_run"));
    const cards = screen.getAllByTestId("waiting-card");
    expect(within(cards[0]).getByTestId("card-kind").textContent).toBe("Approve");
    expect(within(cards[0]).getByTestId("ask-lead").textContent).toBe("Approve the T4 deploy window?");
    expect(section.contains(cards[0])).toBe(true);
    expect(section.contains(cards[1])).toBe(false);
    // Repos poly-maker + epicspine-skill in the list: the code is qualified.
    expect(screen.getByTestId("ask-code").textContent).toBe("epicspine-skill/PLAN-4-A1");
    // the count is the status items: the 2 asks; E904's 2 rows with no ask are not counted, nor future gates.
    expect(screen.getByTestId("waiting-on-you").querySelector('[data-tone="needs-you"]')?.textContent).toBe("2");
  });
});

describe("T48-S13 Answered list", () => {
  const long = "Keep the X credentials in team secrets? ".repeat(8);
  const answer = "Yes, keep them, and rotate every 90 days. ".repeat(10);
  it("folded shows only the Answered (n) line; open shows one truncated line per ask with the full text on hover", async () => {
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([
      item({ id: "wj_a", state: "answered", question: long, answer }),
      item({ id: "wj_b", state: "done", question: "Short one?", answer: "no" }),
    ]);
    wrap(<WaitingOnYou milestoneId="ms_1" />);
    const section = await screen.findByTestId("answered-section");
    expect(section.textContent?.trim()).toBe("Answered2");
    expect(within(section).queryAllByTestId("answered-row")).toHaveLength(0);
    expect(section.hasAttribute("data-fold-section")).toBe(true); // the same box as every other section
    fireEvent.click(within(section).getByTestId("answered-section-toggle"));
    const rows = within(section).getAllByTestId("answered-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByTestId("answered-question").className).toMatch(/truncate/);
    expect(within(rows[0]).getByTestId("answered-answer").className).toMatch(/truncate/);
    const btn = within(rows[0]).getByRole("button");
    expect(btn.getAttribute("title")).toContain(long.trim());
    expect(btn.getAttribute("title")).toContain(answer.trim());
    expect(within(section).queryAllByTestId("waiting-card")).toHaveLength(0);
    fireEvent.click(btn);
    expect(within(rows[0]).getAllByTestId("waiting-card")).toHaveLength(1);
    expect(within(rows[1]).queryAllByTestId("waiting-card")).toHaveLength(0);
    fireEvent.click(btn);
    expect(within(section).queryAllByTestId("waiting-card")).toHaveLength(0);
  });
});

describe("WaitingOnYou states", () => {
  it("orders open, then answered / refused, then done last (T13-S10: answered ones collapsed under Answered); the count badge counts only the unanswered", async () => {
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([
      item({ id: "wj_done", state: "done", question: "Already done?", answer: "yes" }),
      item({ id: "wj_pending", state: "answered", question: "Pending work?", answer: "no" }),
      item({ id: "wj_open", question: "Still open?" }),
    ]);
    wrap(<WaitingOnYou milestoneId="ms_1" />);
    expect((await screen.findAllByTestId("waiting-card")).map((c) => c.textContent)).toEqual([expect.stringContaining("Still open?")]);
    expect(screen.queryAllByTestId("answered-row")).toHaveLength(0);
    fireEvent.click(screen.getByTestId("answered-section-toggle"));
    const rows = screen.getAllByTestId("answered-row");
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringMatching(/Pending work\?answered(?!, done)answered by .*: no$/), expect.stringMatching(/Already done\?answered, doneanswered by .*: yes$/)]);
    // compact lines, no cards until one is clicked; a click opens only that ask's card.
    expect(screen.getAllByTestId("waiting-card").map((c) => c.textContent)).toEqual([expect.stringContaining("Still open?")]);
    fireEvent.click(within(rows[1]).getByRole("button"));
    const cards = screen.getAllByTestId("waiting-card");
    expect(cards.map((c) => c.textContent)).toEqual([expect.stringContaining("Still open?"), expect.stringContaining("Already done?")]);
    expect(screen.getByTestId("waiting-on-you").querySelector('[data-tone="needs-you"]')?.textContent).toBe("1");
  });
});

describe("FYI cards (decided by a persona)", () => {
  const fyi = (over: Partial<WaitingItem> = {}) =>
    item({ id: "wj_fyi", state: "answered", decidedBy: "Delivery-Manager", who: "Delivery-Manager", code: "T4-A2", ask: "approve", question: "Restart the relay?", answer: "restarted — why: reversible — rollback: systemctl start relay", options: undefined, recommendation: undefined, ...over });

  it("shows in its own compact section, not as a waiting card, and is not counted", async () => {
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([fyi(), item({ id: "wj_open", question: "Still open?" })]);
    wrap(<WaitingOnYou milestoneId="ms_1" />);
    fireEvent.click(await screen.findByTestId("decided-for-you-toggle")); // Decided for you folds closed by default
    const card = await screen.findByTestId("fyi-card");
    expect(card.textContent).toContain("Decided");
    expect(card.textContent).toContain("by Delivery Manager");
    expect(card.textContent).toContain("Restart the relay?");
    expect(card.textContent).toContain("rollback: systemctl start relay");
    expect(within(screen.getByTestId("decided-for-you")).getByTestId("decided-for-you-toggle")).toBeTruthy();
    expect(screen.getAllByTestId("waiting-card")).toHaveLength(1);
    expect(screen.getByTestId("waiting-on-you").querySelector('[data-tone="needs-you"]')?.textContent).toBe("1");
  });

  it("T13-S14: lines naming Sam with no ask are no cards; the badge is the server's open items (the coded ask only)", async () => {
    const free = (id: string, path: string, title: string) =>
      guess(id, `Waiting on: Sam ${id}`, { signal: "waiting_on", path, spine: { path, title }, milestoneId: "ms_1", nodeKey: "ms_1" });
    const guessed = [free("phone", "docs/spines/epic-917.md", "PLAN-17"), free("S7", "docs/spines/epic-918.md", "PLAN-18"), free("E910", "docs/spines/epic-910.md", "PLAN-10")];
    const coded = item({ id: "wj_a1", code: "PLAN-29-A1", question: "Still open?" });
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([coded, fyi(), ...guessed]);
    vi.spyOn(api, "getMilestoneStatus").mockResolvedValue({
      milestoneId: "ms_1",
      outcome: { word: "not_yet", source: "derived" },
      flow: { word: "needs_you", reason: "1 question" },
      items: [{ id: coded.id, kind: "ask", state: "open", milestoneId: "ms_1", title: "PLAN-29-A1", nodeKey: "ms_1" }],
      needsYou: 1,
      reasons: ["1 question"],
    } as MilestoneStatusView);
    wrap(<WaitingOnYou milestoneId="ms_1" />);
    await vi.waitFor(() => expect(screen.getByTestId("waiting-on-you-count").textContent).toBe("1"));
    expect(screen.getAllByTestId("waiting-card")).toHaveLength(1);
    expect(screen.queryAllByTestId("guessed-card")).toHaveLength(0);
    expect(screen.queryByText(/no ask written/)).toBeNull();
    const decided = screen.getByTestId("decided-for-you");
    expect(screen.getByTestId("waiting-card").compareDocumentPosition(decided) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("T8-S26: shows the rubric score the verdict was judged by, when the console has it", async () => {
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([fyi({ rubric: "score 91/75 · reversal 4 · options 3 · impact 3 · evidence 4" })]);
    wrap(<WaitingOnYou milestoneId="ms_1" />);
    fireEvent.click(await screen.findByTestId("decided-for-you-toggle")); // folded closed by default
    expect((await screen.findByTestId("fyi-rubric")).textContent).toBe("score 91/75 · reversal 4 · options 3 · impact 3 · evidence 4");
  });

  it("only FYI items: nothing counted, no badge; T48-S17: Decided for you is its own section, Waiting on you says it is empty", async () => {
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([fyi()]);
    wrap(<WaitingOnYou milestoneId="ms_1" />);
    fireEvent.click(await screen.findByTestId("decided-for-you-toggle")); // folded closed by default
    await screen.findByTestId("fyi-card");
    expect(screen.getByTestId("waiting-on-you").querySelector('[data-tone="needs-you"]')).toBeNull();
    expect(within(screen.getByTestId("waiting-on-you")).getByText(/Nothing waiting on you/)).toBeTruthy();
    expect(screen.getByTestId("waiting-on-you").contains(screen.getByTestId("fyi-card"))).toBe(false);
  });

  it("one click on Reverse posts an answer to the owner via respond; the card then says so", async () => {
    const spy = vi.spyOn(api, "respondToWaiting").mockResolvedValue({ id: "jr_1", itemId: "wj_fyi", kind: "answer", text: "x", delivery: "sent", createdAt: new Date().toISOString() });
    wrap(<FyiCard item={fyi()} />);
    fireEvent.click(screen.getByRole("button", { name: /Reverse/ }));
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    const [id, body] = spy.mock.calls[0];
    expect(id).toBe("wj_fyi");
    expect(body).toMatchObject({ kind: "answer", milestoneId: "ms_1" });
    expect(body.text).toContain("Reverse this decision (Restart the relay?)");
  });

  it("a card Sam already reversed shows the response instead of the button", () => {
    wrap(<FyiCard item={fyi({ response: { id: "jr_1", itemId: "wj_fyi", kind: "answer", text: "x", delivery: "sent", createdAt: new Date().toISOString() } })} />);
    expect(screen.queryByRole("button", { name: /Reverse/ })).toBeNull();
    expect(screen.getByTestId("fyi-reversed").textContent).toContain("You asked to reverse this");
  });
});

describe("cards with the M2-23 states", () => {
  const written = { id: "jr_9", itemId: "wj_do", kind: "answer" as const, text: "done", delivery: "sent" as const, createdAt: new Date().toISOString(), spine: { status: "written" as const, sha: "abc1234" } };
  it("a v2 ask keeps its code chip in every state; answered / done have no buttons, a refused write in “Blocking now” shows Retry", async () => {
    const base = { code: "T5-A3", ask: "do" as const, repo: "poly-maker", options: undefined, recommendation: undefined, question: "Patch the archiver", unblocks: "S2, S3" };
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([
      item({ ...base, id: "wj_do", state: "answered", answer: "done", response: written }),
      item({ ...base, id: "wj_do2", code: "T5-A4", state: "done", answer: "done" }),
      item({
        ...base,
        id: "wj_do3",
        code: "T5-A5",
        blocksRunId: "run_7",
        blocksPersona: "E905 steward",
        response: { ...written, id: "jr_10", delivery: "queued", spine: { status: "skipped", reason: "the checkout is on feature, not main" } },
      }),
    ]);
    const retry = vi.spyOn(api, "redeliverResponse").mockResolvedValue({ ...written, id: "jr_10" });
    wrap(<WaitingOnYou milestoneId="ms_1" />);
    expect((await screen.findAllByTestId("waiting-card")).map((c) => within(c).getByTestId("ask-code").textContent)).toEqual(["T5-A5"]);
    fireEvent.click(screen.getByTestId("answered-section-toggle"));
    for (const row of screen.getAllByTestId("answered-row")) fireEvent.click(within(row).getByRole("button")); // one card per clicked line
    const cards = screen.getAllByTestId("waiting-card");
    expect(cards.map((c) => within(c).getByTestId("ask-code").textContent)).toEqual(["T5-A5", "T5-A3", "T5-A4"]);
    // Blocking section first, with the refusal reason and Retry spine write.
    const blocking = screen.getByTestId("blocking-now");
    expect(within(blocking).getByTestId("answer-state").textContent).toMatch(/not written to the spine \(skipped\): the checkout is on feature, not main/);
    fireEvent.click(within(blocking).getByRole("button", { name: /Retry spine write/ }));
    await vi.waitFor(() => expect(retry).toHaveBeenCalledWith("jr_10"));
    // Answered, pending work and done: no Done / Answer controls.
    expect(within(cards[1]).getByTestId("answer-state").textContent).toMatch(/^Answered, pending work: done\. Written to the spine in abc1234/);
    expect(within(cards[1]).queryByRole("button", { name: /Done/ })).toBeNull();
    expect(within(cards[2]).getByTestId("answer-state").textContent).toMatch(/^Done/);
    expect(within(cards[2]).queryByLabelText("Answer")).toBeNull();
    expect(screen.getByTestId("waiting-on-you").querySelector('[data-tone="needs-you"]')?.textContent).toBe("1"); // the refused write still needs the owner (Retry)
  });
});

describe("OwnerActivityList", () => {
  it("shows the spine write (sha, or why it was refused) instead of a thread delivery", async () => {
    vi.spyOn(api, "listOwnerActivity").mockResolvedValue([
      { type: "response", id: "a1", at: new Date().toISOString(), kind: "answer", text: "one", itemTitle: "Decide: X?", delivery: "sent", spine: { status: "written", sha: "abc1234" } },
      { type: "response", id: "a2", at: new Date().toISOString(), kind: "answer", text: "two", itemTitle: "Decide: Y?", delivery: "queued", spine: { status: "skipped", reason: "dirty tree" } },
    ]);
    wrap(<OwnerActivityList milestoneId="ms_1" />);
    // Collapsed by default: header shows the count, rows hidden until toggled.
    const toggle = await screen.findByRole("button", { name: /From you\s*2/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("written to the spine (abc1234)")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("written to the spine (abc1234)")).toBeTruthy();
    expect(screen.getByText("not written to the spine: dirty tree")).toBeTruthy();
    expect(screen.queryByText(/^to /)).toBeNull();
  });
});

describe("SendToDialog", () => {
  it("lists the milestone's personas Delivery Manager first and posts the message", async () => {
    vi.spyOn(api, "listAssignments").mockResolvedValue([
      { id: "as_w", milestoneId: "ms_1", personaId: "pe_w", enabled: true } as Assignment,
      { id: "as_dm", milestoneId: "ms_1", personaId: "pe_dm", enabled: false } as Assignment,
      { id: "as_x", milestoneId: "ms_other", personaId: "pe_w", enabled: true } as Assignment,
    ]);
    vi.spyOn(api, "listPersonas").mockResolvedValue([
      { id: "pe_w", name: "infra steward" } as Persona,
      { id: "pe_dm", name: "Delivery Manager" } as Persona,
    ]);
    const send = vi.spyOn(api, "sendMessage").mockResolvedValue({ id: "msg_1", assignmentId: "as_dm", text: "hi", delivery: "sent", threadId: "th_9", createdAt: new Date().toISOString() });
    render(<SendToDialog milestoneId="ms_1" item={item()} open onOpenChange={() => {}} />);
    const select = (await screen.findByLabelText("Recipient")) as HTMLSelectElement;
    await vi.waitFor(() => expect(select.options.length).toBe(2));
    expect([...select.options].map((o) => o.textContent)).toEqual(["Delivery Manager (not waking)", "infra steward"]);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Restate T5 please" } });
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ milestoneId: "ms_1", assignmentId: "as_dm", text: "Restate T5 please", refItemId: "wj_1" }));
    expect(await screen.findByText(/Sent to the home thread/)).toBeTruthy();
  });
});

describe("quiet card: one plain line, the rest folded", () => {
  it("a long question opens with its first sentence as the heading, the rest and a Why line under it; context and details sit under More", () => {
    wrap(
      <WaitingCard
        item={item({
          question: 'Which of six new taglines goes on the banners? We recommend "Capture, own, compound your memory."',
          impact: "the social team holds the channel banners until you pick",
          contextText: "you answered E925-A1 and asked to play with lines like that",
          risk: "none",
          whyYou: "the brand voice is your call",
          options: undefined,
        })}
      />,
    );
    // a short heading (no verb), the rest of the ask in plain text under it, the Why line; context and details under More
    expect(screen.getByTestId("ask-lead").textContent).toBe("Which of six new taglines goes on the banners?");
    expect(screen.getByTestId("ask-question").textContent).toBe('We recommend "Capture, own, compound your memory."');
    expect(screen.getByTestId("ask-why").textContent).toBe("Why: The social team holds the channel banners until you pick");
    expect(screen.queryByTestId("ask-more")).toBeNull();
    expect(screen.getByTestId("ask-lead").getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByTestId("ask-lead"));
    expect(screen.getByTestId("ask-lead").getAttribute("aria-expanded")).toBe("true");
    const more = screen.getByTestId("ask-more");
    expect(within(more).getByTestId("ask-human")).toBeTruthy();
    expect(within(more).getByTestId("waiting-details")).toBeTruthy();
    fireEvent.click(screen.getByTestId("ask-lead"));
    expect(screen.queryByTestId("ask-more")).toBeNull();
  });
});
