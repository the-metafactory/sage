import { z } from "zod";

/**
 * Canonical Zod schema for the `code-review` task envelope's `payload` field.
 *
 * One source of truth shared between both wire directions:
 * - `bridge.ts` (receiver) — calls `TaskPayloadSchema.safeParse` on incoming
 *   envelopes; the inferred `ReviewTaskPayload` type drives the daemon's
 *   `resolvePrRef` etc.
 * - `dispatcher.ts` (sender) — derives `DispatchTaskPayload` by narrowing
 *   `post` to `true` (per sage#8: the sender NEVER sends `post: false`;
 *   absence means "let the daemon-default decide").
 *
 * When the protocol gains a field (priority, labels, target_lens, etc.),
 * add it here once. Both sites pick it up automatically — pre-#10, both
 * sites had hand-maintained parallel definitions that would silently
 * drift.
 *
 * Refinement: an envelope must carry EITHER a `pr_url` or the
 * `owner+repo+number` triple. The daemon's `resolvePrRef` handles both.
 */
export const TaskPayloadSchema = z
  .object({
    pr_url: z.string().url().optional(),
    owner: z.string().optional(),
    repo: z.string().optional(),
    number: z.number().int().positive().optional(),
    post: z.boolean().optional(),
    /** Per-lens pi timeout. Falls back to daemon PI_TIMEOUT_MS / default. */
    timeout_ms: z.number().int().positive().optional(),
  })
  .refine((p) => Boolean(p.pr_url) || (Boolean(p.owner) && Boolean(p.repo) && Boolean(p.number)), {
    message: "payload must contain either pr_url or (owner, repo, number)",
  });

/**
 * Inferred type for the receiver side. Matches what `safeParse` produces
 * after the refinement runs — all fields optional at the type level since
 * the refinement enforces the disjunction at runtime.
 */
export type ReviewTaskPayload = z.infer<typeof TaskPayloadSchema>;

/**
 * Sender-side narrowing of `ReviewTaskPayload`. Built via `Pick` (not
 * `Omit`) so the dispatcher type doesn't carry fields it never sends:
 *
 * - `pr_url` is REQUIRED (the dispatcher always knows the full URL — it
 *   constructs it from the parsed PR ref). The `owner/repo/number` alt is
 *   only used by webhooks-side producers, not this CLI's dispatcher, so
 *   those fields are deliberately absent here.
 * - `post` is `true | undefined`, never `false`. Sending an explicit
 *   `false` would clobber the bridge's `payload.post ?? cfg.postReviews`
 *   fallthrough (??-coalesce treats false as a value). See sage#8.
 *
 * Tradeoff vs `Omit<ReviewTaskPayload, "post" | "pr_url">`: future
 * protocol fields added to `TaskPayloadSchema` (e.g. `priority`, `labels`,
 * `target_lens`) do NOT auto-propagate here — they need an explicit add
 * to the `Pick` set. The `shape-parity` test in `test/payload.test.ts`
 * already enforces sender-is-subset-of-receiver, so the gap can only go
 * one direction (sender lagging behind receiver, never sender drifting
 * past it). Precision > automatic propagation for the dispatcher's
 * tightly-scoped surface.
 */
export type DispatchTaskPayload = Pick<ReviewTaskPayload, "timeout_ms"> & {
  pr_url: string;
  post?: true;
};
