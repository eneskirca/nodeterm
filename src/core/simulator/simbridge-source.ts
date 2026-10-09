/**
 * The Swift source of `nt-simbridge`, the helper behind the Simulator node (see simulator-service).
 *
 * Shipped as SOURCE and compiled on the user's Mac with `xcrun swiftc` on first use: any machine
 * that has iOS simulators has Xcode, so nothing native ships with nodeterm, nothing is signed for
 * it, and the binary always matches the Xcode it talks to (the cache key includes Xcode's build).
 *
 * It uses Xcode's PRIVATE simulator frameworks — the ones DeviceHub itself uses — resolved at
 * runtime (dlopen / NSClassFromString / dlsym), so nothing links against them and an Xcode that
 * moved something fails with a sentence instead of a crash. The Indigo HID message layout is from
 * facebook/idb (FBSimulatorControl, MIT), whose reverse engineering tracks current Xcodes.
 *
 * Wire format
 *   stdout  frames: "NTF2" | u32 width | u32 height | u32 displayIndex | u32 jpegLength | jpeg   (LE)
 *   stdin   one JSON command per line:
 *             {"t":"down"|"move"|"up","x":0..1,"y":0..1}   a touch at a ratio of the screen
 *             {"t":"key","usage":N,"down":bool}            HID keyboard usage (page 7)
 *             {"t":"button","name":"home"|"lock"|"side"|"siri"|"volup"|"voldown"|"playpause"}
 *             (down/move/up take an optional "edge": 1 top, 2 left, 3 bottom, 4 right)
 *             {"t":"gesture","name":"app-switcher"}         swipe up from the bottom edge and hold
 *             {"t":"display","index":N|-1}                 pin a display; -1 = automatic
 *             {"t":"orientation","value":1..4}             GSEvent orientation (Purple values:
 *                                                          1 portrait, 2 upside down, 3/4 landscape)
 *   stderr  one JSON status line per event: {"ok":…} / {"error":…}
 *
 * Kept free of backticks and dollar-brace sequences so it can live in a TypeScript string.
 */
export const SIMBRIDGE_VERSION = 4

export const SIMBRIDGE_SOURCE = String.raw`
import CoreGraphics
import Darwin
import Foundation
import ImageIO
import IOSurface
import UniformTypeIdentifiers

let statusLock = NSLock()
func status(_ obj: [String: Any]) {
  guard let d = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: d, encoding: .utf8) else { return }
  statusLock.lock(); defer { statusLock.unlock() }
  FileHandle.standardError.write((s + "\n").data(using: .utf8)!)
}
func fail(_ code: String, _ msg: String) -> Never {
  status(["error": code, "message": msg])
  exit(2)
}

// ── Arguments ──────────────────────────────────────────────────────────────────────────────────
let args = CommandLine.arguments
guard args.count >= 2 else { fail("usage", "nt-simbridge <udid> [--fps N] [--max-width PX] [--quality Q]") }
let udid = args[1].uppercased()
func argValue(_ name: String, _ def: Double) -> Double {
  if let i = args.firstIndex(of: name), i + 1 < args.count, let v = Double(args[i + 1]) { return v }
  return def
}
let fps = max(1, min(60, argValue("--fps", 30)))
let maxWidth = max(200, min(2000, argValue("--max-width", 900)))
let quality = max(0.2, min(0.95, argValue("--quality", 0.6)))

// ── Frameworks ─────────────────────────────────────────────────────────────────────────────────
func developerDir() -> String {
  let p = Process()
  p.executableURL = URL(fileURLWithPath: "/usr/bin/xcode-select")
  p.arguments = ["-p"]
  let pipe = Pipe()
  p.standardOutput = pipe
  try? p.run()
  p.waitUntilExit()
  return String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
    .trimmingCharacters(in: .whitespacesAndNewlines) ?? "/Applications/Xcode.app/Contents/Developer"
}
let devDir = developerDir()
let xcodeContents = (devDir as NSString).deletingLastPathComponent
let simulatorKitPath = xcodeContents + "/SharedFrameworks/SimulatorKit.framework/SimulatorKit"
for path in ["/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", simulatorKitPath] {
  if dlopen(path, RTLD_NOW | RTLD_GLOBAL) == nil {
    fail("framework", "could not load " + path + ": " + String(cString: dlerror()))
  }
}
let msgSend = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "objc_msgSend")!

func call(_ obj: AnyObject, _ sel: String) -> AnyObject? {
  let s = NSSelectorFromString(sel)
  guard obj.responds(to: s) else { return nil }
  return obj.perform(s)?.takeUnretainedValue()
}

// ── Device ─────────────────────────────────────────────────────────────────────────────────────
guard let contextClass = NSClassFromString("SimServiceContext") else { fail("framework", "SimServiceContext not found") }
typealias ContextFn = @convention(c) (AnyObject, Selector, NSString, UnsafeMutablePointer<NSError?>?) -> AnyObject?
var ctxErr: NSError?
guard let context = unsafeBitCast(msgSend, to: ContextFn.self)(contextClass, NSSelectorFromString("sharedServiceContextForDeveloperDir:error:"), devDir as NSString, &ctxErr) else {
  fail("framework", "SimServiceContext: " + (ctxErr?.localizedDescription ?? "nil"))
}
typealias DeviceSetFn = @convention(c) (AnyObject, Selector, UnsafeMutablePointer<NSError?>?) -> AnyObject?
var setErr: NSError?
guard let deviceSet = unsafeBitCast(msgSend, to: DeviceSetFn.self)(context, NSSelectorFromString("defaultDeviceSetWithError:"), &setErr),
      let devices = (deviceSet as AnyObject).value(forKey: "devices") as? [AnyObject] else {
  fail("framework", "device set: " + (setErr?.localizedDescription ?? "nil"))
}
guard let device = devices.first(where: { (($0.value(forKey: "UDID") as? NSUUID)?.uuidString ?? "") == udid }) else {
  fail("no-device", "no simulator " + udid)
}
let stateString = (device.value(forKey: "stateString") as? String) ?? "?"
guard stateString == "Booted" else { fail("not-booted", "the simulator is " + stateString) }

// ── Displays ───────────────────────────────────────────────────────────────────────────────────
// A device can have several main-class displays: a foldable has an inner and a cover screen, and
// only one of them is lit at a time. All of them are tracked; the lit one is shown (see pickActive).
struct Display { let index: Int; let surface: IOSurface; let screenID: UInt32; let name: String }

/// Touches go to the shown screen's own digitizer: 0x40000000 | screenID. MEASURED on a foldable
/// (Xcode 27, "iPhone Duo"): the generic main-screen target (0x32) reached neither screen while the
/// cover screen was the lit one; the cover screen's target did. 0x32 remains the fallback for a
/// display that vends no screen id.
func touchTarget(_ d: Display) -> UInt32 { d.screenID > 0 ? (0x4000_0000 | d.screenID) : 0x32 }

func mainDisplays() -> [Display] {
  guard let io = device.value(forKey: "io") as AnyObject?, let ports = call(io, "ioPorts") as? [AnyObject] else { return [] }
  var out: [Display] = []
  for port in ports {
    guard let descriptor = call(port, "descriptor") else { continue }
    guard let s = call(descriptor, "framebufferSurface") ?? call(descriptor, "ioSurface"), CFGetTypeID(s) == IOSurfaceGetTypeID() else { continue }
    var displayClass = -1
    // "state" is a ROCK proxy: no key-value coding, so message displayClass (an unsigned short).
    if let state = call(descriptor, "state"), state.responds(to: NSSelectorFromString("displayClass")) {
      typealias U16Fn = @convention(c) (AnyObject, Selector) -> UInt16
      displayClass = Int(unsafeBitCast(msgSend, to: U16Fn.self)(state, NSSelectorFromString("displayClass")))
    }
    guard displayClass == 0 else { continue }
    var screenID: UInt32 = 0
    var name = ""
    if let props = call(descriptor, "screenProperties") {
      if props.responds(to: NSSelectorFromString("screenID")) {
        typealias U32Fn = @convention(c) (AnyObject, Selector) -> UInt32
        screenID = unsafeBitCast(msgSend, to: U32Fn.self)(props, NSSelectorFromString("screenID"))
      }
      name = (call(props, "name") as? String) ?? ""
    }
    out.append(Display(index: out.count, surface: unsafeBitCast(s, to: IOSurface.self), screenID: screenID, name: name))
  }
  return out
}

/// Whether a surface shows anything: a sparse grid of pixels, any brighter than near-black.
func isLit(_ s: IOSurface) -> Bool {
  IOSurfaceLock(s, .readOnly, nil)
  defer { IOSurfaceUnlock(s, .readOnly, nil) }
  let w = IOSurfaceGetWidth(s), h = IOSurfaceGetHeight(s), bpr = IOSurfaceGetBytesPerRow(s)
  let base = IOSurfaceGetBaseAddress(s).assumingMemoryBound(to: UInt8.self)
  for gy in 1..<8 {
    for gx in 1..<8 {
      let p = base.advanced(by: (h * gy / 8) * bpr + (w * gx / 8) * 4)
      if Int(p[0]) + Int(p[1]) + Int(p[2]) > 60 { return true }
    }
  }
  return false
}

var displays = mainDisplays()
guard !displays.isEmpty else { fail("no-display", "the simulator has no framebuffer display") }
var activeIndex = displays.firstIndex(where: { isLit($0.surface) }) ?? 0
var pinned = false
var lastSeeds = displays.map { IOSurfaceGetSeed($0.surface) }
var lastChange = displays.map { _ in Date.distantPast }
func announce() {
  status(["ok": "displays", "active": activeIndex, "pinned": pinned,
          "displays": displays.map { ["index": $0.index, "width": IOSurfaceGetWidth($0.surface), "height": IOSurfaceGetHeight($0.surface),
                                       "screenID": $0.screenID, "name": $0.name] }])
}
announce()

// ── Frames ─────────────────────────────────────────────────────────────────────────────────────
let out = FileHandle.standardOutput
let colorSpace = CGColorSpaceCreateDeviceRGB()
var sentSeed: UInt32 = 0
var sentIndex = -1

func encode(_ s: IOSurface) -> (Data, Int, Int)? {
  IOSurfaceLock(s, .readOnly, nil)
  defer { IOSurfaceUnlock(s, .readOnly, nil) }
  let w = IOSurfaceGetWidth(s), h = IOSurfaceGetHeight(s)
  guard let ctx = CGContext(data: IOSurfaceGetBaseAddress(s), width: w, height: h, bitsPerComponent: 8,
                            bytesPerRow: IOSurfaceGetBytesPerRow(s), space: colorSpace,
                            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue),
        let full = ctx.makeImage() else { return nil }
  let scale = min(1.0, maxWidth / Double(w))
  var image = full
  if scale < 1.0 {
    let ow = Int(Double(w) * scale), oh = Int(Double(h) * scale)
    if let small = CGContext(data: nil, width: ow, height: oh, bitsPerComponent: 8, bytesPerRow: 0, space: colorSpace,
                             bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) {
      small.interpolationQuality = .medium
      small.draw(full, in: CGRect(x: 0, y: 0, width: ow, height: oh))
      if let i = small.makeImage() { image = i }
    }
  }
  let data = NSMutableData()
  guard let dest = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
  CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
  guard CGImageDestinationFinalize(dest) else { return nil }
  return (data as Data, image.width, image.height)
}

func le32(_ v: Int) -> Data { var x = UInt32(truncatingIfNeeded: v).littleEndian; return Data(bytes: &x, count: 4) }

let frameQueue = DispatchQueue(label: "nt.simbridge.frames")
var ticks = 0
let timer = DispatchSource.makeTimerSource(queue: frameQueue)
timer.schedule(deadline: .now(), repeating: 1.0 / fps)
timer.setEventHandler {
  ticks += 1
  // Surfaces can be replaced (rotation, a display coming up): re-resolve every ~2 s.
  if ticks % Int(fps * 2) == 0 {
    let fresh = mainDisplays()
    // Compare by IOSurface id: the private API hands back a fresh proxy object on every call.
    if !fresh.isEmpty, fresh.count != displays.count || zip(fresh, displays).contains(where: { IOSurfaceGetID($0.surface) != IOSurfaceGetID($1.surface) }) {
      displays = fresh
      lastSeeds = displays.map { IOSurfaceGetSeed($0.surface) }
      lastChange = displays.map { _ in Date() }
      if activeIndex >= displays.count { activeIndex = 0 }
      announce()
    }
  }
  let now = Date()
  for (i, d) in displays.enumerated() {
    let seed = IOSurfaceGetSeed(d.surface)
    if seed != lastSeeds[i] { lastSeeds[i] = seed; lastChange[i] = now }
  }
  // Follow the lit screen (a fold/unfold moves the picture to the other display): when the shown
  // display has been still for 2 s while another one just changed and is lit, switch to it.
  if !pinned, displays.count > 1, now.timeIntervalSince(lastChange[activeIndex]) > 2 {
    if let other = displays.indices.first(where: { $0 != activeIndex && now.timeIntervalSince(lastChange[$0]) < 0.5 && isLit(displays[$0].surface) }) {
      activeIndex = other
      announce()
    }
  }
  let active = displays[activeIndex]
  let seed = lastSeeds[activeIndex]
  if seed == sentSeed && sentIndex == activeIndex { return }
  sentSeed = seed
  sentIndex = activeIndex
  guard let (jpeg, w, h) = encode(active.surface) else { return }
  var frame = Data("NTF2".utf8)
  frame.append(le32(w)); frame.append(le32(h)); frame.append(le32(activeIndex)); frame.append(le32(jpeg.count)); frame.append(jpeg)
  out.write(frame)
}
timer.resume()

// ── HID ────────────────────────────────────────────────────────────────────────────────────────
guard let sk = dlopen(simulatorKitPath, RTLD_NOW) else { fail("framework", "SimulatorKit") }
typealias MouseFn = @convention(c) (UnsafeMutablePointer<CGPoint>?, UnsafeMutablePointer<CGPoint>?, UInt32, UInt, CGSize, UInt32) -> UnsafeMutableRawPointer
typealias KeyFn = @convention(c) (Int32, Int32) -> UnsafeMutableRawPointer
typealias ArbitraryFn = @convention(c) (Int32, UInt32, UInt32, Int32) -> UnsafeMutableRawPointer
guard let mouseSym = dlsym(sk, "IndigoHIDMessageForMouseNSEvent"),
      let keySym = dlsym(sk, "IndigoHIDMessageForKeyboardArbitrary"),
      let arbSym = dlsym(sk, "IndigoHIDMessageForHIDArbitrary") else { fail("framework", "Indigo message builders missing") }
let messageForMouse = unsafeBitCast(mouseSym, to: MouseFn.self)
let messageForKey = unsafeBitCast(keySym, to: KeyFn.self)
let messageForArbitrary = unsafeBitCast(arbSym, to: ArbitraryFn.self)

guard let hidClass = NSClassFromString("SimulatorKit.SimDeviceLegacyHIDClient") else { fail("framework", "SimDeviceLegacyHIDClient not found") }
typealias AllocFn = @convention(c) (AnyClass, Selector) -> AnyObject
typealias HIDInitFn = @convention(c) (AnyObject, Selector, AnyObject, UnsafeMutablePointer<NSError?>?) -> AnyObject?
let allocated = unsafeBitCast(msgSend, to: AllocFn.self)(hidClass, NSSelectorFromString("alloc"))
var hidErr: NSError?
guard let hid = unsafeBitCast(msgSend, to: HIDInitFn.self)(allocated, NSSelectorFromString("initWithDevice:error:"), device, &hidErr) else {
  fail("hid", "HID client: " + (hidErr?.localizedDescription ?? "nil"))
}
typealias SendFn = @convention(c) (AnyObject, Selector, UnsafeMutableRawPointer, Bool, DispatchQueue, @escaping @convention(block) (NSError?) -> Void) -> Void
let sendFn = unsafeBitCast(msgSend, to: SendFn.self)
let hidQueue = DispatchQueue(label: "nt.simbridge.hid")
status(["ok": "ready"])

@Sendable func send(_ message: UnsafeMutableRawPointer) {
  hidQueue.async {
    sendFn(hid, NSSelectorFromString("sendWithMessage:freeWhenDone:completionQueue:completion:"), message, true, hidQueue) { err in
      if let err { status(["error": "hid-send", "message": err.localizedDescription]) }
    }
  }
}

/// A single-finger touch at a ratio of the screen. SimulatorKit only builds multi-touch messages,
/// so the contact is sourced from one and re-enveloped as single-touch (idb's touchMessage).
@Sendable func touch(x: Double, y: Double, down: Bool, target: UInt32, edge: UInt32 = 0) {
  var point = CGPoint(x: x, y: y)
  let source = messageForMouse(&point, nil, target, down ? 1 : 2, CGSize(width: 1, height: 1), edge)
  source.advanced(by: 0x3c).storeBytes(of: x, as: Double.self)
  source.advanced(by: 0x44).storeBytes(of: y, as: Double.self)
  let size = 0x140, stride = 0x90
  guard let dest = calloc(1, size) else { free(source); return }
  dest.advanced(by: 0x18).storeBytes(of: UInt32(stride), as: UInt32.self)
  dest.advanced(by: 0x1c).storeBytes(of: UInt8(2), as: UInt8.self)
  dest.advanced(by: 0x20).storeBytes(of: UInt32(0xB), as: UInt32.self)
  dest.advanced(by: 0x24).storeBytes(of: mach_absolute_time(), as: UInt64.self)
  memcpy(dest.advanced(by: 0x30), source.advanced(by: 0x30), 0x70)
  free(source)
  memcpy(dest.advanced(by: 0x20 + stride), dest.advanced(by: 0x20), stride)
  dest.advanced(by: 0x20 + stride + 0x10).storeBytes(of: UInt32(1), as: UInt32.self)
  dest.advanced(by: 0x20 + stride + 0x14).storeBytes(of: UInt32(2), as: UInt32.self)
  send(dest)
}

/// Hardware buttons as HID Consumer-page usages to the digitizer service (0x32): the path that
/// reaches a Face ID device, which ignores the legacy home-button source.
let consumerUsage: [String: UInt32] = ["home": 0x40, "lock": 0x30, "side": 0x30, "siri": 0xCF, "volup": 0xE9, "voldown": 0xEA, "playpause": 0xCD]
/// The legacy ButtonEventSource for the two buttons that have one (target 0x33). Used when the
/// Consumer-usage path is refused: MEASURED on a foldable, where the digitizer-addressed home press
/// came back "Mach port invalid" while touches to the screen's own target worked.
let legacySource: [String: Int32] = ["home": 0, "lock": 1, "side": 0xBB8]
typealias ButtonFn = @convention(c) (Int32, Int32, Int32) -> UnsafeMutableRawPointer
let messageForButton: ButtonFn? = dlsym(sk, "IndigoHIDMessageForButton").map { unsafeBitCast($0, to: ButtonFn.self) }

@Sendable func sendChecked(_ message: UnsafeMutableRawPointer, _ done: @escaping @Sendable (Bool) -> Void) {
  hidQueue.async {
    sendFn(hid, NSSelectorFromString("sendWithMessage:freeWhenDone:completionQueue:completion:"), message, true, hidQueue) { err in done(err == nil) }
  }
}

@Sendable func button(_ name: String) {
  guard let usage = consumerUsage[name] else { return }
  sendChecked(messageForArbitrary(0x32, 0x0C, usage, 1)) { ok in
    if ok {
      hidQueue.asyncAfter(deadline: .now() + 0.08) { send(messageForArbitrary(0x32, 0x0C, usage, 2)) }
    } else if let source = legacySource[name], let legacy = messageForButton {
      send(legacy(source, 1, 0x33))
      hidQueue.asyncAfter(deadline: .now() + 0.08) { send(legacy(source, 2, 0x33)) }
    } else {
      status(["error": "button", "message": "the simulator refused the " + name + " button"])
    }
  }
}

// ── Gestures ───────────────────────────────────────────────────────────────────────────────────
/// The App Switcher on a Face ID device: a finger from the bottom edge, up past a third of the
/// screen, a pause, then lift. The contact carries the bottom-edge flag (IndigoHIDEdgeBottom = 3):
/// iOS recognises system edge gestures from that flag, not from where the finger started.
@Sendable func appSwitcher(target: UInt32) {
  let steps = 14
  touch(x: 0.5, y: 0.995, down: true, target: target, edge: 3)
  for i in 1...steps {
    let y = 0.995 - 0.4 * Double(i) / Double(steps)
    hidQueue.asyncAfter(deadline: .now() + 0.016 * Double(i)) { touch(x: 0.5, y: y, down: true, target: target, edge: 3) }
  }
  hidQueue.asyncAfter(deadline: .now() + 0.016 * Double(steps) + 0.6) { touch(x: 0.5, y: 0.595, down: false, target: target, edge: 3) }
}

// ── Orientation ────────────────────────────────────────────────────────────────────────────────
// A GSEvent "device orientation changed" (type 50) as a raw mach message to SpringBoard's
// PurpleWorkspacePort, looked up in the device's bootstrap namespace — the layout from idb's
// SimulatorPurpleHID. The framebuffer itself stays portrait; iOS draws rotated content into it.
typealias LookupFn = @convention(c) (AnyObject, Selector, NSString, UnsafeMutablePointer<NSError?>?) -> UInt32
let purpleQueue = DispatchQueue(label: "nt.simbridge.purple")
@Sendable func orientation(_ value: UInt32) {
  purpleQueue.async {
    var lookupErr: NSError?
    let port = unsafeBitCast(msgSend, to: LookupFn.self)(device, NSSelectorFromString("lookup:error:"), "PurpleWorkspacePort" as NSString, &lookupErr)
    guard port != 0 else {
      status(["error": "orientation", "message": "PurpleWorkspacePort unavailable: " + (lookupErr?.localizedDescription ?? "nil")])
      return
    }
    var buf = [UInt8](repeating: 0, count: 112)
    func put(_ v: UInt32, _ at: Int) { withUnsafeBytes(of: v.littleEndian) { for i in 0..<4 { buf[at + i] = $0[i] } } }
    put(0x13, 0x00)              // msgh_bits: MACH_MSG_TYPE_COPY_SEND
    put(108, 0x04)               // msgh_size
    put(port, 0x08)              // msgh_remote_port
    put(0x7B, 0x14)              // msgh_id
    put(50 | 0x2_0000, 0x18)     // GSEvent type: device orientation changed | host flag
    put(4, 0x48)                 // payload length
    put(value, 0x4C)             // the orientation
    let kr = buf.withUnsafeMutableBytes { raw -> kern_return_t in
      let header = raw.baseAddress!.assumingMemoryBound(to: mach_msg_header_t.self)
      return mach_msg(header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, header.pointee.msgh_size, 0, mach_port_t(MACH_PORT_NULL), 2000, mach_port_t(MACH_PORT_NULL))
    }
    if kr != KERN_SUCCESS { status(["error": "orientation", "message": "rotate failed: " + String(cString: mach_error_string(kr))]) }
  }
}

// ── Commands ───────────────────────────────────────────────────────────────────────────────────
DispatchQueue.global().async {
  while let line = readLine() {
    guard let d = line.data(using: .utf8), let cmd = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
          let t = cmd["t"] as? String else { continue }
    switch t {
    case "down", "move", "up":
      guard let x = cmd["x"] as? Double, let y = cmd["y"] as? Double, x.isFinite, y.isFinite else { continue }
      let target = frameQueue.sync { touchTarget(displays[activeIndex]) }
      // The panel edge the contact started on (1 top, 2 left, 3 bottom, 4 right): iOS recognises
      // its edge gestures — the home swipe up from the bottom — from this flag alone.
      let edge = UInt32(min(4, max(0, (cmd["edge"] as? Int) ?? 0)))
      touch(x: min(1, max(0, x)), y: min(1, max(0, y)), down: t != "up", target: target, edge: edge)
    case "key":
      guard let usage = cmd["usage"] as? Int, (0..<256).contains(usage), let down = cmd["down"] as? Bool else { continue }
      send(messageForKey(Int32(usage), down ? 1 : 2))
    case "button":
      button((cmd["name"] as? String) ?? "")
    case "gesture":
      if (cmd["name"] as? String) == "app-switcher" {
        let target = frameQueue.sync { touchTarget(displays[activeIndex]) }
        appSwitcher(target: target)
      }
    case "orientation":
      guard let v = cmd["value"] as? Int, (1...4).contains(v) else { continue }
      orientation(UInt32(v))
    case "display":
      guard let i = cmd["index"] as? Int else { continue }
      frameQueue.async {
        if i >= 0 && i < displays.count { activeIndex = i; pinned = true } else { pinned = false }
        sentIndex = -1
        announce()
      }
    default:
      break
    }
  }
  exit(0) // stdin closed: the node went away
}

dispatchMain()
`
