/**
 * The commit a Sage Review read, carried as a hidden marker in the rendered
 * body.
 *
 * A formal forge Review records its commit itself (`commit_id`). A Review a
 * supervisor posts as an ordinary PR comment does not: ranger runs `sage
 * review` offline and posts the body under its machine account. Without this
 * marker the next round cannot tell which commit Sage last read, so it can
 * neither scope lenses to the delta nor mark the previous-round surface.
 *
 * A leaf, like `claims.ts`: the renderer writes it and the review-body parser
 * reads it, and neither depends on the other.
 */

const MARKER_RE = /<!-- sage:reviewed-commit:([0-9a-f]{7,64}) -->/;

export function renderReviewedCommitMarker(sha: string): string {
  return `<!-- sage:reviewed-commit:${sha} -->`;
}

export function parseReviewedCommitMarker(body: string): string | undefined {
  return MARKER_RE.exec(body)?.[1];
}
