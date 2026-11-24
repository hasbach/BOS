# M1 manual acceptance (human-only items)

Automated and scripted runs cannot close the items below. Each needs a person. Record the result, the date and who ran it in the table, then present the [exit gate](exit-gate.md) for approval.

**Setup:** Start the local stack as in [quickstart → Start](../quickstart.md#start). Sign in as the demo owner. Use a phone, or Edge DevTools device mode at **360 × 740**. If you use a phone, it must reach the web server you started; the dev stack binds to `127.0.0.1` by default.

| # | Check | How | Pass when | Result / date / who |
|---|---|---|---|---|
| H1 | **SC-001 first-use timing, English** | Start a timer when the Add product form is visible (More → Catalog → Add product). Create a product with sizes `S/M/L`, colours `Blue/Black`, one photo, a price and opening stock `5` on each variant. Tap Save. | The product is saved with six variants in **under 3 minutes**, without help. | |
| H2 | **SC-001 first-use timing, Arabic** | Switch the language to العربية and repeat H1 with a new product code. | Same as H1, and the layout reads right-to-left. | |
| H3 | **Screen reader: offline announcement** | Turn on NVDA or Narrator on Windows, or TalkBack/VoiceOver on a phone. Open Catalog, disconnect the network, reconnect, then disconnect again. Repeat in Arabic. | The offline notice is announced **once** per disconnect, in the page language. | |
| H4 | **Screen reader: core journey** | With the screen reader on, go through Catalog search → product → Adjust stock (enter a quantity, then Save) → Stock history → Low stock → CSV import (choose a file). | Every control has a spoken name. Focus enters the Adjust sheet and returns to its opener. Errors and the CSV progress are announced. | |
| H5 | **Product-owner exit-gate approval** | Read the [exit gate](exit-gate.md) and its open findings. | Approved, or a list of blockers is given. | **Approved**, 2026-11-24, product owner, by merging [hasbach/BOS#1](https://github.com/hasbach/BOS/pull/1) (merge commit `0687e07`). H1–H4 had not been run at the time of approval. |

Notes:

- **Approval with open checks (2026-11-24):** the product owner approved M1 (H5) before H1–H4 were run. H1–H4 stay open as findings. They are not M1 blockers, and their results are to be recorded in this table when they are run.

- The scripted timings in [quickstart-execution](quickstart-execution.md) (EN 3.8 s, AR 3.7 s) show that the flow works. They do not replace H1/H2.
- Automated accessibility coverage is in [ux-pass](ux-pass.md). H3/H4 cover what axe and Playwright cannot hear.
