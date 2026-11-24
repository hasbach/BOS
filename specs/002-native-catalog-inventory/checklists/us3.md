# User Story 3 checkpoint (T077): availability that cannot oversell

**Run**: 2026-11-18, by the implementing agent, on the development PC (private PostgreSQL on 127.0.0.1:55433). Backend only; T076 (frontend `allocation` source in `StockHistory.tsx`) is not part of this run.

- [x] Exit-gate tests, from `backend/`: `uv run python scripts/local_tests.py -k "allocation or concurrency" -v tests/integration/test_integrity.py tests/integration` → `60 passed, 906 deselected in 12.79s`, among them:
  - `test_two_allocations_for_the_last_unit_exactly_one_wins`
  - `test_twenty_threads_racing_for_five_units_exactly_five_win`
  - `test_one_short_line_reserves_nothing_and_every_short_line_is_listed`
  - `test_the_same_key_and_contents_return_the_original_whatever_its_state`, `test_the_same_key_with_other_contents_is_refused`
  - `test_the_same_request_key_from_several_threads_makes_one_allocation`, `test_a_duplicate_waiting_on_the_first_request_key_returns_the_winners_allocation`
  - `test_release_returns_the_quantity_and_can_be_repeated`, `test_consume_lowers_on_hand_and_allocated_with_one_movement_per_line`
  - `test_an_archived_variant_or_product_is_refused[variant|product]`
  - `test_allocations_racing_adjustments_never_oversell_and_lose_no_update`
  - `test_an_allocation_holding_the_balance_makes_a_racing_archive_refused`, `test_an_archive_holding_the_balance_makes_a_racing_allocation_refused`, `test_allocations_racing_a_variant_archive_either_all_win_or_the_archive_does`
  - `test_requests_naming_items_in_opposite_orders_never_deadlock`
  - the four stock-adjustment concurrency tests of `test_stock_concurrency.py`
- [x] Integrity report tests: `uv run python scripts/local_tests.py tests/integration/test_integrity.py` → `9 passed in 2.29s`
- [x] Every allocation, stock and catalog test ends with the integrity check (`integrity_check` fixture): zero differences after every scenario (SC-003).
- [x] `flask bos stock-check [--tenant ID]` tested in `tests/integration/test_cli.py` (0 differences and exit 0 on consistent data; each difference listed and exit non-zero after a corruption; one business; unknown business refused).
- [x] Full backend suite: `uv run python scripts/local_tests.py -q -p no:cacheprovider` → `1826 passed in 140.17s`
- [x] `ruff check` clean, `ruff format --check` 116 files formatted, `mypy` no issues in 50 source files

Full verbose output of the exit-gate run: kept by the agent in its scratchpad (`m1-us3-gate.log`), not committed.
