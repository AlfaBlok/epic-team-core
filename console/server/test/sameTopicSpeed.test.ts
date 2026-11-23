import { describe, expect, it } from "vitest";
import { inboxFolds, type InboxAsk, type InboxReview } from "../src/inbox/sameTopic.js";

/**
 * E948-S192, his words 23 Nov 12:04Z: "It actually did load just slowly? Can you check yourself and time for inbox when 50
 * items plus?" Measured on a phone profile: the one-card-per-topic check (E948-S183) took 1.8 s of the 2.6 s of script
 * before his first card showed, every pair of cards parsing every link again. A 60-card inbox (plus the history of asks
 * the list also carries) folds in a few milliseconds, and the same lists fold once for every reader.
 */
const topics = ["kernel plan", "acme testers invite", "vault migration keys", "inbox speed phone", "team browser egress", "host disk space", "social channel x", "books quarterly return"];
const ask = (n: number): InboxAsk & { state: string } => ({
  id: `ms_${n % 5}:a${n}`,
  ask: "decide",
  state: "open",
  code: `E${900 + (n % 9)}-A${n}`,
  unblocks: `E${900 + (n % 9)}-S${n + 100}`,
  about: `${topics[n % topics.length]} ${n}`,
  question: `Do we ship step ${n}? See http://host1.example.com:${9000 + n}/ and https://console.example.com/inbox?focus=${n} and https://git.example.com/blob/docs/x${n}.md`,
  detail: `More at http://host1.example.com:${9100 + n}/index.html and https://docs.example.com/p/${n}`,
  contextText: `context http://host1.example.com:${9200 + n}/a/b`,
  contextLinks: [{ url: `http://host1.example.com:${9300 + n}/` }, { url: `https://console.example.com/milestones/ms_${n}` }],
  since: new Date(Date.UTC(2026, 10, 1, 0, n)).toISOString(),
});
const review = (n: number): InboxReview => ({
  id: `rv_${n}`,
  ref: `E${800 + (n % 7)}-S${n}`,
  state: "review",
  title: `Finished work number ${n}.`,
  liveUrl: `http://host1.example.com:${9400 + n}/`,
  links: [{ url: `https://console.example.com/inbox?focus=r${n}` }, { url: `http://host1.example.com:${9500 + n}/x` }],
  face: {
    about: `${topics[(n + 3) % topics.length]} review ${n}`,
    title: `Finished work number ${n}.`,
    evidence: { url: `http://host1.example.com:${9600 + n}/#a` },
    delivered: [{ text: `✓ live at http://host1.example.com:${9700 + n}/ and https://console.example.com/x/${n}` }, { text: "✗ one part waits", url: `http://host1.example.com:${9800 + n}/` }],
  },
  inboxSince: new Date(Date.UTC(2026, 10, 2, 0, n)).toISOString(),
});

describe("E948-S192 a 60-card inbox folds fast", () => {
  const asks = Array.from({ length: 60 }, (_, n) => ask(n));
  const reviews = Array.from({ length: 60 }, (_, n) => review(n));

  it("checks 120 open cards against each other in well under 50 ms", () => {
    inboxFolds([...asks], [...reviews]); // warm the JIT, as the page has by its second render
    const t0 = performance.now();
    const f = inboxFolds([...asks], [...reviews]);
    const ms = performance.now() - t0;
    expect(f.size).toBeGreaterThan(0); // the rule still folds (same About words)
    expect(ms).toBeLessThan(50);
  });

  it("folds the same lists once for every reader (sections, top bar, sidebar)", () => {
    const a = [...asks];
    const r = [...reviews];
    const first = inboxFolds(a, r);
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) expect(inboxFolds(a, r)).toBe(first);
    expect(performance.now() - t0).toBeLessThan(5);
    // a refetch is a new list: folded again
    expect(inboxFolds([...a], r)).not.toBe(first);
  });
});
