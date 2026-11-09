#!/usr/bin/env python3
"""Tests for skills/team-skills.py : temp HOME with fake seat dirs, a fake repo and a local
'GitHub' (TEAM_SKILLS_GITHUB_BASE=file://...). Run: python3 skills/test_team_skills.py"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

CLI = Path(__file__).resolve().parent / "team-skills.py"
GIT_ENV = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
           "GIT_COMMITTER_EMAIL": "t@t", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1"}


def skill_md(name, desc):
    return "---\nname: %s\ndescription: %s\n---\n\n# %s\n" % (name, desc, name)


class TeamSkillsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="team-skills-test-"))
        self.home = self.tmp / "home"
        self.repo = self.tmp / "team"
        self.gh = self.tmp / "gh"
        for d in (".claude", ".claude_seat1", ".claude_seat3", ".agents", ".codex"):
            (self.home / d).mkdir(parents=True)
        (self.home / ".claude_seat2.lock").write_text("")          # a file, not a seat
        (self.home / ".claude" / "skills").mkdir()
        self.foreign = self.tmp / "epicspine" / "epic-spine"
        self.foreign.mkdir(parents=True)
        os.symlink(self.foreign, self.home / ".claude" / "skills" / "epic-spine")
        (self.repo / "skills" / "local1").mkdir(parents=True)
        (self.repo / "skills" / "local1" / "SKILL.md").write_text(skill_md("local1", "Local one."))
        self.third_sha = self.make_gh_repo("acme/third", {"skills/third/SKILL.md": skill_md(
            "third", "Make third things. Use it for tests; more text here.")})
        self.write_manifest([self.local_entry(), self.gh_entry(self.third_sha)])
        self.env = dict(os.environ, HOME=str(self.home), TEAM_SKILLS_REPO=str(self.repo),
                        TEAM_SKILLS_GITHUB_BASE="file://%s" % self.gh, **GIT_ENV)
        self.env.pop("TEAM_SKILLS_CACHE", None)
        self.env.pop("XDG_DATA_HOME", None)
        self.cache = self.home / ".local" / "share" / "team-skills"

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    # helpers
    def git(self, *a, cwd):
        return subprocess.run(["git"] + list(a), cwd=cwd, check=True, capture_output=True, text=True,
                              env=dict(os.environ, **GIT_ENV)).stdout.strip()

    def make_gh_repo(self, name, files):
        work = self.tmp / "work" / name
        if not work.is_dir():
            work.mkdir(parents=True)
            self.git("init", "-q", "-b", "main", cwd=work)
        for rel, body in files.items():
            (work / rel).parent.mkdir(parents=True, exist_ok=True)
            (work / rel).write_text(body)
        self.git("add", "-A", cwd=work)
        self.git("commit", "-q", "-m", "c", cwd=work)
        bare = self.gh / (name + ".git")
        if bare.is_dir():
            self.git("push", "-q", str(bare), "main", cwd=work)
        else:
            bare.parent.mkdir(parents=True, exist_ok=True)
            self.git("clone", "-q", "--bare", str(work), str(bare), cwd=self.tmp)
        return self.git("rev-parse", "HEAD", cwd=work)

    def co(self, sha, repo="acme__third"):
        """The shared sparse checkout of repo@sha."""
        return self.cache / ".repos" / repo / sha

    def local_entry(self):
        return {"name": "local1", "use_when": "local", "source": {"type": "local", "path": "skills/local1"}}

    def gh_entry(self, sha):
        return {"name": "third", "use_when": "third", "source": {"type": "github", "repo": "acme/third",
                                                                   "commit": sha, "path": "skills/third"}}

    def write_manifest(self, skills):
        (self.repo / "skills" / "team-skills.json").write_text(json.dumps({"version": 1, "skills": skills}))

    def manifest(self):
        return json.loads((self.repo / "skills" / "team-skills.json").read_text())

    def run_cli(self, *args):
        r = subprocess.run([sys.executable, str(CLI)] + list(args), env=self.env, capture_output=True, text=True)
        return r.returncode, r.stdout, r.stderr

    def jcli(self, *args):
        rc, out, err = self.run_cli(*(list(args) + ["--json"]))
        return rc, json.loads(out)

    def seat_dirs(self):
        return ["~/.agents/skills", "~/.claude/skills", "~/.claude_seat1/skills", "~/.claude_seat3/skills",
                "~/.codex/skills"]

    # tests
    def test_check_before_sync_lists_every_config_dir_as_missing(self):
        rc, r = self.jcli("check")
        self.assertEqual(rc, 1)
        self.assertFalse(r["green"])
        self.assertEqual(sorted(d["dir"] for d in r["dirs"]), self.seat_dirs())
        for d in r["dirs"]:
            self.assertEqual(sorted(d["missing"]), ["local1", "third"])
        self.assertEqual([s["problem"] for s in r["sources"]], ["uncached"])

    def test_sync_links_everywhere_and_is_idempotent(self):
        rc, r = self.jcli("sync")
        self.assertEqual(rc, 0, r)
        self.assertTrue(r["green"])
        self.assertEqual(r["fetched"], ["third@" + self.third_sha[:12]])
        for d in self.seat_dirs():
            p = self.home / d[2:]
            self.assertEqual(os.readlink(p / "local1"), str(self.repo / "skills" / "local1"))
            self.assertEqual(os.readlink(p / "third"), str(self.co(self.third_sha) / "skills" / "third"))
            self.assertTrue((p / "third" / "SKILL.md").is_file())
        # foreign link and the .lock file untouched; no .git in the cache
        self.assertEqual(os.readlink(self.home / ".claude" / "skills" / "epic-spine"), str(self.foreign))
        self.assertTrue((self.home / ".claude_seat2.lock").is_file())
        self.assertFalse((self.co(self.third_sha) / ".git").exists())
        rc, r = self.jcli("sync")
        self.assertEqual((rc, r["changes"], r["fetched"], r["pruned"]), (0, [], [], []))
        rc, out, _ = self.run_cli("check")
        self.assertEqual(rc, 0)
        self.assertIn("green", out)

    def test_skills_of_one_repo_share_one_sparse_checkout(self):
        # one checkout per repo@sha with only the pinned skills' folders + top-level files
        sha = self.make_gh_repo("acme/multi", {
            "README.md": "top\n", "skills/a/SKILL.md": skill_md("a", "A."), "skills/b/SKILL.md": skill_md("b", "B."),
            "skills/c/SKILL.md": skill_md("c", "C."), "skills/a/ref/x.md": "x\n", "big/blob.bin": "z" * 100000})
        ent = lambda n: {"name": n, "use_when": n, "source": {"type": "github", "repo": "acme/multi", "commit": sha,
                                                               "path": "skills/" + n}}
        self.write_manifest([self.local_entry(), self.gh_entry(self.third_sha), ent("a"), ent("b")])
        rc, r = self.jcli("sync")
        self.assertEqual(rc, 0, r)
        co = self.co(sha, "acme__multi")
        self.assertEqual(sorted(os.listdir(self.cache / ".repos")), ["acme__multi", "acme__third"])
        self.assertTrue((co / "README.md").is_file())                     # top-level files kept
        self.assertTrue((co / "skills" / "a" / "ref" / "x.md").is_file())
        self.assertFalse((co / "skills" / "c").exists())                  # an unpinned skill is not checked out
        self.assertFalse((co / "big").exists())
        self.assertFalse((co / ".git").exists())
        for n in ("a", "b"):
            self.assertEqual(os.readlink(self.home / ".codex" / "skills" / n), str(co / "skills" / n))
        self.assertEqual(sorted(json.loads((co / ".team-skills-sparse.json").read_text())["paths"]), ["skills/a", "skills/b"])
        # a third skill of the same repo@sha widens the one checkout; the others' links keep working
        self.write_manifest([self.local_entry(), self.gh_entry(self.third_sha), ent("a"), ent("b"), ent("c")])
        rc, r = self.jcli("sync")
        self.assertEqual(rc, 0, r)
        self.assertTrue(r["green"])
        self.assertTrue((co / "skills" / "c" / "SKILL.md").is_file())
        self.assertTrue((self.home / ".claude" / "skills" / "a" / "SKILL.md").is_file())
        self.assertEqual(sorted(os.listdir(self.cache / ".repos" / "acme__multi")), [sha])
        rc, r = self.jcli("sync")
        self.assertEqual((rc, r["changes"], r["fetched"], r["pruned"]), (0, [], [], []))

    def test_old_per_skill_cache_is_relinked_and_pruned(self):
        # the layout before <cache>/<name>/<sha>, linked from every config dir
        old = self.cache / "third" / self.third_sha / "skills" / "third"
        old.mkdir(parents=True)
        (old / "SKILL.md").write_text(skill_md("third", "old copy"))
        for d in self.seat_dirs():
            (self.home / d[2:]).mkdir(parents=True, exist_ok=True)
            os.symlink(old, self.home / d[2:] / "third")
        rc, r = self.jcli("check")
        self.assertTrue(all(d["stale"] == ["third"] for d in r["dirs"]))
        rc, r = self.jcli("sync")
        self.assertEqual(rc, 0, r)
        self.assertTrue(r["green"])
        self.assertIn("third@" + self.third_sha[:12], r["pruned"])
        self.assertFalse((self.cache / "third").exists())
        self.assertEqual(os.readlink(self.home / ".codex" / "skills" / "third"), str(self.co(self.third_sha) / "skills" / "third"))

    def test_new_seat_is_covered_without_edits(self):
        self.run_cli("sync")
        (self.home / ".claude_seat9").mkdir()
        rc, r = self.jcli("check")
        self.assertEqual(rc, 1)
        seat9 = [d for d in r["dirs"] if d["dir"] == "~/.claude_seat9/skills"][0]
        self.assertEqual(sorted(seat9["missing"]), ["local1", "third"])
        rc, r = self.jcli("sync")
        self.assertEqual(rc, 0)
        self.assertIn("created ~/.claude_seat9/skills", r["changes"])
        self.assertTrue((self.home / ".claude_seat9" / "skills" / "third" / "SKILL.md").is_file())

    def test_repin_relinks_stale_and_prunes_old_cache(self):
        self.run_cli("sync")
        new_sha = self.make_gh_repo("acme/third", {"skills/third/SKILL.md": skill_md("third", "v2.")})
        self.write_manifest([self.local_entry(), self.gh_entry(new_sha)])
        rc, r = self.jcli("check")
        self.assertEqual(rc, 1)
        self.assertTrue(all(d["stale"] == ["third"] for d in r["dirs"]))
        rc, r = self.jcli("sync")
        self.assertEqual(rc, 0, r)
        self.assertEqual(r["pruned"], ["acme/third@" + self.third_sha[:12]])
        self.assertFalse(self.co(self.third_sha).exists())
        self.assertIn("v2.", (self.home / ".codex" / "skills" / "third" / "SKILL.md").read_text())

    def test_removed_skill_is_unlinked_foreign_kept(self):
        self.run_cli("sync")
        rc, r = self.jcli("remove", "third")
        self.assertEqual(rc, 0, r)
        self.assertEqual([s["name"] for s in self.manifest()["skills"]], ["local1"])
        for d in self.seat_dirs():
            self.assertFalse(os.path.lexists(self.home / d[2:] / "third"))
        self.assertTrue(os.path.islink(self.home / ".claude" / "skills" / "epic-spine"))
        self.assertFalse((self.cache / "third").exists())
        rc, r = self.jcli("remove", "nope")
        self.assertEqual((rc, r["ok"]), (2, False))

    def test_conflict_is_reported_and_left_alone(self):
        (self.home / ".claude_seat1" / "skills" / "local1").mkdir(parents=True)
        (self.home / ".agents" / "skills").mkdir()
        os.symlink(self.foreign, self.home / ".agents" / "skills" / "third")
        rc, r = self.jcli("sync")
        self.assertEqual(rc, 1)
        by = {d["dir"]: d for d in r["dirs"]}
        self.assertEqual(by["~/.claude_seat1/skills"]["conflict"], ["local1"])
        self.assertEqual(by["~/.agents/skills"]["conflict"], ["third"])
        self.assertTrue((self.home / ".claude_seat1" / "skills" / "local1").is_dir())
        self.assertEqual(os.readlink(self.home / ".agents" / "skills" / "third"), str(self.foreign))
        rc, out, _ = self.run_cli("check")
        self.assertIn("conflict local1", out)

    def test_add_dry_run_then_add(self):
        sha = self.make_gh_repo("acme/newskill", {"SKILL.md": skill_md("new-skill", "Do new things. Extra.")})
        before = self.manifest()
        rc, r = self.jcli("add", "https://github.com/acme/newskill", "--dry-run")
        self.assertEqual(rc, 0, r)
        self.assertEqual(r["skill"], {"name": "new-skill", "use_when": "Do new things.",
                                      "source": {"type": "github", "repo": "acme/newskill", "commit": sha}})
        self.assertEqual(r["description"], "Do new things. Extra.")
        self.assertEqual(self.manifest(), before)
        rc, r = self.jcli("add", "https://github.com/acme/newskill.git")
        self.assertEqual(rc, 0, r)
        self.assertEqual(r["action"], "added")
        self.assertTrue(r["sync"]["green"])
        self.assertEqual([s["name"] for s in self.manifest()["skills"]], ["local1", "new-skill", "third"])
        self.assertTrue((self.home / ".claude_seat3" / "skills" / "new-skill" / "SKILL.md").is_file())
        rc, r = self.jcli("add", "https://github.com/acme/newskill")
        self.assertEqual(r["action"], "unchanged")
        # a new upstream commit re-pins and keeps the curated use_when
        m = self.manifest()
        next(s for s in m["skills"] if s["name"] == "new-skill")["use_when"] = "curated"
        (self.repo / "skills" / "team-skills.json").write_text(json.dumps(m))
        sha2 = self.make_gh_repo("acme/newskill", {"SKILL.md": skill_md("new-skill", "Do newer things.")})
        rc, r = self.jcli("add", "https://github.com/acme/newskill")
        self.assertEqual((rc, r["action"], r["skill"]["use_when"], r["skill"]["source"]["commit"]),
                         (0, "repinned", "curated", sha2))
        self.assertFalse((self.cache / "new-skill" / sha).exists())

    def test_add_finds_single_nested_skill_and_tree_urls(self):
        sha = self.make_gh_repo("acme/multi", {"skills/a/SKILL.md": skill_md("a", "A."),
                                              "skills/b/SKILL.md": skill_md("b", "B."), "README.md": "x"})
        rc, r = self.jcli("add", "https://github.com/acme/multi", "--dry-run")
        self.assertEqual((rc, r["ok"]), (2, False))
        self.assertIn("several", r["error"])
        rc, r = self.jcli("add", "https://github.com/acme/multi/tree/main/skills/b", "--no-sync",
                          "--use-when", "b things")
        self.assertEqual(rc, 0, r)
        self.assertEqual(r["skill"]["source"], {"type": "github", "repo": "acme/multi", "commit": sha,
                                                "path": "skills/b"})
        self.assertEqual(r["skill"]["use_when"], "b things")
        rc, r = self.jcli("add", "https://github.com/acme/third", "--name", "local1", "--dry-run")
        self.assertEqual(rc, 2)
        self.assertIn("different skill named local1", r["error"])
        rc, r = self.jcli("add", "https://example.com/x/y")
        self.assertEqual(rc, 2)

    # a world's own skills reach that world's checkout only
    def world_checkout(self, name):
        d = self.tmp / "repos" / name
        d.mkdir(parents=True)
        self.git("init", "-q", "-b", "main", cwd=d)
        return d

    def test_world_link_reaches_only_that_worlds_checkout(self):
        sha = self.make_gh_repo("acme/worldy", {"skills/worldy/SKILL.md": skill_md("worldy", "World only.")})
        wm = json.dumps({"version": 1, "skills": [{"name": "worldy", "use_when": "w", "source": {
            "type": "github", "repo": "acme/worldy", "commit": sha, "path": "skills/worldy"}}]})
        mine, other = self.world_checkout("es-a"), self.world_checkout("es-b")
        self.assertEqual(self.jcli("sync")[0], 0)
        rc, r = self.jcli("world-link", "--world", "es-a", "--dest", str(mine), "--manifest-json", wm)
        self.assertEqual(rc, 0, r)
        self.assertEqual(r["linked"], ["worldy"])
        for rel in (".claude/skills", ".agents/skills"):
            p = mine / rel / "worldy"
            self.assertTrue((p / "SKILL.md").is_file())
            self.assertIn("/.worlds/es-a/", os.readlink(p))
            self.assertFalse(os.path.lexists(other / rel / "worldy"))
        # never in a shared seat dir, and the team check stays green (sync/check ignore .worlds)
        for d in self.seat_dirs():
            self.assertFalse(os.path.lexists(Path(d.replace("~", str(self.home))) / "worldy"))
        rc, chk = self.jcli("sync")
        self.assertEqual(rc, 0, chk)
        self.assertTrue((mine / ".claude/skills/worldy/SKILL.md").is_file())   # sync's prune left the world cache alone
        # git never sees the links
        self.assertEqual(self.git("status", "--porcelain", cwd=mine), "")
        self.assertIn("/.claude/skills/worldy", (mine / ".git/info/exclude").read_text())
        # removed from the manifest: unlinked, excluded no more, foreign entries left alone
        (mine / ".claude/skills/own").mkdir()
        rc, r = self.jcli("world-link", "--world", "es-a", "--dest", str(mine), "--manifest-json", json.dumps({"version": 1, "skills": []}))
        self.assertEqual(rc, 0, r)
        self.assertFalse(os.path.lexists(mine / ".claude/skills/worldy"))
        self.assertTrue((mine / ".claude/skills/own").is_dir())
        self.assertNotIn("worldy", (mine / ".git/info/exclude").read_text())

    def test_world_link_conflict_bad_input(self):
        sha = self.make_gh_repo("acme/worldy", {"skills/worldy/SKILL.md": skill_md("worldy", "World only.")})
        wm = json.dumps({"version": 1, "skills": [{"name": "worldy", "use_when": "w", "source": {
            "type": "github", "repo": "acme/worldy", "commit": sha, "path": "skills/worldy"}}]})
        mine = self.world_checkout("es-a")
        (mine / ".claude/skills/worldy").mkdir(parents=True)          # the repo's own folder of that name
        rc, r = self.jcli("world-link", "--world", "es-a", "--dest", str(mine), "--manifest-json", wm)
        self.assertEqual(rc, 1)
        self.assertEqual(r["problems"][0]["name"], "worldy")
        self.assertNotIn("worldy", r["linked"])
        for bad in ({"path": "../../../.ssh"}, {"path": "/etc"}, {"repo": "acme/x/../../y"}):
            e = {"name": "worldy", "use_when": "w", "source": dict({"type": "github", "repo": "acme/worldy", "commit": sha, "path": "skills/worldy"}, **bad)}
            rc, r = self.jcli("world-link", "--world", "es-a", "--dest", str(mine), "--manifest-json", json.dumps({"version": 1, "skills": [e]}))
            self.assertEqual(rc, 2, (bad, r))
        local = json.dumps({"version": 1, "skills": [self.local_entry()]})
        self.assertEqual(self.jcli("world-link", "--world", "es-a", "--dest", str(mine), "--manifest-json", local)[0], 2)
        self.assertEqual(self.jcli("world-link", "--world", "../x", "--dest", str(mine), "--manifest-json", wm)[0], 2)
        self.assertEqual(self.jcli("world-link", "--world", "es-a", "--dest", str(self.tmp), "--manifest-json", wm)[0], 2)

    def test_add_dry_run_against_a_world_manifest(self):
        sha = self.make_gh_repo("acme/worldy", {"skills/worldy/SKILL.md": skill_md("worldy", "World only.")})
        wmf = self.tmp / "nowhere" / "world-skills.json"
        rc, r = self.jcli("add", "https://github.com/acme/worldy", "--dry-run", "--no-sync", "--manifest", str(wmf))
        self.assertEqual(rc, 0, r)
        self.assertEqual((r["action"], r["skill"]["source"]["commit"]), ("added", sha))
        self.assertEqual(self.manifest()["skills"][1]["name"], "third")        # the team manifest is untouched
        self.assertEqual(len(self.manifest()["skills"]), 2)
        self.assertFalse(wmf.exists())
        self.assertEqual(self.jcli("add", "https://github.com/acme/worldy", "--manifest", str(wmf))[0], 2)

    def test_list_and_bad_manifest(self):
        rc, r = self.jcli("list")
        self.assertEqual([s["name"] for s in r["skills"]], ["local1", "third"])
        self.write_manifest([self.local_entry(), dict(self.gh_entry("abc"))])
        rc, r = self.jcli("check")
        self.assertEqual((rc, r["ok"]), (2, False))

    def test_real_manifest_is_valid(self):
        m = json.loads((CLI.parent / "team-skills.json").read_text())
        env = dict(self.env, TEAM_SKILLS_REPO=str(CLI.parent.parent))
        r = subprocess.run([sys.executable, str(CLI), "list", "--json"], env=env, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual([s["name"] for s in json.loads(r.stdout)["skills"]], [s["name"] for s in m["skills"]])
        self.assertIn("diagram-design", [s["name"] for s in m["skills"]])


if __name__ == "__main__":
    unittest.main(verbosity=2)
