# EPIC-902: MAIN under control (the one sprint)

Spine profile: compact
Spine Type: child
Root spine: [EPIC-900-VPS-FLEET](EPIC-900-VPS-FLEET.md)
Parent spine: [EPIC-900-VPS-FLEET](EPIC-900-VPS-FLEET.md)
Ticket backend: local
Ticket root: ../tickets
Spine dialect: v1
Repository: Acme/ops
Primary document: docs/EPIC-902-MAIN-CONTROL.md
Spine ID: EPIC-902
Integration branch: main
Integration policy: main-direct
Dispatch profile: native subagent (harness's own Agent tool), model Sonnet 5.5 (claude-sonnet-5-5), own worktree

This is THE coordination document for MAIN until its exit test passes. Every open item
from EPIC-900-VPS-FLEET, EPIC-900-VPS-HEALTH, EPIC-901-PG1-DATA and E6 is either in the
Queue below or explicitly Parked. Nothing else is worked on. The other spines keep their
history and detail; this one decides order. Opened 2026-10-16 at Sam's request:
"consolidate what is left and go one by one until it is all done."

## Current State

Owner: Sam (approvals, root steps); delivery manager (orchestrator, never implements)
Status: active
Latest (2026-10-16 03:10 CEST): sprint opened. S1 (tripwire paused) done by Sam and verified. Next: S2 (Chainlink cutover, due ~10-17 03:00).
Baseline 2026-10-16 03:00 (measured, cgroup sampler, 10-15 21:44 -> 10-16 03:05):
- CPU ~2.6 of 4 cores avg. Tripwire 0.47 (now off), agent sessions 0.41 avg (bursts to the 1.5-core slice cap), Polymarket stack ~0.85 (xtreme_logger ~0.17 after ML-T2, book collector 0.31, pg1 0.20, chainlink 0.05, binance L2 0.05, twap-shadow 0.05), everything else <0.1 each. Expected after S1: ~2.1.
- Disk: root 53% (34G free), data 64% (53G free). Root growth since 10-14 explained: +4G = /swapfile2 (VH-T17, planned), +3.5G on 10-16 01:30-03:00 = agent worktrees/builds during the E6 deploy night (agent home 7.6G, /tmp 1.2G). Data volume flat ~63-67% for 2 days.
- Memory: 3.4G available, swap 3.6/8G (all on /swapfile, xtreme_logger-era pages).
Waiting on: Sam: S2 root stop, S3 root archiver update, S4 go, S5 list approval, S9 decision.
Next action: S2 at ~10-17 03:00 CEST: worker diffs old vs new twap files (read-only), then Sam stops `chainlink-twap-mainnet`.
Verified at: 2026-10-16 03:10 CEST

## Definition Of Done

All five hold together for 7 consecutive days, read from the observatory (http://10.0.0.10:8090/), no hand checks:

- [ ] DOD-1 **CPU**: production (everything except the agent slice) <= 1.5 cores avg/day; agent slice never above its 1.5-core cap; load1 > 8 for under 30 min/day.
- [ ] DOD-2 **Disk**: root <= 60% and data <= 75%, and every growing dataset has an owner + a cap verified to delete (L1).
- [ ] DOD-3 **Memory**: every container has a memory limit; swap used not trending up.
- [ ] DOD-4 **Data safe**: pg1 has a nightly off-box dump and one tested restore.
- [ ] DOD-5 **Nothing silent**: no crash-looping container, no failed systemd unit, no feed stale > 15 min (market data freshness on the observatory).

Earliest possible pass: S1-S8 done by ~10-23 (S7 needs the 7-day overlap), then 7 days -> ~10-30.

## Sprint Rules

- One queue, done in order. A new item enters only if it blocks the exit test; otherwise it goes to Parked.
- One production change at a time; verify it on the observatory before the next.
- At most 2 workers at once (seat pool capacity 2); no native builds (`npm ci` with gcc) on MAIN.
- Every item ends with evidence (number before/after) recorded here, then is struck.

## Queue

| # | Item | Who | Why (exit test) | Source | Status |
|---|---|---|---|---|---|
| S1 | Pause tripwire | Sam (root) | 1 CPU: -0.47 cores | VH-HEALTH, tripwire-profile | **done 10-16 03:00**, verified inactive/disabled |
| S2 | Chainlink cutover: diff old vs new twap files; stop `chainlink-twap-mainnet`; re-point new app mount to `data/`, redeploy | worker (diff) -> Sam (root stop) -> manager (deployer) | 5 one collector per feed | E6 cutover 2 | due ~10-17 03:00 |
| S3 | Root archiver update in `/root/github/poly-maker` (`archive_orderbook_files.py` from `m7/collectors`) + install `deploy/chainlink-archive/` | Sam (root), manager prepares the exact commands | 2 disk cap; else 1h books deleted unarchived | E6 cutover 1, VH-T12 c | **deadline 10-19** |
| S4 | pg1 nightly off-box dump + restore test (VH-T16 A-C) | Sam go -> worker -> Sam root install | 4 | VH-T16, VH-T7 | waiting on Sam's go (since 10-13) |
| S5 | Memory limit on every container (27 unlimited): manager proposes one table of limits from observed peaks; Sam approves the table once; applied via deployer API one by one | manager + Sam | 3 | VH-T18 rest | ready |
| S6 | Retire dead: twap-shadow, predictionbot x2, aggd_public (already stopped -> delete app), Streamlit in podcek, maker_dashboard split; laneD1 stop or every 15 min | manager list -> Sam per-item | 1, 5 | ML-T8, VH-T18, VH-T19 | ready (list to draft) |
| S7 | After 7-day overlap (~10-23): retire xtreme_logger book capture + its exporter path | worker + deployer | 1 Polymarket CPU | ML-T5 | blocked until ~10-23 |
| S8 | Deploy `m7/xtreme-logger-drop-chainlink` (rebase first); export 32.8 GiB `reference_feed_ticks` to S3 Parquet, verify, drop from pg1 | worker + Sam approve drop | 2, 1 (pg1 smaller) | ML-T4 step 3, PD-T4/T5 | after S2 |
| S9 | Agent load rule: max concurrent sessions on MAIN (proposal 6), no native builds, worktree cleanup after integrate | Sam decides; manager records in AGENTS.md | 1, 2 root | VH-T19, 10-15 burst | waiting on Sam |
| S10 | Stagger the :x0 crons | Sam (root) | 1 load spikes | VH-T19 | ready |
| S11 | "In control" panel on the observatory: the 5 exit-test lines green/red, plus market data freshness | worker | measures the exit test | E5, ML-T9 (in progress) | in progress (ML-T9) |

## Parked (not worked on until the exit test passes)

- E3 sizing (RAM 8 -> 16 GB): revisit only if the exit test cannot pass on 8 GB.
- E4 workbench + repo sync; VH-T10 alert delivery (L3: history first); M3 purpose/verdict for every service (beyond S6).
- EPIC-901-PG1-DATA decisions PD-T1/T2/T3/T6/T10/T11 and the retire-keep-risk review, except what S8 absorbs.
- VH-T4, T8, T9, T11 (absorbed by E6), VH-T6 orphan multipart, ML-T6 Binance latest.json bug, ML-T7 laneD1/tripwire on collector book.
- `--grant-agent-readonly` root step.

## Issue Ledger

| Ticket | Depends On |
|---|---|
| [E6](../tickets/E6-market-data-rationalization.md) | E1 |
| [VH-T16](../tickets/VH-T16-backups-direct-to-s3.md) | VH-T7, VH-T6 |
| [VH-T18](../tickets/VH-T18-persist-deployer-limits.md) | VH-T17 |
| [VH-T19](../tickets/VH-T19-cron-logger-harmonization.md) | VH-T17 |
| [E5](../tickets/E5-fleet-observatory.md) | E1 |

## Decisions

| Date | Outcome | Decision / Attempt | Durable Summary | Evidence | Revisit When |
|---|---|---|---|---|---|
| 2026-10-16 | accepted | One sprint spine (this doc) orders all remaining MAIN work; everything else parked | Many tickets closed but no single exit test, so "control" kept moving. | Sam, 2026-10-16 03:05 | When the exit test passes. |
