#!/bin/bash
# Refresh the Epic mobile discover snapshot every 6 hours.
#
# The server cannot call that endpoint itself (Cloudflare answers 403 to
# datacenter IPs), so it reads the JSON this loop writes. Weekly giveaways
# change over on Thursday, so a 6-hour cadence keeps offers fresh; snapshots
# older than 7 days are ignored by the server.
cd /workspace/FGame || exit 1
while true; do
  echo "[snapshot] $(date '+%F %T') start" >> /tmp/epic-discover.log
  python3 scripts/epic-discover-snapshot.py >> /tmp/epic-discover.log 2>&1
  sleep 21600
done
