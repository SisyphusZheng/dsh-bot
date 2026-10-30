#!/usr/bin/env node
/**
 * Native desktop inspection for beta2 acceptance (B2-G13).
 *
 * Evidence levels this tool provides, in increasing strength:
 *  1. CGWindowListCopyWindowInfo through a tiny CLT-clang helper: a window is
 *     really on screen (kCGWindowIsOnscreen), its real layer, alpha and global
 *     frame are read from the window server, not from the page DOM.
 *  2. NSScreen inventory (frame / visibleFrame / backingScaleFactor) for
 *     edge/multi-display geometry checks.
 *  3. Window screenshot via `screencapture -l <windowNumber>` and full-screen
 *     screenshot via `screencapture -x`, plus the exact evidence path.
 *  4. Real HID-level pointer events (CGEventPost) so a click is delivered to
 *     whichever native window is topmost at that screen point - this is what
 *     tests click-through, not a CDP Input.dispatchMouseEvent.
 *  5. System Events window list (requires the Accessibility TCC grant) as an
 *     independent cross-check of frames/titles.
 *
 * DOM/CDP-only screenshots are NOT sufficient evidence for native visibility;
 * callers must combine page readiness with the window-server facts above.
 *
 * This module intentionally has no npm dependencies.
 */
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dirname, '../..')
const CACHE_DIR = process.env.DSH_BOT_NATIVE_CACHE || join(ROOT, '.mvv-build', 'native')
const PROBE_SOURCE_NAME = 'native-probe-v1.c'
const SCREEN_SAVER_LEVEL = 1000

const C_SOURCE = String.raw`
#include <CoreGraphics/CoreGraphics.h>
#include <CoreFoundation/CoreFoundation.h>
#include <ApplicationServices/ApplicationServices.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void jsonString(const char *s) {
  putchar('"');
  for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
    unsigned char c = *p;
    if (c == '"' || c == '\\') { putchar('\\'); putchar(c); }
    else if (c == '\n') fputs("\\n", stdout);
    else if (c == '\r') fputs("\\r", stdout);
    else if (c == '\t') fputs("\\t", stdout);
    else if (c < 0x20) printf("\\u%04x", c);
    else putchar(c);
  }
  putchar('"');
}

static void cfString(const CFDictionaryRef d, CFStringRef key, char *buf, size_t len) {
  buf[0] = 0;
  CFStringRef value = (CFStringRef)CFDictionaryGetValue(d, key);
  if (!value || CFGetTypeID(value) != CFStringGetTypeID()) return;
  CFStringGetCString(value, buf, len, kCFStringEncodingUTF8);
}

static int cfBool(const CFDictionaryRef d, CFStringRef key, int fallback) {
  CFTypeRef value = CFDictionaryGetValue(d, key);
  if (!value) return fallback;
  if (CFGetTypeID(value) == CFBooleanGetTypeID()) return CFBooleanGetValue((CFBooleanRef)value) ? 1 : 0;
  if (CFGetTypeID(value) == CFNumberGetTypeID()) { int out = fallback; CFNumberGetValue((CFNumberRef)value, kCFNumberIntType, &out); return out; }
  return fallback;
}

static int cfInt(const CFDictionaryRef d, CFStringRef key, int fallback) {
  CFNumberRef value = (CFNumberRef)CFDictionaryGetValue(d, key);
  int out = fallback;
  if (value && CFGetTypeID(value) == CFNumberGetTypeID()) CFNumberGetValue(value, kCFNumberIntType, &out);
  return out;
}

static double cfDouble(const CFDictionaryRef d, CFStringRef key, double fallback) {
  CFNumberRef value = (CFNumberRef)CFDictionaryGetValue(d, key);
  double out = fallback;
  if (value && CFGetTypeID(value) == CFNumberGetTypeID()) CFNumberGetValue(value, kCFNumberDoubleType, &out);
  return out;
}

static void cfBounds(const CFDictionaryRef d, double *x, double *y, double *w, double *h) {
  *x = *y = *w = *h = 0;
  CFDictionaryRef b = (CFDictionaryRef)CFDictionaryGetValue(d, kCGWindowBounds);
  if (!b || CFGetTypeID(b) != CFDictionaryGetTypeID()) return;
  *x = cfDouble(b, CFSTR("X"), 0);
  *y = cfDouble(b, CFSTR("Y"), 0);
  *w = cfDouble(b, CFSTR("Width"), 0);
  *h = cfDouble(b, CFSTR("Height"), 0);
}

static int cmdWindows(int argc, char **argv) {
  int filterPid = 0;
  int onscreenOnly = 1;
  for (int i = 0; i < argc; i++) {
    if (!strcmp(argv[i], "--pid") && i + 1 < argc) filterPid = atoi(argv[++i]);
    if (!strcmp(argv[i], "--all")) onscreenOnly = 0;
  }
  CFArrayRef list = CGWindowListCopyWindowInfo(
    (onscreenOnly ? kCGWindowListOptionOnScreenOnly : kCGWindowListOptionAll) | kCGWindowListExcludeDesktopElements,
    kCGNullWindowID);
  if (!list) { printf("{\"error\":\"no-window-list\"}\n"); return 1; }
  CFIndex n = CFArrayGetCount(list);
  printf("{\"backend\":\"CGWindowListCopyWindowInfo\",\"order\":\"front-to-back\",\"windows\":[");
  int first = 1;
  for (CFIndex i = 0; i < n; i++) {
    CFDictionaryRef d = (CFDictionaryRef)CFArrayGetValueAtIndex(list, i);
    if (!d || CFGetTypeID(d) != CFDictionaryGetTypeID()) continue;
    int pid = cfInt(d, kCGWindowOwnerPID, -1);
    if (filterPid && pid != filterPid) continue;
    char owner[512], name[512];
    cfString(d, kCGWindowOwnerName, owner, sizeof(owner));
    cfString(d, kCGWindowName, name, sizeof(name));
    double x, y, w, h;
    cfBounds(d, &x, &y, &w, &h);
    int onscreen = cfBool(d, kCGWindowIsOnscreen, 0);
    printf("%s{\"index\":%ld,\"owner\":", first ? "" : ",", (long)i); jsonString(owner);
    printf(",\"name\":"); jsonString(name);
    printf(",\"pid\":%d,\"windowNumber\":%d,\"layer\":%d,\"alpha\":%g,\"onscreen\":%s,\"x\":%g,\"y\":%g,\"w\":%g,\"h\":%g}",
      pid, cfInt(d, kCGWindowNumber, -1), cfInt(d, kCGWindowLayer, 0), cfDouble(d, kCGWindowAlpha, 1.0),
      onscreen ? "true" : "false", x, y, w, h);
    first = 0;
  }
  printf("]}\n");
  CFRelease(list);
  return 0;
}

static int cmdDisplays(void) {
  uint32_t count = 0;
  CGGetActiveDisplayList(0, NULL, &count);
  CGDirectDisplayID *displays = calloc(count ? count : 1, sizeof(CGDirectDisplayID));
  CGGetActiveDisplayList(count, displays, &count);
  printf("{\"backend\":\"CGGetActiveDisplayList\",\"mainDisplayId\":%u,\"displays\":[", (unsigned)CGMainDisplayID());
  for (uint32_t i = 0; i < count; i++) {
    CGRect b = CGDisplayBounds(displays[i]);
    CGDisplayModeRef mode = CGDisplayCopyDisplayMode(displays[i]);
    size_t pw = CGDisplayPixelsWide(displays[i]), ph = CGDisplayPixelsHigh(displays[i]);
    size_t modeW = mode ? CGDisplayModeGetWidth(mode) : 0, modeH = mode ? CGDisplayModeGetHeight(mode) : 0;
    size_t pixelW = mode ? CGDisplayModeGetPixelWidth(mode) : pw, pixelH = mode ? CGDisplayModeGetPixelHeight(mode) : ph;
    double scale = modeW > 0 ? (double)pixelW / (double)modeW : (b.size.width > 0 ? (double)pw / b.size.width : 1.0);
    printf("%s{\"id\":%u,\"main\":%s,\"active\":%s,\"asleep\":%s,\"x\":%g,\"y\":%g,\"w\":%g,\"h\":%g,\"pixelsWide\":%zu,\"pixelsHigh\":%zu,\"modeWidth\":%zu,\"modeHeight\":%zu,\"modePixelWidth\":%zu,\"modePixelHeight\":%zu,\"scale\":%g}",
      i ? "," : "", (unsigned)displays[i], CGDisplayIsMain(displays[i]) ? "true" : "false",
      CGDisplayIsActive(displays[i]) ? "true" : "false", CGDisplayIsAsleep(displays[i]) ? "true" : "false",
      b.origin.x, b.origin.y, b.size.width, b.size.height, pw, ph, modeW, modeH, pixelW, pixelH, scale);
    if (mode) CFRelease(mode);
  }
  printf("]}\n");
  free(displays);
  return 0;
}

static CGPoint mouseLocation(void) {
  CGEventRef e = CGEventCreate(NULL);
  CGPoint p = CGEventGetLocation(e);
  CFRelease(e);
  return p;
}

static void postMove(CGPoint p) {
  CGEventRef e = CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, p, kCGMouseButtonLeft);
  CGEventPost(kCGHIDEventTap, e);
  CFRelease(e);
}

static int cmdMouse(int argc, char **argv) {
  CGPoint p = mouseLocation();
  if (argc >= 2 && !strcmp(argv[0], "move")) {
    CGPoint target = CGPointMake(atof(argv[1]), atof(argv[2]));
    postMove(target);
    usleep(150000);
    CGPoint after = mouseLocation();
    printf("{\"command\":\"move\",\"requested\":[%g,%g],\"before\":[%g,%g],\"after\":[%g,%g],\"moved\":%s}\n",
      target.x, target.y, p.x, p.y, after.x, after.y,
      (fabs(after.x - target.x) < 2 && fabs(after.y - target.y) < 2) ? "true" : "false");
    return 0;
  }
  if (argc >= 5 && !strcmp(argv[0], "drag")) {
    CGPoint from = CGPointMake(atof(argv[1]), atof(argv[2]));
    CGPoint to = CGPointMake(atof(argv[3]), atof(argv[4]));
    postMove(from); usleep(150000);
    CGEventRef down = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown, from, kCGMouseButtonLeft);
    CGEventPost(kCGHIDEventTap, down); CFRelease(down);
    usleep(120000);
    for (int step = 1; step <= 14; step++) {
      double t = (double)step / 14.0;
      CGPoint point = CGPointMake(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
      CGEventRef dragged = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDragged, point, kCGMouseButtonLeft);
      CGEventPost(kCGHIDEventTap, dragged); CFRelease(dragged);
      usleep(45000);
    }
    usleep(120000);
    CGEventRef up = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseUp, to, kCGMouseButtonLeft);
    CGEventPost(kCGHIDEventTap, up); CFRelease(up);
    usleep(150000);
    CGPoint after = mouseLocation();
    printf("{\"command\":\"drag\",\"from\":[%g,%g],\"to\":[%g,%g],\"after\":[%g,%g]}\n",
      from.x, from.y, to.x, to.y, after.x, after.y);
    return 0;
  }
  if (argc >= 3 && !strcmp(argv[0], "click")) {
    CGPoint target = CGPointMake(atof(argv[1]), atof(argv[2]));
    int moveFirst = 1;
    for (int i = 3; i < argc; i++) if (!strcmp(argv[i], "--no-move")) moveFirst = 0;
    if (moveFirst) { postMove(target); usleep(250000); }
    CGEventRef down = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown, target, kCGMouseButtonLeft);
    CGEventPost(kCGHIDEventTap, down); CFRelease(down);
    usleep(90000);
    CGEventRef up = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseUp, target, kCGMouseButtonLeft);
    CGEventPost(kCGHIDEventTap, up); CFRelease(up);
    usleep(120000);
    CGPoint after = mouseLocation();
    printf("{\"command\":\"click\",\"requested\":[%g,%g],\"before\":[%g,%g],\"after\":[%g,%g],\"moveFirst\":%s,\"atTarget\":%s}\n",
      target.x, target.y, p.x, p.y, after.x, after.y, moveFirst ? "true" : "false",
      (fabs(after.x - target.x) < 2 && fabs(after.y - target.y) < 2) ? "true" : "false");
    return 0;
  }
  printf("{\"command\":\"location\",\"x\":%g,\"y\":%g}\n", p.x, p.y);
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 2) { fprintf(stderr, "usage: probe windows|displays|mouse [args]\n"); return 2; }
  if (!strcmp(argv[1], "windows")) return cmdWindows(argc - 2, argv + 2);
  if (!strcmp(argv[1], "displays")) return cmdDisplays();
  if (!strcmp(argv[1], "mouse")) return cmdMouse(argc - 2, argv + 2);
  fprintf(stderr, "unknown command: %s\n", argv[1]);
  return 2;
}
`

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...options })
}

let toolchainCache = null
export function toolchain() {
  if (toolchainCache) return toolchainCache
  const clang = run('/usr/bin/clang', ['--version']).split('\n')[0].trim()
  const sdk = run('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path']).trim()
  const swift = existsSync('/usr/bin/swift') ? spawnSync('/usr/bin/swift', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) : null
  toolchainCache = {
    clang,
    sdk,
    clangPath: '/usr/bin/clang',
    swiftVersion: swift && swift.status === 0 ? String(swift.stdout || swift.stderr).split('\n')[0].trim() : null,
    fullXcode: (() => {
      try { return run('/usr/bin/xcodebuild', ['-version']) } catch (error) { return `BLOCKED-ENVIRONMENT: ${String(error.stderr || error.message).split('\n')[0]}` }
    })(),
  }
  return toolchainCache
}

/** Compile (or reuse) the CLT-clang helper. Returns absolute path to the binary. */
export function ensureProbe({ force = false } = {}) {
  mkdirSync(CACHE_DIR, { recursive: true })
  const sourcePath = join(CACHE_DIR, PROBE_SOURCE_NAME)
  const binaryPath = join(CACHE_DIR, 'native-probe')
  const sourceSha256 = createHash('sha256').update(C_SOURCE).digest('hex')
  const stampPath = join(CACHE_DIR, 'native-probe.build.json')
  if (!force && existsSync(binaryPath) && existsSync(stampPath)) {
    try {
      const stamp = JSON.parse(readFileSync(stampPath, 'utf8'))
      if (stamp.sourceSha256 === sourceSha256 && existsSync(stamp.binaryPath)) return binaryPath
    } catch { /* rebuild below */ }
  }
  writeFileSync(sourcePath, C_SOURCE)
  const sdk = run('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path']).trim()
  const compileArgs = ['-O2', '-isysroot', sdk, '-framework', 'CoreGraphics', '-framework', 'CoreFoundation', '-framework', 'ApplicationServices', sourcePath, '-o', binaryPath]
  const startedAt = Date.now()
  const compiled = spawnSync('/usr/bin/clang', compileArgs, { encoding: 'utf8' })
  if (compiled.status !== 0) throw new Error(`native probe compile failed (${compiled.status}): ${compiled.stderr || compiled.error}`)
  writeFileSync(stampPath, JSON.stringify({
    sourceSha256, binaryPath, sourcePath, sdk, compileArgs,
    clang: toolchain().clang, compiledAt: new Date().toISOString(), compileMs: Date.now() - startedAt,
  }, null, 2) + '\n')
  return binaryPath
}

/** Window-server truth for all windows (or one owner PID). Front-to-back order. */
export function windows({ pid, onscreenOnly = true, force = false } = {}) {
  const probe = ensureProbe({ force })
  const args = ['windows']
  if (!onscreenOnly) args.push('--all')
  if (pid) args.push('--pid', String(pid))
  const parsed = JSON.parse(run(probe, args))
  return parsed
}

/** Display inventory from CGDisplay + NSScreen (logical frame, visibleFrame, scale). */
export function displays() {
  const probe = ensureProbe()
  const cg = JSON.parse(run(probe, ['displays']))
  let screens = []
  try {
    const js = `ObjC.import('AppKit');
const out = [];
const screens = $.NSScreen.screens;
for (let i = 0; i < screens.count; i++) {
  const s = screens.objectAtIndex(i);
  const f = s.frame, v = s.visibleFrame;
  out.push({frame:[f.origin.x,f.origin.y,f.size.width,f.size.height],visibleFrame:[v.origin.x,v.origin.y,v.size.width,v.size.height],scale:s.backingScaleFactor});
}
JSON.stringify(out)`
    screens = JSON.parse(run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', js]))
  } catch (error) {
    screens = [{ error: String(error.message) }]
  }
  return { backend: 'CGGetActiveDisplayList+NSScreen', ...cg, screens }
}

export function mouseLocation() {
  return JSON.parse(run(ensureProbe(), ['mouse']))
}

/** Real HID-level pointer move. Used to make bubble hit-testing receive pointer-enter first. */
export function moveMouse(x, y) {
  return JSON.parse(run(ensureProbe(), ['mouse', 'move', String(Math.round(x)), String(Math.round(y))]))
}

/** Real HID-level press-drag-release; used to move the pet window through its own drag handling. */
export function dragMouse(x1, y1, x2, y2) {
  return JSON.parse(run(ensureProbe(), ['mouse', 'drag', String(Math.round(x1)), String(Math.round(y1)), String(Math.round(x2)), String(Math.round(y2))]))
}

/** Real HID-level click at global screen coordinates (topmost window at that point receives it). */
export function clickAt(x, y, { moveFirst = true } = {}) {
  const args = ['mouse', 'click', String(Math.round(x)), String(Math.round(y))]
  if (!moveFirst) args.push('--no-move')
  return JSON.parse(run(ensureProbe(), args))
}

/** Screenshot a single native window by CGWindowID, or the whole screen. */
export function screenshot(path, { windowId } = {}) {
  mkdirSync(resolve(path, '..'), { recursive: true })
  const args = windowId ? ['-x', '-l', String(windowId), path] : ['-x', path]
  const result = spawnSync('/usr/sbin/screencapture', args, { encoding: 'utf8' })
  const ok = result.status === 0 && existsSync(path)
  return {
    ok, path, windowId: windowId ?? null,
    exitCode: result.status,
    error: ok ? null : String(result.stderr || result.error || '').trim() || 'screencapture failed (Screen Recording TCC?)',
  }
}

/** Independent window/frame list through System Events (Accessibility TCC). */
export function systemEventsWindows(pid) {
  const js = `ObjC.import('AppKit');
const se = Application('System Events');
const procs = se.processes.whose({unixId: ${Number(pid)}});
if (!procs.length) JSON.stringify({ ok: false, error: 'process not found' });
else {
  const proc = procs[0];
  const windows = proc.windows();
  const out = { ok: true, processName: proc.name(), frontmost: proc.frontmost(), windows: [] };
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    let position = null, size = null, name = null, role = null;
    try { position = w.position(); } catch (e) {}
    try { size = w.size(); } catch (e) {}
    try { name = w.name(); } catch (e) {}
    try { role = w.role(); } catch (e) {}
    out.windows.push({ index: i, name, role, position, size });
  }
  JSON.stringify(out);
}`
  try {
    const parsed = JSON.parse(run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', js]))
    const blocked = parsed.ok === false && /not authorized|not allowed|-1743/i.test(String(parsed.error))
    return blocked ? { ok: false, blocked: true, error: 'Accessibility TCC not granted', windows: [] } : parsed
  } catch (error) {
    const message = String(error.stderr || error.message)
    const blocked = /not authorized|not allowed|-1743/i.test(message)
    return { ok: false, blocked, error: message.split('\n')[0], windows: [] }
  }
}

/** Frontmost application name, e.g. to prove a bubble show did not steal keyboard focus. */
export function frontmostApp() {
  const js = `ObjC.import('AppKit'); JSON.stringify({ name: Application('System Events').processes.whose({frontmost: true})[0].name() })`
  try {
    return JSON.parse(run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', js]))
  } catch (error) {
    return { name: null, error: String(error.stderr || error.message).split('\n')[0] }
  }
}

/** Bring a named application to the front (used only for the focus-steal test). */
export function activateApp(name) {
  const escaped = String(name).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const js = `ObjC.import('AppKit'); const apps = Application('System Events').processes.whose({name: "${escaped}"}); if (!apps.length) JSON.stringify({ok:false,error:'app not running'}); else { apps[0].frontmost = true; JSON.stringify({ok:true,name:"${escaped}"}); }`
  try { return JSON.parse(run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', js])) } catch (error) { return { ok: false, error: String(error.stderr || error.message).split('\n')[0] } }
}

function safeScreens(displaysResult) {
  return (displaysResult.screens || []).filter(screen => Array.isArray(screen.frame))
}
export { SCREEN_SAVER_LEVEL, ROOT, safeScreens }

const cli = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (cli) {
  const [command, ...rest] = process.argv.slice(2)
  const option = name => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined }
  const output = (() => {
    switch (command) {
      case 'windows': return windows({ pid: option('--pid') ? Number(option('--pid')) : undefined, onscreenOnly: !rest.includes('--all'), force: rest.includes('--rebuild') })
      case 'displays': return displays()
      case 'toolchain': return toolchain()
      case 'mouse': return rest.length === 0 ? mouseLocation()
        : rest[0] === 'move' ? moveMouse(Number(rest[1]), Number(rest[2]))
        : rest[0] === 'click' ? clickAt(Number(rest[1]), Number(rest[2]))
        : rest[0] === 'drag' ? dragMouse(Number(rest[1]), Number(rest[2]), Number(rest[3]), Number(rest[4]))
        : { error: 'usage: mouse [location|move x y|click x y|drag x1 y1 x2 y2]' }
      case 'shot': return screenshot(rest[0], { windowId: option('--window') ? Number(option('--window')) : undefined })
      case 'ax-windows': return systemEventsWindows(Number(rest[0]))
      case 'frontmost': return frontmostApp()
      case 'activate': return activateApp(rest[0])
      default: return { usage: 'node product/tools/native-inspect.mjs windows [--pid N|--all] | displays | toolchain | mouse [move x y|click x y] | shot <png> [--window id] | ax-windows <pid> | frontmost | activate <app>' }
    }
  })()
  console.log(JSON.stringify(output, null, 2))
}
