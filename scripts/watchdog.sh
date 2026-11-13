#!/bin/bash
# Keeps the FGame backend alive: if port 3000 stops answering, restart it.
# The sandbox session can drop the process (crash, OOM, manual kill); without
# this the published URL 504s and the app hangs on "加载中".
#
# It also keeps the iOS in-app-purchase scan loop running: that loop walks
# the ~2300-app candidate pool 400 apps at a time (see iap-scan-loop.sh),
# and if it dies the 内购限免 list silently freezes at whatever it had.
LOG=/tmp/fgame-server.log
while true; do
  if ! curl -sS -m 5 -o /dev/null http://127.0.0.1:3000/health; then
    if ! ss -lnt 2>/dev/null | grep -q ':3000'; then
      echo "[watchdog] $(date '+%F %T') backend down, restarting" >> /tmp/fgame-watchdog.log
      (setsid bash /workspace/FGame/scripts/serve.sh >> "$LOG" 2>&1 &)
    fi
  fi
  if ! pgrep -f "iap-scan-loop.sh" > /dev/null 2>&1; then
    echo "[watchdog] $(date '+%F %T') iap scan loop down, restarting" >> /tmp/fgame-watchdog.log
    (setsid bash /workspace/FGame/scripts/iap-scan-loop.sh >> /tmp/fgame-iap.log 2>&1 &)
  fi
  # Epic mobile discover snapshots are fetched through Chromium (the API
  # 403s server-side). If this loop dies the snapshots silently age out:
  # the server then reads last week's stale JSON, parses zero live
  # giveaways, and the whole Epic mobile section disappears. Keep it alive.
  if ! pgrep -f "epic-discover-cron.sh" > /dev/null 2>&1; then
    echo "[watchdog] $(date '+%F %T') epic discover snapshot loop down, restarting" >> /tmp/fgame-watchdog.log
    (setsid bash /workspace/FGame/scripts/epic-discover-cron.sh >> /tmp/epic-discover.log 2>&1 &)
  fi
  sleep 30
done
