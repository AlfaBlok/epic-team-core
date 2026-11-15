/**
 * The Company view's switch (parked by default): on when CONSOLE_COMPANY_VIEW=1. Core reads it in the gate and the app;
 * the hosted tenancy module re-exports it. Read per call, so a test can flip it.
 */
export const companyViewOn = (env: NodeJS.ProcessEnv = process.env): boolean => env.CONSOLE_COMPANY_VIEW === "1";
/**
 * the paths that stay while the Company view is parked: a wheel note already sent can still be listed and handled, and
 * the read-only list of the other product worlds' open asks and cards the login belongs to, which the Inbox shows
 * (the owner found none of a day's items came from the social product, though its world had several open), and the
 * home repo's live experiments with their numbers, which the Inbox shows too. The Inbox now reads those two at
 * /api/worlds and /api/experiments (as /api/goals); the old paths stay here for tabs opened before.
 */
export const companyPathStaysOff = (path: string): boolean => /\/companies\/(notes|worlds|experiments)(\/|$)/.test(path);
