#!/bin/bash
set -e
cd "$(dirname "$0")"
APP=build/SmartFade.app
mkdir -p $APP/Contents/MacOS $APP/Contents/Resources
cp assets/AppIcon.icns $APP/Contents/Resources/
swiftc -O -swift-version 5 -o $APP/Contents/MacOS/SmartFade Sources/*.swift -framework CoreAudio -framework AudioToolbox
cat > $APP/Contents/Info.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>local.smartfade</string>
  <key>CFBundleName</key><string>SmartFade</string>
  <key>CFBundleExecutable</key><string>SmartFade</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.6.2</string>
  <key>LSMinimumSystemVersion</key><string>14.4</string>
  <key>LSUIElement</key><true/>
  <key>NSAudioCaptureUsageDescription</key><string>SmartFade processes Spotify audio to create seamless transitions between tracks.</string>
</dict></plist>
PLIST
codesign --force --sign - $APP
echo "built $APP"
