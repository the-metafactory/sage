import { createHash } from "node:crypto";

/**
 * The claims surface Sage checks, and the marker that records which version of
 * it has been checked (sage#107).
 *
 * The HonestOracle lens fires on a non-trivial PR description. Unlike every
 * other trigger, that input is in no diff, so it cannot settle the way a
 * diff-driven trigger does once its subject stops changing — and it grows on
 * exactly the rounds where it should quiet down, because answering a reviewer
 * makes a description longer. Left alone it is a full-diff model call on every
 * round for the life of the PR.
 *
 * Gating it on "first round" would be the cheap fix and the wrong one: claims
 * introduced DURING a review loop are the ones an author is least able to catch
 * alone, so a round-1-only Oracle would miss precisely the overclaims the loop
 * itself generates. What the trigger actually wants is "are there NEW claims?",
 * which needs the previously-checked description to compare against.
 *
 * This module owns that comparison. It is a leaf — no forge, no verdict, no
 * lens imports — so the renderer (Verdict Module) and the review-body parser
 * (Forge Module) can share one marker format without either depending on the
 * other.
 */

/** Marker length. Collision risk over one PR's rounds is not a concern here. */
const DIGEST_LENGTH = 16;
/** Per-claim digest length: a description has tens of claims, not thousands. */
const CLAIM_DIGEST_LENGTH = 8;

const MARKER_PREFIX = "<!-- sage:checked-claims:";
const MARKER_SUFFIX = " -->";

// Claims and commit are optional so a marker written before sage#139 still
// parses: it then says WHAT was checked, but not which claims or where.
const MARKER_RE =
  /<!-- sage:checked-claims:([0-9a-f]{16})(?: claims:([0-9a-f,]*))?(?: commit:([0-9A-Za-z._-]{1,64}))? -->/g;

/** What a prior Oracle run checked, read back off its Review comment. */
export interface CheckedClaims {
  /** {@link digestClaims} of the whole description. */
  readonly digest: string;
  /** {@link digestClaim} of each claim in it. Absent on a pre-sage#139 marker. */
  readonly claims?: readonly string[];
  /** The PR head the Oracle read. Absent on a pre-sage#139 marker. */
  readonly commitId?: string;
}

/**
 * The part of a PR the Oracle has not checked yet (sage#139).
 *
 * Present only when an earlier Oracle run recorded where it left off and the
 * Forge could compare that commit to the head. The Oracle still reads the
 * cumulative diff, as evidence, but only these claims are its target.
 */
export interface ClaimsScope {
  /** The commit the previous Oracle run read. */
  readonly sinceCommit: string;
  /**
   * Changes since then: new claims in docs and comments, and changed code an
   * earlier claim may cite. The Oracle sees that code only on a round it runs;
   * a code-only change does not make it run.
   */
  readonly diff: string;
  /** Description claims new or edited since then, in description order. */
  readonly descriptionClaims: readonly string[];
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Digest of the claims surface — today, the PR description.
 *
 * Whitespace-normalized so reflowing a paragraph does not read as a new claim.
 * Case is preserved: "MUST" and "must" are not the same claim.
 */
export function digestClaims(prBody: string): string {
  return createHash("sha256").update(normalize(prBody)).digest("hex").slice(0, DIGEST_LENGTH);
}

const CLAIM_LINE_START_RE = /^\s*(?:[-*+]\s|\d+[.)]\s|\||#)/;

/**
 * The description split into claims: paragraphs, with each list item, table
 * row and heading its own claim. Editing one bullet then re-checks that bullet,
 * not the whole list. Whitespace-normalized like {@link digestClaims}.
 */
export function splitClaims(prBody: string): string[] {
  const claims: string[] = [];
  for (const block of prBody.split(/\n\s*\n/)) {
    let current: string[] = [];
    const flush = () => {
      const claim = normalize(current.join(" "));
      if (claim) claims.push(claim);
      current = [];
    };
    for (const line of block.split("\n")) {
      if (CLAIM_LINE_START_RE.test(line)) flush();
      current.push(line);
    }
    flush();
  }
  return claims;
}

export function digestClaim(claim: string): string {
  return createHash("sha256").update(normalize(claim)).digest("hex").slice(0, CLAIM_DIGEST_LENGTH);
}

/** What the Oracle checks this round, recorded for the next one. */
export function checkedClaimsOf(prBody: string, commitId: string): CheckedClaims {
  return {
    digest: digestClaims(prBody),
    claims: [...new Set(splitClaims(prBody).map(digestClaim))],
    commitId,
  };
}

/** Description claims whose digest no earlier Oracle run recorded. */
export function uncheckedClaims(prBody: string, checked: readonly string[]): string[] {
  const seen = new Set(checked);
  return splitClaims(prBody).filter((claim) => !seen.has(digestClaim(claim)));
}

/**
 * The hidden marker appended to a rendered Review body, recording the claims
 * the Oracle actually checked this round, and at which commit.
 *
 * Written ONLY when the Oracle ran and produced a usable report. A digest
 * recorded for a round where the lens crashed would assert "these claims have
 * been checked" about claims nobody read.
 */
export function renderCheckedClaimsMarker(checked: CheckedClaims): string {
  const claims = checked.claims ? ` claims:${checked.claims.join(",")}` : "";
  const commit = checked.commitId ? ` commit:${checked.commitId}` : "";
  return `${MARKER_PREFIX}${checked.digest}${claims}${commit}${MARKER_SUFFIX}`;
}

/** The footer line Sage's renderer writes last, ahead of its hidden markers. */
const FOOTER_RE = /\n---\n_Posted by Sage\b/g;

/**
 * Read the marker back off a prior Sage Review comment.
 *
 * Only a marker after the footer counts: Sage writes its own there, and a
 * Finding that quotes PR text may echo a planted one above it. Since sage#139
 * the marker decides which claims the Oracle may skip, so a planted marker
 * would let a PR author mark claims checked — including on a round whose
 * Oracle did not run and wrote no marker of its own.
 */
export function parseCheckedClaimsMarker(body: string): CheckedClaims | undefined {
  const footer = [...body.matchAll(FOOTER_RE)].at(-1);
  if (footer?.index === undefined) return undefined;
  const match = [...body.slice(footer.index).matchAll(MARKER_RE)].at(-1);
  if (!match) return undefined;
  const [, digest, claims, commitId] = match;
  return {
    digest: digest!,
    ...(claims !== undefined ? { claims: claims ? claims.split(",") : [] } : {}),
    ...(commitId !== undefined ? { commitId } : {}),
  };
}
