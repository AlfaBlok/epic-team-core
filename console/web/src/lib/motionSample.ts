import { ownerName } from "@/lib/identity";
/** a sample product deck and two campaign spines for the mock and the tests (the real ones live in each social repo). */
/** the sample deck with an `Every feature` part (a `Features:` line) before its price, for the mock and its test. */
export const withFeatures = (deck: string, service = "socialapp") => deck.replace("## How much it costs", `## Every feature\nFeatures: ${service}\n\n## How much it costs`);

/** a sample feature list (the shape of the code repo docs/features/<service>.json, which only the server reads). */
export const sampleFeatureList = {
  service: "SocialApp",
  title: "What SocialApp does for you",
  source: "docs/features/socialapp.json",
  href: "https://github.com/Acme/home_repo/blob/main/docs/features/socialapp.json",
  groups: [
    {
      id: "campaign-at-a-glance",
      title: "Your campaign at a glance",
      intro: "See every post, every number and why the campaign exists, each in one screen.",
      features: [
        { id: "pipeline", title: "One pipeline for every post", text: "Every post sits in a column by its stage, from idea to posted.", rows: ["E974-S1"] },
        { id: "performance", title: "A Performance page", text: "Daily lines of posts, replies, followers and sign-ups.", rows: ["E946-S17"] },
      ],
    },
    {
      id: "you-decide",
      title: "You decide what goes out",
      features: [{ id: "approve-in-inbox", title: "Approve posts in your inbox", text: "A post waiting for you is a card in the same inbox as everything else.", rows: ["E934-S24"] }],
    },
  ],
};

export const sampleProduct = `# SocialApp: the product deck

## Why it exists
Builders who run Reddit and X for a side project struggle to show up every day.

## Who it is for
Founders, small businesses and creators.

## How it works
1. An idea. 2. Research. 3. A draft. 4. Your OK. 5. Posted.

## What it does for you
${ownerName()}'s seven benefit lines live in data/brief.md, Benefits.

## What is included
Scout, Writer, Publisher, Responder and Reporter.

## How much it costs
€99 a month, planned. Testers pay $10 once for the month.

## How you get it
Apply at https://epicspine.dev/testers/.

## How it differs
Your files stay yours. The engine is open source.
`;

export const sampleMotionSpines = [
  {
    rel: "docs/spines/root.md",
    text: `# EPIC-900: Epic campaign\n\n## Campaign plan\n\nMetric: site_visitors 500 by 2026-11-23 from 2026-11-08 (proposed: ${ownerName()} sets it)\n`,
  },
  {
    rel: "docs/spines/campaign-get-testers.md",
    text: "# EPIC-901: Get testers\n\n## Campaign plan\n\nCampaign tag: `EPIC-901`\nPeriod: 2026-11-04 to 2026-11-17\nMetric: testers 10 by 2026-11-17\n",
  },
];

/** a sample campaign product deck (Get testers), docs/campaigns/epic-901/product.md in the real repo. */
export const sampleCampaignProduct = `# Get testers: the campaign deck

## What we push
Five builders run SocialApp on their own Reddit and X this November, for free.

Stat: live:target | applications so far, of 10 by 17 Nov
Stat: 5 | free tester seats

One objective: people apply at https://epicspine.dev/testers/.

## Why now
November is the launch window.

- Nobody outside us has tried it yet.

## Who it is for
Builders with a side project who post on Reddit and X.

## The offer
Free for 5 teams, for four weeks.

## Proof
Real screens from today.

Stat: 13 | Memo posts out since September
Screen: data/assets/A-36-testers-page.png | The testers page

## The plan
The call goes out the day the launch is locked.

## Where we stand
The call is written and held.

Stat: live:posts_out | posts out

## What we say and never say
Say: you approve every post. Never: growth promises or numbers we have not measured.
`;
