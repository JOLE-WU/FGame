#!/bin/bash
# Start the FGame API + web build on port 3000.
#
# 3000 is mandatory: the WorkBuddy publish proxy probes that port, and any
# other port makes the public URL return 504 ("service on port 3000 not
# ready"), which the app shows as an endless loading screen.
cd /workspace/FGame || exit 1
exec env \
  PORT=3000 \
  FGAME_WEB_DIR=/workspace/FGame/client/dist \
  FGAME_PUBLIC_ORIGIN=https://a81bed224b123cc64.app.workbuddy.host \
  FGAME_SHARECODE=73QDIHJLBR \
  FGAME_AUTO_REFRESH=1 \
  FGAME_REFRESH_MS=21600000 \
  node node_modules/.bin/tsx server/src/index.ts
