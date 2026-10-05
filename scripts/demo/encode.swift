// macOS-only optional MP4 export. Input: render.py --frames directory.
import AVFoundation
import CoreGraphics
import ImageIO

struct Frame: Decodable { let file: String; let milliseconds: Int }
let directory = URL(fileURLWithPath: CommandLine.arguments[1])
let output = URL(fileURLWithPath: CommandLine.arguments[2])
let timeline = try JSONDecoder().decode([Frame].self, from: Data(contentsOf: directory.appendingPathComponent("timeline.json")))
let writer = try AVAssetWriter(outputURL: output, fileType: .mp4)
let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
    AVVideoCodecKey: AVVideoCodecType.h264,
    AVVideoWidthKey: 1120, AVVideoHeightKey: 800,
    AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 2_000_000],
])
input.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB,
    kCVPixelBufferWidthKey as String: 1120,
    kCVPixelBufferHeightKey as String: 800,
    kCVPixelBufferCGImageCompatibilityKey as String: true,
    kCVPixelBufferCGBitmapContextCompatibilityKey as String: true,
])
writer.add(input)
writer.shouldOptimizeForNetworkUse = true
guard writer.startWriting() else { fatalError("Could not start video writer: \(String(describing: writer.error))") }
writer.startSession(atSourceTime: .zero)
var index: Int64 = 0
for frame in timeline {
    let source = CGImageSourceCreateWithURL(directory.appendingPathComponent(frame.file) as CFURL,nil)!
    let image = CGImageSourceCreateImageAtIndex(source,0,nil)!
    var buffer: CVPixelBuffer?
    CVPixelBufferPoolCreatePixelBuffer(nil,adaptor.pixelBufferPool!,&buffer)
    let pixel = buffer!
    CVPixelBufferLockBaseAddress(pixel,[])
    let context = CGContext(data: CVPixelBufferGetBaseAddress(pixel),width:1120,height:800,bitsPerComponent:8,bytesPerRow:CVPixelBufferGetBytesPerRow(pixel),space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.noneSkipFirst.rawValue)!
    context.draw(image,in:CGRect(x:0,y:0,width:1120,height:800))
    CVPixelBufferUnlockBaseAddress(pixel,[])
    for _ in 0..<max(1,Int((Double(frame.milliseconds)*30/1000).rounded())) {
        while !input.isReadyForMoreMediaData {
            if writer.status == .failed { fatalError("Video writer failed: \(String(describing: writer.error))") }
            Thread.sleep(forTimeInterval:0.002)
        }
        guard adaptor.append(pixel,withPresentationTime:CMTime(value:index,timescale:30)) else { fatalError("Could not append video frame") }
        index += 1
    }
}
input.markAsFinished()
let done = DispatchSemaphore(value:0)
writer.finishWriting { done.signal() }
done.wait()
guard writer.status == .completed else { fatalError("Video export failed: \(String(describing: writer.error))") }
print("MP4 exported: \(Double(index)/30) seconds")
