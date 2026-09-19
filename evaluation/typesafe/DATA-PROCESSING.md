# TypeSafe corpus data-processing gate

Status: **approved by Jens-Christian Fischer on 2026-09-18 for the exact
five-entry corpus in `corpus.json`, with three shadow-only runs per immutable
head**. The continuing rollout authorization is recorded in the
[issue #125 principal approval receipt](https://github.com/the-metafactory/sage/issues/125#issuecomment-5740115643).

The proof-of-value evaluation is restricted to immutable heads of explicitly
approved, non-critical game PRs listed in `corpus.json`. In the default
`frozen-corpus` authorization mode, the runtime rejects any PR or head SHA
absent from that frozen manifest before calling TypeSafe. The separately
approved persistent rollout described below uses
`approved-repositories-until-revoked` instead and authorizes current heads only
within its local repository allowlist.

The bounded payload contains the PR title, changed paths and line counts,
redacted/truncated diff candidates, and—for existing blocker or important
Findings only—redacted/truncated Lens name and purpose plus the Finding path,
line, Severity, impact, title, rationale, and optional suggestion. Routing and
evidence payloads are each independently capped by `maxStateChars`; full large
diffs, review-posting credentials, and unrestricted repository content are not
included. The runtime redactor removes recognized credential patterns, but it
is not a universal sensitive-content classifier. The exclusion of customer
data, incident material, sensitive security work, and unrecognized secrets is
therefore enforced by the principal's prior classification and explicit
authorization of only non-critical game repositories or immutable PR heads.

As reviewed on 2026-09-18, TypeSafe's public documentation says customer
requests are not used to train Jev. Its public privacy terms describe US
hosting and retention for as long as reasonably necessary; zero-data-retention
is documented as an enterprise option, not assumed for this account. The MCA
also permits service telemetry. For this bounded public-game corpus, the
principal accepted US processing and ordinary retention; zero-data-retention
is not assumed. This approval does not extend beyond the exact heads and
three-run evaluation recorded in the manifest.

The linked issue receipt records Jens-Christian Fischer's 2026-09-19 approval
to install the same bounded, redacted, shadow-only observer on this machine
after merge and keep it enabled until he explicitly turns it off. The planned
machine-local mode-`0600` manifest will use
`authorizationMode: approved-repositories-until-revoked` and name only the
approved non-critical game repositories. Neither that manifest nor the local
on/off switch is committed; their presence must be verified on the machine.
Until installation, the shipped `frozen-corpus` manifest remains disabled by
default. After installation, Sage still runs normally elsewhere, but reviews
outside the local allowlist never call TypeSafe. New records identify which
authorization mode was used. Revocation is performed by removing
`~/.config/sage/typesafe.env` or setting `SAGE_TYPESAFE_MODE=off`.

References reviewed: [model/data-handling documentation](https://docs.typesafe.ai/models),
[privacy policy](https://typesafe.ai/legal/privacy-policy),
[master customer agreement](https://typesafe.ai/legal/mca), and
[data-processing addendum](https://typesafe.ai/legal/data-processing).

The recorded approval includes:

- the approving person and timestamp;
- the exact PR URLs and immutable 40-character head SHAs;
- confirmation that every entry is non-critical game work and contains none of
  the excluded material above;
- the TypeSafe contractual/retention posture that applies to the account;
- acceptance of the cross-border processing posture for this bounded corpus.

Changing model, policy, context selection, or confidence floors invalidates
calibration and requires a new frozen corpus run and fresh report.

`thresholds.json` records the approved usefulness, precision, failure-rate,
sample-size, cost, latency, and repeatability gates. Every routing and
finding-evidence decision signal must also carry an independent label before the
report can recommend a separately authorized production proposal.
