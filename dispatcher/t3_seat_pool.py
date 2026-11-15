#!/usr/bin/env python3
"""EpicSpine machine dispatcher for one team on one server (adapted from epicspine-skill examples/dispatchers/t3_seat_pool.py).

Wire it with EPICSPINE_DISPATCHER in the T3 Code unit. It wraps broker.py: `pick`, `done`, `status`, `sessions` and
`probe` are translated to the dispatcher contract (a null seat becomes id null).
Broker path: --broker PATH, env SEAT_POOL_BROKER, else broker.py next to this file.

Every `id: null` answer carries `retryable` and `retry_after_s` next to `reason` (the broker's own classification
when it gave one, else classed here, see refusal()). `sessions` passes the broker's read-only JSON through (live agent
sessions on this host vs its cap); `probe` passes its read-only "would a pick get a seat now" answer through.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys


DEFAULT_BROKER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "broker.py")


HOST_CAP_RE = re.compile(r"^(high load|low memory|session cap) on \S+:|unreachable", re.I)
RETRYABLE_RE = re.compile(r"^team worker ceiling|^no seat\b|all seats busy|maxed|at capacity", re.I)


def refusal(reason: str, got: dict | None = None) -> dict:
    """`{id: null, reason, retryable, retry_after_s}`: the broker's classification when it gave one, else
    host cap / unreachable 60 s, seats / ceiling / at capacity 120 s, else final."""
    if got and "retryable" in got:
        return {"id": None, "reason": reason, "retryable": got["retryable"], "retry_after_s": got.get("retry_after_s")}
    if HOST_CAP_RE.search(reason):
        return {"id": None, "reason": reason, "retryable": True, "retry_after_s": 60}
    if RETRYABLE_RE.search(reason):
        return {"id": None, "reason": reason, "retryable": True, "retry_after_s": 120}
    return {"id": None, "reason": reason, "retryable": False, "retry_after_s": None}


def broker(path: str, *args: str) -> str:
    return subprocess.run([sys.executable, path, *args], capture_output=True, text=True, check=True, timeout=15).stdout


def main(argv: list[str]) -> int:
    path = os.environ.get("SEAT_POOL_BROKER") or DEFAULT_BROKER
    if argv[:1] == ["--broker"]:
        path, argv = argv[1], argv[2:]
    if not argv:
        print("usage: t3_seat_pool.py [--broker PATH] status|pick|done|sessions|probe ...", file=sys.stderr)
        return 1
    cmd, rest = argv[0], argv[1:]
    if cmd == "status":
        got = json.loads(broker(path, "status"))  # broker status is JSON: name, capacity, available, seats
        out = {k: got[k] for k in ("name", "capacity", "available", "ceiling", "open") if k in got}
        if got.get("set_aside"):  # only while a seat is set aside, so older answers stay identical
            out["set_aside"] = got["set_aside"]
    elif cmd == "pick":
        # the broker refuses on the team ceiling and, for local calls, on low memory here; `--from <host>` means
        # that host already checked its own memory, so the broker skips this host's check
        src = rest[rest.index("--from") + 1:rest.index("--from") + 2] if "--from" in rest else []
        got = json.loads(broker(path, "pick", *(["--from", src[0]] if src else [])))
        if got.get("seat"):
            out = {"id": got["seat"], "via": "t3_delegate_task", "providerInstanceId": got["providerInstanceId"]}
        else:
            out = refusal("paused" if got.get("paused") else got.get("reason") or "all seats busy or maxed", got)
        if got.get("set_aside"):  # seats set aside after a failed sign-in, {seat: until}
            out["set_aside"] = got["set_aside"]
    elif cmd in ("sessions", "probe"):
        out = json.loads(broker(path, cmd))
    elif cmd == "done":
        broker(path, "done", *rest)
        out = {"ok": True}
    else:
        return 1
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
