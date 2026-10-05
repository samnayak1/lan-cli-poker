#!/bin/sh
# Installs the standalone `poker-lan` executable: no Node, npm or build tools needed.
#
#   curl -fsSL https://raw.githubusercontent.com/samnayak1/lan-cli-poker/main/install.sh | sh
#
# Options (environment variables):
#   PREFIX=/usr/local   install into $PREFIX/bin instead of ~/.local/bin
#   VERSION=v0.1.0      install a specific release instead of the latest
set -eu

REPO="samnayak1/lan-cli-poker"
PREFIX="${PREFIX:-$HOME/.local}"
BIN_DIR="$PREFIX/bin"

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) echo "Unsupported OS: $(uname -s). poker-lan's standalone builds are for Linux and macOS." >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) echo "Unsupported CPU: $(uname -m)" >&2; exit 1 ;;
esac

asset="poker-lan-$os-$arch"
if [ -n "${VERSION:-}" ]; then
  url="https://github.com/$REPO/releases/download/$VERSION/$asset"
else
  url="https://github.com/$REPO/releases/latest/download/$asset"
fi

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
echo "Downloading $asset…"
if command -v curl >/dev/null 2>&1; then
  curl -fL --progress-bar "$url" -o "$tmp"
elif command -v wget >/dev/null 2>&1; then
  wget -q --show-progress "$url" -O "$tmp"
else
  echo "Need curl or wget to download." >&2
  exit 1
fi

mkdir -p "$BIN_DIR"
chmod +x "$tmp"
mv "$tmp" "$BIN_DIR/poker-lan"
trap - EXIT

# macOS: clear the download quarantine and give it an ad-hoc signature (Apple Silicon won't run unsigned code).
if [ "$os" = darwin ]; then
  xattr -d com.apple.quarantine "$BIN_DIR/poker-lan" 2>/dev/null || true
  codesign --force --sign - "$BIN_DIR/poker-lan" 2>/dev/null || true
fi

echo "Installed $BIN_DIR/poker-lan"
case ":$PATH:" in
  *":$BIN_DIR:"*) echo "Run it with: poker-lan" ;;
  *) echo "Add $BIN_DIR to your PATH (e.g. echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.profile), then run: poker-lan" ;;
esac
