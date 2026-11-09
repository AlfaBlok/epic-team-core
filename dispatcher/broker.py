#!/usr/bin/env python3
"""Seat broker (stdlib only): picks which agent seat (a Claude Code login) runs the next worker on this host.
State: $BROKER_HOME/seats.json (default ~/.epic-team/broker), log: $BROKER_HOME/heartbeat.log.

  broker.py beat                      new beat: refresh seats, log it, pick the best seat, reserve it, print JSON
  broker.py hello <seat> [beat]       child task: append '<ts> hello from seat-N' and release the seat (ok)
  broker.py done <seat> [--fail] [--signal TEXT] [--limit-until ISO]
                                      release a seat; failure text that looks like a usage limit marks it maxed
  broker.py limit <seat> --until ISO [--signal TEXT]
  broker.py usage                     read every seat's usage now (OAuth usage endpoint), store it, print JSON
  broker.py status                    read-only JSON: {"name","capacity","available","seats":{...}} (EpicSpine dispatcher contract)
  broker.py sessions                  read-only JSON: live agent sessions on this host vs its session cap
  broker.py probe                     read-only JSON: would a local pick get a seat right now

Seats: the "seats" of seats.json (seat<N> -> {"providerInstanceId": "claudeAgent_seat<N>"}); the first run writes
DEFAULT below, edit it to list your own seats. Each seat's Claude Code config dir is ~/.claude_<seat>.

Pick rule: a seat is eligible while logged in, not limited (maxed_until), usage known, 5h% < NEAR_5H and below the
per-seat cap (BROKER_MAX_PER_SEAT running workers, default 10). Score = headroom - IN_FLIGHT_PENALTY * running, with
headroom = min(100 - 5h%, 100 - weekly%) and running = max(the seat's open pick reservations, the console's running
child runs on that seat; the console DB is read read-only, unreadable = reservations only). A seat whose turn could
not start (`done --fail --signal` text matching START_FAIL_RE) is avoided for START_FAIL_COOLDOWN s while another seat
is eligible. Highest score wins, tie -> least recently used. `status` counts available/free with the same eligibility.
A seat whose usage is unknown only because its access token expired, with a refresh token stored, stays eligible as
long as no worker runs on it: it scores as EXPIRED_HEADROOM headroom, so its next session refreshes the token. `pick`
also starts, detached, `refresh-token <seat>` for one expired seat: a one-word `claude -p` turn (haiku, no MCP
servers) under that seat's CLAUDE_CONFIG_DIR, which renews the token through Claude Code itself (the broker never
writes credentials). At most one refresh start per TOKEN_REFRESH_GAP s, each seat at most once per
TOKEN_REFRESH_COOLDOWN s, never at the session cap. Tests: BROKER_REFRESH_CMD replaces the claude command.
`pick` and `beat` read usage fresh first: GET api.anthropic.com/api/oauth/usage (what Claude Code's /usage
reads; no model call) with the access token in ~/.claude_<seat>/.credentials.json. Read-only: the broker
never refreshes or writes credentials; an expired token, missing credentials, or any read error marks the
seat unknown with a reason (never 0%). A limited window sets maxed_until to its reset time. `beat` also
refreshes `claude auth status` (loggedIn). Reactive failover: `done --fail --signal` text that matches a
limit message sets maxed_until (reset time in the text, else +1h). Reservations older than STALE_MIN are
released (lost child). Usage reads are cached USAGE_TTL s per seat; a failed read keeps the last good values
(stale=true + stale_reason, last_ok_at) for up to USAGE_STALE_MAX s, then unknown; HTTP 429 sets usage_backoff_until
(+USAGE_BACKOFF s, no read until then). Tests: SEAT_BROKER_USAGE_FIXTURE=file.json ({seat: usage response | {"error": ..}})
replaces the HTTP read ({"error": .., "http": 429} simulates a 429; each fixture read appends to <fixture>.calls).

Why `pick` returns {"id": null, "reason": ...} (every launcher queues and retries on it):
  1. no seat with headroom (reason "no seat: ...", see skip_reason)
  2. team ceiling: open reservations across all seats >= BROKER_MAX_TOTAL (default 20)
  3. low memory on the launching host: MemAvailable - 600 MB per launch from this host in the last 2 min
     < DISPATCH_MEM_FLOOR_MB (default 2000). `pick --from <host>` means another host already checked its own
     memory and skips this check. Tests: DISPATCH_MEMINFO=file replaces /proc/meminfo.
  4. high CPU load on the launching host: 5-min load average >= DISPATCH_LOAD_PER_CPU (default 2.0) x CPUs, reason
     "high load on <host>: load5 <x> on <n> CPUs (cap <c>)"; local picks only (`--from` skips it like memory).
     Unreadable loadavg never blocks. Tests: DISPATCH_LOADAVG=file replaces /proc/loadavg, DISPATCH_NPROC the CPU count.
  5. agent session cap on this host: threads with an active turn on this host's T3 Code (statuses
     preparing/queued/starting/running, every project, subagents included; the T3 MCP server with $BROKER_HOME/.t3token,
     cached SESSIONS_TTL s) plus local launches in the last SESSION_LAUNCH_WINDOW s (picked, not yet visible)
     >= BROKER_MAX_SESSIONS (default 6), reason "session cap on <host>: <n> live (cap <c>)"; local picks only.
     <n> is the larger of those turns and the live provider processes (claude/codex children of T3, idle ones
     included). Unreadable T3 never blocks. `broker.py sessions` prints the count as JSON. Tests: DISPATCH_SESSIONS=file
     ({"live": n} or a number) replaces the T3 read.
  The console reads these reasons: any refusal but "paused" is a deferred wake retried with backoff, never a failed one.
Every `id: null` answer also carries `retryable` (load, memory, session cap, team ceiling, all seats busy/maxed,
unreachable = true; paused = false) and `retry_after_s` (60 for a host cap or unreachable, 120 for seats/ceiling, null
when not retryable); `reason` is unchanged.
`probe` (read-only, no reservation, no state write) answers whether a local pick would get a seat right now:
{"host": "<host>", "ok": bool, "reason"?, "retryable"?, "retry_after_s"?}.
"""
import fcntl, json, os, re, shutil, subprocess, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

HOME = os.environ.get("BROKER_HOME") or os.path.expanduser("~/.epic-team/broker")
SEATS, LOG = os.path.join(HOME, "seats.json"), os.path.join(HOME, "heartbeat.log")
PAUSE = os.path.join(HOME, "PAUSE")  # presence of this file makes `beat` a no-op (second kill switch)
USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
LIMIT_RE = re.compile(r"hit your (session |weekly |usage |5-hour |five-hour )?limit|usage limit|rate.?limit|limit reached|session limit|quota", re.I)  # console USAGE_LIMIT mirrors it
STALE_MIN = 20
NEAR_5H = 90  # skip a seat at or above this 5h utilization
IN_FLIGHT_PENALTY = 10  # score points per running worker (5 -> 10, spread wider)
MAX_PER_SEAT = int(os.environ.get("BROKER_MAX_PER_SEAT", 10))  # running workers per seat = ceiling / 2 seats (no account limit found)
CONSOLE_DB = os.environ.get("BROKER_CONSOLE_DB", os.path.expanduser("~/.epic-team/console/console.db"))
CONSOLE_LIVE_H = 3  # a console child run counts as running for this long (the console's stale limit)
START_FAIL_RE = re.compile(r"could not start this turn|did not answer the MCP server registration|ProviderAdapterTurnStartError", re.I)
EXPIRED_HEADROOM = 50  # assumed headroom of an idle seat whose token expired (its next session refreshes it)
TOKEN_REFRESH_GAP = 90  # seconds between two token-refresh sessions started on this host
TOKEN_REFRESH_COOLDOWN = 30 * 60  # a seat whose refresh did not help is tried again after this long
START_FAIL_COOLDOWN = 600  # seconds a seat whose turn could not start is avoided while another seat is eligible
USAGE_TTL = 120  # reuse a successful usage read this many seconds (no HTTP call)
USAGE_STALE_MAX = 15 * 60  # on a failed read keep the last good values this long (stale), then unknown
USAGE_BACKOFF = 60  # after HTTP 429 make no read for this many seconds
MAX_TOTAL = int(os.environ.get("BROKER_MAX_TOTAL", 20))  # team-wide ceiling on open reservations
MEM_FLOOR_MB = int(os.environ.get("DISPATCH_MEM_FLOOR_MB", 2000))  # this host's memory floor
MEM_PER_LAUNCH_MB = 600  # a launch not yet visible in MemAvailable
LAUNCH_WINDOW = 120  # seconds a launch counts as not yet visible
HOST = os.environ.get("BROKER_HOST_NAME") or "local"
MAX_SESSIONS = int(os.environ.get("BROKER_MAX_SESSIONS", 6))  # concurrent agent sessions on this host
ACTIVE_STATUSES = ["preparing", "queued", "starting", "running"]  # a T3 thread with a turn in flight
SESSIONS_TTL = 20  # seconds a T3 session count is reused (pick, status and the console's check share it)
SESSION_LAUNCH_WINDOW = 60  # seconds a local pick counts as a session before its thread shows up in T3
SESSIONS_CACHE = os.path.join(HOME, "sessions.json")
DEFAULT = {"beat": 0, "seats": {n: {"providerInstanceId": "claudeAgent_" + n} for n in ("seat1", "seat2", "seat3", "seat5", "seat7")}}
FIELDS = {"runs": 0, "ok": 0, "failed": 0, "in_flight": 0, "reservations": [], "last_used": None,
          "maxed_until": None, "logged_in": None, "auth_checked": None, "usage": None,
          "last_signal": None, "last_error": None, "usage_backoff_until": None, "running": 0,
          "console_running": None, "start_failed_until": None}


def now():
    return datetime.now(timezone.utc)


def ts(t=None):
    return (t or now()).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse(s):
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc) if s else None


class State:
    def __enter__(self):
        self.lock = open(SEATS + ".lock", "w")
        fcntl.flock(self.lock, fcntl.LOCK_EX)
        try:
            self.d = json.load(open(SEATS))
        except (OSError, ValueError):
            self.d = json.loads(json.dumps(DEFAULT))
        for s in self.d["seats"].values():
            for k, v in FIELDS.items():
                s.setdefault(k, json.loads(json.dumps(v)))
        return self

    def __exit__(self, *a):
        self.d["updated"] = ts()
        tmp = SEATS + ".tmp"
        json.dump(self.d, open(tmp, "w"), indent=2)
        os.replace(tmp, SEATS)
        self.lock.close()


def log(line):
    with open(LOG, "a") as f:
        f.write(line + "\n")


def release_stale(d):
    cut = now() - timedelta(minutes=STALE_MIN)
    for n, s in d["seats"].items():
        keep = [r for r in s["reservations"] if parse(r) > cut]
        if len(keep) != len(s["reservations"]):
            s["last_error"] = "released %d stale reservation(s) at %s" % (len(s["reservations"]) - len(keep), ts())
        s["reservations"], s["in_flight"] = keep, len(keep)
        if s["maxed_until"] and parse(s["maxed_until"]) <= now():
            s["maxed_until"] = None


def refresh_auth(d):
    for n, s in d["seats"].items():
        env = dict(os.environ, CLAUDE_CONFIG_DIR=os.path.expanduser("~/.claude_" + n))
        try:
            r = subprocess.run(["claude", "auth", "status"], env=env, capture_output=True, text=True, timeout=30)
            j = json.loads(r.stdout)
            s["logged_in"], s["subscription"], s["org"] = j.get("loggedIn"), j.get("subscriptionType"), j.get("orgName")
        except Exception as e:  # keep previous value, record why
            s["last_error"] = "auth status failed: %s" % e
        s["auth_checked"] = ts()


class UsageError(RuntimeError):
    def __init__(self, msg, http=None):
        super().__init__(msg)
        self.http = http


class TokenExpired(RuntimeError):
    """the access token expired; refreshable = a refresh token is stored (the next session renews it)."""
    def __init__(self, msg, refreshable):
        super().__init__(msg)
        self.refreshable = refreshable


def read_usage(seat):
    """One seat's usage from the OAuth usage endpoint (or the test fixture). Raises with a reason on failure."""
    fx = os.environ.get("SEAT_BROKER_USAGE_FIXTURE")
    if fx:
        with open(fx + ".calls", "a") as f:
            f.write(seat + "\n")
        j = json.load(open(fx)).get(seat)
        if j and j.get("token_expired"):
            raise TokenExpired("access token expired at %s (broker never refreshes; the seat's next session does)"
                               % j.get("expired_at", "?"), bool(j.get("refreshable", True)))
        if not j or "error" in j:
            raise UsageError((j or {}).get("error", "no fixture for " + seat), (j or {}).get("http"))
        return j
    try:
        o = json.load(open(os.path.expanduser("~/.claude_%s/.credentials.json" % seat)))["claudeAiOauth"]
        tok = o["accessToken"]
    except Exception as e:
        raise RuntimeError("no credentials (logged out?): %s" % e)
    if o.get("expiresAt") and o["expiresAt"] / 1000 <= now().timestamp() + 60:
        raise TokenExpired("access token expired at %s (broker never refreshes; the seat's next session does)"
                           % ts(datetime.fromtimestamp(o["expiresAt"] / 1000, timezone.utc)), bool(o.get("refreshToken")))
    req = urllib.request.Request(USAGE_URL, headers={"Authorization": "Bearer " + tok, "anthropic-beta": "oauth-2025-04-20",
                                                     "Content-Type": "application/json", "User-Agent": "epic-team-broker"})
    try:
        with urllib.request.urlopen(req, timeout=5) as f:
            return json.load(f)
    except urllib.error.HTTPError as e:
        raise UsageError("usage endpoint HTTP %d" % e.code, e.code)


def iso(s):
    return ts(datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)) if s else None


def parse_usage(j):
    fh = j.get("five_hour") or {}
    if fh.get("utilization") is None:
        raise RuntimeError("no five_hour utilization in response")
    # general (all-models) weekly only: a weekly_all limits row, else seven_day, else not metered (Team seats)
    lims = [l for l in j.get("limits") or [] if l.get("percent") is not None]
    wa = next((l for l in lims if l.get("kind") == "weekly_all"), None)
    wk = j.get("seven_day")
    if wa:
        w_pct, w_reset, w_src = wa["percent"], iso(wa.get("resets_at")), "weekly_all"
    elif wk and wk.get("utilization") is not None:
        w_pct, w_reset, w_src = wk["utilization"], iso(wk.get("resets_at")), "seven_day"
    else:
        w_pct, w_reset, w_src = None, None, "not metered"
    # model-scoped weekly rows (e.g. Fable) are informational: they never affect headroom, status or limited_until
    mw = {(((l.get("scope") or {}).get("model") or {}).get("display_name") or "unknown"):
          {"pct": l["percent"], "resets_at": iso(l.get("resets_at"))} for l in lims if l.get("kind") == "weekly_scoped"}
    u = {"known": True, "reason": None, "source": "oauth_usage", "five_hour_pct": fh["utilization"],
         "five_hour_resets_at": iso(fh.get("resets_at")), "weekly_pct": w_pct, "weekly_resets_at": w_reset,
         "weekly_source": w_src, "model_weekly": mw, "status": "allowed", "limited_until": None,
         "utilization": {"five_hour": round(fh["utilization"] / 100, 4)}}  # legacy 0-1 field read by status
    if fh.get("locked_reason") or fh["utilization"] >= 100:
        u["status"], u["limited_until"] = "limited", u["five_hour_resets_at"]
    if w_pct is not None and w_pct >= 100:
        u["status"] = "limited"
        u["limited_until"] = max(filter(None, [u["limited_until"], w_reset]), default=None)
    return u


def age(at):
    return (now() - parse(at)).total_seconds() if at else None


def refresh_usage(d):
    """Usage per seat (parallel, read-only): cached USAGE_TTL s; a failed read (or 429 backoff) keeps the last good
    values marked stale for up to USAGE_STALE_MAX s, then unknown with a reason, never 0%."""
    t = ts()
    def one(n):
        s = d["seats"][n]
        prev = s["usage"] or {}
        ok_at = (prev.get("last_ok_at") or prev.get("read_at")) if prev.get("known") else None
        if ok_at and not prev.get("stale") and age(ok_at) < USAGE_TTL:
            return None  # cached, no HTTP call
        expired = False
        if s["usage_backoff_until"] and s["usage_backoff_until"] > t:
            err = "usage endpoint HTTP 429, backoff until " + s["usage_backoff_until"]
        else:
            try:
                u = parse_usage(read_usage(n))
                u["read_at"] = u["last_ok_at"] = t
                return u
            except Exception as e:
                err = str(e)
                expired = getattr(e, "refreshable", False)
                if getattr(e, "http", None) == 429:
                    s["usage_backoff_until"] = ts(now() + timedelta(seconds=USAGE_BACKOFF))
        if ok_at and age(ok_at) < USAGE_STALE_MAX:
            return dict(prev, stale=True, stale_reason=err, last_ok_at=ok_at, read_at=t)
        u = {"known": False, "reason": err, "five_hour_pct": None, "weekly_pct": None, "status": "unknown", "read_at": t}
        if expired:
            u["token_expired"] = True  # refreshable, an idle seat stays eligible (expired_ok)
        return u
    names = sorted(d["seats"])
    with ThreadPoolExecutor(len(names) or 1) as ex:
        got = dict(zip(names, ex.map(one, names)))
    for n, u in got.items():
        if u is None:
            continue
        s = d["seats"][n]
        s["usage"] = u
        if u["status"] == "limited":
            s["maxed_until"] = u["limited_until"] or ts(now() + timedelta(hours=1))


def console_running():
    """running child runs per seat from the console DB (read-only, all worlds), or None when unreadable."""
    import sqlite3
    try:
        if not os.path.exists(CONSOLE_DB):
            return None
        c = sqlite3.connect("file:%s?mode=ro" % CONSOLE_DB, uri=True, timeout=3)
        try:
            cut = (now() - timedelta(hours=CONSOLE_LIVE_H)).strftime("%Y-%m-%dT%H:%M:%S")
            rows = c.execute("SELECT seat, COUNT(*) FROM runs WHERE outcome = 'running' AND parent_run_id IS NOT NULL "
                             "AND seat IS NOT NULL AND started_at > ? GROUP BY seat", (cut,)).fetchall()
        finally:
            c.close()
        return {seat: n for seat, n in rows}
    except Exception:
        return None


def count_running(d, live=None):
    """running = max(open reservations, console running child runs) per seat; live=None reads the console DB."""
    live = console_running() if live is None else live
    for n, s in d["seats"].items():
        s["console_running"] = None if live is None else live.get(n, 0)
        s["running"] = max(s["in_flight"], s["console_running"] or 0)


def headroom(s):
    u = s["usage"] or {}
    if not u.get("known") or u.get("five_hour_pct") is None:
        return None
    if u.get("weekly_pct") is None:
        return 100 - u["five_hour_pct"]
    return min(100 - u["five_hour_pct"], 100 - u["weekly_pct"])


def expired_ok(s):
    """usage unknown only because the token expired (refresh token stored) -> pickable while idle."""
    return headroom(s) is None and bool((s["usage"] or {}).get("token_expired"))


def score(s):
    return (EXPIRED_HEADROOM if expired_ok(s) else headroom(s)) - IN_FLIGHT_PENALTY * s.get("running", s["in_flight"])


def refresh_due(d, host_ok=True):
    """the expired seat (refresh token stored) whose token-refresh session should start now, or None.
    Marks it started in d (call under the State lock)."""
    if not host_ok or (d.get("token_refresh_at") and age(d["token_refresh_at"]) < TOKEN_REFRESH_GAP):
        return None
    due = sorted((s.get("token_refresh_at") or "", n) for n, s in d["seats"].items()
                 if (s["usage"] or {}).get("token_expired") and s["logged_in"] is not False
                 and not (s.get("token_refresh_at") and age(s["token_refresh_at"]) < TOKEN_REFRESH_COOLDOWN))
    if not due:
        return None
    n = due[0][1]
    d["token_refresh_at"] = d["seats"][n]["token_refresh_at"] = ts()
    return n


def start_refresh(seat):
    """detached `broker.py refresh-token <seat>` (outlives the pick, never blocks it)."""
    subprocess.Popen([sys.executable, os.path.abspath(__file__), "refresh-token", seat], stdin=subprocess.DEVNULL,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)


def refresh_token(seat):
    """one tiny Claude Code turn under the seat's config dir; Claude Code renews the expired token itself."""
    cmd = os.environ.get("BROKER_REFRESH_CMD")
    claude = shutil.which("claude") or os.path.expanduser("~/.local/bin/claude")  # an ssh PATH may lack ~/.local/bin
    cmd = cmd.split() if cmd else [claude, "-p", "--model", "haiku", "--max-turns", "1", "--strict-mcp-config",
                                   "Reply with the single word: ok"]
    env = dict(os.environ, CLAUDE_CONFIG_DIR=os.path.expanduser("~/.claude_" + seat))
    try:
        r = subprocess.run(cmd, env=env, cwd=HOME, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=180)
        res = "rc=%d" % r.returncode
    except Exception as e:
        res = "error %s" % type(e).__name__
    log("%s token refresh session for %s: %s" % (ts(), seat, res))
    return res


def snapshot(d):
    out = []
    for n, s in sorted(d["seats"].items()):
        u = s["usage"] or {}
        out.append("%s[in_flight=%d runs=%d%s%s%s]" % (
            n, s.get("running", s["in_flight"]), s["runs"], " 5h=%s%% wk=%s%%" % (u.get("five_hour_pct"), u.get("weekly_pct"))
            if u.get("known") else " usage=UNKNOWN",
            " MAXED_until=" + s["maxed_until"] if s["maxed_until"] else "",
            " LOGGED_OUT" if s["logged_in"] is False else ""))
    return " ".join(out).replace("[in_flight=", "[running=")


def skip_reason(s):
    if s["logged_in"] is False:
        return "logged out"
    if s["maxed_until"] and s["maxed_until"] > ts():
        return "limited until " + s["maxed_until"]
    if expired_ok(s):
        if s.get("running", 0) > 0:  # one refresh session at a time; a second waits for the refreshed usage
            return "token expired, refresh session running"
        return None
    if headroom(s) is None:
        return "usage unknown: %s" % ((s["usage"] or {}).get("reason") or "never read")
    if s["usage"]["five_hour_pct"] >= NEAR_5H:
        return "near 5h limit (%s%%)" % s["usage"]["five_hour_pct"]
    if s.get("running", 0) >= MAX_PER_SEAT:
        return "at per-seat cap (%d running, cap %d)" % (s["running"], MAX_PER_SEAT)
    return None


def open_total(d):
    return sum(s["in_flight"] for s in d["seats"].values())


def ceiling_reason(d):
    n = open_total(d)
    return "team worker ceiling %d reached (%d open)" % (MAX_TOTAL, n) if n >= MAX_TOTAL else None


def mem_available_mb(path=None):
    for line in open(path or os.environ.get("DISPATCH_MEMINFO") or "/proc/meminfo"):
        if line.startswith("MemAvailable:"):
            return int(line.split()[1]) // 1024
    raise RuntimeError("no MemAvailable in meminfo")


def mem_reason(recent, floor_mb=None, host=HOST):
    """None when this host may launch one more worker, else the refusal reason. `recent` = launches from this host
    in the last LAUNCH_WINDOW s (not yet counted in MemAvailable). Unreadable meminfo never blocks."""
    floor_mb = MEM_FLOOR_MB if floor_mb is None else floor_mb
    try:
        n = mem_available_mb() - MEM_PER_LAUNCH_MB * recent
    except (OSError, ValueError, RuntimeError):
        return None
    return "low memory on %s: %d MB available (floor %d)" % (host, n, floor_mb) if n < floor_mb else None


LOAD_PER_CPU = 2.0  # refuse a local pick at or above this 5-min load average per CPU


def load_reason(host=HOST):
    """None when this host's CPU can take one more worker, else the refusal reason. Unreadable never blocks."""
    try:
        per_cpu = float(os.environ.get("DISPATCH_LOAD_PER_CPU") or LOAD_PER_CPU)
    except ValueError:
        per_cpu = LOAD_PER_CPU
    try:
        with open(os.environ.get("DISPATCH_LOADAVG") or "/proc/loadavg") as f:
            load5 = float(f.read().split()[1])
        cpus = int(os.environ.get("DISPATCH_NPROC") or os.cpu_count() or 1)
    except (OSError, ValueError, IndexError):
        return None
    cap = per_cpu * cpus
    return "high load on %s: load5 %.1f on %d CPUs (cap %.0f)" % (host, load5, cpus, cap) if load5 >= cap else None


def t3_origin():
    """This host's T3 server origin: T3_MCP_URL, else ~/.t3/userdata/server-runtime.json (T3 may pick a random port), else :3773."""
    if os.environ.get("T3_MCP_URL"):
        return os.environ["T3_MCP_URL"].rstrip("/").rsplit("/mcp", 1)[0]
    try:
        o = json.load(open(os.path.expanduser("~/.t3/userdata/server-runtime.json"))).get("origin")
        if isinstance(o, str) and o.startswith(("http://", "https://")):
            return o.rstrip("/")
    except (OSError, ValueError, AttributeError):
        pass
    return "http://127.0.0.1:3773"


class T3Mcp:
    """Minimal T3 MCP client, for the session count."""

    def __init__(self, timeout=5):
        self.url, self.timeout, self.sid = t3_origin() + "/mcp", timeout, None
        tok = open(os.path.join(HOME, ".t3token")).read().strip()
        self.h = {"Authorization": "Bearer " + tok, "Content-Type": "application/json",
                  "Accept": "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18"}
        self.post({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "seat-broker", "version": "0"}}})
        self.post({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def post(self, obj):
        h = dict(self.h, **({"mcp-session-id": self.sid} if self.sid else {}))
        resp = urllib.request.urlopen(urllib.request.Request(self.url, json.dumps(obj).encode(), h), timeout=self.timeout)
        self.sid = resp.headers.get("mcp-session-id") or self.sid
        body = resp.read().decode()
        for line in body.splitlines():
            if line.startswith("data:"):
                body = line[5:].strip()
        return json.loads(body) if body.strip() else None

    def call(self, tool, args):
        r = self.post({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": tool, "arguments": args}})
        res = (r or {}).get("result") or {}
        if res.get("isError") or "error" in (r or {}):
            raise RuntimeError("%s: %s" % (tool, json.dumps(r)[:200]))
        if "structuredContent" in res:
            return res["structuredContent"]
        return json.loads(res["content"][0]["text"])


def read_t3_sessions():
    """Threads with an active turn on this host's T3, every project. Raises on any read error."""
    c = T3Mcp()
    projects = [p for p in c.call("t3_project_list", {}).get("projects", []) if not p.get("deletedAt")]

    def one(p):
        got = c.call("t3_thread_list", {"projectId": p["id"], "statuses": ACTIVE_STATUSES, "includeSubagents": True, "limit": 100})
        return [{"thread": t.get("threadId"), "status": t.get("status"), "project": p.get("title"),
                 "seat": t.get("providerInstanceId"), "title": (t.get("title") or "")[:80]} for t in got.get("threads", [])]
    with ThreadPoolExecutor(max_workers=6) as ex:  # one call per project; many projects on one host
        return [t for ts_ in ex.map(one, projects) for t in ts_]


def live_sessions(write=True):
    """{"live": n, "threads": [...], "at": ts} for this host, or None when T3 cannot be read (never blocks a pick)."""
    fx = os.environ.get("DISPATCH_SESSIONS")
    if fx:
        try:
            v = json.load(open(fx))
        except (OSError, ValueError):
            return None
        return v if isinstance(v, dict) else {"live": int(v), "threads": [], "at": ts()}
    try:
        c = json.load(open(SESSIONS_CACHE))
        if age(c["at"]) < SESSIONS_TTL:
            return c
    except (OSError, ValueError, KeyError, TypeError):
        pass
    try:
        threads = read_t3_sessions()
    except Exception as e:  # no token, T3 down, protocol change: never block, say why in `sessions`
        return {"live": None, "threads": [], "at": ts(), "error": str(e)[:200]}
    c = {"live": len(threads), "threads": threads, "at": ts()}
    if write:
        try:
            tmp = SESSIONS_CACHE + ".tmp"
            json.dump(c, open(tmp, "w"))
            os.replace(tmp, SESSIONS_CACHE)
        except OSError:
            pass
    return c


PROVIDER_COMMS = ("claude", "codex")  # provider processes T3 spawns per thread session


def provider_processes():
    """live provider processes (claude / codex) whose parent is this host's T3 server, idle ones included: T3
    keeps a thread's process alive after its turn ends, so a turn count alone missed them (2026-11-03: 10 processes
    on one host while 1 turn counted). None when unreadable or under a DISPATCH_SESSIONS fixture without DISPATCH_PROCS.
    Tests: DISPATCH_PROCS=<n> replaces the /proc scan."""
    fx = os.environ.get("DISPATCH_PROCS")
    if fx is not None:
        try:
            return int(fx)
        except ValueError:
            return None
    if os.environ.get("DISPATCH_SESSIONS"):
        return None
    try:
        comm, ppid = {}, {}
        for pid in os.listdir("/proc"):
            if not pid.isdigit():
                continue
            try:
                with open("/proc/%s/stat" % pid) as f:
                    st = f.read()
            except OSError:
                continue
            # pid (comm) state ppid ...: comm may hold spaces, so split at the last ')'
            comm[pid] = st[st.index("(") + 1:st.rindex(")")]
            ppid[pid] = st[st.rindex(")") + 2:].split()[1]
        def is_t3(pid):  # T3's comm is "node-MainThread"; its argv[0] is .../t3 (`t3 serve`)
            try:
                with open("/proc/%s/cmdline" % pid, "rb") as f:
                    return os.path.basename(f.read().split(b"\0")[0].decode("utf-8", "replace")) == "t3"
            except OSError:
                return False
        return len([p for p, c in comm.items() if c in PROVIDER_COMMS and is_t3(ppid[p])])
    except Exception:
        return None


def recent_session_launches(d):
    cut = ts(now() - timedelta(seconds=SESSION_LAUNCH_WINDOW))
    return len([t for t in d.get("local_launches", []) if t > cut])


def session_count(d, write=True):
    """(live turns + launches not yet visible, cap, detail) for this host; count None = unreadable."""
    s = dict(live_sessions(write) or {})
    procs = provider_processes()
    s["procs"] = procs
    turns = s.get("live")
    # the larger of turns in flight and live provider processes (an idle session still holds memory and CPU)
    base = None if turns is None and procs is None else max(x for x in (turns, procs) if x is not None)
    n = None if base is None else base + recent_session_launches(d)
    return n, MAX_SESSIONS, s


def session_reason(d, host=HOST):
    """None while this host runs fewer agent sessions than the session cap, else the refusal reason."""
    n, cap, _ = session_count(d)
    return "session cap on %s: %d live (cap %d)" % (host, n, cap) if n is not None and n >= cap else None


def recent_launches(d):
    cut = ts(now() - timedelta(seconds=LAUNCH_WINDOW))
    d["local_launches"] = [t for t in d.get("local_launches", []) if t > cut]
    return len(d["local_launches"])


def start_failed(s):
    return bool(s.get("start_failed_until")) and s["start_failed_until"] > ts()


def pick(d):
    ok = [(start_failed(s), -score(s), expired_ok(s), s["last_used"] or "", n)  # an ok seat wins a tie
          for n, s in d["seats"].items() if not skip_reason(s)]
    return min(ok)[-1] if ok else None  # a seat whose turn could not start sorts last


def no_seat_reason(d):
    return "no seat: " + "; ".join("%s %s" % (n, skip_reason(s)) for n, s in sorted(d["seats"].items()))


HOST_CAP_RE = re.compile(r"^(high load|low memory|session cap) on \S+:")
RETRYABLE_RE = re.compile(r"^team worker ceiling|unreachable|^no seat\b|all seats busy|maxed|at capacity", re.I)


def refusal(reason):
    """the `id: null` answer for a refusal reason: reason verbatim + retryable + retry_after_s."""
    if HOST_CAP_RE.search(reason) or re.search("unreachable", reason, re.I):
        return {"id": None, "reason": reason, "retryable": True, "retry_after_s": 60}
    if RETRYABLE_RE.search(reason):
        return {"id": None, "reason": reason, "retryable": True, "retry_after_s": 120}
    return {"id": None, "reason": reason, "retryable": False, "retry_after_s": None}


def arg(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def release(d, seat, ok, signal=None, until=None):
    s = d["seats"][seat]
    if s["reservations"]:
        s["reservations"].pop(0)
    s["in_flight"] = len(s["reservations"])
    s["ok" if ok else "failed"] += 1
    if signal:
        s["last_signal"] = signal
    if not ok:
        s["last_error"] = "%s %s" % (ts(), signal or "failed")
        if signal and START_FAIL_RE.search(signal):  # avoid this seat for a while, not a usage limit
            s["start_failed_until"] = ts(now() + timedelta(seconds=START_FAIL_COOLDOWN))
        if not until and signal and LIMIT_RE.search(signal):
            m = re.search(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", signal)
            until = m.group(0) if m else ts(now() + timedelta(hours=1))
    if until:
        s["maxed_until"] = until


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if cmd == "beat":
        if os.path.exists(PAUSE):
            print(json.dumps({"paused": True}))
            return
        with State() as st:
            d = st.d
            release_stale(d)
            refresh_auth(d)
            refresh_usage(d)
            count_running(d)
            d["beat"] += 1
            seat = pick(d)
            if seat:
                s = d["seats"][seat]
                s["runs"] += 1
                s["last_used"] = ts()
                s["reservations"].append(ts())
                s["in_flight"] = len(s["reservations"])
            log("%s beat=%d seat=%s headroom: %s" % (ts(), d["beat"], seat or "NONE", snapshot(d)))
            print(json.dumps({"beat": d["beat"], "seat": seat,
                              "providerInstanceId": d["seats"][seat]["providerInstanceId"] if seat else None}))
    elif cmd == "hello":
        seat = sys.argv[2]
        with State() as st:
            log("%s hello from seat-%s%s" % (ts(), seat.replace("seat", ""), " (beat %s)" % sys.argv[3] if len(sys.argv) > 3 else ""))
            release(st.d, seat, True)
        print("logged hello for " + seat)
    elif cmd == "done":
        with State() as st:
            release(st.d, sys.argv[2], "--fail" not in sys.argv, arg("--signal"), arg("--limit-until"))
        print(json.dumps({"ok": True}))
    elif cmd == "limit":
        with State() as st:
            st.d["seats"][sys.argv[2]]["maxed_until"] = arg("--until")
            st.d["seats"][sys.argv[2]]["last_signal"] = arg("--signal", "manual")
    elif cmd == "pick":
        # reserve the best-scoring eligible seat for one delegated worker; release with `done <seat>`
        if os.path.exists(PAUSE):
            print(json.dumps(dict(refusal("paused"), paused=True, seat=None)))
            return
        with State() as st:
            d = st.d
            release_stale(d)
            local = arg("--from") is None  # --from <host>: that host checked its own memory and load before forwarding
            refused = ceiling_reason(d) or (local and (mem_reason(recent_launches(d)) or load_reason() or session_reason(d)))
            if refused:
                print(json.dumps(dict({"seat": None, "providerInstanceId": None}, **refusal(refused))))
                return
            refresh_usage(d)
            count_running(d)
            # renew one expired seat's token (a pick --from another host ran no host gate here, so check the cap now)
            renew = refresh_due(d, host_ok=not (mem_reason(recent_launches(d)) or load_reason() or session_reason(d))
                                if not local else True)
            seat = pick(d)
            if seat:
                s = d["seats"][seat]
                s["runs"] += 1
                s["last_used"] = ts()
                s["reservations"].append(ts())
                s["in_flight"] = len(s["reservations"])
                s["running"] += 1
                if local:
                    d.setdefault("local_launches", []).append(ts())
            out = {"seat": seat, "providerInstanceId": d["seats"][seat]["providerInstanceId"] if seat else None}
            if seat:  # EpicSpine dispatcher contract keys, alongside the legacy ones
                out.update(id=seat, via="t3_delegate_task", headroom=headroom(d["seats"][seat]))
                if expired_ok(d["seats"][seat]):
                    out["token_refresh"] = True  # this session refreshes the seat's expired token
            else:
                out.update(refusal(no_seat_reason(d)))
        if renew:
            start_refresh(renew)
            out["token_refresh_started"] = renew
        print(json.dumps(out))
    elif cmd == "refresh-token":
        print(json.dumps({"seat": sys.argv[2], "result": refresh_token(sys.argv[2])}))
    elif cmd == "probe":
        # would a local pick get a seat right now? Read-only: same gates and eligibility as `pick`, no reservation.
        if os.path.exists(PAUSE):
            print(json.dumps(dict(refusal("paused"), host=HOST, ok=False)))
            return
        try:
            d = json.load(open(SEATS))
        except (OSError, ValueError):
            d = {}
        d.setdefault("seats", {})
        for s in d["seats"].values():
            for k, v in FIELDS.items():
                s.setdefault(k, v)
        cut = now() - timedelta(minutes=STALE_MIN)
        for s in d["seats"].values():
            s["reservations"] = [r for r in s["reservations"] if parse(r) > cut]
            s["in_flight"] = len(s["reservations"])
        count_running(d)
        refused = ceiling_reason(d) or mem_reason(recent_launches(d)) or load_reason() or session_reason(d)
        if not refused and not pick(d):
            refused = no_seat_reason(d)
        out = {"host": HOST, "ok": not refused}
        if refused:
            out.update({k: v for k, v in refusal(refused).items() if k != "id"})
        print(json.dumps(out))
    elif cmd == "sessions":
        # read-only JSON of this host's live agent sessions vs the session cap (no reservation, no state write)
        try:
            d = json.load(open(SEATS))
        except (OSError, ValueError):
            d = {}
        n, cap, s = session_count(d)
        print(json.dumps({"host": HOST, "live": n, "cap": cap, "full": n is not None and n >= cap,
                          "turns": s.get("live"), "procs": s.get("procs"), "launching": recent_session_launches(d), "at": s.get("at"),
                          "error": s.get("error"), "threads": s.get("threads", [])}))
    elif cmd == "usage":
        with State() as st:
            refresh_usage(st.d)
            print(json.dumps({n: dict(s["usage"], headroom=headroom(s)) for n, s in sorted(st.d["seats"].items())}))
    elif cmd == "status":
        # read-only: no reservation, no refresh, no write
        d = json.load(open(SEATS))
        seats = d.get("seats", {})
        for s in seats.values():
            for k, v in FIELDS.items():
                s.setdefault(k, v)
        cut_r = now() - timedelta(minutes=STALE_MIN)
        for s in seats.values():  # running as pick counts it (live reservations vs console child runs)
            s["in_flight"] = len([r for r in s["reservations"] if parse(r) > cut_r])
        count_running(d)
        free = [n for n, s in seats.items() if not skip_reason(s)]  # same eligibility as pick
        cut = ts(now() - timedelta(minutes=STALE_MIN))  # count open reservations as pick would (stale ones drop)
        n_open = sum(len([r for r in s["reservations"] if r > cut]) for s in seats.values())
        print(json.dumps({"name": "seat pool", "capacity": len(seats), "available": len(free),
                          "ceiling": MAX_TOTAL, "open": n_open, "per_seat_cap": MAX_PER_SEAT,
                          "sessions": dict(zip(("live", "cap"), session_count(d, write=False)[:2]), host=HOST),
                          "beat": d.get("beat"), "updated": d.get("updated"), "free": sorted(free),
                          "seats": {n: {"org": s.get("org"), "logged_in": s["logged_in"], "in_flight": s["in_flight"],
                                        "running": s["running"], "console_running": s["console_running"],
                                        "start_failed_until": s["start_failed_until"], "runs": s["runs"], "maxed_until": s["maxed_until"],
                                        "five_hour": ((s["usage"] or {}).get("utilization") or {}).get("five_hour"),
                                        "usage": {k: (s["usage"] or {}).get(k) for k in (
                                            "known", "reason", "token_expired", "five_hour_pct", "five_hour_resets_at", "weekly_pct",
                                            "weekly_resets_at", "status", "read_at")}}
                                    for n, s in sorted(seats.items())}}))
    else:
        print(open(SEATS).read())


main()
