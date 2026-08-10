#!/bin/bash
# daemon/install/postinstall.sh — .pkg 装完后由 macOS Installer 以 root 运行（非用户上下文）。
# 所有 per-user 路径须显式解析真实登录的 console user，不能用裸 $HOME（root 下 = /var/root）。
#
# #403 落点迁移：daemon 真身住 ~/.pie/bin/pie（用户可写），plist / host wrapper 都指它，
# /usr/local/bin/pie 退化成 symlink（首装建一次，之后自更新永不再碰）。此后 daemon 更新
# = 顶栏 app 下新二进制原子 rename 覆盖 ~/.pie/bin/pie，零提权、零安装器、零密码。
# 本脚本对「首装」与「已装旧版」收敛到同一终态（幂等），不写单独迁移分支。
set -euo pipefail

# 解析真实登录的 console user（而非 root）
CONSOLE_USER="$(stat -f%Su /dev/console 2>/dev/null || true)"
if [ -z "$CONSOLE_USER" ] || [ "$CONSOLE_USER" = "root" ] || [ "$CONSOLE_USER" = "loginwindow" ]; then
  echo "[pie] error: no logged-in console user detected (got '${CONSOLE_USER:-<empty>}')." >&2
  echo "[pie] please log into the Mac's GUI session and re-run this installer, or run 'pie doctor' after logging in to finish setup." >&2
  exit 1
fi

USER_HOME="$(dscl . -read "/Users/$CONSOLE_USER" NFSHomeDirectory 2>/dev/null | awk '{print $NF}')"
USER_UID="$(id -u "$CONSOLE_USER")"

if [ -z "$USER_HOME" ] || [ ! -d "$USER_HOME" ]; then
  echo "[pie] error: could not resolve home directory for console user '$CONSOLE_USER'." >&2
  exit 1
fi

# per-user 路径：一律基于真实用户的 $USER_HOME，绝不用裸 $HOME（root 下 $HOME=/var/root）
PIE_DIR="$USER_HOME/.pie"
BIN_DIR="$PIE_DIR/bin"
NM_DIR="$USER_HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
LA_DIR="$USER_HOME/Library/LaunchAgents"

# daemon 真身与 host wrapper 的固定落点（不随版本变——自更新只换 pie 的 inode，不重写 wrapper）
PIE_BIN="$BIN_DIR/pie"
HOST_WRAPPER="$BIN_DIR/pie-host"
# pkg payload 落下的系统级实体（首装是真文件，重装亦然）；迁移后 /usr/local/bin/pie 退化成 symlink
PAYLOAD_BIN="/usr/local/bin/pie"
LEGACY_HOST_WRAPPER="/usr/local/bin/pie-host"

mkdir -p "$PIE_DIR/logs" "$BIN_DIR" "$NM_DIR" "$LA_DIR"

# ── 落点迁移（幂等）：把 payload 的 /usr/local/bin/pie 挪进 ~/.pie/bin/pie ──────────
# payload 每次装都会重新写实体到 $PAYLOAD_BIN；若它是真文件（首装 / 重装）就 mv 覆盖到
# $BIN_DIR/pie。若它已是指向 $BIN_DIR/pie 的 symlink（自更新后重装的中间态），mv 会把
# 那个 symlink 挪走——所以只在「是普通文件」时 mv，否则保留现有真身。
if [ -f "$PAYLOAD_BIN" ] && [ ! -L "$PAYLOAD_BIN" ]; then
  mv -f "$PAYLOAD_BIN" "$PIE_BIN"
fi
chmod +x "$PIE_BIN"
# /usr/local/bin/pie 退化成便利 symlink（CLI `pie doctor` 不变），指向用户目录真身
ln -sf "$PIE_BIN" "$PAYLOAD_BIN"

# host wrapper（Chrome spawn 它 → 转 `pie host`）；固定路径、内容不随版本变
printf '#!/bin/bash\nexec %s host "$@"\n' "$PIE_BIN" > "$HOST_WRAPPER"
chmod +x "$HOST_WRAPPER"
# 删掉遗留的系统级 host wrapper（运行时链路已彻底退出 /usr/local/bin）
rm -f "$LEGACY_HOST_WRAPPER"

# 扩展 ID 由打包时注入（build-pkg.sh 替 __EXT_ID__）；native manifest 的 path 指用户目录 wrapper
sed -e "s|__PIE_BIN__|$HOST_WRAPPER|g" \
    "$(dirname "$0")/ai.wiseria.pie.host.template.json" > "$NM_DIR/ai.wiseria.pie.json"

# launchd：ProgramArguments 指 ~/.pie/bin/pie（不再是 /usr/local/bin/pie）
sed -e "s|__PIE_BIN__|$PIE_BIN|g" -e "s|__LOG__|$PIE_DIR/logs/daemon.err.log|g" \
    "$(dirname "$0")/ai.wiseria.pie.plist.template" > "$LA_DIR/ai.wiseria.pie.plist"

# per-user 文件是以 root 写的，交还给真实用户，否则该用户的 launchd/Chrome 会话读不到 / 没权限
# （含新落点 $BIN_DIR 下的真身与 wrapper——自更新时用户进程要能原子 rename 覆盖它们）
chown -R "$CONSOLE_USER" "$PIE_DIR"
chown "$CONSOLE_USER" "$NM_DIR/ai.wiseria.pie.json"
chown "$CONSOLE_USER" "$LA_DIR/ai.wiseria.pie.plist"

# 装进该用户的 gui/<uid> session domain，而非 root 的 domain
launchctl asuser "$USER_UID" launchctl unload "$LA_DIR/ai.wiseria.pie.plist" 2>/dev/null || true
launchctl asuser "$USER_UID" launchctl load "$LA_DIR/ai.wiseria.pie.plist"

# 顶栏 app：登录自启 + 装完立即启动（图标出现 = 安装成功反馈）
if [ -d "/Applications/Pie Link.app" ]; then
  cp "$(dirname "$0")/ai.wiseria.pie.menubar.plist.template" "$LA_DIR/ai.wiseria.pie.menubar.plist"
  chown "$CONSOLE_USER" "$LA_DIR/ai.wiseria.pie.menubar.plist"
  launchctl asuser "$USER_UID" launchctl unload "$LA_DIR/ai.wiseria.pie.menubar.plist" 2>/dev/null || true
  launchctl asuser "$USER_UID" launchctl load "$LA_DIR/ai.wiseria.pie.menubar.plist"
fi

echo "[pie] installed. run 'pie doctor' to verify."
