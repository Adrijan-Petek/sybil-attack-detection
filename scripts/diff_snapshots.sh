#!/bin/bash
# diff_snapshots.sh - Diff two snapshots to find unfollows/unstars
OLD_FILE=$1
NEW_FILE=$2

if [ -z "$OLD_FILE" ] || [ -z "$NEW_FILE" ]; then
  echo "Usage: $0 <old_snapshot> <new_snapshot>"
  exit 1
fi

# Users in old but not in new (unfollows/unstars)
comm -23 "$OLD_FILE" "$NEW_FILE" > unfollows_$(date +%F).txt

echo "Unfollows/unstars saved to unfollows_$(date +%F).txt"