# TypeSafe shadow PoV operation

The proof of value is disabled by default. Do not enable it until
`DATA-PROCESSING.md`, `corpus.json`, and `thresholds.json` carry explicit
principal approval.

For each approved immutable corpus entry, run Sage at that exact head:

```sh
SAGE_TYPESAFE_MODE=shadow \
SAGE_TYPESAFE_CORPUS=evaluation/typesafe/corpus.json \
TYPESAFE_API_KEY=... \
bun run review OWNER/REPO#NUMBER --substrate codex
```

The ordinary Sage review is computed, persisted, and optionally posted before
the observer runs. Structured shadow records are written with mode `0600` under
`~/.config/sage/typesafe-shadow/`. The API key is read only by the HTTP
transport and is never included in the request state or record.

Repeat every immutable state as required by the study, then have an independent
reviewer fill `reviewer-labels.json`. Render the report without network access:

```sh
bun run report:typesafe \
  ~/.config/sage/typesafe-shadow \
  evaluation/typesafe/reviewer-labels.json \
  evaluation/typesafe/thresholds.json
```

Removal is one isolated change: delete `src/typesafe/`, `evaluation/typesafe/`,
the TypeSafe tests and report script, then remove the optional observer field,
CLI flags, and package script. No Verdict, Lens, Forge, or bus contract stores a
TypeSafe-owned decision.
