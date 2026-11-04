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

# reports/: only these report packs are free and may ship. Every other pack under reports/ in rs-reports
# (paid orders) is stripped by git filter-repo before the pull. The filter is deterministic, so the
# filtered commits keep the same ids as the ones already in this monorepo's (purged) history.
FREE_REPORTS=(near-users-vs-bots)

filtered_reports_src() {  # $1 = rs-reports path; prints the path of a filtered clone
  command -v git-filter-repo >/dev/null || { echo "!! git-filter-repo is required (brew install git-filter-repo)" >&2; return 1; }
  local tmp; tmp=$(mktemp -d "${TMPDIR:-/tmp}/nearbi-reports.XXXXXX")
  git clone -q --no-local --single-branch --branch main "$1" "$tmp/rs-reports" >&2
  local args=() pack
  while read -r pack; do
    [ -z "$pack" ] && continue
    printf '%s\n' "${FREE_REPORTS[@]}" | grep -qxF "$pack" || args+=(--path "reports/$pack/")
  done < <(git -C "$tmp/rs-reports" log --format= --name-only main -- reports/ | awk -F/ 'NF>2{print $2}' | sort -u)
  if [ ${#args[@]} -gt 0 ]; then
    git -C "$tmp/rs-reports" filter-repo --force --quiet --invert-paths "${args[@]}" >&2
    echo "   reports: stripped non-free packs: ${args[*]}" | sed 's/--path //g' >&2
  fi
  echo "$tmp/rs-reports"
}

# app/: paid order deliverables once sat in nearbi-app's src/catalog.ts (title = the buyer's question, summary =
# the answer). The monorepo's history was purged of them with git filter-repo --replace-text using
# tooling/purge/app-replace-text.txt; nearbi-app goes through the same deterministic pass before the pull, so
# the filtered commits keep the ids already in this monorepo and the paid text cannot come back.
APP_REPLACE_TEXT="$ROOT/tooling/purge/app-replace-text.txt"

filtered_app_src() {  # $1 = nearbi-app path; prints the path of a filtered clone
  command -v git-filter-repo >/dev/null || { echo "!! git-filter-repo is required (brew install git-filter-repo)" >&2; return 1; }
  local tmp; tmp=$(mktemp -d "${TMPDIR:-/tmp}/nearbi-app.XXXXXX")
  git clone -q --no-local --single-branch --branch main "$1" "$tmp/nearbi-app" >&2
  git -C "$tmp/nearbi-app" filter-repo --force --quiet --replace-text "$APP_REPLACE_TEXT" >&2
  echo "   app: applied $(basename "$APP_REPLACE_TEXT")" >&2
  echo "$tmp/nearbi-app"
}

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
  if [ "$prefix" = reports ]; then
    src=$(filtered_reports_src "$src") || { fail=1; continue; }
  elif [ "$prefix" = app ]; then
    src=$(filtered_app_src "$src") || { fail=1; continue; }
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
  case "$src" in "${TMPDIR:-/tmp}"/nearbi-reports.*|"${TMPDIR:-/tmp}"/nearbi-app.*) rm -rf "$(dirname "$src")" ;; esac
done

# Paid / buyer report packs must never ship: refuse to leave one in reports/.
paid=$(git ls-files reports/reports | awk -F/ '{print $3}' | sort -u | grep -vxF -f <(printf '%s\n' "${FREE_REPORTS[@]}") || true)
if [ -n "$paid" ]; then
  echo "!! reports/ now contains report packs that are not on the free allowlist:" >&2
  echo "$paid" | sed 's/^/   /' >&2
  echo "   Remove them (and purge from history) before pushing." >&2
  fail=1
fi

# Paid deliverable text must never ship in app/ either (it lives in DynamoDB on the order, not in source).
if git grep -qE 'slug: "near-oct-cohort-retention"' -- app/; then
  echo "!! app/ contains a paid order deliverable entry; purge it (tooling/purge/app-replace-text.txt) before pushing." >&2
  fail=1
fi

exit $fail
