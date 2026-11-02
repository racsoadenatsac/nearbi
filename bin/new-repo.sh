#!/bin/bash
# Create a new logical-unit repo under ~/projects/research-shop/<name> with standard scaffolding.
# Usage: new-repo.sh <name> "<one-line purpose>"
set -euo pipefail
ROOT="$HOME/projects/research-shop"
name="$1"; purpose="$2"
dir="$ROOT/$name"
[ -d "$dir/.git" ] && { echo "exists: $dir"; exit 0; }
mkdir -p "$dir" && cd "$dir"
git init -q -b main
git config user.name "Felix (research-shop agent)"
git config user.email "felix@research-shop.local"
cat > README.md <<EOF
# $name

$purpose

Part of the NEAR Hackathon one-agent research shop. See \`rs-docs/ARCHITECTURE.md\`.
EOF
cat > .gitignore <<'EOF'
# secrets: never commit
.env
.env.*
*.key
*credentials*.json
*service-account*.json
secrets/
# build/runtime
__pycache__/
*.pyc
.venv/
node_modules/
.ipynb_checkpoints/
.DS_Store
cache/
EOF
git add -A
git commit -q -m "chore: initialize $name repository"
echo "created: $dir"
