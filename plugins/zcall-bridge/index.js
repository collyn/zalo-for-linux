/**
 * plugins/zcall-bridge/index.js
 *
 * zcall call-v2 Wine environment manager.
 *
 * Zalo 26.x runs calls through a Qt helper (ZaloCall.exe on Windows). On
 * Linux, the patched main-dist code (scripts/patches/patch-zcall-callv2.js)
 * spawns the Windows ZaloCall.exe under Wine, bridged over named pipes ->
 * TCP by pipebridge.exe (see app/native/qt-call-and-cap/).
 *
 * This plugin prepares the environment before any call can happen:
 *   1. Locates a wine binary: env ZCALL_WINE -> `wine` in PATH -> Bottles
 *      kron4ek runner -> previously downloaded runtime (userData).
 *   2. If no wine is found on first run, ASKS the user (friendly dialog)
 *      and downloads a portable wine (~100MB) into
 *      <userData>/zcall-wine-runtime/ with a progress window — no root
 *      needed, works on any distro.
 *   3. Ensures the wine prefix exists (wineboot), exports
 *      ZCALL_WINE / ZCALL_WINEPREFIX / WINEDEBUG into process.env.
 *   4. On quit, kills the whole wine session of our prefix.
 *
 * Configuration (env vars):
 *   ZCALL_WINE                 wine binary (highest priority)
 *   ZCALL_WINEPREFIX           wine prefix (default: <userData>/zcall-wine)
 *   ZCALL_DISABLE              set to anything to skip entirely
 *   ZCALL_AUTO_SETUP           '1' to download wine silently (no dialog)
 *   ZCALL_WINE_DOWNLOAD_URL    override the portable wine download URL
 */

'use strict';

const { spawn, spawnSync, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

// Lightest verified build (54MB download / ~565MB extracted; wine 11.x is
// 96MB / 852MB). 8.6 chosen over 7.22/8.0.1 for a more mature wow64 while
// keeping the same weight.
const WINE_DOWNLOAD_URL =
  'https://github.com/Kron4ek/Wine-Builds/releases/download/8.6/wine-8.6-amd64.tar.xz';
const RUNTIME_DIRNAME = 'zcall-wine-runtime';
const CONFIG_FILENAME = 'zcall-config.json';

let dialogModule = null;
let BrowserWindowModule = null;
let NotificationModule = null;

function getElectronModules() {
  try {
    const electron = require('electron');
    dialogModule = electron.dialog;
    BrowserWindowModule = electron.BrowserWindow;
    NotificationModule = electron.Notification;
  } catch (e) { /* not running inside Electron (unit tests) */ }
}

// ---------------------------------------------------------------------------
// Config (per-user choices, stored in userData)
// ---------------------------------------------------------------------------

function readConfig(userDataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(userDataDir, CONFIG_FILENAME), 'utf8'));
  } catch (e) {
    return {};
  }
}

function writeConfig(userDataDir, cfg) {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(path.join(userDataDir, CONFIG_FILENAME), JSON.stringify(cfg, null, 2));
  } catch (e) {
    console.error('[zcall-bridge] could not write config:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Wine discovery
// ---------------------------------------------------------------------------

function findWine() {
  if (process.env.ZCALL_WINE) return process.env.ZCALL_WINE;

  // 1. wine from PATH
  const which = spawnSync('which', ['wine'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();

  // 2. Bottles flatpak kron4ek runners (known-good on this setup)
  const runnersRoot = path.join(os.homedir(), '.var', 'app', 'com.usebottles.bottles', 'data', 'bottles', 'runners');
  if (fs.existsSync(runnersRoot)) {
    const entries = fs.readdirSync(runnersRoot).sort().reverse();
    for (const name of entries) {
      if (!/^kron4ek-wine/.test(name)) continue;
      const candidate = path.join(runnersRoot, name, 'bin', 'wine');
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  return null;
}

function findDownloadedWine(userDataDir) {
  const p = path.join(userDataDir, RUNTIME_DIRNAME, 'bin', 'wine');
  return fs.existsSync(p) ? p : null;
}

/**
 * Verify that this wine can actually run 32-bit executables (ZaloCall is a
 * PE32 binary). Runs pipebridge.exe --version (a 32-bit exe) with a timeout.
 * Returns true only when it prints the expected output.
 */
function validateWine(winePath, prefix) {
  const pipebridgePath = path.join(__dirname, '..', '..', 'app', 'native', 'qt-call-and-cap', 'pipebridge.exe');
  if (!fs.existsSync(pipebridgePath)) return false;
  try {
    const res = spawnSync(winePath, [pipebridgePath, '--version'], {
      env: Object.assign({}, process.env, { WINEPREFIX: prefix, WINEDEBUG: '-all' }),
      encoding: 'utf8',
      timeout: 30000
    });
    return res.status === 0 && /pipebridge/.test(res.stdout || '');
  } catch (e) {
    return false;
  }
}

/**
 * Kill leftover wine processes of OUR prefix (e.g. winedevice orphans left
 * by an unclean kill -9 of a previous session). Safe to run at launch: no
 * legit session exists yet.
 */
function sweepStaleProcesses(prefix) {
  try {
    for (const name of ['wineserver', 'winedevice.exe']) {
      let out = '';
      try { out = execSync('pgrep -x ' + name, { encoding: 'utf8' }); } catch (_) { continue; }
      for (const pid of out.trim().split('\n')) {
        if (!pid) continue;
        let env = '';
        try { env = fs.readFileSync('/proc/' + pid + '/environ', 'utf8'); } catch (_) { continue; }
        if (env.includes(prefix)) {
          process.kill(Number(pid), 'SIGKILL');
        }
      }
    }
  } catch (_) { /* nothing stale */ }
}

// ---------------------------------------------------------------------------
// Portable wine download + extract
// ---------------------------------------------------------------------------

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        return downloadFile(res.headers.location, dest, onProgress).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(dest); } catch (e) { /* ignore */ }
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let got = 0;
      res.on('data', (chunk) => {
        got += chunk.length;
        if (onProgress && total) onProgress(got, total);
      });
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (e) => {
      file.close();
      try { fs.unlinkSync(dest); } catch (_) { /* ignore */ }
      reject(e);
    });
  });
}

async function installDownloadedWine(userDataDir, onProgress) {
  const runtimeDir = path.join(userDataDir, RUNTIME_DIRNAME);
  const tarball = path.join(userDataDir, 'zcall-wine-download.tar.xz');
  const url = process.env.ZCALL_WINE_DOWNLOAD_URL || WINE_DOWNLOAD_URL;

  fs.mkdirSync(userDataDir, { recursive: true });
  await downloadFile(url, tarball, onProgress);

  fs.mkdirSync(runtimeDir, { recursive: true });
  execSync(`tar -xf "${tarball}" -C "${runtimeDir}" --strip-components=1`, { stdio: 'pipe' });
  fs.unlinkSync(tarball);

  const wine = path.join(runtimeDir, 'bin', 'wine');
  if (!fs.existsSync(wine)) throw new Error('wine binary not found after extract');
  return wine;
}

// ---------------------------------------------------------------------------
// Friendly setup UI (ask -> progress window -> notification)
// ---------------------------------------------------------------------------

let askWindowOpen = false;

/**
 * Custom always-on-top ask window (native dialogs can get covered by the
 * Zalo main window on Linux DEs). Resolves with the user's choice.
 */
function showAskWindow(failedWine) {
  const { ipcMain } = require('electron');
  const win = new BrowserWindowModule({
    width: 540,
    height: 280,
    frame: false,
    resizable: false,
    movable: true,
    center: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    // Tiny internal window with static HTML — node integration is safe here.
    webPreferences: { contextIsolation: false, nodeIntegration: true }
  });
  const downloadUrl = process.env.ZCALL_WINE_DOWNLOAD_URL || WINE_DOWNLOAD_URL;
  const headLine = failedWine
    ? 'Wine trên máy bạn không tương thích với tính năng gọi (không chạy được ứng dụng 32-bit). Tải bản Wine tương thích?'
    : 'Tính năng gọi điện cần Wine. Tải và bật ngay bây giờ?';
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{font-family:sans-serif;background:#1f1f1f;color:#eee;margin:0;padding:20px 24px;-webkit-app-region:drag}
    h3{margin:0 0 8px;font-size:16px}
    p{font-size:13px;color:#ccc;margin:0 0 10px;line-height:1.45}
    #url{font-size:11px;color:#6ab;text-overflow:ellipsis;overflow:hidden;white-space:nowrap;cursor:pointer;margin-bottom:14px;-webkit-app-region:no-drag}
    label{font-size:13px;color:#ccc;display:block;margin-bottom:16px;-webkit-app-region:no-drag}
    .row{display:flex;justify-content:flex-end;gap:10px;-webkit-app-region:no-drag}
    button{font-size:13px;padding:8px 18px;border-radius:6px;border:none;cursor:pointer}
    #yes{background:#0a6e3c;color:#fff}
    #no{background:#3a3a3a;color:#eee}
  </style></head><body>
    <h3>Zalo — Tính năng gọi điện</h3>
    <p>${headLine}<br>
       Sẽ tải ~54MB về lưu trong dữ liệu của Zalo — không cần quyền quản trị,
       không ảnh hưởng hệ thống.</p>
    <div id="url" title="Mở nguồn tải trong trình duyệt">Nguồn tải: ${downloadUrl}</div>
    <label><input type="checkbox" id="never"> Không hỏi lại lần sau nếu không tải</label>
    <div class="row">
      <button id="no">Để sau</button>
      <button id="yes">Tải và bật ngay</button>
    </div>
    <script>
      const {ipcRenderer, shell} = require('electron');
      function answer(download) {
        ipcRenderer.send('zcall-ask-result', {
          download,
          neverAgain: document.getElementById('never').checked
        });
      }
      document.getElementById('yes').onclick = () => answer(true);
      document.getElementById('no').onclick = () => answer(false);
      document.getElementById('url').onclick = () => shell.openExternal('${downloadUrl}');
    </script>
  </body></html>`;
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

  return new Promise((resolve) => {
    const onResult = (_e, result) => {
      ipcMain.removeListener('zcall-ask-result', onResult);
      try { win.close(); } catch (e) { /* already closed */ }
      resolve(result || { download: false, neverAgain: false });
    };
    ipcMain.on('zcall-ask-result', onResult);
    // fallback: user closed the window somehow
    win.on('closed', () => {
      ipcMain.removeListener('zcall-ask-result', onResult);
      resolve({ download: false, neverAgain: false });
    });
  });
}

function showProgressWindow() {
  const win = new BrowserWindowModule({
    width: 520,
    height: 165,
    frame: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    // Tiny internal window with static HTML — node integration is safe here.
    webPreferences: { contextIsolation: false, nodeIntegration: true }
  });
  const downloadUrl = process.env.ZCALL_WINE_DOWNLOAD_URL || WINE_DOWNLOAD_URL;
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{font-family:sans-serif;background:#1f1f1f;color:#eee;margin:0;padding:18px 22px;-webkit-app-region:drag}
    h3{margin:0 0 6px;font-size:15px} p{margin:0 0 12px;font-size:12px;color:#aaa}
    progress{width:100%;height:14px}
    #label{font-size:12px;color:#aaa;margin-top:8px}
    #url{font-size:11px;color:#6ab;margin-top:8px;text-overflow:ellipsis;overflow:hidden;white-space:nowrap;cursor:pointer}
  </style></head><body>
    <h3>Zalo — Tính năng gọi điện</h3>
    <p>Đang tải Wine (~54MB), vui lòng chờ…</p>
    <progress id="bar" max="100" value="0"></progress>
    <div id="label">0%</div>
    <div id="url" title="Mở nguồn tải trong trình duyệt">${downloadUrl}</div>
    <script>
      const {ipcRenderer, shell} = require('electron');
      ipcRenderer.on('progress', (e, pct, text) => {
        document.getElementById('bar').value = pct;
        document.getElementById('label').textContent = text;
      });
      document.getElementById('url').onclick = () => {
        shell.openExternal('${downloadUrl}');
      };
    </script>
  </body></html>`;
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  return {
    set(pct, text) {
      try { win.webContents.send('progress', pct, text); } catch (e) { /* window closed */ }
    },
    close() {
      try { win.close(); } catch (e) { /* already closed */ }
    }
  };
}

async function promptAndInstall(userDataDir, failedWine) {
  getElectronModules();
  if (!BrowserWindowModule) return null;
  if (askWindowOpen) return null; // never show two ask windows
  askWindowOpen = true;

  let result;
  try {
    result = await showAskWindow(failedWine);
  } finally {
    askWindowOpen = false;
  }

  if (!result.download) {
    // "Để sau": ask again on next launch; ticked "không hỏi lại" -> never.
    writeConfig(userDataDir, { wineSetup: result.neverAgain ? 'declined-permanent' : 'declined' });
    return null;
  }

  const progress = showProgressWindow();
  try {
    let lastUpdate = 0;
    const wine = await installDownloadedWine(userDataDir, (got, total) => {
      const now = Date.now();
      if (now - lastUpdate < 500) return; // throttle IPC updates
      lastUpdate = now;
      const pct = Math.round((got / total) * 100);
      progress.set(pct, `Đang tải… ${Math.round(got / 1024 / 1024)}MB / ${Math.round(total / 1024 / 1024)}MB (${pct}%)`);
    });
    progress.set(100, 'Đang giải nén và chuẩn bị…');

    // First prefix init (~10-30s, done once)
    const prefix = process.env.ZCALL_WINEPREFIX || path.join(userDataDir, 'zcall-wine');
    spawnSync(wine, ['wineboot', '-u'], {
      env: Object.assign({}, process.env, { WINEPREFIX: prefix, WINEDEBUG: '-all' }),
      stdio: 'ignore',
      timeout: 180000
    });

    progress.close();

    process.env.ZCALL_WINE = wine;
    process.env.ZCALL_WINEPREFIX = prefix;
    if (!process.env.WINEDEBUG) process.env.WINEDEBUG = '-all';
    writeConfig(userDataDir, { wineSetup: 'ready' });

    if (NotificationModule && NotificationModule.isSupported()) {
      new NotificationModule({
        title: 'Zalo',
        body: 'Tính năng gọi điện đã sẵn sàng! Hãy thử gọi một cuộc.'
      }).show();
    }
    return wine;
  } catch (e) {
    progress.close();
    const parent = BrowserWindowModule.getFocusedWindow() || BrowserWindowModule.getAllWindows()[0];
    if (dialogModule) {
      await dialogModule.showMessageBox(parent, {
        type: 'error',
        title: 'Zalo — Tính năng gọi điện',
        message: 'Không thể tải Wine',
        detail: String((e && e.message) || e) + '\n\nBạn có thể thử lại từ menu khay hệ thống, hoặc cài Wine bằng lệnh: sudo apt install wine'
      });
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function launch({ userDataDir }) {
  if (process.env.ZCALL_DISABLE) return false;

  const prefix = process.env.ZCALL_WINEPREFIX || path.join(userDataDir, 'zcall-wine');
  const downloadedWine = findDownloadedWine(userDataDir);
  let wine = process.env.ZCALL_WINE || findWine() || downloadedWine;

  // Clean stale wine processes from unclean previous exits
  sweepStaleProcesses(prefix);

  let failedWine = null;
  if (wine) {
    // Ensure the prefix exists before validating (validation needs a booted prefix)
    if (!fs.existsSync(path.join(prefix, 'drive_c'))) {
      console.log('[zcall-bridge] initializing wine prefix:', prefix);
      try {
        spawnSync(wine, ['wineboot', '-u'], {
          env: Object.assign({}, process.env, { WINEPREFIX: prefix, WINEDEBUG: '-all' }),
          stdio: 'ignore',
          timeout: 180000
        });
      } catch (e) {
        console.error('[zcall-bridge] wineboot failed:', e.message);
      }
    }

    // A found wine is only usable if it can run 32-bit executables. The
    // downloaded runtime is known-good, so skip the check for it.
    if (wine !== downloadedWine && !validateWine(wine, prefix)) {
      console.error('[zcall-bridge] wine cannot run 32-bit apps, treating as unavailable:', wine);
      failedWine = wine;
      wine = null;
    }
  }

  if (!wine) {
    // No usable wine: ask the user (async — never block the ready handler).
    // Silent only when the user ticked "không hỏi lại" on a previous
    // decline, unless ZCALL_AUTO_SETUP=1 forces a silent download.
    const cfg = readConfig(userDataDir);
    if (cfg.wineSetup === 'declined-permanent' && process.env.ZCALL_AUTO_SETUP !== '1') {
      console.error('[zcall-bridge] wine setup declined permanently — calls unavailable');
      return false;
    }
    console.log('[zcall-bridge] no usable wine, prompting user to set up...');
    promptAndInstall(userDataDir, failedWine).then((w) => {
      if (w) console.log('[zcall-bridge] portable wine ready:', w);
    }).catch((e) => console.error('[zcall-bridge] setup failed:', e.message));
    return false;
  }

  // Export for the patched main-dist spawn code
  process.env.ZCALL_WINE = wine;
  process.env.ZCALL_WINEPREFIX = prefix;
  if (!process.env.WINEDEBUG) process.env.WINEDEBUG = '-all';

  console.log('[zcall-bridge] wine ready:', wine, '(prefix:', prefix + ')');
  return true;
}

function openSetupDialog({ userDataDir }) {
  getElectronModules();
  const wine = process.env.ZCALL_WINE || findWine() || findDownloadedWine(userDataDir);
  if (wine) {
    if (dialogModule) {
      dialogModule.showMessageBox({
        type: 'info',
        title: 'Zalo — Tính năng gọi điện',
        message: 'Tính năng gọi điện đang hoạt động',
        detail: 'Wine đang dùng: ' + wine
      });
    }
    return;
  }
  promptAndInstall(userDataDir);
}

function shutdown() {
  // Kill the whole wine session for our prefix: ZaloCall.exe dies with the
  // app (the call-v2 module kills it), but pipebridge.exe is spawned
  // fire-and-forget and would keep wineserver alive forever. wineserver -k
  // terminates wineserver and every wine client in this prefix.
  const wine = process.env.ZCALL_WINE;
  const prefix = process.env.ZCALL_WINEPREFIX;
  if (!wine || !prefix) return;

  const wineserverPath = path.join(path.dirname(wine), 'wineserver');
  if (!fs.existsSync(wineserverPath)) return;

  try {
    spawnSync(wineserverPath, ['-k'], {
      env: Object.assign({}, process.env, { WINEPREFIX: prefix, WINEDEBUG: '-all' }),
      stdio: 'ignore',
      timeout: 10000
    });
  } catch (e) {
    console.error('[zcall-bridge] wineserver -k failed:', e.message);
  }

  // Hard-kill any lingering wine processes that still serve OUR prefix (the
  // -k above normally suffices, but during quit races a fresh server can
  // appear or winedevice can outlive its killed server).
  try {
    for (const name of ['wineserver', 'winedevice.exe']) {
      let out = '';
      try { out = execSync('pgrep -x ' + name, { encoding: 'utf8' }); } catch (_) { continue; }
      for (const pid of out.trim().split('\n')) {
        if (!pid) continue;
        let env = '';
        try { env = fs.readFileSync('/proc/' + pid + '/environ', 'utf8'); } catch (_) { continue; }
        if (env.includes(prefix)) {
          process.kill(Number(pid), 'SIGKILL');
        }
      }
    }
  } catch (_) { /* nothing left */ }
}

module.exports = {
  launch,
  openSetupDialog,
  shutdown,
  // internal (testability)
  _installDownloadedWine: installDownloadedWine,
};
