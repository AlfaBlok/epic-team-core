#!/usr/bin/env python3
"""Dry-run tests for the M1 usage-based pick (stdlib only). Never touches live state: each case runs the
broker with HOME set to a fresh temp dir and usage from SEAT_BROKER_USAGE_FIXTURE.

  python3 core/dispatcher/test_broker.py            # runs all cases, exit 1 on any failure
"""
import json, os, subprocess, sys, tempfile, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
BROKER = os.path.join(HERE, "broker.py")
ADAPTER = os.path.join(HERE, "t3_seat_pool.py")
FAIL = []


def usage(five, weekly, five_reset="2099-01-01T00:00:00Z", weekly_reset="2099-01-07T00:00:00Z", fable=0, seven_day=None):
    # same shape as GET /api/oauth/usage on a Team seat (session + Fable weekly_scoped); `weekly` adds a general
    # weekly_all row (None = not metered, as on today's Team seats)
    lim = [{"kind": "session", "group": "session", "percent": five, "resets_at": five_reset, "is_active": True},
           {"kind": "weekly_scoped", "group": "weekly", "percent": fable, "resets_at": weekly_reset,
            "scope": {"model": {"display_name": "Fable"}}, "is_active": False}]
    if weekly is not None:
        lim.append({"kind": "weekly_all", "group": "weekly", "percent": weekly, "resets_at": weekly_reset})
    return {"five_hour": {"utilization": five, "resets_at": five_reset, "locked_reason": None},
            "seven_day": seven_day, "limits": lim}


def meminfo(home, avail_mb):
    f = os.path.join(home, "meminfo")
    open(f, "w").write("MemTotal:       16000000 kB\nMemAvailable:   %d kB\n" % (avail_mb * 1024))
    return f


def loadavg(home, load5):
    f = os.path.join(home, "loadavg")
    open(f, "w").write("%.2f %.2f %.2f 1/100 1\n" % (load5, load5, load5))
    return f


def run(fixture, *args, prog=BROKER, home=None, mem_mb=12000, extra_env=None, load5=0.5):
    home = home or tempfile.mkdtemp(prefix="broker-test-")
    os.makedirs(os.path.join(home, ".epic-team", "broker"), exist_ok=True)
    # a fixed loadavg (never this host's real one) and 4 CPUs, so the CPU gate is deterministic
    env = dict(os.environ, HOME=home, DISPATCH_MEMINFO=meminfo(home, mem_mb), DISPATCH_LOADAVG=loadavg(home, load5),
               DISPATCH_NPROC="4", DISPATCH_PROCS="0")  # never this host's real provider processes
    env.update(extra_env or {})
    for k in ("SEAT_POOL_BROKER", "BROKER_MAX_TOTAL", "DISPATCH_MEM_FLOOR_MB", "DISPATCH_LOAD_PER_CPU",
              "DISPATCH_SESSIONS", "BROKER_MAX_SESSIONS", "T3_MCP_URL"):
        if k not in (extra_env or {}):
            env.pop(k, None)
    env["BROKER_REFRESH_CMD"] = (extra_env or {}).get("BROKER_REFRESH_CMD", "true")  # never a real claude turn
    env["BROKER_AUTH_CMD"] = (extra_env or {}).get("BROKER_AUTH_CMD", "echo {}")  # never a real claude auth status
    if fixture is not None:
        fx = os.path.join(home, "fixture.json")
        json.dump(fixture, open(fx, "w"))
        env["SEAT_BROKER_USAGE_FIXTURE"] = fx
    cmd = [sys.executable, prog] + (["--broker", BROKER] if prog != BROKER else []) + list(args)
    r = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=60)
    if r.returncode:
        raise RuntimeError(r.stderr)
    return (json.loads(r.stdout) if r.stdout.strip() else None), home




def in_flight_total(home):
    return sum(v.get("in_flight", 0) for v in json.load(open(os.path.join(home, ".epic-team", "broker", "seats.json")))["seats"].values())


def seed(busy):
    """Temp HOME whose seats.json already holds fresh reservations, e.g. {"seat1": 1, "seat2": 1}."""
    home = tempfile.mkdtemp(prefix="broker-test-")
    os.makedirs(os.path.join(home, ".epic-team", "broker"))
    at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    seats = {n: {"providerInstanceId": "claudeAgent_" + n, "reservations": [at] * k, "in_flight": k}
             for n, k in busy.items()}
    json.dump({"beat": 0, "seats": seats}, open(os.path.join(home, ".epic-team", "broker", "seats.json"), "w"))
    return home


def parse_ts(t):
    return datetime.strptime(t, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def check(name, cond, got):
    print("%s  %s  -> %s" % ("PASS" if cond else "FAIL", name, json.dumps(got)))
    if not cond:
        FAIL.append(name)



def console_db(home, running):
    """a console.db stub with `running` child runs per seat, e.g. {"seat1": 6, "seat2": 3}."""
    import sqlite3
    f = os.path.join(home, "console.db")
    c = sqlite3.connect(f)
    c.execute("CREATE TABLE runs (id TEXT, seat TEXT, outcome TEXT, parent_run_id TEXT, started_at TEXT)")
    at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    old = (datetime.now(timezone.utc) - timedelta(hours=5)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    for seat, k in running.items():
        for i in range(k):
            c.execute("INSERT INTO runs VALUES (?,?,?,?,?)", ("r%s%d" % (seat, i), seat, "running", "p", at))
    c.execute("INSERT INTO runs VALUES ('top', 'seat2', 'running', NULL, ?)", (at,))  # a wake, not a worker
    c.execute("INSERT INTO runs VALUES ('stale', 'seat2', 'running', 'p', ?)", (old,))  # past the stale limit
    c.execute("INSERT INTO runs VALUES ('done', 'seat2', 'progressed', 'p', ?)", (at,))
    c.commit()
    c.close()
    return f


# tonight's case (2026-10-31 23:40Z): seat1 27% / seat2 41%, the console runs 6 workers on seat1 and 3 on
# seat2, the broker held 1 / 0 reservations (older ones expired after 20 min) and kept picking seat1
TONIGHT = {"seat1": usage(27, None), "seat2": usage(41, None)}
h = seed({"seat1": 1, "seat2": 0})
g, _ = run(TONIGHT, "pick", "--from", "other-host", home=h, extra_env={"BROKER_CONSOLE_DB": console_db(h, {"seat1": 6, "seat2": 3})})
st = json.load(open(os.path.join(h, ".epic-team", "broker", "seats.json")))["seats"]
check("E39-a console running 6/3 (reservations 1/0) -> seat2; running counted from the console",
      g["seat"] == "seat2" and st["seat1"]["running"] == 6 and st["seat2"]["running"] == 4 and st["seat2"]["console_running"] == 3, [g, {n: (s["running"], s["console_running"]) for n, s in st.items()}])
h = seed({"seat1": 1, "seat2": 0})
g, _ = run(TONIGHT, "pick", home=h, extra_env={"BROKER_CONSOLE_DB": os.path.join(h, "missing.db")})
check("E39-b console DB unreadable -> reservations only (as before): seat1", g["seat"] == "seat1", g)
h = seed({"seat1": 0, "seat2": 0})
g, _ = run({"seat1": usage(5, None), "seat2": usage(80, None)}, "pick", home=h, extra_env={"BROKER_CONSOLE_DB": console_db(h, {"seat1": 10, "seat2": 1})})
check("E39-c per-seat cap 10: seat1 at 10 running is skipped despite more headroom -> seat2", g["seat"] == "seat2", g)
h = seed({"seat1": 0, "seat2": 0})
g, _ = run({"seat1": usage(5, None), "seat2": usage(95, None)}, "pick", home=h, extra_env={"BROKER_CONSOLE_DB": console_db(h, {"seat1": 10})})
check("E39-d cap + seat2 near 5h -> no seat, reason names the cap", g["id"] is None and "at per-seat cap (10 running, cap 10)" in g["reason"], g)
h = seed({"seat1": 1, "seat2": 0})
run(TONIGHT, "done", "seat1", "--fail", "--signal", "The provider could not start this turn. Retry the turn", home=h)
st = json.load(open(os.path.join(h, ".epic-team", "broker", "seats.json")))["seats"]
g, _ = run(TONIGHT, "pick", home=h)
check("E39-e done --fail --signal 'could not start this turn' -> seat1 avoided 10 min (not maxed): seat2",
      g["seat"] == "seat2" and st["seat1"]["start_failed_until"] and not st["seat1"]["maxed_until"], [g, st["seat1"]["start_failed_until"]])
h = seed({"seat1": 0, "seat2": 0})  # fresh home: no cached usage
run(TONIGHT, "done", "seat1", "--fail", "--signal", "Claude Code did not answer the MCP server registration.", home=h)
g, _ = run({"seat1": usage(27, None), "seat2": usage(95, None)}, "pick", home=h)
check("E39-f the cooldown is soft: seat2 ineligible -> seat1 still picked", g["seat"] == "seat1", g)
# a seat that cannot sign in is set aside 30 min (not eligible), the next best seat is picked, pick names it
NOLOGIN = "seat1: ~/.claude_seat1 has no .credentials.json, new threads say Not logged in"
h = seed({"seat1": 0, "seat2": 0})
run(TONIGHT, "done", "seat1", "--fail", "--signal", NOLOGIN, home=h)
st = json.load(open(os.path.join(h, ".epic-team", "broker", "seats.json")))["seats"]
left = (parse_ts(st["seat1"]["auth_failed_until"]) - datetime.now(timezone.utc)).total_seconds() if st["seat1"]["auth_failed_until"] else 0
g, _ = run(TONIGHT, "pick", "--from", "other-host", home=h)
check("S101a done --fail 'Not logged in' -> seat1 set aside ~30 min, pick takes seat2 and names seat1 in set_aside",
      g["seat"] == "seat2" and 1700 < left <= 1800 and list(g.get("set_aside", {})) == ["seat1"] and not st["seat1"]["maxed_until"], [g, left])
h = seed({"seat1": 0, "seat2": 0})
run(TONIGHT, "done", "seat1", "--fail", "--signal", "T3 turn failed: Claude could not authenticate. Run /login", home=h)
g, _ = run({"seat1": usage(5, 10), "seat2": usage(95, None)}, "pick", home=h)
check("S101b the set-aside is hard: seat2 ineligible -> no seat (retryable), reason names the set-aside",
      g["id"] is None and g["retryable"] and "seat1 set aside until" in g["reason"] and "sign-in failed" in g["reason"], g)
h = seed({"seat1": 0, "seat2": 0})
run(TONIGHT, "done", "seat1", "--fail", "--signal", "Claude could not authenticate", home=h)
d = json.load(open(os.path.join(h, ".epic-team", "broker", "seats.json")))
d["seats"]["seat1"]["auth_failed_until"] = "2000-01-01T00:00:00Z"
json.dump(d, open(os.path.join(h, ".epic-team", "broker", "seats.json"), "w"))
g, _ = run({"seat1": usage(5, 10), "seat2": usage(60, None)}, "pick", home=h)
check("S101c after 30 min the seat is pickable again (most headroom wins)", g["seat"] == "seat1" and "set_aside" not in g, g)
h = seed({"seat1": 1, "seat2": 0})
run(TONIGHT, "done", "seat1", "--fail", "--signal", "Claude could not authenticate", home=h)
run(TONIGHT, "done", "seat1", home=h)
st = json.load(open(os.path.join(h, ".epic-team", "broker", "seats.json")))["seats"]
check("S101d a later ok done clears the set-aside", st["seat1"]["auth_failed_until"] is None, st["seat1"]["auth_failed_until"])
h = seed({"seat1": 0, "seat2": 0})
run(TONIGHT, "done", "seat1", "--fail", "--signal", "Claude could not authenticate", home=h)
g, _ = run(TONIGHT, "status", home=h)
check("S101e status names the set-aside and counts seat1 unavailable",
      list(g.get("set_aside", {})) == ["seat1"] and "seat1" not in g["free"] and g["seats"]["seat1"]["auth_failed_until"], g)
h = seed({"seat1": 0, "seat2": 0})
run(TONIGHT, "done", "seat1", "--fail", "--signal", "Claude API rate limit reached. Try again later.", home=h)
st = json.load(open(os.path.join(h, ".epic-team", "broker", "seats.json")))["seats"]
check("S101f a usage-limit signal is not a sign-in failure", not st["seat1"]["auth_failed_until"] and st["seat1"]["maxed_until"], st["seat1"])
h = seed({"seat1": 0, "seat2": 0})
run(TONIGHT, "done", "seat1", "--fail", "--signal", "Claude could not authenticate", home=h)
g, _ = run(TONIGHT, "pick", "--from", "other-host", prog=ADAPTER, home=h)
gs, _ = run(TONIGHT, "status", prog=ADAPTER, home=h)
check("S101g the adapter passes set_aside on pick and status", g["id"] == "seat2" and list(g.get("set_aside", {})) == ["seat1"]
      and list(gs.get("set_aside", {})) == ["seat1"], [g, gs])
# the console's usage-limit signal (T3's error + its reset) sets maxed_until to that reset; "hit your 5-hour limit" too
h = seed({"seat1": 0, "seat2": 0})
run(TONIGHT, "done", "seat1", "--fail", "--signal",
    "T3 turn failed: Usage limit reached: Claude API rate limit reached. Try again later. (limited until 2099-01-03T19:50:00Z)", home=h)
st = json.load(open(os.path.join(h, ".epic-team", "broker", "seats.json")))["seats"]
g, _ = run(TONIGHT, "pick", home=h)
check("E47-a done --fail --signal 'Usage limit reached … (limited until T)' -> seat1 maxed_until T, pick seat2",
      st["seat1"]["maxed_until"] == "2099-01-03T19:50:00Z" and g["seat"] == "seat2", [g, st["seat1"]["maxed_until"]])
h = seed({"seat1": 0, "seat2": 0})
run(TONIGHT, "done", "seat1", "--fail", "--signal", "You've hit your 5-hour limit", home=h)
st = json.load(open(os.path.join(h, ".epic-team", "broker", "seats.json")))["seats"]
check("E47-b 'hit your 5-hour limit' -> seat1 maxed (+1h)", bool(st["seat1"]["maxed_until"]), st["seat1"])
h = seed({"seat1": 2, "seat2": 0})
run(TONIGHT, "pick", home=h)
g, _ = run(TONIGHT, "status", home=h, extra_env={"BROKER_CONSOLE_DB": console_db(h, {"seat1": 6, "seat2": 3})})
check("E39-g status shows running, console_running, per_seat_cap",
      g["per_seat_cap"] == 10 and g["seats"]["seat1"]["running"] == 6 and g["seats"]["seat2"]["console_running"] == 3, g)

# 4. most headroom wins (5h), both directions
g, _ = run({"seat1": usage(60, 0), "seat2": usage(20, 0)}, "pick")
check("T4a seat1 60% / seat2 20% -> seat2", g["seat"] == "seat2", g)
g, _ = run({"seat1": usage(20, 0), "seat2": usage(60, 0)}, "pick")
check("T4b seat1 20% / seat2 60% -> seat1", g["seat"] == "seat1", g)

# 5. weekly counts
g, _ = run({"seat1": usage(10, 95), "seat2": usage(50, 50)}, "pick")
check("T5 seat1 5h10/wk95, seat2 50/50 -> seat2", g["seat"] == "seat2", g)

# 6. limited skipped until reset; both limited -> no seat with a reason
g, home = run({"seat1": usage(100, 0, five_reset="2099-01-01T05:00:00Z"), "seat2": usage(85, 0)}, "pick")
st = json.load(open(os.path.join(home, ".epic-team", "broker", "seats.json")))["seats"]["seat1"]
check("T6a seat1 limited (5h 100%), seat2 85% -> seat2", g["seat"] == "seat2" and st["maxed_until"] == "2099-01-01T05:00:00Z", g)
g, _ = run({"seat1": usage(10, 100), "seat2": usage(100, 10)}, "pick")
check("T6b both limited -> no seat, reason", g["seat"] is None and g["id"] is None and "limited until" in g["reason"], g)
g, _ = run({"seat1": usage(10, 100), "seat2": usage(100, 10)}, "pick", prog=ADAPTER)
check("T6c adapter: both limited -> id null + reason", g["id"] is None and "limited until" in g["reason"], g)
# limited seat comes back after its reset: reset in the past is cleared, fresh read says allowed
g, home = run({"seat1": usage(10, 0), "seat2": usage(50, 0)}, "limit", "seat1", "--until", "2000-01-01T00:00:00Z")
g, _ = run({"seat1": usage(10, 0), "seat2": usage(50, 0)}, "pick", home=home)
check("T6d seat1 maxed_until in the past + now 10% -> seat1 again", g["seat"] == "seat1", g)

# 3. honest failure: read error and logged-out seat (no credentials in temp HOME) -> unknown with reason, never 0%
g, home = run({"seat1": {"error": "usage endpoint HTTP 401"}, "seat2": usage(80, 0)}, "pick")
s1 = json.load(open(os.path.join(home, ".epic-team", "broker", "seats.json")))["seats"]["seat1"]["usage"]
check("T3a seat1 read error -> unknown, skipped, seat2 picked", g["seat"] == "seat2" and s1["known"] is False
      and s1["five_hour_pct"] is None and "401" in s1["reason"], {"pick": g, "seat1.usage": s1})
g, _ = run(None, "usage")  # real code path, temp HOME has no ~/.claude_seatN/.credentials.json
check("T3b no credentials -> unknown + reason, never 0", all(u["known"] is False and u["five_hour_pct"] is None
      and "no credentials" in u["reason"] and u["headroom"] is None for u in g.values()), g)
g, _ = run(None, "pick")
check("T3c all unknown -> pick returns no seat + reason", g["seat"] is None and "usage unknown" in g["reason"], g)

# a seat unknown only because its access token expired (refresh token stored) is picked while idle, below an
# ok seat with more headroom, above a busy one; one refresh session at a time; no refresh token = still skipped
EXP = {"token_expired": True, "expired_at": "2026-11-03T22:59:06Z"}
g, home = run({"seat1": EXP, "seat7": usage(50, 30)}, "pick", home=seed({"seat1": 0, "seat7": 4}))
s1 = json.load(open(os.path.join(home, ".epic-team", "broker", "seats.json")))["seats"]["seat1"]["usage"]
check("S60a expired seat beats a busy ok seat, flagged token_refresh", g["seat"] == "seat1" and g.get("token_refresh") is True
      and g["headroom"] is None and s1["token_expired"] is True and s1["known"] is False, g)
st, _ = run({"seat1": EXP, "seat7": usage(50, 30)}, "status", home=home)
check("S60b status: the expired seat is not free while its refresh session runs", st["free"] == ["seat7"]
      and st["seats"]["seat1"]["usage"]["token_expired"] is True, st["free"])
g, _ = run({"seat1": EXP, "seat7": usage(50, 30)}, "pick", home=home)
check("S60c second pick goes elsewhere (one refresh session per seat)", g["seat"] == "seat7", g)
g, _ = run({"seat1": EXP, "seat7": usage(10, 0)}, "pick")
check("S60d an idle ok seat with more headroom wins", g["seat"] == "seat7", g)
g, _ = run({"seat1": EXP, "seat7": usage(50, 0)}, "pick")
check("S60e tie with an ok seat: the ok seat wins", g["seat"] == "seat7", g)
g, _ = run({"seat1": dict(EXP, refreshable=False), "seat7": usage(50, 30)}, "pick", home=seed({"seat1": 0, "seat7": 9}))
check("S60f no refresh token: still skipped as unknown", g["seat"] == "seat7", g)
st, _ = run({"seat1": EXP, "seat2": EXP}, "status", home=run({"seat1": EXP, "seat2": EXP}, "usage")[1])
check("S60g status counts idle expired seats as available", st["available"] == 2 and st["free"] == ["seat1", "seat2"], st["free"])
home = tempfile.mkdtemp(prefix="broker-test-")  # real code path: fake credentials files, expired, no HTTP call
for n, refresh in (("seat1", "placeholder-not-a-token"), ("seat2", None)):
    os.makedirs(os.path.join(home, ".claude_" + n))
    o = {"accessToken": "placeholder-not-a-token", "expiresAt": 1000 * int(datetime.now(timezone.utc).timestamp() - 3600)}
    if refresh:
        o["refreshToken"] = refresh
    json.dump({"claudeAiOauth": o}, open(os.path.join(home, ".claude_" + n, ".credentials.json"), "w"))
g, _ = run(None, "pick", home=home)
u = json.load(open(os.path.join(home, ".epic-team", "broker", "seats.json")))["seats"]
check("S60h real credentials: expired + refresh token picked, expired without one skipped", g["seat"] == "seat1"
      and u["seat1"]["usage"].get("token_expired") is True and "token_expired" not in u["seat2"]["usage"]
      and "access token expired" in u["seat2"]["usage"]["reason"], g)

# tie -> least recently used
g, home = run({"seat1": usage(30, 0), "seat2": usage(30, 0)}, "pick")
first = g["seat"]
run({"seat1": usage(30, 0), "seat2": usage(30, 0)}, "done", first, home=home)
g, _ = run({"seat1": usage(30, 0), "seat2": usage(30, 0)}, "pick", home=home)
check("tie -> least recently used", first and g["seat"] not in (None, first), {"first": first, "second": g})

# M1b: no 1-per-seat cap; score = headroom - 5*in_flight; 5h >= 90% skipped; status uses the same eligibility
fx = {"seat1": usage(7, 0), "seat2": usage(33, 0)}
g, _ = run(fx, "pick", home=seed({"seat1": 1, "seat2": 1}))
check("A both in_flight 1 at 7%/33% -> seat1", g["seat"] == "seat1", g)
fx, home, got = {"seat1": usage(10, 0), "seat2": usage(20, 0)}, None, []
for _ in range(4):
    g, home = run(fx, "pick", home=home)
    got.append(g["seat"])
check("B 4 back-to-back picks 10%/20% spread over both seats", set(got) == {"seat1", "seat2"}, got)
g, _ = run({"seat1": usage(92, 0), "seat2": usage(50, 0)}, "pick")
check("C1 seat1 92% (allowed), seat2 50% -> seat2", g["seat"] == "seat2", g)
g, _ = run({"seat1": usage(92, 0), "seat2": usage(95, 0)}, "pick")
check("C2 both >= 90% -> no seat, near 5h limit", g["seat"] is None and "near 5h limit" in g["reason"], g)
home = seed({"seat1": 1, "seat2": 1})
run({"seat1": usage(7, 0), "seat2": usage(33, 0)}, "usage", home=home)
g, _ = run({}, "status", home=home)
check("D status: both busy under 90% -> available 2", g["available"] == 2 and g["free"] == ["seat1", "seat2"], g)

# M1c: general weekly only; model-scoped (Fable) weekly is informational
g, home = run({"seat1": usage(10, None, fable=100), "seat2": usage(50, None)}, "pick")
u1 = json.load(open(os.path.join(home, ".epic-team", "broker", "seats.json")))["seats"]["seat1"]["usage"]
check("W-a Fable 100% + 5h 10% -> seat1 eligible, weekly None, model_weekly.Fable 100",
      g["seat"] == "seat1" and u1["status"] == "allowed" and u1["weekly_pct"] is None
      and u1["weekly_source"] == "not metered" and u1["model_weekly"]["Fable"]["pct"] == 100, {"pick": g, "seat1": u1})
g, _ = run({"seat1": usage(10, 95), "seat2": usage(10, None)}, "usage")
check("W-b weekly_all 95% -> headroom 5; not metered -> headroom 90",
      g["seat1"]["headroom"] == 5 and g["seat1"]["weekly_source"] == "weekly_all" and g["seat2"]["headroom"] == 90, g)
sd = {"utilization": 100, "resets_at": "2099-01-05T00:00:00Z"}
g, home = run({"seat1": usage(10, None, seven_day=sd), "seat2": usage(50, None)}, "pick")
s1 = json.load(open(os.path.join(home, ".epic-team", "broker", "seats.json")))["seats"]["seat1"]
check("W-c seven_day 100 -> limited until its reset, seat2 picked", g["seat"] == "seat2"
      and s1["usage"]["status"] == "limited" and s1["usage"]["limited_until"] == "2099-01-05T00:00:00Z"
      and s1["maxed_until"] == "2099-01-05T00:00:00Z", {"pick": g, "seat1": s1})

# M1d: usage cache (120 s), stale fallback (15 min), 429 backoff (60 s)
def calls(home):
    f = os.path.join(home, "fixture.json.calls")
    return open(f).read().split() if os.path.exists(f) else []


def seed_usage(mins_ago, five=12, backoff=None):
    """Temp HOME whose seats.json holds a good usage read for both seats taken `mins_ago` minutes ago."""
    home = tempfile.mkdtemp(prefix="broker-test-")
    os.makedirs(os.path.join(home, ".epic-team", "broker"))
    at = (datetime.now(timezone.utc) - timedelta(minutes=mins_ago)).strftime("%Y-%m-%dT%H:%M:%SZ")
    seats = {n: {"providerInstanceId": "claudeAgent_" + n, "usage_backoff_until": backoff, "usage": {
        "known": True, "reason": None, "five_hour_pct": five, "weekly_pct": None, "status": "allowed",
        "limited_until": None, "read_at": at}} for n in ("seat1", "seat2")}
    json.dump({"beat": 0, "seats": seats}, open(os.path.join(home, ".epic-team", "broker", "seats.json"), "w"))
    return home


def seats_of(home):
    return json.load(open(os.path.join(home, ".epic-team", "broker", "seats.json")))["seats"]


fx = {"seat1": usage(12, 0), "seat2": usage(38, 0), "seat3": usage(40, 0), "seat5": usage(41, 0), "seat7": usage(42, 0)}
g, home = run(fx, "pick")
n1 = len(calls(home))
g2, _ = run(fx, "pick", home=home)
check("M1d-a second pick within 120 s makes no read", n1 == 5 and len(calls(home)) == 5 and g2["seat"],
      {"calls_after_1": n1, "calls_after_2": len(calls(home)), "pick2": g2})
e429 = {"error": "usage endpoint HTTP 429", "http": 429}
home = seed_usage(5)
g, _ = run({"seat1": e429, "seat2": e429}, "pick", home=home)
s1 = seats_of(home)["seat1"]
check("M1d-b 429 + last good 5 min old -> eligible, stale, backoff set", g["seat"] in ("seat1", "seat2")
      and s1["usage"]["known"] is True and s1["usage"]["stale"] is True and "429" in s1["usage"]["stale_reason"]
      and s1["usage"]["last_ok_at"] and s1["usage_backoff_until"] > s1["usage"]["read_at"], {"pick": g, "seat1": s1})
home = seed_usage(20)
g, _ = run({"seat1": e429, "seat2": usage(38, 0)}, "pick", home=home)
s1 = seats_of(home)["seat1"]
check("M1d-c 429 + last good 20 min old -> unknown, skipped", g["seat"] == "seat2" and s1["usage"]["known"] is False
      and "429" in s1["usage"]["reason"], {"pick": g, "seat1": s1})
home = seed_usage(5, backoff="2099-01-01T00:00:00Z")
g, _ = run({"seat1": usage(12, 0), "seat2": usage(38, 0)}, "pick", home=home)
s1 = seats_of(home)["seat1"]
check("M1d-d during backoff no read attempted, stale values used", calls(home) == [] and g["seat"]
      and s1["usage"]["stale"] is True and "backoff" in s1["usage"]["stale_reason"], {"pick": g, "seat1": s1})

# 8. contract: keys of status/pick/done (broker + adapter) are a superset of the pre-M1 shapes
g, home = run({"seat1": usage(5, 0), "seat2": usage(50, 0)}, "pick")
check("T8 broker pick keys", {"seat", "providerInstanceId", "id", "via"} <= set(g), g)
g, _ = run({"seat1": usage(5, 0), "seat2": usage(50, 0)}, "done", "seat1", home=home)
check("T8 broker done", g == {"ok": True}, g)
g, _ = run({}, "status", home=home)
check("T8 broker status keys", {"name", "capacity", "available", "beat", "updated", "free", "seats"} <= set(g)
      and all({"org", "logged_in", "in_flight", "runs", "maxed_until", "five_hour"} <= set(s) for s in g["seats"].values()), g)
g, home = run({"seat1": usage(5, 0), "seat2": usage(50, 0)}, "pick", prog=ADAPTER)
check("T8 adapter pick", set(g) == {"id", "via", "providerInstanceId"}, g)
g, _ = run({}, "done", "seat1", prog=ADAPTER, home=home)
check("T8 adapter done", g == {"ok": True}, g)
g, _ = run({}, "status", prog=ADAPTER, home=home)
check("T8 adapter status", set(g) == {"name", "capacity", "available", "ceiling", "open"}, g)

# team ceiling (20 open reservations) and memory floor (this host 2000 MB; --from <host> skips it)
fx = {"seat1": usage(10, 0), "seat2": usage(20, 0)}
home = seed({"seat1": 10, "seat2": 10})
g, _ = run(fx, "pick", home=home)
check("S8-a 20 open -> null id, ceiling reason", g["id"] is None and g["reason"] == "team worker ceiling 20 reached (20 open)", g)
g, _ = run({}, "status", home=home)
check("S8-b status shows ceiling 20 / open 20", g["ceiling"] == 20 and g["open"] == 20, g)
g, _ = run({}, "status", prog=ADAPTER, home=home)
check("S8-b2 adapter status shows ceiling/open", g["ceiling"] == 20 and g["open"] == 20, g)
run(fx, "done", "seat1", home=home)
g, _ = run(fx, "pick", home=home)
check("S8-c release one -> pick works", g["id"] in ("seat1", "seat2"), g)
g, _ = run(fx, "pick", home=seed({"seat1": 2, "seat2": 1}), extra_env={"BROKER_MAX_TOTAL": "3"})
check("S8-d BROKER_MAX_TOTAL=3 with 3 open -> ceiling 3", g["id"] is None and "ceiling 3 reached (3 open)" in g["reason"], g)
g, _ = run(fx, "pick", mem_mb=1500)
check("S8-e MemAvailable 1500 < floor 2000 -> null, low memory reason", g["id"] is None
      and g["reason"] == "low memory on local: 1500 MB available (floor 2000)", g)
g, _ = run(fx, "pick", mem_mb=1500, prog=ADAPTER)
check("S8-f adapter passes the low-memory refusal", g["id"] is None and "low memory on local" in g["reason"], g)
g, _ = run(fx, "pick", mem_mb=2500)
check("S8-g MemAvailable 2500 -> pick", g["id"] in ("seat1", "seat2"), g)
g, home = run(fx, "pick", mem_mb=2500)
g2, _ = run(fx, "pick", mem_mb=2500, home=home)
check("S8-h 2500 MB, one launch in the last 2 min counts 600 MB -> second pick refused at 1900",
      g["id"] and g2["id"] is None and g2["reason"] == "low memory on local: 1900 MB available (floor 2000)", [g, g2])
g, _ = run(fx, "pick", mem_mb=500, extra_env={"DISPATCH_MEM_FLOOR_MB": "400"})
check("S8-i DISPATCH_MEM_FLOOR_MB=400 lets 500 MB through", g["id"] in ("seat1", "seat2"), g)
# this host CPU gate, same rule as the another host client (2.0 x CPUs; 4 CPUs -> cap 8), local picks only
g, home = run(fx, "pick", load5=9.3)
check("S46-a load5 9.3 on 4 CPUs -> null, high load reason, no reservation",
      g["id"] is None and g["reason"] == "high load on local: load5 9.3 on 4 CPUs (cap 8)" and in_flight_total(home) == 0, g)
g, _ = run(fx, "pick", load5=7.9)
check("S46-b load5 7.9 (< cap 8) -> pick", g["id"] in ("seat1", "seat2"), g)
g, _ = run(fx, "pick", "--from", "other-host", load5=30)
check("S46-c --from another host skips this host's load gate (another host checked its own)", g["id"] in ("seat1", "seat2"), g)
g, _ = run(fx, "pick", prog=ADAPTER, load5=12)
check("S46-d adapter passes the high-load refusal verbatim", g == {"id": None, "reason": "high load on local: load5 12.0 on 4 CPUs (cap 8)", "retryable": True, "retry_after_s": 60}, g)
g, _ = run(fx, "pick", load5=12, extra_env={"DISPATCH_LOAD_PER_CPU": "4"})
check("S46-e DISPATCH_LOAD_PER_CPU=4 raises the cap to 16", g["id"] in ("seat1", "seat2"), g)
g, _ = run(fx, "pick", extra_env={"DISPATCH_LOADAVG": "/nonexistent/loadavg"})
check("S46-f unreadable loadavg never blocks", g["id"] in ("seat1", "seat2"), g)
# at most 6 concurrent agent sessions on this host (T3 threads with a turn in flight), local picks only
def sessions_file(n):
    f = os.path.join(tempfile.mkdtemp(prefix="sessions-"), "sessions.json")
    json.dump({"live": n, "threads": [], "at": "2099-01-01T00:00:00Z"} if n is not None else {"live": None}, open(f, "w"))
    return f
g, home = run(fx, "pick", extra_env={"DISPATCH_SESSIONS": sessions_file(6)})
check("S48-a 6 live sessions on this host (cap 6) -> null, session cap reason, no reservation",
      g["id"] is None and g["reason"] == "session cap on local: 6 live (cap 6)" and in_flight_total(home) == 0, g)
g, home = run(fx, "pick", extra_env={"DISPATCH_SESSIONS": sessions_file(5)})
g2, _ = run(fx, "pick", home=home, extra_env={"DISPATCH_SESSIONS": sessions_file(5)})
check("S48-b 5 live -> pick; a second pick within 60 s counts the first launch (5 + 1 = 6) -> refused",
      g["id"] in ("seat1", "seat2") and g2["id"] is None and g2["reason"] == "session cap on local: 6 live (cap 6)", [g, g2])
g, _ = run(fx, "pick", "--from", "other-host", extra_env={"DISPATCH_SESSIONS": sessions_file(9)})
check("S48-c --from another host skips this host's session cap (the thread launches on another host)", g["id"] in ("seat1", "seat2"), g)
g, _ = run(fx, "pick", extra_env={"DISPATCH_SESSIONS": sessions_file(7), "BROKER_MAX_SESSIONS": "8"})
check("S48-d BROKER_MAX_SESSIONS=8 lets a 7-session host pick", g["id"] in ("seat1", "seat2"), g)
g, _ = run(fx, "pick", extra_env={"DISPATCH_SESSIONS": sessions_file(None)})
g2, _ = run(fx, "pick")  # no token in the temp HOME: T3 unreadable
check("S48-e unreadable session count (fixture null, no T3 token) never blocks", g["id"] and g2["id"], [g, g2])
g, _ = run(fx, "pick", prog=ADAPTER, extra_env={"DISPATCH_SESSIONS": sessions_file(6)})
check("S48-f adapter passes the session-cap refusal verbatim", g == {"id": None, "reason": "session cap on local: 6 live (cap 6)", "retryable": True, "retry_after_s": 60}, g)
g, _ = run(fx, "sessions", extra_env={"DISPATCH_SESSIONS": sessions_file(4)})
check("S48-g `sessions` JSON: live/cap/full", g["live"] == 4 and g["cap"] == 6 and g["full"] is False and g["host"] == "local", g)
g, _ = run(fx, "sessions", prog=ADAPTER, extra_env={"DISPATCH_SESSIONS": sessions_file(7)})
check("S48-k adapter `sessions` passes the broker JSON through", g["live"] == 7 and g["full"] is True and g["cap"] == 6, g)
_, home = run(fx, "pick", "--from", "other-host")
g, _ = run(fx, "status", home=home, extra_env={"DISPATCH_SESSIONS": sessions_file(6)})
check("S48-h status carries sessions {live, cap, host}", g.get("sessions") == {"live": 6, "cap": 6, "host": "local"}, g.get("sessions"))
g, _ = run(fx, "pick", extra_env={"DISPATCH_SESSIONS": sessions_file(1), "DISPATCH_PROCS": "6"})
check("S57-a idle provider processes count toward the cap (1 turn, 6 processes)", g["id"] is None and g["reason"] == "session cap on local: 6 live (cap 6)" and g["retryable"] is True, g)
g, _ = run(fx, "sessions", extra_env={"DISPATCH_SESSIONS": sessions_file(3), "DISPATCH_PROCS": "2"})
check("S57-b `sessions` JSON: live is the larger of turns and processes, both shown", g["live"] == 3 and g["turns"] == 3 and g["procs"] == 2, g)
g, _ = run(fx, "pick", extra_env={"DISPATCH_SESSIONS": sessions_file(None), "DISPATCH_PROCS": "6"})
check("S57-c processes still cap when the T3 turn count is unreadable", g["id"] is None and "6 live" in g["reason"], g)


class FakeT3(BaseHTTPRequestHandler):
    """Stand-in T3 MCP server: two projects, active threads only when asked with the active statuses."""
    calls = []

    def log_message(self, *a):
        pass

    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        FakeT3.calls.append((self.headers.get("Authorization"), req.get("method"), (req.get("params") or {}).get("name"),
                             (req.get("params") or {}).get("arguments")))
        res = {}
        if req.get("method") == "tools/call":
            name, a = req["params"]["name"], req["params"]["arguments"]
            if name == "t3_project_list":
                res = {"structuredContent": {"projects": [{"id": "p1", "title": "team"}, {"id": "p2", "title": "site"},
                                                          {"id": "p3", "title": "old", "deletedAt": "2026-01-01"}]}}
            elif name == "t3_thread_list":
                ok = sorted(a.get("statuses") or []) == ["preparing", "queued", "running", "starting"] and a.get("includeSubagents")
                th = {"p1": [{"threadId": "t1", "status": "running", "title": "worker"}, {"threadId": "t2", "status": "starting"}],
                      "p2": [{"threadId": "t3", "status": "queued"}]}.get(a["projectId"], []) if ok else []
                res = {"content": [{"type": "text", "text": json.dumps({"threads": th})}]}
        body = "event: message\ndata: " + json.dumps({"jsonrpc": "2.0", "id": req.get("id"), "result": res}) + "\n\n"
        self.send_response(200 if req.get("id") is not None else 202)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("mcp-session-id", "sid-1")
        self.end_headers()
        self.wfile.write(body.encode() if req.get("id") is not None else b"")


t3srv = ThreadingHTTPServer(("127.0.0.1", 0), FakeT3)
threading.Thread(target=t3srv.serve_forever, daemon=True).start()
t3home = tempfile.mkdtemp(prefix="broker-t3-")
os.makedirs(os.path.join(t3home, ".epic-team", "broker"), exist_ok=True)
open(os.path.join(t3home, ".epic-team", "broker", ".t3token"), "w").write("tok-x\n")
T3ENV = {"T3_MCP_URL": "http://127.0.0.1:%d/mcp" % t3srv.server_address[1]}
g, _ = run(fx, "sessions", home=t3home, extra_env=T3ENV)
lists = [c for c in FakeT3.calls if c[2] == "t3_thread_list"]
check("S48-i real T3 read: 3 active threads over 2 projects (deleted skipped), bearer token, subagents included",
      g["live"] == 3 and g["turns"] == 3 and sorted(c[3]["projectId"] for c in lists) == ["p1", "p2"]  # read in parallel: any order
      and all(c[0] == "Bearer tok-x" for c in FakeT3.calls), [g, FakeT3.calls])
n = len(FakeT3.calls)
g, _ = run(fx, "pick", home=t3home, extra_env=dict(T3ENV, BROKER_MAX_SESSIONS="3"))
check("S48-j pick reuses the cached count (no T3 call within 20 s) and refuses at cap 3",
      g["id"] is None and g["reason"] == "session cap on local: 3 live (cap 3)" and len(FakeT3.calls) == n, g)
t3srv.shutdown()
__import__("shutil").rmtree(t3home, ignore_errors=True)  # its fake .t3token showed up as a leak-watch finding

g, _ = run(fx, "pick", "--from", "other-host", mem_mb=500, prog=ADAPTER)
check("S8-j adapter pick --from another host skips this host's memory check", g["id"] in ("seat1", "seat2"), g)
g, home = run(fx, "pick", "--from", "other-host", mem_mb=2500)
g2, _ = run(fx, "pick", mem_mb=2500, home=home)
check("S8-k a another host launch does not count against this host's memory", g["id"] and g2["id"], [g, g2])

# every null pick says whether a retry may get past it and when; `reason` is unchanged (the console parses it)
fx = {"seat1": usage(10, 0), "seat2": usage(20, 0)}
R = lambda g, ok, after: g["id"] is None and g["retryable"] is ok and g["retry_after_s"] == after
for prog, tag in ((BROKER, "broker"), (ADAPTER, "adapter")):
    g, _ = run(fx, "pick", prog=prog, mem_mb=1500)
    check("S54-a %s low memory: retryable after 60 s, reason unchanged" % tag, R(g, True, 60) and g["reason"] == "low memory on local: 1500 MB available (floor 2000)", g)
    g, _ = run(fx, "pick", prog=prog, load5=9.0)
    check("S54-b %s high load: retryable after 60 s" % tag, R(g, True, 60) and g["reason"] == "high load on local: load5 9.0 on 4 CPUs (cap 8)", g)
    g, _ = run(fx, "pick", prog=prog, extra_env={"DISPATCH_SESSIONS": sessions_file(6)})
    check("S54-c %s session cap: retryable after 60 s" % tag, R(g, True, 60) and g["reason"].startswith("session cap on local: 6 live"), g)
    g, _ = run(fx, "pick", prog=prog, home=seed({"seat1": 10, "seat2": 10}))
    check("S54-d %s team ceiling: retryable after 120 s" % tag, R(g, True, 120) and g["reason"].startswith("team worker ceiling 20 reached"), g)
    g, _ = run({"seat1": usage(95, 0), "seat2": usage(96, 0)}, "pick", prog=prog)
    check("S54-e %s all seats near their limit: retryable after 120 s" % tag, R(g, True, 120) and g["reason"].startswith("no seat: "), g)
    h = tempfile.mkdtemp(prefix="broker-test-")
    os.makedirs(os.path.join(h, ".epic-team", "broker"))
    open(os.path.join(h, ".epic-team", "broker", "PAUSE"), "w").close()
    g, _ = run(fx, "pick", prog=prog, home=h)
    check("S54-f %s paused: not retryable" % tag, R(g, False, None) and g["reason"] == "paused", g)
g, _ = run(fx, "pick", "--from", "other-host", prog=ADAPTER, mem_mb=1500)
check("S54-g --from another host skips this host's gates and picks (no refusal fields on a seat)", g["id"] in ("seat1", "seat2") and "retryable" not in g, g)
g, home = run(fx, "usage")
before = json.load(open(os.path.join(home, ".epic-team", "broker", "seats.json")))
g, _ = run(fx, "probe", home=home)
g2, _ = run(fx, "probe", prog=ADAPTER, home=home)
after = json.load(open(os.path.join(home, ".epic-team", "broker", "seats.json")))
check("S54-i probe with headroom: ok, nothing reserved, seats.json untouched (broker + adapter)",
      g == {"host": "local", "ok": True} and g2 == g and before == after, [g, g2])
g, _ = run(fx, "probe", home=home, load5=9.0)
check("S54-j probe at this host's load cap: not ok, retryable, reason as pick's", g["ok"] is False and g["retryable"] is True
      and g["retry_after_s"] == 60 and g["reason"].startswith("high load on local") and in_flight_total(home) == 0, g)
g, _ = run(fx, "probe", home=home, extra_env={"DISPATCH_SESSIONS": sessions_file(6)})
check("S54-k probe at the session cap: not ok", g["ok"] is False and g["reason"].startswith("session cap on local"), g)
g, _ = run(fx, "probe", home=seed({"seat1": 10, "seat2": 10}))
check("S54-l probe at the team ceiling: not ok", g["ok"] is False and g["reason"].startswith("team worker ceiling"), g)
# pick starts one detached token-refresh session on this host (the claude turn is stubbed), one per 90 s, each seat
# at most once per 30 min, never at the session cap; refresh-token runs the command under the seat's config dir
import time
home = seed({"seat1": 0, "seat2": 0, "seat7": 0})
probe = os.path.join(home, "refresh.sh")
open(probe, "w").write('#!/bin/sh\necho "$CLAUDE_CONFIG_DIR" >> %s/refresh.calls\n' % home)
os.chmod(probe, 0o755)
RX = {"BROKER_REFRESH_CMD": probe}
g, _ = run({"seat1": EXP, "seat2": EXP, "seat7": usage(10, 0)}, "pick", "--from", "other-host", home=home, extra_env=dict(RX, DISPATCH_SESSIONS=sessions_file(1)))
for _ in range(50):
    if os.path.exists(os.path.join(home, "refresh.calls")):
        break
    time.sleep(0.1)
calls = open(os.path.join(home, "refresh.calls")).read().split() if os.path.exists(os.path.join(home, "refresh.calls")) else []
check("S60i pick starts a refresh session for one expired seat under its config dir", g["seat"] == "seat7"
      and g.get("token_refresh_started") == "seat1" and calls == [os.path.join(home, ".claude_seat1")], [g, calls])
g, _ = run({"seat1": EXP, "seat2": EXP, "seat7": usage(10, 0)}, "pick", "--from", "other-host", home=home, extra_env=dict(RX, DISPATCH_SESSIONS=sessions_file(1)))
check("S60j a second pick within 90 s starts none", "token_refresh_started" not in g, g)
d = json.load(open(os.path.join(home, ".epic-team", "broker", "seats.json")))
d["token_refresh_at"] = "2000-01-01T00:00:00Z"
json.dump(d, open(os.path.join(home, ".epic-team", "broker", "seats.json"), "w"))
g, _ = run({"seat1": EXP, "seat2": EXP, "seat7": usage(10, 0)}, "pick", "--from", "other-host", home=home, extra_env=dict(RX, DISPATCH_SESSIONS=sessions_file(1)))
check("S60k after the gap the next expired seat (seat1 cooling down 30 min)", g.get("token_refresh_started") == "seat2", g)
d = json.load(open(os.path.join(home, ".epic-team", "broker", "seats.json")))
d["token_refresh_at"] = "2000-01-01T00:00:00Z"
json.dump(d, open(os.path.join(home, ".epic-team", "broker", "seats.json"), "w"))
g, _ = run({"seat1": EXP, "seat2": EXP, "seat7": usage(10, 0)}, "pick", "--from", "other-host", home=home, extra_env=dict(RX, DISPATCH_SESSIONS=sessions_file(6)))
check("S60l at the session cap: no refresh session", "token_refresh_started" not in g and g["seat"] == "seat7", g)
g, _ = run({"seat1": usage(10, 0)}, "pick", home=seed({"seat1": 0}), extra_env=RX)
check("S60m no expired seat: no refresh session", "token_refresh_started" not in g, g)
g, h = run(None, "refresh-token", "seat3", extra_env=RX)
check("S60n refresh-token runs the command and logs it", g == {"seat": "seat3", "result": "rc=0"}
      and "token refresh session for seat3: rc=0" in open(os.path.join(h, ".epic-team", "broker", "heartbeat.log")).read(), g)

# a seat whose usage cannot be read gets its sign-in rechecked on pick; signed out -> "logged out"
home = tempfile.mkdtemp(prefix="broker-test-")
authsh = os.path.join(home, "auth.sh")
open(authsh, "w").write("#!/bin/sh\ncase \"$CLAUDE_CONFIG_DIR\" in *seat1) echo '{\"loggedIn\": false}';; *) echo '{\"loggedIn\": true}';; esac\n")
os.chmod(authsh, 0o755)
AX = {"BROKER_AUTH_CMD": authsh}
g, home = run({"seat1": {"error": "usage endpoint HTTP 429", "http": 429}, "seat2": usage(10, 0)}, "pick", home=home, extra_env=AX)
d = json.load(open(os.path.join(home, ".epic-team", "broker", "seats.json")))
check("S111a unknown-usage seat rechecked: signed out shows logged out", d["seats"]["seat1"]["logged_in"] is False
      and d["seats"]["seat2"].get("auth_checked") is None and g["seat"] == "seat2", g)
g, _ = run({"seat1": {"error": "usage endpoint HTTP 429", "http": 429}, "seat2": usage(10, 0)}, "status", home=home, extra_env=AX)
check("S111b status shows seat1 signed out and not free", g["seats"]["seat1"]["logged_in"] is False and g["free"] == ["seat2"], g)

print("\n%d failed" % len(FAIL) if FAIL else "\nall passed")
sys.exit(1 if FAIL else 0)
