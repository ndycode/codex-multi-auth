#!/bin/bash
# Build CodexQuota.app from CodexQuota.swift and install it to ~/Applications.
#
# Requires the Swift toolchain (Xcode or Command Line Tools) and macOS 13+.
# No Xcode project needed — compiles with swiftc and assembles the bundle by hand.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="${1:-$HOME/Applications/CodexQuota.app}"
BIN="$HERE/.build/CodexQuota"

echo "Compiling…"
mkdir -p "$HERE/.build"
swiftc -O -parse-as-library "$HERE/CodexQuota.swift" -o "$BIN"

echo "Assembling bundle at $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$BIN" "$APP/Contents/MacOS/CodexQuota"
chmod +x "$APP/Contents/MacOS/CodexQuota"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key><string>CodexQuota</string>
	<key>CFBundleDisplayName</key><string>Codex Quota</string>
	<key>CFBundleIdentifier</key><string>com.codexmultiauth.quota</string>
	<key>CFBundleVersion</key><string>1.0</string>
	<key>CFBundleShortVersionString</key><string>1.0</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleExecutable</key><string>CodexQuota</string>
	<key>LSMinimumSystemVersion</key><string>13.0</string>
	<key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

# Ad-hoc signature so Gatekeeper lets the locally-built bundle run.
codesign --force --sign - "$APP" >/dev/null 2>&1 || true

echo "Done. Launch with:  open \"$APP\""
echo "Autostart at login:  copy contrib/macos-app/local.codex.quota.plist into ~/Library/LaunchAgents and run 'launchctl load' it."
