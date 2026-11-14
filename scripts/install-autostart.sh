#!/bin/bash
# Install the container-level autostart entry so the FGame backend comes back
# automatically after a sandbox resume / container recreation.
#
# supervisord.conf includes %(_run)s/supervisord-conf/*.conf. That runtime dir
# is recreated on some resumes, so watchdog.sh also calls this whenever the
# entry is missing. Safe to run repeatedly.
set -u
SRC=/workspace/FGame/scripts/fgame-supervisor.conf
DIR=/.PlnPyKFp4CRfFtgC1_run/supervisord-conf

if [ ! -f "$SRC" ]; then
  echo "模板不存在: $SRC" >&2
  exit 1
fi
if [ ! -d "$DIR" ]; then
  echo "supervisord 运行时目录不存在（$DIR），跳过；会话内由 watchdog 直接守护。"
  exit 0
fi
if cp "$SRC" "$DIR/fgame.conf"; then
  echo "已安装自启配置: $DIR/fgame.conf （下次容器重建时 supervisord 自动拉起 watchdog）"
else
  echo "写入失败，请检查权限" >&2
  exit 1
fi
