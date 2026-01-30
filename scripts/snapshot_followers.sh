#!/bin/bash
# snapshot_followers.sh - Snapshot GitHub followers for a user
USER=$1
DATE=$(date +%F)

if [ -z "$USER" ]; then
  echo "Usage: $0 <username>"
  exit 1
fi

gh api "users/$USER/followers" --paginate \
| jq -r '.[].login' | sort > followers_$DATE.txt

echo "Followers snapshot saved to followers_$DATE.txt"