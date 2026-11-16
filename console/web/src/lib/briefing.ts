/**
 * His briefing's door: `?briefing=1` on Home opens it in both skins (the objectives screen, the social skin's
 * campaigns home), and "brief me" typed alone in a chat opens it instead of sending (the owner, vn_15aa4467: "it gives
 * me at some point a briefing where it's telling me, these are your objectives and key results, one by one").
 */
export const BRIEFING_PARAM = "briefing";
/** "brief me" (and "briefing", "give me my briefing", "start the briefing") typed alone. */
export const isBriefMe = (text: string) => /^\s*(?:please\s+)?(?:brief\s+me|briefing|(?:give|start)\s+(?:me\s+)?(?:my\s+|the\s+|a\s+)?briefing)(?:\s+please)?\s*[.!?]*\s*$/i.test(text);
/** where the briefing opens: Home holds the objectives screen in both skins. */
export const briefingHref = () => `/?${BRIEFING_PARAM}=1`;
