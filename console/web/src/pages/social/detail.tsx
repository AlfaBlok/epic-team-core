import type { ReactNode } from "react";
import type { SocialIdea } from "@/api/types";
import { isLive, type Post } from "@/lib/social";
import { postBasics, slotWords } from "@/lib/postBasics";
import { ideaParts, textParts, type Para } from "@/lib/readable";
import { dayLabel, OutLink, PostBadge } from "./parts";
import { ownerName } from "@/lib/identity";

/**
 * one post or one idea in detail as labelled parts, each on its own row
 * (label left, words right; stacked on a phone), paragraphs kept, a readable line (about 68 characters, line height 1.55)
 * and space between parts. Used by the Pipeline's Full screen and the post page.
 */

/** One labelled part: its label (and a small note under it) on the left, its content on the right. */
export function Part({ label, note, children, testid }: { label: string; note?: ReactNode; children: ReactNode; testid?: string }) {
  return (
    <section className="grid min-w-0 gap-1.5 sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:gap-x-6" data-testid={testid ?? "detail-part"} data-label={label}>
      <h3 className="text-[13px] font-medium leading-6 text-muted-foreground">
        {label}
        {note && <span className="block text-xs font-normal">{note}</span>}
      </h3>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

/** The column of parts, with clear space between them. */
export function Parts({ children, testid }: { children: ReactNode; testid?: string }) {
  return (
    <div className="grid min-w-0 gap-6" data-testid={testid}>
      {children}
    </div>
  );
}

const READ = "max-w-[68ch] text-[15px] leading-[1.55] text-foreground";

function Paragraph({ para }: { para: Para }) {
  return (
    <>
      {para.lead && <p className="whitespace-pre-wrap break-words">{para.lead}</p>}
      {para.items.length > 0 && (
        <ul className="grid list-disc gap-1 pl-5 marker:text-muted-foreground">
          {para.items.map((it, i) => (
            <li key={i} className="break-words pl-1">
              {it}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Lines of words with a paragraph's space between them. */
export function Lines({ lines, list }: { lines: ReactNode[]; list?: boolean }) {
  if (list)
    return (
      <ul className={`grid list-disc gap-2 pl-5 marker:text-muted-foreground ${READ}`}>
        {lines.map((l, i) => (
          <li key={i} className="break-words pl-1">
            {l}
          </li>
        ))}
      </ul>
    );
  return (
    <div className={`grid gap-3 ${READ}`}>
      {lines.map((l, i) => (
        <p key={i} className="break-words">
          {l}
        </p>
      ))}
    </div>
  );
}

/** A post's text as parts: an X thread one part per post ("Post 2 of 5"), else hook, body and call to action. */
export function PostText({ text, titleIsHook }: { text: string; titleIsHook?: boolean }) {
  return (
    <>
      {textParts(text, { titleIsHook }).map((part, k) => (
        <Part key={k} label={part.label} note={part.n ? `Post ${part.n.replace("/", " of ")}` : undefined} testid="post-part">
          <div className={`grid gap-3 ${READ}`}>
            {part.paras.map((para, i) => (
              <Paragraph key={i} para={para} />
            ))}
          </div>
        </Part>
      ))}
    </>
  );
}

/** The Reddit thread title is the post's hook (an X post's title is its first line, already in the text). */
export function postHook(p: Pick<Post, "kind" | "platform" | "community" | "title" | "checks">): string | undefined {
  const b = postBasics(p);
  return b.title && !b.reply && !/^x$/i.test(p.platform) ? b.title : undefined;
}

/** Channel, slot and status of a post, each labelled. */
export function postFacts(p: Post): [string, ReactNode][] {
  const channel = [p.platform || "Not set", p.community && !/^x$/i.test(p.community) ? p.community : ""].filter(Boolean).join(" · ");
  const when = p.slot ? slotWords(p.slot) : isLive(p) && p.date ? slotWords(p.date) : "No time set yet";
  return [
    ["Channel", channel],
    [isLive(p) ? "Went out" : "Slot", when],
    [
      "Status",
      <span key="s" className="inline-flex flex-wrap items-center gap-2">
        <PostBadge p={p} />
        <OutLink href={p.link} />
      </span>,
    ],
  ];
}

/** The whole post in parts: hook, body, call to action, then its image, channel, slot and status. */
export function PostDetail({ p, images, title, page }: { p: Post; images: ReactNode; title?: ReactNode; page?: ReactNode }) {
  const hook = postHook(p);
  return (
    <Parts testid="post-detail">
      {hook ? (
        <Part label="Hook" note="Thread title" testid="post-part">
          <p className={`${READ} text-base font-semibold`}>{title ?? hook}</p>
        </Part>
      ) : null}
      {p.text && p.text !== p.title ? (
        <div className="grid gap-6" data-testid="post-text">
          <PostText text={p.text} titleIsHook={!!hook} />
        </div>
      ) : (
        !hook && (
          <Part label="Text">
            <p className={READ}>{title ?? p.title}</p>
          </Part>
        )
      )}
      {images && <Part label="Image">{images}</Part>}
      {postFacts(p).map(([k, v]) => (
        <Part key={k} label={k} testid="post-fact">
          <div className="text-sm leading-6">{v}</div>
        </Part>
      ))}
      {page && (
        <Part label="More">
          <div className="text-sm leading-6">{page}</div>
        </Part>
      )}
    </Parts>
  );
}

/** One idea in parts: what, why, audience, how to write it, source, and what became of it. */
export function IdeaDetail({ i, used }: { i: SocialIdea; used?: ReactNode }) {
  const parts = ideaParts(i.idea ?? "", i);
  const from = i.from ? (i.from === ownerName() ? "You" : `The ${i.from}`) : undefined;
  const source = [
    ...(from ? [`${from}${i.date ? `, ${dayLabel(i.date)}` : ""}`] : []),
    ...parts.source,
    ...(i.link
      ? [
          <OutLink key="l" href={i.link}>
            {/^https?:\/\/(www\.)?(reddit|x|twitter)\.com/.test(i.link) ? "The thread it came from" : "Where it came from"}
          </OutLink>,
        ]
      : []),
  ];
  return (
    <Parts testid="idea-detail">
      <Part label="What">
        <Lines lines={parts.what} />
      </Part>
      {parts.why.length > 0 && (
        <Part label="Why">
          <Lines lines={parts.why} />
        </Part>
      )}
      {parts.audience.length > 0 && (
        <Part label="Audience">
          <Lines lines={parts.audience} />
        </Part>
      )}
      {parts.how.length > 0 && (
        <Part label="How to write it">
          <Lines lines={parts.how} list />
        </Part>
      )}
      {source.length > 0 && (
        <Part label="Source">
          <Lines lines={source} />
        </Part>
      )}
      {(i.why || used) && (
        <Part label="So far">
          <div className="grid gap-2">
            {i.why && <Lines lines={[i.why]} />}
            {used}
          </div>
        </Part>
      )}
    </Parts>
  );
}
