# T070 / US2 — Stock ledger checkpoint evidence

**Automated evidence captured.** The [shared run record](us1.md#shared-automated-run-records-t057-t070-t088-t102) gives backend scope, contract/route-coverage output, integrity fixture semantics and full Vitest/Playwright results. Quickstart scenario 2 and checkpoint approval are not recorded.

| Task | Automated evidence |
| --- | --- |
| T058 | [Adjustments](../../../backend/tests/integration/test_stock_adjustments.py): **60 passed**, integrity active. Signs by reason, Other direction/note, count including zero, integer bounds, stale current balance, reserved floor, named DB constraint translation, same-key replay vs changed body, archived variant, audit data and immutable earlier movements. |
| T059 | [Movements](../../../backend/tests/integration/test_stock_movements.py): **14 passed**, integrity active. Newest-first rows and stable 50-row cursor; actor, signed count, source, running balance and manager read without `audit.view`. |
| T060 | [Concurrency](../../../backend/tests/integration/test_stock_concurrency.py): **4 passed**, integrity active (named results below). |
| T061 | [M1 isolation](../../../backend/tests/isolation/test_m1_routes.py): **12 adjustment/movement cases passed** within the shared **67 passed**, integrity active. Foreign variant vs invented ID, denied sales/packing/dispatch and caller-side denial audit. |
| T062 | [Adjust sheet](../../../frontend/tests/catalog/adjust-stock.test.tsx) and [history](../../../frontend/tests/catalog/stock-history.test.tsx) included in the recorded full Vitest suite: Add/Remove/Set count, Other direction, Arabic digits, preview and server-confirmed success, current balance on conflict, same-key retry, Beirut timestamps and history paging/empty states. |
| T063 | [Stock journey](../../../frontend/e2e/m1-stock.spec.ts), both locales in the full 360 px run: manager add/remove/count and ledger, stale windows and retry with new values, too-large removal, double tap and packing POST denial. |

```text
 test_two_changes_from_the_same_balance_version_record_exactly_one PASSED
 test_parallel_decrements_never_go_negative_and_lose_no_update PASSED
 test_the_same_key_sent_by_several_threads_records_one_movement PASSED
 test_a_lock_held_past_the_lock_timeout_answers_try_again_and_records_nothing PASSED
 test_the_same_key_twice_records_one_movement_and_replays_it_with_the_balance_now PASSED
```

### T112 scenario 3 backend evidence (no allocation UI)

Same isolated run: [allocation](../../../backend/tests/integration/test_allocation.py) **29 passed**, [allocation concurrency](../../../backend/tests/integration/test_allocation_concurrency.py) **9 passed**, with the integrity fixture active in both. Named passes include last unit (one winner), 20-for-5 (five winners), one short line (reserve none), same-key replay vs changed-content conflict, release, consume, archive refusal, and allocation racing adjustment; see [US3 record](us3.md) for the individual test names and earlier capture. [Checker tests](../../../backend/tests/integration/test_integrity.py) **9 passed**, including deliberate drift detection. This does not imply a screen exists for allocation or that Reserved was manually inspected in either locale.

**Still manual:** [Quickstart scenario 2](quickstart-runbook.md#2--stock-adjustments-t070-sc-002-sc-007) needs the bilingual walkthrough, observed preview/history, two operator sessions, double tap and the owner audit view of the packing refusal. The lost-response replay is automated evidence, not a hand-timed step.
