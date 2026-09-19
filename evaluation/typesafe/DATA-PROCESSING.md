# TypeSafe corpus data-processing gate

Status: **approved by Jens-Christian Fischer on 2026-09-18 for the exact
five-entry corpus in `corpus.json`, with three shadow-only runs per immutable
head**.

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
also permits service telemetry. For this bounded public-game corpus, the
principal accepted US processing and ordinary retention; zero-data-retention
is not assumed. This approval does not extend beyond the exact heads and
three-run evaluation recorded in the manifest.

On 2026-09-19, Jens-Christian Fischer separately authorized this machine to
run the same bounded, redacted, shadow-only observer for every Sage review
until he explicitly turns it off, noting that the active work for the next few
days is game development. That broader authorization is stored in a local
`0600` manifest with `authorizationMode: all-reviews-until-revoked`; it is not
the shipped corpus default. New records identify which authorization mode was
used. Revocation is performed by removing `~/.config/sage/typesafe.env` or
setting `SAGE_TYPESAFE_MODE=off`.

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
