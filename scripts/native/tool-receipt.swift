import Foundation
import CoreGraphics
import CoreText

// Render an escaped, plain-text snapshot. No HTML, scripts, network or browser data files.
@main struct ReceiptSnapshot {
static func main() {
let input = FileHandle.standardInput.readDataToEndOfFile()
guard input.count <= 262144,
      let value = try? JSONSerialization.jsonObject(with: input) as? [String: String],
      let text = value["text"], let source = value["source"],
      let url = URL(string: source), url.scheme == "https" else { exit(2) }
let content = "Receipt snapshot\nSource: \(source)\n\n\(text)"
let font = CTFontCreateWithName("Helvetica" as CFString, 10, nil)
let string = NSAttributedString(string: content, attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font])
let framesetter = CTFramesetterCreateWithAttributedString(string)
let data = NSMutableData()
var box = CGRect(x: 0, y: 0, width: 612, height: 792)
guard let consumer = CGDataConsumer(data: data),
      let context = CGContext(consumer: consumer, mediaBox: &box, nil) else { exit(3) }
let area = CGRect(x: 36, y: 36, width: 540, height: 720)
var start = 0, pages = 0
while start < string.length && pages < 100 {
  context.beginPDFPage(nil)
  let frame = CTFramesetterCreateFrame(framesetter, CFRange(location: start, length: 0), CGPath(rect: area, transform: nil), nil)
  CTFrameDraw(frame, context)
  let range = CTFrameGetVisibleStringRange(frame)
  guard range.length > 0 else { exit(4) }
  start += range.length; pages += 1
  context.endPDFPage()
}
guard start == string.length else { exit(5) }
context.closePDF()
print((data as Data).base64EncodedString())
}
}
