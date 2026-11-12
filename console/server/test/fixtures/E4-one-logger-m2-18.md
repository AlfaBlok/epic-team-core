# E4: One logger

Spine ID: e4-one-logger

## Current State

Owner: E4 manager (thread mcp:e4e4e4e4-1111-2222-3333-444455556666)
Status: ready
Waiting on: none
Next action: resume Phase 1 (T1–T3)

## Issue Ledger

| Issue | Title | Prod change? | Needs | Status |
|---|---|---|---|---|
| 0 | **S3** (patch the archiver for 1h) and **S2** (Chainlink cutover) — already queued | yes | Sam root | waiting (Sam root, ops S2/S3) |
| T1 | Bring the host-only code into git | no | worker | ready — code part done |
| T2 | XL-1: `streams.yaml` + schema | no | worker | ready — not started |
| T3 | XL-2: Node service `apps/xtreme_logger/` | no | worker | ready — not started |
| T4 | XL-3: deploy in place of xz7bqe, book only | yes | Sam go | pending |
| T5 | XL-4: chainlink stream on; stop 3mtbos | yes | Sam go | pending |
| T6 | Re-point readers to the new tables | no | worker; Sam pulls on dub_1 | ready — not started |
| T7 | XL-6: `market_data.*` tables + pg1 writer | yes (new tables only) | Sam go (pg1 schema) | ready — T7a (exporter part) not started |
| T8 | S8: podcek stops Chainlink capture; drop 33 GiB | yes | Sam approves drop | pending |
| T9 | XL-5: binance_l2 stream on | yes | Sam go; after T3 | ready |
| T10 | S7: retire podcek | yes | Sam go; T6 + T7 green | pending |
| T11 | XL-7: archiver as a service task | yes | Sam root | pending |

## Definition Of Done

- [ ] DOD-1 Test fixture for the console inbox (M2-18).
