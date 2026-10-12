// Used only by test/windows-native-build.test.mjs: proves Reach can build a
// Windows helper with the PC's own csc.exe (server/desktop-native.mjs
// windowsBinary) and that every assembly the helpers use resolves. C# 5, the
// language of the .NET Framework 4.x compiler. One JSON line, then exit 0.
using System;

static class Hello {
  static int Main() {
    Type[] used = {
      typeof(System.Windows.Automation.AutomationElement), // UIAutomationClient
      typeof(System.Windows.Automation.ControlType),       // UIAutomationTypes
      typeof(System.Drawing.Rectangle),                    // System.Drawing
      typeof(System.Windows.Forms.Screen),                 // System.Windows.Forms
      typeof(System.Windows.Point),                        // WindowsBase
      typeof(System.Linq.Enumerable),                      // System.Core
      typeof(System.Diagnostics.Process),                  // System
    };
    Console.Out.Write("{\"ok\":true,\"hello\":\"reach\",\"types\":" + used.Length + "}\n");
    Console.Out.Flush();
    return 0;
  }
}
