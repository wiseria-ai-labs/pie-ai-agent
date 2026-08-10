#!/bin/bash
# daemon/install/build-pkg.sh — 组 .pkg。用法: build-pkg.sh <EXT_ID> [VERSION] [BIN] [APP]
# BIN 缺省 = 本机编译 dist/pie（开发路径，unsigned）；给定 = 使用外部（已签名）二进制。
# APP 给定 = 把顶栏 app（Pie Link.app）放进 payload /Applications/（signed .app 在 release-pkg.sh 层准备）。
# 产物 pkg 本身不签名——签名/公证在 release-pkg.sh（CI）层做。
set -euo pipefail
EXT_ID="${1:?need extension id}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${2:-$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/package.json")}"
BIN="${3:-}"
APP="${4:-}"

if [ -z "$BIN" ]; then
  ( cd "$ROOT" && bun build ./src/cli.ts --compile --outfile dist/pie )
  BIN="$ROOT/dist/pie"
fi

STAGE="$(mktemp -d)"
mkdir -p "$STAGE/usr/local/bin"
cp "$BIN" "$STAGE/usr/local/bin/pie"
chmod +x "$STAGE/usr/local/bin/pie"

if [ -n "$APP" ]; then
  mkdir -p "$STAGE/Applications"
  cp -R "$APP" "$STAGE/Applications/"
fi

SCRIPTS="$(mktemp -d)"
cp "$ROOT/install/postinstall.sh" "$SCRIPTS/postinstall"
chmod +x "$SCRIPTS/postinstall"
sed "s|__EXT_ID__|$EXT_ID|g" "$ROOT/install/ai.wiseria.pie.host.template.json" > "$SCRIPTS/ai.wiseria.pie.host.template.json"
cp "$ROOT/install/ai.wiseria.pie.plist.template" "$SCRIPTS/"
cp "$ROOT/install/ai.wiseria.pie.menubar.plist.template" "$SCRIPTS/"

mkdir -p "$ROOT/dist"

# app bundle 必须钉死装在 /Applications：pkgbuild 从 payload 推断 component 时，Apple 默认
# 给 bundle 开 BundleIsRelocatable=true —— installer 会去 LaunchServices 数据库找同
# CFBundleIdentifier 的 app，把新版**装到它记得的那个旧位置**（install.log: "Applications/
# Pie Link.app relocated to ..."）。凡是这个 app 曾出现在别处（开发机的 dist/、用户拖出来
# 试过），/Applications/Pie Link.app 就永远不会出现 → postinstall 的 app 段整段跳过（顶栏
# 不自启），且 #419 的自更新硬编码 /Applications/Pie Link.app 会永远打不中。
# 关 relocation + 关版本比较（装了这个 pkg 就该拿到 pkg 里那版，本地反复装同版本号也覆盖）。
PKG_ARGS=()
if [ -n "$APP" ]; then
  COMPONENT_PLIST="$(mktemp -t pie-component).plist"
  cat > "$COMPONENT_PLIST" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
  <dict>
    <key>BundleHasStrictIdentifier</key><true/>
    <key>BundleIsRelocatable</key><false/>
    <key>BundleIsVersionChecked</key><false/>
    <key>BundleOverwriteAction</key><string>upgrade</string>
    <key>RootRelativeBundlePath</key><string>Applications/Pie Link.app</string>
  </dict>
</array>
PLIST
  echo "</plist>" >> "$COMPONENT_PLIST"
  PKG_ARGS=(--component-plist "$COMPONENT_PLIST")
fi

pkgbuild --root "$STAGE" --scripts "$SCRIPTS" \
  --identifier ai.wiseria.pie --version "$VERSION" \
  "${PKG_ARGS[@]+"${PKG_ARGS[@]}"}" \
  "$ROOT/dist/pie-link-$VERSION.pkg"

# 自检：relocation 静默退化（装完"成功"但 app 去了别处），必须在打包时就拦住。
# 判据是 PackageInfo 里有没有**非空**的 <relocate> 段：默认行为写 `<relocate><bundle
# id="ai.wiseria.pie.menubar"/></relocate>`，关掉后是空元素 `<relocate/>`。
#（别用 pkg-info 的 relocatable="false" 属性判——它两种情况都是 false，没有区分力。）
if [ -n "$APP" ]; then
  CHECK="$(mktemp -d)/x"
  pkgutil --expand "$ROOT/dist/pie-link-$VERSION.pkg" "$CHECK"
  grep -q '<relocate>' "$CHECK/PackageInfo" && {
    echo "error: pkg still has a <relocate> directive — app bundle would be installed to wherever LaunchServices remembers it" >&2
    exit 1; }
  grep -q 'Applications/Pie Link.app' "$CHECK/PackageInfo" || {
    echo "error: pkg PackageInfo has no Applications/Pie Link.app bundle entry" >&2
    exit 1; }
  rm -rf "$CHECK"
fi

echo "built dist/pie-link-$VERSION.pkg (unsigned)"
