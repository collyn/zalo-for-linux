#!/bin/bash
rm -f /usr/share/pixmaps/zalo.png
# The bundled wine dir is fetched by after-install, not package-owned —
# drop it on real removal. On upgrade ($1 = upgrade) KEEP it so the new
# package's after-install skips the re-download.
if [ "$1" != "upgrade" ]; then
  rm -rf /opt/Zalo/app/native/wine-runtime
fi
exit 0
