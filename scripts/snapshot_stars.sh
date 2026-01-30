#!/bin/bash
# snapshot_stars.sh - Snapshot GitHub stargazers for a repo
REPO=$1
DATE=$(date +%F)

if [ -z "$REPO" ]; then
  echo "Usage: $0 <owner/repo>"
  exit 1
fi

gh api "repos/$REPO/stargazers" --paginate \
| jq -r '.[].user.login' | sort > stars_$DATE.txt

echo "Stargazers snapshot saved to stars_$DATE.txt"