const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('./utils/logger');

const BASE_DIR = path.join(__dirname, '..');
const APP_DIR = path.join(BASE_DIR, 'app');

let ZALO_VERSION = null;
const builtFiles = [];

async function main() {
  try {
    // Read version from package.json.bak
    const packageJsonBakPath = path.join(APP_DIR, 'package.json.bak');
    if (fs.existsSync(packageJsonBakPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonBakPath, 'utf8'));
      ZALO_VERSION = packageJson.version;
      logger.info('Zalo version from package.json.bak:', ZALO_VERSION);

      // Export global outputs for workflow
      if (process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `zalo_version=${ZALO_VERSION}\n`);
      }
    } else {
      logger.warn('package.json.bak not found, version will be unknown');
    }

    // A leftover bundled runtime (e.g. from a crashed previous run) would
    // silently bloat the standard variants — start clean; Phase 3 re-bundles.
    fs.rmSync(path.join(APP_DIR, 'native', 'wine-runtime'), { recursive: true, force: true });
    fs.rmSync(path.join(APP_DIR, 'native', 'gst-runtime'), { recursive: true, force: true });

    // Phase 1: Build original Zalo
    logger.step('PHASE 1: Building Zalo (Original)');
    await build('(Original)', '');

    // Phase 1.5: Full variant of the original (no ZaDark) — wine bundled.
    logger.step('PHASE 1.5: Building Zalo (Full — wine bundled, no ZaDark)');
    await bundleWineRuntime();
    await bundleGstRuntime();
    await build('(Full — wine bundled)', '-PlainFull');
    // Remove the runtime again — the standard variants must not contain it,
    // and a leftover from a previous run would silently bloat them (and the
    // next Full build) to the Full size.
    fs.rmSync(path.join(APP_DIR, 'native', 'wine-runtime'), { recursive: true, force: true });
    fs.rmSync(path.join(APP_DIR, 'native', 'gst-runtime'), { recursive: true, force: true });

    // Phase 2: Apply ZaDark integration and build final product
    logger.step('PHASE 2: Building Zalo (with ZaDark)');

    // Patch ZaDark directly into APP_DIR
    await integrateZaDark();
    await build('(with ZaDark)', '-ZaDark');

    // Phase 3: Full variant of the ZaDark build — wine bundled, so the call
    // feature works out of the box with no first-run download.
    logger.step('PHASE 3: Building Zalo (Full — wine bundled, with ZaDark)');
    await bundleWineRuntime();
    await bundleGstRuntime();
    await build('(Full — wine bundled)', '-Full');
    // Release asset for the standard variants' first-run download — must run
    // BEFORE the rmSyncs below (the only moment the final tree exists).
    await packageGstAsset();
    fs.rmSync(path.join(APP_DIR, 'native', 'wine-runtime'), { recursive: true, force: true });
    fs.rmSync(path.join(APP_DIR, 'native', 'gst-runtime'), { recursive: true, force: true });

    // Final summary
    logger.step('BUILD SUMMARY');
    if (builtFiles.length > 0) {
      builtFiles.forEach(({ type, name, sizeStr }) => {
        logger.info(`${type} • ${name} (${sizeStr})`);
      });
    } else {
      logger.warn('No AppImage files were built in this run');
    }
  } catch (error) {
    logger.error('Main workflow failed:', error.message);
    process.exit(1);
  }
}

// Full variants bundle the pure-64-bit (wow64) wine build: 32-bit Windows
// code runs with NO host 32-bit libraries. WINE_DOWNLOAD_URL in
// plugins/zcall-bridge/index.js is the IDENTICAL URL — the standard-variant
// first-run download matches the bundled runtime; keep the two in sync.
const WINE_DOWNLOAD_URL_WOW64 =
  'https://github.com/Kron4ek/Wine-Builds/releases/download/11.14/wine-11.14-amd64-wow64.tar.xz';

// GStreamer packages bundled for the Full variant (64-bit, Ubuntu jammy so
// the glibc floor is 2.35 — Ubuntu 22.04/Mint 21+). v4l2src (plugins-good)
// is what wine's winegstreamer uses for the webcam; libav supplies H.264.
const GST_PACKAGES = [
  'libgstreamer1.0-0',
  'libgstreamer-plugins-base1.0-0',
  'gstreamer1.0-plugins-good',
  // plugins-bad intentionally omitted: libav covers decode/encode (see
  // README) and bad pulls heavy deps (libblas3, libavfilter, ...). The ONE
  // exception is pipewiresrc for the Wayland bridge — fetched alone in
  // phase 3, never as part of the closure.
  'gstreamer1.0-libav',
  'libv4l-0',
  // libavcodec58 hard-depends libblas3/liblapack3 via ALTERNATIVE deps
  // (libblas3 | libatlas3-base | libopenblas-base) — resolution differs by
  // container state, so pin them explicitly or fresh caches miss them and
  // the ldd gate fails on libgstlibav.so.
  'libblas3',
  'liblapack3',
  // glib dlopens libpcre for regex — a Recommends, so --no-install-recommends
  // drops it; the gst-plugin-scanner links it directly.
  'libpcre3',
];

// Wayland screen-share bridge stack bundled for the Full variant (jammy
// 64-bit only). Xvfb links libGL/libGLX/libGLdispatch in its NEEDED set —
// the GL strip below stays mandatory, so those three resolve from the HOST
// mesa at runtime (always present in a graphical session); see the ldd gate
// allowlist below.
const BRIDGE_X_PACKAGES = [
  'xvfb', 'xserver-common', 'xkb-data', 'xauth', 'x11-xkb-utils', 'xdotool',
  'gstreamer1.0-tools', // gst-launch-1.0 + gst-inspect-1.0
  // Debian splits the X-dependent plugins (ximagesink/xvimagesink) out of
  // plugins-base into gstreamer1.0-x.
  'gstreamer1.0-x',
];

// python3 + dbus/gir ARE installed in the base image (apt needs python3), so
// `install --download-only` would skip them — `--reinstall` forces the fetch.
// Listed explicitly, no recommends.
const PY_PACKAGES = [
  'python3.10-minimal', 'libpython3.10-minimal', 'libpython3.10-stdlib',
  'python3.10', 'python3-minimal', 'python3',
  'python3-dbus', 'python3-gi', 'gir1.2-glib-2.0', 'gir1.2-girepository-2.0',
  'libgirepository-1.0-1', 'libffi8', 'libexpat1', 'libmpdec3', 'libdbus-1-3',
];

// Pipewiresrc: Ubuntu ships it in a DEDICATED package (gstreamer1.0-pipewire,
// 150KB, contains exactly libgstpipewire.so) — NOT in plugins-bad, whose
// closure (blas3/LLVM) must never land in the tree. All four debs extract
// whole; no closure, no cherry-pick needed. libspa-0.2-bluetooth is a hard
// Depends of libpipewire-0.3-0 on jammy (harmless if not — the ldd gate is
// self-correcting).
const PW_PACKAGES = [
  'gstreamer1.0-pipewire', 'libpipewire-0.3-0', 'libspa-0.2-modules',
  'libspa-0.2-bluetooth',
];

async function bundleWineRuntime() {
  const target = path.join(APP_DIR, 'native', 'wine-runtime');
  if (fs.existsSync(path.join(target, 'bin', 'wine'))) {
    logger.dim('wine runtime already bundled, skipping download');
    return;
  }
  const tarball = path.join(APP_DIR, 'native', 'wine-bundle.tar.xz');
  logger.info('Downloading portable wine (wow64) for the Full variant...');
  try {
    execSync(`curl -L --fail -o "${tarball}" "${WINE_DOWNLOAD_URL_WOW64}"`, {
      cwd: BASE_DIR, stdio: 'inherit'
    });
    fs.mkdirSync(target, { recursive: true });
    execSync(`tar -xf "${tarball}" -C "${target}" --strip-components=1`, {
      cwd: BASE_DIR, stdio: 'pipe'
    });
  } finally {
    try { fs.unlinkSync(tarball); } catch (e) { /* none */ }
  }
  if (!fs.existsSync(path.join(target, 'bin', 'wine'))) {
    throw new Error('wine binary not found after extract');
  }
  logger.success('wine runtime bundled into app/native/wine-runtime');
}

/**
 * Bundle a self-contained 64-bit GStreamer tree for the Full variant.
 * Uses a throwaway ubuntu:22.04 container so apt resolves the exact jammy
 * dependency closure (glibc excluded — the container image already ships
 * libc, so the download cache never includes it). Missing docker is NOT
 * fatal: the Full AppImage still builds and falls back to the host's 64-bit
 * GStreamer at runtime.
 */
// Everything the runtime needs beyond the plain gst libs (paths relative to
// the tree root): keeps a pre-bridge-era bundle from silently satisfying the
// skip gates (the CI temp cache is keyed on package-lock.json, which does
// not change when this file does).
const RUNTIME_MARKERS = [
  'usr/lib/x86_64-linux-gnu/libgstreamer-1.0.so.0',
  'usr/lib/x86_64-linux-gnu/gstreamer-1.0/libgstpipewire.so',
  'usr/lib/x86_64-linux-gnu/gstreamer-1.0/libgstximagesink.so',
  'usr/bin/Xvfb',
  'usr/bin/python3',
];

async function bundleGstRuntime() {
  const target = path.join(APP_DIR, 'native', 'gst-runtime');
  const libDir = path.join(target, 'usr', 'lib', 'x86_64-linux-gnu');
  if (RUNTIME_MARKERS.every((m) => fs.existsSync(path.join(target, m)))) {
    logger.dim('gst runtime already bundled, skipping');
    return;
  }

  // Staged under temp/ (gitignored + CI-cached) so both Full phases and
  // re-runs share one docker pass.
  const stage = path.join(BASE_DIR, 'temp', 'gst-debs');
  const stageRoot = path.join(stage, 'root');
  const stageLib = path.join(stageRoot, 'usr', 'lib', 'x86_64-linux-gnu');
  if (!RUNTIME_MARKERS.every((m) => fs.existsSync(path.join(stageRoot, m)))) {
    logger.info('Bundling 64-bit GStreamer + Wayland bridge stack (ubuntu:22.04 debs) for the Full variant...');
    fs.mkdirSync(stage, { recursive: true });
    // Script via a mounted file — nested shell quoting would eat `$f`.
    const ALL_PACKAGES = GST_PACKAGES.concat(BRIDGE_X_PACKAGES, PY_PACKAGES, PW_PACKAGES, ['libpcre3']);
    const script = [
      'set -e',
      'export DEBIAN_FRONTEND=noninteractive',
      'apt-get update -qq',
      // Fresh extract, but KEEP /out/cache: CI restores the deb cache there
      // and apt re-uses it (matching checksums skip the re-download).
      'rm -rf /out/root /out/cache-py /out/cache-pw',
      'mkdir -p /out/cache/partial /out/cache-py /out/cache-pw /out/root',
      // Silences "Download is performed unsandboxed as root" noise.
      'APT() { apt-get -o APT::Sandbox::User=root "$@"; }',
      // ---- Phase 1: gst runtime + X bridge stack (not installed in the
      // ---- image, so the full closure lands: xserver-common, xkb-data,
      // ---- libxfont2, libpixman, libxdo3, ...).
      'APT -o Dir::Cache::archives=/out/cache install -y -qq ' +
        '--download-only --no-install-recommends ' +
        GST_PACKAGES.concat(BRIDGE_X_PACKAGES).join(' '),
      // libpcre3 ships in the base image, so `install --download-only` skips
      // it — pull it explicitly (download ignores Dir::Cache::archives, so
      // run it from inside the cache dir).
      'cd /out/cache && APT download libpcre3 && cd /out',
      // ---- Phase 2: python closure. python3 IS installed in the base image,
      // ---- so plain download-only would skip it: --reinstall forces the
      // ---- re-download of the NAMED installed packages; uninstalled deps
      // ---- fetch normally.
      'APT -o Dir::Cache::archives=/out/cache-py install -y -qq ' +
        '--reinstall --download-only --no-install-recommends ' + PY_PACKAGES.join(' '),
      // ---- Phase 3: pipewiresrc, NO closure — the explicit list below
      // ---- (gstreamer1.0-pipewire contains exactly the plugin .so).
      'cd /out/cache-pw && APT download ' + PW_PACKAGES.join(' ') + ' && cd /out',
      // ---- Deterministic extraction: only debs belonging to the CURRENT
      // ---- closure. Blindly extracting every cached deb lets stale debs
      // ---- from earlier package sets leak into the tree (bloat + a local
      // ---- tree that differs from a fresh-CI tree — the libblas/liblapack
      // ---- incident). --reinstall in the dry-run forces already-installed
      // ---- packages into the Inst list.
      'APT -s --reinstall install --no-install-recommends ' + ALL_PACKAGES.join(' ') + ' > /out/plan.txt',
      "grep '^Inst ' /out/plan.txt | awk '{print $2}' | sort -u > /out/keep.txt",
      'for f in /out/cache/*.deb /out/cache-py/*.deb /out/cache-pw/*.deb; do',
      '  n=$(dpkg-deb -f "$f" Package 2>/dev/null || true)',
      '  if grep -qxF "$n" /out/keep.txt; then dpkg-deb -x "$f" /out/root; fi',
      'done',
      // root-owned inside the container — give everything back to the
      // invoking user (NOT just root/: leftover root-owned dirs like
      // cache/partial break `find` runs elsewhere in the build with
      // "Permission denied" exit codes).
      'chown -R "$HOST_UID:$HOST_GID" /out',
    ].join('\n');
    fs.writeFileSync(path.join(stage, 'fetch-gst.sh'), script);
    try {
      execSync(
        `docker run --rm -e HOST_UID=${process.getuid()} -e HOST_GID=${process.getgid()} ` +
        `-v "${stage}:/out" ubuntu:22.04 bash /out/fetch-gst.sh`, {
          cwd: BASE_DIR, stdio: 'inherit', timeout: 900000
        });
    } catch (e) {
      logger.warn('docker unavailable or failed — Full variant built WITHOUT bundled GStreamer ' +
        '(call video will need 64-bit gst on the host): ' + String(e.message).slice(-200));
      return;
    }
  }

  // Prune docs/systemd junk and make absolute symlinks relative so the tree
  // is relocatable. Also merge lib/ into usr/lib/ — a few debs still ship
  // files under /lib (pre-usr-merge layout), which the runtime
  // LD_LIBRARY_PATH entry would never see.
  for (const p of ['usr/share/doc', 'usr/share/man', 'etc', 'bin', 'sbin', 'var']) {
    fs.rmSync(path.join(stageRoot, p), { recursive: true, force: true });
  }
  const legacyLib = path.join(stageRoot, 'lib', 'x86_64-linux-gnu');
  if (fs.existsSync(legacyLib)) {
    fs.cpSync(legacyLib, path.join(stageRoot, 'usr', 'lib', 'x86_64-linux-gnu'), {
      recursive: true, force: true, verbatimSymlinks: true
    });
    fs.rmSync(path.join(stageRoot, 'lib'), { recursive: true, force: true });
  }

  // Strip the GL/mesa chain. apt forces it in via libgstreamer-gl (hard dep
  // of plugins-base) but it must NOT ship: our LD_LIBRARY_PATH is prepended
  // to the whole wine process, so a bundled libGL would shadow the host's
  // mesa and break ZaloCall rendering on GPUs newer than jammy's drivers.
  // The capture path (v4l2src, videoconvert, libav) never touches GL; gl
  // plugins simply fail to load and gst blacklists them silently.
  const gstLibDir = path.join(stageRoot, 'usr', 'lib', 'x86_64-linux-gnu');
  const GL_STRIP = [
    'dri', 'libLLVM-*.so.*', 'libGLX*.so.*', 'libGL.so.*', 'libEGL*.so.*',
    'libgbm.so.*', 'libglapi.so.*', 'libxatracker.so.*', 'libGLES*.so.*',
    'libOpenGL.so.*', 'libgallium*.so.*', 'libOSMesa.so.*', 'libglx-*.so.*',
    'gstreamer-1.0/libgstgl.so', 'gstreamer-1.0/libgstopengl*.so',
  ];
  for (const pattern of GL_STRIP) {
    const dir = path.dirname(pattern);
    const base = path.basename(pattern);
    let files = [];
    try { files = fs.readdirSync(path.join(gstLibDir, dir)); } catch (e) { continue; }
    for (const f of files) {
      if (f === base || (base.includes('*') && f.startsWith(base.split('*')[0]) && f.endsWith(base.split('*').pop()))) {
        fs.rmSync(path.join(gstLibDir, dir, f), { recursive: true, force: true });
      }
    }
  }
  const absLinks = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isSymbolicLink()) {
        const t = fs.readlinkSync(p);
        if (path.isAbsolute(t)) absLinks.push({ p, t });
      }
    }
  })(stageRoot);
  for (const { p, t } of absLinks) {
    const rel = path.relative(path.dirname(p), t);
    fs.unlinkSync(p);
    fs.symlinkSync(rel, p);
  }
  // Empty dir GST_PLUGIN_SYSTEM_PATH points at — isolates the wine process
  // from the host's (possibly different-version) system plugins.
  fs.mkdirSync(path.join(stageRoot, 'system'), { recursive: true });

  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(stageRoot, target, { recursive: true, verbatimSymlinks: true });

  const EXISTENCE_GATE = [
    ['usr/lib/x86_64-linux-gnu', 'libgstreamer-1.0.so.0'],
    ['usr/lib/x86_64-linux-gnu', 'gstreamer-1.0/libgstvideo4linux2.so'],
    ['usr/lib/x86_64-linux-gnu', 'gstreamer-1.0/libgstlibav.so'],
    ['usr/lib/x86_64-linux-gnu', 'gstreamer-1.0/libgstpipewire.so'],  // cherry-picked
    ['usr/lib/x86_64-linux-gnu', 'libpipewire-0.3.so.0'],
    ['usr/bin', 'Xvfb'], ['usr/bin', 'gst-launch-1.0'], ['usr/bin', 'gst-inspect-1.0'],
    ['usr/bin', 'python3'], ['usr/bin', 'python3.10'], ['usr/bin', 'xdotool'],
    ['usr/lib/python3.10', 'os.py'],     // stdlib actually extracted
  ];
  for (const [base, f] of EXISTENCE_GATE) {
    if (!fs.existsSync(path.join(target, base, f))) {
      throw new Error('gst bundle incomplete after extraction: ' + base + '/' + f);
    }
  }

  // Every NEEDED entry of the key libs must resolve inside the bundle (the
  // runtime LD_LIBRARY_PATH contains ONLY this dir — a missing dep would be
  // a hard dlopen failure at call time, so fail the build now).
  // Xvfb is the one intentional exception: it links libGL/libGLX/
  // libGLdispatch DIRECTLY (checked: host ldd shows them) and must resolve
  // them from the HOST mesa — bundling GL is forbidden (it would shadow the
  // host mesa for the wine process too). Every graphical session ships mesa,
  // so this is always satisfiable where Wayland sharing can exist.
  const LDD_GATE = [
    'libgstreamer-1.0.so.0', 'gstreamer-1.0/libgstvideo4linux2.so',
    'gstreamer-1.0/libgstlibav.so', 'gstreamer-1.0/libgstpipewire.so',
    'libpipewire-0.3.so.0', '../../bin/Xvfb', '../../bin/gst-launch-1.0',
    '../../bin/gst-inspect-1.0', '../../bin/xdotool', '../../bin/python3.10',
  ];
  try {
    // python C-extensions live under usr/lib/python3/dist-packages (NOT the
    // multiarch dir) — resolve their real names by readdir.
    const pyMods = [];
    for (const pat of ['_dbus_bindings*.so', 'gi/_gi*.so']) {
      const dir = path.join(target, 'usr', 'lib', 'python3', 'dist-packages', path.dirname(pat));
      let entries = [];
      try { entries = fs.readdirSync(dir); } catch (e) { continue; }
      for (const e of entries) {
        if (e.startsWith(path.basename(pat).split('*')[0])) pyMods.push(path.join(dir, e));
      }
    }
    const lddFiles = LDD_GATE.map((f) => path.join(libDir, f)).concat(pyMods);
    const missing = [];
    for (const f of lddFiles) {
      const out = execSync(`LD_LIBRARY_PATH="${libDir}" ldd "${f}"`, {
        encoding: 'utf8', stdio: 'pipe'
      });
      for (const line of out.split('\n')) {
        // Host-resolved-by-design for Xvfb only.
        if (line.includes('not found') &&
            !(f.includes('Xvfb') && /libGL|libGLdispatch|libGLX/.test(line))) {
          missing.push(path.basename(f) + ' -> ' + line.trim());
        }
      }
    }
    if (missing.length) {
      throw new Error('gst bundle has unresolved deps:\n' + missing.join('\n'));
    }
    logger.dim('gst bundle deps self-contained (' + (LDD_GATE.length + pyMods.length) + ' files checked)');
  } catch (e) {
    if (String(e.message).includes('unresolved deps')) throw e;
    logger.warn('ldd dep check skipped (ldd unavailable): ' + String(e.message).slice(-120));
  }

  // Smoke-verify plugin loadability with RTLD_NOW (stricter than a lazy
  // load; catches symbol-level breakage the ldd check cannot). gst's own
  // scanner is unsuitable here — it speaks a pipe protocol when invoked
  // directly.
  try {
    const probe = path.join(stage, 'dlopen-probe.c');
    fs.writeFileSync(probe, [
      '#include <dlfcn.h>',
      '#include <stdio.h>',
      'int main(int c,char**v){for(int i=1;i<c;i++){void*h=dlopen(v[i],RTLD_NOW);',
      'if(!h){fprintf(stderr,"dlopen FAIL %s: %s\\n",v[i],dlerror());return 1;}}return 0;}',
    ].join('\n'));
    execSync(`gcc "${probe}" -ldl -o "${stage}/dlopen-probe" && ` +
      `LD_LIBRARY_PATH="${libDir}" "${stage}/dlopen-probe" ` +
      `"${libDir}/gstreamer-1.0/libgstvideo4linux2.so" "${libDir}/gstreamer-1.0/libgstlibav.so" ` +
      `"${libDir}/gstreamer-1.0/libgstpipewire.so"`, {
      cwd: BASE_DIR, stdio: 'pipe', timeout: 60000
    });
    logger.dim('gst bundle verified (video4linux2 + libav + pipewire dlopen with RTLD_NOW)');
  } catch (e) {
    logger.warn('gst plugin dlopen check skipped/failed: ' + String(e.stderr || e.message).trim().slice(-300));
  }

  // ---- Gate (b): bundled python must import dbus + gi against the bundled
  // ---- tree (HARD — a failure here breaks the whole bridge on user machines).
  try {
    const pyEnv = {
      PATH: process.env.PATH || '/usr/bin:/bin',
      LD_LIBRARY_PATH: libDir,
      PYTHONHOME: target + '/usr',
      PYTHONPATH: [
        target + '/usr/lib/python3.10',
        target + '/usr/lib/python3.10/lib-dynload',
        target + '/usr/lib/python3/dist-packages',
      ].join(':'),
      PYTHONNOUSERSITE: '1',
      GI_TYPELIB_PATH: libDir + '/girepository-1.0',
    };
    execSync(`"${target}/usr/bin/python3.10" -c "import dbus; import dbus.mainloop.glib; from gi.repository import GLib; print('py-ok')"`, {
      cwd: BASE_DIR, stdio: 'pipe', timeout: 60000, env: pyEnv
    });
    logger.dim('gate (b): bundled python imports dbus + gi OK');
  } catch (e) {
    throw new Error('gate (b) FAILED — bundled python cannot import dbus/gi:\n' +
      String(e.stderr || e.message).trim().slice(-500));
  }

  // ---- Gate (c): bundled gst-inspect must register the bridge elements
  // ---- (HARD). Inspect exits 1 when the element did not register — the
  // ---- plugin-dlopen/registration failure signal we want.
  try {
    const gstEnv = {
      PATH: process.env.PATH || '/usr/bin:/bin',
      LD_LIBRARY_PATH: libDir,
      GST_PLUGIN_PATH: libDir + '/gstreamer-1.0',
      GST_PLUGIN_SYSTEM_PATH: target + '/system',
      GST_PLUGIN_SCANNER: libDir + '/gstreamer1.0/gstreamer-1.0/gst-plugin-scanner',
      GST_REGISTRY: stage + '/registry-bridge-test.bin',
    };
    for (const el of ['pipewiresrc', 'ximagesink', 'videoconvert']) {
      execSync(`"${target}/usr/bin/gst-inspect-1.0" ${el}`, {
        cwd: BASE_DIR, stdio: 'pipe', timeout: 60000, env: gstEnv
      });
    }
    logger.dim('gate (c): bundled gst-inspect registers pipewiresrc + ximagesink + videoconvert');
  } catch (e) {
    throw new Error('gate (c) FAILED — bundled gst cannot register bridge elements:\n' +
      String(e.stderr || e.message).trim().slice(-500));
  }

  // ---- Gate (d): bundled Xvfb must start WITHOUT bundled GL (GLX module
  // ---- cannot load its libGL from the bundle — that is by design; Xvfb
  // ---- must survive anyway, since ximagesink never needs GLX). HARD.
  try {
    let display = null;
    for (let n = 90; n <= 99 && !display; n++) {
      if (!fs.existsSync(`/tmp/.X${n}-lock`) && !fs.existsSync(`/tmp/.X11-unix/X${n}`)) display = ':' + n;
    }
    if (display) {
      const xvfb = spawn(target + '/usr/bin/Xvfb', [display, '-screen', '0', '320x240x24'], {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { PATH: process.env.PATH || '/usr/bin:/bin', LD_LIBRARY_PATH: libDir },
      });
      let stderrBuf = '';
      xvfb.stderr.on('data', (d) => { stderrBuf += d; });
      await new Promise((resolve) => setTimeout(resolve, 3500));
      if (xvfb.exitCode !== null) {
        throw new Error('Xvfb died at startup:\n' + stderrBuf.slice(-600));
      }
      xvfb.kill('SIGTERM');
      const fatal = stderrBuf.split('\n').filter((l) =>
        /Fatal server error|Server is already active|\(EE\)/.test(l) &&
        !/glx|GLX|Failed to load module|keymap|xkb|font|XKB/i.test(l));
      if (fatal.length) {
        throw new Error('Xvfb fatal markers in stderr:\n' + fatal.join('\n').slice(-600));
      }
      logger.dim(`gate (d): bundled Xvfb smoke OK on ${display} (no GLX module)`);
    } else {
      logger.warn('gate (d) skipped: no free X display in :90-:99');
    }
  } catch (e) {
    throw new Error('gate (d) FAILED — bundled Xvfb unusable without bundled GL:\n' +
      String(e.message).slice(-600));
  }

  logger.success('gst runtime + Wayland bridge stack bundled into app/native/gst-runtime');
}

/**
 * Package the bundled GStreamer tree as the per-version release asset the
 * standard variants download at first-run setup (gst-runtime-<ver>.tar.xz).
 * Must be called while app/native/gst-runtime still exists (main() does this
 * right after the Phase 3 Full build, before the rmSync cleanup).
 */
async function packageGstAsset() {
  const target = path.join(APP_DIR, 'native', 'gst-runtime');
  const marker = path.join(target, 'usr', 'lib', 'x86_64-linux-gnu', 'libgstreamer-1.0.so.0');
  if (!fs.existsSync(marker)) {
    logger.warn('no gst runtime to package (docker bundle failed?) — standard variants will fall back to host 64-bit gst');
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, 'gst_runtime_file=\ngst_runtime_name=\n');
    }
    return;
  }
  const name = `gst-runtime-${ZALO_VERSION || 'unknown'}.tar.xz`;
  const file = path.join(BASE_DIR, 'dist', name);
  logger.info('Packaging GStreamer runtime release asset: dist/' + name + ' ...');
  // xz default level: ~340MB tree, mostly binary — roughly 30-90s on CI.
  // Size matters (every standard user downloads this), speed does not.
  fs.mkdirSync(path.join(BASE_DIR, 'dist'), { recursive: true });
  execSync(`tar -cJf "${file}" -C "${target}" .`, { cwd: BASE_DIR, stdio: 'pipe' });
  logger.success('gst release asset: ' + name + ' (' + Math.round(fs.statSync(file).size / 1024 / 1024) + 'MB)');
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `gst_runtime_file=${'dist/' + name}\ngst_runtime_name=${name}\n`);
  }
}

async function integrateZaDark() {
  logger.info('Applying ZaDark patches...');

  try {
    // Verify ZaDark module is available
    const zadarkModulePath = path.join(BASE_DIR, 'plugins', 'zadark', 'build', 'pc', 'zadark-pc.js');
    if (!fs.existsSync(zadarkModulePath)) {
      throw new Error('ZaDark PC module not found - run "npm run prepare-zadark" first');
    }

    const zadarkPC = require(zadarkModulePath);
    zadarkPC.copyZaDarkAssets(BASE_DIR);
    zadarkPC.writeIndexFile(BASE_DIR);
    zadarkPC.writeBootstrapFile(BASE_DIR);
    zadarkPC.writePopupViewerFile(BASE_DIR);
    logger.success('ZaDark patches applied successfully');

  } catch (error) {
    logger.error('ZaDark integration failed:', error.message);
    logger.info('Continuing with original app directory...');
  }
}

async function build(buildName = '', outputSuffix = '') {
  try {
    // Get git commit hash for filename
    const commitHash = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();

    // Set artifact name and build command based on build type
    let artifactName;
    let buildCommand;
    let zadarkVersion = null;

    if (outputSuffix === '-ZaDark' || outputSuffix === '-Full') {
      // Read ZaDark version for custom naming (the Full variant also builds
      // on the ZaDark-integrated app directory)
      const zadarkPackagePath = path.join(BASE_DIR, 'plugins', 'zadark', 'package.json');
      zadarkVersion = 'unknown';

      if (fs.existsSync(zadarkPackagePath)) {
        try {
          const zadarkPackage = JSON.parse(fs.readFileSync(zadarkPackagePath, 'utf8'));
          zadarkVersion = zadarkPackage.version;
        } catch (error) {
          logger.warn('Could not read ZaDark version, using "unknown"');
        }
      }

      artifactName = `Zalo-${ZALO_VERSION}+ZaDark-${zadarkVersion}-${commitHash}${outputSuffix}.AppImage`;
      buildCommand = `npx electron-builder --linux --config.linux.artifactName="${artifactName}" -c.extraMetadata.version=${ZALO_VERSION} --publish=never`;
      logger.info(`Building ${buildName} with Zalo: ${ZALO_VERSION}, ZaDark: ${zadarkVersion}, Commit: ${commitHash}`);
    } else if (outputSuffix === '-PlainFull') {
      artifactName = `Zalo-${ZALO_VERSION}-${commitHash}-Full.AppImage`;
      buildCommand = `npx electron-builder --linux --config.linux.artifactName="${artifactName}" -c.extraMetadata.version=${ZALO_VERSION} --publish=never`;
      logger.info(`Building ${buildName} with Zalo: ${ZALO_VERSION}, Commit: ${commitHash}`);
    } else {
      artifactName = `Zalo-${ZALO_VERSION}-${commitHash}.AppImage`;
      buildCommand = `npx electron-builder --linux --config.linux.artifactName="${artifactName}" -c.extraMetadata.version=${ZALO_VERSION} --publish=never`;
      logger.info(`Building ${buildName} with Zalo: ${ZALO_VERSION}, Commit: ${commitHash}`);
    }
    // Write build-info.json to the app directory so the AppImage will contain its metadata
    let repository = process.env.GITHUB_REPOSITORY || null;
    if (!repository) {
      try {
        const remote = execSync('git remote get-url origin', { encoding: 'utf8', stdio: 'pipe' }).trim();
        const m = remote.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
        if (m) repository = m[1] + '/' + m[2];
      } catch (e) { /* no git remote — asset downloads will fall back to host gst */ }
    }
    const buildInfo = {
      version: ZALO_VERSION,
      zadarkVersion: (outputSuffix === '-ZaDark' || outputSuffix === '-Full') ? zadarkVersion : null,
      commit: commitHash,
      buildDate: new Date().toISOString(),
      // Which GitHub repo hosts this build's release assets (gst-runtime
      // first-run download). CI: github.repository; local: derived from the
      // origin remote — so forks host their own assets automatically.
      repository,
    };
    
    const buildInfoPath = path.join(APP_DIR, 'pc-dist', 'build-info.json');
    if (fs.existsSync(path.join(APP_DIR, 'pc-dist'))) {
      fs.writeFileSync(buildInfoPath, JSON.stringify(buildInfo, null, 2), 'utf8');
      logger.dim(`Wrote metadata: ${buildInfoPath}`);
    } else {
      logger.warn('pc-dist directory not found, skipping build-info.json');
    }

    logger.dim(`Command: ${buildCommand}`);

    // Capture build output to get file information
    const buildOutput = execSync(buildCommand, {
      stdio: 'pipe',
      cwd: path.join(BASE_DIR),
      encoding: 'utf8'
    });

    // Parse build output to find AppImage file
    const appImageMatch = buildOutput.match(/file=(dist\/.*\.AppImage)/);
    let appImageFile = null;
    let appImageName = null;

    if (appImageMatch) {
      appImageFile = appImageMatch[1];
      appImageName = path.basename(appImageFile);

      // Get file size
      if (fs.existsSync(path.join(BASE_DIR, appImageFile))) {
        const fullPath = path.join(BASE_DIR, appImageFile);
        const size = fs.statSync(fullPath).size;
        const sizeStr = size > 1024 * 1024
          ? `${Math.round(size / 1024 / 1024)}MB`
          : `${Math.round(size / 1024)}KB`;

        // Calculate SHA256 for logging
        let fileSha256 = 'unknown';
        try {
          const sha256Output = execSync(`sha256sum "${fullPath}"`, { encoding: 'utf8' });
          fileSha256 = sha256Output.split(' ')[0];
        } catch (error) {
          logger.warn('Could not calculate SHA256');
        }
        
        logger.success(`Built ${appImageName} (${sizeStr})`);
        logger.dim(`SHA256: ${fileSha256}`);
        
        builtFiles.push({
          type: outputSuffix === '-Full' ? '🍷 Full (ZaDark)' : outputSuffix === '-PlainFull' ? '🍷 Full' : outputSuffix === '-ZaDark' ? '🎨 ZaDark' : '📦 Original',
          name: appImageName,
          sizeStr
        });
      } else {
        logger.warn(`AppImage file not found: ${appImageFile}`);
      }
    } else {
      logger.warn('Could not find AppImage path in build output');
    }

    // Export build info to GitHub Actions
    if (process.env.GITHUB_OUTPUT) {
      const prefix = outputSuffix === '-PlainFull' ? 'plainfull_' : outputSuffix === '-Full' ? 'full_' : outputSuffix === '-ZaDark' ? 'zadark_' : 'original_';

      // Export build-specific info
      const specificOutputs = [
        `${prefix}appimage_file=${appImageFile || ''}`,
        `${prefix}appimage_name=${appImageName || ''}`
      ];

      specificOutputs.forEach(output => {
        fs.appendFileSync(process.env.GITHUB_OUTPUT, output + '\n');
      });

      logger.dim(`Exported ${prefix.replace('_', '')} build info to GitHub Actions`);
    }
  } catch (error) {
    logger.error('Build failed:', error.message);
    if (error.stdout) logger.dim('STDOUT:', error.stdout.toString());
    if (error.stderr) logger.dim('STDERR:', error.stderr.toString());
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main, bundleWineRuntime, bundleGstRuntime, packageGstAsset };