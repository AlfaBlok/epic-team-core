#!/usr/bin/env python3
"""One host's repos for the Team desk's repo index (core/console/server/src/desk/repoIndex.ts).

Usage: repo_index.py '{"root": "~/github"}'   (or over ssh: python3 -I - '<json>' < repo_index.py)
Prints {"root": <abs root>, "repos": [{name, remote, last, subject, summary}]}: every checkout directly under root (a dir with a
.git directory; linked worktrees and bare repos are skipped), its newest work commit on any branch, tag or remote (ISO date + subject; merges and fleet housekeeping such as EpicSpine blocks skipped), and a one-line
summary (README's first prose line, else the root spine's Goal, else the README title). Stdlib only, read-only: one `git log`
per repo, run by the console's background refresh, never on a request.
"""
import json
import os
import re
import subprocess
import sys

MAX = 160


META = re.compile(r"^[A-Z][\w()-]*(?: [\w()-]+){0,2}:\s*\S")


def first_prose(text):
    """The first prose paragraph (lines joined), skipping headings, badges, html, quotes, tables, code and `Key: value` lines."""
    fence = False
    para = []
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("```"):
            fence = not fence
            if para:
                break
            continue
        skip = fence or not line or line.startswith(("#", "<", "!", "[!", ">", "|", "---", "===", "- ", "* ")) or bool(META.match(line))
        skip = skip or bool(re.match(r"^\[.*\]:\s", line)) or bool(re.match(r"^[-*_=]{3,}$", line))
        if skip:
            if para:
                break
            continue
        para.append(line)
    return " ".join(para)


def title_of(text):
    for raw in text.splitlines():
        m = re.match(r"^#\s+(.+)$", raw.strip())
        if m:
            return m.group(1).strip()
    return ""


def clean(s):
    s = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", s)
    s = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", s)
    s = re.sub(r"`|\*\*|(?<!\w)[*_]{1,2}|[*_]{1,2}(?!\w)", "", s)
    s = re.sub(r"\s+", " ", s).strip()
    if len(s) > MAX:
        cut = s[: MAX - 1]
        dot = cut.rfind(". ")
        s = cut[: dot + 1] if dot > 60 else cut.rstrip() + "…"
    return s


def read(path, limit=200_000):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read(limit)
    except OSError:
        return ""


def spine_goal(repo):
    agents = read(os.path.join(repo, "AGENTS.md"))
    m = re.search(r"Root spine:\s*\[?`?([^\s`\]]+\.md)", agents)
    paths = [m.group(1)] if m else []
    paths += ["docs/spines/root.md", "EPIC.md"]
    for rel in paths:
        text = read(os.path.join(repo, rel))
        g = re.search(r"^##\s+(?:Goal|Mission|Purpose)\s*$(.*?)(?=^##\s|\Z)", text, re.M | re.S)
        if g:
            line = first_prose(g.group(1))
            if line:
                return line
    return ""


def root_spine(repo):
    """The repo's root spine (AGENTS.md `Root spine:`, else docs/spines/root.md, else EPIC.md), relative; "" if none."""
    agents = read(os.path.join(repo, "AGENTS.md"))
    m = re.search(r"Root spine:\s*\[?`?([^\s`\]]+\.md)", agents)
    for rel in ([m.group(1)] if m else []) + ["docs/spines/root.md", "EPIC.md"]:
        if os.path.isfile(os.path.join(repo, rel)):
            return rel
    return ""


def summary(repo):
    readme = ""
    for f in ("README.md", "readme.md", "README", "README.txt"):
        readme = read(os.path.join(repo, f))
        if readme:
            break
    return clean(first_prose(readme) or spine_goal(repo) or title_of(readme))


def remote(repo):
    text = read(os.path.join(repo, ".git", "config"))
    sec = None
    for line in text.splitlines():
        m = re.match(r"^\s*\[(.+)\]\s*$", line)
        if m:
            sec = m.group(1).strip()
            continue
        kv = re.match(r"^\s*url\s*=\s*(.+?)\s*$", line)
        if kv and sec == 'remote "origin"':
            g = re.search(r"github\.com[:/]+([^/\s]+)/([^/\s]+?)(?:\.git)?/?$", kv.group(1))
            return f"{g.group(1)}/{g.group(2)}" if g else None
    return None


# Fleet housekeeping, not work on the repo: EpicSpine blocks and migrations, AGENTS/CLAUDE pointer lines, safety copies.
HOUSEKEEPING = re.compile(
    r"epic-?spine|\bAGENTS\b|root spine|harness pointers|repo block|find-before-you-ask|WIP: local uncommitted|safety copy|reconcile divergence",
    re.I,
)
HOUSEKEEPING_FILES = re.compile(r"^(AGENTS\.md|CLAUDE\.md|GEMINI\.md|\.gitignore|\.claude/.*|\.agents/.*|\.epicspine.*)$")


def last_commit(repo):
    """Newest commit on any ref that is work: merges, housekeeping subjects and commits touching only harness files skipped.
    Falls back to the newest commit of all when every recent one is housekeeping."""
    try:
        out = subprocess.run(
            ["git", "-C", repo, "log", "--branches", "--tags", "--remotes", "--no-merges", "--date-order", "-n", "300", "--name-only", "--format=%x00%cI%x09%s"],
            capture_output=True, text=True, timeout=20, check=True,
        ).stdout
    except (subprocess.SubprocessError, OSError):
        return None, None
    first = None
    for block in out.split("\0")[1:]:
        head, _, files = block.partition("\n")
        when, _, subj = head.partition("\t")
        first = first or (when, subj)
        paths = [f for f in files.splitlines() if f.strip()]
        if HOUSEKEEPING.search(subj) or (paths and all(HOUSEKEEPING_FILES.match(f) for f in paths)):
            continue
        return when, clean(subj)
    return (first[0], clean(first[1])) if first else (None, None)


def main():
    req = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    root = os.path.expanduser(req.get("root") or "~/github")
    repos = []
    try:
        names = sorted(os.listdir(root))
    except OSError as e:
        print(json.dumps({"root": root, "repos": [], "error": str(e)}))
        return
    for name in names:
        repo = os.path.join(root, name)
        if name.startswith(".") or not os.path.isdir(os.path.join(repo, ".git")):
            continue
        when, subj = last_commit(repo)
        repos.append({"name": name, "remote": remote(repo), "last": when, "subject": subj, "summary": summary(repo), "spine": root_spine(repo)})
    print(json.dumps({"root": root, "repos": repos}))


if __name__ == "__main__":
    main()
