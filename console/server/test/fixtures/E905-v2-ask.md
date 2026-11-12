# E5: Archiver

Spine ID: e5-archiver

## Current State

Status: blocked
Waiting on: Sam: E905-A3, E905-A4

## Waiting on

- [ask E905-A3: do @Sam since 2026-10-21 row S3] Patch the archiver for 1 h on main (S3: the 1 h book archive) so the Chainlink cutover can run — steps: [runbook](runbooks/archiver-patch.md#run) (main, user root) — unblocks: S2, S3; each day waiting loses a day of archived ticks — recommend: do it tonight — effort: ~10 min — context: [why](notes.md#archiver)
- [ask E905-A4: decide @Sam since 2026-10-01] Keep raw books forever or 6 months? — options: forever | 6 months — recommend: forever — unblocks: S4 retention job — context: notes.md
- [ask E905-A4: approve @Sam since 2026-10-21] Approve the exporter autoDeploy off? — recommend: approve — context: notes.md
- [ask: provide @Sam since 2026-10-21] The pg1 read-only password — context: notes.md
- [answered E905-A1 2026-10-20 @Sam] Use one logger? — answer: one

## Issue Ledger

| Issue | Title | Needs | Status |
|---|---|---|---|
| S2 | Chainlink cutover | — | blocked |
| S3 | Patch the archiver for 1h | Sam root | blocked |

## Definition Of Done

- [ ] DOD-1 Test fixture for the console inbox (M2-18).
