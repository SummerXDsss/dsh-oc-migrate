#!/bin/sh
# Optional AppImage launcher for ordinary Linux desktops, including systems without FUSE.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ "$#" -gt 0 ]; then
  APP=$1; shift
else
  set -- "$HERE"/DSH*.AppImage
  [ "$#" -eq 1 ] && [ -f "$1" ] || { echo '请把启动脚本和一个 AppImage 放在同一目录，或指定 AppImage 路径。' >&2; exit 2; }
  APP=$1; shift
fi
[ -f "$APP" ] || { echo 'AppImage 文件不存在。' >&2; exit 2; }
# A relative filename without '/' must not be searched in PATH by exec.
case "$APP" in /*) ;; *) APP="$PWD/$APP" ;; esac
[ -x "$APP" ] || chmod u+x "$APP"
if [ ! -r /dev/fuse ] || [ ! -w /dev/fuse ] || { ! command -v fusermount >/dev/null 2>&1 && ! command -v fusermount3 >/dev/null 2>&1; }; then
  export APPIMAGE_EXTRACT_AND_RUN=1
fi
exec "$APP" "$@"
