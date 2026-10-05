import Foundation
import AppKit
import ApplicationServices

func stop(_ message: String) -> Never { FileHandle.standardError.write(Data(message.utf8)); exit(1) }
guard AXIsProcessTrusted() else { stop("Allow Accessibility access for the Reach input helper or the terminal running Reach in System Settings.") }
let data = FileHandle.standardInput.readDataToEndOfFile()
guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let type = object["type"] as? String else { stop("Invalid input") }
let source = CGEventSource(stateID: .hidSystemState)
if type == "click", let x = object["x"] as? Double, let y = object["y"] as? Double {
    let bounds = CGDisplayBounds(CGMainDisplayID())
    let point = CGPoint(x: bounds.minX + x * max(0, bounds.width - 1), y: bounds.minY + y * max(0, bounds.height - 1))
    let right = object["button"] as? String == "right"
    let button: CGMouseButton = right ? .right : .left
    let count = object["count"] as? Int ?? 1
    for click in 1...count {
        for down in [true, false] {
            let kind: CGEventType = right ? (down ? .rightMouseDown : .rightMouseUp) : (down ? .leftMouseDown : .leftMouseUp)
            let event = CGEvent(mouseEventSource: source, mouseType: kind, mouseCursorPosition: point, mouseButton: button)
            event?.setIntegerValueField(.mouseEventClickState, value: Int64(click))
            event?.post(tap: .cghidEventTap)
        }
    }
} else if type == "scroll", let delta = object["delta"] as? Int32 {
    CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 1, wheel1: delta, wheel2: 0, wheel3: 0)?.post(tap: .cghidEventTap)
} else if type == "text", let text = object["text"] as? String {
    // Send complete Unicode scalars so surrogate pairs never split across events.
    for scalar in text.unicodeScalars {
        let units = Array(String(scalar).utf16)
        for down in [true, false] {
            if let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down) {
                event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
                event.post(tap: .cghidEventTap)
            }
        }
    }
} else if type == "key", let key = object["key"] as? String {
    let keys: [String: CGKeyCode] = ["enter":36,"backspace":51,"tab":48,"escape":53,"left":123,"right":124,"down":125,"up":126]
    guard let code = keys[key] else { stop("Unsupported key") }
    CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)?.post(tap: .cghidEventTap)
    CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)?.post(tap: .cghidEventTap)
} else { stop("Unsupported input") }
