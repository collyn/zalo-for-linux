# Bundled 32-bit GStreamer stack — licensing

This directory ships UNMODIFIED i386 binary packages from the Ubuntu 26.04
("resolute") archive, bundled so wine's camera capture always uses the
fixed stack. Ubuntu 24.04's i386 gst 1.24 + libv4l 1.26 stalls UVC cameras
(DQBUF EPIPE) — see the camera-capture note in scripts/linux-after-install.sh.

| Package | Version | License |
|---|---|---|
| libgstreamer1.0-0 | 1.28.2-1 | LGPL-2.1-or-later |
| libgstreamer-plugins-base1.0-0 | 1.28.2-1 | LGPL-2.1-or-later |
| gstreamer1.0-plugins-base | 1.28.2-1 | LGPL-2.1-or-later |
| gstreamer1.0-plugins-good | 1.28.2-2ubuntu0.1 | LGPL-2.1-or-later |
| libv4l-0t64 | 1.32.0-2ubuntu1 | LGPL-2.1-or-later |
| libv4lconvert0t64 | 1.32.0-2ubuntu1 | LGPL-2.1-or-later |
| liborc-0.4-0t64 | 1:0.4.42-2 | BSD-2-Clause |

Source code (unmodified):

- GStreamer 1.28.2 — https://gstreamer.freedesktop.org/src/
  (Ubuntu source packages gstreamer1.0, gst-plugins-base1.0,
  gst-plugins-good1.0 in the resolute archive)
- v4l-utils 1.32.0 — https://git.linuxtv.org/v4l-utils.git
- orc 0.4.42 — https://gitlab.freedesktop.org/gstreamer/orc

The libraries are dynamically loaded (dlopen/LD_LIBRARY_PATH) by the wine
capture pipeline — no GPL-covered code is linked into the Zalo application
itself. Per-package copyright details (Debian machine-readable format) ship
alongside these files in usr/share/doc/<package>/copyright.
