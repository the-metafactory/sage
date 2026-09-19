# TypeSafe shadow PoV operation

The proof of value is disabled by default. Do not enable it until
`DATA-PROCESSING.md`, `corpus.json`, and `thresholds.json` carry explicit
principal approval.

Sage's launcher also reads `~/.config/sage/typesafe.env` after its ordinary
provider environment. This separate `0600` file is the persistent on/off
switch for a machine-wide shadow rollout. A local manifest may set
`authorizationMode` to `approved-repositories-until-revoked` only with
explicit principal approval and a `repositories` allowlist whose entries are
classified `non-critical-game`; the shipped manifest remains `frozen-corpus`.
Reviews outside that allowlist are skipped before the full Review snapshot is
cloned, persisted, or sent to TypeSafe. Remove the file or set
`SAGE_TYPESAFE_MODE=off` to revoke the rollout.

For each approved immutable corpus entry, run Sage at that exact head:

```sh
SAGE_TYPESAFE_MODE=shadow \
SAGE_TYPESAFE_CORPUS=evaluation/typesafe/corpus.json \
SAGE_TYPESAFE_REPEATS=3 \
TYPESAFE_API_KEY=... \
bun run review OWNER/REPO#NUMBER --substrate codex
```

The ordinary Sage Review is computed, persisted, and optionally posted before
the observer starts. `reviewPr` returns the authoritative Verdict without
waiting for advisory work; the CLI prints that Verdict and then awaits the
observer-completion handle so local records survive process exit. Structured
shadow records are written with mode `0600` under
`~/.config/sage/typesafe-shadow/`. The API key is read only by the HTTP
transport and is never included in the request state or record.
Each record includes the authorization mode so frozen-corpus and until-revoked
runs remain distinguishable during evaluation.

`SAGE_TYPESAFE_REPEATS=3` reuses the single completed Sage baseline and records
three sequential TypeSafe judgments over exactly the same state. Then have an
independent reviewer fill `reviewer-labels.json`. Render the report without
network access:

```sh
bun run report:typesafe \
  ~/.config/sage/typesafe-shadow \
  evaluation/typesafe/reviewer-labels.json \
  evaluation/typesafe/thresholds.json
```

For a reviewable operational snapshot, export only records matching immutable
heads in the checked-in corpus. The exporter validates the full record schema,
removes PR titles, paths, excerpts, finding subjects, and selection prose, and
keeps only the public review anchor plus the metrics needed to reproduce the
report:

```sh
bun run export:typesafe-evidence
bun run report:typesafe evaluation/typesafe/live-evidence
```

The checked-in `live-evidence/` cohort is therefore not a second source of
review content; it is a sanitized, immutable audit input for the published
operational measurements. Original records remain local with mode `0600`.

Long digit runs in JSON strings are written as equivalent Unicode escapes by
the export step so repository scanners do not mistake public commit SHAs for
credentials. JSON decoding restores the original string before schema
validation.

Removal is one isolated change: delete `src/typesafe/`, `evaluation/typesafe/`,
the TypeSafe tests and report script, then remove the optional observer field,
CLI flags, and package script. No Verdict, Lens, Forge, or bus contract stores a
TypeSafe-owned decision.
