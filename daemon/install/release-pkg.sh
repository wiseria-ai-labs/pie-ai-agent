#!/bin/bash
# daemon/install/release-pkg.sh — 签名发布全链。CI（或有证书的本机）调用。
# 前提: keychain 已导入 Developer ID Application + Installer 证书；
# env: APPLE_NOTARY_KEY / APPLE_NOTARY_KEY_ID / APPLE_NOTARY_KEY_ISSUER
set -euo pipefail
EXT_ID="${1:?need extension id}"
VERSION="${2:?need version}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${APPLE_NOTARY_KEY:?}" "${APPLE_NOTARY_KEY_ID:?}" "${APPLE_NOTARY_KEY_ISSUER:?}"

APP_ID="$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -1)"
INST_ID="$(security find-identity -v | sed -n 's/.*"\(Developer ID Installer: [^"]*\)".*/\1/p' | head -1)"
[ -n "$APP_ID" ] || { echo "no Developer ID Application identity in keychain" >&2; exit 1; }
[ -n "$INST_ID" ] || { echo "no Developer ID Installer identity in keychain" >&2; exit 1; }

# Apple Team ID：从签名身份名 "Developer ID Application: Name (TEAMID)" 括号里取出。
# #403 自更新把它**编译期内嵌进二进制**（--define PIE_TEAM_ID），运行时拿它比对下载物的
# codesign TeamIdentifier（不从下载物读期望值）。来源即签名身份，天然与实际签名一致。
TEAM_ID="$(printf '%s' "$APP_ID" | sed -n 's/.*(\([A-Z0-9]\{6,\}\))$/\1/p')"
[ -n "$TEAM_ID" ] || { echo "could not parse Team ID from identity: $APP_ID" >&2; exit 1; }

# 1) 双 target 编译 + lipo universal（PIE_TEAM_ID 与 PIE_DAEMON_VERSION 一同内嵌）
( cd "$ROOT" \
  && bun build ./src/cli.ts --compile --target=bun-darwin-arm64 \
       --define "process.env.PIE_DAEMON_VERSION=\"$VERSION\"" \
       --define "process.env.PIE_TEAM_ID=\"$TEAM_ID\"" --outfile dist/pie-arm64 \
  && bun build ./src/cli.ts --compile --target=bun-darwin-x64 \
       --define "process.env.PIE_DAEMON_VERSION=\"$VERSION\"" \
       --define "process.env.PIE_TEAM_ID=\"$TEAM_ID\"" --outfile dist/pie-x64 )
lipo -create "$ROOT/dist/pie-arm64" "$ROOT/dist/pie-x64" -output "$ROOT/dist/pie-universal"

# 2) 签二进制（hardened runtime + JIT entitlements）
codesign --force --options runtime --timestamp \
  --entitlements "$ROOT/install/pie.entitlements" \
  --sign "$APP_ID" "$ROOT/dist/pie-universal"
codesign --verify --strict "$ROOT/dist/pie-universal"

# 2.1) #403 自更新物：把已签名的 pie-universal 打成 zip（顶栏 app 自更新下载它 → 验签 →
# 原子 rename 覆盖 ~/.pie/bin/pie）。固定名，release.yml 传成 /latest/download/ 稳定 asset。
ditto -c -k --keepParent "$ROOT/dist/pie-universal" "$ROOT/dist/pie-darwin-universal.zip"

# 2.5) 顶栏 app：构建 + 签名（hardened runtime，无需 JIT entitlements）
"$ROOT/menubar/build-app.sh" "$ROOT/dist" "$VERSION"
codesign --force --deep --options runtime --timestamp \
  --sign "$APP_ID" "$ROOT/dist/Pie Link.app"
codesign --verify --strict "$ROOT/dist/Pie Link.app"

# 2.6) #419 顶栏 app 自更新物：已签名 bundle 打成 zip（daemon 当 ShipIt 下载 → 三闸 →
# 整 bundle rename 覆盖 /Applications/Pie Link.app）。固定名，release.yml 写进
# pie-link-latest.json 的 app.url，靠 /latest/download/ 稳定命中。
# 明确不对 app zip 公证：程序化 write 出来的文件不带 com.apple.quarantine，
# Gatekeeper 不做首次运行检查；我们自己的闸只验 codesign 签名 + TeamIdentifier，
# 不看公证 ticket。加一轮 notarytool submit --wait 只是白花 CI 时间。
ditto -c -k --keepParent "$ROOT/dist/Pie Link.app" "$ROOT/dist/pie-link-app.zip"

# 3) 组 pkg（unsigned）→ productsign
"$ROOT/install/build-pkg.sh" "$EXT_ID" "$VERSION" "$ROOT/dist/pie-universal" "$ROOT/dist/Pie Link.app"
mv "$ROOT/dist/pie-link-$VERSION.pkg" "$ROOT/dist/pie-link-$VERSION-unsigned.pkg"
productsign --sign "$INST_ID" \
  "$ROOT/dist/pie-link-$VERSION-unsigned.pkg" "$ROOT/dist/pie-link-$VERSION.pkg"
rm "$ROOT/dist/pie-link-$VERSION-unsigned.pkg"

# 4) 公证 + staple
KEY_FILE="$(mktemp)"; printf '%s' "$APPLE_NOTARY_KEY" > "$KEY_FILE"
xcrun notarytool submit "$ROOT/dist/pie-link-$VERSION.pkg" \
  --key "$KEY_FILE" --key-id "$APPLE_NOTARY_KEY_ID" --issuer "$APPLE_NOTARY_KEY_ISSUER" \
  --wait
rm "$KEY_FILE"
xcrun stapler staple "$ROOT/dist/pie-link-$VERSION.pkg"
echo "signed+notarized dist/pie-link-$VERSION.pkg"
