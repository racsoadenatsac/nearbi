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
aws cloudfront create-invalidation --distribution-id "$dist" --paths "/*" --query 'Invalidation.Id' --output text
