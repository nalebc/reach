// Reach app displays: every app opened on the phone gets its own hidden
// display (CGVirtualDisplay, a private macOS API, checked at runtime). The
// app's window moves onto it at the phone's shape and Reach streams only that
// window. Nothing covers it, the person at the Mac doesn't see it, and several
// apps keep running side by side.
//
// JSON lines on stdin/stdout. Requests {"id":n,"cmd":...} get {"re":n,...} or
// {"re":n,"error":...}; events are {"event":...}. Closing a thread, "Return all"
// in the menu bar, stdin EOF or SIGTERM give every window back first.
//
// Pause ("pause", or Pause Reach in the menu bar) gives this Mac back to
// whoever is at it: every window comes back to the real screens, none is
// closed, the hidden displays go, and the threads are held. "resume" puts each
// held window back on a hidden display for the phone.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <IOKit/pwr_mgt/IOPMLib.h>
#import <libgen.h>
#import <libproc.h>
#import <os/lock.h>

extern AXError _AXUIElementGetWindow(AXUIElementRef, CGWindowID *);
@protocol ReachVirtualDisplay <NSObject>
- (instancetype)initWithDescriptor:(id)descriptor;
- (instancetype)initWithWidth:(unsigned)width height:(unsigned)height refreshRate:(double)rate;
- (BOOL)applySettings:(id)settings;
- (unsigned)displayID;
@end

static const int MAX_THREADS = 4;
static NSString *const PAUSED = @"Reach is paused on this Mac.";
// An agent while someone is at the Mac gets only a window of its own: an app
// that would lend its existing window (maybe the one they're using) is refused.
static NSDictionary *lendRefused(void) { return @{@"error": @"That app would lend a window someone may be using.", @"code": @"lend"}; }
// macOS only runs a desktop on modes of at least 640×600 points, and only
// starts a display in Retina (2x) by itself from 800 points wide; narrower ones
// came up at 1x, streaming blurry. A phone-width window therefore sits inside a
// display of at least 800 points, and the stream is cropped to the window.
static const CGFloat MIN_W = 800, MIN_H = 600, BOTTOM = 16, MAX_SIDE = 1900;
// Apps whose ⌘N opens a plain new window. Elsewhere ⌘N makes a note, an event
// or an email, so those apps lend their existing window instead.
static NSSet *newWindowApps;

// One pointer, two owners, like two mice on one Mac: whoever moves it last
// has it. When the phone uses an app, the pointer goes to that app's hidden
// display. When this Mac's own trackpad or mouse then moves, clicks or
// scrolls, the pointer comes back to where it last was on the real screens
// and carries on from there, instead of being lost on a screen nobody here
// can see. The phone's input comes from Reach's input helper; everything else
// (trackpad, mouse, other software) counts as this Mac's.
static os_unfair_lock pointerLock = OS_UNFAIR_LOCK_INIT;
static CGRect hiddenScreens[8], realScreens[16];
static int hiddenCount = 0, realCount = 0;
static CGPoint localPoint;
static BOOL localKnown = NO;
static CFMachPortRef pointerTap = NULL;
// When the phone last moved the pointer, and whether it holds a button down
// (a drag): after a short pause it hands the pointer back (bringPointerHome).
static CFAbsoluteTime phoneAt = 0;
static BOOL phoneDown = NO;
static BOOL fromPhone(pid_t pid) {
  static NSMutableDictionary<NSNumber *, NSNumber *> *known;
  static os_unfair_lock knownLock = OS_UNFAIR_LOCK_INIT;
  os_unfair_lock_lock(&knownLock);
  if (!known) known = [NSMutableDictionary dictionary];
  NSNumber *cached = known[@(pid)];
  os_unfair_lock_unlock(&knownLock);
  if (cached) return cached.boolValue;
  char path[PROC_PIDPATHINFO_MAXSIZE] = {0};
  BOOL phone = proc_pidpath(pid, path, sizeof path) > 0 &&
               strncmp(basename(path), "reach-desktop-input", 19) == 0;
  os_unfair_lock_lock(&knownLock);
  if (known.count > 256) [known removeAllObjects];
  known[@(pid)] = @(phone);
  os_unfair_lock_unlock(&knownLock);
  return phone;
}
static CGEventRef pointerMoved(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *info) {
  if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
    if (pointerTap) CGEventTapEnable(pointerTap, true);
    return event;
  }
  pid_t pid = (pid_t)CGEventGetIntegerValueField(event, kCGEventSourceUnixProcessID);
  if (pid > 0 && fromPhone(pid)) {
    // The phone takes the pointer: remember where it was on this Mac's
    // screens, so it comes back exactly there.
    CGEventRef now = CGEventCreate(NULL);
    CGPoint was = now ? CGEventGetLocation(now) : CGPointZero;
    if (now) CFRelease(now);
    os_unfair_lock_lock(&pointerLock);
    for (int i = 0; i < realCount; i++)
      if (CGRectContainsPoint(realScreens[i], was)) {
        localPoint = was;
        localKnown = YES;
      }
    phoneAt = CFAbsoluteTimeGetCurrent();
    if (type == kCGEventLeftMouseDown || type == kCGEventRightMouseDown || type == kCGEventOtherMouseDown)
      phoneDown = YES;
    else if (type == kCGEventLeftMouseUp || type == kCGEventRightMouseUp || type == kCGEventOtherMouseUp)
      phoneDown = NO;
    os_unfair_lock_unlock(&pointerLock);
    return event;
  }
  CGPoint at = CGEventGetLocation(event);
  os_unfair_lock_lock(&pointerLock);
  BOOL hidden = NO;
  for (int i = 0; i < hiddenCount; i++)
    if (CGRectContainsPoint(hiddenScreens[i], at)) hidden = YES;
  if (!hidden || !realCount) {
    if (!hidden) {
      localPoint = at;
      localKnown = YES;
    }
    os_unfair_lock_unlock(&pointerLock);
    return event;
  }
  CGPoint target = localKnown ? localPoint
                              : CGPointMake(CGRectGetMidX(realScreens[0]), CGRectGetMidY(realScreens[0]));
  if (type == kCGEventMouseMoved || type == kCGEventLeftMouseDragged || type == kCGEventRightMouseDragged ||
      type == kCGEventOtherMouseDragged) {
    target.x += CGEventGetDoubleValueField(event, kCGMouseEventDeltaX);
    target.y += CGEventGetDoubleValueField(event, kCGMouseEventDeltaY);
  }
  // Stay on a real screen: the one the pointer was on, if it would leave all.
  BOOL inside = NO;
  for (int i = 0; i < realCount; i++)
    if (CGRectContainsPoint(realScreens[i], target)) inside = YES;
  if (!inside) {
    CGRect home = realScreens[0];
    for (int i = 0; i < realCount; i++)
      if (CGRectContainsPoint(realScreens[i], localPoint)) home = realScreens[i];
    target.x = MIN(MAX(target.x, CGRectGetMinX(home)), CGRectGetMaxX(home) - 1);
    target.y = MIN(MAX(target.y, CGRectGetMinY(home)), CGRectGetMaxY(home) - 1);
  }
  localPoint = target;
  localKnown = YES;
  os_unfair_lock_unlock(&pointerLock);
  CGEventSetLocation(event, target);
  return event;
}
// The phone has let go of the pointer for a moment and it is still on a
// hidden display: put it back where this Mac's own user left it, so nobody
// at the Mac finds it gone (two people on one Mac). Never mid-drag, and only
// while it is still on a hidden display (the Mac's own mouse wins anyway).
static void bringPointerHome(void) {
  CGEventRef now = CGEventCreate(NULL);
  if (!now) return;
  CGPoint at = CGEventGetLocation(now);
  CFRelease(now);
  os_unfair_lock_lock(&pointerLock);
  BOOL hidden = NO;
  for (int i = 0; i < hiddenCount; i++)
    if (CGRectContainsPoint(hiddenScreens[i], at)) hidden = YES;
  BOOL idle = phoneAt > 0 && CFAbsoluteTimeGetCurrent() - phoneAt > 2.0 && !phoneDown;
  BOOL known = localKnown && realCount > 0;
  CGPoint home = localPoint;
  os_unfair_lock_unlock(&pointerLock);
  if (!hidden || !idle || !known) return;
  CGWarpMouseCursorPosition(home);
  CGAssociateMouseAndMouseCursorPosition(true);
}
static void emit(NSDictionary *value) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
  if (!data) return;
  @synchronized([NSFileHandle class]) {
    fwrite(data.bytes, 1, data.length, stdout);
    fputc('\n', stdout);
    fflush(stdout);
  }
}
static void pump(double seconds) {
  [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:seconds]];
}
static id attr(id element, CFStringRef name) {
  CFTypeRef value = NULL;
  if (element && AXUIElementCopyAttributeValue((__bridge AXUIElementRef)element, name, &value) == kAXErrorSuccess && value)
    return CFBridgingRelease(value);
  return nil;
}
static BOOL setAttr(id element, CFStringRef name, CFTypeRef value) {
  return element && AXUIElementSetAttributeValue((__bridge AXUIElementRef)element, name, value) == kAXErrorSuccess;
}
static CGRect frameOf(id window) {
  CGPoint p = CGPointZero;
  CGSize s = CGSizeZero;
  id pv = attr(window, kAXPositionAttribute), sv = attr(window, kAXSizeAttribute);
  if (pv) AXValueGetValue((__bridge AXValueRef)pv, kAXValueTypeCGPoint, &p);
  if (sv) AXValueGetValue((__bridge AXValueRef)sv, kAXValueTypeCGSize, &s);
  return (CGRect){p, s};
}
static void place(id window, CGPoint origin) {
  AXValueRef v = AXValueCreate(kAXValueTypeCGPoint, &origin);
  setAttr(window, kAXPositionAttribute, v);
  CFRelease(v);
}
static void resize(id window, CGSize size) {
  AXValueRef v = AXValueCreate(kAXValueTypeCGSize, &size);
  setAttr(window, kAXSizeAttribute, v);
  CFRelease(v);
}
static BOOL near(CGRect a, CGRect b) {
  return fabs(a.origin.x - b.origin.x) < 1.5 && fabs(a.origin.y - b.origin.y) < 1.5 &&
         fabs(a.size.width - b.size.width) < 1.5 && fabs(a.size.height - b.size.height) < 1.5;
}
// Position, size, position; then verify. A resize right after a move to
// another display can be dropped, so the size is retried until it holds.
static CGRect setFrame(id window, CGRect target) {
  place(window, target.origin);
  pump(0.05);
  resize(window, target.size);
  place(window, target.origin);
  CGRect now = frameOf(window);
  for (int pass = 0; pass < 4 && !near(now, target); pass++) {
    pump(0.12);
    resize(window, target.size);
    pump(0.05);
    place(window, target.origin);
    now = frameOf(window);
  }
  return now;
}
static CGWindowID windowNumber(id window) {
  CGWindowID number = 0;
  if (window) _AXUIElementGetWindow((__bridge AXUIElementRef)window, &number);
  return number;
}
static BOOL standard(id window) {
  NSString *subrole = attr(window, kAXSubroleAttribute);
  return !subrole || [subrole isEqual:(id)kAXStandardWindowSubrole];
}
static NSArray *windowsOf(id app) { return attr(app, kAXWindowsAttribute) ?: @[]; }
static NSDictionary *rect(CGRect r) {
  return @{@"x": @(round(r.origin.x)), @"y": @(round(r.origin.y)), @"w": @(round(r.size.width)), @"h": @(round(r.size.height))};
}
static NSString *str(id value) { return [value isKindOfClass:NSString.class] ? value : nil; }
static double num(id value, double fallback) { return [value isKindOfClass:NSNumber.class] ? [value doubleValue] : fallback; }

@interface Thread : NSObject
@property(copy) NSString *key, *name, *bundle;
@property unsigned slot;
@property(strong) id display;
@property CGDirectDisplayID displayID;
@property CGSize size, phone, minimum;
@property pid_t pid;
@property(strong) id app, window;
@property CGWindowID windowID;
@property BOOL created, wasMinimized, wasFullScreen;
@property CGRect original, region;
@property AXObserverRef observer;
@property BOOL settling, quitting;
// Paused: the window is back on this Mac's screens and belongs to it until
// Resume. Nothing closes or moves it meanwhile.
@property BOOL held;
@end
@implementation Thread
@end

@interface Displays : NSObject
@property(strong) NSMutableDictionary<NSString *, Thread *> *threads;
@property(strong) NSMutableArray *queue;
@property BOOL busy, ending, endRequested;
// `resident`: Reach asked for its menu bar item to stay while it runs (the
// "state" command), with Pause or Resume in it.
@property BOOL paused, resident;
@property(strong) NSStatusItem *item;
// Messages from the phone waiting for their Claude app chat ("waiting"):
// [{title, count, link}], listed in the menu; a click opens the chat.
@property(strong) NSArray *waiting;
@end

static Displays *shared;

static void observed(AXObserverRef observer, AXUIElementRef element, CFStringRef notification, void *context);

@implementation Displays
- (instancetype)init {
  self = [super init];
  _threads = [NSMutableDictionary dictionary];
  _queue = [NSMutableArray array];
  return self;
}
- (BOOL)available {
  return NSClassFromString(@"CGVirtualDisplay") && NSClassFromString(@"CGVirtualDisplayDescriptor") &&
         NSClassFromString(@"CGVirtualDisplayMode") && NSClassFromString(@"CGVirtualDisplaySettings");
}
- (Thread *)threadForDisplay:(CGDirectDisplayID)displayID {
  for (Thread *t in self.threads.allValues) if (t.displayID == displayID) return t;
  return nil;
}
// Hidden displays chain diagonally off the bottom-right corner of the real
// screens, touching only at corners, so the Mac's own mouse rarely wanders in.
- (void)arrange {
  CGDirectDisplayID online[32];
  uint32_t count = 0;
  if (CGGetOnlineDisplayList(32, online, &count) != kCGErrorSuccess) return;
  CGRect physical = CGRectNull;
  for (uint32_t i = 0; i < count; i++)
    if (![self threadForDisplay:online[i]]) physical = CGRectUnion(physical, CGDisplayBounds(online[i]));
  if (CGRectIsNull(physical)) return;
  CGFloat x = CGRectGetMaxX(physical), y = CGRectGetMaxY(physical);
  NSArray *ordered = [self.threads.allValues sortedArrayUsingComparator:^NSComparisonResult(Thread *a, Thread *b) {
    return a.slot < b.slot ? NSOrderedAscending : a.slot > b.slot ? NSOrderedDescending : NSOrderedSame;
  }];
  CGDisplayConfigRef config;
  if (CGBeginDisplayConfiguration(&config) != kCGErrorSuccess) return;
  for (Thread *t in ordered) {
    if (!t.displayID) continue;
    CGRect bounds = CGDisplayBounds(t.displayID);
    CGConfigureDisplayOrigin(config, t.displayID, (int32_t)x, (int32_t)y);
    x += bounds.size.width;
    y += bounds.size.height;
  }
  CGCompleteDisplayConfiguration(config, kCGConfigureForAppOnly);
  [self watchPointer];
}
// The watcher runs on its own thread, so nothing here (a slow app, a window
// being moved) can ever hold up this Mac's mouse.
- (void)watchPointer {
  CGDirectDisplayID online[32];
  uint32_t count = 0;
  CGGetOnlineDisplayList(32, online, &count);
  os_unfair_lock_lock(&pointerLock);
  hiddenCount = realCount = 0;
  for (uint32_t i = 0; i < count; i++) {
    CGRect bounds = CGDisplayBounds(online[i]);
    if ([self threadForDisplay:online[i]]) {
      if (hiddenCount < 8) hiddenScreens[hiddenCount++] = bounds;
    } else if (realCount < 16) {
      // The main screen first: where the pointer goes if none is known yet.
      if (CGDisplayIsMain(online[i]) && realCount) {
        realScreens[realCount++] = realScreens[0];
        realScreens[0] = bounds;
      } else
        realScreens[realCount++] = bounds;
    }
  }
  BOOL active = hiddenCount > 0;
  os_unfair_lock_unlock(&pointerLock);
  if (active && !pointerTap) {
    CGEventMask mask = CGEventMaskBit(kCGEventMouseMoved) | CGEventMaskBit(kCGEventLeftMouseDown) |
                       CGEventMaskBit(kCGEventLeftMouseUp) | CGEventMaskBit(kCGEventRightMouseDown) |
                       CGEventMaskBit(kCGEventRightMouseUp) | CGEventMaskBit(kCGEventOtherMouseDown) |
                       CGEventMaskBit(kCGEventOtherMouseUp) | CGEventMaskBit(kCGEventLeftMouseDragged) |
                       CGEventMaskBit(kCGEventRightMouseDragged) | CGEventMaskBit(kCGEventOtherMouseDragged) |
                       CGEventMaskBit(kCGEventScrollWheel);
    CFMachPortRef port = CGEventTapCreate(kCGHIDEventTap, kCGHeadInsertEventTap, kCGEventTapOptionDefault, mask,
                                          pointerMoved, NULL);
    if (!port) {
      // macOS refused (no Accessibility for Reach's terminal): say so once,
      // instead of the Mac's mouse quietly getting lost on hidden displays.
      static BOOL told = NO;
      if (!told) {
        told = YES;
        emit(@{@"event": @"pointer-guard", @"ok": @NO});
      }
      return;
    }
    pointerTap = port;
    NSThread *thread = [[NSThread alloc] initWithBlock:^{
      CFRunLoopSourceRef source = CFMachPortCreateRunLoopSource(NULL, port, 0);
      CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
      CFRelease(source);
      CFRunLoopRun();
    }];
    thread.qualityOfService = NSQualityOfServiceUserInteractive;
    [thread start];
  }
  if (pointerTap) CGEventTapEnable(pointerTap, active);
  static dispatch_source_t home = NULL;
  if (active && !home) {
    home = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0,
                                  dispatch_get_global_queue(QOS_CLASS_UTILITY, 0));
    dispatch_source_set_timer(home, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 2), NSEC_PER_SEC / 2,
                              NSEC_PER_SEC / 10);
    dispatch_source_set_event_handler(home, ^{
      bringPointerHome();
    });
    dispatch_resume(home);
  }
}
// Retina: the 2x mode at the display's size. macOS sometimes starts at 1x.
// Retina: the 2x mode at the display's size. macOS can start a display, or
// keep a resized one, at 1x; switching may only succeed once it has settled.
- (BOOL)isRetina:(Thread *)t {
  CGDisplayModeRef current = CGDisplayCopyDisplayMode(t.displayID);
  BOOL done = current && CGDisplayModeGetWidth(current) == (size_t)t.size.width &&
              CGDisplayModeGetPixelWidth(current) == 2 * (size_t)t.size.width;
  if (current) CGDisplayModeRelease(current);
  return done;
}
- (void)retina:(Thread *)t {
  for (int attempt = 0; attempt < 100 && ![self isRetina:t]; attempt++) {
    NSArray *modes = CFBridgingRelease(CGDisplayCopyAllDisplayModes(
        t.displayID, (__bridge CFDictionaryRef) @{(id)kCGDisplayShowDuplicateLowResolutionModes: @YES}));
    for (id m in modes) {
      CGDisplayModeRef mode = (__bridge CGDisplayModeRef)m;
      if (CGDisplayModeGetWidth(mode) != (size_t)t.size.width || CGDisplayModeGetHeight(mode) != (size_t)t.size.height ||
          CGDisplayModeGetPixelWidth(mode) != 2 * (size_t)t.size.width)
        continue;
      if (CGDisplaySetDisplayMode(t.displayID, mode, NULL) != kCGErrorSuccess) {
        CGDisplayConfigRef config;
        if (CGBeginDisplayConfiguration(&config) == kCGErrorSuccess) {
          CGConfigureDisplayWithDisplayMode(config, t.displayID, mode, NULL);
          CGCompleteDisplayConfiguration(config, kCGConfigureForAppOnly);
        }
      }
      break;
    }
    pump(0.05);
  }
}
- (BOOL)applySize:(Thread *)t {
  id mode = [(id<ReachVirtualDisplay>)[NSClassFromString(@"CGVirtualDisplayMode") alloc]
      initWithWidth:(unsigned)t.size.width height:(unsigned)t.size.height refreshRate:60.0];
  id settings = [NSClassFromString(@"CGVirtualDisplaySettings") new];
  [settings setValue:@1 forKey:@"hiDPI"];
  [settings setValue:@[mode] forKey:@"modes"];
  return [(id<ReachVirtualDisplay>)t.display applySettings:settings];
}
- (NSString *)createDisplay:(Thread *)t {
  NSMutableSet *used = [NSMutableSet set];
  for (Thread *other in self.threads.allValues) [used addObject:@(other.slot)];
  for (unsigned slot = 1; slot <= MAX_THREADS; slot++)
    if (![used containsObject:@(slot)]) { t.slot = slot; break; }
  if (!t.slot) return @"Four apps are already open on your phone. Close one first.";
  id descriptor = [NSClassFromString(@"CGVirtualDisplayDescriptor") new];
  [descriptor setValue:[NSString stringWithFormat:@"Reach · %@", t.name ?: @"App"] forKey:@"name"];
  [descriptor setValue:@((unsigned)MAX_SIDE * 2) forKey:@"maxPixelsWide"];
  [descriptor setValue:@((unsigned)MAX_SIDE * 2) forKey:@"maxPixelsHigh"];
  // Stable identity per slot: macOS keeps per-display settings keyed by it,
  // so slots are reused instead of piling up new entries. A second Reach (a
  // test copy) uses its own range so the two never claim the same display.
  unsigned identity = t.slot + (unsigned)MIN(64, MAX(0, atoi(getenv("REACH_APP_DISPLAY_SLOTS") ?: "0")));
  [descriptor setValue:@(0x5243) forKey:@"vendorID"];
  [descriptor setValue:@(0x41505000 + identity) forKey:@"productID"];
  [descriptor setValue:@(0x52454100 + identity) forKey:@"serialNum"];
  if ([descriptor respondsToSelector:NSSelectorFromString(@"setSerialNumber:")])
    [descriptor setValue:@(0x52454100 + identity) forKey:@"serialNumber"];
  [descriptor setValue:[NSValue valueWithSize:NSMakeSize(MAX_SIDE * 2 * 25.4 / 220, MAX_SIDE * 2 * 25.4 / 220)]
                forKey:@"sizeInMillimeters"];
  [descriptor setValue:dispatch_get_global_queue(QOS_CLASS_USER_INTERACTIVE, 0) forKey:@"queue"];
  t.display = [(id<ReachVirtualDisplay>)[NSClassFromString(@"CGVirtualDisplay") alloc] initWithDescriptor:descriptor];
  if (!t.display || ![self applySize:t]) {
    t.display = nil;
    return @"macOS refused the hidden display for this app.";
  }
  t.displayID = [(id<ReachVirtualDisplay>)t.display displayID];
  for (int i = 0; i < 60 && !CGDisplayIsActive(t.displayID); i++) pump(0.05);
  if (!t.displayID || !CGDisplayIsActive(t.displayID)) {
    t.display = nil;
    return @"macOS did not turn on the hidden display for this app.";
  }
  [self retina:t];
  [self arrange];
  pump(0.3);
  return nil;
}
- (BOOL)growDisplay:(Thread *)t to:(CGSize)size {
  if (size.width <= t.size.width && size.height <= t.size.height) return YES;
  t.size = CGSizeMake(MIN(MAX_SIDE, MAX(t.size.width, size.width)), MIN(MAX_SIDE, MAX(t.size.height, size.height)));
  if (![self applySize:t]) return NO;
  pump(0.3);
  [self retina:t];
  [self arrange];
  pump(0.3);
  return YES;
}
- (CGFloat)menuBar:(Thread *)t {
  for (NSScreen *screen in NSScreen.screens)
    if ([screen.deviceDescription[@"NSScreenNumber"] unsignedIntValue] == t.displayID)
      return MAX(0, NSMaxY(screen.frame) - NSMaxY(screen.visibleFrame));
  return 30;
}
// The window keeps the phone's proportions at the app's own minimum width.
static CGSize windowSize(CGSize phone, CGSize minimum) {
  CGFloat ratio = phone.height / MAX(1, phone.width);
  CGFloat w = MAX(phone.width, minimum.width), h = w * ratio;
  if (h < minimum.height) { h = minimum.height; w = MAX(w, h / ratio); }
  return CGSizeMake(round(w), round(h));
}
// Big enough for the window in both orientations, so rotating never
// reconfigures the Mac's displays.
- (CGSize)displayFor:(Thread *)t menuBar:(CGFloat)top {
  CGSize portrait = windowSize(CGSizeMake(MIN(t.phone.width, t.phone.height), MAX(t.phone.width, t.phone.height)), t.minimum);
  CGSize landscape = windowSize(CGSizeMake(MAX(t.phone.width, t.phone.height), MIN(t.phone.width, t.phone.height)), t.minimum);
  return CGSizeMake(ceil(MAX(MIN_W, MAX(portrait.width, landscape.width))),
                    ceil(MAX(MIN_H, top + BOTTOM + MAX(portrait.height, landscape.height))));
}
- (NSDictionary *)fit:(Thread *)t {
  CGFloat top = [self menuBar:t];
  CGSize wanted = [self displayFor:t menuBar:top];
  if (![self growDisplay:t to:wanted]) return @{@"error": @"macOS refused to resize the hidden display."};
  for (int round = 0; round < 3; round++) {
    CGRect bounds = CGDisplayBounds(t.displayID);
    top = [self menuBar:t];
    CGSize size = windowSize(t.phone, t.minimum);
    size.width = MIN(size.width, bounds.size.width);
    size.height = MIN(size.height, bounds.size.height - top - BOTTOM);
    // Flush with the right edge and just under the menu bar: menus that
    // would cross the edge flip back over the window.
    CGRect target = CGRectMake(CGRectGetMaxX(bounds) - size.width, bounds.origin.y + top, size.width, size.height);
    CGRect actual = setFrame(t.window, target);
    BOOL wider = actual.size.width > target.size.width + 1, taller = actual.size.height > target.size.height + 1;
    if (wider || taller) {
      // The app refused to shrink: learn only the side it refused, grow the
      // display, and fit again.
      t.minimum = CGSizeMake(wider ? MAX(t.minimum.width, actual.size.width) : t.minimum.width,
                             taller ? MAX(t.minimum.height, actual.size.height) : t.minimum.height);
      if (![self growDisplay:t to:[self displayFor:t menuBar:top]]) break;
      continue;
    }
    if (actual.size.width < target.size.width - 1 || actual.size.height < target.size.height - 1) {
      // A fixed-size window (Calculator): keep it flush right under the menu bar.
      actual = setFrame(t.window, CGRectMake(CGRectGetMaxX(bounds) - actual.size.width, bounds.origin.y + top,
                                             actual.size.width, actual.size.height));
    }
    break;
  }
  CGRect frame = frameOf(t.window), bounds = CGDisplayBounds(t.displayID);
  t.region = CGRectIntersection(CGRectOffset(frame, -bounds.origin.x, -bounds.origin.y),
                                CGRectMake(0, 0, bounds.size.width, bounds.size.height));
  return nil;
}
- (NSDictionary *)describe:(Thread *)t {
  CGRect bounds = CGDisplayBounds(t.displayID);
  CGDisplayModeRef mode = CGDisplayCopyDisplayMode(t.displayID);
  double scale = mode && bounds.size.width ? (double)CGDisplayModeGetPixelWidth(mode) / bounds.size.width : 2;
  if (mode) CGDisplayModeRelease(mode);
  return @{
    @"thread": t.key,
    @"display": [NSString stringWithFormat:@"%u", t.displayID],
    @"size": @{@"w": @(bounds.size.width), @"h": @(bounds.size.height)},
    @"region": rect(t.region),
    @"scale": @(scale),
    @"created": @(t.created),
    @"minimum": @{@"w": @(t.minimum.width), @"h": @(t.minimum.height)},
    @"app": @{@"name": t.name ?: @"", @"bundle": t.bundle ?: @"", @"pid": @(t.pid)},
  };
}
- (void)observe:(Thread *)t {
  AXObserverRef observer = NULL;
  if (AXObserverCreate(t.pid, observed, &observer) != kAXErrorSuccess) return;
  void *context = (__bridge void *)t;
  AXObserverAddNotification(observer, (__bridge AXUIElementRef)t.window, kAXMovedNotification, context);
  AXObserverAddNotification(observer, (__bridge AXUIElementRef)t.window, kAXResizedNotification, context);
  AXObserverAddNotification(observer, (__bridge AXUIElementRef)t.window, kAXUIElementDestroyedNotification, context);
  CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), kCFRunLoopDefaultMode);
  t.observer = observer;
}
- (void)unobserve:(Thread *)t {
  if (!t.observer) return;
  CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(t.observer), kCFRunLoopDefaultMode);
  CFRelease(t.observer);
  t.observer = NULL;
}
// The app moved or resized its own window, or closed it.
- (void)changed:(Thread *)t closed:(BOOL)closed {
  if (self.threads[t.key] != t || t.settling || t.held) return;
  if (closed) {
    [self unobserve:t];
    t.window = nil;
    emit(@{@"event": @"closed", @"thread": t.key});
    return;
  }
  CGRect frame = frameOf(t.window), bounds = CGDisplayBounds(t.displayID);
  CGRect region = CGRectIntersection(CGRectOffset(frame, -bounds.origin.x, -bounds.origin.y),
                                     CGRectMake(0, 0, bounds.size.width, bounds.size.height));
  if (CGRectIsNull(region) || near(region, t.region)) return;
  t.region = region;
  emit(@{@"event": @"region", @"thread": t.key, @"region": rect(region)});
}
- (id)appWindow:(id)app excluding:(NSSet *)before timeout:(double)seconds {
  NSDate *end = [NSDate dateWithTimeIntervalSinceNow:seconds];
  do {
    for (id w in windowsOf(app))
      if (standard(w) && ![before containsObject:@(windowNumber(w))] && ![attr(w, kAXMinimizedAttribute) boolValue]) return w;
    pump(0.05);
  } while ([end timeIntervalSinceNow] > 0);
  return nil;
}
// The menu item bound to ⌘N, also inside a submenu (Terminal keeps it under
// New Window ▸ its default profile).
static id commandN(NSArray *items, int depth) {
  for (id item in items) {
    NSString *key = str(attr(item, kAXMenuItemCmdCharAttribute));
    NSNumber *modifiers = attr(item, kAXMenuItemCmdModifiersAttribute);
    if ([key isEqual:@"N"] && modifiers && modifiers.intValue == kAXMenuItemModifierNone) return item;
    if (depth > 0)
      for (id submenu in attr(item, kAXChildrenAttribute) ?: @[]) {
        id found = commandN(attr(submenu, kAXChildrenAttribute) ?: @[], depth - 1);
        if (found) return found;
      }
  }
  return nil;
}
- (id)menuItemForNewWindow:(id)app {
  for (id top in attr(attr(app, kAXMenuBarAttribute), kAXChildrenAttribute) ?: @[])
    for (id menu in attr(top, kAXChildrenAttribute) ?: @[]) {
      id found = commandN(attr(menu, kAXChildrenAttribute) ?: @[], 1);
      if (found) return found;
    }
  return nil;
}
- (NSDictionary *)open:(NSDictionary *)request {
  NSString *key = str(request[@"thread"]), *path = str(request[@"path"]);
  NSDictionary *phone = request[@"phone"];
  if (!key || !path || ![phone isKindOfClass:NSDictionary.class]) return @{@"error": @"Invalid request."};
  if (self.paused) return @{@"error": PAUSED};
  if (self.threads[key] && !self.threads[key].held) return [self describe:self.threads[key]];
  if (self.threads[key]) return [self resume:request];
  if (![self available]) return @{@"error": @"This Mac can't create hidden displays."};
  if (!AXIsProcessTrusted())
    return @{@"error": @"Allow Accessibility for Reach in System Settings → Privacy & Security → Accessibility.", @"code": @"accessibility"};
  if (self.threads.count >= MAX_THREADS) return @{@"error": @"Four apps are already open on your phone. Close one first."};
  CGFloat pw = MIN(1000, MAX(200, num(phone[@"w"], 393))), ph = MIN(1000, MAX(200, num(phone[@"h"], 852)));
  NSDictionary *hint = request[@"minimum"];
  Thread *t = [Thread new];
  t.key = key;
  t.phone = CGSizeMake(pw, ph);
  t.minimum = [hint isKindOfClass:NSDictionary.class] ? CGSizeMake(MIN(MAX_SIDE, num(hint[@"w"], 0)), MIN(MAX_SIDE, num(hint[@"h"], 0)))
                                                       : CGSizeZero;

  // The app: running already, or launched without taking focus from the Mac.
  NSURL *url = [NSURL fileURLWithPath:path];
  NSBundle *bundle = [NSBundle bundleWithURL:url];
  NSString *bundleID = bundle.bundleIdentifier;
  NSRunningApplication *running = bundleID ? [NSRunningApplication runningApplicationsWithBundleIdentifier:bundleID].firstObject : nil;
  NSMutableSet *before = [NSMutableSet set];
  id app = nil;
  if (running) {
    app = CFBridgingRelease(AXUIElementCreateApplication(running.processIdentifier));
    AXUIElementSetMessagingTimeout((__bridge AXUIElementRef)app, 2.0);
    for (id w in windowsOf(app)) [before addObject:@(windowNumber(w))];
  }
  BOOL hadWindows = before.count > 0;
  BOOL mayLend = ![request[@"lend"] isEqual:@NO];
  if (!mayLend && hadWindows && ![newWindowApps containsObject:(running.bundleIdentifier ?: bundleID ?: @"")]) return lendRefused();
  if (!running || !hadWindows) {
    __block NSRunningApplication *launched = nil;
    __block BOOL finished = NO;
    NSWorkspaceOpenConfiguration *config = [NSWorkspaceOpenConfiguration configuration];
    config.activates = NO;
    config.addsToRecentItems = NO;
    [NSWorkspace.sharedWorkspace openApplicationAtURL:url configuration:config completionHandler:^(NSRunningApplication *a, NSError *e) {
      launched = a;
      finished = YES;
    }];
    NSDate *end = [NSDate dateWithTimeIntervalSinceNow:20];
    while (!finished && [end timeIntervalSinceNow] > 0) pump(0.05);
    running = launched ?: running;
    if (!running) return @{@"error": @"That app didn't open on the Mac."};
    if (!app) {
      app = CFBridgingRelease(AXUIElementCreateApplication(running.processIdentifier));
      AXUIElementSetMessagingTimeout((__bridge AXUIElementRef)app, 2.0);
    }
  }
  t.pid = running.processIdentifier;
  t.bundle = running.bundleIdentifier ?: bundleID ?: @"";
  t.name = running.localizedName ?: [path.lastPathComponent stringByDeletingPathExtension];
  t.app = app;

  // A size learned last time only pre-sizes the display, so it rarely needs
  // to grow; the window always learns the app's real minimum afresh.
  t.size = [self displayFor:t menuBar:30];
  t.minimum = CGSizeZero;
  // Known before it exists, so placement treats it as a hidden display and
  // puts it off the corner of the real screens.
  self.threads[key] = t;
  NSString *failure = [self createDisplay:t];
  if (failure) {
    [self.threads removeObjectForKey:key];
    return @{@"error": failure};
  }
  t.settling = YES;

  // Its window: the one a launch just opened, a fresh one where ⌘N means
  // "New Window", or the app's own main window, lent and given back later.
  id window = nil;
  if (!hadWindows) {
    window = [self appWindow:app excluding:before timeout:15];
    t.created = window != nil;
  } else if ([newWindowApps containsObject:t.bundle]) {
    id item = [self menuItemForNewWindow:app];
    if (item && AXUIElementPerformAction((__bridge AXUIElementRef)item, kAXPressAction) == kAXErrorSuccess) {
      window = [self appWindow:app excluding:before timeout:5];
      t.created = window != nil;
    }
  }
  // No window of its own (a menu of an app in the background can do nothing):
  // refused before its existing window is touched.
  if (!window && hadWindows && !mayLend) {
    [self destroy:t];
    return lendRefused();
  }
  if (!window) {
    window = attr(app, kAXMainWindowAttribute) ?: attr(app, kAXFocusedWindowAttribute);
    if (!window || !standard(window)) {
      window = nil;
      for (id w in windowsOf(app)) if (standard(w)) { window = w; break; }
    }
    if (window) {
      t.wasMinimized = [attr(window, kAXMinimizedAttribute) boolValue];
      if (t.wasMinimized) { setAttr(window, kAXMinimizedAttribute, kCFBooleanFalse); pump(0.4); }
      t.wasFullScreen = [attr(window, CFSTR("AXFullScreen")) boolValue];
      if (t.wasFullScreen) { setAttr(window, CFSTR("AXFullScreen"), kCFBooleanFalse); pump(1.2); }
      t.original = frameOf(window);
    }
  }
  if (!window) {
    [self destroy:t];
    return @{@"error": [NSString stringWithFormat:@"%@ has no window to show.", t.name]};
  }
  t.window = window;
  t.windowID = windowNumber(window);
  NSDictionary *error = [self fit:t];
  t.settling = NO;
  if (error) {
    [self giveBack:t];
    [self destroy:t];
    return error;
  }
  [self observe:t];
  [self updateMenu];
  return [self describe:t];
}
- (NSDictionary *)rotate:(NSDictionary *)request {
  Thread *t = self.threads[str(request[@"thread"]) ?: @""];
  NSDictionary *phone = request[@"phone"];
  if (!t || ![phone isKindOfClass:NSDictionary.class]) return @{@"error": @"That app isn't open on your phone."};
  if (t.held) return @{@"error": PAUSED};
  if (!t.window) return @{@"error": @"That window was closed on the Mac."};
  t.phone = CGSizeMake(MIN(1000, MAX(200, num(phone[@"w"], t.phone.width))), MIN(1000, MAX(200, num(phone[@"h"], t.phone.height))));
  t.settling = YES;
  NSDictionary *error = [self fit:t];
  t.settling = NO;
  return error ?: [self describe:t];
}
// Where the window's text fields are, so the phone can open its keyboard in
// the same tap (Safari only opens it during a tap, before any reply). Rects
// are in points from the window's top-left. The walk is bounded in time and
// skips anything scrolled out of view; pages refresh it after each gesture.
- (NSDictionary *)fields:(NSDictionary *)request {
  Thread *t = self.threads[str(request[@"thread"]) ?: @""];
  if (!t || !t.window) return @{@"error": @"That app isn't open on your phone."};
  if (t.held) return @{@"error": PAUSED};
  static NSSet *editable;
  static NSArray *names;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    editable = [NSSet setWithArray:@[(id)kAXTextFieldRole, (id)kAXTextAreaRole, (id)kAXComboBoxRole, @"AXSearchField"]];
    names = @[(id)kAXRoleAttribute, (id)kAXSubroleAttribute, (id)kAXPositionAttribute, (id)kAXSizeAttribute,
              (id)kAXChildrenAttribute, (id)kAXEnabledAttribute];
  });
  CGRect window = frameOf(t.window);
  NSMutableArray *found = [NSMutableArray array];
  NSMutableArray *queue = [NSMutableArray arrayWithObject:t.window];
  CFAbsoluteTime start = CFAbsoluteTimeGetCurrent();
  NSUInteger next = 0;
  while (next < queue.count && next < 5000 && found.count < 300 && CFAbsoluteTimeGetCurrent() - start < 0.15) {
    id element = queue[next++];
    CFArrayRef raw = NULL;
    if (AXUIElementCopyMultipleAttributeValues((__bridge AXUIElementRef)element, (__bridge CFArrayRef)names, 0, &raw) !=
            kAXErrorSuccess || !raw)
      continue;
    NSArray *values = CFBridgingRelease(raw);
    id (^value)(NSUInteger) = ^id(NSUInteger i) {
      id v = i < values.count ? values[i] : nil;
      if (v && CFGetTypeID((__bridge CFTypeRef)v) == AXValueGetTypeID() &&
          AXValueGetType((__bridge AXValueRef)v) == kAXValueTypeAXError)
        return nil;
      return v;
    };
    CGPoint p = CGPointZero;
    CGSize size = CGSizeZero;
    id position = value(2), extent = value(3);
    BOOL framed = position && extent && AXValueGetValue((__bridge AXValueRef)position, kAXValueTypeCGPoint, &p) &&
                  AXValueGetValue((__bridge AXValueRef)extent, kAXValueTypeCGSize, &size);
    CGRect frame = (CGRect){p, size};
    // Nothing out of view: long web pages stay cheap.
    if (framed && !CGRectIntersectsRect(frame, window)) continue;
    if ([editable containsObject:str(value(0)) ?: @""]) {
      id enabled = value(5);
      if (framed && size.width >= 4 && size.height >= 4 && (!enabled || [enabled boolValue])) {
        CGRect r = CGRectIntersection(frame, window);
        [found addObject:@{
          @"x": @(round(r.origin.x - window.origin.x)),
          @"y": @(round(r.origin.y - window.origin.y)),
          @"w": @(round(r.size.width)),
          @"h": @(round(r.size.height)),
          @"secure": @([str(value(1)) isEqual:(id)kAXSecureTextFieldSubrole]),
        }];
      }
      continue;
    }
    id children = value(4);
    if ([children isKindOfClass:NSArray.class]) [queue addObjectsFromArray:children];
  }
  return @{@"fields": found, @"complete": @(next >= queue.count)};
}
// Quit the app, the way ⌘Q does: it can still ask to save. If it also has
// windows on the Mac's own screens, the phone confirms first. When it can't
// quit yet (a question is showing), the thread stays so the phone can answer.
- (NSDictionary *)quit:(NSDictionary *)request {
  Thread *t = self.threads[str(request[@"thread"]) ?: @""];
  if (!t) return @{@"quit": @YES};
  if (t.held) return @{@"error": PAUSED};
  NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:t.pid];
  if (!app || app.terminated) {
    [self ended:t.pid];
    return @{@"quit": @YES};
  }
  NSUInteger others = 0;
  for (id w in windowsOf(t.app)) {
    if (!standard(w)) continue;
    CGRect f = frameOf(w);
    CGPoint mid = CGPointMake(CGRectGetMidX(f), CGRectGetMidY(f));
    BOOL hidden = NO;
    for (Thread *other in self.threads.allValues)
      if (other.displayID && CGRectContainsPoint(CGDisplayBounds(other.displayID), mid)) hidden = YES;
    if (!hidden) others++;
  }
  if (others && ![request[@"confirm"] boolValue]) return @{@"confirm": @YES, @"others": @(others)};
  t.quitting = YES;
  [app terminate];
  for (int i = 0; i < 160 && !app.terminated; i++) pump(0.05);
  if (!app.terminated) return @{@"quit": @NO, @"waiting": @YES};
  [self ended:t.pid];
  return @{@"quit": @YES};
}
// The app quit, from the phone or on the Mac: its threads end.
- (void)ended:(pid_t)pid {
  for (Thread *t in self.threads.allValues.copy) {
    if (t.pid != pid) continue;
    [self unobserve:t];
    t.window = nil;
    [self destroy:t];
    emit(@{@"event": @"quit", @"thread": t.key});
  }
}
- (NSDictionary *)activate:(NSDictionary *)request {
  Thread *t = self.threads[str(request[@"thread"]) ?: @""];
  if (!t) return @{@"error": @"That app isn't open on your phone."};
  if (t.held) return @{@"error": PAUSED};
  [[NSRunningApplication runningApplicationWithProcessIdentifier:t.pid] activateWithOptions:0];
  if (t.window) {
    setAttr(t.window, kAXMainAttribute, kCFBooleanTrue);
    AXUIElementPerformAction((__bridge AXUIElementRef)t.window, kAXRaiseAction);
  }
  return @{@"ok": @YES};
}
// The window back on this Mac's own screens: a borrowed one where it was
// (minimized or full screen again if it was), one Reach opened, or one whose
// place is gone, centered near the top of the main screen.
- (BOOL)bringBack:(Thread *)t {
  id window = t.window;
  if (!window) return NO;
  CGRect main = CGDisplayBounds(CGMainDisplayID());
  CGRect target = t.original;
  BOOL onScreen = NO;
  CGDirectDisplayID online[32];
  uint32_t count = 0;
  CGGetOnlineDisplayList(32, online, &count);
  for (uint32_t i = 0; i < count; i++)
    if (online[i] != t.displayID && ![self threadForDisplay:online[i]] && CGRectIntersectsRect(CGDisplayBounds(online[i]), target))
      onScreen = YES;
  if (t.created || CGRectIsEmpty(target) || !onScreen) {
    CGSize size = frameOf(window).size;
    size.width = MIN(size.width, main.size.width - 80);
    size.height = MIN(size.height, main.size.height - 120);
    target = CGRectMake(CGRectGetMidX(main) - size.width / 2, main.origin.y + 60, size.width, size.height);
  }
  BOOL returned = near(setFrame(window, target), target);
  if (t.wasMinimized) setAttr(window, kAXMinimizedAttribute, kCFBooleanTrue);
  if (t.wasFullScreen) setAttr(window, CFSTR("AXFullScreen"), kCFBooleanTrue);
  return returned;
}
// A window Reach opened is closed; one it borrowed goes back where it was.
// If closing is blocked (unsaved changes, "close 5 tabs?"), the window comes
// back to the main screen instead of vanishing with the display. A held
// (paused) window is already this Mac's and stays exactly as it is: Reach
// quitting while paused never closes what someone is using.
- (NSDictionary *)giveBack:(Thread *)t {
  [self unobserve:t];
  if (t.held) {
    t.window = nil;
    return @{@"closed": @NO, @"returned": @YES};
  }
  BOOL closed = NO, returned = NO;
  id window = t.window;
  if (window && t.created) {
    id button = attr(window, kAXCloseButtonAttribute);
    if (button) AXUIElementPerformAction((__bridge AXUIElementRef)button, kAXPressAction);
    for (int i = 0; i < 20 && !closed; i++) {
      pump(0.05);
      closed = YES;
      for (id w in windowsOf(t.app)) if (windowNumber(w) == t.windowID) closed = NO;
    }
  }
  if (window && !closed) returned = [self bringBack:t];
  t.window = nil;
  return @{@"closed": @(closed), @"returned": @(returned)};
}
// The hidden display goes; the thread may stay (paused).
- (void)dropDisplay:(Thread *)t {
  BOOL had = t.display != nil;
  t.display = nil;
  t.displayID = 0;
  if (had) {
    // WindowServer can defer removing a display while the real screens
    // sleep. A short activity assertion lets it finish; it changes no setting.
    IOPMAssertionID wake = kIOPMNullAssertionID;
    if (IOPMAssertionDeclareUserActivity(CFSTR("Reach hidden display cleanup"), kIOPMUserActiveLocal, &wake) == kIOReturnSuccess) {
      IOPMAssertionSetProperty(wake, kIOPMAssertionTimeoutKey, (__bridge CFTypeRef) @2);
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{ IOPMAssertionRelease(wake); });
    }
  }
}
- (void)destroy:(Thread *)t {
  [self unobserve:t];
  [self dropDisplay:t];
  [self.threads removeObjectForKey:t.key];
  [self arrange];
  [self updateMenu];
}
// Pause: every app's window comes back to this Mac's screens (none is
// closed), the hidden displays go, and the threads are held for Resume.
- (NSDictionary *)hold {
  NSMutableArray *held = [NSMutableArray array];
  for (Thread *t in self.threads.allValues) {
    [held addObject:t.key];
    if (t.held) continue;
    [self unobserve:t];
    // Held first: a move reported just before must not reach the phone.
    t.held = YES;
    [self bringBack:t];
    [self dropDisplay:t];
  }
  [self arrange];
  [self updateMenu];
  return @{@"held": held};
}
// Resume: a held window goes back onto a fresh hidden display at the phone's
// shape, from wherever it is now. If it was closed meanwhile (or its app
// quit), the reply says "gone" and the phone's app opens anew.
- (NSDictionary *)resume:(NSDictionary *)request {
  Thread *t = self.threads[str(request[@"thread"]) ?: @""];
  if (!t) return @{@"error": @"That app isn't waiting for your phone.", @"code": @"gone"};
  if (!t.held) return [self describe:t];
  if (!AXIsProcessTrusted())
    return @{@"error": @"Allow Accessibility for Reach in System Settings → Privacy & Security → Accessibility.", @"code": @"accessibility"};
  NSRunningApplication *running = [NSRunningApplication runningApplicationWithProcessIdentifier:t.pid];
  BOOL present = NO;
  if (t.window && running && !running.terminated)
    for (id w in windowsOf(t.app)) if (windowNumber(w) == t.windowID) present = YES;
  if (!present) {
    t.window = nil;
    [self.threads removeObjectForKey:t.key];
    [self updateMenu];
    return @{@"error": [NSString stringWithFormat:@"%@'s window was closed on the Mac.", t.name], @"code": @"gone"};
  }
  BOOL minimized = [attr(t.window, kAXMinimizedAttribute) boolValue];
  BOOL full = [attr(t.window, CFSTR("AXFullScreen")) boolValue];
  if (minimized) { setAttr(t.window, kAXMinimizedAttribute, kCFBooleanFalse); pump(0.4); }
  if (full) { setAttr(t.window, CFSTR("AXFullScreen"), kCFBooleanFalse); pump(1.2); }
  // A borrowed window will go back to where it is now, as it is now.
  if (!t.created) {
    t.wasMinimized = minimized;
    t.wasFullScreen = full;
    t.original = frameOf(t.window);
  }
  t.held = NO;
  t.slot = 0;
  t.size = [self displayFor:t menuBar:30];
  NSString *failure = [self createDisplay:t];
  if (failure) {
    // The window never left this Mac's screens.
    t.window = nil;
    [self destroy:t];
    return @{@"error": failure};
  }
  t.settling = YES;
  NSDictionary *error = [self fit:t];
  t.settling = NO;
  if (error) {
    [self bringBack:t];
    t.window = nil;
    [self destroy:t];
    return error;
  }
  [self observe:t];
  [self updateMenu];
  return [self describe:t];
}
- (NSDictionary *)close:(NSDictionary *)request {
  Thread *t = self.threads[str(request[@"thread"]) ?: @""];
  if (!t) return @{@"closed": @NO, @"returned": @NO, @"gone": @YES};
  NSDictionary *result = [self giveBack:t];
  [self destroy:t];
  return result;
}
- (void)returnAllClicked:(id)sender {
  [self enqueue:@{@"cmd": @"return-all"}];
}
- (void)returnAll {
  for (Thread *t in self.threads.allValues.copy) {
    [self giveBack:t];
    [self destroy:t];
    emit(@{@"event": @"released", @"thread": t.key});
  }
}
- (void)pauseClicked:(id)sender {
  emit(@{@"event": @"pause"});
}
- (void)resumeClicked:(id)sender {
  emit(@{@"event": @"resume"});
}
// A waiting message's chat, opened in the Claude app (it goes in from there).
- (void)openWaitingClicked:(NSMenuItem *)sender {
  NSURL *url = [NSURL URLWithString:sender.representedObject ?: @""];
  if ([url.scheme isEqual:@"claude"]) [NSWorkspace.sharedWorkspace openURL:url];
}
// The Mac always shows that apps are on a phone, and can take them back.
// While Reach runs it also keeps a small item of its own: Pause gives this
// Mac back to whoever is at it; Resume lends it to the phone again.
- (void)updateMenu {
  NSMutableArray *names = [NSMutableArray array];
  for (Thread *t in self.threads.allValues)
    if (!t.held) [names addObject:t.name ?: @"App"];
  [names sortUsingSelector:@selector(localizedCaseInsensitiveCompare:)];
  NSUInteger waitingCount = 0;
  for (NSDictionary *chat in self.waiting) waitingCount += MAX(1, [chat[@"count"] unsignedIntegerValue]);
  if (!names.count && !self.resident) {
    if (self.item) [NSStatusBar.systemStatusBar removeStatusItem:self.item];
    self.item = nil;
    return;
  }
  if (!self.item) self.item = [NSStatusBar.systemStatusBar statusItemWithLength:NSVariableStatusItemLength];
  NSString *symbol = self.paused ? @"iphone.slash" : @"iphone.radiowaves.left.and.right";
  NSImage *image = [NSImage imageWithSystemSymbolName:symbol accessibilityDescription:@"Reach"];
  image.template = YES;
  self.item.button.image = names.count ? nil : image;
  self.item.button.title = names.count == 1 ? [NSString stringWithFormat:@"Reach · %@", names.firstObject]
                           : names.count ? [NSString stringWithFormat:@"Reach · %lu apps", (unsigned long)names.count]
                           : image ? @"" : self.paused ? @"Reach · Paused" : @"Reach";
  self.item.button.toolTip = self.paused ? @"Reach is paused" : @"Open on a phone through Reach";
  // A message from the phone waiting: its count beside the mark.
  if (waitingCount && !names.count) {
    self.item.button.image = image;
    self.item.button.title = [NSString stringWithFormat:@" %lu", (unsigned long)waitingCount];
    self.item.button.toolTip = waitingCount == 1 ? @"A message from your phone is waiting for its chat" : @"Messages from your phone are waiting for their chats";
  }
  NSMenu *menu = [NSMenu new];
  NSString *title = self.paused ? @"Paused · your phone can't see or use this Mac"
                    : names.count ? [NSString stringWithFormat:@"On your phone: %@", [names componentsJoinedByString:@", "]]
                                  : @"Reach is on";
  NSMenuItem *heading = [[NSMenuItem alloc] initWithTitle:title action:nil keyEquivalent:@""];
  heading.enabled = NO;
  [menu addItem:heading];
  if (self.waiting.count) {
    [menu addItem:[NSMenuItem separatorItem]];
    NSMenuItem *about = [[NSMenuItem alloc] initWithTitle:@"From your phone, waiting in the Claude app" action:nil keyEquivalent:@""];
    about.enabled = NO;
    [menu addItem:about];
    for (NSDictionary *chat in self.waiting) {
      NSUInteger count = MAX(1, [chat[@"count"] unsignedIntegerValue]);
      NSString *line = count == 1 ? [NSString stringWithFormat:@"Open \u201c%@\u201d", str(chat[@"title"])]
                                  : [NSString stringWithFormat:@"Open \u201c%@\u201d \u00b7 %lu messages", str(chat[@"title"]), (unsigned long)count];
      NSMenuItem *open = [[NSMenuItem alloc] initWithTitle:line action:@selector(openWaitingClicked:) keyEquivalent:@""];
      open.target = self;
      open.representedObject = str(chat[@"link"]);
      [menu addItem:open];
    }
    [menu addItem:[NSMenuItem separatorItem]];
  }
  if (names.count) {
    NSMenuItem *give = [[NSMenuItem alloc] initWithTitle:@"Return all to this Mac" action:@selector(returnAllClicked:) keyEquivalent:@""];
    give.target = self;
    [menu addItem:give];
  }
  if (self.resident) {
    [menu addItem:[NSMenuItem separatorItem]];
    NSMenuItem *toggle = self.paused
        ? [[NSMenuItem alloc] initWithTitle:@"Resume Reach" action:@selector(resumeClicked:) keyEquivalent:@""]
        : [[NSMenuItem alloc] initWithTitle:@"Pause Reach" action:@selector(pauseClicked:) keyEquivalent:@""];
    toggle.target = self;
    [menu addItem:toggle];
  }
  self.item.menu = menu;
}
- (void)end {
  if (self.busy) {
    self.endRequested = YES;
    return;
  }
  if (self.ending) return;
  self.ending = YES;
  for (Thread *t in self.threads.allValues.copy) {
    [self giveBack:t];
    [self destroy:t];
  }
  pump(0.6);
  exit(0);
}
- (void)handle:(NSDictionary *)request {
  NSString *cmd = str(request[@"cmd"]);
  NSDictionary *result;
  @try {
    if ([cmd isEqual:@"probe"])
      result = @{@"available": @([self available]), @"accessibility": (AXIsProcessTrusted() ? @YES : @NO),
                 @"screenRecording": @(CGPreflightScreenCaptureAccess())};
    else if ([cmd isEqual:@"open"]) result = [self open:request];
    else if ([cmd isEqual:@"rotate"]) result = [self rotate:request];
    else if ([cmd isEqual:@"activate"]) result = [self activate:request];
    else if ([cmd isEqual:@"close"]) result = [self close:request];
    else if ([cmd isEqual:@"fields"]) result = [self fields:request];
    else if ([cmd isEqual:@"quit"]) result = [self quit:request];
    else if ([cmd isEqual:@"pause"]) result = [self hold];
    else if ([cmd isEqual:@"resume"]) result = [self resume:request];
    else if ([cmd isEqual:@"state"]) {
      self.resident = YES;
      self.paused = [request[@"paused"] boolValue];
      [self updateMenu];
      result = @{@"paused": @(self.paused)};
    }
    else if ([cmd isEqual:@"ended"]) {
      [self ended:(pid_t)[request[@"pid"] intValue]];
      return;
    } else if ([cmd isEqual:@"return-all"]) {
      [self returnAll];
      return;
    }
    else if ([cmd isEqual:@"waiting"]) {
      self.waiting = [request[@"chats"] isKindOfClass:NSArray.class] ? request[@"chats"] : @[];
      [self updateMenu];
      result = @{@"waiting": @(self.waiting.count)};
    }
    else if ([cmd isEqual:@"list"]) {
      NSMutableArray *list = [NSMutableArray array];
      for (Thread *t in self.threads.allValues)
        if (!t.held) [list addObject:[self describe:t]];
      result = @{@"threads": list};
    } else result = @{@"error": @"Unknown command."};
  } @catch (NSException *e) {
    result = @{@"error": e.reason ?: @"The app display helper failed."};
  }
  if (!request[@"id"]) return;
  NSMutableDictionary *reply = [result mutableCopy];
  reply[@"re"] = request[@"id"];
  emit(reply);
}
// One request at a time: handlers wait for windows by running the run loop,
// which must not start another request halfway through.
- (void)enqueue:(NSDictionary *)request {
  [self.queue addObject:request];
  if (self.busy) return;
  self.busy = YES;
  while (self.queue.count && !self.ending) {
    NSDictionary *next = self.queue.firstObject;
    [self.queue removeObjectAtIndex:0];
    [self handle:next];
  }
  self.busy = NO;
  if (self.endRequested) [self end];
}
@end

static void observed(AXObserverRef observer, AXUIElementRef element, CFStringRef notification, void *context) {
  Thread *t = (__bridge Thread *)context;
  BOOL closed = CFEqual(notification, kAXUIElementDestroyedNotification);
  // Coalesce a burst of moves and resizes into one report.
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(closed ? 0 : 150 * NSEC_PER_MSEC)), dispatch_get_main_queue(), ^{
    [shared changed:t closed:closed];
  });
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    newWindowApps = [NSSet setWithArray:@[
      @"com.google.Chrome", @"com.google.Chrome.beta", @"com.google.Chrome.canary", @"org.chromium.Chromium",
      @"com.brave.Browser", @"com.microsoft.edgemac", @"company.thebrowser.Browser", @"com.vivaldi.Vivaldi",
      @"com.operasoftware.Opera", @"com.apple.Safari", @"com.apple.SafariTechnologyPreview", @"org.mozilla.firefox",
      @"com.apple.finder", @"com.apple.Terminal", @"com.googlecode.iterm2",
    ]];
    if (argc > 1 && strcmp(argv[1], "--probe") == 0) {
      Displays *probe = [Displays new];
      emit(@{@"available": @([probe available]), @"accessibility": (AXIsProcessTrusted() ? @YES : @NO),
             @"screenRecording": @(CGPreflightScreenCaptureAccess())});
      return 0;
    }
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    shared = [Displays new];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      char *line = NULL;
      size_t capacity = 0;
      ssize_t length;
      while ((length = getline(&line, &capacity, stdin)) > 0) {
        if (length > 16384) continue;
        NSData *data = [NSData dataWithBytes:line length:(NSUInteger)length];
        NSDictionary *request = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
        if (![request isKindOfClass:NSDictionary.class]) continue;
        dispatch_async(dispatch_get_main_queue(), ^{ [shared enqueue:request]; });
      }
      free(line);
      dispatch_async(dispatch_get_main_queue(), ^{ [shared end]; });
    });
    signal(SIGTERM, SIG_IGN);
    // An app quitting on its own (or crashing) ends its threads too.
    [NSWorkspace.sharedWorkspace.notificationCenter addObserverForName:NSWorkspaceDidTerminateApplicationNotification
                                                                object:nil
                                                                 queue:NSOperationQueue.mainQueue
                                                            usingBlock:^(NSNotification *note) {
      NSRunningApplication *app = note.userInfo[NSWorkspaceApplicationKey];
      if (app) [shared enqueue:@{@"cmd": @"ended", @"pid": @(app.processIdentifier)}];
    }];
    // The app in front, now and at each change, and each app opening: a
    // message from the phone waiting because you're in the Claude app goes
    // in once you step away from it (or once the app opens).
    void (^tell)(NSString *, NSRunningApplication *) = ^(NSString *event, NSRunningApplication *app) {
      emit(@{@"event": event, @"bundle": app.bundleIdentifier ?: @""});
    };
    tell(@"frontmost", NSWorkspace.sharedWorkspace.frontmostApplication);
    [NSWorkspace.sharedWorkspace.notificationCenter addObserverForName:NSWorkspaceDidActivateApplicationNotification
                                                                object:nil
                                                                 queue:NSOperationQueue.mainQueue
                                                            usingBlock:^(NSNotification *note) {
      tell(@"frontmost", note.userInfo[NSWorkspaceApplicationKey]);
    }];
    [NSWorkspace.sharedWorkspace.notificationCenter addObserverForName:NSWorkspaceDidLaunchApplicationNotification
                                                                object:nil
                                                                 queue:NSOperationQueue.mainQueue
                                                            usingBlock:^(NSNotification *note) {
      tell(@"launched", note.userInfo[NSWorkspaceApplicationKey]);
    }];
    dispatch_source_t termination = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, SIGTERM, 0, dispatch_get_main_queue());
    dispatch_source_set_event_handler(termination, ^{ [shared end]; });
    dispatch_resume(termination);
    [NSApp run];
  }
  return 0;
}
