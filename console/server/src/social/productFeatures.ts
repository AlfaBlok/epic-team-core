import type { FeatureList } from "../book/features.js";
import type { MotionBody, ProductSlide } from "./motionCompute.js";

/**
 * a product
 * deck part whose body holds a line `Features: <service>` shows that service's whole feature list, one slide per group,
 * read live from the code repo docs/features/<service>.json (the one source epicspine.dev/team/, /social/ and Every epic
 * draw; motion.ts serviceFeatures reads it, so this file stays pure for the web mock). Nothing is copied into the deck:
 * a new feature line shows on the deck at the next load.
 */
const FEATURES_LINE = /^Features:\s*([a-z0-9-]+)\s*$/im;

/** The service named by a part's `Features:` line, or undefined. */
export function featuresOf(body: string): string | undefined {
  return FEATURES_LINE.exec(body)?.[1].toLowerCase();
}

/**
 * The deck with each `Features:` part replaced by one slide per group (`<part title>: <group title>`). Each carries the
 * group's lines and `part`, the part's own title in the file (a note on the slide is filed against it). The rest of the
 * part's body (any text around the line) leads its first slide. A list that cannot be read leaves the part as written,
 * with the line swapped for a short notice.
 */
export function expandFeatures<D extends MotionBody["product"]>(deck: D, read: (service: string) => FeatureList | undefined): D {
  if (!deck.slides.some((s) => featuresOf(s.body))) return deck;
  const slides: ProductSlide[] = [];
  for (const s of deck.slides) {
    const service = featuresOf(s.body);
    if (!service) {
      slides.push(s);
      continue;
    }
    const rest = s.body.replace(FEATURES_LINE, "").trim();
    const list = read(service);
    const groups = list?.groups.filter((g) => g.features.length) ?? [];
    if (!list || !groups.length) {
      slides.push({ ...s, body: [rest, `The ${service} feature list could not be read.`].filter(Boolean).join("\n\n") });
      continue;
    }
    groups.forEach((g, k) =>
      slides.push({
        title: `${s.title}: ${g.title}`,
        body: [k === 0 ? rest : "", g.intro ?? ""].filter(Boolean).join("\n\n"),
        part: s.title,
        features: {
          service: list.service || service,
          group: g.id,
          source: list.href ?? list.source,
          items: g.features.map((f) => ({ id: f.id, title: f.title, text: f.text, ...(f.since ? { since: f.since } : {}) })),
        },
      }),
    );
  }
  return { ...deck, slides };
}
