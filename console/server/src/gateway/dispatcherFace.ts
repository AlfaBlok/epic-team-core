import { execFile } from "../spawnHost.js";
import type { DB } from "../db.js";

/**
 * the dispatcher's HTTP face for tenant boxes (plan §6b). A box has no the main server key, so its EPICSPINE_DISPATCHER is
 * the thin client (m0/dispatcher/gateway_client.py), which calls these three routes on the agent gateway with its world's
 * token. Each route runs the very same CLI the console and the worker server use (EPICSPINE_DISPATCHER on the main server: t3_seat_pool.py →
 * broker.py), so the answer is the CLI's stdout byte for byte and the reservations live in the one store (seats.json,
 * providers-state.json): no second pool, no double booking. The world is always the token's: a box never names it.
 *
 *   GET  /api/dispatcher/status                        → `status --world W`
 *   POST /api/dispatcher/pick {persona?, provider?, model?, from?} → `pick --world W [--persona P] [--provider C] [--model M] [--from H]`
 *   POST /api/dispatcher/done {id, failed?}            → `done <id> [--fail]`, only for an id this world picked here
 *
 * `done` is guarded by `gateway_picks`: a world releases only a reservation it picked through the gateway and has not
 * released yet (the broker's `done <seat>` pops the oldest reservation of that seat, whoever made it). A pick older
 * than the stores' stale window (20 min) was already released by them, so its `done` answers `{"ok": true}` without
 * calling the CLI, which would otherwise release someone else's reservation.
 */

export type FaceRunner = (args: string[]) => Promise<string>;
const STALE_MIN = 20; // broker.py and providers.py STALE_MIN
const ARG = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,119}$/; // ids, classes, models, host names; never a flag

/** The CLI runner: `sh -c '<cmd> "$@"'` like t3/dispatcher.ts, so the exact command string the console uses works here. */
export function cliRunner(cmd: string, env: NodeJS.ProcessEnv = process.env): FaceRunner {
  return (args) =>
    new Promise((resolve, reject) =>
      execFile("sh", ["-c", `${cmd} "$@"`, "dispatcher", ...args], { timeout: 30_000, env }, (err, stdout, stderr) =>
        err ? reject(new Error(`dispatcher ${args[0]} failed: ${(stderr || err.message).slice(0, 300)}`)) : resolve(stdout),
      ),
    );
}

export function ensureGatewayPicks(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gateway_picks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL,
      instance TEXT NOT NULL,
      picked_at TEXT NOT NULL,
      done_at TEXT
    );
    CREATE INDEX IF NOT EXISTS gateway_picks_open ON gateway_picks (tenant_id, instance, done_at);
  `);
}

type Answer = { status: 200 | 400 | 404 | 502; body: string };
const json = (status: Answer["status"], v: unknown): Answer => ({ status, body: JSON.stringify(v) });
const err = (status: Answer["status"], code: string, message: string) => json(status, { error: { code, message } });

export function dispatcherFace(db: DB, run: FaceRunner) {
  ensureGatewayPicks(db);
  const call = async (args: string[]): Promise<Answer> => {
    try {
      const out = await run(args);
      JSON.parse(out); // the CLI always prints one JSON line; anything else is a broken dispatcher, not an answer
      return { status: 200, body: out.trim() };
    } catch (e) {
      return err(502, "dispatcher_failed", e instanceof Error ? e.message : String(e));
    }
  };
  const opts = (b: Record<string, unknown>, keys: string[]): string[] | Answer => {
    const out: string[] = [];
    for (const k of keys) {
      const v = b[k];
      if (v === undefined || v === null || v === "") continue;
      if (typeof v !== "string" || !ARG.test(v)) return err(400, "validation_error", `${k} must be a plain id (letters, digits, . _ : @ / -)`);
      out.push(`--${k}`, v);
    }
    return out;
  };

  return {
    status: (world: string) => call(["status", "--world", world]),

    async pick(world: string, b: Record<string, unknown>): Promise<Answer> {
      const extra = opts(b, ["persona", "provider", "model", "from"]);
      if (!Array.isArray(extra)) return extra;
      const a = await call(["pick", "--world", world, ...extra]);
      if (a.status === 200) {
        const id = (JSON.parse(a.body) as { id?: unknown }).id;
        if (typeof id === "string" && id)
          db.prepare("INSERT INTO gateway_picks (tenant_id, instance, picked_at) VALUES (?, ?, ?)").run(world, id, new Date().toISOString());
      }
      return a;
    },

    async done(world: string, b: Record<string, unknown>): Promise<Answer> {
      const id = b.id;
      if (typeof id !== "string" || !ARG.test(id)) return err(400, "validation_error", "id must be the id a pick returned");
      const row = db
        .prepare("SELECT id, picked_at FROM gateway_picks WHERE tenant_id = ? AND instance = ? AND done_at IS NULL ORDER BY id LIMIT 1")
        .get(world, id) as { id: number; picked_at: string } | undefined;
      if (!row) return err(404, "not_picked", `${id} has no open reservation picked by this world through the gateway`);
      db.prepare("UPDATE gateway_picks SET done_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
      if (Date.now() - Date.parse(row.picked_at) > STALE_MIN * 60_000) return { status: 200, body: JSON.stringify({ ok: true }) };
      const a = await call(["done", id, ...(b.failed === true ? ["--fail"] : [])]);
      if (a.status !== 200) db.prepare("UPDATE gateway_picks SET done_at = NULL WHERE id = ?").run(row.id); // retry may release it
      return a;
    },
  };
}
export type DispatcherFace = ReturnType<typeof dispatcherFace>;
