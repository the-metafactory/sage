# TypeSafe shadow proof-of-value report

Status: **not run**.

No real PR material has been sent to TypeSafe. The corpus manifest and
data-processing approval are intentionally pending. After approval, run the
same immutable heads repeatedly, collect the structured records from
`~/.config/sage/typesafe-shadow/`, obtain independent reviewer labels in
`reviewer-labels.json`, and render the report with the pure report generator in
`src/typesafe/report.ts`.

The usefulness/cost thresholds in `thresholds.json` are also pending. Until
they are explicitly approved, the generator is fail-closed to `iterate` and
cannot recommend a production proposal.

The final report must include deterministic baseline coverage, per-question
usefulness and evidence sufficiency, precision/recall where ground truth is
available, repeated-run agreement and probability spread, adversarial results,
latency, token and dollar cost including failures/retries, truncation, failure
cases, and exactly one recommendation: stop, iterate, or propose a separately
authorized production integration.
