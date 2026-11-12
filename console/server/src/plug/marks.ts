/**
 * Names the hosted layer writes and core must recognise: core counts a world desk's thread and keeps the
 * tester signup notes out of the desk's reply list, so the two marks live here and the hosted modules re-export them.
 */
/** A world desk's thread key (hosted: desk/worldDesk.ts). */
export const worldDeskKey = (world: string) => `world-desk:${world}`;
/** The first word of a tester signup's desk note (hosted: testers.ts). */
export const TESTER_MARKER = "[tester]";

/** The notice ref of a spine ask; older refs are needs_jordi ids (carried into the spines once). */
export const noticeRef = (milestoneId: string, path: string, code: string) => `spine:${milestoneId}:${code}:${path}`;
export function parseNoticeRef(ref: string): { milestoneId: string; code: string; path: string } | undefined {
  const m = /^spine:([^:]+):([^:]+):(.+)$/.exec(ref);
  return m ? { milestoneId: m[1], code: m[2], path: m[3] } : undefined;
}

/** The first word of a social digest's desk note (hosted: social/digest.ts). */
export const DIGEST_MARKER = "[digest]";
