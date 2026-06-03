#!/usr/bin/env bash
# gui/build.sh — build Claude-Control.app (icon + binary + bundle) into gui/dist/.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DIST="$HERE/dist"; APP="$DIST/Claude-Control.app"
rm -rf "$DIST"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# 1) icon
ICONSET="$(mktemp -d)/AppIcon.iconset"
swift "$HERE/make-icon.swift" "$ICONSET"
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

# 2) binary
swiftc -O "$HERE/Sources/main.swift" -o "$APP/Contents/MacOS/Claude-Control" -framework AppKit

# 3) Info.plist
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Claude-Control</string>
  <key>CFBundleDisplayName</key><string>Claude-Control</string>
  <key>CFBundleIdentifier</key><string>com.scottgraham.claude-control</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>Claude-Control</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST

echo "built $APP"
