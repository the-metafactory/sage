/**
 * The `payload` of the `code-review` task envelope that `sage dispatch`
 * publishes. Sage is the sender only: cortex's `ReviewConsumer` owns the
 * receiving side and validates what arrives with its own resolver, so
 * Sage keeps no receiver schema.
 */
export type DispatchTaskPayload = {
  /** Always set: the dispatcher builds the full PR or MR URL from the parsed ref. */
  pr_url: string;
  /** Slash-joined owner/repo per cortex#237 §4.1 (sage#52). */
  repo: string;
  /** Integer PR/MR number; pairs with `repo` (cortex#237 §4.1, sage#52). */
  pr?: number;
  /**
   * Label for the routing semantic. Receivers are selected by capability,
   * not by this field; Sage dispatch defaults to `"capability-dispatch"`.
   */
  reviewer?: string;
  /** Per-lens timeout. Falls back to the receiver's default. */
  timeout_ms?: number;
  /**
   * Forge discriminator (sage#43). Omitted for GitHub so older receivers
   * keep working; set for a GitLab MR so cortex routes to the GitLab backend.
   */
  forge?: "github" | "gitlab";
  /**
   * `true` or absent, never `false`. An explicit `false` would clobber the
   * receiver's `payload.post ?? cfg.postReviews` fallthrough (sage#8).
   */
  post?: true;
};
