# TypeSafe shadow proof-of-value report

Status: **partial live evaluation — iterate**.

This snapshot covers two of the five approved immutable Seelite corpus heads,
each with one complete Sage baseline and three sequential Jev judgments over
the same bounded state:

- `jcfischer/seelite#347` at `a6995ab79d48286070823<wbr>914671e1ecf37444efe`
- `jcfischer/seelite#354` at `f2297e371d2c9b608166742995069aafd29a5e4c`

Both reviews ran through Claude Code without posting to GitHub. All 14 Sage
lenses completed; none produced an errored baseline report. Jev was advisory
only and had no return channel into lens selection, findings, severity, the
Verdict, or Forge actions.

## Coverage and operations

- Records: 6
- Immutable states: 2
- Completed baseline Lens runs observed: 14
- Failed baseline lens runs: 0
- Independently labeled decision signals: 0 / 42 (42 missing)
- Decision signals with ground truth: 0 / 42 (42 missing)
- Failed records: 0
- State-truncated records: 6 / 6 (1.000)
- Evidence questions omitted by request bounds: 0
- Provider request attempts / retries: 12 / 0
- Pre-fix recorded stage-total latency p50 / p95: 577 ms / 1172 ms
- Usage: 69,345 input tokens, 6,588 output tokens
- Estimated provider cost: $0.002912 total, $0.000485 average per record

## Decision-signal repeatability

Routing and finding-evidence signals only; candidate-selection helper signals
are intentionally excluded because they do not count toward the production gate.

This is an early operational signal over two immutable states, not evidence of
general stability or value.

- Repeated decision state/question groups: 14
- Mean exact-choice agreement: 1.000
- Maximum probability spread: 0.060

Every repeated routing and finding-evidence Choice was identical across its
three runs. The probability spread clears the predeclared 0.20 ceiling, and
the conservative pre-fix stage-total latency, failure rate, and cost clear
their operational thresholds. New records use concurrent wall-clock latency
(the slower stage), not the sum of the two parallel stages.

These measurements are reproducible from the schema-validated, content-
sanitized records in `live-evidence/` with:

```sh
bun run report:typesafe evaluation/typesafe/live-evidence
```

The artifact retains metrics and public immutable review anchors but removes
PR titles, paths, excerpts, finding subjects, and candidate-selection prose.

## Early qualitative observations

For PR #347, Jev recommended no additional conditional lens. It classified the
Glossary finding about `slot` as supported and the HonestOracle `forceRaider`
claim as insufficiently evidenced by the selected diff excerpt.

For PR #354, Jev recommended Architecture, Performance, and Maintainability.
It classified both important findings as insufficiently evidenced. This is a
useful pressure point for labeling: findings grounded partly in repository
context or mathematical prose may need more than the nearest bounded diff hunk,
but expanding state would increase disclosure and cost.

All six records report bounded-state truncation. That is expected for these
large diffs and proves the size boundary is active, but independent review must
decide whether the retained evidence is still useful enough.

## Independent reviewer labels

No independent labels have been supplied yet. Precision, recall, false-negative
examples, and reviewer-validated usefulness therefore cannot be calculated.
Candidate-selection helper signals do not count toward the production gate;
every routing and finding-evidence decision does.

## Recommendation

Threshold status: **approved**.

**iterate** — Operational behavior is strong, but the proof of value has not
cleared its evidence gate. Complete the remaining approved corpus runs and
independently label all decision signals before proposing any separately
authorized production integration.
