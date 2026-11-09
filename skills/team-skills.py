#!/usr/bin/env python3
"""team-skills: install the team skill library (skills/team-skills.json) into every agent config dir.

  team-skills.py sync      [--json] [--quiet]   fetch pinned third-party skills, link every skill into every config dir
  team-skills.py check     [--json]             exit 1 and list drift (missing / extra / stale / conflict) per config dir
  team-skills.py list      [--json]             the manifest
  team-skills.py add <github-url> [--name N] [--path P] [--use-when TEXT] [--dry-run] [--no-sync] [--json]
  team-skills.py remove <name> [--no-sync] [--json]
  team-skills.py install-timer [--json]         systemd user timer running `sync` every 10 min
  team-skills.py world-link --world W --dest CHECKOUT --manifest-json JSON [--json]
                                               link one world's own skills into that world's checkout only

World skills: a world (a tenant of a hosted console) adds its own skills on top of this library; they are
kept in the world's repo (skills/world-skills.json, the console writes it) and never in this manifest or a shared config
dir. `world-link` fetches them into a per-world cache (<cache>/.worlds/<world>/.repos/...) and links each into the
checkout the world's wake runs in: <checkout>/.claude/skills/<name> (Claude Code project skills) and
<checkout>/.agents/skills/<name> (Codex), listed in the checkout's .git/info/exclude so they are never committed. Links
of that world's cache no longer in its manifest are removed; anything else in those dirs is never touched (a name clash
is a conflict). `sync` and `check` ignore .worlds, so a world's skill never reaches another world's seats.

With TEAM_SKILLS_MCP_INSTALLER set to an installer script (`<script> --json --check|--alert`, answering
{"green", "configs", "host_problems", "alert"?}), sync and check also cover the seats' baseline MCP servers through it:
sync installs them in every seat config and alerts on a problem it cannot fix, check reports them
(TEAM_SKILLS_MCP=0 skips this).

Config dirs are found by glob on every run, so a seat added later is covered with no edit:
~/.claude/skills, ~/.claude_seat<N>/skills (Claude Code), ~/.agents/skills (Codex and other agents),
~/.codex/skills (Codex's own $CODEX_HOME/skills). A dir is used only if its parent (~/.claude_seat3, ~/.codex ...) exists.

Ownership: an entry is ours only if it is a symlink into this repo's skills/ or into the cache. Anything else
(epic-spine links, real dirs, a user's own skill) is never touched; a name clash with one is reported as a conflict.
Third-party skills are fetched at their pinned commit into ~/.local/share/team-skills/.repos/<owner>__<repo>/<sha>
(immutable): one sparse checkout per repo@sha, shared by every skill pinned there, holding only those skills' folders
plus the repo's top-level files (git cone mode; blobs outside them are never downloaded where the server supports
partial clone). A skill links to its folder inside it. When a new skill needs a folder that checkout lacks, it is
fetched again with the union and swapped in (one full checkout per skill would hold the same commit many times).

Env overrides (tests, pre-merge rollout): TEAM_SKILLS_REPO, TEAM_SKILLS_MANIFEST, TEAM_SKILLS_CACHE, TEAM_SKILLS_GITHUB_BASE.
Exit: 0 green, 1 drift or conflict, 2 usage or fetch error.
"""
import argparse
import fcntl
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
SEAT_DIR_RE = re.compile(r"^\.claude(_seat[0-9]+)?$")
GITHUB_URL_RE = re.compile(
    r"^(?:https?://(?:www\.)?github\.com/|git@github\.com:)([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?"
    r"(?:/tree/([^/]+)(?:/(.*?))?)?/?$")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
TIMER_NAME = "team-skills"


class Fail(Exception):
    pass


def repo_root():
    return Path(os.environ.get("TEAM_SKILLS_REPO") or Path(__file__).resolve().parent.parent).resolve()


def manifest_path():
    return Path(os.environ.get("TEAM_SKILLS_MANIFEST") or repo_root() / "skills" / "team-skills.json")


def cache_root():
    env = os.environ.get("TEAM_SKILLS_CACHE")
    if env:
        return Path(env)
    base = os.environ.get("XDG_DATA_HOME") or os.path.join(Path.home(), ".local", "share")
    return Path(base) / "team-skills"


def github_base():
    return os.environ.get("TEAM_SKILLS_GITHUB_BASE", "https://github.com").rstrip("/")


def tilde(p):
    p, h = str(p), str(Path.home())
    return "~" + p[len(h):] if p == h or p.startswith(h + "/") else p


# ---- manifest ---------------------------------------------------------------------------------------------

def load_manifest(missing_ok=False):
    p = manifest_path()
    try:
        m = json.loads(p.read_text())
    except FileNotFoundError:
        if missing_ok:
            return {"version": 1, "skills": []}
        raise Fail("manifest not found: %s" % p)
    except ValueError as e:
        raise Fail("manifest is not valid JSON: %s" % e)
    return validate_manifest(m)


def validate_manifest(m):
    skills = m.get("skills") if isinstance(m, dict) else None
    if not isinstance(skills, list):
        raise Fail("manifest has no skills list")
    seen = set()
    for s in skills:
        name, src = s.get("name"), s.get("source") or {}
        if not isinstance(name, str) or not NAME_RE.match(name):
            raise Fail("bad skill name in manifest: %r" % (name,))
        if name in seen:
            raise Fail("duplicate skill in manifest: %s" % name)
        seen.add(name)
        if src.get("type") == "local":
            if not src.get("path"):
                raise Fail("%s: local source needs a path" % name)
        elif src.get("type") == "github":
            if not src.get("repo") or not SHA_RE.match(src.get("commit") or ""):
                raise Fail("%s: github source needs repo and a 40-char commit sha" % name)
            # a world's manifest is written in its repo; a source must stay inside its own checkout of repo@sha
            if not REPO_RE.match(src["repo"]):
                raise Fail("%s: github repo must be <owner>/<repo>: %r" % (name, src["repo"]))
            sub = src.get("path") or ""
            if not isinstance(sub, str) or sub.startswith("/") or ".." in sub.split("/") or "\\" in sub:
                raise Fail("%s: path must be a folder inside the repo: %r" % (name, sub))
        else:
            raise Fail("%s: unknown source type %r" % (name, src.get("type")))
    return m


def save_manifest(m):
    m["skills"].sort(key=lambda s: s["name"])
    p = manifest_path()
    fd, tmp = tempfile.mkstemp(dir=str(p.parent), prefix=".team-skills.", suffix=".json")
    with os.fdopen(fd, "w") as f:
        f.write(json.dumps(m, indent=2) + "\n")
    os.chmod(tmp, 0o644)
    os.replace(tmp, p)


def clone_url(repo):
    return "%s/%s.git" % (github_base(), repo)


REPOS_DIR = ".repos"
SPARSE_MARK = ".team-skills-sparse.json"


def repo_checkout(src):
    """The shared checkout dir of a github source: <cache>/.repos/<owner>__<repo>/<sha>."""
    return cache_root() / REPOS_DIR / src["repo"].replace("/", "__").lower() / src["commit"]


def skill_path(src):
    return (src.get("path") or "").strip("/")


def desired_target(skill):
    src = skill["source"]
    if src["type"] == "local":
        return (repo_root() / src["path"]).resolve()
    sub = skill_path(src)
    base = repo_checkout(src)
    return base / sub if sub else base


# ---- config dirs ------------------------------------------------------------------------------------------

def config_dirs():
    """Every skills dir an agent on this host reads, found by glob (new seats need no edit)."""
    home = Path.home()
    out = []
    try:
        entries = sorted(os.listdir(home))
    except OSError:
        entries = []
    for e in entries:
        if SEAT_DIR_RE.match(e) and (home / e).is_dir():
            out.append(home / e / "skills")
    for e in (".agents", ".codex"):
        if (home / e).is_dir():
            out.append(home / e / "skills")
    return out


def owned(target):
    """True if a link target points into our repo's skills/ or our cache."""
    t = os.path.normpath(str(target))
    for root in (str(repo_root() / "skills"), str(cache_root())):
        root = os.path.normpath(root)
        if t == root or t.startswith(root + "/"):
            return True
    return False


def link_target(path):
    t = os.readlink(path)
    return os.path.normpath(os.path.join(os.path.dirname(str(path)), t))


def scan_dir(d, skills):
    """Drift of one config dir: {missing, stale, extra, conflict, ok} lists of names."""
    r = {"dir": tilde(d), "ok": [], "missing": [], "stale": [], "extra": [], "conflict": []}
    names = {s["name"] for s in skills}
    for s in skills:
        p = d / s["name"]
        want = str(desired_target(s))
        if not os.path.lexists(p):
            r["missing"].append(s["name"])
        elif p.is_symlink():
            have = link_target(p)
            if have == want:
                r["ok"].append(s["name"])
            elif owned(have):
                r["stale"].append(s["name"])
            else:
                r["conflict"].append(s["name"])
        else:
            r["conflict"].append(s["name"])
    if d.is_dir():
        for e in sorted(os.listdir(d)):
            p = d / e
            if e not in names and p.is_symlink() and owned(link_target(p)):
                r["extra"].append(e)
    r["green"] = not (r["missing"] or r["stale"] or r["extra"] or r["conflict"])
    return r


def source_problems(skills):
    """Skills whose source is not on disk: local path missing, or third-party not yet fetched."""
    out = []
    for s in skills:
        t = desired_target(s)
        if not (t / "SKILL.md").is_file():
            out.append({"name": s["name"], "problem": "uncached" if s["source"]["type"] == "github" else "missing source",
                        "path": tilde(t)})
    return out


# ---- fetch ------------------------------------------------------------------------------------------------

def git(args, cwd=None, timeout=300):
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0")
    r = subprocess.run(["git"] + args, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise Fail("git %s failed: %s" % (args[0], (r.stderr or r.stdout).strip()[-300:]))
    return r.stdout


def fetch_to(repo, sha, dest, paths=None):
    """Check out repo@sha into dest (a new dir) without .git. `paths` (dirs): a cone-mode sparse checkout of just
    those plus every top-level file, with blobs fetched only for them (partial clone, where the server allows it);
    None, or any empty path (a skill at the repo root), checks out everything."""
    dest.mkdir(parents=True)
    git(["init", "-q"], cwd=dest)
    git(["remote", "add", "origin", clone_url(repo)], cwd=dest)
    sparse = paths is not None and all(paths)
    filt = []
    if sparse:
        git(["sparse-checkout", "set", "--cone"] + sorted(set(paths)), cwd=dest)
        filt = ["--filter=blob:none"]
    try:
        git(["fetch", "-q", "--depth", "1"] + filt + ["origin", sha], cwd=dest)
    except Fail:
        git(["fetch", "-q"] + filt + ["origin"], cwd=dest)
    git(["-c", "advice.detachedHead=false", "checkout", "-q", sha], cwd=dest)
    head = git(["rev-parse", "HEAD"], cwd=dest).strip()
    if head != sha:
        raise Fail("%s: checked out %s, wanted %s" % (repo, head, sha))
    shutil.rmtree(dest / ".git")


def staging_dir(tag):
    root = cache_root()
    root.mkdir(parents=True, exist_ok=True)
    return Path(tempfile.mkdtemp(dir=str(root), prefix=".tmp-%s-" % tag))


def checkout_paths(final):
    """The folders a shared checkout holds: a list ([""] = everything), or None if unknown / absent."""
    try:
        return json.loads((final / SPARSE_MARK).read_text())["paths"]
    except (OSError, ValueError, KeyError, TypeError):
        return None


def covers(have, need):
    return have is not None and ("" in have or all(p in have for p in need))


def ensure_cached(skill, skills=None):
    """Make sure the shared checkout of a github skill's repo@sha holds its folder (fetching it, with the folders of
    every other skill pinned to the same repo@sha in `skills`, if not). Returns True if fetched."""
    src = skill["source"]
    final = repo_checkout(src)
    group = [s for s in (skills or []) if s["source"]["type"] == "github" and repo_checkout(s["source"]) == final]
    need = sorted({skill_path(src)} | {skill_path(s["source"]) for s in group})
    have = checkout_paths(final) if final.is_dir() else None
    if covers(have, need):
        if not (desired_target(skill) / "SKILL.md").is_file():
            raise Fail("%s: no SKILL.md at %s in %s@%s" % (skill["name"], skill_path(src) or "/", src["repo"], src["commit"][:12]))
        return False
    want = sorted(set(need) | set(have or []))
    want = [""] if "" in want else want
    st = staging_dir(skill["name"])
    try:
        co = st / "co"
        fetch_to(src["repo"], src["commit"], co, None if want == [""] else want)
        for p in need:
            if not (co / p / "SKILL.md").is_file():
                raise Fail("%s: no SKILL.md at %s in %s@%s" % (skill["name"], p or "/", src["repo"], src["commit"][:12]))
        (co / SPARSE_MARK).write_text(json.dumps({"repo": src["repo"], "commit": src["commit"], "paths": want}) + "\n")
        final.parent.mkdir(parents=True, exist_ok=True)
        if final.exists():  # widen: swap the new checkout in, then drop the old one
            os.rename(final, st / "old")
        os.rename(co, final)
    finally:
        shutil.rmtree(st, ignore_errors=True)
    return True


def prune_cache(skills):
    """Remove shared checkouts no skill is pinned to, and the per-skill checkouts of the old layout (<name>/<sha>)."""
    keep = {repo_checkout(s["source"]) for s in skills if s["source"]["type"] == "github"}
    root = cache_root()
    removed = []
    if not root.is_dir():
        return removed
    repos = root / REPOS_DIR
    if repos.is_dir():
        for k in sorted(os.listdir(repos)):
            for sha in sorted(os.listdir(repos / k)) if (repos / k).is_dir() else []:
                if repos / k / sha not in keep:
                    shutil.rmtree(repos / k / sha, ignore_errors=True)
                    removed.append("%s@%s" % (k.replace("__", "/"), sha[:12]))
            if (repos / k).is_dir() and not os.listdir(repos / k):
                (repos / k).rmdir()
    for n in sorted(os.listdir(root)):   # old layout: every <name>/<sha> is a leftover now
        p = root / n
        if n.startswith(".tmp-"):
            shutil.rmtree(p, ignore_errors=True)
            continue
        if n.startswith(".") or not p.is_dir():
            continue
        for sha in sorted(os.listdir(p)):
            shutil.rmtree(p / sha, ignore_errors=True)
            removed.append("%s@%s" % (n, sha[:12]))
        if not os.listdir(p):
            p.rmdir()
    return removed


# ---- commands ---------------------------------------------------------------------------------------------

class Lock:
    def __enter__(self):
        root = cache_root()
        root.mkdir(parents=True, exist_ok=True)
        self.f = open(root / ".lock", "w")
        fcntl.flock(self.f, fcntl.LOCK_EX)
        return self

    def __exit__(self, *a):
        self.f.close()


def seat_mcp(install=False):
    """The seats' baseline MCP servers, by the TEAM_SKILLS_MCP_INSTALLER script when one is set.
    sync installs them in every seat config (so a new seat has them within one timer run) and alerts on a problem it
    could not fix; check only reports. None without an installer or with TEAM_SKILLS_MCP=0 (tests)."""
    script = Path(os.environ.get("TEAM_SKILLS_MCP_INSTALLER") or "/nonexistent")
    if os.environ.get("TEAM_SKILLS_MCP") == "0" or not script.is_file():
        return None
    args = [sys.executable, str(script), "--json"] + (["--alert"] if install else ["--check"])
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=600)  # the installer may mint seat tokens over ssh
        return json.loads(p.stdout)
    except (subprocess.SubprocessError, OSError, ValueError) as e:
        return {"ok": False, "green": False, "host_problems": ["MCP installer failed: %s" % e], "configs": []}


def do_check(mcp=False):
    m = load_manifest()
    dirs = [scan_dir(d, m["skills"]) for d in config_dirs()]
    src = source_problems(m["skills"])
    mcp = seat_mcp() if mcp is False else mcp
    green = all(d["green"] for d in dirs) and not src and (mcp is None or mcp.get("green"))
    return {"ok": True, "green": green, "host": os.uname().nodename, "skills": [s["name"] for s in m["skills"]],
            "dirs": dirs, "sources": src, "mcp": mcp}


def symlink_atomic(target, path):
    tmp = path.parent / (".%s.team-skills-tmp" % path.name)
    if os.path.lexists(tmp):
        os.unlink(tmp)
    os.symlink(str(target), str(tmp))
    os.replace(tmp, path)


def do_sync():
    with Lock():
        m = load_manifest()
        changes, fetched = [], []
        for s in m["skills"]:
            if s["source"]["type"] == "github" and ensure_cached(s, m["skills"]):
                fetched.append("%s@%s" % (s["name"], s["source"]["commit"][:12]))
        src = source_problems(m["skills"])
        bad = {p["name"] for p in src}
        by_name = {s["name"]: s for s in m["skills"]}
        for d in config_dirs():
            if not d.is_dir():
                d.mkdir(mode=0o700)
                changes.append("created %s" % tilde(d))
            r = scan_dir(d, m["skills"])
            for n in r["missing"] + r["stale"]:
                if n in bad:
                    continue
                symlink_atomic(desired_target(by_name[n]), d / n)
                changes.append("%s %s/%s" % ("linked" if n in r["missing"] else "relinked", tilde(d), n))
            for n in r["extra"]:
                os.unlink(d / n)
                changes.append("unlinked %s/%s" % (tilde(d), n))
        pruned = prune_cache(m["skills"])
        mcp = seat_mcp(install=True)
    for c in (mcp or {}).get("configs", []):
        for ch in c.get("changed") or []:
            changes.append("mcp %s: %s" % (c["config"], ch))
    res = do_check(mcp)
    res.update(changes=changes, fetched=fetched, pruned=pruned)
    return res


def parse_frontmatter(text):
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    out, key, buf = {}, None, []
    for line in lines[1:]:
        if line.strip() == "---":
            break
        mm = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", line)
        if mm and not line.startswith((" ", "\t")):
            if key:
                out[key] = " ".join(buf).strip()
            key, v = mm.group(1), mm.group(2).strip()
            buf = [] if v in ("", ">", "|", ">-", "|-") else [v]
        elif key:
            buf.append(line.strip())
    if key:
        out[key] = " ".join(buf).strip()
    for k, v in out.items():
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            out[k] = v[1:-1]
    return out


def one_line(desc, limit=200):
    desc = " ".join((desc or "").split())
    m = re.match(r"^(.+?[.!?])(\s|$)", desc)
    s = m.group(1) if m else desc
    return s if len(s) <= limit else s[:limit - 1].rstrip(" ,;") + "…"


def resolve_ref(repo, ref):
    out = git(["ls-remote", clone_url(repo), ref], timeout=60)
    for line in out.splitlines():
        sha, name = line.split("\t", 1)
        if name in (ref, "refs/heads/" + ref, "refs/tags/" + ref + "^{}"):
            return sha
    for line in out.splitlines():
        return line.split("\t", 1)[0]
    if SHA_RE.match(ref):
        return ref
    raise Fail("cannot resolve %s in %s" % (ref, repo))


def do_add(url, name=None, path=None, use_when=None, dry_run=False, sync=True, missing_ok=False):
    mm = GITHUB_URL_RE.match(url.strip())
    if not mm:
        raise Fail("not a GitHub repo URL: %s (want https://github.com/<owner>/<repo>[/tree/<ref>/<path>])" % url)
    owner, rname, ref, sub = mm.groups()
    repo = "%s/%s" % (owner, rname)
    path = (path if path is not None else (sub or "")).strip("/")
    with Lock():
        m = load_manifest(missing_ok)
        sha = resolve_ref(repo, ref or "HEAD")
        st = staging_dir("add")
        try:
            co = st / "co"
            fetch_to(repo, sha, co)
            if not path and not (co / "SKILL.md").is_file():
                found = sorted(str(p.parent.relative_to(co)) for p in co.rglob("SKILL.md"))
                if len(found) != 1:
                    raise Fail("%s: %s SKILL.md; pass --path (found: %s)" % (
                        repo, "no" if not found else "several", ", ".join(found) or "none"))
                path = found[0]
            sk = co / path / "SKILL.md"
            if not sk.is_file():
                raise Fail("%s@%s: no SKILL.md at %s" % (repo, sha[:12], path or "/"))
            fm = parse_frontmatter(sk.read_text(errors="replace"))
            nm = name or fm.get("name") or (Path(path).name if path else rname)
            nm = nm.strip().lower()
            if not NAME_RE.match(nm):
                raise Fail("skill name %r is not valid; pass --name" % nm)
            entry = {"name": nm, "use_when": use_when or one_line(fm.get("description")),
                     "source": {"type": "github", "repo": repo, "commit": sha}}
            if path:
                entry["source"]["path"] = path
            old = next((s for s in m["skills"] if s["name"] == nm), None)
            if old and not (old["source"]["type"] == "github" and old["source"]["repo"].lower() == repo.lower()):
                raise Fail("a different skill named %s is already in the library (%s)" % (
                    nm, old["source"].get("repo") or old["source"].get("path")))
            if old and not use_when:
                entry["use_when"] = old.get("use_when") or entry["use_when"]   # keep the curated line on a re-pin
            action = "unchanged" if old == entry else ("repinned" if old else "added")
            res = {"ok": True, "action": action, "dry_run": dry_run, "skill": entry,
                   "description": fm.get("description", ""), "skill_md_name": fm.get("name")}
            if dry_run:
                return res
            if old:
                m["skills"].remove(old)
            m["skills"].append(entry)
            save_manifest(m)
            ensure_cached(entry, m["skills"])   # into the shared sparse checkout of repo@sha
        finally:
            shutil.rmtree(st, ignore_errors=True)
    if sync:
        res["sync"] = do_sync()
    return res


def do_remove(name, sync=True):
    m = load_manifest()
    old = next((s for s in m["skills"] if s["name"] == name), None)
    if not old:
        raise Fail("no skill named %s in the library" % name)
    m["skills"].remove(old)
    save_manifest(m)
    res = {"ok": True, "action": "removed", "skill": old}
    if sync:
        res["sync"] = do_sync()
    return res


def do_list():
    m = load_manifest()
    return {"ok": True, "manifest": tilde(manifest_path()), "skills": m["skills"]}


SERVICE = """[Unit]
Description=Team skills: link skills/team-skills.json into every agent config dir
ConditionPathExists={script}

[Service]
Type=oneshot
Nice=10
ExecStart=/usr/bin/python3 {script} sync --quiet
"""
TIMER = """[Unit]
Description=Team skills sync every 10 min (new seats get the team skills with no manual step)

[Timer]
OnBootSec=2min
OnUnitActiveSec=10min

[Install]
WantedBy=timers.target
"""


def do_install_timer():
    unit_dir = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "systemd" / "user"
    unit_dir.mkdir(parents=True, exist_ok=True)
    script = repo_root() / "skills" / "team-skills.py"
    changed = []
    for fn, body in (("%s.service" % TIMER_NAME, SERVICE.format(script=script)), ("%s.timer" % TIMER_NAME, TIMER)):
        p = unit_dir / fn
        if not p.is_file() or p.read_text() != body:
            p.write_text(body)
            changed.append(fn)
    env = dict(os.environ)
    env.setdefault("XDG_RUNTIME_DIR", "/run/user/%d" % os.getuid())
    sc = ["systemctl", "--user"]
    if changed:
        subprocess.run(sc + ["daemon-reload"], env=env, check=True)
    subprocess.run(sc + ["enable", "--now", "%s.timer" % TIMER_NAME], env=env, check=True, capture_output=True)
    act = subprocess.run(sc + ["is-active", "%s.timer" % TIMER_NAME], env=env, capture_output=True, text=True).stdout.strip()
    return {"ok": act == "active", "changed": changed, "timer": act, "unit_dir": tilde(unit_dir), "script": str(script)}


# ---- world skills -------------------------------------------------------------------------------

WORLD_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
WORLD_DIRS = (".claude/skills", ".agents/skills")
EXCLUDE_BEGIN = "# team-skills world links, managed by skills/team-skills.py world-link"
EXCLUDE_END = "# end team-skills world links"


def world_cache(world):
    return cache_root() / ".worlds" / world


def git_exclude_file(dest):
    p = git(["rev-parse", "--git-path", "info/exclude"], cwd=dest).strip()
    return (Path(dest) / p) if not os.path.isabs(p) else Path(p)


def set_exclude(dest, names):
    """Our block in the checkout's .git/info/exclude lists exactly the links we keep (never committed)."""
    f = git_exclude_file(dest)
    try:
        lines = f.read_text().splitlines()
    except FileNotFoundError:
        lines = []
    out, skip = [], False
    for ln in lines:
        if ln == EXCLUDE_BEGIN:
            skip = True
            continue
        if skip and ln == EXCLUDE_END:
            skip = False
            continue
        if not skip:
            out.append(ln)
    if names:
        out += [EXCLUDE_BEGIN] + ["/%s/%s" % (d, n) for n in sorted(names) for d in WORLD_DIRS] + [EXCLUDE_END]
    text = "\n".join(out) + ("\n" if out else "")
    if not f.is_file() or f.read_text() != text:
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(text)


def do_world_link(world, dest, manifest_json):
    """Link the world's skills into its checkout `dest` only. Exit 1 (green false) when one could not be linked."""
    if not WORLD_RE.match(world or ""):
        raise Fail("bad world id: %r" % (world,))
    dest = Path(dest).expanduser().resolve()
    if not (dest / ".git").exists():
        raise Fail("not a git checkout: %s" % tilde(dest))
    try:
        m = validate_manifest(json.loads(manifest_json))
    except ValueError as e:
        raise Fail("world manifest is not valid JSON: %s" % e)
    local = [s["name"] for s in m["skills"] if s["source"]["type"] != "github"]
    if local:
        raise Fail("world skills come from GitHub, pinned: %s" % ", ".join(local))
    wroot = os.path.normpath(str(world_cache(world)))
    os.environ["TEAM_SKILLS_CACHE"] = wroot   # every fetch below goes to this world's own cache
    mine = lambda t: os.path.normpath(t) == wroot or os.path.normpath(t).startswith(wroot + "/")
    problems, linked, changes = [], [], []
    with Lock():
        for s in m["skills"]:
            try:
                ensure_cached(s, m["skills"])
            except Fail as e:
                problems.append({"name": s["name"], "problem": str(e)})
        bad = {p["name"] for p in problems}
        names = {s["name"] for s in m["skills"]}
        for rel in WORLD_DIRS:
            d = dest / rel
            d.mkdir(parents=True, exist_ok=True)
            for s in m["skills"]:
                if s["name"] in bad:
                    continue
                p, want = d / s["name"], str(desired_target(s))
                if os.path.lexists(p) and not (p.is_symlink() and mine(link_target(p))):
                    problems.append({"name": s["name"], "problem": "%s/%s exists and is not this world's link (left alone)" % (rel, s["name"])})
                    bad.add(s["name"])
                    continue
                if not (p.is_symlink() and link_target(p) == want):
                    symlink_atomic(want, p)
                    changes.append("linked %s/%s" % (rel, s["name"]))
            for e in sorted(os.listdir(d)):
                p = d / e
                if e not in names and p.is_symlink() and mine(link_target(p)):
                    os.unlink(p)
                    changes.append("unlinked %s/%s" % (rel, e))
        linked = sorted(names - bad)
        set_exclude(dest, linked)
        prune_cache(m["skills"])
    return {"ok": True, "green": not problems, "world": world, "dest": tilde(dest), "linked": linked,
            "problems": problems, "changes": changes}


# ---- output -----------------------------------------------------------------------------------------------

def print_check(r):
    print("team-skills %s on %s: %s (%s)" % ("green" if r["green"] else "DRIFT", r["host"],
                                             ", ".join(r["skills"]) or "no skills", tilde(manifest_path())))
    for d in r["dirs"]:
        if d["green"]:
            print("  ok     %s" % d["dir"])
        else:
            parts = ["%s %s" % (k, ", ".join(d[k])) for k in ("missing", "stale", "extra", "conflict") if d[k]]
            print("  drift  %s: %s" % (d["dir"], "; ".join(parts)))
    for s in r["sources"]:
        print("  source %s: %s (%s)" % (s["name"], s["problem"], s["path"]))
    mcp = r.get("mcp")
    if mcp:
        print("  seat MCP baseline: %s" % ("green" if mcp.get("green") else "DRIFT"))
        for c in mcp.get("configs", []):
            bad = [x for x in (c.get("problem"), c.get("missing") and "lacks " + ", ".join(c["missing"]),
                               c.get("broken_console") and "broken console entry") if x]
            if bad:
                print("  drift  %s: %s" % (c["config"], "; ".join(bad)))
        for p in mcp.get("host_problems", []):
            print("  drift  host: %s" % p)
        if mcp.get("alert"):
            print("  alert  %s" % mcp["alert"])


def main(argv=None):
    ap = argparse.ArgumentParser(prog="team-skills", description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    for c in ("sync", "check", "list", "install-timer"):
        p = sub.add_parser(c)
        p.add_argument("--json", action="store_true")
        if c == "sync":
            p.add_argument("--quiet", action="store_true", help="print only changes and problems")
    p = sub.add_parser("add")
    p.add_argument("url")
    p.add_argument("--name")
    p.add_argument("--path", help="dir holding SKILL.md inside the repo")
    p.add_argument("--use-when", dest="use_when")
    p.add_argument("--dry-run", action="store_true", help="resolve and read SKILL.md, write nothing")
    p.add_argument("--no-sync", action="store_true")
    p.add_argument("--json", action="store_true")
    p.add_argument("--manifest", help="dry-run against this manifest (a world's; missing = empty)")
    p = sub.add_parser("world-link")
    p.add_argument("--world", required=True)
    p.add_argument("--dest", required=True, help="the world's checkout the wake runs in")
    p.add_argument("--manifest-json", dest="manifest_json", required=True)
    p.add_argument("--json", action="store_true")
    p = sub.add_parser("remove")
    p.add_argument("name")
    p.add_argument("--no-sync", action="store_true")
    p.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    try:
        if a.cmd == "check":
            r = do_check()
        elif a.cmd == "sync":
            r = do_sync()
        elif a.cmd == "list":
            r = do_list()
        elif a.cmd == "add":
            if a.manifest:
                if not a.dry_run:
                    raise Fail("--manifest is for --dry-run only (the console writes a world's manifest itself)")
                os.environ["TEAM_SKILLS_MANIFEST"] = a.manifest
            r = do_add(a.url, a.name, a.path, a.use_when, a.dry_run, not a.no_sync and not a.manifest, bool(a.manifest))
        elif a.cmd == "world-link":
            r = do_world_link(a.world, a.dest, a.manifest_json)
        elif a.cmd == "remove":
            r = do_remove(a.name, not a.no_sync)
        else:
            r = do_install_timer()
    except (Fail, subprocess.SubprocessError, OSError) as e:
        if getattr(a, "json", False):
            print(json.dumps({"ok": False, "error": str(e)}))
        else:
            print("team-skills: %s" % e, file=sys.stderr)
        return 2
    green = r.get("green", r.get("sync", {}).get("green", True)) and r.get("ok", True)
    if a.json:
        print(json.dumps(r, indent=2))
    elif a.cmd in ("check", "sync"):
        if a.cmd == "sync":
            for c in r["fetched"]:
                print("fetched %s" % c)
            for c in r["changes"]:
                print(c)
            for c in r["pruned"]:
                print("pruned cache %s" % c)
        if not (a.cmd == "sync" and a.quiet and r["green"]):
            print_check(r)
    elif a.cmd == "list":
        for s in r["skills"]:
            src = s["source"]
            where = src["path"] if src["type"] == "local" else "%s@%s%s" % (
                src["repo"], src["commit"][:12], ("/" + src["path"]) if src.get("path") else "")
            print("%-20s %-60s %s" % (s["name"], where, s["use_when"]))
    elif a.cmd == "world-link":
        print("world %s -> %s: linked %s" % (r["world"], r["dest"], ", ".join(r["linked"]) or "none"))
        for c in r["changes"]:
            print("  " + c)
        for p in r["problems"]:
            print("  problem %s: %s" % (p["name"], p["problem"]))
    elif a.cmd in ("add", "remove"):
        s = r["skill"]
        print("%s %s (%s)" % (r["action"] + (" (dry run)" if r.get("dry_run") else ""), s["name"],
                              s["source"].get("repo") or s["source"].get("path")))
        if a.cmd == "add":
            print("  use when: %s" % s["use_when"])
        if "sync" in r:
            print_check(r["sync"])
    else:
        print("timer %s (%s); units %s%s" % (r["timer"], TIMER_NAME, r["unit_dir"],
                                             ", updated " + ", ".join(r["changed"]) if r["changed"] else ""))
    return 0 if green else 1


if __name__ == "__main__":
    sys.exit(main())
