# T102 / US5 — CSV import checkpoint evidence

**Automated evidence captured.** The [shared run record](us1.md#shared-automated-run-records-t057-t070-t088-t102) gives full suite results, contract/route-coverage output, the isolated run and integrity scope. Quickstart scenario 5 and checkpoint approval are not recorded.

| Task | Automated evidence |
| --- | --- |
| T089 | [Number normalization](../../../backend/tests/unit/test_numbers.py): **15 passed**. Local digits/separators and invalid number forms. |
| T090 | [CSV rules](../../../backend/tests/unit/test_csv_rules.py): **5 passed**. Header/empty-cell rules, product inheritance, stores, SKU/code and combinations, variant/option limits, amounts and collected row errors. |
| T091 | [Import API](../../../backend/tests/integration/test_catalog_import.py): **21 passed**, integrity active. File-level precedence, BOM and Arabic cells, failed/valid preview, ledger/audit/committed replay, expiry, confirm races, conflicts, full rollback, reuse errors, no-photo and 500-row timing. The preview, failed preview and confirm happy path call the OpenAPI response assertion. |
| T092 | [Maintenance](../../../backend/tests/integration/test_maintenance_catalog.py): `test_expired_uncommitted_batches_are_purged_but_results_are_kept` passed within the shared **4 passed**, integrity active. Checks per-tenant cleanup with committed results preserved. |
| T093 | Actual cases live in [test_import_routes.py](../../../backend/tests/isolation/test_import_routes.py), not `test_m1_routes.py` as named in the task: **5 passed**, integrity active. All four route permissions and audit; foreign/missing GET and confirm uniformly not found; template static and uploads tenant-bound. |
| T094 | [Import component](../../../frontend/tests/catalog/import.test.tsx) in the full Vitest suite: template, upload progress, file vs row errors, preview and confirm controls, conflict and result. |
| T095 | [Browser import journey](../../../frontend/e2e/m1-import.spec.ts) passed in both locales: UTF-8 template with Arabic, four data rows with three distinct errors, empty pre-confirm catalog, counts, confirmation, one sampled opening movement, re-upload showing four rows to fix and no extra products. The browser checks the duplicate count; per-row duplicate codes are checked by the backend rather than individually by the browser. This is not the manual 40-valid-plus-3-faulty exercise. |

### Captured timing and atomicity (SC-005)

```text
 test_catalog_import.py::test_500_rows_preview_within_budget 500-row preview: 0.172s
 PASSED
 test_mid_confirm_failure_rolls_back_every_write PASSED
 test_late_sku_race_rolls_back_prior_products_and_returns_row_error PASSED
 test_simultaneous_confirms_return_the_same_batch PASSED
```

The measured upload-to-preview was **0.172 s** against **<30 s**, in the Flask test client on the isolated PostgreSQL database, not a mobile browser, real network or UI timing. The passing timing test had the integrity fixture active. This is the T102 timing to quote in T107; it does not replace any mobile profile numbers.

**Still manual:** [Quickstart scenario 5](quickstart-runbook.md#5--csv-import-t102-sc-005) needs both locales using the spreadsheet, 40 valid + 3 faulty rows, each localized error, audit, repeat upload, file-level refusals and the No photo filter.
