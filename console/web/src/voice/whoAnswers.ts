import { socialProduct } from "@/lib/identity";

/**
 * Who answers each Call, by where he presses it (the owner, 27 Nov: "I'm pressing this button when I'm
 * on my chat, and it says Partner. So here, I would expect to be talking to the team desk. But somehow, I was put through
 * to the strategist of one objective"; and: "on the call, I should see a name of who I'm talking to").
 * One map, one name per person: the same name on the button, on the call screen while it connects and while it is on,
 * and in the voice's own greeting (server: voice/coach.ts, voice/levelCall.ts, voice/marketing.ts).
 *
 *   Team desk chat · Partner   ──▶ Team desk partner   (all his objectives, the senior partner and OKR expert) /api/voice/coach
 *   Team desk chat · Call      ──▶ Team desk line      (quick status, passes his words to the desk)          /api/voice
 *   social desk · Partner      ──▶ <social> partner    (the product's campaigns and numbers)                  /api/voice/marketing
 *   social desk · Call         ──▶ <social> desk line                                                         /api/tenants/:id/desk/voice
 *   an objective's page · Call ──▶ <objective> manager (that objective only)                                  /api/objectives/:id/voice
 *   a campaign's chat · Call   ──▶ <campaign> manager  (that campaign only)                                   /api/milestones/:id/voice
 */
/**
 * `shown` is what the call bar says (the owner: the full objective or campaign name, never cut
 * short): "manager of Acme: Launch Acme"; `name` stays the short role the voice greets by.
 */
export type WhoAnswers = { base: string; name: string; callee: string; shown: string };

/** the words after an objective's product ("Acme: Get 5 testers" → "Get 5 testers"). */
export const shortName = (s: string) => s.replace(/\s+/g, " ").trim().replace(/^[^:]{1,30}:\s*/, "").slice(0, 80) || s;

/** the whole name, spaces folded, never clipped ("Acme: Launch Acme"). */
export const fullName = (s: string) => s.replace(/\s+/g, " ").trim();

const who = (base: string, name: string, shown = name): WhoAnswers => ({ base, name, callee: `the ${name}`, shown });

export const TEAM_DESK_PARTNER = "Team desk partner";
export const TEAM_DESK_LINE = "Team desk line";
export const socialPartner = () => `${socialProduct()} partner`;

export const whoAnswers = {
  teamDeskPartner: () => who("/api/voice/coach", TEAM_DESK_PARTNER),
  teamDeskCall: () => who("/api/voice", TEAM_DESK_LINE),
  socialDeskPartner: () => who("/api/voice/marketing", socialPartner()),
  socialDeskCall: (base: string) => who(base, `${socialProduct()} desk line`),
  objective: (id: string, name: string) => who(`/api/objectives/${encodeURIComponent(id)}/voice`, `${shortName(name)} manager`, `manager of ${fullName(name) || id}`),
  campaign: (id: string, title: string) => who(`/api/milestones/${encodeURIComponent(id)}/voice`, `${shortName(title)} manager`, `manager of ${fullName(title) || id}`),
};
