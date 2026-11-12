import type { T3Client } from "./client.js";

/**
 * A second coding host the cycle starts on demand and reaches over a tunnel (the contract is core, our the worker server is
 * the hosted implementation in the hosted second-host module). Moved unchanged from the hosted second-host module.
 */
export interface Vps3Target {
  client: T3Client;
  /** Start the worker server if needed and wait for its T3; throws Vps3Unavailable with a reason. Concurrent calls share one run. */
  ensure(): Promise<void>;
  /** URL a persona on the worker server uses to call this console (the reverse forward's loopback address). */
  publicUrl: string;
  /** The service says whether any the worker server run (wake, child, answer) is open or a wake is imminent. */
  setActivity(fn: () => boolean): void;
  /** Make sure the tunnel is up (no coding start); for reads of an open run. No-op without ssh. */
  touchTunnel(): void;
  /** Periodic: while activity, keep the tunnel up (reopen on drop); close it after idleCloseMs without. Never starts the box. */
  maintain(): void;
  tunnelUp(): boolean;
  /** an ensure (coding start + tunnel + health) is running right now, whoever asked for it. */
  ensuring(): boolean;
  /** `coding status` (read-only; never starts the box). Never rejects. */
  codingStatus(timeoutMs?: number): Promise<{ code: number | null; stdout: string; stderr: string; timedOut?: boolean }>;
  /**
   * one cheap T3 call, only when the tunnel is already up (or the MCP URL is direct). Never opens the tunnel,
   * never starts the box: a cold the worker server answers `not_checked` at once.
   */
  probe(): Promise<{ state: "reachable" | "unreachable" | "not_checked"; detail?: string }>;
  close(): void;
}
