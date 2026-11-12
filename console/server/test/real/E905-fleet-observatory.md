# E5: Fleet Observatory (milestone "M2")

Ticket ID: E5
Status: active
Owner: delivery manager (dispatches workers); Sam approves
Evidence: [docs/EPIC-900-VPS-FLEET.md](../docs/EPIC-900-VPS-FLEET.md), existing page `scripts/build_status_page.py` -> `reports/status/index.html` (served on the tailnet at http://10.104.206.10:8090/)

Naming: Sam asked for "M2"; recorded as E5 to keep the E1-E4 flow (one epic = one milestone).

## Goal

One page Sam opens on the tailnet to see, at a glance: what runs on MAIN (live / paused / stopped),
what each thing consumes (CPU, memory, storage), simple host CPU and disk history, and S3 size per
bucket/prefix, its growth, and which container produces each prefix.

## Acceptance

- [ ] AC-1 Tabs **Now**, **CPU**, **DATA** on the existing status page (other chapters stay reachable).
- [ ] AC-2 Now: every container + paused/stopped Deployer apps + paused crons, with state, CPU %, mem, restarts.
- [ ] AC-3 CPU: host load history (sar) and top containers by CPU over time (vps-snapshots docker-stats).
- [ ] AC-4 DATA: root/data disk history (`disk.csv`), storage per container/volume, S3 size per bucket/prefix
      with growth over time, each prefix mapped to a producer from `docs/data-catalog.md` or flagged "unknown".
- [ ] AC-5 Numbers match `df` / `docker stats` / S3 listing at generation time.
- [ ] AC-6 Auto-refresh (about every 10 min) behind a stable tailnet URL served by a supervised process.
- [ ] AC-7 Read-only everywhere: no host, Deployer, or S3 writes; no secrets in repo or page.

## Phases

| Phase | Scope | Status |
|---|---|---|
| E5.1 | Tabs from data already collected (snapshots, sar, disk.csv, Deployer API GET) | done 2026-10-14 (88406a2, manager-verified) |
| E5.2 | Read-only daily S3 size listing -> `reports/s3/sizes.csv` (agent user crontab), fed into DATA tab | done 2026-10-14: first listing (a9-1 215.7G, poly-maker-logs 283.4G, property-datalake 39.4G, vps-archives 74.1G); agent crontab 05:20 daily |
| E5.3 | Auto-refresh + supervised server (systemd --user) replacing ad-hoc `http.server`; host services (cgroup sampler) in CPU tab; stale-red header | done 2026-10-15 on branch wt/e5-3 (awaiting manager integration) |
| E5.4 | "Who took the CPU over time": stacked CPU-cores + 100%-share charts at the top of the CPU tab, 6h/24h/7d/all, history back to 2026-10-14 20:57 (vps-forensics backfill), event markers | done 2026-10-15 on branch wt/e5-4 (awaiting manager integration) |

## Notes

- Scope: MAIN only. HOST2 needs an ssh alias/key from Sam first.
- S3 growth history starts at the first E5.2 run; it cannot be backfilled (L1/L3).
- Agent seat has no Docker socket: per-container data comes from root-written `/var/log/vps-snapshots`.
- E5.3 runtime (outside git, so 10-min regens do not dirty the repo): cgroup samples `~/.local/share/ops/cgroups/YYYY-MM-DD.csv`
  (~0.5 MB/day, sampler deletes files older than 14 days); live page `~/.local/share/ops/www/index.html`.
  Units in `hosts/main/user-units/` (install: `hosts/main/user-units/install.sh`, run from the checkout the units should
  execute; it pins `INFRA_VPS_ROOT` via a drop-in). `reports/status/index.html` in git is now only a manual snapshot.
- Container names for docker scopes come from root-written `/var/log/vps-forensics/.names` (full container ID -> name, L5).
- E5.4 (`scripts/cpu_timeline.py`): per consumer from the cgroup sampler; buckets it lacks are backfilled from root's per-minute
  `/var/log/vps-forensics/*.log[.gz]` (world-readable, 14-day retention, so "all" tops out at ~14 days). Completed forensics days are
  cached as JSON in `~/.local/share/ops/timeline-cache/` (~40 KB/day; a cache file is deleted once its log is gone). Host used CPU = sar -u (100 - idle - iowait);
  "other" = host used minus the 8 named consumers (includes kernel threads). Per-consumer history before 2026-10-14 20:57 does not exist.

## Execution log

- 2026-10-14 ~22:25 CEST: E5.1+E5.2 merged to main (88406a2, worker Seat 1 Sonnet 5.5). Manager checks: only S3 list + Deployer GET project.all calls; 0 secret hits across 82 tracked files; page regenerated on main and served at http://10.104.206.10:8090/ (Now 33/33 running, 29 Deployer apps). Gaps: no per-volume storage in snapshots (needs root-written `docker system df -v`); S3 history 1 point; producers "unknown" for a9-1 and some poly-maker-logs prefixes; page is static until E5.3.
- 2026-10-15 ~21:55 CEST: E5.3 on branch wt/e5-3 (worker). New `scripts/cgroup_sample.py` (read-only /sys/fs/cgroup, as agent: usage, throttling, cpu.pressure, memory.current for system.slice/*.service, docker-*.scope, user.slice/user-*.slice). CPU tab: new "Who uses the CPU now" stacked chart + "Top consumers (all cgroups)" 1 h/24 h/7 d with CPU cap, throttled %, PSI %, verdict (self-throttled / CPU-starved / hits its cap / ok), and a PSI note linking incident Q4; old docker-stats view kept below as "Containers only, longer history". Header shows "Generated ... (N min ago)", red STALE after 30 min, page auto-reloads every 10 min. User units: `infra-ops-cgsample.timer` (*:0/5), `infra-ops-observatory-build.timer` (*:2/10), `infra-ops-observatory-http.service` (Restart=always, bind 10.104.206.10:8090). Linger=yes, so no crontab fallback. Ad-hoc server pid 2004239 stopped and replaced by the unit (same URL). First result: tripwire 46% of a core at its 50% cap, 90% of periods throttled, PSI 83% -> self-throttled; user-1000.slice (agents) 148% at its 150% cap, also self-throttled at that moment.
- 2026-10-15 ~22:15 CEST: E5.4 on branch wt/e5-4 (worker). New `scripts/cpu_timeline.py`, hooked at the top of the CPU tab (`#cputime`): (a) stacked area of CPU cores used per consumer (fixed 8 consumers: top of last 6 h, then 24 h, then all; + other + light idle band to 4 cores; red 4-core line), (b) 100%-stacked share of used CPU, same colours, shared legend, range buttons 6h/24h/7d/all, hover tooltip with every consumer's cores and %, sar total, idle. Inline SVG/JS, no CDN; data block ~28 KB, page ~340 KB. 5-min buckets for 6h/24h, 30-min for 7d/all. Events: VH-T17 root apply (2026-10-14 21:00), tripwire pause auto-detected (sustained drop below 0.02 cores after >= 0.1; not yet fired, tripwire still at 0.47 cores). Sampler buckets are interval-weighted (manual extra samples no longer double-count). Build adds ~1 s (today's forensics log parsed each run, older days cached).
