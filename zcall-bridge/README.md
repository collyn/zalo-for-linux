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
- Compile `pipebridge.c` bằng mingw (fallback dùng exe đã commit)

Yêu cầu: Wine chạy được 32-bit (wow64 như Wine 11). Khi app thoát, plugin
kill toàn bộ phiên wine của prefix (`wineserver -k` + hard-kill
wineserver/winedevice còn sót).

## Trải nghiệm người dùng: tự động cài wine

Người dùng **không cần cài gì thủ công**. Ngay lần mở app đầu tiên:

1. Nếu máy chưa có wine, app hiện cửa sổ hỏi **luôn nổi trên cửa sổ chính**
   (không bị che): *"Tính năng gọi điện cần Wine. Tải và bật ngay bây giờ?"*
   — nút **"Tải và bật ngay"** / **"Để sau"**, kèm link nguồn tải minh bạch
   và checkbox **"Không hỏi lại lần sau nếu không tải"**
2. Chọn tải → cửa sổ tiến trình *"Đang tải Wine (~54MB)…"* với % trực quan
   → tự giải nén → tự khởi tạo prefix (mất ~1-2 phút tổng cộng)
3. Xong → thông báo *"Tính năng gọi điện đã sẵn sàng!"* — gọi được ngay,
   không cần khởi động lại, không cần quyền quản trị
4. Chọn "Để sau" → **hỏi lại vào lần mở app sau**; tick "không hỏi lại" →
   không bao giờ tự hỏi nữa. Cả hai trường hợp đều bật lại được qua
   **menu khay hệ thống → "Cài đặt gọi điện…"**

Wine tải về được lưu tại `<userData>/zcall-wine-runtime/` — hoàn toàn trong
dữ liệu của app, không đụng hệ thống, gỡ app là sạch.

## Cấu hình Wine (custom path)

Người dùng nâng cao có thể chỉ định wine riêng. Khi app khởi động, plugin
tự dò theo thứ tự ưu tiên:

```
1. Biến môi trường ZCALL_WINE          ← ưu tiên cao nhất
2. Wine đã tải tự động (mục trên)      ← <userData>/zcall-wine-runtime/bin/wine
3. Lệnh `wine` trong PATH              ← wine hệ thống (apt install wine...)
4. Runner Bottles (flatpak)            ← ~/.var/app/com.usebottles.bottles/
                                          data/bottles/runners/kron4ek-wine-*/
                                          bin/wine (chọn bản mới nhất)
```

Nếu không tìm thấy wine: app vẫn chạy bình thường, chỉ **không có tính năng
gọi** — và hộp thoại hỏi tải wine ở trên sẽ xuất hiện.

### Các biến môi trường

| Biến | Ý nghĩa | Mặc định |
|---|---|---|
| `ZCALL_WINE` | Đường dẫn tuyệt đối tới binary `wine` | tự dò (xem thứ tự trên) |
| `ZCALL_WINEPREFIX` | Prefix wine dành riêng cho app | `<userData>/zcall-wine` |
| `ZCALL_DISABLE` | Set bất kỳ giá trị nào để tắt hẳn tính năng gọi | — |
| `ZCALL_AUTO_SETUP` | `'1'` = tải wine tự động, không hỏi (dùng khi triển khai hàng loạt/script) | — |
| `ZCALL_WINE_DOWNLOAD_URL` | Ghi đè URL tải wine portable | URL kron4ek 11.14 trên GitHub |

> ⚠️ Wine cần hỗ trợ chạy app 32-bit (ZaloCall.exe là PE32). Các bản Wine 8+
> có chế độ wow64 chạy được 32-bit trên wine64 thuần; bản cũ hơn cần
> `dpkg --add-architecture i386` + gói wine32.

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
  **11.14** (96MB/852MB), **8.6** (54MB/565MB — dùng làm mặc định tải tự
  động), **8.0.1** (53MB/564MB), **7.22** (53MB/563MB)
- ✅ `native-ready` → `init` → `makeCall` → `callState: incall`, `show success`,
  `sendSignal 401` — engine thực hiện cuộc gọi thật (voice + video signaling)
- ✅ **Người dùng xác nhận cuộc gọi thoại hoạt động** trong app
- ✅ pipebridge C (252KB) hoạt động trong app thật
- ✅ Thư mục engine đã tỉa 196MB → **67MB** (bỏ pdbs, translations, Qt plugins
  thừa, opengl32sw, Qt5Sql/Xml; giữ ZaviMeet cho group call) — call 1-1 vẫn chạy
- ✅ Tắt app → wine session được dọn sạch (wineserver + winedevice)
- ⚠️ Chưa test: video call end-to-end (máy test không có webcam) — signaling
  video đã chạy, cần máy có camera để xác nhận capture + hiển thị
