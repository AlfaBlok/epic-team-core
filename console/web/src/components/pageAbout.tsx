import { Fragment, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { DeckAbout, PageKeeper, RocksAbout } from "@/api";
import { RelTime } from "@/components/common";
import { useWords } from "@/lib/skin";
import { githubRepoUrl, homeRepo, hostOf, memoryName, ownerName, sites } from "@/lib/identity";

/**
 * the epic decks and the big rocks board say on screen who keeps them, on which milestone, how often, which
 * repo they come from and where his voice notes come from (the memory service), with a link to the persona's settings. One line on
 * the page; the rest in an "About this page" fold. The data comes from the server (deck/about.ts), read from the repos.
 */


/** A persona's name, linked to its settings (its Edit dialog on Personas). */
export function KeeperName({ k }: { k: PageKeeper }) {
  if (!k.personaId) return <span className="font-medium">{k.name}</span>;
  return (
    <Link to={`/personas?edit=${encodeURIComponent(k.personaId)}`} className="font-medium underline" data-testid="about-persona">
      {k.name}
    </Link>
  );
}

/** "the Gap finder, every day at 13:00 Madrid time on the code repo · the code repo (its settings)". */
function KeeperLine({ k }: { k: PageKeeper }) {
  const w = useWords();
  return (
    <>
      <KeeperName k={k} />
      {k.cadence && `, ${k.cadence}`}
      {k.enabled === false && " (switched off)"}
      {k.milestone && (
        <>
          {" "}
          on the {w.milestone}{" "}
          <Link to={`/milestones/${k.milestoneId}?tab=personas`} className="underline">
            {k.milestone}
          </Link>
        </>
      )}
    </>
  );
}

const names = (ks: PageKeeper[]) =>
  ks.map((k, i) => (
    <Fragment key={k.personaId ?? k.name}>
      {i > 0 && (i === ks.length - 1 ? " and " : ", ")}
      <KeeperName k={k} />
    </Fragment>
  ));

function Fold({ children, line, testId }: { children: ReactNode; line: ReactNode; testId: string }) {
  return (
    <div className="mb-3 min-w-0 text-sm text-muted-foreground" data-testid={testId}>
      <p className="[overflow-wrap:anywhere]" data-testid={`${testId}-line`}>
        {line}
      </p>
      <details className="mt-1">
        <summary className="cursor-pointer select-none text-xs underline">About this page</summary>
        <ul className="mt-2 grid list-disc gap-1.5 pl-5 text-xs [overflow-wrap:anywhere]">{children}</ul>
      </details>
    </div>
  );
}

function RocksItem({ r }: { r: RocksAbout }) {
  return (
    <li data-testid="about-rocks">
      The big rocks come from{" "}
      <a href={`${githubRepoUrl()}/blob/main/${r.file}`} target="_blank" rel="noreferrer" className="underline">
        {r.file}
      </a>{" "}
      in {r.repo}. {r.keeper ? <>It is kept by <KeeperLine k={r.keeper} />. </> : "No persona keeps it yet. "}
      {r.refresh && `${r.refresh}. `}
      {r.sources && `${r.sources}.`}
      {r.lastRead && ` Last read on ${r.lastRead}.`}
    </li>
  );
}

const memoryAbout = () =>
  `${memoryName()} is only where ${ownerName()}'s voice notes are kept, as his shared memory. The board, the decks and the personas that keep them belong to ${homeRepo()}, ${ownerName()}'s team console.`;

/** The epic deck's line and fold. */
export function DeckAboutBlock({ a, code }: { a: DeckAbout; code: string }) {
  const w = useWords();
  const line = (
    <>
      From the {a.repo} spine {code}.{" "}
      {a.workers.length ? (
        <>
          Worked by {names(a.workers)}
          {a.milestone && ` on ${a.milestone.title}`}.{" "}
        </>
      ) : (
        "No persona works this epic yet. "
      )}
      The console rebuilds it every day at {a.refresh.at}.
    </>
  );
  return (
    <Fold line={line} testId="deck-about">
      <li>
        This page lives on {ownerName()}'s team console, {typeof location !== "undefined" && location.hostname ? location.hostname : hostOf(sites().teamUrl)}. It is built from the spine{" "}
        <a href={`${githubRepoUrl(a.repo)}/blob/main/${a.spinePath}`} target="_blank" rel="noreferrer" className="underline">
          {a.spinePath}
        </a>{" "}
        in the {a.repo} repo. Nobody types on it by hand: change the spine and the deck changes.
      </li>
      <li data-testid="about-workers">
        {a.milestone ? (
          <>
            The epic is worked by the personas on the {w.milestone}{" "}
            <Link to={`/milestones/${a.milestone.id}?tab=personas`} className="underline">
              {a.milestone.title}
            </Link>
            {a.milestone.own ? "" : `, the nearest ${w.milestone} above this spine`}:{" "}
          </>
        ) : (
          `No console ${w.milestone} tracks this spine or any spine above it, so no persona works it yet.`
        )}
        {a.workers.map((k, i) => (
          <Fragment key={k.personaId ?? k.name}>
            {i > 0 && "; "}
            <KeeperName k={k} />
            {k.cadence && ` ${k.cadence}`}
            {k.enabled === false && " (switched off)"}
          </Fragment>
        ))}
        {a.milestone && "."}
      </li>
      <li>
        The daily refresh rebuilds every deck at {a.refresh.at}. It is a console job, not a persona: it pulls the repos and reads the spines again. A spine change shows within about 5 minutes.
        {a.refresh.lastOkAt && (
          <>
            {" "}
            Last run <RelTime iso={a.refresh.lastOkAt} />.
          </>
        )}
      </li>
      {a.rocks && <RocksItem r={a.rocks} />}
      <li>{memoryAbout()}</li>
    </Fold>
  );
}

/** The big rocks board's line and fold. */
export function RocksAboutBlock({ r }: { r: RocksAbout }) {
  const line = (
    <>
      {r.keeper ? (
        <>
          Kept by the <KeeperName k={r.keeper} />
          {r.keeper.milestone && ` on ${r.keeper.milestone}`}
        </>
      ) : (
        "No persona keeps this board yet"
      )}
      , from {ownerName()}'s voice notes in {memoryName()}. It lives in {r.repo}, {r.file}.
    </>
  );
  return (
    <Fold line={line} testId="rocks-about">
      <li>
        This board lives on {ownerName()}'s team console, {typeof location !== "undefined" && location.hostname ? location.hostname : hostOf(sites().teamUrl)}. It is read from{" "}
        <a href={`${githubRepoUrl()}/blob/main/${r.file}`} target="_blank" rel="noreferrer" className="underline">
          {r.file}
        </a>{" "}
        in the {r.repo} repo, and each rock sits on the first slide of the epic decks it touches.
      </li>
      <li data-testid="about-keeper">
        {r.keeper ? (
          <>
            It is kept by <KeeperLine k={r.keeper} />.{" "}
          </>
        ) : (
          "No persona keeps it yet. "
        )}
        {r.refresh && `${r.refresh}.`}
      </li>
      {r.sources && <li>{r.sources}.</li>}
      <li>{memoryAbout()}</li>
    </Fold>
  );
}
