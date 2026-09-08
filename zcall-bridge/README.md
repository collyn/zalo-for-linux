# zcall-bridge — cuộc gọi Zalo trên Linux qua Wine

Chạy engine gọi điện (voice/video) của Zalo trên Linux.

## Vấn đề

Zalo PC 26.x thực hiện cuộc gọi bằng helper **ZaloCall.exe** (app Qt, chỉ có
bản Windows/macOS). Trên Linux không có helper tương ứng, và Wine ≥ 9.9 đã
bỏ hỗ trợ AF_UNIX socket (nhánh macOS dùng unix socket).

## Giải pháp

Chạy **ZaloCall.exe bản Windows** dưới Wine, bắc cầu kênh giao tiếp bằng
named pipes (thứ Wine hỗ trợ tốt):

```
┌── Zalo app (Linux, đã patch) ────────────────────────────────┐
│  main process: listen TCP 127.0.0.1:29631 (recv) / 29632 (send)
│  spawn: wine pipebridge.exe 29631 29632
│  spawn: wine ZaloCall.exe \\.\pipe\PipeZCallRecv \\.\pipe\PipeZCallSend
└──────────────┬───────────────────────────────────────────────┘
               │ TCP loopback
┌──────────────▼───────────────────────────────────────────────┐
│  WINE prefix                                                  │
│  pipebridge.exe (C, 252KB, không cần runtime)                │
│    named pipes ⇄ TCP, pump dữ liệu 2 chiều                   │
│  ZaloCall.exe — engine gọi thật (Qt5)                        │
└──────────────────────────────────────────────────────────────┘
```

Transport: AES-128-CBC (key cố định trong app), message JSON phân tách `$`.

## Các patch (scripts/patches/)

| Patch | Mục đích |
|---|---|
| `patch-zcall-callv2.js` | Nhánh Linux cho call-v2: TCP ports, spawn qua Wine + pipebridge, **gửi lại init trước mỗi makeCall** (chống lỗi -11 init_error), **fix cờ F kẹt queue gửi** của Zalo, bỏ qua unlink/verifyMd5 không áp dụng |
| `patch-zcall-callgate.js` | Mở 2 gate UI: bỏ check `os.release() < 17` (viết cho Darwin kernel, trên Linux kernel 7.x luôn fail) và bật default `enableCall`/`enableVideoCall` |

## Cài đặt

```bash
node scripts/setup-zcall-bridge.js
```

- Tải installer Windows chính thức, tách `plugins/capture/` →
  `app/native/qt-call-and-cap/` (ZaloCall.exe + ZaviMeet.exe + Qt DLLs +
  plugins, sau khi tỉa còn ~67MB)
- Compile `pipebridge.c` bằng mingw — máy build cần
  `gcc-mingw-w64-i686` (`sudo apt install gcc-mingw-w64-i686`); exe không
  được commit theo chính sách repo (`*.exe` trong .gitignore)

Yêu cầu: Wine chạy được 32-bit (wow64 như Wine 11). Khi app thoát, plugin
kill toàn bộ phiên wine của prefix (`wineserver -k` + hard-kill
wineserver/winedevice còn sót).

## Trải nghiệm người dùng: tự động cài wine

Người dùng **không cần cài gì thủ công**. Ngay lần mở app đầu tiên:

1. App **tự kiểm tra** wine tìm thấy có chạy được app 32-bit không (chạy thử
   `pipebridge.exe --version` — chính là exe 32-bit của cầu nối):
   - Wine hoạt động tốt → **dùng im lặng, không hiện dialog nào**
   - Chưa có wine, hoặc wine có nhưng **không tương thích** (không hỗ trợ
     32-bit / quá cũ) → hiện cửa sổ hỏi **luôn nổi trên cửa sổ chính**
     (không bị che), kèm lý do cụ thể — nút **"Tải và bật ngay"** /
     **"Để sau"**, link nguồn tải minh bạch và checkbox
     **"Không hỏi lại lần sau nếu không tải"**
2. Chọn tải → cửa sổ tiến trình *"Đang tải Wine (~94MB)…"* rồi *"Đang tải
   GStreamer (~120MB)…"* với % trực quan → tự giải nén → tự khởi tạo prefix
   (mất ~2-4 phút tổng cộng)
3. Xong → thông báo *"Tính năng gọi điện đã sẵn sàng!"* — gọi được ngay,
   không cần khởi động lại, không cần quyền quản trị
4. Chọn "Để sau" → **hỏi lại vào lần mở app sau**; tick "không hỏi lại" →
   không bao giờ tự hỏi nữa. Cả hai trường hợp đều bật lại được qua
   **menu khay hệ thống → "Cài đặt gọi điện…"**

Wine tải về lưu tại `<userData>/zcall-wine-runtime/`, cây GStreamer 64-bit
(tải từ asset release `gst-runtime-<ver>.tar.xz`) lưu tại
`<userData>/zcall-gst-runtime/` — hoàn toàn trong dữ liệu của app, không
đụng hệ thống, gỡ app là sạch.

### Biến thể Full (wine đi kèm sẵn)

Release có 2 biến thể **Full** cho cả 2 flavor: portable wine được đóng
gói sẵn **bên trong AppImage**:

- `Zalo-<ver>-<hash>-Full.AppImage` — không ZaDark
- `Zalo-<ver>+ZaDark-<zdv>-<hash>-Full.AppImage` — có ZaDark

Biến thể Full bundle:

- **Wine bản wow64 thuần 64-bit** (`app/native/wine-runtime/`) — chạy app
  Windows 32-bit (ZaloCall) **không cần bất kỳ thư viện 32-bit nào** của
  hệ thống.
- **GStreamer 64-bit + Wayland share-screen bridge** (`app/native/gst-runtime/`)
  — v4l2src cho webcam, libav cho H.264, pipewiresrc cho share screen; kèm
  Xvfb, xdotool, python3.10 + dbus/gir, gst-launch. Wine (wow64) dùng
  GStreamer 64-bit nên **mic + camera + share screen hoạt động không cần
  cài gì** (glibc ≥ 2.35 — Ubuntu 22.04/Mint 21+). Xvfb dùng libGL của
  host (có sẵn trong mọi phiên đồ họa — không phải cài thêm).

Mở app lần đầu là gọi và chia sẻ màn hình được ngay — không cần mạng,
không cần tải wine, không cần cài thư viện. Trên Wayland, share screen đi
qua portal của desktop (xdg-desktop-portal + phiên PipeWire — có sẵn trong
mọi desktop Wayland); trên X11 hoạt động trực tiếp.

Bản thường cũng **không cần cài gì**: lần chạy đầu tự tải cùng bộ wine
wow64 + cây GStreamer/bridge (asset release `gst-runtime-<ver>.tar.xz`) về
`<userData>/` — zero system-deps như bản Full, chỉ khác là phải tải về lần
đầu (cần mạng) và tốn ~2GB ổ đĩa. Nếu tải GStreamer thất bại (bản dev, mạng
chặn), app vẫn gọi thoại được và dùng GStreamer 64-bit hệ thống cho camera.
Dùng wine hệ thống (classic) vẫn được hỗ trợ như một lựa chọn manual.

## Cấu hình Wine (custom path)

Người dùng nâng cao có thể chỉ định wine riêng. Khi app khởi động, plugin
tự dò theo thứ tự ưu tiên:

```
1. Biến môi trường ZCALL_WINE          ← ưu tiên cao nhất (user tự chỉ định)
2. Wine đi kèm app (biến thể Full)    ← app/native/wine-runtime/bin/wine
                                          trong AppImage — mở là dùng được
                                          ngay, không cần tải gì thêm
3. Wine đã tải tự động                ← <userData>/zcall-wine-runtime/bin/wine
                                          (bản app kiểm soát + đã test — nên
                                          dùng để có trải nghiệm đồng nhất)
4. Lệnh `wine` trong PATH              ← wine hệ thống (apt/dnf install wine...)
5. Runner Bottles (flatpak)            ← ~/.var/app/com.usebottles.bottles/
                                          data/bottles/runners/kron4ek-wine-*/
                                          bin/wine (chọn bản mới nhất)
```

App thử lần lượt từng ứng viên và chọn bản đầu tiên **chạy được app 32-bit**;
wine hỏng tự động bỏ qua sang bản tiếp theo.

Nếu không tìm thấy wine: app vẫn chạy bình thường, chỉ **không có tính năng
gọi** — và hộp thoại hỏi tải wine ở trên sẽ xuất hiện.

### Các biến môi trường

| Biến | Ý nghĩa | Mặc định |
|---|---|---|
| `ZCALL_WINE` | Đường dẫn tuyệt đối tới binary `wine` | tự dò (xem thứ tự trên) |
| `ZCALL_WINEPREFIX` | Prefix wine dành riêng cho app | `<userData>/zcall-wine` |
| `ZCALL_DISABLE` | Set bất kỳ giá trị nào để tắt hẳn tính năng gọi | — |
| `ZCALL_AUTO_SETUP` | `'1'` = tải wine tự động, không hỏi (dùng khi triển khai hàng loạt/script) | — |
| `ZCALL_WINE_DOWNLOAD_URL` | Ghi đè URL tải wine portable | URL kron4ek 11.14 wow64 trên GitHub |
| `ZCALL_GST_DOWNLOAD_URL` | Ghi đè URL tải asset GStreamer | `https://github.com/<repo build app>/releases/download/<ver>/gst-runtime-<ver>.tar.xz` (repo đọc tự động từ `build-info.json` — fork nào build thì trỏ về release của fork đó) |
| `ZCALL_GST_RUNTIME` | Ghi đè đường dẫn cây GStreamer 64-bit (test/dev) | `app/native/gst-runtime` (Full) / `<userData>/zcall-gst-runtime` (bản thường) |
| `ZCALL_GST_REGISTRY` | File registry gst riêng của app | `<userData>/gst-registry-64.bin` |
| `ZCALL_GST_REGISTRY_BRIDGE` | Registry riêng cho gst-launch/gst-inspect của bridge | `<userData>/gst-registry-bridge-64.bin` |

## Cài thư viện cho từng distro (copy-paste)

> **Chỉ cần khi dùng wine hệ thống classic thủ công** (qua `ZCALL_WINE`/nút
> "Chọn file wine có sẵn"). Wine tải tự động (wow64) + GStreamer tải về
> (bản thường) hoặc đi kèm (Full) đều **không cần mục này**.

Wine hệ thống classic dùng loader 32-bit nên **máy cần thư viện 32-bit**.
Có 2 mức:

- **Tối thiểu (gọi thoại — loa + mic)**: base libs + driver âm thanh
- **Đầy đủ (thoại + video)**: thêm GStreamer + libv4l

App cũng tự hiện dialog hướng dẫn đúng distro khi thiếu.

### Ubuntu / Debian

```bash
sudo dpkg --add-architecture i386 && sudo apt update

# Tối thiểu — gọi thoại
sudo apt install -y libc6:i386 libx11-6:i386 libxext6:i386 libfreetype6:i386 \
  libgl1:i386 libpulse0:i386 libasound2:i386 zlib1g:i386

# Đầy đủ — thêm cho video call
sudo apt install -y libgstreamer1.0-0:i386 libgstreamer-plugins-base1.0-0:i386 \
  gstreamer1.0-plugins-good:i386 libv4l-0:i386

# Khuyến nghị — decode H.264 video từ đầu bên kia
sudo apt install -y gstreamer1.0-libav:i386
```

### Fedora / RHEL

```bash
# Tối thiểu — gọi thoại
sudo dnf install -y glibc.i686 libX11.i686 libXext.i686 freetype.i686 \
  mesa-libGL.i686 pulseaudio-libs.i686 alsa-lib.i686 zlib-ng-compat.i686

# Đầy đủ — thêm cho video call
sudo dnf install -y gstreamer1.i686 gstreamer1-plugins-base.i686 \
  gstreamer1-plugins-good.i686 libv4l.i686

# Khuyến nghị — decode H.264 (cần RPM Fusion)
sudo dnf install https://download1.rpmfusion.org/free/fedora/rpmfusion-free-release-$(rpm -E %fedora).noarch.rpm
sudo dnf install gstreamer1-plugin-libav.i686
```

### Arch

```bash
# Tối thiểu — gọi thoại
sudo pacman -S --needed lib32-glibc lib32-libx11 lib32-libxext \
  lib32-freetype2 lib32-mesa lib32-libpulse lib32-alsa-lib lib32-zlib

# Đầy đủ — thêm cho video call
sudo pacman -S --needed lib32-gstreamer lib32-gst-plugins-base \
  lib32-gst-plugins-good lib32-libv4l

# Khuyến nghị — decode H.264
sudo pacman -S --needed lib32-gst-libav
```

> `gstreamer1.0-plugins-bad` (Ubuntu) / `gstreamer1-plugins-bad-free` (Fedora)
> chỉ cần khi không dùng libav — không bắt buộc nếu đã cài libav.

### Đường tắt: cài wine hệ thống

`sudo apt install wine` / `sudo dnf install wine` / `sudo pacman -S wine` —
trình quản lý gói tự kéo đủ thư viện. App tự phát hiện và dùng wine hệ thống.

### Kiểm tra sau khi cài

```bash
# Mic được hệ thống nhận chưa?
pactl list sources short | grep -i input
# Loa?
pactl list sinks short
# Camera?
ls /dev/video*          # rỗng = chưa nhận phần cứng; thiếu quyền: sudo usermod -aG video $USER
```

### Camera bị xanh/nhòe (lệch định dạng pixel)

Cài công cụ điều khiển camera (`sudo apt install v4l-utils` /
`sudo dnf install v4l-utils` / `sudo pacman -S v4l-utils`) rồi ép format:

```bash
v4l2-ctl --set-fmt-video=width=640,height=480,pixelformat=MJPG
```

(hết hiệu lực khi rút cắm camera)

### Share screen trên Wayland (bridge)

Trên Wayland, XWayland không nhìn thấy desktop nên ZaloCall (wine) chụp được
màn hình đen. App có sẵn **bridge riêng**:

1. Cài thành phần — **chỉ cần khi dùng wine hệ thống thủ công** (hoặc bản
   release cũ chưa có bridge đi kèm); biến thể Full bundle sẵn và bản thường
   tải về cùng cây GStreamer — cả hai chạy thẳng, bỏ qua bước này. Nếu
   thiếu, app tự hiện dialog với đúng lệnh cho distro của bạn khi bấm Share
   screen:
   ```bash
   # Fedora:  sudo dnf install xorg-x11-server-Xvfb xdotool python3-dbus \
   #            gstreamer1-plugins-base gstreamer1-plugins-bad-free
   # Ubuntu:  sudo apt install xvfb xdotool python3-dbus \
   #            gstreamer1.0-plugins-base gstreamer1.0-plugins-bad
   # Arch:    sudo pacman -S xorg-server-xvfb xdotool python-dbus \
   #            gst-plugins-base gst-plugins-bad
   ```
   (`streamproxy.so` được build sẵn vào app — không cần cài gì thêm.)
2. Gọi video **hoàn toàn như bình thường** — giao diện cuộc gọi là cửa sổ
   native trên desktop, không có gì thay đổi
3. Bấm **Share screen** như thường → **hộp thoại xin quyền ghi màn hình
   (portal chuẩn) tự hiện ra** → chọn màn hình → Cho phép → hình chia sẻ
   được lấy từ màn hình Wayland thật qua bridge ✓

Bridge chạy **Xvfb headless** làm màn hình render (`:99`): màn hình Wayland
được đưa vào đó qua XDG ScreenCast portal + GStreamer. ZaloCall **vẫn chạy
native trên màn hình thật**; `streamproxy.so` (shim LD_PRELOAD, build sẵn
theo app) chặn đúng các lời gọi chụp màn hình của ZaloCall
(`XGetImage`/`XShmGetImage`/`xcb_get_image` trên root) và **trả về nội dung
từ `:99`** — nên phần còn lại của app (giao diện, âm thanh, video) không
đổi, chỉ riêng hình ảnh chia sẻ đi qua bridge. Shim cũng **tự báo hiệu**
(bằng file request) khi phát hiện lần chụp màn hình đầu tiên — app theo
dõi và tự khởi động bridge, nên không cần thao tác nào thêm. Nếu người
dùng từ chối hộp thoại quyền, app không hỏi lại trong 90 giây (bấm lại Share
screen để thử lại). Bridge tự tắt khi thoát app.

Trên **phiên X11**, share screen hoạt động trực tiếp — không cần bridge.

### Lưu ý giới hạn

- Bản kron4ek **wow64** (thuần 64-bit) không chạy được ZaloCall **trên wine
  < 9** (wow64 thử nghiệm thời 8.6, lỗi với Qt 32-bit). Từ wine 9+ chạy tốt
  (đã xác minh trên 11.14) — đây là build mặc định cho cả Full bundle lẫn
  luồng tự tải của bản thường. Wine hệ thống classic vẫn hỗ trợ (cần thư
  viện 32-bit, xem mục trên).
- Công cụ xwaylandvideobridge của KDE chỉ chạy trên KDE Plasma (KWin); trên
  GNOME dùng bridge tích hợp của app (mục trên).

### Ví dụ chạy với wine tự chọn

**Dev mode:**

```bash
# Wine hệ thống bạn tự cài (ví dụ apt install wine)
ZCALL_WINE=/usr/bin/wine npm start

# Wine build riêng tải từ internet
ZCALL_WINE=/opt/wine-10.0/bin/wine npm start

# Kèm prefix riêng
ZCALL_WINE=/usr/bin/wine ZCALL_WINEPREFIX=~/zalo-call-prefix npm start

# Tắt hẳn tính năng gọi
ZCALL_DISABLE=1 npm start
```

**AppImage (bản đóng gói):**

```bash
# Chạy từ terminal, env áp dụng cho phiên đó
ZCALL_WINE=/usr/bin/wine ./Zalo-<version>.AppImage
```

Muốn áp vĩnh viễn: sửa file `.desktop` của app (do Gear Lever/trình đơn tạo),
thêm biến vào dòng `Exec`:

```ini
Exec=env ZCALL_WINE=/usr/bin/wine /đường/dẫn/tới/Zalo.AppImage
```

### Kiểm tra wine có chạy được không

```bash
# 1. Wine hoạt động?
/đường/dẫn/wine --version          # in ra phiên bản, ví dụ wine-11.14

# 2. Chạy được app 32-bit? (tạo prefix thử — lần đầu mất ~30s)
WINEPREFIX=/tmp/test-prefix /đường/dẫn/wine wineboot -u
ls /tmp/test-prefix/drive_c        # có Program Files/ = OK
rm -rf /tmp/test-prefix

# 3. Mở app với env, gọi thử một cuộc thoại. Lần gọi đầu tiên hơi chậm
#    (wine khởi động nguội + tạo prefix nếu chưa có ~5-15s).
```

### Prefix nằm ở đâu

- Mặc định: `<userData>/zcall-wine` — `userData` của app là
  `~/.config/ZaloData/` (hoặc theo env `XDG_CONFIG_HOME`).
- App **chỉ thao tác wine trong đúng prefix này** — không đụng tới
  `~/.wine` hay các prefix Bottles khác của bạn.
- Khi app thoát, toàn bộ tiến trình wine của prefix này bị dọn sạch
  (`wineserver -k` + hard-kill `wineserver`/`winedevice.exe` còn sót).
- Muốn reset trạng thái gọi: xóa thư mục prefix rồi mở lại app —
  plugin sẽ tự tạo lại prefix mới.

## Đã xác minh

- ✅ ZaloCall.exe chạy dưới Wine (wow64), kết nối đủ 2 kênh. Các bản đã test
  thật qua replay (init → makeCall → incall → success → sendSignal):
  **11.14** (96MB/852MB — bản khuyên dùng, video call đã xác minh thật),
  **8.6** (54MB/565MB — nhẹ hơn nhưng video call crash `msvcp140._Throw_C_error`
  thiếu hàm CRT khi gặp lỗi decode), **8.0.1**, **7.22**
- ✅ **Video call hoạt động** trên Fedora (wine 11.14 + GStreamer 32-bit +
  libv4l) — camera đôi khi cần ép format: `v4l2-ctl --set-fmt-video=width=640,height=480,pixelformat=MJPG`
- ✅ **Share screen trên Wayland** qua bridge tích hợp (XDG ScreenCast
  portal → PipeWire → GStreamer → Xvfb headless `:99` → streamproxy shim
  → ZaloCall) — **người dùng xác nhận share hoạt động** trên KDE
  Wayland; ZaloCall chạy native, giao diện cuộc gọi không đổi; hộp thoại
  quyền tự hiện khi bấm Share screen (shim báo hiệu qua file request).
  Shim được build 2 kiến trúc: 32-bit (`streamproxy.so`) cho wine classic,
  64-bit (`streamproxy-x86_64.so`) cho wine wow64 thuần — app tự chọn theo
  build wine (probe `lib/wine/i386-unix`)
- ✅ **Wine wow64 thuần 64-bit (11.14) xác minh**: `wineboot` + pipebridge
  (PE32) + ZaloCall khởi tạo đủ call engine không crash (thứ từng fail trên
  wine 8.6); LD_PRELOAD 64-bit load vào process wow64 (probe constructor +
  `streamproxy-x86_64.so` nằm trong `/proc/<pid>/maps`) — nền tảng cho biến
  thể Full không cần thư viện 32-bit
- ✅ **Bridge stack self-contained xác minh tại build** (4 gate tự động):
  ldd self-contained (15+ file, Xvfb allowlist libGL host), bundled python
  import `dbus`+`gi` OK, bundled gst-inspect đăng ký `pipewiresrc`/
  `ximagesink`/`videoconvert`, Xvfb chạy không GLX. Portal flow đầy đủ cần
  test trên máy Wayland thật (Fedora/KDE) — người dùng xác nhận
- ⚠️ Trên phiên X11 không cần bridge — share screen hoạt động trực tiếp.
- ✅ `native-ready` → `init` → `makeCall` → `callState: incall`, `show success`,
  `sendSignal 401` — engine thực hiện cuộc gọi thật (voice + video signaling)
- ✅ **Người dùng xác nhận cuộc gọi thoại hoạt động** trong app
- ✅ pipebridge C (252KB) hoạt động trong app thật
- ✅ Thư mục engine đã tỉa 196MB → **67MB** (bỏ pdbs, translations, Qt plugins
  thừa, opengl32sw, Qt5Sql/Xml; giữ ZaviMeet cho group call) — call 1-1 vẫn chạy
- ✅ Tắt app → wine session được dọn sạch (wineserver + winedevice)
- ⚠️ Chưa test: video call end-to-end (máy test không có webcam) — signaling
  video đã chạy, cần máy có camera để xác nhận capture + hiển thị
