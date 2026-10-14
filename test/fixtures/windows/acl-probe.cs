// Who may open a file, a folder or a named pipe, as Windows itself keeps it,
// for real-Windows tests only (test/agent-remote.test.mjs).
//
//   acl-probe.exe file <path>     a file's or a folder's
//   acl-probe.exe pipe <name>     a pipe's (\\.\pipe\<name>, opened as a client)
//
// Prints one line of JSON: {"me":"<SID>","owner":"<SID>","protected":bool,
// "rules":[{"sid":"<SID>","allow":bool,"rights":<mask>,"inherited":bool,
// "inheritOnly":bool}]} (an inherit-only rule is for what's made inside).
// Failures print "error <message>" and exit 3. C# 5; mscorlib, System,
// System.Core.
using System;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

static class AclProbe {
  static string Quote(string text) {
    return "\"" + text.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
  }

  static int Main(string[] args) {
    try {
      if (args.Length != 2) return 2;
      NativeObjectSecurity security;
      if (args[0] == "file")
        security = Directory.Exists(args[1]) ? (NativeObjectSecurity)Directory.GetAccessControl(args[1]) : File.GetAccessControl(args[1]);
      else if (args[0] == "pipe") {
        using (var pipe = new NamedPipeClientStream(".", args[1], PipeDirection.InOut)) {
          pipe.Connect(5000);
          security = pipe.GetAccessControl();
        }
      } else return 2;
      var text = new StringBuilder();
      text.Append("{\"me\":").Append(Quote(WindowsIdentity.GetCurrent().User.Value));
      text.Append(",\"owner\":").Append(Quote(security.GetOwner(typeof(SecurityIdentifier)).Value));
      text.Append(",\"protected\":").Append(security.AreAccessRulesProtected ? "true" : "false");
      text.Append(",\"rules\":[");
      bool first = true;
      foreach (AccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier))) {
        int rights = rule is FileSystemAccessRule ? (int)((FileSystemAccessRule)rule).FileSystemRights
          : rule is PipeAccessRule ? (int)((PipeAccessRule)rule).PipeAccessRights : -1;
        if (!first) text.Append(",");
        first = false;
        text.Append("{\"sid\":").Append(Quote(rule.IdentityReference.Value));
        text.Append(",\"allow\":").Append(rule.AccessControlType == AccessControlType.Allow ? "true" : "false");
        text.Append(",\"rights\":").Append(rights);
        text.Append(",\"inherited\":").Append(rule.IsInherited ? "true" : "false");
        text.Append(",\"inheritOnly\":").Append((rule.PropagationFlags & PropagationFlags.InheritOnly) != 0 ? "true" : "false").Append("}");
      }
      Console.WriteLine(text.Append("]}").ToString());
      return 0;
    } catch (Exception error) {
      Console.WriteLine("error " + error.Message);
      return 3;
    }
  }
}
