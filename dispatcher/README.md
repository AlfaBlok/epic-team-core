# Dispatcher

`t3_seat_pool.py` is the EpicSpine machine dispatcher for one host: point `EPICSPINE_DISPATCHER` in the T3 Code unit
at it. It wraps `broker.py`, which picks the Claude Code seat that runs the next worker.

```sh
python3 dispatcher/t3_seat_pool.py status        # capacity and free seats
python3 dispatcher/t3_seat_pool.py pick          # {"id": "seat2", "via": "t3_delegate_task", "providerInstanceId": ...}
python3 dispatcher/t3_seat_pool.py done seat2    # release it
```

State lives in `$BROKER_HOME` (default `~/.epic-team/broker`): `seats.json` (edit its `seats` to list your seats,
`seat<N>` with config dir `~/.claude_seat<N>`), `heartbeat.log`, and `PAUSE` (present = no picks). The broker only reads
credentials, never writes them.

## Why `pick` returns `{"id": null, "reason": "..."}`

Every launcher queues the work and retries on a null id. The reasons:

1. **No seat with headroom**: `no seat: seat1 limited until ...; seat2 near 5h limit (92%)`.
2. **Team ceiling**: open reservations across all seats reach `BROKER_MAX_TOTAL`.
3. **Low memory on this host**: available memory, minus 600 MB per launch in the last 2 minutes, under the floor.
4. **High load on this host**: the 5-minute load average at or above `DISPATCH_LOAD_PER_CPU` x CPUs.
5. **Session cap on this host**: agent sessions with a turn in flight in T3 Code at `BROKER_MAX_SESSIONS`.
6. **Seat at its cap**: `BROKER_MAX_PER_SEAT` workers already running on it.

Each null answer also says `retryable` and `retry_after_s`.

## Knobs

| env | default |
|---|---|
| `BROKER_HOME` | `~/.epic-team/broker` |
| `BROKER_HOST_NAME` | `local` (the host name in refusal reasons) |
| `BROKER_MAX_TOTAL` | 20 |
| `BROKER_MAX_PER_SEAT` | 10 |
| `BROKER_MAX_SESSIONS` | 6 |
| `BROKER_CONSOLE_DB` | `~/.epic-team/console/console.db` (read-only: each seat's running child runs) |
| `DISPATCH_MEM_FLOOR_MB` | 2000 |
| `DISPATCH_LOAD_PER_CPU` | 2.0 |
| `T3_MCP_URL` | from `~/.t3/userdata/server-runtime.json`, else `http://127.0.0.1:3773/mcp` |

Tests: `python3 dispatcher/test_broker.py` (a temp HOME each case, usage from fixtures, never live state).
