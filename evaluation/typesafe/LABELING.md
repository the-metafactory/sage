# Independent decision-label audit

The 114 labels in `reviewer-labels.json` were adjudicated by a Codex agent on
2026-09-19, independently of Jev's generation step. This was an agent review,
not a human or principal attestation, and it was not blind: the reviewer could
see Jev's recorded choices while checking them against the immutable public
heads and locally persisted Sage baselines.

Candidate-selection helper signals are excluded. The 38 routing and
finding-evidence decisions over five immutable states were adjudicated once,
then the same ground truth was applied to each state's three repeat records.
Usefulness is evaluated per record: an accepted `recommend` or `supported` is
positive, and a signal is useful when that polarity matches the adjudicated
ground truth.

## Routing rubric

A routing decision is positive when the corresponding specialized Sage Lens
produced at least one actionable Finding in the completed baseline. A Lens
that was inapplicable or completed without a Finding is negative. This makes
the proof-of-value question operational: would the bounded signal have routed
work toward a Lens that produced review value on this exact head?

| PR | Security | Architecture | EcosystemCompliance | Performance | Maintainability |
| --- | --- | --- | --- | --- | --- |
| `#319` | no | no | no | no | yes |
| `#336` | no | no | no | yes | yes |
| `#347` | no | no | no | no | yes |
| `#354` | no | yes | no | yes | yes |
| `#389` | no | no | no | no | yes |

## Finding-evidence adjudications

The reviewer checked each retained important Finding against the exact public
head. Only the duplicated right-panel markup was supported. The others were
false or overstated baseline Findings: several glossary hits were ordinary
technical uses (`gamepad`, keyboard `modifier`, or carrier `slot`), `Launch
queue` occurred in its canonical `_Avoid_` declaration, `forceRaider` bypassed
the query flag in its implementation, the render-scale slack already covered
the noisy fit, and the airlock geometry already used absolute axial
coordinates.

| PR | Question suffix | Finding | Ground truth |
| --- | --- | --- | --- |
| `#319` | `3c6351c18423` | `Launch queue` glossary alias | negative |
| `#319` | `709cdc073368` | `power` glossary alias | negative |
| `#336` | `666f78c97c05` | airlock Z placement | negative |
| `#347` | `1201e559e7d9` | `slot` glossary alias | negative |
| `#347` | `920a00d3cb7b` | `forceRaider` bypass absent | negative |
| `#354` | `50992831b777` | render-scale ceiling proof | negative |
| `#354` | `702d056851fd` | `Command` glossary alias | negative |
| `#389` | `611731e55552` | duplicated right-panel markup | positive |
| `#389` | `574d82fcafd8` | `pad` glossary alias | negative |
| `#389` | `4074a43b71f0` | `pad` glossary alias | negative |
| `#389` | `2e8caa43ec8b` | `Modifier` glossary alias | negative |
| `#389` | `4c2dfe5eaa4c` | `pad` glossary alias | negative |
| `#389` | `936984df67b5` | `pad` glossary alias | negative |

The audit is reproducible from the exact heads in `corpus.json`, the sanitized
decision records in `live-evidence/`, and the label file. The unredacted local
records remain mode `0600` and are not committed.
