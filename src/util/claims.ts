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

const MARKER_PREFIX = "<!-- sage:checked-claims:";
const MARKER_SUFFIX = " -->";

const MARKER_RE = /<!-- sage:checked-claims:([0-9a-f]{16}) -->/;

/**
 * Digest of the claims surface — today, the PR description.
 *
 * Whitespace-normalized so reflowing a paragraph does not read as a new claim.
 * Case is preserved: "MUST" and "must" are not the same claim.
 */
export function digestClaims(prBody: string): string {
  const normalized = prBody.replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalized).digest("hex").slice(0, DIGEST_LENGTH);
}

/**
 * The hidden marker appended to a rendered Review body, recording the claims
 * digest the Oracle actually checked this round.
 *
 * Written ONLY when the Oracle ran and produced a usable report. A digest
 * recorded for a round where the lens crashed would assert "these claims have
 * been checked" about claims nobody read.
 */
export function renderCheckedClaimsMarker(digest: string): string {
  return `${MARKER_PREFIX}${digest}${MARKER_SUFFIX}`;
}

/** Read the marker back off a prior Sage review body. */
export function parseCheckedClaimsMarker(body: string): string | undefined {
  return MARKER_RE.exec(body)?.[1];
}
