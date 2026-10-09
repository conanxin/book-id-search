#!/usr/bin/env bash
set -euo pipefail

# Only in an isolated GitHub Actions runner. Never update origin or merge
# any of the PRs through the GitHub API.
if [[ "${R6_LOCAL_ONLY:-}" != "YES" ]]; then
  echo "R6_LOCAL_ONLY_REQUIRED"
  exit 2
fi
expected_main="42cf1b7b4a10a6edfa53d688012728dded0b3049"
expected_tree="79997ca5b811d2110b6fef334b1bc133c632ca4a"
r5_snapshot="15416cdafd376cdcf6c7f31eb2156f0c9f78d831"

refs=(
  "feat/s32-m3a-gate4-dossier"
  "test/s32-m3a-r4-auth-run404"
  "feat/s32-p1a-book-detail-research-entry"
  "feat/s32-p1b-citation-precision-v01"
  "test/s32-candidate-claims-canonical-refresh-reliability"
)
numbers=(58 66 61 62 64)
expected_heads=(
  "32ba986d45dcfcc14cb2440363abdd46bfe37551"
  "ff92403b50f35089111ba0b3496973a05997bc8d"
  "7e0c3476736b11153953698858cf5e37b6e2b515"
  "8995e43a710ca21e4fff5c134d51fa4a802d2dc2"
  "055696468bd14996c26ebd420083228bb9a8573d"
)
refspecs=("+refs/heads/main:refs/remotes/origin/main")
for ref in "${refs[@]}"; do
  refspecs+=("+refs/heads/${ref}:refs/remotes/origin/${ref}")
done
refspecs+=("+refs/heads/research/s32-r5-combined-review:refs/remotes/origin/research/s32-r5-combined-review")

# Fetch exact live branch refs and freeze their identity BEFORE any local merge.
git fetch --no-tags origin "${refspecs[@]}"
actual_main="$(git rev-parse refs/remotes/origin/main)"
if [[ "$actual_main" != "$expected_main" ]]; then
  echo "R6_ABORT_MAIN_CHANGED expected=$expected_main actual=$actual_main"
  exit 3
fi
for i in "${!refs[@]}"; do
  actual="$(git rev-parse "refs/remotes/origin/${refs[$i]}")"
  if [[ "$actual" != "${expected_heads[$i]}" ]]; then
    echo "R6_ABORT_SOURCE_CHANGED PR=${numbers[$i]} expected=${expected_heads[$i]} actual=$actual"
    exit 4
  fi
done

# Explicitly establish that the expected stacked ancestry is still intact.
git merge-base --is-ancestor "$expected_main" "${expected_heads[0]}"
for i in 1 2 3; do git merge-base --is-ancestor "${expected_heads[0]}" "${expected_heads[$i]}"; done
git merge-base --is-ancestor "$expected_main" "${expected_heads[4]}"

git switch --detach "$expected_main"
git switch -c r6-git-merge-runner-only
git config user.name "R6 Git Merge Rehearsal"
git config user.email "r6-rehearsal@users.noreply.github.com"
git config commit.gpgsign false

for i in "${!refs[@]}"; do
  before="$(git rev-parse HEAD)"
  echo "R6_MERGING_PR=${numbers[$i]} FROM=${expected_heads[$i]}"
  # Real git merge with a local two-parent merge commit, not a tree overlay.
  if ! git merge --no-ff --no-edit "${expected_heads[$i]}"; then
    echo "R6_MERGE_CONFLICT_PR=${numbers[$i]}"
    git diff --name-only --diff-filter=U
    exit 5
  fi
  read -r first second <<< "$(git show -s --format=%P HEAD)"
  if [[ "$first" != "$before" || "$second" != "${expected_heads[$i]}" ]]; then
    echo "R6_MERGE_PARENTS_UNEXPECTED_PR=${numbers[$i]}"
    exit 6
  fi
  echo "R6_REAL_MERGE_PR_${numbers[$i]}=PASS"
done

final_tree="$(git rev-parse HEAD^{tree})"
r5_tree="$(git rev-parse "${r5_snapshot}^{tree}")"
echo "R6_REAL_MERGE_TREE=$final_tree"
echo "R5_COMPOSED_TREE=$r5_tree"
if [[ "$final_tree" != "$expected_tree" || "$r5_tree" != "$expected_tree" ]]; then
  echo "R6_COMPOSED_TREE_MISMATCH"
  git diff --stat "$r5_snapshot" HEAD || true
  git diff --name-status "$r5_snapshot" HEAD || true
  exit 7
fi
git diff --check "$expected_main"...HEAD
echo "R6_REAL_GIT_MERGES=5_PASS"
echo "R6_TREE_EQ_R5_COMPOSED=PASS"
echo "R6_NO_REMOTE_PUSH=YES"
