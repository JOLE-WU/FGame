#!/bin/bash
# Keeps the iOS in-app-purchase free list fresh.
#
# "内购限免" is a long-tail event: the only way to spot it is to ask Apple
# for each candidate app's in-app purchase block, and App Store pages are
# ~1MB each, so the scan is chunked. The server keeps a rotating cursor
# (data/iap-scan-state.json) over a ~2300-app pool, so calling the action
# repeatedly walks the whole pool and then starts over. 400 apps per hour
# ≈ the full pool every 6 hours, which is far below any rate limit and
# keeps the list within a day of reality.
cd /workspace/FGame || exit 1
while true; do
  OUT=$(curl -s -m 300 -X POST http://127.0.0.1:3000/actions \
    -H 'Content-Type: application/json' \
    -d '{"action":"refreshIosIapFree","args":{"limit":400}}')
  echo "[iap] $(date '+%F %T') $OUT" >> /tmp/fgame-iap.log
  sleep 3600
done
