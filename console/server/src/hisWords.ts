/**
 * Card feedback once refused the owner's long voice note (about 9,000 characters) at a 4,000 character limit, and said
 * Not sent while his words had already reached his memory: every word he says on a card is taken, however long.
 * The one upper bound for his words on any card route (feedback, Not yet, Decline, an answer, a comment, a Run now note):
 * far above any voice note (a 2-hour note is about 100,000 characters), only there so a broken client cannot post megabytes.
 */
export const HIS_WORDS_MAX = 200_000;
