# T088 / US4 — Low-stock checkpoint evidence

**Automated evidence captured.** The [shared run record](us1.md#shared-automated-run-records-t057-t070-t088-t102) gives backend, contract, route-coverage, component and browser output. Quickstart scenario 4 and checkpoint approval are not recorded.

| Task | Automated evidence |
| --- | --- |
| T078 | [Business settings](../../../backend/tests/integration/test_business_settings.py): **50 passed** (full settings module, not all M1 cases; no inventory fixture). Covers default 2, owner/manager change, max value, field validation, denied staff and before/after audit. |
| T079 | [Low-stock API](../../../backend/tests/integration/test_low_stock.py): **8 passed**, integrity active. Named cases `test_list_and_sales_catalog_use_effective_threshold_and_available_stock`, `test_list_is_paged_by_availability_and_sku_and_can_filter_by_store` and `test_recording_stock_changes_moves_a_variant_into_and_out_of_the_list` passed. Asserts threshold override/default, zero-disabled warning but Out in catalog, active/visible scope, ordered and filtered list and movement across threshold. |
| T080 | [M1 isolation](../../../backend/tests/isolation/test_m1_routes.py): `test_low_stock_list_requires_stock_adjust` and `test_low_stock_hides_another_business_and_refuses_its_store_filter` passed across their parameters (**6 cases** within the shared **67 passed**, integrity active). Checks role denial and foreign store ID refusal with audit. |
| T081 | [List](../../../frontend/tests/catalog/low-stock.test.tsx), [settings](../../../frontend/tests/stores/settings.test.tsx) and [start tab](../../../frontend/tests/shell/seeded-screens.test.tsx) in the recorded full Vitest suite: list content/out first, empty/paged behavior, Arabic-Indic default field and validation, privileged shortcut and count/first names. |
| T082 | The journey is in [m1-low-stock.spec.ts](../../../frontend/e2e/m1-low-stock.spec.ts), not `m1-stock.spec.ts` as named in the task. It ran in both locales in the full suite. API fixtures/adjustments drive 5 → 3 → 7 and the browser checks the Low list, ordering, zero-level exclusion/Out, staff catalog with Low visible and no Low-stock list link, and direct GET 403. It does not perform the settings change or the adjustments through the UI. |

The settings and low-stock JSON assertions use the shared [OpenAPI response helpers](../../../backend/tests/integration/us1_support.py). The registration gate passed independently of these endpoint checks.

**Still manual:** [Quickstart scenario 4](quickstart-runbook.md#4--low-stock-warnings-t088) needs both locale records, including entering the level and adjustment through the UI, both routes to the list, the staff Low filter and the owner-visible History refusal.
