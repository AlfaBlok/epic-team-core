/**
 * The Company view's switch (parked by default): on when CONSOLE_COMPANY_VIEW=1. Core reads it in the gate and the app;
 * the hosted tenancy module re-exports it. Read per call, so a test can flip it.
 */
export const companyViewOn = (env: NodeJS.ProcessEnv = process.env): boolean => env.CONSOLE_COMPANY_VIEW === "1";
/** the paths that stay while the Company view is parked: a wheel note already sent can still be listed and handled. */
export const companyPathStaysOff = (path: string): boolean => /\/companies\/notes(\/|$)/.test(path);
