#!/bin/bash
# One-line git status for every repo in the fleet.
ROOT="$HOME/projects/research-shop"
for d in "$ROOT"/rs-*/; do
  n=$(basename "$d")
  b=$(git -C "$d" branch --show-current)
  dirty=$(git -C "$d" status --porcelain | wc -l | tr -d ' ')
  last=$(git -C "$d" log -1 --format='%h %s (%cr)')
  printf "%-12s %-24s dirty:%-3s %s\n" "$n" "$b" "$dirty" "$last"
done
