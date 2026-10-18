import AppKit
import CoreGraphics
import CoreImage
import CoreMedia
import Foundation
import ScreenCaptureKit
import VideoToolbox

@available(macOS 12.3, *)
final class Capture: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
  let queue = DispatchQueue(label: "reach.screen.frames")
  let context = CIContext(options: [.cacheIntermediates: false])
  var latest: CVPixelBuffer?
  var wanted = false, keyframe = false, encoding = false
  // Nothing new since the last frame: reply with one byte so the server sends
  // nothing, and the phone has nothing to decode or draw. A real frame still
  // goes out every second to keep the stream alive.
  var fresh = true, lastSent = Date.distantPast
  var lastKeyTime = Date.distantPast
  // macOS said there's nothing to show (a blank, suspended or stopped frame:
  // the display asleep, the Mac locked) until the next complete frame.
  var blank = false
  var stream: SCStream?, encoder: VTCompressionSession?
  var width = 0, height = 0, frame: Int64 = 0, codec = ""
  let video: Bool, strictHardware: Bool, fps: Int, maxWidth: Int, bitrate: Int,
    displayID: CGDirectDisplayID
  // Optional "x,y,w,h" in display points: only that part of the display (an
  // app's window on its hidden display), at full resolution, without a pointer.
  let region: CGRect?
  // Optional JSON {ids, names, words, titles} (server/agent-guard.mjs's lists):
  // a viewer who isn't the owner never sees these windows: password
  // managers, the Mac's security prompts, Reach's own windows.
  struct Privacy: Decodable { let ids: [String], names: [String], words: [String], titles: [String] }
  let privacy: Privacy?
  init(_ args: [String]) {
    strictHardware = args.count > 5 && args[5] == "hardware"
    displayID = args.count > 0 && args[0] != "primary" ? UInt32(args[0]) ?? 0 : CGMainDisplayID()
    video = args.count > 1 && args[1] == "h264"
    fps = args.count > 2 ? Int(args[2]) ?? 30 : 15
    maxWidth = args.count > 3 ? Int(args[3]) ?? 1600 : 1600
    bitrate = args.count > 4 ? Int(args[4]) ?? 6_000_000 : 6_000_000
    let parts = args.count > 6 ? args[6].split(separator: ",").compactMap { Double($0) } : []
    region =
      parts.count == 4 && parts[2] >= 16 && parts[3] >= 16
      ? CGRect(x: parts[0], y: parts[1], width: parts[2], height: parts[3]) : nil
    privacy =
      args.count > 7 && !args[7].isEmpty
      ? try? JSONDecoder().decode(Privacy.self, from: Data(args[7].utf8)) : nil
    // Asked to hide windows but unreadable: never show them unfiltered.
    if args.count > 7 && !args[7].isEmpty && privacy == nil {
      FileHandle.standardError.write(Data("Invalid privacy rules.\n".utf8))
      exit(1)
    }
  }
  // "reach" as a word: Reach.app, "Reach — node"; not Preacher.
  func mentions(_ value: String, _ words: [String]) -> Bool {
    let text = value.lowercased()
    for word in words where !word.isEmpty {
      var search = text.startIndex
      while let range = text.range(of: word, range: search..<text.endIndex) {
        let before = range.lowerBound == text.startIndex ? nil : text[text.index(before: range.lowerBound)]
        let after = range.upperBound == text.endIndex ? nil : text[range.upperBound]
        if !(before?.isLetter ?? false) && !(after?.isLetter ?? false) { return true }
        search = range.upperBound
      }
    }
    return false
  }
  // The windows left out for a viewer who isn't the owner (none otherwise),
  // as scripts/native/agent-desktop.swift leaves them out for agents.
  func hidden(_ content: SCShareableContent, _ display: SCDisplay) -> [SCWindow] {
    guard let p = privacy else { return [] }
    // The Dock's full-screen windows. The Dock itself is one, titled "Dock"
    // (layer 20, display-sized on macOS 26), and stays. Mission Control and
    // App Exposé add untitled ones that draw every window's preview: while
    // any is up, all of them are left out, so hidden stays hidden there
    // (measured Oct 11: Mission Control adds two, at layers 20 and 18).
    let dockLayer = { (window: SCWindow) -> Bool in
      (window.owningApplication?.bundleIdentifier ?? "").lowercased() == "com.apple.dock"
        && window.windowLayer > 0
        && window.frame.width >= display.frame.width * 0.9
        && window.frame.height >= display.frame.height * 0.9
    }
    let overview = content.windows.contains { dockLayer($0) && $0.title != "Dock" }
    return content.windows.filter { window in
      let app = window.owningApplication
      let id = (app?.bundleIdentifier ?? "").lowercased()
      let name = (app?.applicationName ?? "").lowercased()
      let title = (window.title ?? "").lowercased()
      if dockLayer(window) && (overview || window.title != "Dock") {
        return true
      }
      if p.ids.contains(where: { id == $0 || id.hasPrefix($0.hasSuffix(".") ? $0 : $0 + ".") }) {
        return true
      }
      return p.names.contains(name) || mentions("\(id) \(name) \(title)", p.words)
        || p.titles.contains(where: { !$0.isEmpty && title.contains($0) })
    }
  }
  func failure(_ text: String) -> Never {
    FileHandle.standardError.write(Data((text + "\n").utf8))
    finish(1)
  }
  // Every way out stops the capture first. Exiting with it running once left
  // macOS capturing for 14 hours with nobody reading (Oct 12): the Mac kept
  // its screen-sharing mark, even with Reach paused, and Netflix wouldn't play.
  func finish(_ code: Int32) -> Never {
    if let stream {
      let done = DispatchSemaphore(value: 0)
      stream.stopCapture { _ in done.signal() }
      _ = done.wait(timeout: .now() + 2)
    }
    exit(code)
  }
  func write(_ data: Data) {
    var size = UInt32(data.count).bigEndian
    FileHandle.standardOutput.write(Data(bytes: &size, count: 4))
    FileHandle.standardOutput.write(data)
  }
  // Says what stopped capture. Only a refused permission says "Allow Screen
  // Recording…": Reach stops retrying on that sentence. Sleep, lock and
  // display changes stop capture too, and the phone reconnects after them.
  // The server words the steps for the app Reach runs in (permissionHint in
  // server/screen-stream.mjs): the permission is that app's, not this helper's.
  func stopped(_ error: Error, _ what: String) -> Never {
    let e = error as NSError
    if (e.domain == SCStreamErrorDomain && e.code == SCStreamError.Code.userDeclined.rawValue)
      || !CGPreflightScreenCaptureAccess()
    {
      failure(
        "Screen Recording is off for the app running Reach. Allow it in System Settings, then quit and reopen it."
      )
    }
    // Named, so the phone says why while it reconnects.
    switch idleCode() {
    case 2: failure("The Mac is locked. The screen comes back when it's unlocked.")
    case 1: failure("The Mac is asleep. The screen comes back when it wakes.")
    default: break
    }
    if e.domain == "Display unavailable" {
      failure("This display is unavailable. Select an available display and reconnect.")
    }
    failure("\(what): \(e.localizedDescription) (\(e.domain) \(e.code)).")
  }
  // Why there's no picture to send: 2 the Mac is locked, 1 its display is
  // asleep or blank, nil when a picture is simply still on its way.
  func idleCode() -> UInt8? {
    if let session = CGSessionCopyCurrentDictionary() as? [String: Any],
      (session["CGSSessionScreenIsLocked"] as? NSNumber)?.boolValue == true
    {
      return 2
    }
    if blank || CGDisplayIsAsleep(displayID) != 0 { return 1 }
    return nil
  }
  func stream(_ stream: SCStream, didStopWithError error: Error) {
    stopped(error, "Screen capture stopped")
  }
  func compressed(_ sample: CMSampleBuffer) {
    let attachments =
      CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[String: Any]]
    let key = (attachments?.first?[kCMSampleAttachmentKey_NotSync as String] as? Bool) != true
    guard let format = sample.formatDescription, let block = sample.dataBuffer else {
      failure("Video encoding failed.")
    }
    var data = Data()
    var length: Int32 = 4
    if key {
      var count = 0
      var size = 0
      var pointer: UnsafePointer<UInt8>?
      guard
        CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
          format, parameterSetIndex: 0, parameterSetPointerOut: &pointer,
          parameterSetSizeOut: &size, parameterSetCountOut: &count, nalUnitHeaderLengthOut: &length)
          == noErr
      else { failure("Video format unavailable.") }
      for index in 0..<count {
        guard
          CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            format, parameterSetIndex: index, parameterSetPointerOut: &pointer,
            parameterSetSizeOut: &size, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil)
            == noErr, let p = pointer
        else { continue }
        if index == 0 && size >= 4 { codec = String(format: "avc1.%02X%02X%02X", p[1], p[2], p[3]) }
        data.append(contentsOf: [0, 0, 0, 1])
        data.append(p, count: size)
      }
    }
    let size = CMBlockBufferGetDataLength(block)
    var bytes = [UInt8](repeating: 0, count: size)
    guard
      CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: size, destination: &bytes) == noErr
    else { failure("Video packet unavailable.") }
    var offset = 0
    while offset + 4 <= size {
      let n =
        (Int(bytes[offset]) << 24) | (Int(bytes[offset + 1]) << 16) | (Int(bytes[offset + 2]) << 8)
        | Int(bytes[offset + 3])
      offset += 4
      guard n > 0 && offset + n <= size else { failure("Invalid video packet.") }
      data.append(contentsOf: [0, 0, 0, 1])
      data.append(contentsOf: bytes[offset..<offset + n])
      offset += n
    }
    let timestamp = Int(CMTimeGetSeconds(sample.presentationTimeStamp) * 1_000_000)
    let metadata: [String: Any] = [
      "key": key, "timestamp": timestamp, "width": width, "height": height, "codec": codec,
    ]
    guard let json = try? JSONSerialization.data(withJSONObject: metadata) else { return }
    var header = UInt32(json.count).bigEndian
    var packet = Data(bytes: &header, count: 4)
    packet.append(json)
    packet.append(data)
    write(packet)
    encoding = false
  }
  // The encoder dropped the frame it was given: answer the server's request
  // with "nothing changed" (one byte) and keep the picture marked fresh, so
  // the next request encodes it again.
  func dropped() {
    encoding = false
    fresh = true
    write(Data([0]))
  }
  // Every request gets exactly one answer, never silence: the server gives
  // up on a helper that doesn't answer in 15 s, and the phone shows "stalled".
  func emit() {
    guard wanted, !encoding else { return }
    guard let buffer = latest else {
      // Nothing to capture (asleep, locked): one byte says why, and the
      // phone keeps its last picture. No picture yet otherwise: wait for it.
      if let code = idleCode() {
        wanted = false
        write(Data([code]))
      }
      return
    }
    wanted = false
    if !fresh && !keyframe && Date().timeIntervalSince(lastSent) < 1 {
      write(Data([0]))
      return
    }
    let changed = fresh
    fresh = false
    lastSent = Date()
    if !video {
      guard let color = CGColorSpace(name: CGColorSpace.sRGB),
        let data = context.jpegRepresentation(
          of: CIImage(cvPixelBuffer: buffer), colorSpace: color,
          options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.8]
        )
      else {
        // This picture didn't convert: "nothing changed", and the next
        // request tries again.
        fresh = true
        write(Data([0]))
        return
      }
      write(data)
      return
    }
    guard let encoder = encoder else {
      fresh = true
      write(Data([0]))
      return
    }
    encoding = true
    frame += 1
    // A keyframe at a phone's full resolution weighs as much as seconds of
    // delta frames; one every 2 s was the live screen's biggest bandwidth
    // burst on a slow link. The phone asks for one whenever it needs one
    // (a new viewer, a restarted decoder: the "key" command), so the
    // periodic one is only a safety net.
    if changed && Date().timeIntervalSince(lastKeyTime) >= 10 { keyframe = true }
    if keyframe { lastKeyTime = Date() }
    let properties = keyframe ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil
    keyframe = false
    let status = VTCompressionSessionEncodeFrame(
      encoder, imageBuffer: buffer,
      presentationTimeStamp: CMClockGetTime(CMClockGetHostTimeClock()),
      duration: CMTime(value: 1, timescale: CMTimeScale(fps)), frameProperties: properties,
      sourceFrameRefcon: nil, infoFlagsOut: nil)
    if status != noErr { failure("Hardware video encoder failed. Use compatibility mode.") }
  }
  func stream(
    _ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType
  ) {
    guard type == .screen, sample.isValid,
      let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false)
        as? [[SCStreamFrameInfo: Any]], let raw = attachments.first?[.status] as? Int
    else { return }
    guard SCFrameStatus(rawValue: raw) == .complete else {
      if [.blank, .suspended, .stopped].contains(SCFrameStatus(rawValue: raw)) {
        latest = nil
        blank = true
        // A request already waiting is answered with why.
        emit()
      }
      return
    }
    latest = sample.imageBuffer
    blank = false
    fresh = true
    emit()
  }
  func configureEncoder() throws {
    let status = VTCompressionSessionCreate(
      allocator: nil, width: Int32(width), height: Int32(height), codecType: kCMVideoCodecType_H264,
      encoderSpecification: [
        kVTVideoEncoderSpecification_EnableLowLatencyRateControl: true,
        strictHardware
          ? kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder
          : kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: true,
      ] as CFDictionary, imageBufferAttributes: nil, compressedDataAllocator: nil,
      outputCallback: { ref, _, status, _, sample in
        guard let ref = ref else { return }
        let capture = Unmanaged<Capture>.fromOpaque(ref).takeUnretainedValue()
        // The VideoToolbox status (-12911 malfunction, -12915 busy, …) is the
        // one clue to why: it lands in Reach's log (server/screen-stream.mjs).
        guard status == noErr else {
          capture.failure("Video encoder failed (VideoToolbox \(status)).")
        }
        // No sample and no error: the encoder dropped this frame to hold its
        // bitrate (low-latency rate control), which it does just when the
        // server lowers the bitrate on a struggling link. Treated as fatal,
        // that ended the stream about once a second on a slow link (Oct 7).
        guard let sample = sample else {
          capture.queue.async { capture.dropped() }
          return
        }
        capture.queue.async { capture.compressed(sample) }
      }, refcon: Unmanaged.passUnretained(self).toOpaque(), compressionSessionOut: &encoder)
    guard status == noErr, let encoder = encoder else {
      throw NSError(domain: "Video encoder unavailable", code: 1)
    }
    let properties: [CFString: Any] = [
      kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality: true,
      kVTCompressionPropertyKey_RealTime: true, kVTCompressionPropertyKey_MaxFrameDelayCount: 0,
      kVTCompressionPropertyKey_AllowFrameReordering: false,
      kVTCompressionPropertyKey_ProfileLevel: kVTProfileLevel_H264_High_AutoLevel,
      kVTCompressionPropertyKey_AverageBitRate: bitrate,
      kVTCompressionPropertyKey_ExpectedFrameRate: fps,
      kVTCompressionPropertyKey_MaxKeyFrameInterval: fps * 10,
      kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration: 10,
      // Low-latency rate control turns long-term references on by default
      // (reads 1): frames after each keyframe then carry LTR marking and
      // reordering, meant for a sender that acknowledges the receiver's LTR
      // frames. Reach never does, and a phone decoder has failed on deltas,
      // so they're off. (macOS 12.0+, inside this macOS 12.3+ class.)
      kVTCompressionPropertyKey_EnableLTR: false,
    ]
    for (key, value) in properties {
      VTSessionSetProperty(encoder, key: key, value: value as CFTypeRef)
    }
    VTCompressionSessionPrepareToEncodeFrames(encoder)
  }
  func adjust(_ line: String) -> Bool {
    guard line.hasPrefix("bitrate ") else { return false }
    if let value = Int(line.dropFirst(8)), value >= 750000, value <= 24_000_000,
      let encoder = encoder
    {
      VTSessionSetProperty(
        encoder, key: kVTCompressionPropertyKey_AverageBitRate, value: NSNumber(value: value))
    }
    return true
  }
  func selfTest(_ testWidth: Int = 640, _ testHeight: Int = 360) throws {
    guard video && strictHardware else {
      failure("H.264 self-test configuration is invalid.")
    }
    width = testWidth
    height = testHeight
    try configureEncoder()
    var value: CVPixelBuffer?
    guard
      CVPixelBufferCreate(
        nil, width, height, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
        [kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary] as CFDictionary, &value)
        == kCVReturnSuccess, let buffer = value
    else { failure("Test buffer unavailable.") }
    latest = buffer
    CVPixelBufferLockBaseAddress(buffer, [])
    let pixels = CVPixelBufferGetBaseAddressOfPlane(buffer, 0)!.assumingMemoryBound(to: UInt8.self)
    let stride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0)
    for y in 0..<height {
      for x in 0..<width { pixels[y * stride + x] = UInt8(32 + (x / 20 + y / 10) % 160) }
    }
    memset(
      CVPixelBufferGetBaseAddressOfPlane(buffer, 1), 128,
      CVPixelBufferGetBytesPerRowOfPlane(buffer, 1) * CVPixelBufferGetHeightOfPlane(buffer, 1))
    CVPixelBufferUnlockBaseAddress(buffer, [])
    DispatchQueue.global().async {
      while let line = readLine() {
        self.queue.async {
          if self.adjust(line) { return }
          CVPixelBufferLockBaseAddress(buffer, [])
          let previous = Int(max(0, self.frame - 1) * 4) % self.width
          let current = Int(self.frame * 4) % self.width
          for y in 0..<self.height {
            for x in max(0, previous - 20)..<min(self.width, previous + 20) {
              pixels[y * stride + x] = UInt8(32 + (x / 20 + y / 10) % 160)
            }
            for x in max(0, current - 20)..<min(self.width, current + 20) {
              pixels[y * stride + x] = 220
            }
          }
          CVPixelBufferUnlockBaseAddress(buffer, [])
          self.wanted = true
          self.keyframe = line == "key"
          self.fresh = true
          self.emit()
        }
      }
      exit(0)
    }
  }
  func start() async throws {
    let content = try await SCShareableContent.excludingDesktopWindows(
      false, onScreenWindowsOnly: true)
    guard let display = content.displays.first(where: { $0.displayID == displayID }) else {
      throw NSError(domain: "Display unavailable", code: 1)
    }
    let mode = CGDisplayCopyDisplayMode(displayID)
    var pixelsWide = Double(mode?.pixelWidth ?? display.width)
    var pixelsHigh = Double(mode?.pixelHeight ?? display.height)
    let config = SCStreamConfiguration()
    if let region = region?.intersection(
      CGRect(x: 0, y: 0, width: display.width, height: display.height)), !region.isEmpty
    {
      let backing = pixelsWide / Double(display.width)
      config.sourceRect = region
      pixelsWide = region.width * backing
      pixelsHigh = region.height * backing
    }
    let scale = min(1.0, Double(maxWidth) / pixelsWide, 3840.0 / pixelsHigh)
    width = max(2, Int(pixelsWide * scale) / 2 * 2)
    height = max(2, Int(pixelsHigh * scale) / 2 * 2)
    config.width = width
    config.height = height
    config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
    config.queueDepth = 3
    config.showsCursor = region == nil
    config.pixelFormat =
      video ? kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange : kCVPixelFormatType_32BGRA
    if video { try configureEncoder() }
    let excluded = hidden(content, display)
    let capture = SCStream(
      filter: SCContentFilter(display: display, excludingWindows: excluded), configuration: config,
      delegate: self)
    stream = capture
    try capture.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
    try await capture.startCapture()
    // Windows open and close: the hidden ones are looked for again every
    // second, and the filter changes only when they did.
    if privacy != nil {
      let id = displayID
      Task {
        var last = Set(excluded.map { $0.windowID })
        while true {
          try? await Task.sleep(nanoseconds: 1_000_000_000)
          guard
            let content = try? await SCShareableContent.excludingDesktopWindows(
              false, onScreenWindowsOnly: true),
            let display = content.displays.first(where: { $0.displayID == id })
          else { continue }
          let hide = self.hidden(content, display)
          let ids = Set(hide.map { $0.windowID })
          if ids == last { continue }
          do {
            try await capture.updateContentFilter(
              SCContentFilter(display: display, excludingWindows: hide))
            last = ids
          } catch {
            // Can't hide what should be hidden: stop rather than show it.
            self.failure("Screen capture could not hide private windows.")
          }
        }
      }
    }
    DispatchQueue.global().async {
      while let line = readLine() {
        self.queue.async {
          if self.adjust(line) { return }
          self.wanted = true
          self.keyframe = line == "key"
          self.emit()
        }
      }
      self.finish(0)
    }
  }
}
@main struct ReachScreenStream {
  static func main() async {
    if CommandLine.arguments.contains("--list") {
      let screens = NSScreen.screens.map { screen -> [String: Any] in
        let id =
          (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?
          .uint32Value ?? 0
        let b = CGDisplayBounds(id)
        return [
          "id": String(id), "name": screen.localizedName, "primary": id == CGMainDisplayID(),
          "width": Int(b.width), "height": Int(b.height), "x": Int(b.minX), "y": Int(b.minY),
          "pixelWidth": CGDisplayCopyDisplayMode(id)?.pixelWidth ?? Int(b.width),
          "pixelHeight": CGDisplayCopyDisplayMode(id)?.pixelHeight ?? Int(b.height),
          "virtual": CGDisplayModelNumber(id) == 0x7669_7274,
        ]
      }
      if let data = try? JSONSerialization.data(withJSONObject: screens) {
        FileHandle.standardOutput.write(data)
      }
      return
    }
    guard #available(macOS 12.3, *) else {
      FileHandle.standardError.write(Data("macOS 12.3 or newer is required.\n".utf8))
      exit(1)
    }
    let test = CommandLine.arguments.contains("--self-test")
    let args = Array(CommandLine.arguments.dropFirst())
    let w = test && args.count > 1 ? Int(args[1]) ?? 640 : 640
    let h = test && args.count > 2 ? Int(args[2]) ?? 360 : 360
    guard w >= 2, h >= 2, w <= 3840, h <= 3840, w * h <= 9_000_000 else { exit(1) }
    // Swift 6.1.2 -O miscompiles a conditional array passed to this
    // initializer: --self-test silently selected JPEG instead of H.264.
    // Separate branches preserve the requested format on that compiler.
    let capture: Capture
    if test {
      let rate = args.count > 3 ? args[3] : "30"
      let testArgs = ["primary", "h264", rate, String(w), "16000000", "hardware"]
      capture = Capture(testArgs)
    } else {
      capture = Capture(args)
      guard capture.video == (args.count > 1 && args[1] == "h264"),
        capture.strictHardware == (args.count > 5 && args[5] == "hardware")
      else { capture.failure("Screen capture format could not be initialized.") }
    }
    // Stopped by Reach (SIGTERM), or Reach gone without closing the pipe
    // (adopted by launchd): the capture ends with this helper, never after.
    var endings: [DispatchSourceProtocol] = []
    for signo in [SIGTERM, SIGINT, SIGHUP] {
      signal(signo, SIG_IGN)
      let source = DispatchSource.makeSignalSource(signal: signo, queue: .global())
      source.setEventHandler { capture.finish(0) }
      source.resume()
      endings.append(source)
    }
    let orphan = DispatchSource.makeTimerSource(queue: .global())
    orphan.schedule(deadline: .now() + 2, repeating: 2)
    orphan.setEventHandler { if getppid() == 1 { capture.finish(0) } }
    orphan.resume()
    endings.append(orphan)
    do {
      if test { try capture.selfTest(w, h) } else { try await capture.start() }
      while true { try await Task.sleep(nanoseconds: 60_000_000_000) }
    } catch {
      capture.stopped(error, "Screen capture could not start")
    }
  }
}
