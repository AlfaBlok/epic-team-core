/** One run with every host it could be placed on (the store lists these; runHosts.ts places them). */
export interface HostRunRow {
  id: string;
  startedAt: string;
  endedAt?: string;
  kind?: string;
  host?: string;
  launchHost?: string;
  envHost?: string;
  parentHost?: string;
  parentLaunchHost?: string;
  parentEnvHost?: string;
  seat?: string;
}
