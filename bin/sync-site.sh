#!/bin/bash
# Upload nearbi-app/public to the static bucket and invalidate CloudFront.
# Usage: AWS_PROFILE=nearbi bin/sync-site.sh [app-dir]
set -euo pipefail
cd "$(dirname "$0")/.."
app="${1:-../nearbi-app}"
bucket=$(tofu -chdir=tofu output -raw site_bucket)
dist=$(tofu -chdir=tofu output -raw cloudfront_distribution_id)
# ledger/ is published by rs-ledger (bin/publish); exclude it so --delete never removes it.
aws s3 sync "$app/public/" "s3://$bucket/" --delete --exclude ".DS_Store" --exclude "ledger/*"
# HTML/JS/CSS change often and have unversioned names: make browsers revalidate (ETag) instead of
# serving a stale copy from their heuristic cache. Images/PDFs keep default caching.
aws s3 cp "$app/public/" "s3://$bucket/" --recursive --exclude "*" --include "*.html" --include "*.js" --include "*.css" \
  --exclude "ledger/*" --metadata-directive REPLACE --cache-control "no-cache" --only-show-errors
aws cloudfront create-invalidation --distribution-id "$dist" --paths "/*" --query 'Invalidation.Id' --output text
