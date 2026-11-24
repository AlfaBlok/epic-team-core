/**
 * one set of buttons per card
 * kind, the same labels, order and one-line hint everywhere (Team home, a milestone's page, the phone).
 *  - a question (decide, provide, a persona's question): its options, or one Answer with his words;
 *  - an approve card (approve ask, or a `do` step with Done in place of Approve): Approve, Changes wanted, Decline;
 *  - a review card: Mark complete (its variants), Changes wanted, Decline; a held post: Schedule, Changes wanted, Decline.
 * Changes wanted opens a box for his words; Decline opens a box with an optional reason. The press kinds behind them are
 * unchanged (feedback = relaunch, deny), so the daily press test presses the same routes.
 */
export const ACTION = {
  answer: { label: "Answer", hint: "Your words go to the team and close the question." },
  // a `do` step's own answer box.
  reply: { label: "Answer", hint: "Send words, a screenshot or a file. The team reads them.", placeholder: "Your answer: words, a pasted screenshot or a file…" },
  pick: { hint: "Pick one, or write your own answer and press Answer." },
  approve: { label: "Approve", hint: "Yes. The team goes ahead." },
  done: { label: "Done", hint: "You did this step. The team carries on." },
  changes: { label: "Changes wanted", hint: "Say what should change. The work comes back to you.", send: "Send what should change", placeholder: "What should change? Your words go to the team." },
  // E948-S139 (the owner, 24 Nov 20:37Z): "Give me a button. That's it Duplicate or already answered". One tap closes the
  // card as answered with these words (and the note box, when he wrote in it); the team traces which card it repeats.
  duplicate: { label: "Duplicate or already answered", hint: "It closes. The team finds the card it repeats and stops asking.", said: "Closed as a duplicate", words: "duplicate or already answered" },
  decline: { label: "Decline", hint: "It closes as a no. A reason is optional.", placeholder: "Why not? (optional) Your words are kept with it." },
} as const;

/**
 * what a card's pressed button says. It spins with "Sending…" in the frame of
 * the tap, every other button on the card waits (disabled), it turns into "Saved ✓" once the console has the press (its
 * 202), and the card leaves `savedMs` later; a failure gives the button back with the reason next to it.
 */
export const PRESS = { sending: "Sending…", saved: "Saved ✓", savedMs: 250, writing: "Saved · writing it to the project…", done: "Done ✓ It is in the project", doneShowMs: 8_000 } as const;
export type Pressing = { key: string; phase: "sending" | "saved" };

/** The props of one card button `key` while `p` runs: spinner on the pressed one, "Saved ✓" after, the others disabled. */
export function pressProps(p: Pressing | undefined, key: string, disabled = false) {
  return {
    pending: p?.key === key && p.phase === "sending",
    saved: p?.key === key && p.phase === "saved",
    pendingLabel: PRESS.sending,
    savedLabel: PRESS.saved,
    disabled: disabled || !!p,
  };
}
