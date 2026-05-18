#!/usr/bin/env bash
# Mock `glab` subprocess for integration tests. Implements the minimum
# subset of `glab api` calls sage's GitLabBackend exercises against a
# single PR (project=42, iid=7).
#
# Invocation pattern:
#   glab api --hostname <host> [--paginate] <path> [-X POST] [-F body=@file]
#
# The script pattern-matches on path + verb and emits canned JSON to
# stdout. Exit 0 unless the test sets MOCK_GLAB_FAIL=1.

if [[ "$MOCK_GLAB_FAIL" == "1" ]]; then
  echo "mocked glab failure" >&2
  exit 1
fi

# Fixture project + MR — exported as one constant so changing the test
# fixture only needs editing one line (sage review on #48, Maintainability).
MR_PATH="/projects/group%2Fproj/merge_requests/7"

case "$1" in
  auth)
    # `glab auth status --hostname H` — used by GitLabBackend.authStatus().
    echo "✓ Logged in to gitlab.com as sage-bot"
    exit 0
    ;;
  api)
    shift
    # Walk past --hostname H and optional --paginate.
    while [[ "$1" == "--hostname" || "$1" == "--paginate" ]]; do
      case "$1" in
        --hostname) shift 2 ;;
        --paginate) shift ;;
      esac
    done
    method="GET"
    path=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        -X) method="$2"; shift 2 ;;
        -F) shift 2 ;;  # form fields ignored — postNote isn't asserted on body
        *) path="$1"; shift ;;
      esac
    done

    if [[ "$method" == "GET" && "$path" == "$MR_PATH" ]]; then
      cat <<'JSON'
{
  "iid": 7,
  "title": "feat: add cool thing",
  "description": "PR body here",
  "state": "opened",
  "draft": false,
  "merged_at": null,
  "sha": "abc123",
  "source_branch": "feat/cool",
  "diff_refs": {"base_sha": "base", "head_sha": "head", "start_sha": "start"},
  "target_branch": "main",
  "web_url": "https://gitlab.com/group/proj/-/merge_requests/7",
  "author": {"username": "alice"}
}
JSON
      exit 0
    fi

    if [[ "$method" == "GET" && "$path" == "$MR_PATH/changes" ]]; then
      cat <<'JSON'
{
  "changes": [
    {"old_path": "src/a.ts", "new_path": "src/a.ts", "diff": "@@ -1 +1 @@\n-old\n+new\n"}
  ]
}
JSON
      exit 0
    fi

    if [[ "$method" == "POST" && "$path" == "$MR_PATH/notes" ]]; then
      echo '{"id": 999, "body": "posted"}'
      exit 0
    fi

    if [[ "$method" == "POST" && "$path" == "$MR_PATH/approve" ]]; then
      echo '{"approved": true}'
      exit 0
    fi

    echo "mock glab: unhandled $method $path" >&2
    exit 2
    ;;
  *)
    echo "mock glab: unhandled command $*" >&2
    exit 2
    ;;
esac
