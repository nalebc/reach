import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

// The Mac's sound for a phone that listens beside its live screen
// (server/screen-sound.mjs): what the Mac plays, never its microphone,
// through ScreenCaptureKit with the Screen Recording permission the picture
// already uses. Length-prefixed packets on stdout, as the screen helper's:
// "i" and JSON {rate, channels} whenever the format is new, then "p" and
// 16-bit little-endian samples, interleaved. Reach compresses them; this
// helper never opens a network port.
@available(macOS 13.0, *)
final class Sound: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
  let queue = DispatchQueue(label: "reach.sound.samples")
  var stream: SCStream?
  var rate = 0.0, channels = 0
  let debug = ProcessInfo.processInfo.environment["REACH_SOUND_DEBUG"] == "1"

  func failure(_ text: String) -> Never {
    FileHandle.standardError.write(Data((text + "\n").utf8))
    finish(1)
  }
  // Every way out stops the capture first, as the screen helper's does: a
  // capture left running keeps the Mac's recording mark on (Oct 12).
  func finish(_ code: Int32) -> Never {
    if let stream {
      let done = DispatchSemaphore(value: 0)
      stream.stopCapture { _ in done.signal() }
      _ = done.wait(timeout: .now() + 2)
    }
    exit(code)
  }
  func write(_ kind: UInt8, _ payload: Data) {
    var size = UInt32(payload.count + 1).bigEndian
    var packet = Data(bytes: &size, count: 4)
    packet.append(kind)
    packet.append(payload)
    FileHandle.standardOutput.write(packet)
  }
  func announce(_ rate: Double, _ channels: Int) {
    guard rate != self.rate || channels != self.channels else { return }
    self.rate = rate
    self.channels = channels
    let info: [String: Any] = ["rate": Int(rate), "channels": channels]
    if let json = try? JSONSerialization.data(withJSONObject: info) { write(UInt8(ascii: "i"), json) }
  }
  // Says why the capture stopped. Only a refused permission says "Screen
  // Recording": Reach stops retrying on it (server/screen-stream.mjs).
  func stopped(_ error: Error, _ what: String) -> Never {
    let e = error as NSError
    if (e.domain == SCStreamErrorDomain && e.code == SCStreamError.Code.userDeclined.rawValue)
      || !CGPreflightScreenCaptureAccess()
    {
      failure(
        "Screen Recording is off for the app running Reach. Allow it in System Settings, then quit and reopen it."
      )
    }
    if let session = CGSessionCopyCurrentDictionary() as? [String: Any],
      (session["CGSSessionScreenIsLocked"] as? NSNumber)?.boolValue == true
    {
      failure("The Mac is locked. Its sound comes back when it's unlocked.")
    }
    failure("\(what): \(e.localizedDescription) (\(e.domain) \(e.code)).")
  }
  func stream(_ stream: SCStream, didStopWithError error: Error) {
    stopped(error, "Sound capture stopped")
  }
  func stream(
    _ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType
  ) {
    // The picture this stream must have is two pixels a second: unused.
    guard type == .audio, sample.isValid, let format = sample.formatDescription,
      let description = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee
    else { return }
    // The layout is read from each buffer, never assumed: float or
    // integer, interleaved or one buffer per channel.
    let float = description.mFormatFlags & kAudioFormatFlagIsFloat != 0
    let planar = description.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
    let count = Int(description.mChannelsPerFrame)
    let bits = Int(description.mBitsPerChannel)
    guard description.mFormatID == kAudioFormatLinearPCM, count > 0, count <= 16,
      (float && bits == 32) || (!float && bits == 16)
    else { failure("The Mac's sound came in a format Reach can't read.") }
    if debug {
      FileHandle.standardError.write(
        Data(
          "rate \(description.mSampleRate) channels \(count) bits \(bits) float \(float) planar \(planar)\n"
            .utf8))
    }
    var needed = 0
    guard
      CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
        sample, bufferListSizeNeededOut: &needed, bufferListOut: nil, bufferListSize: 0,
        blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: nil)
        == noErr, needed > 0
    else { return }
    let raw = UnsafeMutableRawPointer.allocate(
      byteCount: needed, alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { raw.deallocate() }
    let list = raw.bindMemory(to: AudioBufferList.self, capacity: 1)
    var block: CMBlockBuffer?
    guard
      CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
        sample, bufferListSizeNeededOut: nil, bufferListOut: list, bufferListSize: needed,
        blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
        flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, blockBufferOut: &block)
        == noErr
    else { return }
    let buffers = UnsafeMutableAudioBufferListPointer(list)
    let frames = CMSampleBufferGetNumSamples(sample)
    guard frames > 0, buffers.count == (planar ? count : 1) else { return }
    // Two channels go out: a mono Mac in both, the first two of more.
    let out = min(count, 2) == 1 ? 1 : 2
    announce(description.mSampleRate, out)
    var samples = [Int16](repeating: 0, count: frames * out)
    let size = bits / 8
    for c in 0..<out {
      let buffer = buffers[planar ? c : 0]
      guard let data = buffer.mData else { return }
      let step = planar ? 1 : count
      let offset = planar ? 0 : c
      guard Int(buffer.mDataByteSize) >= ((frames - 1) * step + offset + 1) * size else { return }
      if float {
        let values = data.assumingMemoryBound(to: Float.self)
        for i in 0..<frames {
          let v = max(-1, min(1, values[i * step + offset]))
          samples[i * out + c] = Int16(v * 32767)
        }
      } else {
        let values = data.assumingMemoryBound(to: Int16.self)
        for i in 0..<frames { samples[i * out + c] = values[i * step + offset] }
      }
    }
    write(UInt8(ascii: "p"), samples.withUnsafeBytes { Data($0) })
  }
  func start() async throws {
    // Checked first, so nothing here ever asks macOS to prompt.
    guard CGPreflightScreenCaptureAccess() else {
      failure(
        "Screen Recording is off for the app running Reach. Allow it in System Settings, then quit and reopen it."
      )
    }
    let content = try await SCShareableContent.excludingDesktopWindows(
      false, onScreenWindowsOnly: true)
    guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() })
      ?? content.displays.first
    else { throw NSError(domain: "No display", code: 1) }
    let config = SCStreamConfiguration()
    config.capturesAudio = true
    config.sampleRate = 48000
    config.channelCount = 2
    config.excludesCurrentProcessAudio = true
    // A stream always has a picture; this one's is as small and rare as
    // ScreenCaptureKit allows, and nobody sees it.
    config.width = 2
    config.height = 2
    config.minimumFrameInterval = CMTime(value: 1, timescale: 2)
    config.queueDepth = 3
    config.showsCursor = false
    // Every app's sound: none left out.
    let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
    let capture = SCStream(filter: filter, configuration: config, delegate: self)
    stream = capture
    try capture.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
    try capture.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
    try await capture.startCapture()
  }
  // A tone through the same packets, without capturing anything: what the
  // tests run (no permission needed). 440 Hz left, 660 Hz right, 20 ms each.
  func selfTest(_ seconds: Double) {
    announce(48000, 2)
    let frames = 960
    var t = 0
    for _ in 0..<Int(seconds * 50) {
      var samples = [Int16](repeating: 0, count: frames * 2)
      for i in 0..<frames {
        let at = Double(t + i) / 48000
        samples[i * 2] = Int16(sin(2 * .pi * 440 * at) * 12000)
        samples[i * 2 + 1] = Int16(sin(2 * .pi * 660 * at) * 12000)
      }
      t += frames
      write(UInt8(ascii: "p"), samples.withUnsafeBytes { Data($0) })
    }
  }
}

@main struct ReachScreenSound {
  static func main() async {
    guard #available(macOS 13.0, *) else {
      FileHandle.standardError.write(Data("Hearing the Mac needs macOS 13 or newer.\n".utf8))
      exit(1)
    }
    let sound = Sound()
    let args = Array(CommandLine.arguments.dropFirst())
    if args.first == "--self-test" {
      let seconds = args.count > 1 ? min(10, max(0.02, Double(args[1]) ?? 1)) : 1
      sound.selfTest(seconds)
      exit(0)
    }
    // Stopped by Reach (SIGTERM, or its pipe closed), or Reach gone without
    // a word (adopted by launchd): the capture ends with this helper.
    var endings: [DispatchSourceProtocol] = []
    for signo in [SIGTERM, SIGINT, SIGHUP] {
      signal(signo, SIG_IGN)
      let source = DispatchSource.makeSignalSource(signal: signo, queue: .global())
      source.setEventHandler { sound.finish(0) }
      source.resume()
      endings.append(source)
    }
    let orphan = DispatchSource.makeTimerSource(queue: .global())
    orphan.schedule(deadline: .now() + 2, repeating: 2)
    orphan.setEventHandler { if getppid() == 1 { sound.finish(0) } }
    orphan.resume()
    endings.append(orphan)
    DispatchQueue.global().async {
      while readLine() != nil {}
      sound.finish(0)
    }
    do {
      try await sound.start()
      while true { try await Task.sleep(nanoseconds: 60_000_000_000) }
    } catch {
      sound.stopped(error, "Sound capture could not start")
    }
  }
}
