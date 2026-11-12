// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { crossLine, passedLine, relayLine } from "../../../server/src/voice/cross";
import { spillLine } from "../../../server/src/voice/spill";
import { passedHead, passedLabel } from "@/lib/passed";
import { PassedBubble } from "@/components/PassedBubble";

/**
 * the console and his other desk pass his words in as user-role messages; the
 * desk Chat shows them apart from his own (a label naming who passed them, the desk's side, a tint, the original linked).
 * Built from the server's own line builders, so a change to their words fails here.
 */
const team = { world: "acme", product: "EpicTeam" as const, url: "https://team.example.com/chat" };
const social = { world: "social", product: "SocialApp" as const, url: "https://social.example/chat" };

describe("T101-S12 passed messages in the desk Chat", () => {
  it("reads a message passed from the other desk (router and relay, and T101-S11's card notes use the same head)", () => {
    for (const make of [crossLine, relayLine]) {
      const p = passedHead(make("dx_ab12", social, team, "fix the post tracker.", "Please fix the tracker that counts my posts"));
      expect(p).toMatchObject({ kind: "from", desk: "SocialApp", id: "dx_ab12", about: "fix the post tracker", quote: "Please fix the tracker that counts my posts", url: social.url });
      expect(passedLabel(p!)).toBe("Passed from your SocialApp desk");
    }
  });

  it("reads the console's line that a part went to the other desk", () => {
    const p = passedHead(passedLine("dx_cd34", team, social, "a post about the launch"));
    expect(p).toMatchObject({ kind: "to", desk: "SocialApp", id: "dx_cd34", about: "a post about the launch", url: social.url, quote: "" });
    expect(passedLabel(p!)).toBe("Passed on to your SocialApp desk");
  });

  it("reads the rest of a voice note filed on a card", () => {
    const p = passedHead(spillLine({ id: "vn_1", world: "acme", where: "card T92-A1: which mail", words: "Use Gmail. Also rename the deck." }, "rename the deck"));
    expect(p).toMatchObject({ kind: "spill", id: "vn_1", about: "rename the deck", where: "card T92-A1: which mail", quote: "Use Gmail. Also rename the deck." });
  });

  it("leaves his own words alone, even when they mention a desk", () => {
    expect(passedHead("Pass this to the SocialApp desk please")).toBeUndefined();
    expect(passedHead("↔ is a nice arrow")).toBeUndefined();
    expect(passedHead("")).toBeUndefined();
  });

  it("draws it on the desk's side with the label, his words and the link, never as his message", () => {
    const p = passedHead(relayLine("dx_ab12", social, team, "fix the post tracker", "Please fix the tracker"))!;
    render(
      <ol>
        <PassedBubble p={p} at="2026-11-11T08:00:00Z" />
      </ol>,
    );
    const li = screen.getByTestId("chat-passed");
    expect(li.className).toContain("justify-start");
    expect(li.innerHTML).not.toContain("bg-primary");
    expect(screen.getByTestId("chat-passed-label").textContent).toBe("Passed from your SocialApp desk");
    expect(screen.getByTestId("chat-passed-quote").textContent).toContain("Please fix the tracker");
    expect(screen.getByTestId("chat-passed-link").getAttribute("href")).toBe(social.url);
    expect(screen.queryByTestId("chat-user")).toBeNull();
  });
});
