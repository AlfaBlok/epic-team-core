# EPIC-902: MAIN control (hold)

Spine ID: infra-epic-902

## Current State

Owner: Delivery manager
Status: active
Last attempted: 2026-10-24 06:53 CEST all 5 exit checks green; 7-day hold started
Result: DoD 5/5 green now; proof needs the hold
Monitoring: 7-day hold, all 5 DoD green since 2026-10-24T06:53+02:00 until 2026-10-31T06:53+02:00 · next check 2026-10-25T02:00Z archiver delete proof (DOD-2) · then write Outcome, Status review
Waiting on: none
Next action: 2026-10-25 02:00 UTC check the archiver delete proof
Verified at: 2026-10-24 06:53 CEST

## Waiting on

- [answered EPIC-902-A2 2026-10-22 @Sam] Stop the old twap service? — answer: yes

## Definition Of Done

- [ ] DOD-1 tripwire stays paused 7 days
- [ ] DOD-2 archiver deletes on schedule
- [ ] DOD-3 disk under 70%
- [ ] DOD-4 no OOM
- [x] DOD-5 Chainlink cutover done
