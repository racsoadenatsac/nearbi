#!/bin/bash
# Refresh the nearbi submission monorepo from its local source repos.
#
# Each top-level directory is a `git subtree` of one source repo (imported WITHOUT --squash, so the
# source history and commit dates are kept). This runs `git subtree pull` for every prefix from the
# source repo's default branch. Run it from anywhere inside the monorepo, on a clean working tree.
#
#   tooling/bin/sync-monorepo.sh            # pull every prefix
#   tooling/bin/sync-monorepo.sh docs app   # pull only these prefixes
#   SRC_ROOT=/path/to/repos tooling/bin/sync-monorepo.sh
#
# SRC_ROOT defaults to the monorepo's parent directory (~/projects/research-shop).
# Excluded on purpose (never synced): rs-sales, rs-site, nearbi-site, research-shop.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
SRC_ROOT="${SRC_ROOT:-$(dirname "$ROOT")}"
cd "$ROOT"

# prefix:source-repo:branch
MAP=(
  app:nearbi-app:main
  infra:nearbi-infra:main
  contracts:rs-payments:main
  agent:rs-agent:main
  ledger:rs-ledger:main
  repro:rs-repro:main
  thesis:rs-thesis:main
  docs:rs-docs:main
  reports:rs-reports:main
  tooling:rs-tooling:main
)

if [ -n "$(git status --porcelain)" ]; then
  echo "sync-monorepo: working tree is not clean; commit or stash first" >&2
  exit 1
fi

want=("$@")
selected() {
  [ ${#want[@]} -eq 0 ] && return 0
  local w; for w in "${want[@]}"; do [ "$w" = "$1" ] && return 0; done
  return 1
}

fail=0
for entry in "${MAP[@]}"; do
  IFS=: read -r prefix repo branch <<<"$entry"
  selected "$prefix" || continue
  src="$SRC_ROOT/$repo"
  if [ ! -d "$src/.git" ]; then
    echo "!! $prefix: source repo $src not found" >&2; fail=1; continue
  fi
  before=$(git rev-parse HEAD)
  if out=$(git subtree pull --prefix="$prefix" "$src" "$branch" \
             -m "chore(monorepo): sync $prefix/ from $repo ($branch)" 2>&1); then
    if [ "$(git rev-parse HEAD)" = "$before" ]; then
      printf "== %-10s up to date (%s)\n" "$prefix" "$repo"
    else
      printf "++ %-10s updated from %s @ %s\n" "$prefix" "$repo" "$(git -C "$src" rev-parse --short "$branch")"
    fi
  else
    echo "!! $prefix: subtree pull from $repo failed:" >&2
    echo "$out" | sed 's/^/   /' >&2
    git merge --abort 2>/dev/null || true
    fail=1
  fi
done

# Paid / buyer report packs must never ship: refuse to leave one in reports/.
paid=$(git ls-files reports/reports | awk -F/ '{print $3}' | sort -u | grep -vxE 'near-users-vs-bots' || true)
if [ -n "$paid" ]; then
  echo "!! reports/ now contains report packs that are not on the free allowlist:" >&2
  echo "$paid" | sed 's/^/   /' >&2
  echo "   Remove them (and purge from history) before pushing." >&2
  fail=1
fi

exit $fail
