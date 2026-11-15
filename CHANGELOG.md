# Changelog

## [0.5.0] - 2026-11-15

### Changed

- The deterministic glossary check also reads the exported names declared on added lines of JavaScript and TypeScript files, where an alias matches as a whole word inside a name (`owner` in `setOwner`). Markdown prose and source comments are checked as before. (#149)
- An alias inside a canonical term is no longer flagged: `score` where `Score` is itself a term, or `tier` in "hull tier" where `Hull tier` is a term. (#149)
- The typecheck fails on unused locals and parameters and now covers `test/` and `scripts/`. (#150, #151)

### Removed

- `TaskPayloadSchema` and `ReviewTaskPayload`. Cortex validates the receiving side; `DispatchTaskPayload` stays, as a plain type. (#152)

## [0.4.0] - 2026-11-08

### Added

- `review.exclude` in `.sage.yaml` on the base branch removes matching files from the diff and file list every lens reads, including the prior-round and claims diffs. The verdict lists each excluded file, and an invalid value fails the review. (#142)

### Changed

- A failed GitHub preflight now reports what failed instead of "gh auth is not configured". It still exits 2, and stderr ends with a `SAGE_PREFLIGHT_FAILURE` line whose kind is `auth`, `rate-limit`, `transient` or `unknown`. The GitLab preflight is unchanged. (#143, #144)

### Fixed

- Review launch and posting failures are recoverable. (#141)
- The oracle checks only unchecked claims after the first run. (#139, #140)

## [0.3.0] - 2026-10-11

### Changed

- Reviews with a failed lens now have the `incomplete` verdict and CLI exit code 2. Consumers must handle the new verdict; exit code 1 remains changes requested and 0 remains approved or commented. Failed rounds do not emit reviewed-commit or claim markers and are excluded from retry baselines, including legacy DID NOT RUN reports. (#136, #137)
- Incomplete rounds post a forge comment instead of an approval or changes-requested review, and synthetic lens errors do not inflate finding counts. (#136, #137)

### Added

- Repository `.sage.yaml` may declare `glossary.ignore` aliases. Configuration comes from the base revision, matches exact aliases case-insensitively, and applies to deterministic glossary checks and model glossary context. Malformed configuration fails explicitly. (#136, #137)
