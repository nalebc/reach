import AVFoundation
import UIKit

/// The layer decodes H.264 through VideoToolbox. No JPEG or JS bridge per frame.
final class DesktopVideo: UIView {
  override class var layerClass: AnyClass { AVSampleBufferDisplayLayer.self }
  var displayLayer: AVSampleBufferDisplayLayer { layer as! AVSampleBufferDisplayLayer }
  private let queue = DispatchQueue(label: "reach.desktop.decode", qos: .userInteractive)
  private var format: CMVideoFormatDescription?
  private var waitingForKey = true
  var dimensions = CGSize(width: 16, height: 9)
  override init(frame: CGRect) {
    super.init(frame: frame)
    displayLayer.videoGravity = .resizeAspect
    backgroundColor = .black
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  func reset() {
    queue.async {
      self.displayLayer.flushAndRemoveImage()
      self.format = nil
      self.waitingForKey = true
    }
  }
  /// Returns sequence and whether a new IDR is needed. One submission at a time.
  func submit(_ packet: Data, done: @escaping (UInt32, Bool) -> Void) {
    queue.async {
      guard packet.count >= 9, packet.count <= 8 * 1024 * 1024 else { return done(0, true) }
      func u32(_ at: Int) -> UInt32 { packet[at..<at + 4].reduce(0) { ($0 << 8) | UInt32($1) } }
      let seq = u32(0)
      let length = Int(u32(4))
      guard length > 0, length <= 4096, 8 + length < packet.count,
        let meta = (try? JSONSerialization.jsonObject(with: packet.subdata(in: 8..<8 + length)))
          as? [String: Any],
        let key = meta["key"] as? Bool
      else { return done(seq, true) }
      if self.displayLayer.status == .failed {
        self.displayLayer.flush()
        self.waitingForKey = true
      }
      if self.waitingForKey && !key { return done(seq, true) }
      let bytes = [UInt8](packet[(8 + length)...])
      var starts: [Int] = []
      var i = 0
      while i + 4 <= bytes.count {
        if bytes[i] == 0 && bytes[i + 1] == 0 && bytes[i + 2] == 0 && bytes[i + 3] == 1 {
          starts.append(i)
          i += 4
        } else {
          i += 1
        }
      }
      guard !starts.isEmpty, starts.count < 256 else { return done(seq, true) }
      var nals: [Data] = []
      for (index, start) in starts.enumerated() {
        let end = index + 1 < starts.count ? starts[index + 1] : bytes.count
        if end > start + 4 { nals.append(Data(bytes[start + 4..<end])) }
      }
      if key {
        guard let sps = nals.first(where: { $0.first! & 31 == 7 }),
          let pps = nals.first(where: { $0.first! & 31 == 8 })
        else { return done(seq, true) }
        var next: CMFormatDescription?
        let status = sps.withUnsafeBytes { sp in
          pps.withUnsafeBytes { pp in
            let pointers = [
              sp.baseAddress!.assumingMemoryBound(to: UInt8.self),
              pp.baseAddress!.assumingMemoryBound(to: UInt8.self),
            ]
            let sizes = [sps.count, pps.count]
            return CMVideoFormatDescriptionCreateFromH264ParameterSets(
              allocator: kCFAllocatorDefault, parameterSetCount: 2, parameterSetPointers: pointers,
              parameterSetSizes: sizes, nalUnitHeaderLength: 4, formatDescriptionOut: &next)
          }
        }
        guard status == noErr, let next else { return done(seq, true) }
        let dimensions = CMVideoFormatDescriptionGetDimensions(next)
        guard dimensions.width > 0, dimensions.height > 0, dimensions.width <= 3840,
          dimensions.height <= 3840
        else { return done(seq, true) }
        if let old = self.format, !CMFormatDescriptionEqual(old, otherFormatDescription: next) {
          self.displayLayer.flush()
        }
        self.format = next
        self.waitingForKey = false
        DispatchQueue.main.async {
          self.dimensions = CGSize(width: Int(dimensions.width), height: Int(dimensions.height))
        }
      }
      guard let format = self.format else { return done(seq, true) }
      guard self.displayLayer.isReadyForMoreMediaData else {
        self.displayLayer.flush()
        self.waitingForKey = true
        return done(seq, true)
      }
      var avcc = Data()
      for nal in nals where ![7, 8, 9].contains(nal.first! & 31) {
        var count = UInt32(nal.count).bigEndian
        avcc.append(Data(bytes: &count, count: 4))
        avcc.append(nal)
      }
      guard !avcc.isEmpty else { return done(seq, false) }
      var block: CMBlockBuffer?
      guard
        CMBlockBufferCreateWithMemoryBlock(
          allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: avcc.count,
          blockAllocator: kCFAllocatorDefault, customBlockSource: nil, offsetToData: 0,
          dataLength: avcc.count, flags: 0, blockBufferOut: &block) == noErr, let block
      else { return done(seq, true) }
      let copied = avcc.withUnsafeBytes {
        CMBlockBufferReplaceDataBytes(
          with: $0.baseAddress!, blockBuffer: block, offsetIntoDestination: 0,
          dataLength: avcc.count)
      }
      var timing = CMSampleTimingInfo(
        duration: .invalid,
        presentationTimeStamp: CMTime(
          value: (meta["timestamp"] as? NSNumber)?.int64Value ?? 0, timescale: 1_000_000),
        decodeTimeStamp: .invalid)
      var size = avcc.count
      var sample: CMSampleBuffer?
      guard copied == noErr,
        CMSampleBufferCreateReady(
          allocator: kCFAllocatorDefault, dataBuffer: block, formatDescription: format,
          sampleCount: 1, sampleTimingEntryCount: 1, sampleTimingArray: &timing,
          sampleSizeEntryCount: 1, sampleSizeArray: &size, sampleBufferOut: &sample) == noErr,
        let sample
      else { return done(seq, true) }
      if let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: true)
      {
        let entry = unsafeBitCast(
          CFArrayGetValueAtIndex(attachments, 0), to: CFMutableDictionary.self)
        CFDictionarySetValue(
          entry, Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
          Unmanaged.passUnretained(kCFBooleanTrue).toOpaque())
      }
      self.displayLayer.enqueue(sample)
      done(seq, false)
    }
  }
  var videoRect: CGRect { AVMakeRect(aspectRatio: dimensions, insideRect: bounds) }
}
