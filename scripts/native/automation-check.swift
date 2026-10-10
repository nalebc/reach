// Whether Reach, through the Terminal it runs in, may send Apple Events to a
// browser (macOS Automation), for agents' saved tools (server/tool-setup.mjs).
// "check" only asks macOS; "ask" also shows macOS's own prompt on the Mac
// when it hasn't asked yet, and the owner answers there. Nothing is sent to
// the browser itself.
import CoreServices
import Foundation

@main
struct AutomationCheck {
  static func main() {
    let args = CommandLine.arguments
    guard args.count == 3, ["check", "ask"].contains(args[2]),
      args[1].range(of: "^[A-Za-z0-9.-]{1,200}$", options: .regularExpression) != nil
    else {
      print("{\"status\":null}")
      exit(2)
    }
    var target = AEAddressDesc()
    let bundle = Array(args[1].utf8)
    let created = bundle.withUnsafeBufferPointer {
      AECreateDesc(DescType(typeApplicationBundleID), $0.baseAddress, $0.count, &target)
    }
    guard created == noErr else {
      print("{\"status\":null}")
      exit(1)
    }
    defer { AEDisposeDesc(&target) }
    // 0 allowed, -1743 turned off, -1744 not asked yet, -600 not running.
    let status = AEDeterminePermissionToAutomateTarget(
      &target, AEEventClass(typeWildCard), AEEventID(typeWildCard), args[2] == "ask")
    print("{\"status\":\(status)}")
  }
}
