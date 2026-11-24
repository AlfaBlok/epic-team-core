#!/usr/bin/env python3
"""Token usage of console runs, read from Claude Code transcripts on this host.

Usage: run_usage.py '<json>'   where json = {"runs": [{"id": "run_…", "since": <epoch s>}], "dirs": ["~/.claude_seat1", …]}
Prints one JSON object: {"<run id>": {"models": {"<model>": {input, cacheWrite, cacheRead, output, turns}}, "files": n} | null}.

Never prints message text: only run ids (given by the caller), model names and token counts leave this script. It runs
the same on the main server (locally) and on a second host (`ssh … python3 - '<json>' < run_usage.py`), stdlib only.

Which transcript lines belong to run X (a JSONL file is one Claude Code session; a T3 home thread can hold many wakes):
- anchor: a user text message containing `this run X`, `(run X)` (the wake protocol header) or `"clientRequestId":"X"`
  (the wake stub POSTs `/wake` with the run id as its clientRequestId and saves the reply to a file, so the header
  may never show up). The run's lines go from that message to the next user text message anchoring another run (or EOF);
- a home thread's wake is a stub message (`Agent-team console wake for assignment …`) whose turn curls the wake prompt:
  the `Console protocol (run X)` header in that tool result starts run X back at the stub message (so does `this run X`
  in a tool result of the stub's own turn, before any run is named: older stubs saved the prompt to a file and grepped it;
  and so does a reply naming exactly one run of the stub's assignment, `{"id":"X","assignmentId":"<as>"…}`: the
  persona's own PATCH of its run, when it never printed the prompt's header; and so does the stub turn's first tool
  result naming any run id, when it names exactly one: the persona grepped its id out of the saved prompt);
- otherwise, the file's FIRST user text message (skipping `<local-command-caveat>` / slash-command / compact-summary
  lines) names X: `Your run id: X` / `Child run id: X` / `Console run: X` (a delegated worker's brief), `runs/X`, or X is the only run id in
  it that is not named as the parent: the whole file;
- a worker whose brief names only its parent P (`Parent DM run: P`) and that records itself (`POST /api/runs` with
  parentRunId P) is run C from the reply `{"id":"C",…,"parentRunId":"P"}`: the whole file.
- a delegated worker whose run carries its T3 thread id (`thread:delegated-task:…`): T3's state DB
  (~/.t3/userdata/statev2.sqlite, read-only) names the Claude session behind that thread; that whole file is X, unless
  the file names its own run Y (a second row for the same worker): then it stays Y's and X is printed with no tokens
  and `sameAs: Y`, so the worker is counted once.
A file that merely mentions X elsewhere (a manager quoting it, a runs listing) is never counted for X.
Seat dirs: `dirs` empty or ["auto"] = every `~/.claude` and `~/.claude_seat*` directory on the host. Each run
also gets `seat`: the config dir most of its tokens came from (`seatN` for `.claude_seatN`, `default` for `.claude`).
A sandboxed world job keeps its whole session in `<worlds root>/.logs/<world>/<run>.jsonl` (the root: `worldLogs` in the
request, else $WORLDS_ROOT; neither = not read): that file is the run's, all of it, and its `seat` is `sandbox` (no seat
dir holds that transcript, so without this such runs had no usage and their world's credit meter never moved).
Assistant lines are counted once per API message id (Claude Code writes one line per content block, each repeating the
same usage), across files too (a resumed session copies earlier lines into its new file). `<synthetic>` lines are skipped.
"""
import glob
import json
import os
import re
import sqlite3
import sys

RUN_ID = re.compile(r"run_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
ANCHOR = re.compile(r"(?:this run |\(run )(run_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})")
# The wake protocol header; in a home thread it arrives in the tool result of the stub's `curl …/wake`.
HEADER = re.compile(r"Console protocol \(run (run_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)")
_ID = r"(run_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"
# the wake stub's `-d '{"clientRequestId":"run_X"}'` (quotes may arrive escaped).
CLIENT_REQ = re.compile(r'clientRequestId\\*"\s*:\s*\\*"' + _ID)
# A delegated worker's brief naming its own run, and one naming only its parent.
OWN = re.compile(r"\b(?:[Yy]our|[Cc]hild|Console) run(?: id)?[:*\s]*(?:is\s+)?`?" + _ID)
PARENT = re.compile(r"\b[Pp]arent(?:RunId|_run_id| DM run| run)?(?: id)?[:*=\s]*(?:is\s+)?[`\"]?" + _ID)
# Bumped when the matching rules change: the console re-reads the last 7 days' usage read by an older scan.
SCAN_VERSION = 3  # 3: sandbox job transcripts
STUB = "Agent-team console wake for assignment"
STUB_AS = re.compile(r"Agent-team console wake for assignment (as_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})")
# Lines Claude Code writes as user text that no one typed: never "the first message".
NOT_A_PROMPT = ("<local-command-caveat>", "<command-name>", "<command-message>", "<local-command-stdout>", "Caveat: ")


def anchors_in(t):
    return set(ANCHOR.findall(t)) | set(CLIENT_REQ.findall(t))


def seat_of(path):
    """`…/.claude_seat3/projects/…` -> seat3, `…/.claude/projects/…` -> default."""
    parts = path.split(os.sep)
    for p in reversed(parts):
        if p.startswith(".claude_"):
            return p[len(".claude_"):]
        if p == ".claude":
            return "default"
    return "unknown"


def discover_dirs():
    home = os.path.expanduser("~")
    found = []
    for d in [os.path.join(home, ".claude")] + sorted(glob.glob(os.path.join(home, ".claude_seat*"))):
        if os.path.isdir(d) and os.path.isdir(os.path.join(d, "projects")):
            found.append(d)
    return found


def user_text(o):
    if o.get("type") != "user":
        return None
    m = o.get("message") or {}
    if m.get("role") != "user":
        return None
    c = m.get("content")
    if isinstance(c, str):
        t = c
    elif isinstance(c, list):
        t = " ".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text")
    else:
        t = ""
    return t if t.strip() else None


def tool_result_text(o):
    if o.get("type") != "user":
        return ""
    c = (o.get("message") or {}).get("content")
    if not isinstance(c, list):
        return ""
    parts = []
    for b in c:
        if isinstance(b, dict) and b.get("type") == "tool_result":
            cc = b.get("content")
            if isinstance(cc, str):
                parts.append(cc)
            elif isinstance(cc, list):
                parts.extend(x.get("text", "") for x in cc if isinstance(x, dict))
    return " ".join(parts)


def thread_sessions(threads, state=None):
    """T3 thread id -> the Claude session ids (JSONL basenames) T3 ran it in; {} when T3's state DB is not here."""
    state = state or os.path.expanduser("~/.t3/userdata/statev2.sqlite")
    if not threads or not os.path.exists(state):
        return {}
    out = {}
    try:
        con = sqlite3.connect("file:%s?mode=ro" % state, uri=True, timeout=5)
        try:
            for t in threads:
                for (payload,) in con.execute(
                    "SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE thread_id = ?", (t,)
                ):
                    try:
                        sid = ((json.loads(payload) or {}).get("nativeThreadRef") or {}).get("nativeId")
                    except ValueError:
                        sid = None
                    if sid:
                        out.setdefault(t, set()).add(sid)
        finally:
            con.close()
    except sqlite3.Error:
        return out
    return out


def scan_file(path, wanted, seen, out, forced=None):
    """forced: the run this whole file belongs to (its T3 thread is that run's), unless the file names its own run.
    Returns the run the file names itself when that is not `forced` (a duplicate row for one worker), else None."""
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            raw = fh.read()
    except OSError:
        return None
    if forced is None and not any(r in raw for r in wanted):
        return None
    lines = []
    for line in raw.splitlines():
        try:
            lines.append(json.loads(line))
        except ValueError:
            continue
    # Which run each line belongs to (None = no run); decided at user text messages, and at a wake prompt fetched by
    # a home thread's stub (the stub message and the turn that fetched it then belong to that run too).
    current = None
    first = True
    last_text = 0
    owner = []
    parent = None  # the brief named only its parent run: wait for the worker's own POST /api/runs reply
    stub_open = False  # a wake stub's turn that has not named its run yet
    stub_as = None  # that stub's assignment id
    stub_ids_seen = False  # a tool result in that turn already named some run
    seat = seat_of(path)
    for i, o in enumerate(lines):
        t = user_text(o)
        if t is not None and (o.get("isMeta") or o.get("isCompactSummary") or t.lstrip().startswith(NOT_A_PROMPT)):
            t = False  # not typed by anyone: neither an anchor nor the first message
        if t:
            last_text = i
            anchors = anchors_in(t)
            stub_open = not anchors and STUB in t
            m = STUB_AS.search(t) if stub_open else None
            stub_as = m.group(1) if m else None
            stub_ids_seen = False
            if len(anchors) == 1:
                current = anchors.pop()
                parent = None
            elif first:
                own = set(OWN.findall(t))
                parents = set(PARENT.findall(t))
                ids = set(RUN_ID.findall(t)) - parents
                named = [r for r in ids if ("runs/" + r) in t]
                if len(own) == 1:
                    current = own.pop()
                elif len(named) == 1:
                    current = named[0]
                elif len(ids) == 1:
                    current = ids.pop()
                elif not ids and len(parents) == 1:
                    parent = parents.pop()
            first = False
        elif t is None:
            res = tool_result_text(o)
            headers = set(HEADER.findall(res))
            if not headers and stub_open and not stub_ids_seen:
                ids = set(RUN_ID.findall(res))
                if ids:
                    stub_ids_seen = True
                    if len(ids) == 1:
                        headers = ids
            if not headers and stub_open:
                headers = set(ANCHOR.findall(res))
            if not headers and stub_open and stub_as and stub_as in res:
                headers = set(re.findall(r'"id"\s*:\s*"' + _ID + r'"\s*,\s*"assignmentId"\s*:\s*"' + stub_as + '"', res))
            if len(headers) == 1:
                stub_open = False
                run = headers.pop()
                if run != current:
                    current = run
                    owner[last_text:] = [run] * (i - last_text)
            elif parent and current is None and parent in res:
                m = re.search(r'"id"\s*:\s*"' + _ID + r'"[^{}]*"parentRunId"\s*:\s*"' + re.escape(parent) + '"', res)
                if m:
                    current = m.group(1)
                    owner[:] = [current] * len(owner)
                    parent = None
        owner.append(current)
    same_as = None
    if forced is not None:
        named = set(owner) - {None}
        if named and forced not in named:
            same_as = named.pop() if len(named) == 1 else None
        else:
            owner = [forced] * len(lines)
    touched = set()
    for o, run in zip(lines, owner):
        if run in wanted and add_usage(o, run, seen, out, seat):
            touched.add(run)
    # Native subagents (Agent tool) write their own files under <session>/subagents/; each goes to the run whose
    # segment was open when the subagent started (by timestamp).
    starts = []
    for o, run in zip(lines, owner):
        if (not starts or starts[-1][1] != run) and o.get("timestamp"):
            starts.append((o["timestamp"], run))
    for sub in sorted(glob.glob(os.path.join(path[: -len(".jsonl")], "subagents", "*.jsonl"))):
        try:
            with open(sub, encoding="utf-8", errors="replace") as fh:
                slines = [json.loads(l) for l in fh if l.strip().startswith("{")]
        except (OSError, ValueError):
            continue
        ts = next((o.get("timestamp") for o in slines if o.get("timestamp")), None)
        run = None
        for start, r in starts:
            if ts is not None and start <= ts:
                run = r
        if run not in wanted:
            continue
        for o in slines:
            if add_usage(o, run, seen, out, seat):
                touched.add(run)
    for run in touched:
        out[run]["files"] += 1
    return same_as


def add_usage(o, run, seen, out, seat="unknown"):
    """Add one assistant line's usage to out[run]; False when the line carries none."""
    if o.get("type") != "assistant":
        return False
    m = o.get("message") or {}
    u = m.get("usage")
    model = m.get("model") or "unknown"
    if not isinstance(u, dict) or model == "<synthetic>":
        return False
    key = m.get("id") or o.get("uuid")
    prev = seen.get(key)
    rec = {
        "input": int(u.get("input_tokens") or 0),
        "cacheWrite": int(u.get("cache_creation_input_tokens") or 0),
        "cacheRead": int(u.get("cache_read_input_tokens") or 0),
        "output": int(u.get("output_tokens") or 0),
    }
    r = out.setdefault(run, {"models": {}, "files": 0, "seats": {}})
    sums = r["models"].setdefault(model, {"input": 0, "cacheWrite": 0, "cacheRead": 0, "output": 0, "turns": 0})
    if prev is None:
        sums["turns"] += 1
    else:
        # Same API message seen again: keep the larger counts (output can grow across a message's lines).
        prun, pmodel, prec = prev
        if prun != run or pmodel != model:
            return False
        for k in rec:
            sums[k] -= prec[k]
        rec = {k: max(rec[k], prec[k]) for k in rec}
    for k in rec:
        sums[k] += rec[k]
    if prev is None:
        r["seats"][seat] = r["seats"].get(seat, 0) + sum(rec.values())
    seen[key] = (run, model, rec)
    return True


def sandbox_files(runs, root=None):
    """Each run's sandbox job transcript, `<root>/.logs/<world>/<run>.jsonl` (left out when there is none)."""
    root = root or os.environ.get("WORLDS_ROOT") or ""
    out = {}
    if not root:
        return out
    logs = os.path.join(os.path.expanduser(root), ".logs")
    for run in runs:
        found = sorted(glob.glob(os.path.join(logs, "*", run + ".jsonl")))
        if found and not os.path.islink(found[0]):
            out[run] = found[0]
    return out


def scan_sandbox(path, run, seen, out):
    """The whole sandbox transcript is `run`'s (one job, one session): every assistant line counts for it."""
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            lines = [json.loads(l) for l in fh if l.strip().startswith("{")]
    except (OSError, ValueError):
        return False
    hit = False
    for o in lines:
        if add_usage(o, run, seen, out, "sandbox"):
            hit = True
    if hit:
        out[run]["files"] += 1
    return hit


def main():
    req = json.loads(sys.argv[1])
    valid = [r for r in req.get("runs", []) if RUN_ID.fullmatch(r.get("id", ""))]
    runs = {r["id"]: float(r.get("since") or 0) for r in valid}
    # Delegated workers: their own session, by T3 thread id (home threads hold many wakes: anchors decide there).
    by_thread = {r["thread"]: r["id"] for r in valid if str(r.get("thread") or "").startswith("thread:delegated-task:")}
    forced = {}
    for t, sids in thread_sessions(list(by_thread), req.get("t3State")).items():
        for sid in sids:
            forced[sid] = by_thread[t]
    since = min(runs.values()) if runs else 0
    dirs = [d for d in req.get("dirs") or [] if d != "auto"]
    if not dirs:
        dirs = discover_dirs()
    files = []
    for d in dirs:
        for f in glob.glob(os.path.join(os.path.expanduser(d), "projects", "*", "*.jsonl")):
            try:
                mt = os.path.getmtime(f)
            except OSError:
                continue
            if mt >= since:
                files.append((mt, f))
    out = {}
    seen = {}
    wanted = set(runs)
    files.sort()
    same_as = {}
    # a sandboxed world job's own transcript first (the whole file is that run's)
    for run, f in sandbox_files(wanted, req.get("worldLogs")).items():
        scan_sandbox(f, run, seen, out)
    # Forced files first: a worker's own session wins its API messages over any file that copied them.
    for _, f in files:
        sid = os.path.basename(f)[: -len(".jsonl")]
        if sid in forced:
            dup = scan_file(f, wanted, seen, out, forced[sid])
            if dup:
                same_as[forced[sid]] = dup
    for _, f in files:
        if os.path.basename(f)[: -len(".jsonl")] not in forced:
            scan_file(f, wanted, seen, out)
    for r in out.values():
        seats = r.pop("seats", {})
        r["seat"] = max(seats, key=seats.get) if seats else None
    res = {r: out.get(r) for r in runs}
    for r, y in same_as.items():
        if not res.get(r):
            res[r] = {"models": {}, "files": 0, "seat": None, "sameAs": y}
    res["_meta"] = {"dirs": [seat_of(os.path.join(os.path.expanduser(d), "projects")) for d in dirs], "scan": SCAN_VERSION}
    print(json.dumps(res))


if __name__ == "__main__":
    main()
