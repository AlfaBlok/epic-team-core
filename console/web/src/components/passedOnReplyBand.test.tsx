// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { passedReply, passedLabel } from "@/lib/passed";
import { PassedBubble } from "@/components/PassedBubble";

/**
 * the desk the owner talks to passes his product feedback on and says so as the first line of its reply,
 * "Passed to the EpicTeam desk: <what> (<link>)". The Chat shows that line as the grey passed-on band with where it went.
 */
const NOTE = "https://git.example.com/acme/team/blob/main/desk/inbox/2026-11-12-social-feedback-x.md";

describe("the desk's own passed-on line", () => {
  it("reads what went and where, and keeps the rest of the reply", () => {
    const r = passedReply(`Passed to the EpicTeam desk: the campaign page is hard to find (${NOTE})\nI am drafting tomorrow's post now.`);
    expect(r?.p).toMatchObject({ kind: "to", desk: "EpicTeam", about: "the campaign page is hard to find", url: NOTE, by: "desk" });
    expect(r?.rest).toBe("I am drafting tomorrow's post now.");
    expect(passedLabel(r!.p)).toBe("Passed on to your EpicTeam desk");
  });

  it("reads a markdown link and bold too", () => {
    const r = passedReply(`**Passed to the EpicTeam desk:** the Home looks messy ([the note](${NOTE}))`);
    expect(r?.p).toMatchObject({ about: "the Home looks messy", url: NOTE });
    expect(r?.rest).toBe("");
  });

  it("keeps a second sentence on the same line as the rest", () => {
    const r = passedReply("Passed to the SocialApp desk: the launch clip post. I am looking at the slow pipeline page now.");
    expect(r?.p).toMatchObject({ desk: "SocialApp", about: "the launch clip post" });
    expect(r?.rest).toBe("I am looking at the slow pipeline page now.");
  });

  it("leaves other replies alone", () => {
    expect(passedReply("I passed it to the EpicTeam desk yesterday")).toBeUndefined();
    expect(passedReply("Done: the post is scheduled.")).toBeUndefined();
    expect(passedReply("")).toBeUndefined();
  });

  it("draws the band on the desk's side with the link to where it went", () => {
    const r = passedReply(`Passed to the EpicTeam desk: the campaign page is hard to find (${NOTE})`)!;
    render(
      <ol>
        <PassedBubble p={r.p} at="2026-11-12T18:00:00Z" />
      </ol>,
    );
    const li = screen.getByTestId("chat-passed");
    expect(li.getAttribute("data-by")).toBe("desk");
    expect(screen.getByTestId("chat-passed-label").textContent).toBe("Passed on to your EpicTeam desk");
    expect(screen.getByTestId("chat-passed-link").getAttribute("href")).toBe(NOTE);
    expect(screen.getByTestId("chat-passed-link").textContent).toContain("Open where it went");
    expect(li.textContent).toContain("This desk passed it on");
  });
});
