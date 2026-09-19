# TypeSafe shadow proof-of-value report

Status: **complete bounded evaluation — iterate**.

The approved public-game corpus covers all five immutable Seelite heads, each
with one complete fixed Sage baseline and three sequential Jev judgments over
the same bounded state. The committed evidence records selected baseline Lens
names, Finding fingerprints, and Verdict decisions, but not the Sage substrate
or full baseline Finding bodies:

- `jcfischer/seelite#336` at `f8190d2a2a6ad65918db24bec9b10ce3e7dcede4`
- `jcfischer/seelite#347` at `a6995ab79d48286070823914671e1ecf37444efe`
- `jcfischer/seelite#354` at `f2297e371d2c9b608166742995069aafd29a5e4c`
- `jcfischer/seelite#319` at `27608527de9de92ef2d8d66e832b62b20f5e1792`
- `jcfischer/seelite#389` at `7c8a99cf9aaac6b1ad1cd9872b8e8d229ba9336e`

No review was posted. Jev remained advisory and had no return channel into Lens
selection, Findings, Severity, the Verdict, or Forge interactions.

## Coverage and operations

- Records: 15
- Immutable states: 5
- Completed baseline Lens runs observed: 33
- Failed baseline lens runs: 0
- Labeled decision-record signals: 114 / 114 (0 missing; 38 unique state/question adjudications applied to three repeats)
- Decision signals with ground truth: 114 / 114 (0 missing)
- Failed records: 0
- State-truncated records: 15 / 15 (1.000)
- Evidence questions omitted by request bounds: 258
- Provider request attempts / retries: 30 / 0
- Latency p50 / p95: 561 ms / 1172 ms
- Usage: 170,088 input tokens, 16,329 output tokens
- Estimated provider cost: $0.007144 total, $0.000476 average per record

The 258 omissions are 86 excess important Findings from `#389`, repeated over
its three Jev judgments. The hard evidence-question bound worked as designed,
but the resulting coverage gap independently prevents a production proposal.

## Decision-signal repeatability

Routing and finding-evidence signals only; candidate-selection helper signals
are intentionally excluded because they do not count toward the production
gate.

This is a bounded operational signal over five immutable states, not evidence
of general stability or value.

- Repeated decision state/question groups: 38
- Mean exact-choice agreement: 1.000
- Maximum probability spread: 0.070

All repeated choices were identical across their three runs, and the maximum
spread clears the predeclared 0.20 ceiling.

## Independent reviewer labels

The labels are an independent Codex agent audit, not a human or principal
attestation. The rubric and the 38 state/question adjudications expanded across
three repeats are documented in `LABELING.md`.

| Question | Labeled | Useful | Not useful | Indeterminate | Evidence sufficient | Precision | Recall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `finding.evidence.v1` | 39 | 30 | 9 | 0 | 39 | 0.000 | 0.000 |
| `lens.architecture.v1` | 15 | 6 | 9 | 0 | 15 | 0.250 | 1.000 |
| `lens.ecosystem-compliance.v1` | 15 | 15 | 0 | 0 | 15 | n/a | n/a |
| `lens.maintainability.v1` | 15 | 3 | 12 | 0 | 15 | 1.000 | 0.200 |
| `lens.performance.v1` | 15 | 12 | 3 | 0 | 15 | 1.000 | 0.500 |
| `lens.security.v1` | 15 | 15 | 0 | 0 | 15 | n/a | n/a |

Overall usefulness was 81 / 114 (0.711), below the approved 0.75 production-
proposal threshold. Finding-evidence precision was 0.000, Architecture
precision was 0.250, and Maintainability recall was 0.200. Stable repetition
therefore did not translate into sufficient decision quality.

## Recommendation

Threshold status: **approved**.

**Iterate. Do not propose production authority.** The corpus completed with
excellent operational reliability and repeatability, but the independently
labeled usefulness and question-level quality do not clear the approved gates,
and the bounded evidence stage omitted part of one pathological baseline. The
shadow observer remains suitable for continued non-authoritative measurement
on the explicitly approved game repositories.

The metrics reproduce offline from the schema-validated, content-sanitized
records with:

```sh
bun run report:typesafe \
  evaluation/typesafe/live-evidence \
  evaluation/typesafe/reviewer-labels.json \
  evaluation/typesafe/thresholds.json
```
