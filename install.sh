#!/bin/bash
# BetterBot — one-click installer
# Usage: curl -sL <url> | bash
# Or: bash install.sh

set -e

INSTALL_DIR="$HOME/.betterclaw/app"
BIN_LINK="/usr/local/bin/betterbot"

echo ""
echo "  ╔══════════════════════════════╗"
echo "  ║     BetterBot Installer     ║"
echo "  ╚══════════════════════════════╝"
echo ""

# Check Node.js
if ! command -v node &>/dev/null; then
  echo "❌ Node.js is required but not installed."
  echo ""
  if command -v brew &>/dev/null; then
    echo "   Run: brew install node"
  else
    echo "   Install from: https://nodejs.org"
  fi
  exit 1
fi

NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "❌ Node.js 20+ required (you have $(node -v))"
  exit 1
fi

echo "✓ Node.js $(node -v)"

# Download or copy
if [ -f "./bin/betterbot" ]; then
  # Running from extracted tarball
  SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
  echo "✓ Installing from local directory"
else
  echo "⬇ Downloading BetterBot..."
  TMP=$(mktemp -d)
  curl -sL "https://github.com/mylesndavid/betterbot/archive/refs/heads/main.tar.gz" -o "$TMP/bc.tgz"
  tar xzf "$TMP/bc.tgz" -C "$TMP"
  SRC_DIR="$TMP/betterbot-main"
fi

# Install
echo "📦 Installing to $INSTALL_DIR..."
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
cp -R "$SRC_DIR"/* "$INSTALL_DIR"/
chmod +x "$INSTALL_DIR/bin/betterbot"

# Install dependencies
if [ -f "$INSTALL_DIR/package.json" ]; then
  echo "📚 Installing dependencies..."
  (cd "$INSTALL_DIR" && npm install --production)
fi

# Remove quarantine (macOS)
if command -v xattr &>/dev/null; then
  xattr -dr com.apple.quarantine "$INSTALL_DIR" 2>/dev/null || true
fi

# Symlink
echo "🔗 Linking betterbot command..."
if [ ! -d "/usr/local/bin" ]; then
  sudo mkdir -p /usr/local/bin
fi
if [ -w "/usr/local/bin" ]; then
  ln -sf "$INSTALL_DIR/bin/betterbot" "$BIN_LINK"
else
  sudo ln -sf "$INSTALL_DIR/bin/betterbot" "$BIN_LINK"
fi

echo ""
echo "✅ BetterBot installed!"
echo ""
echo "   Run:  betterbot init"
echo ""
