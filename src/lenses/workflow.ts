import type {
  ForgeBackend,
  InlineComment,
  PrMetadata,
  PrRef,
  ReviewEvent,
} from "../forge/types.ts";
import { createPriorFindings } from "../prior-findings/index.ts";
import type {
  PriorFindings,
  PriorFindingsStatus,
} from "../prior-findings/index.ts";
import type { Substrate } from "../substrate/types.ts";
import { loadArchitectureDocs } from "./architecture-docs.ts";
import {
  buildGlossaryContext,
  buildGlossaryLensReport,
  findGlossaryViolations,
  parseGlossary,
} from "./glossary.ts";
import {
  decideVerdict,
  extractInlineComments,
  persistVerdict,
  renderVerdict,
  type Verdict,
  type VerdictBlockMeta,
  verdictFilePath,
  verdictToEvent,
  addedLinesByPath,
  changedPathsInDiff,
  markPreviousRoundSurface,
  markRepeatedFindings,
} from "../verdict/index.ts";
import { LENSES, lensReviewScope, type LensModule } from "./registry.ts";
import { digestClaims } from "../util/claims.ts";
import {
  readConcurrencyEnv,
  runLenses,
} from "./scheduler.ts";
import type { ApplicabilityContext } from "./applicability.ts";
import type { LensReport } from "./types.ts";

export interface ReviewOptions {
  ref: PrRef;
  /**
   * Forge backend (GitHub, GitLab, etc.) that performs all
   * platform-specific I/O for this review. Resolved once per CLI
   * invocation or bus task by `selectForge` — the workflow itself
   * stays forge-agnostic so adding a third forge is a single new
   * backend file, not a workflow rewrite (sage#43 Phase 5).
   */
  forge: ForgeBackend;
  /**
   * Substrate that backs every lens for this review. Resolved once per
   * process at startup by the CLI / daemon (`selectSubstrate`) — Sage
   * deliberately does NOT support per-task substrate selection so verdicts
   * stay reproducible across operators. See issue #14 "Out of scope".
   */
  substrate: Substrate;
  /** Post the review back to the forge. Default: false (dry-run). */
  post?: boolean;
  /** Per-lens substrate timeout. Falls back to substrate-specific default. */
  timeoutMs?: number;
  /**
   * Max concurrent lens executions. Undefined preserves the historical
   * fully-parallel behavior; set via CLI flag or SAGE_LENS_CONCURRENCY.
   */
  lensConcurrency?: number;
  /**
   * Prior Findings Module — fetches Sage-authored findings from earlier
   * Reviews on the same PR (CONTEXT.md). When omitted, defaults from
   * `opts.forge.reviewSource()`.
   */
  priorFindings?: PriorFindings;
  /**
   * Fired when `priorFindings.collect()` returns a non-`ok` status.
   * Used by `sage dispatch` to surface the degradation on a Lifecycle
   * envelope payload (sage#56).
   */
  onPriorFindingsDegraded?: (status: PriorFindingsStatus, reason: string) => void | Promise<void>;
  /** Progress callback fired after each lens completes — envelope emission. */
  onLensComplete?: (report: LensReport) => void | Promise<void>;
}

export interface ReviewResult {
  verdict: Verdict;
  /**
   * True only when `opts.post` was set AND `postReview` actually returned
   * without throwing (sage#16).
   */
  posted: boolean;
  postedEvent?: ReviewEvent;
  downgraded?: boolean;
  /** Post-step failure detail (set only when `opts.post && !posted`). */
  postError?: PostError;
  /**
   * Absolute path to the on-disk verdict file (`.md` form, ready for
   * `gh pr review --body-file`). Set when `persistVerdict` succeeded.
   */
  recoveryPath?: string;
  /**
   * Metadata for the cortex structured verdict block (sage#83). `commit_id`
   * is the PR head SHA; the GitHub review id/url + `submitted_at` are
   * link-less defaults in Tier 1 (id 0, url ""). The CLI emits the block only
   * under `--emit-verdict-block`.
   */
  blockMeta: VerdictBlockMeta;
}

export interface PostError {
  message: string;
}

const POST_ERROR_MAX_LEN = 500;

/** Re-export for back-compat with existing CLI callers (sage#59). */
export { parseConcurrencyValue, readConcurrencyEnv } from "./scheduler.ts";

/**
 * Strip control bytes + ANSI escapes — gh stderr can include color
 * codes / attacker-shaped content reflected from a remote repo name.
 * Sanitized before the message rides the NATS bus or hits the
 * operator's terminal.
 */
function sanitizeErrorMessage(raw: string): string {
  // ORDER MATTERS: CSI pattern must come BEFORE the control-byte
  // class so `\x1b[31m` matches as a unit, not as `\x1b` + `[31m`.
  // eslint-disable-next-line no-control-regex
  return raw.replace(/\x1b\[[0-9;]*[A-Za-z]|[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

export async function reviewPr(opts: ReviewOptions): Promise<ReviewResult> {
  const priorFindingsModule: PriorFindings =
    opts.priorFindings ?? createPriorFindings(opts.forge.reviewSource());

  const [pr, diff, priorResult] = await Promise.all([
    opts.forge.prView(opts.ref),
    opts.forge.prDiff(opts.ref),
    priorFindingsModule.collect(opts.ref),
  ]);
  // sage#107 — what changed since Sage last reviewed this PR. Fetched once and
  // used twice: as the review target for `delta`-scoped Lenses, and as the
  // previous-round surface marking below. Round 1 (no prior review) and any
  // Forge that cannot compare two commits both land on `diff` undefined, which
  // is the pre-#107 behavior in full.
  const priorRound = await fetchPriorRoundDiff(
    opts.forge,
    opts.ref,
    pr.headRefOid,
    priorResult.latestReviewCommitId,
  );

  // Two contexts, deliberately separated. Applicability asks "does this Lens
  // have anything to say about the NEW work?" — so it reads the delta when
  // there is one, and a Lens whose triggers left the diff stops firing instead
  // of re-running on settled code every round. `cumulativeCtx` is what
  // `cumulative`-scoped Lenses actually review.
  // `reviewCount` is 0 on a degraded prior-findings lookup as well as on a
  // genuine first round; both mean "we cannot say Sage has been here", and
  // firing the body-driven predicates is the safe answer to that.
  const isFirstRound = priorResult.reviewCount === 0;
  // Undefined when no prior Review recorded a claims digest — unknown, not
  // unchanged, so the claims-checking lens looks.
  const claimsChanged =
    priorResult.latestCheckedClaimsDigest === undefined
      ? undefined
      : digestClaims(pr.body) !== priorResult.latestCheckedClaimsDigest;
  const claimsCtx = claimsChanged === undefined ? {} : { claimsChanged };
  const cumulativeCtx: ApplicabilityContext = { pr, diff, isFirstRound, ...claimsCtx };
  const applicabilityCtx: ApplicabilityContext =
    priorRound.diff !== undefined
      ? {
          pr: narrowToDelta(pr, priorRound.diff),
          diff: priorRound.diff,
          isFirstRound,
          ...claimsCtx,
        }
      : cumulativeCtx;
  const applicableLenses = LENSES.filter(
    (lens) => !lens.applies || lens.applies(applicabilityCtx),
  );
  logReviewScope(applicableLenses, diff, priorRound);
  // compass#98 F7: load unconditionally. Previously gated on
  // `applicableLenses.some(usesArchitectureDocs)` — the always-on
  // CodeQuality lens needs CONTEXT.md for the diff-aware glossary
  // excerpt below even when no Architecture/ContextDrift lens applies.
  const architectureDocs = await loadArchitectureDocs({
    forge: opts.forge,
    ref: opts.ref,
    baseRefName: pr.baseRefName,
  });

  // compass#98 F7: parse the glossary once per review (deterministic,
  // no model call) so every lens gets a diff-relevant excerpt on stdin
  // and exact `_Avoid_`-alias hits on added lines become findings
  // regardless of which lenses are applicable to this PR.
  const contextMdDoc = architectureDocs.docs.find((d) => d.path === "CONTEXT.md");
  const glossaryEntries =
    contextMdDoc?.status === "loaded" ? parseGlossary(contextMdDoc.content) : [];
  const glossaryContext = buildGlossaryContext(glossaryEntries, diff);
  const glossaryFindings = findGlossaryViolations(glossaryEntries, diff);

  if (priorResult.status !== "ok") {
    const reason = priorResult.reason ?? "";
    console.error(
      `[workflow] prior Sage findings degraded (${priorResult.status}); continuing without iteration context: ${reason}`,
    );
    try {
      await opts.onPriorFindingsDegraded?.(priorResult.status, reason);
    } catch (cbErr) {
      const m = cbErr instanceof Error ? cbErr.message : String(cbErr);
      console.error(`[workflow] onPriorFindingsDegraded failed: ${m}`);
    }
  }

  const concurrency =
    opts.lensConcurrency ?? readConcurrencyEnv("SAGE_LENS_CONCURRENCY");

  const lensReports = await runLenses({
    lenses: applicableLenses,
    ctx: cumulativeCtx,
    ...(priorRound.diff !== undefined ? { deltaDiff: priorRound.diff } : {}),
    lensesAreApplicable: true,
    substrate: opts.substrate,
    priorFindings: priorResult.findings,
    ...(architectureDocs !== undefined ? { architectureDocs } : {}),
    ...(glossaryContext.hasEntries ? { glossaryContext } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(concurrency !== undefined ? { concurrency } : {}),
    ...(opts.onLensComplete !== undefined ? { onLensComplete: opts.onLensComplete } : {}),
  });

  // compass#98 F7: fold the deterministic glossary findings in as their
  // own code-synthesized LensReport (not model-authored) so they feed
  // `decideVerdict`'s severity gate exactly like any other lens's
  // findings, regardless of which model-backed lenses ran. Omitted
  // entirely when there are zero hits, so a PR with no violations (the
  // overwhelming majority) gets a byte-identical LensReport[] to
  // pre-F7 behavior.
  const allLensReports =
    glossaryFindings.length > 0
      ? [...lensReports, buildGlossaryLensReport(glossaryFindings)]
      : lensReports;
  if (glossaryFindings.length > 0) {
    const glossaryReport = allLensReports[allLensReports.length - 1]!;
    try {
      await opts.onLensComplete?.(glossaryReport);
    } catch (cbErr) {
      const m = cbErr instanceof Error ? cbErr.message : String(cbErr);
      console.error(`[workflow] onLensComplete (Glossary) failed: ${m}`);
    }
  }

  // Order matters only for readability — the two marks are independent and
  // both additive. Repeat detection runs against the Prior Findings already
  // fetched for the lens prompts, so it costs no extra Forge call.
  const enrichedLensReports = markRepeatedFindings(
    applyPriorRoundSurface(allLensReports, priorRound),
    priorResult.findings,
  );
  const decided = decideVerdict(enrichedLensReports);
  // Recorded only when a claims-checking lens actually produced a report. A
  // digest written for a round whose Oracle crashed would assert that claims
  // nobody read have been checked, and the next round would skip them.
  const checkedClaims = claimsWereChecked(applicableLenses, enrichedLensReports)
    ? digestClaims(pr.body)
    : undefined;
  const verdict: Verdict =
    checkedClaims !== undefined
      ? { ...decided, checkedClaimsDigest: checkedClaims }
      : decided;
  const body = renderVerdict(verdict, opts.substrate.displayName, pr.headRefOid);

  // Persist BEFORE post: a failed post leaves the verdict on disk
  // for manual re-post via `gh pr review --body-file` (sage#16).
  const persisted = persistVerdict(opts.ref, verdict, body);
  const recoveryPath = persisted ? verdictFilePath(opts.ref, "md") : undefined;

  // compass#99 F15: line-anchored findings (real diff line, non-errored
  // lens) become inline PR comments alongside the top-level review body.
  // Computed unconditionally (cheap, pure) so `blockMeta.inline_comments`
  // below can report the honest count regardless of `opts.post`.
  const inlineComments = extractInlineComments(verdict);

  const { posted, postedEvent, downgraded, postError } = opts.post
    ? await attemptPost(opts.forge, opts.ref, verdict, body, inlineComments)
    : { posted: false };

  // Tier 1: link-less defaults (contract-valid integer 0 / string ""). The
  // real GitHub review id + url are a Tier-2 follow-up (forge-backend
  // extension); `commit_id` is the PR head SHA so cortex's merge-freshness
  // check has a real anchor today.
  //
  // `inline_comments` (compass#99 F15): the REAL count of inline comments
  // sage attempted to post — `inlineComments.length` when the post
  // succeeded, `0` when nothing was posted (post skipped, or the post
  // attempt failed and `postError` is set). Previously hardcoded to `0`
  // regardless of outcome; now means the same thing as the skill path's
  // count (drift-5).
  const blockMeta: VerdictBlockMeta = {
    github_review_id: 0,
    github_review_url: "",
    submitted_at: new Date().toISOString(),
    commit_id: pr.headRefOid,
    inline_comments: posted ? inlineComments.length : 0,
  };

  return {
    verdict,
    posted,
    blockMeta,
    ...(recoveryPath !== undefined ? { recoveryPath } : {}),
    ...(postedEvent !== undefined ? { postedEvent } : {}),
    ...(downgraded !== undefined ? { downgraded } : {}),
    ...(postError !== undefined ? { postError } : {}),
  };
}

/**
 * The comparison between Sage's previous review of this PR and the current
 * head.
 *
 * `diff: undefined, unavailable: false` is the ordinary "there is no previous
 * round" case — round 1, or a Forge with no `diffBetween`. `unavailable: true`
 * means there WAS a previous round and the comparison could not be fetched,
 * which is a coverage gap the Verdict has to disclose rather than silently
 * treat as "nothing changed".
 */
interface PriorRoundDiff {
  diff?: string;
  unavailable: boolean;
}

async function fetchPriorRoundDiff(
  forge: ForgeBackend,
  ref: PrRef,
  headCommit: string,
  priorReviewCommit: string | undefined,
): Promise<PriorRoundDiff> {
  if (!priorReviewCommit || !headCommit || !forge.diffBetween) {
    return { unavailable: false };
  }
  try {
    return {
      diff: await forge.diffBetween(ref, priorReviewCommit, headCommit),
      unavailable: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[workflow] prior-round comparison unavailable; every lens reviews the cumulative diff and coverage is marked incomplete: ${message}`,
    );
    return { unavailable: true };
  }
}

function applyPriorRoundSurface(
  lenses: LensReport[],
  priorRound: PriorRoundDiff,
): LensReport[] {
  if (priorRound.unavailable) {
    return lenses.map((lens) => ({ ...lens, previousRoundSurfaceUnavailable: true as const }));
  }
  if (priorRound.diff === undefined) return lenses;
  return markPreviousRoundSurface(lenses, addedLinesByPath(priorRound.diff));
}

/**
 * Whether a Lens whose subject is the PR's claims ran and returned a usable
 * report this Review. Registry-driven rather than matching a lens name, so the
 * knowledge of WHICH lens checks claims stays in one place.
 */
function claimsWereChecked(
  applicable: readonly LensModule[],
  reports: readonly LensReport[],
): boolean {
  const names = new Set(
    applicable.filter((lens) => lens.checksClaims).map((lens) => lens.name),
  );
  if (names.size === 0) return false;
  return reports.some((report) => names.has(report.lens) && !report.errored);
}

/**
 * The PR as applicability should see it for a delta round: same metadata, but
 * only the files this round actually touched.
 *
 * Applicability reads `pr.files` more than it scans the diff body, so without
 * this a PR that ever touched `src/auth.ts` wakes the Security lens on every
 * later round regardless of what that round changed. Per-file addition and
 * deletion counts stay cumulative — they over-report rather than under-report,
 * and the lenses that read them review the cumulative diff anyway.
 *
 * Scoped to applicability ONLY. Lenses still receive the real `pr`, because a
 * Lens reporting "2 changed files" on a 40-file PR would be lying.
 */
function narrowToDelta(pr: PrMetadata, deltaDiff: string): PrMetadata {
  const touched = changedPathsInDiff(deltaDiff);
  const files = pr.files.filter((f) => touched.has(f.path));
  return { ...pr, files, changedFiles: files.length };
}

/**
 * One line saying how much of the change each Lens is about to read. The whole
 * point of delta scoping is that a round-12 review costs a fraction of a
 * round-1 review, and a saving nobody can see is a saving nobody can check.
 */
function logReviewScope(
  applicable: readonly LensModule[],
  cumulativeDiff: string,
  priorRound: PriorRoundDiff,
): void {
  if (priorRound.diff === undefined) {
    console.error(
      `[workflow] scope: no prior Sage review to compare against; ${applicable.length} lens(es) read the cumulative diff (${cumulativeDiff.length} bytes)`,
    );
    return;
  }
  const delta = applicable.filter((l) => lensReviewScope(l) === "delta");
  console.error(
    `[workflow] scope: ${delta.length}/${applicable.length} lens(es) read the ${priorRound.diff.length}-byte prior-round delta; ` +
      `${applicable.length - delta.length} read the ${cumulativeDiff.length}-byte cumulative diff`,
  );
}

interface AttemptPostResult {
  posted: boolean;
  postedEvent?: ReviewEvent;
  downgraded?: boolean;
  postError?: PostError;
}

/**
 * Attempt the Forge post step. Pure helper extracted from `reviewPr`
 * so the data flow is explicit (return value, not outer-scope
 * mutations) and `reviewPr` stays scannable. Never re-throws —
 * pre-sage#16, a `postReview` throw escaped and conflated a post
 * failure with a lens failure.
 */
async function attemptPost(
  forge: ForgeBackend,
  ref: PrRef,
  verdict: Verdict,
  body: string,
  comments: InlineComment[],
): Promise<AttemptPostResult> {
  const target = `${ref.owner}/${ref.repo}#${ref.number}`;
  // eslint-disable-next-line no-console
  console.error(
    `[workflow] post: attempting ${target} (decision=${verdict.decision}, inline_comments=${comments.length})`,
  );

  try {
    const result = await forge.postReview({
      ref,
      event: verdictToEvent(verdict.decision),
      body,
      ...(comments.length > 0 ? { comments } : {}),
    });
    // eslint-disable-next-line no-console
    console.error(
      `[workflow] post: ok ${target} (event=${result.posted}, downgraded=${result.downgraded})`,
    );
    return {
      posted: true,
      postedEvent: result.posted,
      downgraded: result.downgraded,
    };
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    // Sanitize BEFORE truncate so control bytes / ANSI escapes can't
    // partially-survive past the slice boundary.
    const sanitized = sanitizeErrorMessage(rawMessage);
    const message =
      sanitized.length > POST_ERROR_MAX_LEN
        ? `${sanitized.slice(0, POST_ERROR_MAX_LEN)} […truncated ${sanitized.length - POST_ERROR_MAX_LEN} chars]`
        : sanitized;
    // eslint-disable-next-line no-console
    console.error(`[workflow] post: failed ${target}: ${message}`);
    return { posted: false, postError: { message } };
  }
}
