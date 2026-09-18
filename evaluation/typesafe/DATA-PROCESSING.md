# TypeSafe corpus data-processing gate

Status: **pending principal approval; no real PR material may be sent**.

The proof of value is restricted to immutable heads of explicitly approved,
non-critical game PRs listed in `corpus.json`. The runtime rejects any PR or
head SHA absent from that frozen manifest before calling TypeSafe.

The bounded payload contains only the PR title, changed paths and line counts,
and redacted/truncated diff candidates. It excludes credentials, API keys,
private customer data, incident material, sensitive security work, full large
diffs, review-posting credentials, and unrestricted repository content.

As reviewed on 2026-09-18, TypeSafe's public documentation says customer
requests are not used to train Jev. Its public privacy terms describe US
hosting and retention for as long as reasonably necessary; zero-data-retention
is documented as an enterprise option, not assumed for this account. The MCA
also permits service telemetry. Those facts are not approval.

References reviewed: [model/data-handling documentation](https://docs.typesafe.ai/models),
[privacy policy](https://typesafe.ai/legal/privacy-policy),
[master customer agreement](https://typesafe.ai/legal/mca), and
[data-processing addendum](https://typesafe.ai/legal/data-processing).

Before changing `dataProcessingApproval.status` to `approved`, a principal
must record:

- the approving person and timestamp;
- the exact PR URLs and immutable 40-character head SHAs;
- confirmation that every entry is non-critical game work and contains none of
  the excluded material above;
- the TypeSafe contractual/retention posture that applies to the account;
- acceptance of the cross-border processing posture for this bounded corpus.

Changing model, policy, context selection, or confidence floors invalidates
calibration and requires a new frozen corpus run and fresh report.

`thresholds.json` remains pending until the principal approves the usefulness,
precision, failure-rate, sample-size, and cost gates. The report generator will
not recommend a production proposal while those thresholds are pending.
