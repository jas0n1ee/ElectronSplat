#!/bin/sh
# Use a system-owned Chromium sandbox when USB file ownership cannot supply one.
# Keep namespaces/seccomp enabled; never add --no-sandbox to the application.
portable_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
portable_helper="$portable_root/chrome-sandbox"
if [ "$(stat -Lc '%u:%a' "$portable_helper" 2>/dev/null)" = '0:4755' ]; then
  exec "$portable_root/portable-runtime" "$@"
fi
portable_system_helper=/opt/google/chrome/chrome-sandbox
if [ "$(stat -Lc '%u:%a' "$portable_system_helper" 2>/dev/null)" = '0:4755' ]; then
  # Only replace the application's own bundled helper/link, never the system file.
  if [ -L "$portable_helper" ]; then
    rm -- "$portable_helper" || exit 1
  elif [ -f "$portable_helper" ]; then
    mv -f -- "$portable_helper" "$portable_root/.bundled-chrome-sandbox" || exit 1
  fi
  ln -s -- "$portable_system_helper" "$portable_helper" || exit 1
  exec "$portable_root/portable-runtime" "$@"
fi
# On systems allowing unprivileged user namespaces, Chromium can use that sandbox
# without a setuid helper. Restricted Ubuntu installations require system setup.
"$portable_root/portable-runtime" --disable-setuid-sandbox "$@"
portable_status=$?
if [ "$portable_status" -ne 0 ]; then
  portable_message='Portable 无法启动。此 Linux 系统可能限制 Chromium 沙箱。需要已正确安装的 Chrome 沙箱组件，或由管理员配置应用沙箱；详情请查看终端错误。'
  printf '%s\n' "$portable_message" >&2
  if command -v zenity >/dev/null 2>&1; then zenity --error --title='Portable 启动失败' --text="$portable_message"; fi
fi
exit "$portable_status"
