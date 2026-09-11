#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

baseline_commit="e1a8788ab796f4d001c5d1e9851c418989b05424"
baseline_tag="v1.12.11"
variant="lightweight-plugin-lockdown-local-tools"
revision="3"
output_dir="$repo_root/output-maintained"
source_html="$repo_root/apps/web/dist/index.html"
output_html="$output_dir/management.html"

fail() {
  printf 'maintained build failed: %s\n' "$*" >&2
  exit 1
}

command -v git >/dev/null || fail "git is required"
command -v bun >/dev/null || fail "bun is required"
command -v sha256sum >/dev/null || fail "sha256sum is required"
command -v python3 >/dev/null || fail "python3 is required"

git cat-file -e "${baseline_commit}^{commit}" 2>/dev/null || fail "baseline commit is unavailable"
resolved_tag="$(git rev-list -n 1 "$baseline_tag" 2>/dev/null || true)"
[[ "$resolved_tag" == "$baseline_commit" ]] || fail "baseline tag does not resolve to the pinned commit"
head_commit="$(git rev-parse HEAD)"
merge_base="$(git merge-base HEAD "$baseline_commit" 2>/dev/null || true)"
[[ "$merge_base" == "$baseline_commit" ]] || fail "HEAD is not based on the pinned upstream commit"
[[ -z "$(git status --porcelain --untracked-files=all)" ]] || fail "release source worktree is not clean"
mapfile -t ignored_env_files < <(
  git ls-files --others --ignored --exclude-standard -- \
    '.env*' 'apps/web/.env*' 'apps/docs/.env*'
)
[[ "${#ignored_env_files[@]}" -eq 0 ]] || fail "ignored environment input detected: ${ignored_env_files[*]}"
[[ -z "${VITE_DEFAULT_CPA_BASE_URL:-}" ]] || fail "VITE_DEFAULT_CPA_BASE_URL must be unset for release builds"
[[ -z "${VITE_DEMO_SITE:-}" ]] || fail "VITE_DEMO_SITE must be unset for release builds"
[[ -z "${DEMO_SITE:-}" ]] || fail "DEMO_SITE must be unset for release builds"
source_tag="$(git describe --tags --exact-match HEAD 2>/dev/null || true)"
if [[ -n "${RELEASE_TAG:-}" ]]; then
  [[ "$source_tag" == "$RELEASE_TAG" ]] || fail "HEAD tag does not match RELEASE_TAG"
fi
if [[ -n "${VERSION:-}" ]]; then
  if [[ -n "${RELEASE_TAG:-}" ]]; then
    [[ "$VERSION" == "$RELEASE_TAG" ]] || fail "VERSION does not match RELEASE_TAG"
  else
    fail "VERSION must be unset outside a tagged release build"
  fi
fi
build_version="${RELEASE_TAG:-${source_tag:-dev}}"

bun run type-check
bun run lint
bun run test
VERSION="$build_version" bun run build

[[ -s "$source_html" ]] || fail "single-file web build is missing"
mkdir -p "$output_dir"
rm -f "$output_html" "$output_dir/SHA256SUMS" "$output_dir/metadata.json"
cp "$source_html" "$output_html"

python3 - "$output_html" <<'PY'
from pathlib import Path
import re
import sys

artifact = Path(sys.argv[1])
data = artifact.read_bytes()
text = data.decode('utf-8', errors='ignore')

forbidden_markers = [
    'APIKEY' + '.FUN',
    'apikey' + '.fun',
    'APIKEY' + '_FUN',
    'apikey' + 'Fun',
    'aff=' + 'AKCPA',
]
for marker in forbidden_markers:
    if marker in text:
        raise SystemExit(f'forbidden marker found in production artifact: {marker}')

secret_patterns = {
    'private key block': rb'-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----',
    'AWS access key': rb'AKIA[0-9A-Z]{16}',
    'GitHub token': rb'gh[pousr]_[A-Za-z0-9]{30,}',
    'generic live secret': rb'(?i)(?:api[_-]?key|secret|token)["\'\s:=]{1,12}(?:sk-|rk-|pk_live_)[A-Za-z0-9_-]{16,}',
}
for label, pattern in secret_patterns.items():
    if re.search(pattern, data):
        raise SystemExit(f'typical credential pattern found in production artifact: {label}')
PY

artifact_sha="$(sha256sum "$output_html" | awk '{print $1}')"
artifact_size="$(wc -c < "$output_html" | tr -d ' ')"

BUILD_TIMESTAMP="$(date -u +'%Y-%m-%dT%H:%M:%SZ')" \
HEAD_COMMIT="$head_commit" \
SOURCE_TAG="$source_tag" \
BUILD_VERSION="$build_version" \
ARTIFACT_SHA="$artifact_sha" \
ARTIFACT_SIZE="$artifact_size" \
python3 - "$output_dir/metadata.json" <<'PY'
import json
import os
import sys
from pathlib import Path

metadata = {
    'variant': 'lightweight-plugin-lockdown-local-tools',
    'revision': 3,
    'upstream': {
        'repository': 'https://github.com/seakee/CPA-Manager-Plus.git',
        'tag': 'v1.12.11',
        'commit': 'e1a8788ab796f4d001c5d1e9851c418989b05424',
    },
    'sourceHead': os.environ['HEAD_COMMIT'],
    'sourceTag': os.environ.get('SOURCE_TAG') or None,
    'buildVersion': os.environ['BUILD_VERSION'],
    'dirtyWorktreeAllowed': False,
    'builtAt': os.environ['BUILD_TIMESTAMP'],
    'artifact': {
        'path': 'management.html',
        'sha256': os.environ['ARTIFACT_SHA'],
        'sizeBytes': int(os.environ['ARTIFACT_SIZE']),
    },
}
Path(sys.argv[1]).write_text(json.dumps(metadata, indent=2) + '\n')
PY

printf '%s\n' "$head_commit" > "$output_dir/SOURCE_COMMIT"
(
  cd "$output_dir"
  sha256sum management.html metadata.json SOURCE_COMMIT > SHA256SUMS
)

printf 'maintained artifact: %s\n' "$output_html"
printf 'sha256: %s\n' "$artifact_sha"
printf 'size: %s bytes\n' "$artifact_size"
