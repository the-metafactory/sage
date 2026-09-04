/**
 * Marker for the commit Sage reviewed.
 *
 * GitHub's non-Review records do not carry a `commit_id`, even when they are
 * Sage's normal fallback when it reviews its own PR. Keep this in a leaf
 * utility so the renderer and prior-findings parser can share the same forge-neutral
 * format without depending on each other.
 */

const MARKER_PREFIX = "<!-- sage:reviewed-commit:";
const MARKER_SUFFIX = " -->";
const COMMIT_ID_RE = /^[0-9a-f]{7,64}$/i;
const MARKER_RE = /<!-- sage:reviewed-commit:([0-9a-f]{7,64}) -->/i;

/** Render a marker only for a valid Git object identifier. */
export function renderReviewedCommitMarker(commitId: string): string | undefined {
  if (!COMMIT_ID_RE.test(commitId)) return undefined;
  return `${MARKER_PREFIX}${commitId}${MARKER_SUFFIX}`;
}

/** Read the reviewed commit marker from a prior rendered Sage Verdict. */
export function parseReviewedCommitMarker(body: string): string | undefined {
  return MARKER_RE.exec(body)?.[1];
}
