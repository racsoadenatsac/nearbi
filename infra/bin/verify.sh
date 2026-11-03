#!/bin/bash
# Smoke-check the deployed site through CloudFront. Prints status codes; exits non-zero on mismatch.
# Usage: bin/verify.sh [base-url]   (default: tofu output cloudfront_url)
set -uo pipefail
cd "$(dirname "$0")/.."
base="${1:-$(tofu -chdir=tofu output -raw cloudfront_url)}"
fail=0
check() { # name expected-regex path [extra curl args]
  local name="$1" want="$2" path="$3"; shift 3
  local out code
  out=$(curl -sS -o /tmp/nearbi-verify.body -w '%{http_code} %{redirect_url}' "$@" "$base$path")
  code=${out%% *}
  if [[ "$code" =~ ^($want)$ ]]; then echo "PASS $code $name $path ${out#* }"; else echo "FAIL $code $name $path ${out#* } (want $want)"; fail=1; fi
}
check landing        200     /
grep -qi "<html" /tmp/nearbi-verify.body && echo "     landing body: $(grep -o '<title>[^<]*' /tmp/nearbi-verify.body | head -1)"
check free-sample    200     /reports/near-users-vs-bots/
check free-noslash   301     /reports/near-users-vs-bots
check free-pdf       200     /reports/near-users-vs-bots/NEAR-real-users-or-bots.pdf -I
check gated-report   '30[12]|401|403' /reports/some-premium-report/
check gated-members  '30[12]|401|403' /members
check login          200     /login
check auth-challenge 200     /auth/challenge
head -c 300 /tmp/nearbi-verify.body; echo
check api-me         200     /api/me
cat /tmp/nearbi-verify.body; echo
api=$(tofu -chdir=tofu output -raw api_endpoint)
out=$(curl -sS -o /dev/null -w '%{http_code}' "$api/api/me"); [ "$out" = 403 ] && echo "PASS 403 direct-apigw-bypass-blocked" || { echo "FAIL $out direct-apigw-bypass (want 403)"; fail=1; }
exit $fail
