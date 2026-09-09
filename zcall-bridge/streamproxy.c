/*
 * streamproxy.c — LD_PRELOAD shim that redirects the screen-capture reads of
 * a wine app (ZaloCall) from its real X display to the bridge display (:99),
 * where the Wayland screen is rendered by the screen bridge.
 *
 * ZaloCall runs natively on the real display (its call UI is a normal
 * window), but when it captures the screen for "share screen" it reads the
 * root window — which is black/unsupported on rootless XWayland. This shim
 * intercepts the three capture APIs (libX11 XGetImage, XShmGetImage, xcb
 * xcb_get_image) and, for root grabs, serves the same region from the
 * bridge display instead. Everything else passes through untouched.
 *
 * The shim is inert when the bridge display is not reachable, so it can be
 * preloaded unconditionally. When a capture happens and the bridge display
 * is down, it touches ZCALL_PROXY_REQUEST — the plugin watches that file
 * and starts the bridge (popping the compositor's permission dialog), so
 * the user never has to prepare the bridge manually.
 *
 * Build (32-bit — ZaloCall is 32-bit, a 64-bit shim never intercepts):
 *   gcc -m32 -shared -fPIC -O2 streamproxy.c -ldl -lX11 -lxcb -o streamproxy.so
 * Debug: set ZCALL_PROXY_LOG=<file> to trace which API the app uses.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <poll.h>
#include <time.h>
#include <linux/videodev2.h>
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/extensions/XShm.h>
#include <xcb/xcb.h>
#include <xcb/xproto.h>

static FILE *logf = NULL;
static int verbose = 0;

/* Kill-switch (ZCALL_PROXY_OFF=1): every wrapper passes through untouched —
 * A/B lever to prove whether a call failure is caused by the shim. */
static int disabled(void) {
    static int d = -1;
    if (d < 0) d = getenv("ZCALL_PROXY_OFF") != NULL;
    return d;
}

static void plog(const char *fmt, ...) {
    if (!logf) {
        const char *p = getenv("ZCALL_PROXY_LOG");
        if (!p) return;
        logf = fopen(p, "a");
        if (!logf) return;
        if (getenv("ZCALL_PROXY_DEBUG")) verbose = 1;
    }
    va_list ap;
    va_start(ap, fmt);
    vfprintf(logf, fmt, ap);
    va_end(ap);
    fflush(logf);
}

/* Per-call tracing (ZCALL_PROXY_DEBUG=1): dumps every capture the app
 * makes with the drawable/root comparison and which branch was taken —
 * the bridge proxies ONLY root grabs, so a window capture falls through
 * silently without this. */
static void vlog(const char *fmt, ...) {
    if (!verbose) return;
    plog("streamproxy: ");
    va_list ap;
    va_start(ap, fmt);
    vfprintf(logf, fmt, ap);
    va_end(ap);
    fputc('\n', logf);
    fflush(logf);
}

/* ------------------------------------------------------------------ */
/* camera format enforcement                                           */
/* ------------------------------------------------------------------ */
/* ZaloCall crashes (page fault in its own code) when the webcam's default
 * format does not match what its Qt pipeline expects. The verified-good
 * combo is MJPG 640x480. Force it EVERY time the app opens a /dev/video*
 * device: the driver resets to its default on close, so a one-shot
 * v4l2-ctl only fixes the FIRST call of the session. */
typedef int (*open_fn)(const char *, int, ...);

/* Try MJPG 640x480 first; fall back to YUYV 640x480 (IR/secondary devices
 * usually only do raw formats). Returns the pixelformat actually set. */
static uint32_t set_camera_fmt(int fd) {
    struct v4l2_format fmt;
    memset(&fmt, 0, sizeof(fmt));
    fmt.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    if (ioctl(fd, VIDIOC_G_FMT, &fmt) < 0) return 0;
    fmt.fmt.pix.width = 640;
    fmt.fmt.pix.height = 480;
    fmt.fmt.pix.pixelformat = V4L2_PIX_FMT_MJPEG;
    if (ioctl(fd, VIDIOC_S_FMT, &fmt) == 0 && fmt.fmt.pix.pixelformat == V4L2_PIX_FMT_MJPEG)
        return V4L2_PIX_FMT_MJPEG;
    fmt.fmt.pix.pixelformat = V4L2_PIX_FMT_YUYV;
    if (ioctl(fd, VIDIOC_S_FMT, &fmt) == 0 && fmt.fmt.pix.pixelformat == V4L2_PIX_FMT_YUYV)
        return V4L2_PIX_FMT_YUYV;
    return 0;
}

static int recover_camera(int fd);
static int (*real_close_fn)(int) = NULL;

static int wrap_open(const char *path, int flags, mode_t mode, const char *sym) {
    static open_fn real_open = NULL;
    static open_fn real_open64 = NULL;
    open_fn fn;
    if (!real_close_fn) real_close_fn = (int (*)(int))dlsym(RTLD_NEXT, "close");
    if (sym[4] == '6') {           /* "open64" */
        if (!real_open64) real_open64 = (open_fn)dlsym(RTLD_NEXT, "open64");
        fn = real_open64;
    } else {
        if (!real_open) real_open = (open_fn)dlsym(RTLD_NEXT, "open");
        fn = real_open;
    }
    int fd = fn(path, flags, mode);
    if (fd >= 0 && path && strstr(path, "/dev/video")) {
        uint32_t got = set_camera_fmt(fd);
        if (got == V4L2_PIX_FMT_MJPEG)
            plog("streamproxy: camera %s -> MJPG 640x480\n", path);
        else if (got == V4L2_PIX_FMT_YUYV)
            plog("streamproxy: camera %s -> YUYV 640x480 (no MJPG)\n", path);
        else {
            /* Neither format accepted. Either a format-poor device (IR
             * camera) or a WEDGED one left half-streaming by the previous
             * session — try a mini-stream recovery on a fresh fd. */
            static open_fn real_open_r = NULL;
            if (!real_open_r) real_open_r = (open_fn)dlsym(RTLD_NEXT, "open");
            int r = real_open_r(path, O_RDWR | O_NONBLOCK, 0);
            if (r >= 0) {
                recover_camera(r);
                real_close_fn(r);
                got = set_camera_fmt(fd);
            }
            if (got == V4L2_PIX_FMT_MJPEG || got == V4L2_PIX_FMT_YUYV) {
                plog("streamproxy: camera %s recovered by mini-stream -> fmt OK\n", path);
            } else if (getenv("ZCALL_CAMERA_KEEP_WEDGED")) {
                /* Debug lever: let the app see the half-dead device (old
                 * behavior — the app then crashes on the garbage it reads). */
                plog("streamproxy: camera %s: WEDGED, left open (debug)\n", path);
            } else {
                /* Refuse the open: ZaloCall sees "no camera" and degrades
                 * to voice-only instead of crashing on a half-dead device.
                 * The user can then replug / rmmod at leisure. */
                plog("streamproxy: camera %s: WEDGED — open refused (voice-only fallback)\n", path);
                real_close_fn(fd);
                return -1;
            }
        }
    }
    return fd;
}

static int cam_open_count = 0;

int open(const char *path, int flags, ...) {
    mode_t mode = 0;
    if (flags & O_CREAT) {
        va_list ap;
        va_start(ap, flags);
        mode = (mode_t)va_arg(ap, int);
        va_end(ap);
    }
    if (disabled()) {
        static open_fn real_open_o = NULL;
        if (!real_open_o) real_open_o = (open_fn)dlsym(RTLD_NEXT, "open");
        return real_open_o(path, flags, mode);
    }
    int fd = wrap_open(path, flags, mode, "open");
    if (fd >= 0 && path && strstr(path, "/dev/video")) cam_open_count++;
    return fd;
}

int open64(const char *path, int flags, ...) {
    mode_t mode = 0;
    if (flags & O_CREAT) {
        va_list ap;
        va_start(ap, flags);
        mode = (mode_t)va_arg(ap, int);
        va_end(ap);
    }
    if (disabled()) {
        static open_fn real_open64_o = NULL;
        if (!real_open64_o) real_open64_o = (open_fn)dlsym(RTLD_NEXT, "open64");
        return real_open64_o(path, flags, mode);
    }
    int fd = wrap_open(path, flags, mode, "open64");
    if (fd >= 0 && path && strstr(path, "/dev/video")) cam_open_count++;
    return fd;
}

/* ------------------------------------------------------------------ */
/* device kick on last close                                           */
/* ------------------------------------------------------------------ */
/* wine's winegstreamer stops the stream without fully resetting the
 * device on some cameras (alt-setting stuck): the NEXT open gets a
 * half-dead device and ZaloCall crashes on the garbage it reads (the
 * Mint "first call works, second call crashes" bug). When the LAST fd on
 * a /dev/video* device closes, re-open it briefly, send STREAMOFF and
 * re-apply the format — a userspace "kick" that normalizes the driver. */

static int fd_is_camera(int fd) {
    struct v4l2_capability cap;
    memset(&cap, 0, sizeof(cap));
    return ioctl(fd, VIDIOC_QUERYCAP, &cap) == 0;
}

/* Full mini-stream cycle: format -> 2 mmap buffers -> STREAMON ->
 * STREAMOFF -> release. This is the sequence uvcvideo needs to return the
 * USB alt-setting to idle; a bare STREAMOFF was not enough on some cameras
 * (the Mint wedge: next open's S_FMT fails and ZaloCall crashes on the
 * half-dead device). Returns 0 when the device answers all ioctls cleanly. */
static int recover_camera(int fd) {
    struct v4l2_format fmt;
    struct v4l2_requestbuffers req;
    enum v4l2_buf_type t = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    memset(&fmt, 0, sizeof(fmt));
    fmt.type = t;
    if (ioctl(fd, VIDIOC_G_FMT, &fmt) < 0) return -1;
    fmt.fmt.pix.width = 640;
    fmt.fmt.pix.height = 480;
    fmt.fmt.pix.pixelformat = V4L2_PIX_FMT_MJPEG;
    if (ioctl(fd, VIDIOC_S_FMT, &fmt) < 0) return -1;
    memset(&req, 0, sizeof(req));
    req.count = 2;
    req.type = t;
    req.memory = V4L2_MEMORY_MMAP;
    if (ioctl(fd, VIDIOC_REQBUFS, &req) < 0) return -1;
    if (ioctl(fd, VIDIOC_STREAMON, &t) < 0) { ioctl(fd, VIDIOC_REQBUFS, &req); return -1; }
    if (ioctl(fd, VIDIOC_STREAMOFF, &t) < 0) { /* keep going */ }
    req.count = 0;
    ioctl(fd, VIDIOC_REQBUFS, &req);
    return 0;
}

static void kick_camera(const char *path) {
    static open_fn real_open_k = NULL;
    if (!real_open_k) real_open_k = (open_fn)dlsym(RTLD_NEXT, "open");
    int k = real_open_k(path, O_RDWR | O_NONBLOCK, 0);
    if (k < 0) return;
    enum v4l2_buf_type t = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    ioctl(k, VIDIOC_STREAMOFF, &t);
    recover_camera(k);
    real_close_fn(k);
    plog("streamproxy: camera %s kicked (mini-stream cycle) after last close\n", path);
}

int close(int fd) {
    if (!real_close_fn) real_close_fn = (int (*)(int))dlsym(RTLD_NEXT, "close");
    if (disabled()) return real_close_fn(fd);
    int is_cam = fd_is_camera(fd);
    int ret = real_close_fn(fd);
    if (is_cam && cam_open_count > 0) {
        cam_open_count--;
        if (cam_open_count == 0) {
            /* Last camera fd in the process closed — normalize the device.
             * Best-effort on video0 (the real webcam). */
            kick_camera("/dev/video0");
        }
    }
    return ret;
}

/* ------------------------------------------------------------------ */
/* lazy connections to the bridge display                              */
/* ------------------------------------------------------------------ */

static Display *src_dpy = NULL;
static xcb_connection_t *src_c = NULL;
static xcb_window_t src_root = 0;

/* The app starts capturing (user clicked "share screen"): if the bridge
 * display is not up, ask the plugin to start the bridge by touching the
 * request file. The plugin watches it and pops the compositor's
 * permission dialog. */
static void signal_request(void) {
    const char *p = getenv("ZCALL_PROXY_REQUEST");
    if (!p) return;
    FILE *f = fopen(p, "w");
    if (f) fclose(f);
}

/* Report the root-capture region ("x y w h") to the plugin via a file.
 * ZaloCall captures at the position of the monitor IT considers primary —
 * which does NOT change with the portal's source selection. The plugin
 * parks the gst window at THIS position (not the shared monitor's), so
 * whichever monitor the user shares lands exactly where the captures
 * read. Written only when the region changes (captures run at ~25fps). */
static int last_rx = -1, last_ry = -1, last_rw = -1, last_rh = -1;
static void report_region(int x, int y, unsigned int w, unsigned int h) {
    /* Heartbeat FIRST — it must fire on EVERY capture while the share is
     * live, NOT only when the region changes (a stable region would
     * otherwise leave the heartbeat stale and the plugin would tear a
     * healthy bridge down mid-share). Throttled to once per second. */
    const char *hb = getenv("ZCALL_PROXY_HEARTBEAT");
    if (hb) {
        static time_t last_hb = 0;
        time_t now = time(NULL);
        if (now != last_hb) {
            last_hb = now;
            FILE *g = fopen(hb, "w");
            if (g) {
                fputc('1', g);
                fclose(g);
            }
        }
    }
    const char *p = getenv("ZCALL_PROXY_REGION");
    if (!p) return;
    if (x == last_rx && y == last_ry && (int)w == last_rw && (int)h == last_rh)
        return;
    last_rx = x; last_ry = y; last_rw = (int)w; last_rh = (int)h;
    FILE *f = fopen(p, "w");
    if (!f) return;
    fprintf(f, "%d %d %u %u\n", x, y, w, h);
    fclose(f);
}

/* If the bridge display dies mid-capture, Xlib's default IO error handler
 * would kill the whole app. Instead drop the cached connection (next grab
 * re-opens or falls through) and chain anything else to the original
 * handler. */
static int (*orig_io_handler)(Display *) = NULL;

static int src_io_handler(Display *d) {
    if (d == src_dpy) {
        plog("streamproxy: src connection broken, dropping cache\n");
        src_dpy = NULL;
        return 0;
    }
    if (orig_io_handler) return orig_io_handler(d);
    return 1;
}

/* Same for protocol errors (e.g. a grab beyond the bridge screen edge):
 * default handling would abort the process — drop the cache instead so
 * the next grab re-opens cleanly, and let the failed call fall through
 * to the real display. */
static int (*orig_error_handler)(Display *, XErrorEvent *) = NULL;

static int src_error_handler(Display *d, XErrorEvent *e) {
    if (d == src_dpy) {
        plog("streamproxy: src X error code=%d, dropping cache\n",
             e ? (int)e->error_code : -1);
        src_dpy = NULL;
        return 0;
    }
    if (orig_error_handler) return orig_error_handler(d, e);
    return 0;
}

static int src_scr_w = 0;
static int src_scr_h = 0;

/* Cheap liveness probe on the cached src connection. poll/recv only — no
 * X protocol traffic, so it can NEVER trigger the fatal-IO-error path
 * (which crashed ZaloCall when a capture hit the connection Xvfb died on
 * during bridge teardown: the stale Display was reused, XGetImage hit the
 * dead socket and wine aborted mid-call). */
static int src_conn_alive(Display *d) {
    struct pollfd pfd;
    pfd.fd = ConnectionNumber(d);
    pfd.events = POLLIN | POLLHUP | POLLERR;
    pfd.revents = 0;
    if (poll(&pfd, 1, 0) <= 0) return 1;      /* no events — alive */
    if (pfd.revents & (POLLHUP | POLLERR)) return 0;
    if (pfd.revents & POLLIN) {
        char b;
        ssize_t n = recv(pfd.fd, &b, 1, MSG_PEEK | MSG_DONTWAIT);
        if (n == 0) return 0;                 /* EOF — server gone */
        /* n < 0 (EAGAIN) or n > 0 (pending events) — still alive */
    }
    return 1;
}

static Display *ensure_src_dpy(void) {
    if (src_dpy && !src_conn_alive(src_dpy)) {
        plog("streamproxy: src connection dead, dropping cache\n");
        src_dpy = NULL;  /* leak the dead Display — re-open below */
    }
    if (!src_dpy) {
        const char *n = getenv("ZCALL_PROXY_SRC");
        if (!n) n = ":99";
        src_dpy = XOpenDisplay(n);
        if (src_dpy) {
            // Capture the ORIGINAL handlers only on the FIRST install: on
            // every later open the "currently installed" handler IS this
            // shim itself — re-capturing would make orig point at us and
            // the next foreign-display error would recurse forever (stack
            // overflow). Re-installing ours each open keeps the chain
            // wine -> shim intact across bridge restarts.
            if (!orig_io_handler) orig_io_handler = XSetIOErrorHandler(src_io_handler);
            else XSetIOErrorHandler(src_io_handler);
            if (!orig_error_handler) orig_error_handler = XSetErrorHandler(src_error_handler);
            else XSetErrorHandler(src_error_handler);
            src_scr_w = DisplayWidth(src_dpy, DefaultScreen(src_dpy));
            src_scr_h = DisplayHeight(src_dpy, DefaultScreen(src_dpy));
            plog("streamproxy: libX11 src %s opened (%dx%d)\n", n,
                 src_scr_w, src_scr_h);
        } else {
            plog("streamproxy: cannot open src %s (not proxying)\n", n);
            signal_request();
        }
    }
    return src_dpy;
}

/* The bridge screen must cover the whole grab region — ZaloCall captures
 * the FULL root, which spans ALL monitors (e.g. 3840x1080 on two
 * 1920x1080 screens). A region beyond the bridge screen edge would fail
 * the src grab (and the error handler would drop the cache mid-capture) —
 * fall through to the real display instead, same as when the bridge is
 * down. */
static int region_fits(int x, int y, unsigned int w, unsigned int h) {
    if (!src_scr_w) return 0;  /* screen size unknown — no connection yet */
    return x >= 0 && y >= 0 &&
           (unsigned)x + w <= (unsigned)src_scr_w &&
           (unsigned)y + h <= (unsigned)src_scr_h;
}

static xcb_connection_t *ensure_src_c(void) {
    if (!src_c) {
        const char *n = getenv("ZCALL_PROXY_SRC");
        if (!n) n = ":99";
        int scr = 0;
        src_c = xcb_connect(n, &scr);
        if (src_c && !xcb_connection_has_error(src_c)) {
            xcb_screen_iterator_t it =
                xcb_setup_roots_iterator(xcb_get_setup(src_c));
            if (it.rem) {
                src_root = it.data->root;
                src_scr_w = it.data->width_in_pixels;
                src_scr_h = it.data->height_in_pixels;
            }
            plog("streamproxy: xcb src %s opened\n", n);
        } else {
            if (src_c) xcb_disconnect(src_c);
            src_c = NULL;
            plog("streamproxy: cannot open xcb src %s\n", n);
            signal_request();
        }
    }
    return src_c;
}

/* ------------------------------------------------------------------ */
/* libX11: XGetImage / XShmGetImage                                    */
/* ------------------------------------------------------------------ */

typedef XImage *(*XGetImage_fn)(Display *, Drawable, int, int, unsigned int,
                                unsigned int, unsigned long, int);
typedef Bool (*XShmGetImage_fn)(Display *, Drawable, XImage *, int, int,
                                unsigned long);

static XGetImage_fn real_XGetImage = NULL;
static XShmGetImage_fn real_XShmGetImage = NULL;

static int is_root(Display *dpy, Drawable d) {
    return d == (Drawable)DefaultRootWindow(dpy);
}

XImage *XGetImage(Display *dpy, Drawable d, int x, int y, unsigned int w,
                  unsigned int h, unsigned long plane_mask, int format) {
    if (!real_XGetImage)
        real_XGetImage = (XGetImage_fn)dlsym(RTLD_NEXT, "XGetImage");
    if (disabled())
        return real_XGetImage(dpy, d, x, y, w, h, plane_mask, format);
    if (ensure_src_dpy() && dpy != src_dpy && is_root(dpy, d) &&
        region_fits(x, y, w, h)) {
        report_region(x, y, w, h);
        XImage *im = real_XGetImage(src_dpy, (Drawable)DefaultRootWindow(src_dpy),
                                    x, y, w, h, plane_mask, format);
        plog("streamproxy: XGetImage root %ux%u+%d+%d -> %s\n", w, h, x, y,
             im ? "proxied" : "src-failed, fell through");
        if (im) return im;
    }
    vlog("XGetImage dpy=%p drawable=0x%lx root=0x%lx %ux%u+%d+%d fmt=%d %s",
         (void *)dpy, (unsigned long)d, (unsigned long)DefaultRootWindow(dpy),
         w, h, x, y, format,
         (dpy != src_dpy && is_root(dpy, d)) ? "(should have proxied)" : "(fell through)");
    return real_XGetImage(dpy, d, x, y, w, h, plane_mask, format);
}

Bool XShmGetImage(Display *dpy, Drawable d, XImage *image, int x, int y,
                  unsigned long plane_mask) {
    if (!real_XShmGetImage)
        real_XShmGetImage = (XShmGetImage_fn)dlsym(RTLD_NEXT, "XShmGetImage");
    // The proxy branch below grabs via real_XGetImage — the app may hit
    // XShmGetImage FIRST (Qt's shm capture path never calls XGetImage),
    // and real_XGetImage is still NULL then: a call through NULL, SIGSEGV
    // right when share screen starts.
    if (!real_XGetImage)
        real_XGetImage = (XGetImage_fn)dlsym(RTLD_NEXT, "XGetImage");
    if (disabled())
        return real_XShmGetImage(dpy, d, image, x, y, plane_mask);
    if (ensure_src_dpy() && dpy != src_dpy && is_root(dpy, d) && image &&
        region_fits(x, y, (unsigned)image->width, (unsigned)image->height)) {
        report_region(x, y, (unsigned)image->width, (unsigned)image->height);
        XImage *im = real_XGetImage(src_dpy, (Drawable)DefaultRootWindow(src_dpy),
                                    x, y, image->width, image->height,
                                    plane_mask, ZPixmap);
        if (im) {
            size_t copy = im->bytes_per_line < image->bytes_per_line
                              ? im->bytes_per_line
                              : image->bytes_per_line;
            for (unsigned int r = 0; r < (unsigned int)im->height; r++)
                memcpy(image->data + (size_t)r * image->bytes_per_line,
                       im->data + (size_t)r * im->bytes_per_line, copy);
            XDestroyImage(im);
            plog("streamproxy: XShmGetImage root %dx%d -> proxied\n",
                 image->width, image->height);
            return True;
        }
    }
    vlog("XShmGetImage dpy=%p drawable=0x%lx root=0x%lx %dx%d+%d+%d %s",
         (void *)dpy, (unsigned long)d, (unsigned long)DefaultRootWindow(dpy),
         image ? image->width : 0, image ? image->height : 0, x, y,
         (dpy != src_dpy && is_root(dpy, d)) ? "(should have proxied)" : "(fell through)");
    return real_XShmGetImage(dpy, d, image, x, y, plane_mask);
}

/* ------------------------------------------------------------------ */
/* xcb: xcb_get_image / xcb_get_image_reply (Qt QScreen::grabWindow)   */
/* ------------------------------------------------------------------ */

typedef xcb_get_image_cookie_t (*xcb_get_image_fn)(xcb_connection_t *, uint8_t,
                                                   xcb_drawable_t, int16_t,
                                                   int16_t, uint16_t, uint16_t,
                                                   uint32_t);
typedef xcb_get_image_reply_t *(*xcb_get_image_reply_fn)(
    xcb_connection_t *, xcb_get_image_cookie_t, xcb_generic_error_t **);

static xcb_get_image_fn real_xcb_get_image = NULL;
static xcb_get_image_reply_fn real_xcb_get_image_reply = NULL;

#define PROXY_MAP_SIZE 64
static struct {
    uint64_t seq;
    int valid;
    int16_t x, y;
    uint16_t w, h;
} proxy_map[PROXY_MAP_SIZE];

static xcb_window_t conn_root(xcb_connection_t *c) {
    xcb_screen_iterator_t it = xcb_setup_roots_iterator(xcb_get_setup(c));
    return it.rem ? it.data->root : 0;
}

xcb_get_image_cookie_t xcb_get_image(xcb_connection_t *c, uint8_t format,
                                     xcb_drawable_t drawable, int16_t x,
                                     int16_t y, uint16_t width, uint16_t height,
                                     uint32_t plane_mask) {
    if (!real_xcb_get_image)
        real_xcb_get_image = (xcb_get_image_fn)dlsym(RTLD_NEXT, "xcb_get_image");
    if (disabled())
        return real_xcb_get_image(c, format, drawable, x, y, width, height, plane_mask);
    vlog("xcb_get_image c=%p drawable=0x%x root=0x%x %ux%u+%d+%d %s",
         (void *)c, drawable, conn_root(c), width, height, x, y,
         (drawable == conn_root(c)) ? "(root)" : "(window)");
    xcb_get_image_cookie_t cookie =
        real_xcb_get_image(c, format, drawable, x, y, width, height, plane_mask);
    if (ensure_src_c() && c != src_c && drawable == conn_root(c) &&
        region_fits(x, y, width, height)) {
        /* Same protocol as the Xlib paths: report the capture region (the
         * plugin parks the gst window there) and keep the heartbeat fresh
         * so a live xcb-based share is never torn down mid-stream. */
        report_region(x, y, width, height);
        unsigned int slot = cookie.sequence % PROXY_MAP_SIZE;
        for (unsigned int i = 0; i < PROXY_MAP_SIZE; i++) {
            unsigned int s = (slot + i) % PROXY_MAP_SIZE;
            if (!proxy_map[s].valid) {
                proxy_map[s].valid = 1;
                proxy_map[s].seq = cookie.sequence;
                proxy_map[s].x = x;
                proxy_map[s].y = y;
                proxy_map[s].w = width;
                proxy_map[s].h = height;
                plog("streamproxy: xcb_get_image root %ux%u+%d+%d queued\n",
                     width, height, x, y);
                break;
            }
        }
    }
    return cookie;
}

xcb_get_image_reply_t *xcb_get_image_reply(xcb_connection_t *c,
                                           xcb_get_image_cookie_t cookie,
                                           xcb_generic_error_t **e) {
    if (!real_xcb_get_image_reply)
        real_xcb_get_image_reply =
            (xcb_get_image_reply_fn)dlsym(RTLD_NEXT, "xcb_get_image_reply");
    if (disabled())
        return real_xcb_get_image_reply(c, cookie, e);
    unsigned int slot = cookie.sequence % PROXY_MAP_SIZE;
    for (unsigned int i = 0; i < PROXY_MAP_SIZE; i++) {
        unsigned int s = (slot + i) % PROXY_MAP_SIZE;
        if (proxy_map[s].valid && proxy_map[s].seq == cookie.sequence) {
            proxy_map[s].valid = 0;
            /* swallow the real reply (BadMatch on rootless XWayland) */
            xcb_generic_error_t *lerr = NULL;
            xcb_get_image_reply_t *rr = real_xcb_get_image_reply(c, cookie, &lerr);
            free(rr);
            /* fetch the same region from the bridge display */
            xcb_get_image_cookie_t c2 =
                real_xcb_get_image(src_c, XCB_IMAGE_FORMAT_Z_PIXMAP, src_root,
                                   proxy_map[s].x, proxy_map[s].y,
                                   proxy_map[s].w, proxy_map[s].h, ~0);
            xcb_get_image_reply_t *r2 = real_xcb_get_image_reply(src_c, c2, NULL);
            if (r2) {
                uint8_t *data = (uint8_t *)(r2 + 1);
                size_t len = (size_t)r2->length * 4;
                xcb_get_image_reply_t *out =
                    malloc(sizeof(xcb_get_image_reply_t) + len);
                memset(out, 0, sizeof(xcb_get_image_reply_t));
                out->response_type = 1;
                out->depth = r2->depth;
                out->sequence = (uint16_t)cookie.sequence;
                out->visual = r2->visual;
                out->length = r2->length;
                memcpy(out + 1, data, len);
                free(r2);
                plog("streamproxy: xcb root grab %ux%u -> proxied\n",
                     proxy_map[s].w, proxy_map[s].h);
                return out;
            }
            plog("streamproxy: xcb src grab failed\n");
            return NULL;
        }
    }
    return real_xcb_get_image_reply(c, cookie, e);
}
