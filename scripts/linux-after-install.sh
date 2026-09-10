#!/bin/bash
# 1) Icon fallback for DEs whose icon themes do not resolve hicolor (the
#    same fix as fcitx5-skey: KDE checks /usr/share/pixmaps as a last
#    resort, and an absolute Icon= path bypasses theme inheritance).
cp /opt/Zalo/app/pc-dist/favicon-512x512.png /usr/share/pixmaps/zalo.png 2>/dev/null || true
sed -i 's|^Icon=.*|Icon=/usr/share/pixmaps/zalo.png|' /usr/share/applications/zalo.desktop 2>/dev/null || true

# 2) Pre-fetch the verified wine build into the bundled location so the
#    installed app behaves like the Full variant — calls work immediately
#    after install, no first-run download. Distro wines are NOT usable
#    (Ubuntu 24.04 ships wine 9.0; Fedora/Arch ship wow64-only builds) so
#    the app's own 11.17 classic is the only reliable option.
#    URL must stay in sync with WINE_DOWNLOAD_URL in
#    plugins/zcall-bridge/index.js. Network failure is non-fatal: the app
#    falls back to its own first-run download flow.
#    EXPECTED_VERSION gates the download: on upgrades the previous wine is
#    reused as-is, and when a release bumps WINE_URL to a newer wine the
#    version mismatch triggers exactly one re-download here.
WINE_URL="https://github.com/Kron4ek/Wine-Builds/releases/download/11.17/wine-11.17-amd64.tar.xz"
EXPECTED_VERSION="wine-11.17"
WINE_DIR="/opt/Zalo/app/native/wine-runtime"

NEED=1
if [ -x "$WINE_DIR/bin/wine" ]; then
  CUR=$("$WINE_DIR/bin/wine" --version 2>/dev/null || true)
  [ "$CUR" = "$EXPECTED_VERSION" ] && NEED=0
fi

if [ "$NEED" = "1" ]; then
  rm -rf "$WINE_DIR"
  mkdir -p "$WINE_DIR"
  TMP=$(mktemp -d)
  if curl -fsSL --retry 3 -o "$TMP/wine.tar.xz" "$WINE_URL" \
      && tar -xf "$TMP/wine.tar.xz" -C "$WINE_DIR" --strip-components=1; then
    # Prune the dev-kit (mirror of pruneWineTree in scripts/build.js):
    # headers, import libs, .def/.c sources and the winegcc/widl toolchain
    # are ~200MB the call engine never touches.
    rm -rf "$WINE_DIR/include"
    find "$WINE_DIR/lib" -type f \( -name '*.a' -o -name '*.def' -o -name '*.c' \) -delete 2>/dev/null || true
    (cd "$WINE_DIR/bin" && ls | grep -vE '^(wine|wineserver|wineboot)$' | xargs -r rm -f)
    echo "zcall: bundled $EXPECTED_VERSION classic installed to $WINE_DIR"
  else
    rm -rf "$WINE_DIR"
    echo "zcall: wine download failed (offline?) — the app will download it on first run"
  fi
  rm -rf "$TMP"
fi
exit 0
