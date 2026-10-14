// This Windows PC's screen and input for an agent preset (server/agent-desktop.mjs),
// as scripts/native/agent-desktop.swift is a Mac's: the same JSON lines, ops,
// fields, refusal kinds and words (docs/parity/B-desktop-helper.md). One
// process per agent session, fed JSON lines: first the rules, then one request
// at a time (a screenshot, one input action, an app to open, what is in front,
// the app catalog). Every action is checked against exactly what it would
// reach, the window under the pointer or the focused element, right before it
// is sent, in this process. The rules are data from the server
// (server/agent-guard.mjs): the protected apps, Reach's own names and
// addresses, the preset's app set, the owner's hidden apps.
//
// Started by Reach with --reach-pid <Reach's process> --reach-console 0|1.
// stdin: UTF-8 JSON lines (each at most 256 KiB). stdout: exactly one JSON
// line per request, {"ok":true,…} or {"error":…,"kind":…,"candidates":[…]}.
// Nothing is ever written anywhere else: no log, no stderr, no file. On the end
// of its input, or when Reach's process ends, it lets go of any button or key
// it holds and exits.
//
// C# 5 for the .NET Framework 4.8 compiler every Windows 10 and 11 has
// (csc.exe), built on the PC by server/desktop-native.mjs windowsBinary with
// agent-desktop.manifest (per-monitor DPI aware, never elevated). No
// PowerShell, no NuGet packages.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

class Refusal : Exception {
  public readonly string Kind;
  public readonly List<object> Candidates;
  public Refusal(string message, string kind) : base(message) { Kind = kind; Candidates = new List<object>(); }
  public Refusal(string message, string kind, List<object> candidates) : base(message) { Kind = kind; Candidates = candidates ?? new List<object>(); }
}
// A refusal after which this helper ends (a thread that hung): the next
// request starts a fresh one.
sealed class Wedged : Refusal {
  public Wedged(string message, string kind) : base(message, kind) { }
}

// BEGIN JSON
// Strict RFC 8259, as the server writes it: objects (a key at most once),
// arrays, strings, numbers (doubles; an integer is one that is whole, as
// Swift's exact Int), true, false and null, nested at most 32 deep. Written
// back with every control character, U+2028/U+2029 and lone surrogate escaped.
static class Json {
  public static object Parse(string text) {
    int at = 0;
    object value = Value(text, ref at, 0);
    Space(text, ref at);
    if (at != text.Length) throw new FormatException("trailing text");
    return value;
  }
  static void Space(string s, ref int at) {
    while (at < s.Length && (s[at] == ' ' || s[at] == '\t' || s[at] == '\n' || s[at] == '\r')) at++;
  }
  static object Value(string s, ref int at, int depth) {
    Space(s, ref at);
    if (at >= s.Length) throw new FormatException("no value");
    char c = s[at];
    if (c == '{') return Object(s, ref at, depth + 1);
    if (c == '[') return Array(s, ref at, depth + 1);
    if (c == '"') return Text(s, ref at);
    if (c == 't') { Word(s, ref at, "true"); return true; }
    if (c == 'f') { Word(s, ref at, "false"); return false; }
    if (c == 'n') { Word(s, ref at, "null"); return null; }
    return Number(s, ref at);
  }
  static void Word(string s, ref int at, string word) {
    if (string.CompareOrdinal(s, at, word, 0, word.Length) != 0) throw new FormatException("bad literal");
    at += word.Length;
  }
  static Dictionary<string, object> Object(string s, ref int at, int depth) {
    if (depth > 32) throw new FormatException("too deep");
    var result = new Dictionary<string, object>(StringComparer.Ordinal);
    at++;
    Space(s, ref at);
    if (at < s.Length && s[at] == '}') { at++; return result; }
    while (true) {
      Space(s, ref at);
      if (at >= s.Length || s[at] != '"') throw new FormatException("key");
      string key = Text(s, ref at);
      Space(s, ref at);
      if (at >= s.Length || s[at] != ':') throw new FormatException("colon");
      at++;
      if (result.ContainsKey(key)) throw new FormatException("duplicate key");
      result[key] = Value(s, ref at, depth);
      Space(s, ref at);
      if (at < s.Length && s[at] == ',') { at++; continue; }
      if (at < s.Length && s[at] == '}') { at++; return result; }
      throw new FormatException("object");
    }
  }
  static List<object> Array(string s, ref int at, int depth) {
    if (depth > 32) throw new FormatException("too deep");
    var result = new List<object>();
    at++;
    Space(s, ref at);
    if (at < s.Length && s[at] == ']') { at++; return result; }
    while (true) {
      result.Add(Value(s, ref at, depth));
      Space(s, ref at);
      if (at < s.Length && s[at] == ',') { at++; continue; }
      if (at < s.Length && s[at] == ']') { at++; return result; }
      throw new FormatException("array");
    }
  }
  static int Hex(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
  }
  static char Unit(string s, ref int at) {
    if (at + 4 > s.Length) throw new FormatException("escape");
    int value = 0;
    for (int i = 0; i < 4; i++) {
      int digit = Hex(s[at + i]);
      if (digit < 0) throw new FormatException("escape");
      value = value * 16 + digit;
    }
    at += 4;
    return (char)value;
  }
  static string Text(string s, ref int at) {
    var b = new StringBuilder();
    at++;
    while (true) {
      if (at >= s.Length) throw new FormatException("string");
      char c = s[at++];
      if (c == '"') return b.ToString();
      if (c < 0x20) throw new FormatException("control character");
      if (char.IsHighSurrogate(c)) {
        if (at >= s.Length || !char.IsLowSurrogate(s[at])) throw new FormatException("surrogate");
        b.Append(c).Append(s[at++]);
        continue;
      }
      if (char.IsLowSurrogate(c)) throw new FormatException("surrogate");
      if (c != '\\') { b.Append(c); continue; }
      if (at >= s.Length) throw new FormatException("escape");
      char e = s[at++];
      switch (e) {
        case '"': b.Append('"'); break;
        case '\\': b.Append('\\'); break;
        case '/': b.Append('/'); break;
        case 'b': b.Append('\b'); break;
        case 'f': b.Append('\f'); break;
        case 'n': b.Append('\n'); break;
        case 'r': b.Append('\r'); break;
        case 't': b.Append('\t'); break;
        case 'u': {
          char unit = Unit(s, ref at);
          if (char.IsHighSurrogate(unit)) {
            if (at + 6 > s.Length || s[at] != '\\' || s[at + 1] != 'u') throw new FormatException("surrogate");
            at += 2;
            char low = Unit(s, ref at);
            if (!char.IsLowSurrogate(low)) throw new FormatException("surrogate");
            b.Append(unit).Append(low);
          } else if (char.IsLowSurrogate(unit)) throw new FormatException("surrogate");
          else b.Append(unit);
          break;
        }
        default: throw new FormatException("escape");
      }
    }
  }
  static double Number(string s, ref int at) {
    int start = at;
    if (at < s.Length && s[at] == '-') at++;
    if (at >= s.Length) throw new FormatException("number");
    if (s[at] == '0') at++;
    else if (s[at] >= '1' && s[at] <= '9') { while (at < s.Length && s[at] >= '0' && s[at] <= '9') at++; }
    else throw new FormatException("number");
    if (at < s.Length && s[at] == '.') {
      at++;
      int digits = at;
      while (at < s.Length && s[at] >= '0' && s[at] <= '9') at++;
      if (at == digits) throw new FormatException("number");
    }
    if (at < s.Length && (s[at] == 'e' || s[at] == 'E')) {
      at++;
      if (at < s.Length && (s[at] == '+' || s[at] == '-')) at++;
      int digits = at;
      while (at < s.Length && s[at] >= '0' && s[at] <= '9') at++;
      if (at == digits) throw new FormatException("number");
    }
    double value;
    // Out of a double's range: the .NET Framework throws where newer .NETs give infinity.
    try { value = double.Parse(s.Substring(start, at - start), NumberStyles.Float, CultureInfo.InvariantCulture); }
    catch (OverflowException) { throw new FormatException("number"); }
    if (double.IsInfinity(value) || double.IsNaN(value)) throw new FormatException("number");
    return value;
  }

  public static string Write(object value) {
    var b = new StringBuilder();
    Write(b, value);
    return b.ToString();
  }
  static void Write(StringBuilder b, object value) {
    if (value == null) { b.Append("null"); return; }
    var text = value as string;
    if (text != null) { Quote(b, text); return; }
    if (value is bool) { b.Append((bool)value ? "true" : "false"); return; }
    if (value is int || value is long || value is uint || value is ulong || value is short || value is ushort || value is byte) {
      b.Append(Convert.ToString(value, CultureInfo.InvariantCulture));
      return;
    }
    if (value is double || value is float) {
      double d = Convert.ToDouble(value, CultureInfo.InvariantCulture);
      if (double.IsNaN(d) || double.IsInfinity(d)) b.Append("null");
      else if (Math.Floor(d) == d && Math.Abs(d) < 1e15) b.Append(((long)d).ToString(CultureInfo.InvariantCulture));
      else b.Append(d.ToString("R", CultureInfo.InvariantCulture));
      return;
    }
    var map = value as IDictionary<string, object>;
    if (map != null) {
      b.Append('{');
      bool first = true;
      foreach (var pair in map) {
        if (!first) b.Append(',');
        first = false;
        Quote(b, pair.Key);
        b.Append(':');
        Write(b, pair.Value);
      }
      b.Append('}');
      return;
    }
    var list = value as System.Collections.IEnumerable;
    if (list != null) {
      b.Append('[');
      bool first = true;
      foreach (object item in list) {
        if (!first) b.Append(',');
        first = false;
        Write(b, item);
      }
      b.Append(']');
      return;
    }
    Quote(b, Convert.ToString(value, CultureInfo.InvariantCulture));
  }
  static void Quote(StringBuilder b, string s) {
    b.Append('"');
    for (int i = 0; i < s.Length; i++) {
      char c = s[i];
      if (c == '"') b.Append("\\\"");
      else if (c == '\\') b.Append("\\\\");
      else if (c < 0x20 || c == (char)0x2028 || c == (char)0x2029) b.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
      else if (char.IsHighSurrogate(c) && i + 1 < s.Length && char.IsLowSurrogate(s[i + 1])) { b.Append(c).Append(s[i + 1]); i++; }
      else if (char.IsSurrogate(c)) b.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
      else b.Append(c);
    }
    b.Append('"');
  }

  // Swift's exact casts on what JSONSerialization read: `as? String`,
  // `as? Bool`, `as? Int` (a whole number only) and `as? Double`.
  public static object Get(Dictionary<string, object> map, string key) {
    object value;
    return map != null && map.TryGetValue(key, out value) ? value : null;
  }
  public static string Str(Dictionary<string, object> map, string key) { return Get(map, key) as string; }
  public static bool True(Dictionary<string, object> map, string key) { object value = Get(map, key); return value is bool && (bool)value; }
  public static bool IsInt(object value) {
    return value is double && Math.Floor((double)value) == (double)value && (double)value >= int.MinValue && (double)value <= int.MaxValue;
  }
  public static int? Int(Dictionary<string, object> map, string key) {
    object value = Get(map, key);
    if (!IsInt(value)) return null;
    return (int)(double)value;
  }
  public static double? Double(Dictionary<string, object> map, string key) {
    object value = Get(map, key);
    if (value is double) return (double)value;
    return null;
  }
  public static Dictionary<string, object> Map(Dictionary<string, object> map, string key) { return Get(map, key) as Dictionary<string, object>; }
  // [String]: every element a string, or nothing at all.
  public static List<string> Strings(Dictionary<string, object> map, string key) {
    var list = Get(map, key) as List<object>;
    var result = new List<string>();
    if (list == null) return result;
    foreach (object item in list) {
      var text = item as string;
      if (text == null) return new List<string>();
      result.Add(text);
    }
    return result;
  }
  // [[String: Any]], keeping each entry's string values.
  public static List<Dictionary<string, string>> Entries(Dictionary<string, object> map, string key) {
    var list = Get(map, key) as List<object>;
    var result = new List<Dictionary<string, string>>();
    if (list == null) return result;
    foreach (object item in list) {
      var entry = item as Dictionary<string, object>;
      if (entry == null) return new List<Dictionary<string, string>>();
      var strings = new Dictionary<string, string>(StringComparer.Ordinal);
      foreach (var pair in entry) { var text = pair.Value as string; if (text != null) strings[pair.Key] = text; }
      result.Add(strings);
    }
    return result;
  }
}
// END JSON

// BEGIN PURE URL
// Addresses as Swift's URLComponents(string:) reads them: RFC 3986 and
// nothing looser (a character outside it, a bad %XX or a bracket outside an
// IPv6 host, and it's no address). IP addresses as BSD's inet_pton reads
// them: four decimal octets without leading zeros; IPv6 with at most one
// "::", an optional IPv4 tail and no zone. System.Uri is never used here: it
// rewrites paths and reads 127.1 as an address.
sealed class UrlParts {
  public string Scheme;    // null when there is none
  public string Host;      // percent-decoded, IPv6 without brackets; null without an authority
  public string Port;      // null when there is none
  public string Path = ""; // as written
  public string Query;     // null when there is none
  public string Fragment;  // null when there is none
}
static class Url {
  const string Unreserved = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
  const string SubDelims = "!$&'()*+,;=";
  static int Hex(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
  }
  static int IndexOfAny(string value, string set, int start) {
    for (int i = start; i < value.Length; i++) if (set.IndexOf(value[i]) >= 0) return i;
    return -1;
  }
  // Every character unreserved, a sub-delimiter, one of `extra`, or %XX.
  static bool Component(string value, string extra) {
    for (int i = 0; i < value.Length; i++) {
      char c = value[i];
      if (c == '%') {
        if (i + 2 >= value.Length || Hex(value[i + 1]) < 0 || Hex(value[i + 2]) < 0) return false;
        i += 2;
        continue;
      }
      if (c > 0x7e || (Unreserved.IndexOf(c) < 0 && SubDelims.IndexOf(c) < 0 && extra.IndexOf(c) < 0)) return false;
    }
    return true;
  }
  static string Decode(string value) {
    var bytes = new List<byte>();
    for (int i = 0; i < value.Length; i++) {
      if (value[i] == '%' && i + 2 < value.Length) { bytes.Add((byte)(Hex(value[i + 1]) * 16 + Hex(value[i + 2]))); i += 2; }
      else bytes.Add((byte)value[i]);
    }
    try { return new UTF8Encoding(false, true).GetString(bytes.ToArray()); } catch (ArgumentException) { return value; }
  }
  static bool SchemeValid(string scheme) {
    if (scheme.Length == 0 || !((scheme[0] >= 'a' && scheme[0] <= 'z') || (scheme[0] >= 'A' && scheme[0] <= 'Z'))) return false;
    foreach (char c in scheme)
      if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '+' || c == '-' || c == '.')) return false;
    return true;
  }
  // RFC 3986 Appendix B splits it; each part must then be valid as written.
  public static UrlParts Parse(string value) {
    if (value == null) return null;
    var parts = new UrlParts();
    int at = 0;
    int stop = IndexOfAny(value, ":/?#", 0);
    if (stop > 0 && value[stop] == ':') { parts.Scheme = value.Substring(0, stop); at = stop + 1; }
    string authority = null;
    if (at + 1 < value.Length && value[at] == '/' && value[at + 1] == '/') {
      int end = IndexOfAny(value, "/?#", at + 2);
      if (end < 0) end = value.Length;
      authority = value.Substring(at + 2, end - at - 2);
      at = end;
    }
    int pathEnd = IndexOfAny(value, "?#", at);
    if (pathEnd < 0) pathEnd = value.Length;
    parts.Path = value.Substring(at, pathEnd - at);
    at = pathEnd;
    if (at < value.Length && value[at] == '?') {
      int end = value.IndexOf('#', at);
      if (end < 0) end = value.Length;
      parts.Query = value.Substring(at + 1, end - at - 1);
      at = end;
    }
    if (at < value.Length && value[at] == '#') parts.Fragment = value.Substring(at + 1);
    if (parts.Scheme != null && !SchemeValid(parts.Scheme)) return null;
    if (authority != null && !Authority(authority, parts)) return null;
    if (!Component(parts.Path, ":@/")) return null;
    if (parts.Query != null && !Component(parts.Query, ":@/?")) return null;
    if (parts.Fragment != null && !Component(parts.Fragment, ":@/?")) return null;
    return parts;
  }
  static bool Authority(string authority, UrlParts parts) {
    int sign = authority.IndexOf('@');
    if (sign >= 0 && !Component(authority.Substring(0, sign), ":")) return false;
    string hostPort = sign >= 0 ? authority.Substring(sign + 1) : authority;
    string port = null;
    if (hostPort.Length > 0 && hostPort[0] == '[') {
      int close = hostPort.IndexOf(']');
      if (close < 0) return false;
      string inner = hostPort.Substring(1, close - 1);
      if (!IPv6(inner)) return false;
      string rest = hostPort.Substring(close + 1);
      if (rest.Length > 0) { if (rest[0] != ':') return false; port = rest.Substring(1); }
      parts.Host = inner;
    } else {
      int colon = hostPort.IndexOf(':');
      string host = colon >= 0 ? hostPort.Substring(0, colon) : hostPort;
      if (colon >= 0) port = hostPort.Substring(colon + 1);
      if (!Component(host, "")) return false;
      parts.Host = Decode(host);
    }
    if (port != null) {
      foreach (char c in port) if (c < '0' || c > '9') return false;
      parts.Port = port;
    }
    return true;
  }
  // BSD's inet_pton(AF_INET).
  public static bool IPv4(string value) {
    int octets = 0, current = 0;
    bool sawDigit = false;
    foreach (char c in value) {
      if (c >= '0' && c <= '9') {
        if (sawDigit && current == 0) return false;
        int next = current * 10 + (c - '0');
        if (next > 255) return false;
        current = next;
        if (!sawDigit) { if (++octets > 4) return false; sawDigit = true; }
      } else if (c == '.' && sawDigit) {
        if (octets == 4) return false;
        current = 0;
        sawDigit = false;
      } else return false;
    }
    return octets == 4;
  }
  // BSD's inet_pton(AF_INET6): 16 bytes exactly.
  public static bool IPv6(string value) {
    int at = 0;
    if (value.Length > 0 && value[0] == ':') {
      if (value.Length < 2 || value[1] != ':') return false;
      at = 1;
    }
    int bytes = 0, doubleColon = -1, digits = 0, token = at;
    while (at < value.Length) {
      char c = value[at++];
      if (Hex(c) >= 0) {
        if (++digits > 4) return false;
        continue;
      }
      if (c == ':') {
        token = at;
        if (digits == 0) {
          if (doubleColon >= 0) return false;
          doubleColon = bytes;
          continue;
        }
        if (at >= value.Length) return false;
        if (bytes + 2 > 16) return false;
        bytes += 2;
        digits = 0;
        continue;
      }
      if (c == '.' && bytes + 4 <= 16 && IPv4(value.Substring(token))) {
        bytes += 4;
        digits = 0;
        at = value.Length;
        break;
      }
      return false;
    }
    if (digits > 0) {
      if (bytes + 2 > 16) return false;
      bytes += 2;
    }
    if (doubleColon >= 0) {
      if (bytes == 16) return false;
      bytes = 16;
    }
    return bytes == 16;
  }
}
// END PURE URL

// BEGIN PURE DESKTOP POLICY — compiled directly by policy tests without Windows UI.
// A line-for-line port of agent-desktop.swift's, deciding the same shared
// corpus (test/helpers/desktop-policy-corpus.mjs). Every comparison is
// ordinal: the .NET Framework's defaults follow the PC's language.
sealed class Rules {
  public string Mode = "view";                    // "full", "apps" (allowedApps only) or "view" (screenshots only)
  public List<string> Hosts = new List<string>();  // Reach's addresses, lowercased
  public List<string> Titles = new List<string> { "reach" };  // words marking Reach's own windows
  public List<Dictionary<string, string>> AllowedApps = new List<Dictionary<string, string>>();  // Apps preset: {id, bundleId}
  public List<Dictionary<string, string>> HiddenApps = new List<Dictionary<string, string>>();   // the owner's extra hidden apps: {id, bundleId, name}
  public List<string> ProtectedAppIds = new List<string>();
  public List<string> ProtectedAppNames = new List<string>();
  public List<string> ReachWords = new List<string> { "reach", "tailscale", "tailnet" };
  public List<string> PrivatePanes = new List<string>();
  public List<string> ProtectedTitleWords = new List<string>();
  public List<string> ProtectedPagePatterns = new List<string>();
  public List<string> TerminalLike = new List<string>();
  public List<Regex> Patterns = new List<Regex>();
  public List<string> MoneySites = new List<string>();                                   // bank sites (server/money-sites.mjs)
  public Dictionary<string, Regex> Money = new Dictionary<string, Regex>(StringComparer.Ordinal);  // their words, by kind (MoneyPatterns)
  public HashSet<string> MoneyReadWords = new HashSet<string>(StringComparer.Ordinal);   // the words a bank page's buttons may say
  // Windows' own, as data (the Mac's helper keeps these in its code).
  public List<string> ProgramExtensions = new List<string>();
  public List<string> RunnerApps = new List<string>();
  public List<string> ProtectedPublishers = new List<string>();
  public List<string> ProtectedPaths = new List<string>();  // folders no file is opened from, as given
  public string Home = "";
  public Rules Copy() { return (Rules)MemberwiseClone(); }

  // The rules from the server, as agent-desktop.swift reads them: lists
  // lowercased, an unknown mode as "view", the patterns compiled once.
  public static Rules From(Dictionary<string, object> request) {
    var r = new Rules();
    Func<string, List<string>> strings = key => Json.Strings(request, key).ConvertAll(Policy.Lower);
    string mode = Json.Str(request, "mode") ?? "";
    r.Mode = mode == "full" || mode == "apps" || mode == "view" ? mode : "view";
    r.Hosts = strings("hosts");
    r.Titles = strings("titles").Count == 0 ? new List<string> { "reach" } : strings("titles");
    r.AllowedApps = Json.Entries(request, "allowedApps");
    // An installed program is allowed by its exact path: the bundle Windows
    // reports for it (exe:<name>) would match any program of that name.
    foreach (var app in r.AllowedApps) {
      string bundle;
      if (app.TryGetValue("bundleId", out bundle) && bundle.StartsWith("exe:", StringComparison.OrdinalIgnoreCase)) app["bundleId"] = "";
    }
    r.HiddenApps = Json.Entries(request, "hiddenApps");
    r.ProtectedAppIds = strings("protectedAppIds");
    r.ProtectedAppNames = strings("protectedAppNames");
    if (strings("reachWords").Count > 0) r.ReachWords = strings("reachWords");
    r.PrivatePanes = strings("privatePanes");
    r.ProtectedTitleWords = strings("protectedTitleWords");
    r.ProtectedPagePatterns = Json.Strings(request, "protectedPagePatterns");
    r.TerminalLike = strings("terminalLike");
    r.Patterns = Policy.Compile(r.ProtectedPagePatterns);
    r.MoneySites = strings("moneySites");
    r.MoneyReadWords = new HashSet<string>(strings("moneyReadWords"), StringComparer.Ordinal);
    var sources = new Dictionary<string, string>(StringComparer.Ordinal);
    foreach (string key in Policy.MoneyKinds.Keys) { string source = Json.Str(request, key); if (source != null) sources[key] = source; }
    r.Money = Policy.MoneyPatterns(sources);
    r.ProgramExtensions = strings("programExtensions");
    r.RunnerApps = strings("runnerApps");
    r.ProtectedPublishers = strings("protectedPublishers");
    r.ProtectedPaths = Json.Strings(request, "protectedPaths");
    r.Home = Json.Str(request, "home") ?? "";
    return r;
  }
}
static class Policy {
  public const string ReachReason = "That's Reach. The agent can't use Reach.";
  public const string ProtectedReason = "That holds passwords or controls who may use this Windows PC. It stays closed to the agent.";
  public const string HiddenReason = "The owner hid this app from the agent.";
  public const string NotAllowedReason = "That's not one of the apps this agent may use.";
  public const string SecureReason = "That's a password field. Use the Password box so the password stays hidden.";
  static readonly TimeSpan Budget = TimeSpan.FromMilliseconds(100);

  // NFKC, then lowercase as Swift and JavaScript do: İ is i and a combining
  // dot, a capital sigma ending a word is ς, every other character by its
  // own lowercase. A broken surrogate is read as U+FFFD.
  public static string Lower(string value) {
    if (string.IsNullOrEmpty(value)) return "";
    var whole = new StringBuilder(value.Length);
    for (int i = 0; i < value.Length; i++) {
      char c = value[i];
      if (char.IsHighSurrogate(c) && i + 1 < value.Length && char.IsLowSurrogate(value[i + 1])) { whole.Append(c).Append(value[++i]); continue; }
      whole.Append(char.IsSurrogate(c) ? (char)0xFFFD : c);
    }
    string text;
    try { text = whole.ToString().Normalize(NormalizationForm.FormKC); } catch (ArgumentException) { text = whole.ToString(); }
    var lower = new StringBuilder(text.Length);
    for (int i = 0; i < text.Length; i++) {
      char c = text[i];
      if (c == (char)0x130) { lower.Append('i').Append((char)0x307); continue; }
      if (c == (char)0x3A3) { lower.Append(FinalSigma(text, i) ? (char)0x3C2 : (char)0x3C3); continue; }
      if (char.IsHighSurrogate(c) && i + 1 < text.Length) {
        lower.Append(CultureInfo.InvariantCulture.TextInfo.ToLower(text.Substring(i, 2)));
        i++;
        continue;
      }
      lower.Append(char.ToLowerInvariant(c));
    }
    return lower.ToString();
  }
  static bool FinalSigma(string text, int at) {
    return at > 0 && char.IsLetter(text[at - 1]) && (at + 1 >= text.Length || !char.IsLetter(text[at + 1]));
  }
  static bool LetterAt(string text, int at) {
    if (at < 0 || at >= text.Length) return false;
    if (char.IsLowSurrogate(text[at]) && at > 0 && char.IsHighSurrogate(text[at - 1])) return char.IsLetter(text, at - 1);
    return char.IsLetter(text, at);
  }
  static string Value(Dictionary<string, string> entry, string key) {
    string value;
    return entry != null && entry.TryGetValue(key, out value) && value != null ? value : "";
  }
  static bool Has(List<string> list, string value) {
    foreach (string item in list) if (item == value) return true;
    return false;
  }
  static string Squeeze(string text) {
    var words = new List<string>();
    var word = new StringBuilder();
    foreach (char c in text) {
      if (char.IsWhiteSpace(c)) { if (word.Length > 0) { words.Add(word.ToString()); word.Length = 0; } }
      else word.Append(c);
    }
    if (word.Length > 0) words.Add(word.ToString());
    return string.Join(" ", words);
  }
  // A pattern match within its time budget. Running out counts as a match
  // where a match refuses, and as none where a match allows.
  public static bool Matches(Regex pattern, string text, bool refusing) {
    try { return pattern.IsMatch(text); } catch (RegexMatchTimeoutException) { return refusing; }
  }
  static Regex Pattern(string source, RegexOptions options) {
    try { return new Regex(source, options | RegexOptions.CultureInvariant, Budget); } catch (ArgumentException) { return null; }
  }

  // "reach" as a word: Reach.app, com.reach.app, "Reach — node"; not Preacher.
  public static bool MentionsReach(string value, Rules rules) {
    string text = Lower(value);
    foreach (string word in rules.ReachWords) {
      if (word.Length == 0) continue;
      int search = 0;
      while (search <= text.Length) {
        int at = text.IndexOf(word, search, StringComparison.Ordinal);
        if (at < 0) break;
        if (!LetterAt(text, at - 1) && !LetterAt(text, at + word.Length)) return true;
        search = at + word.Length;
      }
    }
    return false;
  }
  public static bool MatchesApp(string bundleId, string path, Dictionary<string, string> entry) {
    string id = Lower(bundleId), wanted = Lower(Value(entry, "bundleId"));
    if (wanted.Length > 0 && id.Length > 0 && id == wanted) return true;
    string want = Lower(Value(entry, "id"));
    return want.Length > 0 && path.Length > 0 && Lower(path) == want;
  }
  // The last name of a path (a Mac's / or Windows' \), without .app, or .exe
  // in any case: Windows names programs whatever their letters' case.
  public static string FileName(string path) {
    string[] names = (path ?? "").Split(new[] { '/', '\\' }, StringSplitOptions.RemoveEmptyEntries);
    string last = names.Length > 0 ? names[names.Length - 1] : "";
    if (last.EndsWith(".app", StringComparison.Ordinal)) last = last.Substring(0, last.Length - 4);
    else if (last.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) last = last.Substring(0, last.Length - 4);
    return Lower(last);
  }
  // A Store app's package name, from its id (an AUMID: name_publisher!app),
  // lowercased; "" for anything else (every Mac bundle id).
  static readonly Regex Aumid = new Regex("^([a-z0-9.-]{3,50})_[0-9a-hjkmnp-tv-z]{13}![a-z][a-z0-9]*(?:\\.[a-z][a-z0-9]*)*$", RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
  public static string PackageName(string id) {
    try {
      var match = Aumid.Match(Lower(id));
      return match.Success ? match.Groups[1].Value : "";
    } catch (RegexMatchTimeoutException) {
      return "";
    }
  }
  static bool IdMatches(string id, string entry) {
    return id == entry || id.StartsWith(entry.EndsWith(".", StringComparison.Ordinal) ? entry : entry + ".", StringComparison.Ordinal);
  }
  // Reach, Tailscale, the password stores, the security prompts, the tools that
  // stop Reach: never, whatever the preset. On Windows a Store app is also
  // matched by its package (all of a package's apps), and a program by its
  // signer when the rules name publishers.
  public static string ProtectedApp(string bundleId, string name, string path, Rules rules, string publisher = "") {
    string id = Lower(bundleId), lname = Lower(name), file = FileName(path);
    if (MentionsReach(id + " " + lname + " " + file, rules)) return ReachReason;
    string package = PackageName(id);
    if (package.Length == 0) package = PackageName(path);
    foreach (string entry in rules.ProtectedAppIds) {
      if (IdMatches(id, entry)) return ProtectedReason;
      if (entry.Length > 0 && id.StartsWith(entry + "!", StringComparison.Ordinal)) return ProtectedReason;
      if (package.Length > 0 && IdMatches(package, entry)) return ProtectedReason;
    }
    if (Has(rules.ProtectedAppNames, lname) || Has(rules.ProtectedAppNames, file)) return ProtectedReason;
    if (package.Length > 0 && Has(rules.ProtectedAppNames, package)) return ProtectedReason;
    if (!string.IsNullOrEmpty(publisher) && Has(rules.ProtectedPublishers, Lower(publisher))) return ProtectedReason;
    return null;
  }
  // The Mac's System Settings; Windows' Settings app (by its Store id, or its
  // program when Windows won't say), and Control Panel inside File Explorer.
  public static bool SettingsApp(string bundleId) {
    string id = Lower(bundleId);
    return id == "com.apple.systempreferences" || id == "com.apple.settings" ||
      id == "windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel" || id == "exe:systemsettings.exe" || id == "windows.controlpanel";
  }
  // Which apps the agent may touch at all: the preset's set in Apps mode, every
  // app but the protected and hidden ones in Full mode, none in view mode.
  public static string AppReason(string bundleId, string name, string path, Rules rules, string publisher = "") {
    if (rules.Mode == "full") return null;
    string reason = ProtectedApp(bundleId, name, path, rules, publisher);
    if (reason != null) return reason;
    foreach (var app in rules.HiddenApps)
      if (MatchesApp(bundleId, path, app) || (Value(app, "name").Length > 0 && Lower(Value(app, "name")) == Lower(name))) return HiddenReason;
    if (rules.Mode == "apps") {
      foreach (var app in rules.AllowedApps) if (MatchesApp(bundleId, path, app)) return null;
      return NotAllowedReason;
    }
    return null;
  }
  // Reach's own windows (by title), Settings' private pages, and the windows
  // that show saved passwords or run code. verifiedMail: never on Windows
  // (no verified Mail identity), so a Mail subject is judged as any title.
  static readonly Regex Credential = new Regex("\\b(passwords?|passphrase|unlock|locked|security|access|authentication|permissions?|credentials?|authori[sz]e|sign[ -]?in|log[ -]?in)\\b",
    RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
  public static string TitleReason(string title, string bundleId, Rules rules, bool verifiedMail = false) {
    if (rules.Mode == "full") return null;
    string value = Lower(title);
    bool mailContent = verifiedMail && bundleId == "com.apple.mail";
    if (value.Length == 0) return null;
    if (!mailContent && rules.Titles.Exists(word => word.Length > 0 && value.Contains(word)) && MentionsReach(value, rules)) return ReachReason;
    if (SettingsApp(bundleId) && rules.PrivatePanes.Exists(pane => pane.Length > 0 && value.Contains(pane))) return ProtectedReason;
    foreach (string word in rules.ProtectedTitleWords) {
      if (word.Length == 0) continue;
      if (word == "keychain" && mailContent && value.Contains(word)) {
        // Keep credential dialogs conservative, including singular "password".
        if (value.Trim() == word || Matches(Credential, value, true)) return ProtectedReason;
        continue;
      }
      if (word == "passwords") {
        if (value == word || value.StartsWith(word + " ", StringComparison.Ordinal) || value.EndsWith(" " + word, StringComparison.Ordinal) || value.Contains("saved passwords")) return ProtectedReason;
      } else if (value.Contains(word)) return ProtectedReason;
    }
    return null;
  }
  // Match the server's narrow HTTP(S) exception. Ambiguous input keeps the
  // original conservative check; no host alias canonicalization happens here.
  static readonly Regex Unsafe = new Regex("[\\s\\\\\"'`<>\\x00-\\x1f\\x7f-\\x9f\\u200e\\u200f\\u2028-\\u202e\\u2066-\\u2069]", RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
  static readonly Regex BadEscape = new Regex("%(?![a-f0-9]{2})", RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
  static readonly Regex AuthorityCharacters = new Regex("^[a-z0-9.!$&'()*+,;=_~:@\\[\\]-]+$", RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
  static readonly Regex HostAndPort = new Regex("^(?:[^@]*@)?(\\[[a-f0-9:.]+\\]|[a-z0-9._-]+)(?::([0-9]{1,5}))?$", RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
  static readonly Regex Dns = new Regex("^(?:[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?\\.)*[a-z_](?:[a-z0-9_-]*[a-z0-9_])?\\.?$", RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
  public static string ReachHostSubject(string value) {
    try {
      if (Unsafe.IsMatch(value) || BadEscape.IsMatch(value)) return value;
      int start = value.StartsWith("http://", StringComparison.Ordinal) ? 7 : value.StartsWith("https://", StringComparison.Ordinal) ? 8 : -1;
      if (start < 0) return value;
      int end = start;
      while (end < value.Length && value[end] != '/' && value[end] != '?' && value[end] != '#') end++;
      string authority = value.Substring(start, end - start);
      if (authority.Length == 0 || !AuthorityCharacters.IsMatch(authority)) return value;
      var parts = HostAndPort.Match(authority);
      if (!parts.Success) return value;
      int port;
      if (parts.Groups[2].Success && (!int.TryParse(parts.Groups[2].Value, NumberStyles.None, CultureInfo.InvariantCulture, out port) || port > 65535)) return value;
      string rawHost = parts.Groups[1].Value;
      bool bracketed = rawHost.StartsWith("[", StringComparison.Ordinal);
      string host = bracketed ? rawHost.Substring(1, rawHost.Length - 2) : rawHost;
      bool validIP = bracketed ? Url.IPv6(host) : Url.IPv4(host);
      if (!validIP && (bracketed || !Dns.IsMatch(host))) return value;
      var parsed = Url.Parse(value);
      if (parsed == null || (parsed.Scheme != "http" && parsed.Scheme != "https") || string.IsNullOrEmpty(parsed.Host)) return value;
      return authority;
    } catch (RegexMatchTimeoutException) {
      return value;
    }
  }
  // A page address: Reach's own, or one that reveals saved passwords or runs code.
  public static string UrlReason(string url, Rules rules) {
    if (rules.Mode == "full") return null;
    string value = Lower(url).Trim();
    if (value.Length == 0) return null;
    string subject = ReachHostSubject(value);
    if (rules.Hosts.Exists(host => host.Length > 0 && subject.Contains(host))) return ReachReason;
    foreach (Regex pattern in rules.Patterns) if (Matches(pattern, value, true)) return ProtectedReason;
    return null;
  }
  // A terminal or an IDE: typed text there is a command. Short names count
  // only as whole words ("Zed", not "Authorized"; "wt", not "Newtonsoft"), as
  // the server's own check (agent-guard.mjs terminalLikeApp) reads them.
  static readonly HashSet<string> ShortTerminalWords = new HashSet<string>(StringComparer.Ordinal) { "rio", "nova", "zed", "kitty", "hyper", "cmd", "wt", "wsl", "bash" };
  public static bool TerminalLikeApp(string bundleId, string name, string path, Rules rules) {
    string all = Lower(bundleId) + " " + Lower(name) + " " + Lower(path);
    var tokens = new HashSet<string>(StringComparer.Ordinal);
    var token = new StringBuilder();
    foreach (char c in all) {
      if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) token.Append(c);
      else if (token.Length > 0) { tokens.Add(token.ToString()); token.Length = 0; }
    }
    if (token.Length > 0) tokens.Add(token.ToString());
    foreach (string word in rules.TerminalLike) {
      if (word.Length == 0) continue;
      if (ShortTerminalWords.Contains(word) ? tokens.Contains(word) : all.Contains(word)) return true;
    }
    return false;
  }
  // Files that run when opened (open_file never opens them for narrower
  // presets), by their last extension: the server's list for Windows
  // (programExtensions), and these the helper adds: scripts and installers,
  // disk images (they mount without the mark of the web), Office add-ins and
  // macro documents, certificates.
  static readonly string[] WindowsPrograms = { "exe", "com", "bat", "cmd", "ps1", "psm1", "psd1", "ps1xml", "psc1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "wsc",
    "sct", "hta", "msi", "msp", "mst", "scr", "pif", "lnk", "url", "website", "reg", "inf", "cpl", "msc", "jar", "jnlp", "appref-ms", "application", "appx", "msix",
    "appxbundle", "msixbundle", "appinstaller", "library-ms", "search-ms", "searchconnector-ms", "settingcontent-ms", "diagcab", "chm", "ws", "scf", "xbap", "py", "pyw",
    "sh", "rdp", "theme", "themepack", "deskthemepack", "iso", "img", "vhd", "vhdx", "xll", "xla", "xlam", "ppam", "docm", "xlsm", "accde", "mdb", "adp", "cer", "crt",
    "p7b", "pfx" };
  public static string Extension(string path) {
    string[] names = (path ?? "").Split('/', '\\');
    string last = names[names.Length - 1];
    int dot = last.LastIndexOf('.');
    return dot >= 0 ? Lower(last.Substring(dot + 1)) : "";
  }
  public static bool ProgramFile(string path, Rules rules) {
    string extension = Extension(path);
    return extension.Length > 0 && (Has(rules.ProgramExtensions, extension) || System.Array.IndexOf(WindowsPrograms, extension) >= 0);
  }
  public static List<Regex> Compile(List<string> sources) {
    var patterns = new List<Regex>();
    foreach (string source in sources) {
      var pattern = Pattern(source, RegexOptions.IgnoreCase);
      if (pattern != null) patterns.Add(pattern);
    }
    return patterns;
  }
  // A compositor surface cannot identify the app that would receive a pointer
  // event (the Mac's WindowServer; Windows' Desktop Window Manager and its
  // client-server runtime). Keep its protected-title checks, but require an
  // actual app identity.
  public static bool PointerIdentityKnown(string bundleId, string name, string path, int pid) {
    if (pid <= 0 || (string.IsNullOrEmpty(bundleId) && string.IsNullOrEmpty(path))) return false;
    string lname = Lower(name).Trim(), id = Lower(bundleId);
    if (lname == "window server" || lname == "windowserver" || id == "com.apple.windowserver") return false;
    return lname != "dwm" && lname != "csrss" && lname != "desktop window manager" && id != "exe:dwm.exe" && id != "exe:csrss.exe";
  }
  // Command shortcuts can paste clipboard content or invoke autofill. A secure
  // field accepts navigation only; entering its content belongs to the owner.
  static readonly string[] SecureKeys = { "tab", "escape", "esc", "return", "enter", "left", "right", "up", "down" };
  public static bool SecureKeyAllowed(string name, bool command) {
    return !command && System.Array.IndexOf(SecureKeys, name) >= 0;
  }
  // Whether a numbered control has been covered since the agent looked: what
  // is under its center belongs to another app, or sits in a dialog, sheet,
  // menu or popover the control isn't in. Then a click meant for it would
  // land on that instead, so none is sent (batched actions included). Other
  // things of the same page under the point (a card's own link) take the
  // click as a real one would.
  public static bool CoveredControl<T>(T hit, T target, Func<T, T> parent, Func<T, T, bool> equal, Func<T, T, bool> sameApp, Func<T, bool> overlay) where T : class {
    Func<T, List<T>> chain = start => {
      var list = new List<T> { start };
      while (list.Count < 40) {
        T up = parent(list[list.Count - 1]);
        if (up == null) break;
        list.Add(up);
      }
      return list;
    };
    if (!sameApp(hit, target)) return true;
    List<T> hits = chain(hit), targets = chain(target);
    if (hits.Exists(element => equal(element, target)) || targets.Exists(element => equal(element, hit))) return false;
    // Up from what's under the point, until the branch the control is in.
    foreach (T element in hits) {
      if (targets.Exists(other => equal(other, element))) break;
      if (overlay(element)) return true;
    }
    return false;
  }
  // How well a control on screen matches the name the agent gave: the same
  // (ignoring case and spacing) grades 3, starting with it 2, containing it 1,
  // nothing 0.
  public static int NameMatch(string name, string wanted) {
    string have = Squeeze(Lower(name)), want = Squeeze(Lower(wanted));
    if (have.Length == 0 || want.Length == 0) return 0;
    if (have == want) return 3;
    if (have.StartsWith(want, StringComparison.Ordinal)) return 2;
    if (have.Contains(want)) return 1;
    return 0;
  }
  // Which control the agent means, from each one's grade and its distance from
  // where the control was last seen (infinite when nowhere in particular): the
  // best grade; among equals, one clearly nearer than the rest. Otherwise none
  // (-1), with how many were equally good, so the agent says which.
  public static int PickControl(List<KeyValuePair<int, double>> graded, out int candidates) {
    int best = 0;
    foreach (var item in graded) best = Math.Max(best, item.Key);
    candidates = 0;
    if (best == 0) return -1;
    var top = new List<int>();
    for (int i = 0; i < graded.Count; i++) if (graded[i].Key == best) top.Add(i);
    candidates = top.Count;
    if (top.Count == 1) return top[0];
    top.Sort((a, b) => graded[a].Value.CompareTo(graded[b].Value) != 0 ? graded[a].Value.CompareTo(graded[b].Value) : a.CompareTo(b));
    double nearest = graded[top[0]].Value, next = graded[top[1]].Value;
    if (!double.IsInfinity(nearest) && !double.IsNaN(nearest) && next > nearest + 24) return top[0];
    return -1;
  }
  // What the agent typed from its vault, wherever the screen shows it again (a
  // field's value, "Signed in as …"): dots before the agent reads it. Values
  // under three characters aren't tracked: they would blank ordinary text.
  public static readonly string Dots = new string((char)0x2022, 3);
  public static string HideSecrets(string text, List<string> secrets) {
    string result = text ?? "";
    foreach (string secret in secrets) {
      if (string.IsNullOrEmpty(secret) || new StringInfo(secret).LengthInTextElements < 3) continue;
      result = Regex.Replace(result, Regex.Escape(secret), Dots, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    }
    return result;
  }

  // Bank, card, brokerage and payment sites (server/money-sites.mjs, the same
  // rules and test corpus): the agent signs in from its vault, reads, searches,
  // filters by date, downloads and signs out. Nothing that moves money or
  // changes the account. A rule that didn't arrive refuses; so does a page, a
  // control or a field that can't be read.
  public const string MoneyReason = "On a bank site the agent reads, downloads and signs in or out. It doesn't move money or change the account.";
  public const string MoneyLabelReason = "On a bank site the agent presses only controls it can read. This one has no name.";
  public const string MoneyFieldReason = "On a bank site the agent types only into sign-in, code, search and date fields.";
  public const string MoneyPageReason = "This bank page moves money. The agent may read it and leave (Back, Accounts, Sign out), nothing else.";
  public const string MoneyButtonReason = "On a bank site the agent presses only what reads, downloads, filters, opens an account or signs out.";
  public const string MoneyPasteReason = "On a bank site the agent doesn't paste or drag.";
  public const string MoneyUnreadReason = "The page here couldn't be read yet. Describe the screen, then try again.";
  public static readonly Dictionary<string, string> MoneyKinds = new Dictionary<string, string>(StringComparer.Ordinal) {
    { "moneyMove", "move" }, { "moneyCommit", "commit" }, { "moneyAuthPage", "authPage" }, { "moneyAuthOk", "authOk" },
    { "moneyExit", "exit" }, { "moneySafe", "safe" }, { "moneyFieldDeny", "fieldDeny" }, { "moneyFieldOk", "fieldOk" }, { "accountNumber", "accountNumber" },
    { "moneyReadPage", "readPage" }, { "moneyReadOk", "readOk" }, { "moneyTile", "tile" },
  };
  public static Dictionary<string, Regex> MoneyPatterns(Dictionary<string, string> sources) {
    var patterns = new Dictionary<string, Regex>(StringComparer.Ordinal);
    foreach (var kind in MoneyKinds) {
      string source;
      if (!sources.TryGetValue(kind.Key, out source)) continue;
      var pattern = Pattern(source, RegexOptions.IgnoreCase);
      if (pattern != null) patterns[kind.Value] = pattern;
    }
    return patterns;
  }
  // The words that refuse (move, commit, fieldDeny) match everything when missing.
  static readonly string[] RefusingKinds = { "move", "commit", "fieldDeny" };
  public static bool MoneyHas(string kind, string text, Rules rules) {
    bool refusing = System.Array.IndexOf(RefusingKinds, kind) >= 0;
    Regex pattern;
    if (!rules.Money.TryGetValue(kind, out pattern)) return refusing;
    return Matches(pattern, text, refusing);
  }
  // AXPressable: something the page made clickable without saying what it is
  // (a card, a row): judged like a link.
  public static readonly HashSet<string> MoneyActionRoles = new HashSet<string>(StringComparer.Ordinal) { "AXButton", "AXLink", "AXCheckBox", "AXRadioButton", "AXPopUpButton",
    "AXMenuButton", "AXComboBox", "AXMenuItem", "AXTab", "AXDisclosureTriangle", "AXIncrementor", "AXSlider", "AXSwitch", "AXToggle", "AXPressable" };
  public static List<string> MoneyNameWords(string text) {
    var words = new List<string>();
    var current = new StringBuilder();
    for (int i = 0; i < text.Length; i++) {
      bool pair = char.IsHighSurrogate(text[i]) && i + 1 < text.Length && char.IsLowSurrogate(text[i + 1]);
      if (char.IsLetter(text, i) || char.IsNumber(text, i)) {
        current.Append(text[i]);
        if (pair) current.Append(text[++i]);
        continue;
      }
      if (pair) i++;
      if (current.Length > 0) { words.Add(current.ToString()); current.Length = 0; }
    }
    if (current.Length > 0) words.Add(current.ToString());
    return words;
  }
  static bool AllNumbers(string word) {
    for (int i = 0; i < word.Length; i++) {
      if (!char.IsNumber(word, i)) return false;
      if (char.IsHighSurrogate(word[i])) i++;
    }
    return true;
  }
  public static readonly HashSet<string> MoneyFieldRoles = new HashSet<string>(StringComparer.Ordinal) { "AXTextField", "AXTextArea", "AXSearchField", "AXComboBox", "AXSecureTextField" };
  public static string MoneyPlain(string value) { return Squeeze(Lower(value)); }
  static readonly Regex CamelCase = new Regex("([a-z])([A-Z])", RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
  static readonly Regex Separators = new Regex("[_/#?&=+.\\-:]+", RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
  public static string MoneyTidy(string value) {
    string text;
    try { text = (value ?? "").Normalize(NormalizationForm.FormKC); } catch (ArgumentException) { text = value ?? ""; }
    try {
      string split = CamelCase.Replace(text, "$1 $2");
      return Squeeze(Separators.Replace(Lower(split), " "));
    } catch (RegexMatchTimeoutException) {
      return Squeeze(Lower(text));
    }
  }
  static readonly Regex HostFallback = new Regex("^https?://(?:[^/?#@]*@)?([^/?#:@\\[\\]]+)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
  public static string MoneyHost(string url) {
    string value = (url ?? "").Trim();
    var parts = Url.Parse(value);
    if (parts != null && parts.Scheme != null && !string.IsNullOrEmpty(parts.Host)) {
      string scheme = Lower(parts.Scheme);
      return scheme == "http" || scheme == "https" ? Lower(parts.Host) : null;
    }
    // An address URLComponents won't take still names its host.
    try {
      var match = HostFallback.Match(value);
      if (!match.Success || match.Groups[1].Value.Length == 0) return null;
      return Lower(match.Groups[1].Value);
    } catch (RegexMatchTimeoutException) {
      return null;
    }
  }
  public static bool MoneySite(string url, Rules rules) {
    if (rules.Mode == "full") return false;
    string host = MoneyHost(url);
    if (string.IsNullOrEmpty(host)) return false;
    if (host.EndsWith(".", StringComparison.Ordinal)) host = host.Substring(0, host.Length - 1);
    return rules.MoneySites.Exists(site => site.Length > 0 && (host == site || host.EndsWith("." + site, StringComparison.Ordinal)));
  }
  // A page and the frames it holds: the bank's when any of them is.
  public static bool MoneyFrames(List<string> urls, Rules rules) { return urls.Exists(url => MoneySite(url, rules)); }
  // url: one page address, or several (a page and its frames) separated by spaces.
  public static string MoneyPage(string url, string title, Rules rules) {
    string rest = url ?? "";
    var parts = Url.Parse(rest.Trim());
    if (parts != null && parts.Host != null)
      rest = parts.Path + " " + (parts.Query != null ? "?" + parts.Query : "") + " " + (parts.Fragment != null ? "#" + parts.Fragment : "");
    string words = MoneyTidy(rest) + " " + MoneyTidy(title);
    if (MoneyHas("move", words, rules)) return "move";
    if (MoneyHas("authPage", words, rules)) return "auth";
    if (MoneyHas("readPage", words, rules)) return "read";
    return "";
  }
  public static string MoneyClickReason(string url, string title, List<string> labels, string role, Rules rules) {
    if (rules.Mode == "full") return null;
    string page = MoneyPage(url, title, rules);
    var names = labels.ConvertAll(MoneyPlain).FindAll(name => name.Length > 0);
    string own = names.Count > 0 ? names[0] : "", all = string.Join(" ", names);
    if (page == "move") return MoneyHas("exit", own, rules) ? null : MoneyPageReason;
    if (MoneyFieldRoles.Contains(role)) return MoneyHas("move", all, rules) ? MoneyReason : null;
    if (page == "auth" && MoneyHas("authOk", own, rules)) return null;
    if (MoneyHas("safe", own, rules) || MoneyHas("exit", own, rules)) return null;
    if (page == "read" && MoneyHas("readOk", own, rules)) return null;
    if (MoneyHas("move", all, rules) || MoneyHas("commit", all, rules)) return MoneyReason;
    if (all.Length == 0) return MoneyActionRoles.Contains(role) ? MoneyLabelReason : null;
    if (!MoneyActionRoles.Contains(role)) return null; // text the page didn't make clickable
    // Only reading words (in a language these rules know), or an account's
    // tile showing its number or balance.
    if (MoneyNameWords(own).TrueForAll(word => AllNumbers(word) || rules.MoneyReadWords.Contains(word))) return null;
    if ((role == "AXLink" || role == "AXPressable") && MoneyHas("tile", all, rules)) return null;
    return MoneyButtonReason;
  }
  public static string MoneyTypeReason(string url, string title, string label, bool secure, bool secret, Rules rules) {
    if (rules.Mode == "full") return null;
    if (MoneyPage(url, title, rules) == "move") return MoneyPageReason;
    if (secure) return secret ? null : MoneyFieldReason;
    string name = MoneyPlain(label);
    if (name.Length == 0 || MoneyHas("fieldDeny", name, rules) || MoneyHas("move", name, rules)) return MoneyFieldReason;
    return MoneyHas("fieldOk", name, rules) ? null : MoneyFieldReason;
  }
  static readonly string[] MoneyNavigation = { "tab", "escape", "esc", "up", "down", "left", "right", "home", "end", "pageup", "pagedown" };
  static readonly string[] MoneyBrowserCommands = { "[", "]", "l", "w", "f", "c", "a", "t" };
  public static string MoneyKeyReason(string url, string title, string key, bool command, bool control, bool field, bool secure, List<string> labels, string role, Rules rules) {
    if (rules.Mode == "full") return null;
    string name = (key ?? "").ToLowerInvariant();
    Func<string> inField = () => MoneyTypeReason(url, title, labels.Count > 0 ? labels[0] : "", secure, true, rules);
    if ((command || control) && (name == "v" || name == "y")) return MoneyPasteReason;
    if (name == "return" || name == "enter" || name == "space") return field || secure ? inField() : MoneyClickReason(url, title, labels, role, rules);
    if (command && !control && System.Array.IndexOf(MoneyBrowserCommands, name) >= 0) return null;
    if (!command && !control && System.Array.IndexOf(MoneyNavigation, name) >= 0) return null;
    if (field || secure) return command || control ? (MoneyPage(url, title, rules) == "move" ? MoneyPageReason : null) : inField();
    return MoneyPage(url, title, rules) == "move" ? MoneyPageReason : null;
  }
  // Account and card numbers on a bank page: only their last four digits.
  // Out of time: no digit at all.
  public static string MaskAccountNumbers(string text, Rules rules) {
    if (rules.Mode == "full") return text;
    Regex pattern;
    if (!rules.Money.TryGetValue("accountNumber", out pattern)) return text;
    try {
      return pattern.Replace(text, match => {
        var digits = new StringBuilder();
        foreach (char c in match.Value) if (char.IsDigit(c)) digits.Append(c);
        string last = digits.ToString();
        return new string((char)0x2022, 4) + (last.Length > 4 ? last.Substring(last.Length - 4) : last);
      });
    } catch (RegexMatchTimeoutException) {
      var safe = new StringBuilder(text.Length);
      foreach (char c in text) safe.Append(char.IsDigit(c) ? (char)0x2022 : c);
      return safe.ToString();
    }
  }
}
// END PURE DESKTOP POLICY

// BEGIN PURE DESKTOP TEXT
// Each keyboard event must contain complete UTF-16 surrogate pairs. Splitting
// an emoji between events can insert two replacement characters in the app.
// One character (grapheme) per event: some apps read only the first character
// of an event. A character longer than 16 units splits by scalar.
static class Text {
  public static List<ushort[]> KeyboardChunks(string text) {
    var result = new List<ushort[]>();
    var each = StringInfo.GetTextElementEnumerator(text ?? "");
    while (each.MoveNext()) {
      string character = (string)each.Current;
      if (character.Length <= 16) { result.Add(Units(character)); continue; }
      var chunk = new StringBuilder();
      for (int i = 0; i < character.Length; i++) {
        int width = char.IsHighSurrogate(character[i]) && i + 1 < character.Length && char.IsLowSurrogate(character[i + 1]) ? 2 : 1;
        if (chunk.Length + width > 16) { result.Add(Units(chunk.ToString())); chunk.Length = 0; }
        chunk.Append(character, i, width);
        i += width - 1;
      }
      if (chunk.Length > 0) result.Add(Units(chunk.ToString()));
    }
    return result;
  }
  static ushort[] Units(string text) {
    var units = new ushort[text.Length];
    for (int i = 0; i < text.Length; i++) units[i] = text[i];
    return units;
  }
}
// END PURE DESKTOP TEXT

// BEGIN LINE FRAMING
// stdin as bytes, cut at each newline (a CR before it dropped), each line
// decoded as strict UTF-8. A line over the limit is skipped to its newline
// and, like one that isn't UTF-8, given as `invalid`: the next one is read.
sealed class LineFramer {
  readonly int max;
  readonly string invalid;
  readonly MemoryStream line = new MemoryStream();
  readonly UTF8Encoding utf8 = new UTF8Encoding(false, true);
  bool skipping;
  public LineFramer(int max, string invalid) { this.max = max; this.invalid = invalid; }
  public void Feed(byte[] buffer, int count, Action<string> emit) {
    int start = 0;
    while (start < count) {
      int end = System.Array.IndexOf(buffer, (byte)10, start, count - start);
      int stop = end < 0 ? count : end;
      if (!skipping) {
        if (line.Length + (stop - start) > max) { skipping = true; line.SetLength(0); }
        else line.Write(buffer, start, stop - start);
      }
      if (end < 0) return;
      if (skipping) emit(invalid);
      else {
        byte[] bytes = line.ToArray();
        int length = bytes.Length;
        if (length > 0 && bytes[length - 1] == 13) length--;
        string text;
        try { text = utf8.GetString(bytes, 0, length); } catch (ArgumentException) { text = invalid; }
        emit(text);
      }
      line.SetLength(0);
      skipping = false;
      start = end + 1;
    }
  }
}
// END LINE FRAMING

// BEGIN DESKTOP MASKS
// What a screenshot shows, decided from the windows Windows listed (§4.3):
// no Windows call here, so tests decide it from windows they describe.
// A process as the rules judge it (§7.1).
sealed class Ident {
  public int Pid;
  public long Created;
  public string Bundle = "", Path = "", Image = "", Name = "";
  public bool Known, Packaged;
  public int Integrity = -1;
}
// A rectangle of physical pixels of the virtual screen: [Left, Right) by [Top, Bottom).
struct Box {
  public int Left, Top, Right, Bottom;
  public Box(int left, int top, int right, int bottom) { Left = left; Top = top; Right = right; Bottom = bottom; }
  public int Width { get { return Math.Max(0, Right - Left); } }
  public int Height { get { return Math.Max(0, Bottom - Top); } }
  public bool Empty { get { return Right <= Left || Bottom <= Top; } }
  public Box Intersect(Box other) { return new Box(Math.Max(Left, other.Left), Math.Max(Top, other.Top), Math.Min(Right, other.Right), Math.Min(Bottom, other.Bottom)); }
  public bool Contains(int x, int y) { return x >= Left && x < Right && y >= Top && y < Bottom; }
  public Box Inset(int by) { return new Box(Left + by, Top + by, Right - by, Bottom - by); }
}
// A set of pixels, as rectangles that don't overlap.
sealed class PixelSet {
  public List<Box> Boxes = new List<Box>();
  public static PixelSet Of(Box box) { var set = new PixelSet(); set.Add(box); return set; }
  public void Add(Box box) {
    if (box.Empty) return;
    var parts = new List<Box> { box };
    foreach (var have in Boxes) {
      var next = new List<Box>();
      foreach (var part in parts) Cut(part, have, next);
      parts = next;
      if (parts.Count == 0) return;
    }
    Boxes.AddRange(parts);
  }
  public void Add(PixelSet other) { foreach (var box in other.Boxes) Add(box); }
  public void Subtract(Box hole) {
    if (hole.Empty) return;
    var next = new List<Box>();
    foreach (var box in Boxes) Cut(box, hole, next);
    Boxes = next;
  }
  public PixelSet Intersect(PixelSet other) {
    var result = new PixelSet();
    foreach (var a in Boxes) foreach (var b in other.Boxes) { var both = a.Intersect(b); if (!both.Empty) result.Boxes.Add(both); }
    return result;
  }
  public bool Contains(int x, int y) { foreach (var box in Boxes) if (box.Contains(x, y)) return true; return false; }
  public long Area { get { long area = 0; foreach (var box in Boxes) area += (long)box.Width * box.Height; return area; } }
  // The parts of box outside hole.
  static void Cut(Box box, Box hole, List<Box> into) {
    var overlap = box.Intersect(hole);
    if (overlap.Empty) { into.Add(box); return; }
    if (box.Top < overlap.Top) into.Add(new Box(box.Left, box.Top, box.Right, overlap.Top));
    if (overlap.Bottom < box.Bottom) into.Add(new Box(box.Left, overlap.Bottom, box.Right, box.Bottom));
    if (box.Left < overlap.Left) into.Add(new Box(box.Left, overlap.Top, overlap.Left, overlap.Bottom));
    if (overlap.Right < box.Right) into.Add(new Box(overlap.Right, overlap.Top, box.Right, overlap.Bottom));
  }
}
// One top-level window as it was read, and what was decided about it.
sealed class Win {
  public long Handle, Owner;
  public string Class = "";
  public int Pid;
  public Ident Id;
  public bool Visible, Iconic, Cloaked, HasRegion, InL1, InL2, FrameRead, LayeredRead, TitleRead = true;
  public int L1Index = int.MaxValue;
  public Box Frame;
  public uint ExStyle, LayeredFlags;
  public byte Alpha = 255;
  public int Backdrop = -1;   // DWMWA_SYSTEMBACKDROP_TYPE; -1 when Windows doesn't have it
  public double Scale = 1;    // its DPI over 96
  public string Title = "";
  // Top: above every desktop window (topmost, the shell, immersive, or found
  // only by the second walk). Shell: a system surface. Overlay: draws other
  // windows' content (Task View, Alt+Tab, Snap Assist, thumbnails).
  public bool Top, Shell, Overlay, Explorer, Terminal, Reach, Excluded, Allowed;
  public string Reason;
  // Draws pixels: visible, not cloaked, not minimized, not fully transparent.
  public bool Shows { get { return Visible && !Cloaked && !Iconic && !(LayeredRead && (LayeredFlags & Native.LWA_ALPHA) != 0 && Alpha == 0); } }
  public string Key {
    get {
      return string.Join("|", new object[] { Handle, Frame.Left, Frame.Top, Frame.Right, Frame.Bottom, Visible, Cloaked, Iconic, ExStyle, Title, Pid });
    }
  }
  // Drawn solid: nothing behind it shows through (§4.3 step 5). A window made
  // see-through in a way Windows doesn't report (blur behind with per-pixel
  // alpha, an undocumented accent) can't be told apart: the residual §15 notes.
  public bool Opaque {
    get {
      if (!Shows || Id == null || !Id.Known) return false;
      if ((ExStyle & (Native.WS_EX_TRANSPARENT | Native.WS_EX_NOREDIRECTIONBITMAP)) != 0) return false;
      if ((ExStyle & Native.WS_EX_LAYERED) != 0 && !(LayeredRead && (LayeredFlags & Native.LWA_COLORKEY) == 0 && Alpha == 255)) return false;
      if (!(Backdrop < 0 || Backdrop == 0 || Backdrop == 1 || Backdrop == 2 || Backdrop == 4)) return false;
      return !HasRegion && !Shell;
    }
  }
  // Its place in the stack: found only by the second walk, above everything;
  // then the top band, then the desktop's windows, each in Windows' order.
  public int Rank { get { return !InL1 ? 0 : Top ? 1 : 2; } }
  public bool Above(Win other) { return Rank != other.Rank ? Rank < other.Rank : L1Index < other.L1Index; }
}
sealed class Inventory {
  public List<Win> Windows = new List<Win>();
  public bool Complete = true;
  public static bool Same(Inventory a, Inventory b) {
    if (a.Windows.Count != b.Windows.Count) return false;
    for (int i = 0; i < a.Windows.Count; i++) if (a.Windows[i].Key != b.Windows[i].Key) return false;
    return true;
  }
}
static class Masks {
  // What is painted black on the screen; every look's windows count (a window
  // in any of them is handled). No looks (they never agreed, or Windows
  // wouldn't list every window): the whole screen.
  public static PixelSet Black(string mode, Box screen, List<Inventory> looks, bool strict, out int hidden) {
    hidden = 0;
    if (looks == null || looks.Count == 0 || mode == "full") return mode == "full" ? new PixelSet() : PixelSet.Of(screen);
    var counted = new HashSet<long>();
    if (mode == "view") {
      var black = new PixelSet();
      foreach (var look in looks) {
        black.Add(View(look.Windows, screen, strict));
        foreach (var w in look.Windows) if (w.Excluded && On(w, screen) && counted.Add(w.Handle)) hidden++;
      }
      return Bounded(black, screen);
    }
    PixelSet paint = null;
    foreach (var look in looks) {
      var painted = Apps(look.Windows, screen, strict);
      paint = paint == null ? painted : paint.Intersect(painted);
      foreach (var w in look.Windows) if (!w.Allowed && On(w, screen) && counted.Add(w.Handle)) hidden++;
    }
    var rest = PixelSet.Of(screen);
    foreach (var box in paint.Boxes) rest.Subtract(box);
    return Bounded(rest, screen);
  }
  // Too fragmented to trust: all of it.
  static PixelSet Bounded(PixelSet set, Box screen) { return set.Boxes.Count > 20000 ? PixelSet.Of(screen) : set; }
  public static bool On(Win w, Box screen) { return w.Shows && w.FrameRead && !w.Frame.Intersect(screen).Empty; }
  // View: every closed window's whole frame, less what a solid window
  // definitely above it covers (not while a thumbnail overlay is up, and not
  // in strict mode). Windows 11's rounded corners keep 8 px per side black.
  public static PixelSet View(List<Win> windows, Box screen, bool strict) {
    var mask = new PixelSet();
    bool overlay = windows.Exists(w => w.Overlay && On(w, screen));
    foreach (var e in windows) {
      if (!e.Excluded || !On(e, screen)) continue;
      var part = PixelSet.Of(e.Frame.Intersect(screen));
      if (!strict && !overlay)
        foreach (var o in windows)
          if (!ReferenceEquals(o, e) && On(o, screen) && o.Opaque && DefinitelyAbove(o, e)) part.Subtract(o.Frame.Inset((int)Math.Ceiling(8 * o.Scale)));
      mask.Add(part);
    }
    return mask;
  }
  // Windows keeps one order only among desktop windows; a topmost window is
  // also over every one of them.
  static bool DefinitelyAbove(Win o, Win e) {
    bool eDesktop = e.InL1 && !e.Top, oDesktop = o.InL1 && !o.Top;
    if (oDesktop && eDesktop) return o.L1Index < e.L1Index;
    return o.InL1 && (o.ExStyle & Native.WS_EX_TOPMOST) != 0 && !o.Shell && eDesktop;
  }
  // Apps: only the chosen apps' windows, less every window above each, every
  // top-band window not chosen (a toast, Start, a topmost tool) wherever it
  // is, and any closed window below one that isn't solid. While Task View,
  // Alt+Tab or a thumbnail is up, nothing.
  public static PixelSet Apps(List<Win> windows, Box screen, bool strict) {
    var paint = new PixelSet();
    if (windows.Exists(w => w.Overlay && On(w, screen))) return paint;
    foreach (var a in windows) {
      if (!a.Allowed || !On(a, screen)) continue;
      var part = PixelSet.Of(a.Frame.Intersect(screen));
      bool solid = a.Opaque && !strict;
      foreach (var w in windows) {
        if (ReferenceEquals(w, a) || !On(w, screen)) continue;
        if (w.Above(a) || (w.Top && !w.Allowed) || (w.Excluded && a.Above(w) && !solid)) part.Subtract(w.Frame);
      }
      paint.Add(part);
    }
    return paint;
  }
}
// END DESKTOP MASKS

// BEGIN DESKTOP INPUT SEAMS
// What input sees of Windows, and where it goes: Windows itself (WindowsView,
// WindowsInput), or a test's stand-ins (test/fixtures/windows/
// agent-desktop-checks.cs), so the production checks run against both.
interface IDesktopView {
  Inventory Windows(Rules rules);           // every top-level window, read and decided (§4.3)
  Win RouteAt(int x, int y, Rules rules);   // the window Windows routes a click there to; null: none
  Win Foreground(Rules rules);              // the window in front; null: none
  int ForegroundIntegrity();                // its process's integrity; -2 no window in front, -1 unknown
  Seen ElementAt(int x, int y);             // UI Automation's element there; null: none
  Seen Focused();                           // UI Automation's focused element; null: none
  Box VirtualScreen();                      // every monitor, in physical pixels
  int KeyFor(char c);                       // VkKeyScanExW in the front window's layout: VK | shift state << 8; -1 none
  ushort ScanFor(ushort vk);                // MapVirtualKeyExW in the front window's layout
  bool HostsReach(int pid, Rules rules);    // one of this process's windows (or its tabs) is Reach's
  string InputDesktop();                    // "Default" for the owner's desktop
  string ExplorerPlace(long window);        // a File Explorer window's folder, by its parsing name; null: unknown
}
interface IInput {
  bool KeyDown(int vk);                     // GetAsyncKeyState: down right now
  uint Send(Native.INPUT[] batch);          // SendInput: one atomic batch
  void Pause(int ms);
  int DoubleClickMs();                      // GetDoubleClickTime
  int DoubleClickSize();                    // the double-click rectangle's larger side, in pixels
}
interface IClip {
  string Read();                            // the clipboard's text; null when it holds none
  void Write(string text);                  // text (or nothing for null), kept out of Clipboard History and cloud sync
  uint Sequence();                          // changes with every write, anyone's
}
// What an event at a point, or a key, would reach (agent-desktop.swift's
// Seen): its app, its window's title, for web content the page, whether it
// takes a password; on Windows also its window, whether it's the shell or a
// field that runs programs.
sealed class Seen {
  public string Bundle = "", Name = "", Path = "", Title = "", Url = "", Role = "", Control = "", Class = "", AutomationId = "";
  public int Pid;
  public Ident Id = new Ident();
  public long Root;
  public bool Secure, Web, Bank, Shell, Terminal, Reach, Explorer, Chrome, TitleRead = true;
  public Box Frame;           // where it is, in physical pixels
  public List<string> Frames = new List<string>(), Labels = new List<string>();
  public bool CommandField;   // inside a box that runs programs: an address band, Run, Explorer's search (§7.8)
  public bool FolderEdit;     // the rename box of a folder view (§7.8)
  public bool Editable;
}
// END DESKTOP INPUT SEAMS

static partial class Desk {
  // --- The protocol -------------------------------------------------------
  // One line at a time from stdin, as raw bytes: a line over 256 KiB, or one
  // that isn't strict UTF-8, is answered "Invalid request." and the next one
  // read. Console.In is never used (it decodes with the console's code page).
  const int MaxLine = 262144;
  public static readonly string InvalidLine = new string('\0', 1);
  static readonly BlockingCollection<string> lines = new BlockingCollection<string>(4);
  static readonly object outLock = new object();
  static Stream input;
  static StreamWriter output;
  static Rules current;
  static int reachPid;
  static bool reachHasConsole;

  [MTAThread]
  static int Main(string[] args) {
    // Streams first, before anything touches a console (Reach's, §7.3).
    input = Console.OpenStandardInput();
    output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
    output.AutoFlush = false;
    output.NewLine = "\n";
    if (!Arguments(args) || !WatchReach()) return 2;
    Startup();
    StartThreads();
    while (true) Handle(lines.Take());
  }

  static bool Arguments(string[] args) {
    for (int i = 0; i + 1 < args.Length; i += 2) {
      if (args[i] == "--reach-pid") {
        int pid;
        if (!int.TryParse(args[i + 1], NumberStyles.None, CultureInfo.InvariantCulture, out pid) || pid <= 0) return false;
        reachPid = pid;
      } else if (args[i] == "--reach-console") {
        if (args[i + 1] != "0" && args[i + 1] != "1") return false;
        reachHasConsole = args[i + 1] == "1";
      } else return false;
    }
    return reachPid > 0;
  }

  static void ReadInput() {
    var buffer = new byte[65536];
    var framer = new LineFramer(MaxLine, InvalidLine);
    try {
      while (true) {
        int count = input.Read(buffer, 0, buffer.Length);
        if (count <= 0) break;
        framer.Feed(buffer, count, lines.Add);
      }
    } catch (Exception) {
      // The pipe broke: the same as its end.
    }
    End();
  }

  static void Handle(string line) {
    try {
      if (ReferenceEquals(line, InvalidLine)) throw new Refusal("Invalid request.", "invalid");
      Dictionary<string, object> request;
      try { request = Json.Parse(line) as Dictionary<string, object>; } catch (FormatException) { request = null; }
      if (request == null) throw new Refusal("Invalid request.", "invalid");
      Reply(Dispatch(request));
    } catch (Refusal refusal) {
      var answer = new Dictionary<string, object>();
      answer["error"] = refusal.Message;
      answer["kind"] = refusal.Kind;
      answer["candidates"] = refusal.Candidates;
      Reply(answer);
      if (refusal is Wedged) End();
    } catch (Exception) {
      var answer = new Dictionary<string, object>();
      answer["error"] = "The Windows PC couldn't do that.";
      answer["kind"] = "unavailable";
      Reply(answer);
    }
  }

  static void Reply(Dictionary<string, object> value) {
    string text = Json.Write(value);
    lock (outLock) {
      output.Write(text);
      output.Write('\n');
      output.Flush();
    }
  }

  static Dictionary<string, object> Ok() {
    var result = new Dictionary<string, object>();
    result["ok"] = true;
    return result;
  }

  static Dictionary<string, object> Dispatch(Dictionary<string, object> request) {
    string op = Json.Str(request, "op") ?? "";
    if (op == "rules") {
      if (startupProblem != null) throw new Refusal(startupProblem, "unavailable");
      current = Rules.From(request);
      ProbeReachConsole();
      var ready = Ok();
      ready["accessibility"] = uiaReady;
      ready["screen"] = ScreenReadable();
      ready["mode"] = current.Mode;
      ready["elevated"] = ownIntegrity < 0 || ownIntegrity >= HighIntegrity;
      ready["desktop"] = InputDesktopName();
      ready["reachConsole"] = reachConsole;
      return ready;
    }
    if (op == "catalog") return Catalog();
    if (current == null) throw new Refusal("Rules come first.", "invalid");
    if (startupProblem != null) throw new Refusal(startupProblem, "unavailable");
    var action = Json.Map(request, "action");
    ChooseDisplay(Json.Get(request, "displayId") ?? Json.Get(action, "displayId") ?? RememberedDisplay(action));
    switch (op) {
      case "displays": return Displays();
      case "shot": return Shot(current, Math.Max(320, Math.Min(3840, Json.Int(request, "maxWidth") ?? 2560)));
      case "front": return Front(current, Json.True(request, "detail"));
      case "elements": return SnapshotPayload(ReadScreen(current, true, Json.Str(request, "within")));
      case "find": RuleS(); return FindOnScreen(current, Json.Str(request, "text"), Json.Str(request, "name"), Json.Str(request, "role"));
      case "read": return ReadPage(current);
      case "windows": return WindowList(current);
      case "focus": RuleS(); ReadyToAct(); return FocusWindow(Json.Str(request, "id") ?? "", Json.Str(request, "title") ?? "", Json.Str(request, "tab") ?? "", Json.Str(request, "tabRef") ?? "", current);
      case "menus": return MenuBar(current, Json.Str(request, "menu") ?? "");
      case "wait-change": {
        double? revision = Json.Double(request, "revision");
        return WaitChange(revision.HasValue ? (long)revision.Value : Interlocked.Read(ref screenRevision), Json.Int(request, "ms") ?? 400);
      }
      case "open": RuleS(); OnOwnersDesktop(); return Open(Json.Str(request, "app") ?? "", current);
      case "open-url": RuleS(); OnOwnersDesktop(); return OpenUrl(Json.Str(request, "url"), Json.Str(request, "app") ?? "", current);
      case "open-file": RuleS(); OnOwnersDesktop(); return OpenFile(Json.Str(request, "path") ?? "", Json.True(request, "reveal"), current);
      // Saved browser tools reach the browser through Apple Events on a Mac;
      // on Windows they come with Reach's browser extension (workstream G).
      case "browser-check": throw new Refusal("Saved browser tools on Windows come with Reach's browser extension, which isn't installed yet.", "setup_required");
      case "act": {
        RuleS();
        var act = Json.Map(request, "action");
        if (act == null) throw new Refusal("Choose an action.", "invalid");
        var monitor = Display();
        return Perform(act, new Box(monitor.Rect.Left, monitor.Rect.Top, monitor.Rect.Right, monitor.Rect.Bottom), current, Expected(request));
      }
      default: throw new Refusal("Unknown request.", "invalid");
    }
  }

  // The end of input (Reach's stop, or Node gone), Reach's own end, or a
  // thread that wedged: let go of anything held, finish the last line, exit.
  // On Windows a kill gives no chance to run anything, so this is the only
  // moment a held button can be released (§5.4).
  static int ending;
  static void End() {
    if (Interlocked.Exchange(ref ending, 1) != 0) return;
    try { LetGo(); } catch (Exception) { }
    try { lock (outLock) output.Flush(); } catch (Exception) { }
    Native.TerminateProcess(Native.GetCurrentProcess(), 0);
  }

  // --- Startup (§2.4) -------------------------------------------------------
  // Anything that fails here closes every op but the catalog, with the reason.
  static string startupProblem;
  static bool uiaReady;
  internal static int ownIntegrity = -1;
  const int HighIntegrity = 0x3000;

  static void Startup() {
    // No crash dialog, and no crash report carrying memory that may hold a
    // vault value.
    Native.SetErrorMode(Native.SEM_FAILCRITICALERRORS | Native.SEM_NOGPFAULTERRORBOX);
    try { Native.WerSetFlags(Native.WER_FAULT_REPORTING_FLAG_NOHEAP); } catch (Exception) { }
    ownIntegrity = IntegrityOf(Native.GetCurrentProcess());
    if (!PerMonitorAware())
      startupProblem = "Windows didn't start Reach's agent helper with the screen's own scale, so it can't place clicks on this PC.";
    else if (!TitlesReadable())
      startupProblem = "This version of Windows changed how window titles are read. Reach can't check windows here yet.";
    else if (Marshal.SizeOf(typeof(Native.INPUT)) != (IntPtr.Size == 8 ? 40 : 28))
      startupProblem = "Reach's agent helper doesn't match this version of Windows.";
    // UI Automation, checked against known answers; without it the agent
    // only looks (the server refuses the rest, with the reason).
    uiaReady = startupProblem == null && Uia.Start();
  }

  // The manifest makes it per-monitor aware (v2): window frames, UI
  // Automation rectangles, the pointer and monitors in physical pixels.
  static bool PerMonitorAware() {
    try {
      return Native.AreDpiAwarenessContextsEqual(Native.GetThreadDpiAwarenessContext(), Native.DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    } catch (Exception) {
      return false;
    }
  }

  // InternalGetWindowText reads a title from the window itself, a caption or
  // not; Microsoft says it may change. A window of its own, titled and read
  // back, proves it still works here (§2.4).
  static bool TitlesReadable() {
    bool ok = false;
    var thread = new Thread(() => {
      IntPtr window = Native.CreateWindowExW(0, "STATIC", "reach-title-check", Native.WS_POPUP, 0, 0, 0, 0, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
      if (window == IntPtr.Zero) return;
      try {
        var text = new StringBuilder(64);
        ok = Native.InternalGetWindowText(window, text, text.Capacity) == 17 && text.ToString() == "reach-title-check";
      } catch (Exception) {
        ok = false;
      } finally {
        Native.DestroyWindow(window);
      }
    });
    thread.IsBackground = true;
    thread.Start();
    return thread.Join(5000) && ok;
  }

  // A process's integrity level (its token's mandatory label: 0x2000 medium,
  // 0x3000 high, 0x4000 system), or -1 when it can't be read.
  internal static int IntegrityOf(IntPtr process) {
    IntPtr token;
    if (!Native.OpenProcessToken(process, Native.TOKEN_QUERY, out token)) return -1;
    try {
      int size;
      Native.GetTokenInformation(token, Native.TokenIntegrityLevel, IntPtr.Zero, 0, out size);
      if (size <= 0 || size > 4096) return -1;
      IntPtr buffer = Marshal.AllocHGlobal(size);
      try {
        if (!Native.GetTokenInformation(token, Native.TokenIntegrityLevel, buffer, size, out size)) return -1;
        IntPtr sid = Marshal.ReadIntPtr(buffer);
        if (sid == IntPtr.Zero || !Native.IsValidSid(sid)) return -1;
        int count = Marshal.ReadByte(Native.GetSidSubAuthorityCount(sid));
        if (count < 1) return -1;
        return Marshal.ReadInt32(Native.GetSidSubAuthority(sid, (uint)(count - 1)));
      } finally {
        Marshal.FreeHGlobal(buffer);
      }
    } finally {
      Native.CloseHandle(token);
    }
  }

  // The desktop that takes input now: "Default" for the owner's; the secure
  // desktop (UAC, the lock and sign-in screens) can't be opened or named.
  internal static string InputDesktopName() {
    IntPtr desktop = Native.OpenInputDesktop(0, false, Native.DESKTOP_READOBJECTS);
    if (desktop == IntPtr.Zero) return "";
    try {
      var name = new byte[512];
      int needed;
      if (!Native.GetUserObjectInformationW(desktop, Native.UOI_NAME, name, name.Length, out needed) || needed < 2 || needed > name.Length) return "";
      return Encoding.Unicode.GetString(name, 0, needed).TrimEnd('\0');
    } finally {
      Native.CloseDesktop(desktop);
    }
  }

  // Whether a pixel of the screen can be copied at all (a disconnected or
  // locked session gives none).
  static bool ScreenReadable() {
    IntPtr screen = Native.GetDC(IntPtr.Zero);
    if (screen == IntPtr.Zero) return false;
    IntPtr memory = IntPtr.Zero, bitmap = IntPtr.Zero, old = IntPtr.Zero;
    try {
      memory = Native.CreateCompatibleDC(screen);
      bitmap = Native.CreateCompatibleBitmap(screen, 1, 1);
      if (memory == IntPtr.Zero || bitmap == IntPtr.Zero) return false;
      old = Native.SelectObject(memory, bitmap);
      return Native.BitBlt(memory, 0, 0, 1, 1, screen, 0, 0, Native.SRCCOPY);
    } finally {
      if (old != IntPtr.Zero) Native.SelectObject(memory, old);
      if (bitmap != IntPtr.Zero) Native.DeleteObject(bitmap);
      if (memory != IntPtr.Zero) Native.DeleteDC(memory);
      Native.ReleaseDC(IntPtr.Zero, screen);
    }
  }

  // --- Threads (§2.2) -------------------------------------------------------
  static IntPtr reachProcess;

  // Reach's process, held open for this helper's life (its id can't be given
  // to another process meanwhile). It must be older than this helper.
  static bool WatchReach() {
    reachProcess = Native.OpenProcess(Native.SYNCHRONIZE | Native.PROCESS_QUERY_LIMITED_INFORMATION, false, reachPid);
    if (reachProcess == IntPtr.Zero) return false;
    long reachCreated, ownCreated, ignored;
    if (!Native.GetProcessTimes(reachProcess, out reachCreated, out ignored, out ignored, out ignored) ||
        !Native.GetProcessTimes(Native.GetCurrentProcess(), out ownCreated, out ignored, out ignored, out ignored) ||
        reachCreated >= ownCreated) return false;
    return true;
  }

  static void StartThreads() {
    Background("stdin-reader", ReadInput, ApartmentState.MTA);
    // When Reach ends (a crash, Ctrl+C in its terminal), this helper ends too,
    // letting go first: Node can't stop a detached helper itself.
    Background("watchdog", () => { Native.WaitForSingleObject(reachProcess, Native.INFINITE); End(); }, ApartmentState.MTA);
    Background("window-events", WindowEvents, ApartmentState.STA);
    Background("uia-events", UiaEvents, ApartmentState.MTA);
  }

  static Thread Background(string name, ThreadStart work, ApartmentState apartment) {
    var thread = new Thread(() => { try { work(); } catch (Exception) { } });
    thread.Name = name;
    thread.IsBackground = true;
    thread.SetApartmentState(apartment);
    thread.Start();
    return thread;
  }

  // Every change to a top-level window (shown, hidden, moved, retitled,
  // reordered, cloaked, brought forward) moves this count. A screenshot taken
  // while it moved is taken again (§4.3 step 4).
  static int windowRevision;
  static Native.WinEventProc winEvents;
  static void WindowEvents() {
    winEvents = OnWindowEvent;
    uint flags = Native.WINEVENT_OUTOFCONTEXT | Native.WINEVENT_SKIPOWNPROCESS;
    Native.SetWinEventHook(Native.EVENT_SYSTEM_FOREGROUND, Native.EVENT_SYSTEM_FOREGROUND, IntPtr.Zero, winEvents, 0, 0, flags);
    Native.SetWinEventHook(Native.EVENT_OBJECT_SHOW, Native.EVENT_OBJECT_UNCLOAKED, IntPtr.Zero, winEvents, 0, 0, flags);
    Native.MSG message;
    while (Native.GetMessageW(out message, IntPtr.Zero, 0, 0) > 0) {
      Native.TranslateMessage(ref message);
      Native.DispatchMessageW(ref message);
    }
  }
  static void OnWindowEvent(IntPtr hook, uint kind, IntPtr window, int objectId, int childId, uint thread, uint time) {
    if (window == IntPtr.Zero || objectId != Native.OBJID_WINDOW || childId != 0) return;
    if (kind != Native.EVENT_SYSTEM_FOREGROUND && kind != Native.EVENT_OBJECT_SHOW && kind != Native.EVENT_OBJECT_HIDE && kind != Native.EVENT_OBJECT_REORDER &&
        kind != Native.EVENT_OBJECT_LOCATIONCHANGE && kind != Native.EVENT_OBJECT_NAMECHANGE && kind != Native.EVENT_OBJECT_CLOAKED && kind != Native.EVENT_OBJECT_UNCLOAKED) return;
    if (Native.GetAncestor(window, Native.GA_ROOT) != window && window != Native.GetDesktopWindow()) return;
    Interlocked.Increment(ref windowRevision);
  }

  // --- Reach's own console window (§7.3) -----------------------------------
  // On a Mac, Reach's Terminal window is the one whose title names Reach; so
  // it is here (the owner's rule for both, Oct 12), and Reach titles its
  // console "Reach". In a classic console window, that window is also known
  // exactly, whatever its title: by attaching to Reach's console for a moment.
  // Inside a terminal app (a pseudo console) Windows doesn't say which window
  // shows Reach's tab, so only the title rule applies there.
  static string reachConsole = "unknown";
  static IntPtr reachConsoleWindow = IntPtr.Zero;
  static Native.ConsoleCtrlHandler ignoreControl;
  static void ProbeReachConsole() {
    reachConsoleWindow = IntPtr.Zero;
    reachConsole = "unknown";
    if (ignoreControl == null) {
      // A Ctrl+C in Reach's console while attached must not end this helper.
      ignoreControl = kind => true;
      Native.SetConsoleCtrlHandler(ignoreControl, true);
    }
    if (!Native.AttachConsole((uint)reachPid)) {
      reachConsole = Marshal.GetLastWin32Error() == Native.ERROR_INVALID_HANDLE && !reachHasConsole ? "none" : "unknown";
      return;
    }
    try {
      IntPtr window = Native.GetConsoleWindow();
      string kind = ClassOf(window);
      if (kind == "ConsoleWindowClass") { reachConsole = "classic"; reachConsoleWindow = window; }
      else if (kind == "PseudoConsoleWindow") reachConsole = "pseudo";
    } finally {
      Native.FreeConsole();
    }
  }

  static string ClassOf(IntPtr window) {
    if (window == IntPtr.Zero) return "";
    var name = new StringBuilder(260);
    int length = Native.GetClassNameW(window, name, name.Capacity);
    return length > 0 ? name.ToString(0, length) : "";
  }

  // --- Displays (§4.4) ------------------------------------------------------
  // Each monitor in physical pixels of the virtual screen; its id a stable
  // FNV-1a hash of its device's interface path. Chosen per request; element
  // and snapshot references remember theirs.
  sealed class Monitor { public uint Id; public bool Main; public Native.RECT Rect; }
  static uint? selectedDisplay;

  static List<Monitor> Monitors() {
    var found = new List<Monitor>();
    var devices = new List<string>();
    Native.MonitorEnumProc each = (IntPtr handle, IntPtr dc, ref Native.RECT rect, IntPtr data) => {
      var info = new Native.MONITORINFOEX();
      info.cbSize = Marshal.SizeOf(typeof(Native.MONITORINFOEX));
      if (Native.GetMonitorInfoW(handle, ref info)) {
        found.Add(new Monitor { Main = (info.dwFlags & Native.MONITORINFOF_PRIMARY) != 0, Rect = info.rcMonitor });
        devices.Add(info.szDevice ?? "");
      }
      return true;
    };
    Native.EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, each, IntPtr.Zero);
    GC.KeepAlive(each);
    var ids = new HashSet<uint>();
    for (int i = 0; i < found.Count; i++) {
      var device = new Native.DISPLAY_DEVICE();
      device.cb = Marshal.SizeOf(typeof(Native.DISPLAY_DEVICE));
      string path = Native.EnumDisplayDevicesW(devices[i], 0, ref device, Native.EDD_GET_DEVICE_INTERFACE_NAME) && !string.IsNullOrEmpty(device.DeviceID)
        ? device.DeviceID : devices[i];
      found[i].Id = MonitorId(path);
      if (!ids.Add(found[i].Id)) throw new Refusal("Two displays look the same to Windows right now. List displays again.", "unavailable");
    }
    return found;
  }
  public static uint MonitorId(string path) {
    uint hash = 2166136261;
    foreach (byte b in Encoding.UTF8.GetBytes(path.ToLowerInvariant())) { hash ^= b; hash = unchecked(hash * 16777619); }
    return hash == 0 ? 1 : hash;
  }

  static Dictionary<string, object> Displays() {
    var list = new List<object>();
    foreach (var monitor in Monitors()) {
      var entry = new Dictionary<string, object>();
      entry["id"] = monitor.Id;
      entry["main"] = monitor.Main;
      entry["x"] = monitor.Rect.Left;
      entry["y"] = monitor.Rect.Top;
      entry["width"] = monitor.Rect.Right - monitor.Rect.Left;
      entry["height"] = monitor.Rect.Bottom - monitor.Rect.Top;
      list.Add(entry);
    }
    var result = Ok();
    result["displays"] = list;
    return result;
  }

  // A display id in a request (or its reference's): that monitor, or a
  // refusal; never silently another one after it was unplugged.
  static void ChooseDisplay(object value) {
    selectedDisplay = null;
    if (!(value is double)) return;
    double id = (double)value;
    if (!(id >= 1 && id <= uint.MaxValue && Math.Floor(id) == id) || MonitorById((uint)id) == null)
      throw new Refusal("That display is disconnected. List displays again.", "retry");
    selectedDisplay = (uint)id;
  }
  static Monitor MonitorById(uint id) {
    foreach (var monitor in Monitors()) if (monitor.Id == id) return monitor;
    return null;
  }
  // The chosen monitor, else the main one.
  static Monitor Display() {
    var all = Monitors();
    if (selectedDisplay.HasValue) foreach (var monitor in all) if (monitor.Id == selectedDisplay.Value) return monitor;
    foreach (var monitor in all) if (monitor.Main) return monitor;
    if (all.Count > 0) return all[0];
    throw new Refusal("No screen to show.", "unavailable");
  }
  // Where an element or snapshot reference was seen (set by the reads).
  static object RememberedDisplay(Dictionary<string, object> action) {
    return action == null ? null : RememberedDisplayOf(action);
  }

  // --- Who a window belongs to (§7.1) ---------------------------------------
  // A process as the rules judge it, read fresh each time: never remembered
  // by its id, which Windows gives to another process once it ends. A Store
  // app (a package) by its id, only when its program lies in its package's
  // own folder; any other program by its path, exe:<file> its bundle.
  const string UnknownReason = "That window belongs to a program Reach can't identify. The agent leaves it alone.";
  const string UnreadableTitleReason = "Reach can't read that window's title, so the agent leaves it alone.";
  const string SecureDesktopReason = "An administrator prompt, the lock screen or the sign-in screen is up on the PC. The agent waits; the owner answers it at the PC.";

  static Ident Identify(int pid) {
    var id = new Ident { Pid = pid };
    if (pid <= 0) return id;
    IntPtr process = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (process == IntPtr.Zero) return id;
    try {
      long created, ignored;
      if (!Native.GetProcessTimes(process, out created, out ignored, out ignored, out ignored)) return id;
      id.Created = created;
      string image = ImagePath(process);
      if (image == null) return id;
      id.Image = image;
      id.Integrity = IntegrityOf(process);
      var package = new StringBuilder(1024);
      uint length = (uint)package.Capacity;
      int packaged = Native.GetPackageFullName(process, ref length, package);
      if (packaged == 0) {
        // In a package's context: its program must be the package's own.
        if (!InPackage(package.ToString(), image)) return id;
        var app = new StringBuilder(1024);
        uint appLength = (uint)app.Capacity;
        string aumid = Native.GetApplicationUserModelId(process, ref appLength, app) == 0 ? app.ToString() : "";
        id.Packaged = true;
        id.Bundle = aumid;
        id.Path = aumid.Length > 0 ? aumid : image;
      } else if (packaged == Native.APPMODEL_ERROR_NO_PACKAGE) {
        id.Bundle = "exe:" + FileOf(image).ToLowerInvariant();
        id.Path = image;
      } else return id;
      id.Name = Description(image);
      id.Known = true;
      return id;
    } catch (Exception) {
      return new Ident { Pid = pid };
    } finally {
      Native.CloseHandle(process);
    }
  }
  static string ImagePath(IntPtr process) {
    var name = new StringBuilder(32768);
    int size = name.Capacity;
    if (!Native.QueryFullProcessImageNameW(process, 0, name, ref size) || size <= 0) return null;
    string path = name.ToString(0, size);
    var full = new StringBuilder(32768);
    int got = Native.GetLongPathNameW(path, full, full.Capacity);
    return got > 0 && got < full.Capacity ? full.ToString(0, got) : path;
  }
  public static string FileOf(string path) {
    string[] names = (path ?? "").Split('\\', '/');
    return names[names.Length - 1];
  }
  // Inside a folder, by whole names, whatever their letters' case.
  public static bool Within(string path, string folder) {
    if (string.IsNullOrEmpty(path) || string.IsNullOrEmpty(folder)) return false;
    string root = folder.TrimEnd('\\') + "\\";
    return path.StartsWith(root, StringComparison.OrdinalIgnoreCase);
  }
  static bool InPackage(string fullName, string image) {
    var folder = new StringBuilder(32768);
    uint length = (uint)folder.Capacity;
    if (Native.GetPackagePathByFullName(fullName, ref length, folder) == 0 && Within(image, folder.ToString())) return true;
    try {
      // The effective folder of a package that has one (Windows 10 1903 and later).
      folder.Length = 0;
      length = (uint)folder.Capacity;
      if (Native.GetPackagePathByFullName2(fullName, Native.PackagePathType_Effective, ref length, folder) == 0 && Within(image, folder.ToString())) return true;
    } catch (EntryPointNotFoundException) { }
    return false;
  }
  // A program's own name (its version resource's description), else its file's.
  static readonly Dictionary<string, string> descriptions = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
  static string Description(string image) {
    string key;
    try { key = image + "|" + File.GetLastWriteTimeUtc(image).Ticks.ToString(CultureInfo.InvariantCulture); } catch (Exception) { key = image; }
    lock (descriptions) {
      string known;
      if (descriptions.TryGetValue(key, out known)) return known;
    }
    string name = "";
    try { name = (System.Diagnostics.FileVersionInfo.GetVersionInfo(image).FileDescription ?? "").Trim(); } catch (Exception) { }
    if (name.Length == 0) { name = FileOf(image); if (name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) name = name.Substring(0, name.Length - 4); }
    lock (descriptions) {
      if (descriptions.Count > 512) descriptions.Clear();
      descriptions[key] = name;
    }
    return name;
  }
  // The program's signer, verified by Windows from its cache only (nothing
  // fetched), within half a second; unknown otherwise. Only asked for when the
  // rules name publishers.
  static readonly Dictionary<string, string> publishers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
  static string PublisherOf(string image, out bool known) {
    known = false;
    string key;
    try {
      var file = new FileInfo(image);
      key = image + "|" + file.Length.ToString(CultureInfo.InvariantCulture) + "|" + file.LastWriteTimeUtc.Ticks.ToString(CultureInfo.InvariantCulture);
    } catch (Exception) {
      return "";
    }
    lock (publishers) {
      string cached;
      if (publishers.TryGetValue(key, out cached)) { known = true; return cached; }
    }
    var check = System.Threading.Tasks.Task.Factory.StartNew(() => Signer(image));
    if (!check.Wait(500) || check.Result == null) return "";
    known = true;
    lock (publishers) {
      if (publishers.Count > 512) publishers.Clear();
      publishers[key] = check.Result;
    }
    return check.Result;
  }
  // "" for an unsigned program; null when Windows wouldn't say.
  static string Signer(string image) {
    var path = Marshal.StringToHGlobalUni(image);
    var fileInfo = new Native.WINTRUST_FILE_INFO { cbStruct = (uint)Marshal.SizeOf(typeof(Native.WINTRUST_FILE_INFO)), pcwszFilePath = path };
    IntPtr filePointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Native.WINTRUST_FILE_INFO)));
    try {
      Marshal.StructureToPtr(fileInfo, filePointer, false);
      var data = new Native.WINTRUST_DATA {
        cbStruct = (uint)Marshal.SizeOf(typeof(Native.WINTRUST_DATA)), dwUIChoice = Native.WTD_UI_NONE, fdwRevocationChecks = Native.WTD_REVOKE_NONE,
        dwUnionChoice = Native.WTD_CHOICE_FILE, pFile = filePointer, dwStateAction = Native.WTD_STATEACTION_VERIFY,
        dwProvFlags = Native.WTD_CACHE_ONLY_URL_RETRIEVAL | Native.WTD_REVOCATION_CHECK_NONE,
      };
      Guid action = Native.WINTRUST_ACTION_GENERIC_VERIFY_V2;
      int result = Native.WinVerifyTrust(IntPtr.Zero, ref action, ref data);
      data.dwStateAction = Native.WTD_STATEACTION_CLOSE;
      Native.WinVerifyTrust(IntPtr.Zero, ref action, ref data);
      if (result == Native.TRUST_E_NOSIGNATURE || result == Native.TRUST_E_SUBJECT_FORM_UNKNOWN || result == Native.TRUST_E_PROVIDER_UNKNOWN) return "";
      if (result != 0) return null;
      var certificate = new System.Security.Cryptography.X509Certificates.X509Certificate2(System.Security.Cryptography.X509Certificates.X509Certificate.CreateFromSignedFile(image));
      return certificate.GetNameInfo(System.Security.Cryptography.X509Certificates.X509NameType.SimpleName, false) ?? "";
    } catch (Exception) {
      return null;
    } finally {
      Marshal.FreeHGlobal(filePointer);
      Marshal.FreeHGlobal(path);
    }
  }

  // What an app may be to the agent (appReason), with Windows' checks: an
  // identity that couldn't be verified, a publisher the rules name, and a
  // Store app's own program by its file name.
  static string AppVerdict(Ident id, Rules rules) {
    if (rules.Mode == "full") return null;
    if (id == null || !id.Known) return UnknownReason;
    string publisher = "";
    if (rules.ProtectedPublishers.Count > 0) {
      bool known;
      publisher = PublisherOf(id.Image, out known);
      if (!known) return Policy.ProtectedReason;
    }
    string reason = Policy.AppReason(id.Bundle, id.Name, id.Path, rules, publisher);
    if (reason == null && id.Packaged) reason = Policy.ProtectedApp("", "", id.Image, rules);
    return reason;
  }
  static readonly string[] BrowserFiles = { "chrome.exe", "msedge.exe", "firefox.exe", "brave.exe", "opera.exe", "vivaldi.exe", "arc.exe" };
  static readonly string[] BrowserPackages = { "thebrowsercompany.arc_", "mozilla.firefox_", "duckduckgo.desktopbrowser_" };
  public static bool IsBrowser(Ident id) {
    if (id == null) return false;
    string file = FileOf(id.Image).ToLowerInvariant(), bundle = (id.Bundle ?? "").ToLowerInvariant();
    if (System.Array.IndexOf(BrowserFiles, file) >= 0 || System.Array.IndexOf(BrowserFiles, bundle.StartsWith("exe:", StringComparison.Ordinal) ? bundle.Substring(4) : "") >= 0) return true;
    foreach (string package in BrowserPackages) if (bundle.StartsWith(package, StringComparison.Ordinal)) return true;
    return false;
  }

  // --- Windows, as Windows lists them (§4.3) ----------------------------------
  static readonly string[] TerminalClasses = { "ConsoleWindowClass", "PseudoConsoleWindow", "CASCADIA_HOSTING_WINDOW_CLASS", "mintty" };
  static readonly string[] OverlayClasses = { "MultitaskingViewFrame", "XamlExplorerHostIslandWindow", "TaskListThumbnailWnd", "ForegroundStaging" };
  static readonly string[] ShellHosts = { "startmenuexperiencehost.exe", "searchhost.exe", "searchapp.exe", "shellexperiencehost.exe", "shellhost.exe", "widgets.exe",
    "textinputhost.exe", "lockapp.exe" };
  static string windowsFolder;
  static string WindowsFolder() {
    if (windowsFolder == null) windowsFolder = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
    return windowsFolder;
  }
  static bool SystemProgram(string image) {
    return Within(image, WindowsFolder()) || Within(image, Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "WindowsApps"));
  }

  // A window's title, read from the window itself (a captionless one too).
  // Unreadable: the window went away while it was read.
  static string TitleOf(IntPtr window, out bool readable) {
    var text = new StringBuilder(1024);
    int length = Native.InternalGetWindowText(window, text, text.Capacity);
    readable = length > 0 || Native.IsWindow(window);
    return length > 0 ? text.ToString(0, Math.Min(length, text.Length)) : "";
  }

  static uint ExStyleOf(IntPtr window) {
    return IntPtr.Size == 8 ? (uint)Native.GetWindowLongPtrW(window, Native.GWL_EXSTYLE).ToInt64() : (uint)Native.GetWindowLongW(window, Native.GWL_EXSTYLE);
  }

  // One window, read: who it belongs to (an ApplicationFrameHost frame by
  // the app inside it), where it is, how it's drawn, its title.
  static Win Read(IntPtr handle, Dictionary<long, Ident> identities) {
    var w = new Win { Handle = handle.ToInt64(), Class = ClassOf(handle) };
    uint pid;
    Native.GetWindowThreadProcessId(handle, out pid);
    if (w.Class == "ApplicationFrameWindow") {
      IntPtr core = Native.FindWindowExW(handle, IntPtr.Zero, "Windows.UI.Core.CoreWindow", null);
      uint inner = 0;
      if (core != IntPtr.Zero) Native.GetWindowThreadProcessId(core, out inner);
      pid = inner;
    }
    w.Pid = (int)pid;
    w.Visible = Native.IsWindowVisible(handle);
    w.Iconic = Native.IsIconic(handle);
    int cloaked;
    w.Cloaked = Native.DwmGetWindowAttribute(handle, Native.DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0;
    Native.RECT frame;
    if (Native.DwmGetWindowAttribute(handle, Native.DWMWA_EXTENDED_FRAME_BOUNDS, out frame, Marshal.SizeOf(typeof(Native.RECT))) == 0 || Native.GetWindowRect(handle, out frame)) {
      w.Frame = new Box(frame.Left, frame.Top, frame.Right, frame.Bottom);
      w.FrameRead = true;
    }
    Native.RECT region;
    w.HasRegion = Native.GetWindowRgnBox(handle, out region) != 0;
    w.ExStyle = ExStyleOf(handle);
    if ((w.ExStyle & Native.WS_EX_LAYERED) != 0) {
      uint key, flags;
      byte alpha;
      w.LayeredRead = Native.GetLayeredWindowAttributes(handle, out key, out alpha, out flags);
      if (w.LayeredRead) { w.LayeredFlags = flags; w.Alpha = (flags & Native.LWA_ALPHA) != 0 ? alpha : (byte)255; }
    }
    int backdrop;
    w.Backdrop = Native.DwmGetWindowAttribute(handle, Native.DWMWA_SYSTEMBACKDROP_TYPE, out backdrop, 4) == 0 ? backdrop : -1;
    w.Owner = Native.GetWindow(handle, Native.GW_OWNER).ToInt64();
    try { w.Scale = Math.Max(1.0, Native.GetDpiForWindow(handle) / 96.0); } catch (EntryPointNotFoundException) { w.Scale = 1; }
    bool readable;
    w.Title = TitleOf(handle, out readable);
    w.TitleRead = readable;
    if (w.Visible && !w.Cloaked && !w.Iconic) {
      Ident id;
      long key = ((long)w.Pid << 32) ^ ProcessCreated(w.Pid);
      if (!identities.TryGetValue(key, out id)) { id = Identify(w.Pid); identities[key] = id; }
      w.Id = id;
    } else w.Id = new Ident { Pid = w.Pid };
    return w;
  }
  static long ProcessCreated(int pid) {
    IntPtr process = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (process == IntPtr.Zero) return 0;
    try {
      long created, ignored;
      return Native.GetProcessTimes(process, out created, out ignored, out ignored, out ignored) ? created : 0;
    } finally {
      Native.CloseHandle(process);
    }
  }

  // Both walks Windows offers, top to bottom; a walk that revisits a window
  // (they moved while it ran) or passes 4096 is taken again once, then the
  // inventory is incomplete and the picture black.
  static bool WalkEnum(List<IntPtr> found) {
    var seen = new HashSet<long>();
    bool ok = true;
    Native.EnumWindowsProc each = (window, data) => {
      if (!seen.Add(window.ToInt64()) || found.Count >= 4096) { ok = false; return false; }
      found.Add(window);
      return true;
    };
    Native.EnumWindows(each, IntPtr.Zero);
    GC.KeepAlive(each);
    return ok;
  }
  static bool WalkFind(List<IntPtr> found) {
    var seen = new HashSet<long>();
    IntPtr window = IntPtr.Zero;
    while ((window = Native.FindWindowExW(IntPtr.Zero, window, null, null)) != IntPtr.Zero) {
      if (!seen.Add(window.ToInt64()) || found.Count >= 4096) return false;
      found.Add(window);
    }
    return true;
  }
  static Inventory TakeInventory(Rules rules, Dictionary<long, Ident> identities) {
    for (int attempt = 0; attempt < 2; attempt++) {
      var first = new List<IntPtr>();
      var second = new List<IntPtr>();
      if (!WalkEnum(first) || !WalkFind(second)) continue;
      var inventory = new Inventory();
      var index = new Dictionary<long, Win>();
      for (int i = 0; i < first.Count; i++) {
        var w = Read(first[i], identities);
        w.InL1 = true;
        w.L1Index = i;
        if (!index.ContainsKey(w.Handle)) { index[w.Handle] = w; inventory.Windows.Add(w); }
      }
      foreach (IntPtr handle in second) {
        Win known;
        if (index.TryGetValue(handle.ToInt64(), out known)) { known.InL2 = true; continue; }
        var w = Read(handle, identities);
        w.InL2 = true;
        index[w.Handle] = w;
        inventory.Windows.Add(w);
      }
      foreach (var w in inventory.Windows) {
        if (w.Shows && !w.FrameRead) inventory.Complete = false;
        Decide(w, rules, index);
      }
      if (inventory.Complete) return inventory;
    }
    return new Inventory { Complete = false };
  }

  // Explorer the app is its folder windows and what they own; every other
  // Explorer window (the taskbar, the desktop, Start's parts) is the shell.
  static bool ExplorerFolder(Win w, Dictionary<long, Win> index) {
    for (int depth = 0; w != null && depth < 8; depth++) {
      if (w.Class == "CabinetWClass") return true;
      Win owner;
      if (w.Owner == 0 || !index.TryGetValue(w.Owner, out owner)) return false;
      w = owner;
    }
    return false;
  }
  static bool IsReachConsole(long handle) { return reachConsole == "classic" && reachConsoleWindow.ToInt64() == handle; }

  // Every decision about one window, from what was read (§4.3 step 2, §7).
  static void Decide(Win w, Rules rules, Dictionary<long, Win> index) {
    var id = w.Id ?? new Ident();
    string file = FileOf(id.Image).ToLowerInvariant();
    bool explorer = file == "explorer.exe" && SystemProgram(id.Image);
    w.Explorer = explorer && ExplorerFolder(w, index);
    w.Shell = id.Known && ((explorer && !w.Explorer) || (System.Array.IndexOf(ShellHosts, file) >= 0 && SystemProgram(id.Image)));
    w.Overlay = (explorer || w.Shell) && System.Array.IndexOf(OverlayClasses, w.Class) >= 0;
    bool immersive = w.Class.StartsWith("Windows.UI.", StringComparison.Ordinal) || w.Class.IndexOf("Xaml", StringComparison.Ordinal) >= 0 || w.Class.IndexOf("Island", StringComparison.Ordinal) >= 0;
    // The desktop itself (Progman, WorkerW) is the shell too, but always at
    // the bottom: in the top band it would black out every chosen window.
    bool desktop = explorer && (w.Class == "Progman" || w.Class == "WorkerW");
    w.Top = !w.InL1 || (w.ExStyle & Native.WS_EX_TOPMOST) != 0 || (w.Shell && !desktop) || immersive;
    w.Terminal = System.Array.IndexOf(TerminalClasses, w.Class) >= 0 || (id.Known && Policy.TerminalLikeApp(id.Bundle, id.Name, id.Path, rules));
    if (rules.Mode == "full") { w.Allowed = true; return; }
    w.Reach = IsReachConsole(w.Handle) || Policy.TitleReason(w.Title, id.Bundle, rules) == Policy.ReachReason;
    w.Reason = Verdict(w, rules, true);
    w.Excluded = w.Reason != null || w.Overlay;
    w.Allowed = rules.Mode == "apps" && !w.Excluded && !w.Shell && Policy.AppReason(id.Bundle, id.Name, id.Path, rules) == null;
  }
  // Why a window is closed to the agent, or null. look: as a screenshot sees
  // it (Apps' not-chosen apps aren't "closed", only left out).
  static Rules viewRules;
  static string Verdict(Win w, Rules rules, bool look) {
    if (rules.Mode == "full") return null;
    var id = w.Id ?? new Ident();
    Rules judged = rules;
    if (look && rules.Mode == "apps") {
      if (viewRules == null || viewRules.HiddenApps != rules.HiddenApps) { viewRules = rules.Copy(); viewRules.Mode = "view"; }
      judged = viewRules;
    }
    string reason = AppVerdict(id, judged);
    if (reason != null) return reason;
    if (w.Reach) return Policy.ReachReason;
    reason = TitleVerdict(w.Title, id.Bundle, w.Handle, w.Explorer, rules);
    if (reason != null) return reason;
    if ((IsBrowser(id) || w.Terminal) && (!w.TitleRead || w.Title.Length == 0)) return UnreadableTitleReason;
    return null;
  }
  // A title as the rules judge it (§7.4): Settings' window is titled only
  // "Settings", so the page it shows is part of its title (closed when that
  // can't be read); a File Explorer window is also judged as Control Panel
  // when it shows Control Panel or its place can't be read.
  static string TitleVerdict(string title, string bundle, long root, bool explorer, Rules rules) {
    if (Policy.SettingsApp(bundle)) {
      string page = SettingsPage(new IntPtr(root));
      if (page == null) return Policy.ProtectedReason;
      return Policy.TitleReason(title + " " + EmDash + " " + page, bundle, rules);
    }
    string reason = Policy.TitleReason(title, bundle, rules);
    if (reason != null) return reason;
    if (explorer) {
      string place = ExplorerPlace(new IntPtr(root));
      if (place == null || ControlPanelPlace(place)) return Policy.TitleReason(title, "windows.controlpanel", rules);
    }
    return null;
  }
  static readonly string EmDash = ((char)0x2014).ToString();
  static bool ControlPanelPlace(string place) {
    return place.StartsWith("::{26EE0668-A00A-44D7-9371-BEB064C98683}", StringComparison.OrdinalIgnoreCase) ||
      place.StartsWith("::{21EC2020-3AEA-1069-A2DD-08002B30309D}", StringComparison.OrdinalIgnoreCase);
  }
  // The page Settings shows (UI Automation): null until it can be read.
  static string SettingsPage(IntPtr window) { return SettingsPageNow(window); }
  // Where a File Explorer window is (the shell): null until it can be read.
  static readonly Dictionary<long, KeyValuePair<DateTime, string>> places = new Dictionary<long, KeyValuePair<DateTime, string>>();
  static string ExplorerPlace(IntPtr window) { return View.ExplorerPlace(window.ToInt64()); }
  internal static string ExplorerPlaceCached(IntPtr window) {
    KeyValuePair<DateTime, string> known;
    if (places.TryGetValue(window.ToInt64(), out known) && (DateTime.UtcNow - known.Key).TotalSeconds < 1) return known.Value;
    string place = ExplorerPlaceNow(window);
    if (places.Count > 256) places.Clear();
    places[window.ToInt64()] = new KeyValuePair<DateTime, string>(DateTime.UtcNow, place);
    return place;
  }

  // --- A screenshot (§4.3) ------------------------------------------------------
  // Full control: the screen as it is. View: every window closed to the agent
  // painted black. Apps: black, with only the chosen apps' windows painted
  // back. The windows are listed before and after the picture is taken; if
  // anything changed meanwhile it's taken again, and after three tries, or
  // when Windows wouldn't list them all, the whole display is black.
  public static bool StrictMasks = false;
  static Dictionary<string, object> Shot(Rules rules, int maxWidth) {
    if (InputDesktopName() != "Default") throw new Refusal(SecureDesktopReason, "paused");
    var monitor = Display();
    var screen = new Box(monitor.Rect.Left, monitor.Rect.Top, monitor.Rect.Right, monitor.Rect.Bottom);
    if (screen.Empty) throw new Refusal("No screen to show.", "unavailable");
    var identities = new Dictionary<long, Ident>();
    var looks = new List<Inventory>();
    var frame = Settle(() => CaptureScreen(screen), () => TakeInventory(rules, identities), () => Thread.VolatileRead(ref windowRevision), rules.Mode != "full", looks, (old) => old.Dispose());
    int hidden = 0;
    try {
      using (var graphics = Graphics.FromImage(frame.Picture)) {
        if (rules.Mode != "full") {
          var black = Masks.Black(rules.Mode, screen, frame.Settled ? looks : null, StrictMasks, out hidden);
          foreach (var box in black.Boxes) graphics.FillRectangle(Brushes.Black, box.Left - screen.Left, box.Top - screen.Top, box.Width, box.Height);
        }
        DrawCursor(graphics, screen);
        Redact(graphics, screen, rules);
      }
      int width, height;
      string jpeg = Jpeg(frame.Picture, maxWidth, out width, out height);
      var result = Ok();
      result["jpeg"] = jpeg;
      result["width"] = width;
      result["height"] = height;
      result["hidden"] = hidden;
      result["displayId"] = monitor.Id;
      result["displayWidth"] = screen.Width;
      result["displayHeight"] = screen.Height;
      return result;
    } finally {
      frame.Picture.Dispose();
    }
  }
  // The picture and the lists around it, until they agree (at most three
  // pictures). Settled false: they never did, or a list was incomplete.
  public sealed class Taken<T> { public T Picture; public bool Settled; }
  public static Taken<T> Settle<T>(Func<T> capture, Func<Inventory> inventory, Func<int> revision, bool looking, List<Inventory> looks, Action<T> discard) {
    var result = new Taken<T>();
    if (!looking) { result.Picture = capture(); result.Settled = true; return result; }
    for (int attempt = 0; attempt < 3; attempt++) {
      var before = inventory();
      int moved = revision();
      if (attempt > 0) discard(result.Picture);
      result.Picture = capture();
      var after = inventory();
      looks.Add(before);
      looks.Add(after);
      if (!before.Complete || !after.Complete) return result;
      if (moved == revision() && Inventory.Same(before, after)) { result.Settled = true; return result; }
    }
    return result;
  }
  // BitBlt itself: the .NET Framework's CopyFromScreen refuses CaptureBlt,
  // which layered windows need to be in the picture.
  static Bitmap CaptureScreen(Box screen) {
    var bitmap = new Bitmap(screen.Width, screen.Height, PixelFormat.Format32bppRgb);
    bool copied = false;
    try {
      using (var graphics = Graphics.FromImage(bitmap)) {
        IntPtr target = graphics.GetHdc(), source = Native.GetDC(IntPtr.Zero);
        try {
          copied = source != IntPtr.Zero && Native.BitBlt(target, 0, 0, screen.Width, screen.Height, source, screen.Left, screen.Top, Native.SRCCOPY | Native.CAPTUREBLT);
        } finally {
          if (source != IntPtr.Zero) Native.ReleaseDC(IntPtr.Zero, source);
          graphics.ReleaseHdc(target);
        }
      }
    } catch (Exception) {
      copied = false;
    }
    if (copied) return bitmap;
    bitmap.Dispose();
    throw new Refusal("Windows won't let Reach see the screen right now. Keep the PC signed in and unlocked.", "unavailable");
  }
  static void DrawCursor(Graphics graphics, Box screen) {
    var info = new Native.CURSORINFO();
    info.cbSize = Marshal.SizeOf(typeof(Native.CURSORINFO));
    if (!Native.GetCursorInfo(ref info) || (info.flags & Native.CURSOR_SHOWING) == 0 || info.hCursor == IntPtr.Zero) return;
    int hotX = 0, hotY = 0;
    Native.ICONINFO icon;
    if (Native.GetIconInfo(info.hCursor, out icon)) {
      hotX = (int)icon.xHotspot;
      hotY = (int)icon.yHotspot;
      if (icon.hbmMask != IntPtr.Zero) Native.DeleteObject(icon.hbmMask);
      if (icon.hbmColor != IntPtr.Zero) Native.DeleteObject(icon.hbmColor);
    }
    IntPtr dc = graphics.GetHdc();
    try {
      Native.DrawIconEx(dc, info.ptScreenPos.X - screen.Left - hotX, info.ptScreenPos.Y - screen.Top - hotY, info.hCursor, 0, 0, 0, IntPtr.Zero, Native.DI_NORMAL);
    } finally {
      graphics.ReleaseHdc(dc);
    }
  }
  // The display's own pixels, up to maxWidth wide, as a JPEG at quality 70
  // (the Mac's compression factor 0.7), under 6 MiB.
  static string Jpeg(Bitmap frame, int maxWidth, out int width, out int height) {
    double scale = Math.Min(1.0, (double)maxWidth / frame.Width);
    width = Math.Max(1, (int)Math.Round(frame.Width * scale));
    height = Math.Max(1, (int)Math.Round(frame.Height * scale));
    Bitmap scaled = frame;
    if (width != frame.Width || height != frame.Height) {
      scaled = new Bitmap(width, height, PixelFormat.Format24bppRgb);
      using (var graphics = Graphics.FromImage(scaled)) {
        graphics.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
        graphics.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
        graphics.DrawImage(frame, 0, 0, width, height);
      }
    }
    try {
      ImageCodecInfo codec = null;
      foreach (var candidate in ImageCodecInfo.GetImageEncoders()) if (candidate.MimeType == "image/jpeg") codec = candidate;
      if (codec == null) throw new Refusal("The screen couldn't be encoded.", "unavailable");
      var parameters = new EncoderParameters(1);
      parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 70L);
      using (var stream = new MemoryStream()) {
        scaled.Save(stream, codec, parameters);
        if (stream.Length >= 6 * 1024 * 1024) throw new Refusal("The screen couldn't be encoded.", "unavailable");
        return Convert.ToBase64String(stream.GetBuffer(), 0, (int)stream.Length);
      }
    } finally {
      if (!ReferenceEquals(scaled, frame)) scaled.Dispose();
    }
  }

  // --- What is in front (§8.4) ---------------------------------------------------
  // For the owner's "using X" line and for the server's check of typed text
  // (a terminal takes commands). An app the owner hid: not even its name.
  static Dictionary<string, object> Front(Rules rules, bool detail) {
    var result = Ok();
    var w = View.Foreground(rules);
    if (w == null) { result["app"] = ""; result["bundle"] = ""; return result; }
    // The focused element, when it's this window's: its page and whether it takes a password.
    Seen focused = View.Focused();
    if (focused != null && focused.Pid != w.Pid) focused = null;
    string url = focused != null ? focused.Url : "";
    string blocked = Verdict(w, rules, false) ?? Policy.UrlReason(url, rules);
    if (blocked == Policy.HiddenReason) {
      result["app"] = ""; result["bundle"] = ""; result["title"] = ""; result["terminalLike"] = false; result["secure"] = false;
      result["blocked"] = Policy.HiddenReason; result["path"] = ""; result["layout"] = "";
      return result;
    }
    var monitor = Display();
    var screen = monitor.Rect;
    string layout = (screen.Right - screen.Left).ToString(CultureInfo.InvariantCulture) + "," + (screen.Bottom - screen.Top).ToString(CultureInfo.InvariantCulture);
    Func<Box, string> geometry = box => box.Left.ToString(CultureInfo.InvariantCulture) + "," + box.Top.ToString(CultureInfo.InvariantCulture) + "," +
      box.Width.ToString(CultureInfo.InvariantCulture) + "," + box.Height.ToString(CultureInfo.InvariantCulture);
    if (w.FrameRead) layout += "|" + geometry(w.Frame);
    if (focused != null) layout += "|" + geometry(focused.Frame) + "|" + focused.Role + "|" + focused.AutomationId;
    var id = w.Id ?? new Ident();
    result["app"] = id.Name;
    result["bundle"] = id.Bundle;
    result["title"] = blocked == null ? Limit(w.Title, 200) : "";
    result["terminalLike"] = w.Terminal;
    result["secure"] = focused != null && focused.Secure;
    result["blocked"] = blocked ?? "";
    result["path"] = id.Path;
    result["layout"] = Limit(layout, 2000);
    // Asked for: a browser's page and tabs, so the agent needn't describe the screen to know where it is.
    if (detail && blocked == null && rules.Mode != "view" && uiaReady && IsBrowser(id)) {
      string page = WindowPage(w, rules);
      if (page.Length > 0) result["url"] = page;
      var tabs = TabList(w, rules, 30);
      if (tabs.Count > 0) result["tabs"] = tabs;
    }
    return result;
  }
  public static string Limit(string text, int length) {
    if (text == null) return "";
    if (text.Length <= length) return text;
    // Never half of a surrogate pair.
    int cut = char.IsHighSurrogate(text[length - 1]) ? length - 1 : length;
    return text.Substring(0, cut);
  }

  // --- Held input (§5.4) ----------------------------------------------------
  // What this helper holds down between a press and its release: buttons (at
  // the last point it sent for them) and keys. Stopped mid-click or mid-drag,
  // it lets go of them where it held them before exiting, so the owner never
  // inherits a held button. Once stopping, nothing more is sent.
  static readonly object heldLock = new object();
  internal static bool stopping;
  internal static readonly Dictionary<int, Native.POINT> heldButtons = new Dictionary<int, Native.POINT>();
  internal static readonly HashSet<ushort> heldKeys = new HashSet<ushort>();

  // --- Input (§5) -------------------------------------------------------------
  internal static IDesktopView View = new WindowsView();
  internal static IInput Input = new WindowsInput();
  internal static IClip Clip = new WindowsClip();
  const string ChangedReason = "The window at this point changed while it was checked. Look again.";
  const string AdminWindowReason = "That window runs as administrator. Windows keeps other programs' clicks and keys out of it, so the agent leaves it to you at the PC.";
  const string ElevatedFrontReason = "A window running as administrator is in front on the PC. Windows hides the keyboard from Reach while it is, so the agent waits until the owner switches away from it.";
  const string HeldKeyReason = "A key or button is held down on the PC. The agent's input would mix with it. Try again in a moment.";
  const string ElevatedReachReason = "Reach is running as administrator (or User Account Control is off). Agents act only from a standard Reach session.";
  const string CommandFieldReason = "That box runs programs on the PC. Open folders by clicking them, or use open_file with reveal.";
  const string ShutDownReason = "The PC's shut-down and sign-out stay with the owner.";
  // What the agent never switches from the taskbar or Quick Settings: the
  // network Reach answers through and who may reach this PC.
  static readonly string[] SystemGuardedWords = { "wi-fi", "wifi", "vpn", "network", "ethernet", "firewall", "sharing", "airplane" };
  const string SystemGuardedReason = "That control can cut Reach's connection or change who reaches this Windows PC. It stays with the owner.";

  // Rule S: Reach itself elevated (or UAC off) gives the agent no input at all.
  internal static void RuleS() {
    if (ownIntegrity < 0 || ownIntegrity >= HighIntegrity) throw new Refusal(ElevatedReachReason, "blocked");
  }
  // Rule T: Windows keeps a lower program's input out of an elevated one, and
  // says nothing; such a target is refused with the reason (§5.3).
  static void RuleT(Ident id) {
    if (id == null || !id.Known) return;
    if (id.Integrity < 0) throw new Refusal(UnknownReason, "blocked");
    if (id.Integrity >= HighIntegrity || id.Integrity > ownIntegrity) throw new Refusal(AdminWindowReason, "blocked");
  }

  static Seen SeenOf(Win w) {
    var id = w.Id ?? new Ident { Pid = w.Pid };
    return new Seen { Bundle = id.Bundle, Name = id.Name, Path = id.Path, Title = w.Title, TitleRead = w.TitleRead, Pid = w.Pid, Id = id, Root = w.Handle,
      Class = w.Class, Shell = w.Shell, Terminal = w.Terminal, Reach = w.Reach, Explorer = w.Explorer };
  }
  // check(): the app, Reach's own windows, the title, the page.
  static void CheckSeen(Seen s, Rules rules) {
    if (rules.Mode == "full") return;
    string reason = AppVerdict(s.Id, rules);
    if (reason == null && s.Reach) reason = Policy.ReachReason;
    if (reason == null) reason = TitleVerdict(s.Title, s.Bundle, s.Root, s.Explorer, rules);
    if (reason == null) reason = Policy.UrlReason(s.Url, rules);
    if (reason == null && (IsBrowser(s.Id) || s.Terminal) && (!s.TitleRead || s.Title.Length == 0)) reason = UnreadableTitleReason;
    if (reason != null) throw new Refusal(reason, "blocked");
  }

  // The window Windows draws at a point, from its own lists: the first that
  // shows there in band order (click-through windows included). Full
  // control takes Windows' first walk alone.
  internal static Win WindowAt(Inventory inventory, int x, int y, bool full) {
    Win best = null;
    foreach (var w in inventory.Windows) {
      if (full && !w.InL1) continue;
      if (!w.Shows || !w.FrameRead || !w.Frame.Contains(x, y)) continue;
      if (best == null || (full ? w.L1Index < best.L1Index : w.Above(best))) best = w;
    }
    return best;
  }

  // Bank sites (§10.2): the page an event reaches, when it's a bank's; null
  // otherwise. A browser whose page can't be read (its tree not built yet)
  // is refused, unless the event is on the browser's own controls.
  sealed class Page { public string Url, Title; }
  static Page MoneyAt(Seen s, bool point, Rules rules) {
    if (rules.Mode == "full" || !IsBrowser(s.Id) || rules.MoneySites.Count == 0) return null;
    if (s.Web) {
      var addresses = s.Frames.FindAll(frame => frame.Length > 0);
      if (addresses.Count == 0) throw new Refusal(Policy.MoneyUnreadReason, "retry");
      return Policy.MoneyFrames(addresses, rules) ? new Page { Url = string.Join(" ", addresses), Title = s.Title } : null;
    }
    if (s.Chrome) return null;
    // A field outside the page (the address bar, find) takes its own text.
    if (!point && Policy.MoneyFieldRoles.Contains(s.Role)) return null;
    throw new Refusal(Policy.MoneyUnreadReason, "retry");
  }

  // checkPoint (agent-desktop.swift): three views of the point, any refusal
  // wins: the window Windows draws there, the window it will route the click
  // to, and UI Automation's element.
  internal static Seen CheckPoint(int x, int y, Rules rules, Dictionary<string, string> expected, bool activate) {
    bool full = rules.Mode == "full";
    Action<Seen> checkExpected = target => {
      if (expected == null || !Policy.PointerIdentityKnown(target.Bundle, target.Name, target.Path, target.Pid)) return;
      string bundle, title;
      expected.TryGetValue("bundle", out bundle);
      bool titled = expected.TryGetValue("title", out title);
      if (target.Bundle != bundle || (titled && target.Title.Length > 0 && Limit(target.Title, 200) != title))
        throw new Refusal("The shortcut's target window changed. Look again before continuing.", "retry");
    };
    var inventory = View.Windows(rules);
    if (!inventory.Complete && !full) throw new Refusal(ChangedReason, "retry");
    Win at = WindowAt(inventory, x, y, full);
    Win route = View.RouteAt(x, y, rules);
    if (at != null && route != null && route.Pid != at.Pid && (at.ExStyle & Native.WS_EX_TRANSPARENT) == 0) throw new Refusal(ChangedReason, "retry");
    Seen window = at != null ? SeenOf(at) : null;
    if (window != null) {
      if (rules.Mode == "apps" && (at.Shell || window.Bundle.Length == 0)) throw new Refusal(Policy.NotAllowedReason, "blocked");
      if (at.Shell) { if (!full && Policy.MentionsReach(window.Title, rules)) throw new Refusal(Policy.ReachReason, "blocked"); }
      else CheckSeen(window, rules);
      checkExpected(window);
    }
    if (route != null) {
      if (rules.Mode == "apps" && route.Shell) throw new Refusal(Policy.NotAllowedReason, "blocked");
      if (!route.Shell) CheckSeen(SeenOf(route), rules);
      RuleT(route.Id);
    }
    Seen element = View.ElementAt(x, y);
    if (element != null) {
      if (element.Shell) {
        if (rules.Mode == "apps") throw new Refusal(Policy.NotAllowedReason, "blocked");
        string words = Policy.Lower(string.Join(" ", element.Labels));
        if (!full && Policy.MentionsReach(words, rules)) throw new Refusal(Policy.ReachReason, "blocked");
        foreach (string word in SystemGuardedWords) if (!full && words.Contains(word)) throw new Refusal(SystemGuardedReason, "blocked");
      } else {
        CheckSeen(element, rules);
        // UI Automation can't always name an element's window: the window
        // drawn here names it when it's the same app's. Only an unnamed one
        // falls back to the whole app, where any window showing Reach closes all.
        bool named = window != null && window.Pid == element.Pid && window.Title.Length > 0;
        if (!full && element.Title.Length == 0 && !named && View.HostsReach(element.Pid, rules)) throw new Refusal(Policy.ReachReason, "blocked");
        if (element.Title.Length == 0 && named) element.Title = window.Title;
        var page = MoneyAt(element, true, rules);
        if (page != null) {
          element.Bank = true;
          string reason = activate ? Policy.MoneyClickReason(page.Url, page.Title, element.Labels, element.Control, rules) : null;
          if (reason != null) throw new Refusal(reason, "blocked");
        }
      }
      if (Policy.PointerIdentityKnown(element.Bundle, element.Name, element.Path, element.Pid)) {
        checkExpected(element);
        RuleT(element.Id);
        return element;
      }
    }
    if (window != null && Policy.PointerIdentityKnown(window.Bundle, window.Name, window.Path, window.Pid)) {
      if (MoneyAt(window, true, rules) != null) window.Bank = true;
      RuleT(window.Id);
      return window;
    }
    // Full control is light: a point no app claims stays usable.
    if (full && expected == null) return window ?? new Seen();
    throw new Refusal("The app at this point could not be verified. Look again and retry.", "retry");
  }

  // focus (agent-desktop.swift): keys and text go to the window in front and
  // its focused element; both are checked. Keys always reach the window in
  // front, so its process must take them (Rule T).
  internal sealed class Target { public Seen App; public Seen Element; public bool Terminal; }
  internal static Target Focus(Rules rules, bool appOnly) {
    Win front = View.Foreground(rules);
    if (front == null || front.Pid <= 0) throw new Refusal("Nothing is ready for typing.", "retry");
    var app = SeenOf(front);
    string reason = AppVerdict(front.Id, rules);
    if (reason != null) throw new Refusal(reason, "blocked");
    CheckSeen(app, rules);
    RuleT(front.Id);
    Seen focused = View.Focused();
    if (focused == null) {
      if (appOnly || rules.Mode == "full") return new Target { App = app, Element = app, Terminal = front.Terminal };
      throw new Refusal("The focused app could not be verified. Look again before typing or pressing a key.", "retry");
    }
    if (focused.Pid != front.Pid) {
      if (!(appOnly || rules.Mode == "full")) throw new Refusal("The focused app changed while it was checked. Look again before typing or pressing a key.", "retry");
      CheckSeen(focused, rules);
      RuleT(focused.Id);
      return new Target { App = focused, Element = focused, Terminal = focused.Terminal };
    }
    CheckSeen(focused, rules);
    focused.Bundle = app.Bundle;
    focused.Name = app.Name;
    focused.Path = app.Path;
    return new Target { App = app, Element = focused, Terminal = front.Terminal };
  }

  // Keys by name, as agent-desktop.swift's keyCodes: layout-independent where
  // Windows has a key for it; punctuation through the front window's layout.
  static readonly Dictionary<string, ushort> KeyCodes = new Dictionary<string, ushort>(StringComparer.Ordinal) {
    { "return", 0x0D }, { "enter", 0x0D }, { "tab", 0x09 }, { "space", 0x20 }, { "delete", 0x08 }, { "backspace", 0x08 }, { "escape", 0x1B }, { "esc", 0x1B },
    { "left", 0x25 }, { "right", 0x27 }, { "down", 0x28 }, { "up", 0x26 }, { "forwarddelete", 0x2E }, { "home", 0x24 }, { "end", 0x23 }, { "pageup", 0x21 }, { "pagedown", 0x22 },
    { "f1", 0x70 }, { "f2", 0x71 }, { "f3", 0x72 }, { "f4", 0x73 }, { "f5", 0x74 }, { "f6", 0x75 }, { "f7", 0x76 }, { "f8", 0x77 }, { "f9", 0x78 }, { "f10", 0x79 }, { "f11", 0x7A },
  };
  static bool Extended(ushort vk) { return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E; }
  internal static ushort VirtualKey(string name) {
    ushort vk;
    if (KeyCodes.TryGetValue(name, out vk)) return vk;
    if (name.Length == 1) {
      char c = name[0];
      if (c >= 'a' && c <= 'z') return (ushort)(c - 'a' + 0x41);
      if (c >= '0' && c <= '9') return c;
      if ("=-][';\\,/.`".IndexOf(c) >= 0) {
        int mapped = View.KeyFor(c);
        if (mapped == -1 || ((mapped >> 8) & 0xFF) != 0 || (mapped & 0xFF) == 0xFF) throw new Refusal("That key isn't on this PC's keyboard layout. Type it as text.", "invalid");
        return (ushort)(mapped & 0xFF);
      }
    }
    throw new Refusal("Unknown key.", "invalid");
  }
  // The agent names modifiers as on a Mac, or as the server already mapped
  // them: Ctrl for ⌘ and control, Alt for option. Never the Windows key.
  internal static List<ushort> Modifiers(object value) {
    var keys = new List<ushort>();
    var names = value as List<object>;
    if (names == null) return keys;
    bool control = false, alt = false, shift = false;
    foreach (object item in names) {
      string name = item as string;
      if (name == "cmd" || name == "command" || name == "meta" || name == "control" || name == "ctrl") control = true;
      else if (name == "option" || name == "alt") alt = true;
      else if (name == "shift") shift = true;
    }
    if (control) keys.Add(Native.VK_CONTROL);
    if (alt) keys.Add(Native.VK_MENU);
    if (shift) keys.Add(Native.VK_SHIFT);
    return keys;
  }

  // One event as SendInput takes it.
  internal static Native.INPUT MouseEvent(uint flags, int dx, int dy, int data) {
    var input = new Native.INPUT { type = Native.INPUT_MOUSE };
    input.u.mi = new Native.MOUSEINPUT { dx = dx, dy = dy, mouseData = data, dwFlags = flags };
    return input;
  }
  internal static Native.INPUT KeyEvent(ushort vk, ushort scan, uint flags) {
    var input = new Native.INPUT { type = Native.INPUT_KEYBOARD };
    input.u.ki = new Native.KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = flags };
    return input;
  }
  internal static Native.INPUT KeyOf(ushort vk, bool down) {
    return KeyEvent(vk, View.ScanFor(vk), (down ? 0u : Native.KEYEVENTF_KEYUP) | (Extended(vk) ? Native.KEYEVENTF_EXTENDEDKEY : 0u));
  }
  // Absolute, over every monitor: Windows reads 0 to 65535 across the
  // virtual screen; rounded up, so it lands on exactly this pixel.
  public static int Normalize(int offset, int size) {
    if (size <= 1) return 0;
    long value = ((long)offset * 65536 + size - 1) / size;
    return (int)Math.Max(0, Math.Min(65535, value));
  }
  internal static Native.INPUT MoveTo(int x, int y) {
    var screen = View.VirtualScreen();
    return MouseEvent(Native.MOUSEEVENTF_MOVE | Native.MOUSEEVENTF_ABSOLUTE | Native.MOUSEEVENTF_VIRTUALDESK, Normalize(x - screen.Left, screen.Width), Normalize(y - screen.Top, screen.Height), 0);
  }

  // The only place input goes out (§5.1). Before every batch: nothing on a
  // secure desktop, nothing while an elevated window is in front (Rule F),
  // nothing while the owner holds a key or button this helper doesn't. One
  // batch is one SendInput: Windows lets nothing else in between. Once
  // stopping, nothing more is sent.
  static readonly int[] Watched = { Native.VK_CONTROL, Native.VK_MENU, Native.VK_SHIFT, Native.VK_LWIN, Native.VK_RWIN, Native.VK_LBUTTON, Native.VK_RBUTTON, Native.VK_MBUTTON };
  static Native.POINT lastPoint;
  // Nothing acts while Windows shows a secure screen (an administrator
  // prompt, the lock screen) or while an elevated window is in front: what
  // every input batch is checked for, for every action, the ones that send
  // no input too (a press or a fill through UI Automation, a menu's own
  // command, bringing a window forward).
  // Opening apps, websites and files waits for the owner's own desktop too.
  static void OnOwnersDesktop() {
    if (View.InputDesktop() != "Default") throw new Refusal(SecureDesktopReason, "paused");
  }
  internal static void ReadyToAct() {
    if (View.InputDesktop() != "Default") throw new Refusal(SecureDesktopReason, "paused");
    int front = View.ForegroundIntegrity();
    if (front == -1 || front > ownIntegrity) throw new Refusal(ElevatedFrontReason, "paused");
  }
  internal static void Post(Native.INPUT[] batch, int pauseMs) {
    if (View.InputDesktop() != "Default") throw new Refusal(SecureDesktopReason, "paused");
    int front = View.ForegroundIntegrity();
    if (front == -1 || front > ownIntegrity) throw new Refusal(ElevatedFrontReason, "paused");
    lock (heldLock) {
      if (stopping) return;
      foreach (int vk in Watched) if (Input.KeyDown(vk) && !HeldByUs(vk)) throw new Refusal(HeldKeyReason, "retry");
      uint sent = Input.Send(batch);
      for (int i = 0; i < sent && i < batch.Length; i++) Track(batch[i]);
      if (sent != batch.Length) throw new Refusal("Windows refused the input. Look at the screen before trying again.", "unavailable");
    }
    if (pauseMs > 0) Input.Pause(pauseMs);
  }
  // Windows makes a press within its double-click time and rectangle of the
  // last one a double click; a Mac's helper says each click's count itself.
  // So a click or a drag that would join the helper's last press waits until
  // it can't (at most Windows' double-click time), before its point is
  // checked: a click is the count the agent asked for, as on a Mac.
  internal static DateTime lastPressAt = DateTime.MinValue;
  internal static Native.POINT lastPressPoint, pressPoint;
  internal static bool lastPressRight, pressRight;
  internal static void SeparateFromLastPress(Native.POINT p, bool right) {
    pressPoint = p;
    pressRight = right;
    if (right != lastPressRight) return;
    int size = Math.Max(4, Input.DoubleClickSize());
    if (Math.Abs(p.X - lastPressPoint.X) > size || Math.Abs(p.Y - lastPressPoint.Y) > size) return;
    double left = Input.DoubleClickMs() + 25 - (DateTime.UtcNow - lastPressAt).TotalMilliseconds;
    if (left > 0) Input.Pause((int)Math.Ceiling(left));
  }
  static void Pressed(bool right) {
    lastPressAt = DateTime.UtcNow;
    lastPressPoint = pressPoint;
    lastPressRight = right;
  }
  static bool HeldByUs(int vk) {
    if (vk == Native.VK_LBUTTON) return heldButtons.ContainsKey(0);
    if (vk == Native.VK_RBUTTON) return heldButtons.ContainsKey(1);
    return heldKeys.Contains((ushort)vk);
  }
  static void Track(Native.INPUT input) {
    if (input.type == Native.INPUT_MOUSE) {
      uint flags = input.u.mi.dwFlags;
      if ((flags & Native.MOUSEEVENTF_MOVE) != 0 && (flags & Native.MOUSEEVENTF_ABSOLUTE) != 0) {
        lastPoint = new Native.POINT { X = input.u.mi.dx, Y = input.u.mi.dy };
        foreach (int button in new List<int>(heldButtons.Keys)) heldButtons[button] = lastPoint;
      }
      if ((flags & Native.MOUSEEVENTF_LEFTDOWN) != 0) { heldButtons[0] = lastPoint; Pressed(false); }
      if ((flags & Native.MOUSEEVENTF_LEFTUP) != 0) heldButtons.Remove(0);
      if ((flags & Native.MOUSEEVENTF_RIGHTDOWN) != 0) { heldButtons[1] = lastPoint; Pressed(true); }
      if ((flags & Native.MOUSEEVENTF_RIGHTUP) != 0) heldButtons.Remove(1);
    } else if (input.type == Native.INPUT_KEYBOARD && (input.u.ki.dwFlags & Native.KEYEVENTF_UNICODE) == 0) {
      if ((input.u.ki.dwFlags & Native.KEYEVENTF_KEYUP) != 0) heldKeys.Remove(input.u.ki.wVk);
      else heldKeys.Add(input.u.ki.wVk);
    }
  }

  // --- One input action (agent-desktop.swift perform) -------------------------
  static Dictionary<string, string> Expected(Dictionary<string, object> request) {
    var map = Json.Map(request, "expected");
    if (map == null) return null;
    var expected = new Dictionary<string, string>(StringComparer.Ordinal);
    foreach (var pair in map) {
      var text = pair.Value as string;
      if (text == null) return null;
      expected[pair.Key] = text;
    }
    return expected;
  }
  internal static Dictionary<string, object> Perform(Dictionary<string, object> action, Box display, Rules rules, Dictionary<string, string> expected) {
    if (rules.Mode == "view") throw new Refusal("This agent can only look. It has no mouse or keyboard here.", "blocked");
    ReadyToAct();
    string type = Json.Str(action, "type") ?? "";
    Func<string, string, Native.POINT> point = (xKey, yKey) => {
      double? nx = Json.Double(action, xKey), ny = Json.Double(action, yKey);
      if (!nx.HasValue || !ny.HasValue || nx < 0 || nx > 1 || ny < 0 || ny > 1) throw new Refusal("Choose a point on the screen.", "invalid");
      return new Native.POINT {
        X = display.Left + Math.Min(display.Width - 1, (int)Math.Floor(nx.Value * display.Width)),
        Y = display.Top + Math.Min(display.Height - 1, (int)Math.Floor(ny.Value * display.Height)),
      };
    };
    if (expected != null) {
      var current = Front(rules, false);
      foreach (var pair in expected) {
        object value;
        if (!current.TryGetValue(pair.Key, out value) || !(value is string) || (string)value != pair.Value)
          throw new Refusal("The shortcut's app, window or focused field changed. Look again before continuing.", "retry");
      }
      if (Json.True(current, "secure") || (Json.Str(current, "blocked") ?? "").Length > 0)
        throw new Refusal("The shortcut's app, window or focused field changed. Look again before continuing.", "retry");
    }
    var reached = Ok();
    switch (type) {
      case "move": {
        var p = point("x", "y");
        CheckPoint(p.X, p.Y, rules, expected, false);
        Post(new[] { MoveTo(p.X, p.Y) }, 8);
        return reached;
      }
      case "click": {
        var p = point("x", "y");
        bool right = Json.Str(action, "button") == "right";
        SeparateFromLastPress(p, right);
        var target = CheckPoint(p.X, p.Y, rules, expected, true);
        int count = Math.Max(1, Math.Min(3, Json.Int(action, "count") ?? 1));
        // A long press: one press, the button down holdMs before it lets go. A
        // stop meanwhile lets go at once (LetGo).
        int holdMs = count == 1 ? Math.Max(0, Math.Min(10000, Json.Int(action, "holdMs") ?? 0)) : 0;
        var mods = Modifiers(Json.Get(action, "modifiers"));
        uint down = right ? Native.MOUSEEVENTF_RIGHTDOWN : Native.MOUSEEVENTF_LEFTDOWN, up = right ? Native.MOUSEEVENTF_RIGHTUP : Native.MOUSEEVENTF_LEFTUP;
        var press = new List<Native.INPUT>();
        foreach (ushort vk in mods) press.Add(KeyOf(vk, true));
        press.Add(MoveTo(p.X, p.Y));
        var release = new List<Native.INPUT>();
        for (int i = mods.Count - 1; i >= 0; i--) release.Add(KeyOf(mods[i], false));
        if (holdMs > 0) {
          press.Add(MouseEvent(down, 0, 0, 0));
          Post(press.ToArray(), holdMs);
          release.Insert(0, MouseEvent(up, 0, 0, 0));
          Post(release.ToArray(), 8);
        } else {
          for (int i = 0; i < count; i++) { press.Add(MouseEvent(down, 0, 0, 0)); press.Add(MouseEvent(up, 0, 0, 0)); }
          press.AddRange(release);
          Post(press.ToArray(), 8);
        }
        reached["app"] = target.Name;
        reached["bundle"] = target.Bundle;
        return reached;
      }
      case "drag": {
        Native.POINT from = point("x", "y"), to = point("toX", "toY");
        SeparateFromLastPress(from, false);
        Seen start = CheckPoint(from.X, from.Y, rules, expected, false), end = CheckPoint(to.X, to.Y, rules, expected, false);
        if (start.Bank || end.Bank) throw new Refusal(Policy.MoneyPasteReason, "blocked");
        // holdMs: down that long before moving (a long press picks it up);
        // durationMs: the move spread over that long, a step every ~16 ms.
        int holdMs = Math.Max(0, Math.Min(5000, Json.Int(action, "holdMs") ?? 0));
        int durationMs = Math.Max(0, Math.Min(5000, Json.Int(action, "durationMs") ?? 0));
        int steps = durationMs > 0 ? Math.Max(12, Math.Min(300, durationMs / 16)) : 12;
        int stepPause = durationMs > 0 ? durationMs / steps : 8;
        Post(new[] { MoveTo(from.X, from.Y), MouseEvent(Native.MOUSEEVENTF_LEFTDOWN, 0, 0, 0) }, holdMs > 0 ? holdMs : 8);
        for (int step = 1; step <= steps; step++) {
          double t = (double)step / steps;
          Post(new[] { MoveTo((int)Math.Round(from.X + (to.X - from.X) * t), (int)Math.Round(from.Y + (to.Y - from.Y) * t)) }, stepPause);
        }
        Post(new[] { MoveTo(to.X, to.Y), MouseEvent(Native.MOUSEEVENTF_LEFTUP, 0, 0, 0) }, 8);
        return reached;
      }
      case "scroll": {
        var p = point("x", "y");
        CheckPoint(p.X, p.Y, rules, expected, false);
        int dx = (int)Math.Max(-2000, Math.Min(2000, Json.Double(action, "dx") ?? 0));
        int dy = (int)Math.Max(-2000, Math.Min(2000, Json.Double(action, "dy") ?? 0));
        // dy > 0 scrolls down, dx > 0 right, as on a Mac: Windows' wheel is
        // positive forward (up), its tilt positive right.
        var batch = new List<Native.INPUT> { MoveTo(p.X, p.Y) };
        if (dy != 0) batch.Add(MouseEvent(Native.MOUSEEVENTF_WHEEL, 0, 0, -dy));
        if (dx != 0) batch.Add(MouseEvent(Native.MOUSEEVENTF_HWHEEL, 0, 0, dx));
        Post(batch.ToArray(), 8);
        return reached;
      }
      case "type": return Type(action, rules);
      case "key": return Press(action, rules);
      case "element":
      case "press":
      case "fill":
      case "menu":
        return Controls(type, action, display, rules, expected);
      default:
        throw new Refusal("Unknown action.", "invalid");
    }
  }

  // Typed text: into the focused element, checked as it is (a password field
  // takes only a vault value; a vault value never goes into a terminal; a box
  // that runs programs takes nothing); a character at a time, or pasted.
  static Dictionary<string, object> Type(Dictionary<string, object> action, Rules rules) {
    string text = Json.Str(action, "text");
    if (string.IsNullOrEmpty(text) || text.Length > 2000) throw new Refusal("Type up to 2000 characters.", "invalid");
    var target = Focus(rules, false);
    bool secret = Json.True(action, "secret");
    bool full = rules.Mode == "full";
    if (!full && target.Element.Secure && !secret) throw new Refusal(Policy.SecureReason, "blocked");
    if (!full && secret && target.Terminal) throw new Refusal("Vault values don't go into a terminal. Click the sign-in field first.", "blocked");
    if (!full && (target.Element.CommandField || (target.App.Explorer && !target.Element.FolderEdit))) throw new Refusal(CommandFieldReason, "blocked");
    var page = MoneyAt(target.Element, false, rules);
    if (page != null) {
      string reason = Policy.MoneyTypeReason(page.Url, page.Title, target.Element.Labels.Count > 0 ? target.Element.Labels[0] : "", target.Element.Secure, secret, rules);
      if (reason != null) throw new Refusal(reason, "blocked");
    }
    if (secret || target.Element.Secure) RememberSecret(text);
    // The server checked the text as prose or as a command; if the focus
    // moved to a terminal since, it must look again.
    if (target.Terminal && !Json.True(action, "terminalLikeChecked")) throw new Refusal("A terminal is in front now. Try again.", "retry");
    var reached = Ok();
    reached["app"] = target.App.Name;
    reached["bundle"] = target.App.Bundle;
    if (Json.True(action, "paste")) {
      if (secret) throw new Refusal("Vault values are typed, never pasted.", "invalid");
      Paste(text);
      reached["pasted"] = true;
      return reached;
    }
    string[] lines = text.Split('\n');
    for (int line = 0; line < lines.Length; line++) {
      if (line > 0) Post(new[] { KeyEvent(Native.VK_RETURN, View.ScanFor(Native.VK_RETURN), 0), KeyEvent(Native.VK_RETURN, View.ScanFor(Native.VK_RETURN), Native.KEYEVENTF_KEYUP) }, 3);
      foreach (ushort[] chunk in Text.KeyboardChunks(lines[line])) {
        var batch = new List<Native.INPUT>();
        foreach (ushort unit in chunk) {
          batch.Add(KeyEvent(0, unit, Native.KEYEVENTF_UNICODE));
          batch.Add(KeyEvent(0, unit, Native.KEYEVENTF_UNICODE | Native.KEYEVENTF_KEYUP));
        }
        Post(batch.ToArray(), 3);
      }
    }
    return reached;
  }

  // Long text in one go: on the clipboard (kept out of Clipboard History and
  // cloud sync), Ctrl+V, then the owner's clipboard text back, the same way;
  // emptied when there was none. Only text is saved, as on a Mac.
  static void Paste(string text) {
    string previous = Clip.Read();
    Clip.Write(text);
    uint written = Clip.Sequence();
    try {
      Input.Pause(40);
      Post(new[] { KeyOf(Native.VK_CONTROL, true), KeyOf(0x56, true), KeyOf(0x56, false), KeyOf(Native.VK_CONTROL, false) }, 250);
    } finally {
      // Nobody else wrote meanwhile: the board still holds the agent's text,
      // pasted or not.
      if (Clip.Sequence() == written) Clip.Write(previous);
    }
  }

  // A key, with its modifiers, to the window in front.
  static Dictionary<string, object> Press(Dictionary<string, object> action, Rules rules) {
    string name = (Json.Str(action, "key") ?? "").ToLowerInvariant();
    ushort vk = VirtualKey(name);
    var mods = Modifiers(Json.Get(action, "modifiers"));
    bool command = mods.Contains(Native.VK_CONTROL), option = mods.Contains(Native.VK_MENU), shift = mods.Contains(Native.VK_SHIFT);
    bool navigation = System.Array.IndexOf(new[] { "tab", "escape", "esc", "left", "right", "up", "down", "home", "end", "pageup", "pagedown" }, name) >= 0;
    var target = Focus(rules, command || navigation);
    bool full = rules.Mode == "full";
    if (!full) {
      // What closes or stops a window or process holding Reach (Ctrl+Q/W/D,
      // Ctrl+C in a console, Ctrl+Shift+W for a terminal tab, Alt+F4).
      bool closing = (command && (name == "q" || name == "w" || name == "d" || name == "c")) || (command && shift && name == "w") || (option && name == "f4");
      if (closing && (target.App.Reach || View.HostsReach(target.App.Pid, rules))) throw new Refusal(Policy.ReachReason, "blocked");
      // Alt+F4 on the desktop or the taskbar offers to shut the PC down.
      if (option && name == "f4" && target.App.Shell) throw new Refusal(ShutDownReason, "blocked");
      // The developer tools read a page's passwords and run code (Chromium's
      // and Firefox's keys, and the Mac's mapped).
      if (IsBrowser(target.App.Id) && command && ((shift && "ijckez".IndexOf(name, StringComparison.Ordinal) >= 0 && name.Length == 1) || (option && (name == "i" || name == "j" || name == "c"))))
        throw new Refusal(Policy.ProtectedReason, "blocked");
      if (target.Element.Secure && !Policy.SecureKeyAllowed(name, command)) throw new Refusal(Policy.SecureReason, "blocked");
      // A box that runs programs takes only Tab, Escape and the arrows.
      bool moving = !command && !option && System.Array.IndexOf(new[] { "tab", "escape", "esc", "left", "right", "up", "down" }, name) >= 0;
      if ((target.Element.CommandField || (target.App.Explorer && target.Element.Editable && !target.Element.FolderEdit)) && !moving)
        throw new Refusal(CommandFieldReason, "blocked");
    }
    var page = MoneyAt(target.Element, false, rules);
    if (page != null) {
      string reason = Policy.MoneyKeyReason(page.Url, page.Title, name, command, false, Policy.MoneyFieldRoles.Contains(target.Element.Role), target.Element.Secure,
        target.Element.Labels, target.Element.Control, rules);
      if (reason != null) throw new Refusal(reason, "blocked");
    }
    var batch = new List<Native.INPUT>();
    foreach (ushort mod in mods) batch.Add(KeyOf(mod, true));
    batch.Add(KeyOf(vk, true));
    batch.Add(KeyOf(vk, false));
    for (int i = mods.Count - 1; i >= 0; i--) batch.Add(KeyOf(mods[i], false));
    Post(batch.ToArray(), 8);
    var reached = Ok();
    reached["app"] = target.App.Name;
    reached["bundle"] = target.App.Bundle;
    return reached;
  }


  // What the agent typed from its vault (type or fill with secret): never
  // shown back to it, as text or in a screenshot. In this process only.
  internal static readonly List<string> typedSecrets = new List<string>();
  static void RememberSecret(string text) {
    string value = text.Trim();
    if (new StringInfo(value).LengthInTextElements < 3 || typedSecrets.Contains(value)) return;
    typedSecrets.Add(value);
    if (typedSecrets.Count > 16) typedSecrets.RemoveAt(0);
  }

  // --- Windows itself, as input sees it ---------------------------------------
  // One window, read and decided with what owns it (Explorer's dialogs).
  internal static Win ReadDecided(IntPtr root, Rules rules) {
    var w = Read(root, new Dictionary<long, Ident>());
    if (w.Id == null || w.Id.Created == 0) w.Id = Identify(w.Pid);
    var index = new Dictionary<long, Win>();
    index[w.Handle] = w;
    for (IntPtr owner = new IntPtr(w.Owner); owner != IntPtr.Zero && index.Count < 8; owner = Native.GetWindow(owner, Native.GW_OWNER)) {
      var held = new Win { Handle = owner.ToInt64(), Class = ClassOf(owner), Owner = Native.GetWindow(owner, Native.GW_OWNER).ToInt64() };
      if (index.ContainsKey(held.Handle)) break;
      index[held.Handle] = held;
    }
    Decide(w, rules, index);
    return w;
  }
  internal static Inventory InventoryNow(Rules rules) { return TakeInventory(rules, new Dictionary<long, Ident>()); }
  // Any of this process's windows is Reach's (its console, or a title naming
  // Reach): it hosts Reach, so what would close it is refused.
  internal static bool HostsReach(int pid, Rules rules) {
    bool found = false;
    Native.EnumWindowsProc each = (window, data) => {
      uint owner;
      Native.GetWindowThreadProcessId(window, out owner);
      if (owner != pid) return true;
      bool readable;
      string title = TitleOf(window, out readable);
      if (IsReachConsole(window.ToInt64()) || Policy.TitleReason(title, "", rules) == Policy.ReachReason) { found = true; return false; }
      return true;
    };
    Native.EnumWindows(each, IntPtr.Zero);
    GC.KeepAlive(each);
    return found || TabsNameReach(pid, rules);
  }
  // A terminal's tab naming Reach (UI Automation): none until it can be read.
  static bool TabsNameReach(int pid, Rules rules) { return TabsNameReachNow(pid, rules); }
  // UI Automation's element at a point, and the focused one: none until it can be read.
  internal static Seen UiaElementAt(int x, int y) { return UiaElementAtNow(x, y); }
  internal static Seen UiaFocused() { return UiaFocusedNow(); }

  // Let go of whatever this helper holds, where it held it, and send nothing
  // more (the end of input, Reach's own end, a wedged thread).
  internal static void LetGo() {
    lock (heldLock) {
      stopping = true;
      foreach (var held in heldButtons) {
        uint up = held.Key == 1 ? Native.MOUSEEVENTF_RIGHTUP : Native.MOUSEEVENTF_LEFTUP;
        Input.Send(new[] { MouseEvent(Native.MOUSEEVENTF_MOVE | Native.MOUSEEVENTF_ABSOLUTE | Native.MOUSEEVENTF_VIRTUALDESK, held.Value.X, held.Value.Y, 0), MouseEvent(up, 0, 0, 0) });
      }
      foreach (ushort vk in heldKeys) Input.Send(new[] { KeyEvent(vk, 0, Native.KEYEVENTF_KEYUP | (Extended(vk) ? Native.KEYEVENTF_EXTENDEDKEY : 0u)) });
      heldButtons.Clear();
      heldKeys.Clear();
    }
  }

  // --- UI Automation (§8) -------------------------------------------------------
  // All UI Automation calls run on this (the main, MTA) thread, which owns no
  // window, except event handlers' registration (uia-events).
  static void RequireUia() { if (!uiaReady) throw new Refusal("Windows UI Automation isn't available to Reach on this PC.", "unavailable"); }
  static readonly HashSet<string> LabelRoles = new HashSet<string>(StringComparer.Ordinal) { "AXButton", "AXLink", "AXCheckBox", "AXRadioButton", "AXPopUpButton",
    "AXMenuButton", "AXComboBox", "AXTextField", "AXTextArea", "AXSecureTextField", "AXSearchField", "AXMenuItem", "AXMenuBarItem", "AXTab", "AXDisclosureTriangle",
    "AXIncrementor", "AXSlider", "AXSwitch", "AXToggle", "AXDockItem" };
  static readonly HashSet<string> FieldRoles = new HashSet<string>(StringComparer.Ordinal) { "AXTextField", "AXTextArea", "AXSearchField", "AXComboBox", "AXSecureTextField" };
  static readonly Regex Scheme = new Regex("^[a-z][a-z0-9+.-]*:", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));

  static Node Cached(IUIAutomationElement element) {
    if (element == null) return null;
    try { return Node.Of(element.BuildUpdatedCache(Uia.Structure)); } catch (Exception) { return null; }
  }
  static List<Node> Children(Node node) {
    var children = new List<Node>();
    try {
      var found = node.Element.FindAllBuildCache(Uia.ScopeChildren, Uia.ControlView, Uia.Structure);
      int count = found == null ? 0 : found.get_Length();
      for (int i = 0; i < count && i < 2000; i++) children.Add(Node.Of(found.GetElement(i)));
    } catch (Exception) { }
    return children;
  }
  static Node Parent(Node node) {
    try { var up = Uia.Walker.GetParentElementBuildCache(node.Element, Uia.Structure); return up == null ? null : Node.Of(up); } catch (Exception) { return null; }
  }
  // A value, only ever asked for an element that isn't a password field.
  internal static string ValueOf(IUIAutomationElement element) {
    try {
      var bearer = element.FindFirstBuildCache(Uia.ScopeElement, Uia.ValueBearing, Uia.Values);
      if (bearer == null) return "";
      object password = bearer.GetCachedPropertyValue(Uia.IsPassword);
      if (password is bool && (bool)password) return "";
      return bearer.GetCachedPropertyValue(Uia.ValueValue) as string ?? "";
    } catch (Exception) {
      return "";
    }
  }
  // A web page's address (its document's value), or null for a document that isn't one.
  static string PageAddress(Node node) {
    if (node.ControlType != Uia.Document) return null;
    string value = ValueOf(node.Element);
    bool address;
    try { address = Scheme.IsMatch(value); } catch (RegexMatchTimeoutException) { address = false; }
    if (address) return value;
    return node.Framework == "Chrome" || node.Framework == "Gecko" ? value : null;
  }
  static string Collapse(string text) {
    var words = (text ?? "").Split((char[])null, StringSplitOptions.RemoveEmptyEntries);
    return string.Join(" ", words);
  }
  // What a person would hear for a control (labelName, §8.3).
  static string LabelName(Node node, string role, bool secure) {
    var tries = new List<Func<string>> { () => node.Name, () => node.Description };
    if (FieldRoles.Contains(role) || secure) tries.Add(() => node.Help);
    else if (role == "AXButton" || role == "AXPopUpButton" || role == "AXMenuButton" || role == "AXTab" || role == "AXRadioButton" || role == "AXCheckBox") tries.Add(() => ValueOf(node.Element));
    tries.Add(() => node.Help);
    foreach (var get in tries) {
      string name = Collapse(get());
      if (name.Length > 0) return Policy.HideSecrets(Limit(name, 120), typedSecrets);
    }
    return "";
  }
  static string Spoken(Node node, string role) {
    if (role == "AXStaticText" || role == "AXHeading") { string text = Collapse(node.Name); if (text.Length > 0) return Limit(text, 120); }
    return LabelName(node, role, node.Password);
  }

  // Seen for an element (seen(), §8.3): its app (an embedded web view or a
  // packaged app's frame by the window it's in), its window's title, the
  // pages it's inside, what a press there presses, and Windows' fields.
  static Seen UiaSeen(Node node, Rules rules) {
    var s = new Seen { Pid = node.Pid, Secure = node.Password, AutomationId = node.AutomationId, Frame = node.Rect, Class = node.Class };
    s.Editable = node.ControlType == Uia.Edit || (node.ControlType == Uia.Document && node.ValuePattern) || (node.ControlType == Uia.ComboBox && node.ValuePattern);
    var chain = new List<KeyValuePair<string, Node>>();
    Node current = node;
    long root = 0, nearest = node.Window;
    bool chrome = false, band = false, folder = false;
    string ownRole = null;
    for (int step = 0; step < 60 && current != null; step++) {
      Node up = Parent(current);
      string role = current.Role(up);
      if (ownRole == null) ownRole = role;
      string address = PageAddress(current);
      if (address != null) {
        current.Web = true;
        role = "AXWebArea";
        if (s.Url.Length == 0) s.Url = address;
        s.Frames.Add(address);
        s.Web = true;
      }
      if (!s.Web && (current.ControlType == Uia.TitleBar || current.ControlType == Uia.ToolBar || current.ControlType == Uia.Tab || current.ControlType == Uia.MenuBar)) chrome = true;
      if (current.Class == "Address Band Root") band = true;
      if (current.Class == "SHELLDLL_DefView") folder = true;
      if (nearest == 0) nearest = current.Window;
      if (current.Window != 0 && Native.GetAncestor(new IntPtr(current.Window), Native.GA_ROOT).ToInt64() == current.Window) { root = current.Window; break; }
      if (!s.Web && chain.Count < 6) chain.Add(new KeyValuePair<string, Node>(role, current));
      current = up;
    }
    if (root == 0 && nearest != 0) root = Native.GetAncestor(new IntPtr(nearest), Native.GA_ROOT).ToInt64();
    s.Role = ownRole ?? "";
    // What a press here presses: the nearest control up from the element, else
    // the nearest thing the page made clickable, else the element and what
    // holds it. Outside a page, only its own name, judged as a button.
    int at = chain.FindIndex(pair => Policy.MoneyActionRoles.Contains(pair.Key) || Policy.MoneyFieldRoles.Contains(pair.Key));
    if (at >= 0) { for (int i = 0; i <= at; i++) s.Labels.Add(Spoken(chain[i].Value, chain[i].Key)); s.Control = chain[at].Key; }
    else {
      at = chain.FindIndex(pair => pair.Key != "AXStaticText" && pair.Value.Pressable);
      if (at >= 0) { for (int i = 0; i <= at; i++) s.Labels.Add(Spoken(chain[i].Value, chain[i].Key)); s.Control = "AXPressable"; }
      else foreach (var pair in chain) s.Labels.Add(Spoken(pair.Value, pair.Key));
    }
    if (!s.Web) { if (s.Labels.Count > 1) s.Labels.RemoveRange(1, s.Labels.Count - 1); s.Control = "AXButton"; }
    // The window it's in, as the rules judge windows.
    Win window = root != 0 ? ReadDecided(new IntPtr(root), rules) : null;
    var own = Identify(node.Pid);
    s.Id = own;
    if (window != null) {
      s.Root = window.Handle;
      s.Title = window.Title;
      s.TitleRead = window.TitleRead;
      s.Shell = window.Shell;
      s.Explorer = window.Explorer;
      s.Reach = window.Reach;
      s.Terminal = window.Terminal;
      // An embedded web view, or a Store app's frame, speaks for the window it's in.
      if (window.Pid != node.Pid && window.Id != null && window.Id.Known && EmbeddingHost(own) && AppVerdict(own, rules) == null) { s.Id = window.Id; s.Pid = window.Pid; }
      if (window.Class == "#32770" && Policy.Lower(window.Title) == "run" && FileOf(window.Id != null ? window.Id.Image : "").ToLowerInvariant() == "explorer.exe") band = true;
    }
    s.Bundle = s.Id.Bundle;
    s.Name = s.Id.Name;
    s.Path = s.Id.Path;
    s.Terminal = s.Terminal || (s.Id.Known && Policy.TerminalLikeApp(s.Bundle, s.Name, s.Path, rules));
    s.Chrome = chrome && !s.Web;
    s.CommandField = band && s.Editable;
    s.FolderEdit = folder && s.Editable;
    // A browser's address bar holds the page the next key would reach.
    if (s.Url.Length == 0 && (s.Role == "AXTextField" || s.Role == "AXComboBox")) {
      string value = ValueOf(node.Element);
      if (value.Contains("://") || value.Contains(":")) s.Url = value;
    }
    return s;
  }
  // msedgewebview2.exe under the Evergreen runtime, ApplicationFrameHost.exe
  // in System32: hosts whose content belongs to the window they're in.
  static bool EmbeddingHost(Ident id) {
    if (id == null || !id.Known) return false;
    string file = FileOf(id.Image).ToLowerInvariant();
    if (file == "applicationframehost.exe") return Within(id.Image, Path.Combine(WindowsFolder(), "System32"));
    if (file == "msedgewebview2.exe") {
      string x86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
      return Within(id.Image, Path.Combine(x86, "Microsoft\\EdgeWebView\\Application")) || Within(id.Image, Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Microsoft\\EdgeWebView\\Application"));
    }
    return false;
  }
  internal static Seen UiaElementAtNow(int x, int y) {
    if (!uiaReady) return null;
    try {
      var element = Uia.Automation.ElementFromPointBuildCache(new Native.POINT { X = x, Y = y }, Uia.Structure);
      var node = element == null ? null : Node.Of(element);
      if (node == null) return null;
      var seen = UiaSeen(node, current);
      // Chromium builds its page tree only once asked: once more, a moment later.
      if (IsBrowser(seen.Id) && !seen.Web && !seen.Chrome && current.MoneySites.Count > 0) {
        Thread.Sleep(300);
        element = Uia.Automation.ElementFromPointBuildCache(new Native.POINT { X = x, Y = y }, Uia.Structure);
        if (element != null) seen = UiaSeen(Node.Of(element), current);
      }
      return seen;
    } catch (Exception) {
      return null;
    }
  }
  internal static Seen UiaFocusedNow() {
    if (!uiaReady) return null;
    try {
      var element = Uia.Automation.GetFocusedElementBuildCache(Uia.Structure);
      return element == null ? null : UiaSeen(Node.Of(element), current);
    } catch (Exception) {
      return null;
    }
  }

  // The page Settings shows: the navigation item chosen, and the page's own
  // headings and breadcrumb; null when there are none (the page then closes).
  static string SettingsPageNow(IntPtr window) {
    if (!uiaReady) return null;
    try {
      var root = Uia.Automation.ElementFromHandleBuildCache(window, Uia.Structure);
      if (root == null) return null;
      var parts = new List<string>();
      var stack = new Stack<Node>();
      stack.Push(Node.Of(root));
      int visited = 0;
      var deadline = DateTime.UtcNow.AddMilliseconds(500);
      while (stack.Count > 0 && visited < 1500 && DateTime.UtcNow < deadline) {
        var node = stack.Pop();
        visited++;
        bool chosen = node.Selected && (node.ControlType == Uia.ListItem || node.ControlType == Uia.TreeItem || node.ControlType == Uia.TabItem);
        bool heading = node.ControlType == Uia.Text && node.Heading > 0;
        bool crumb = node.AutomationId.IndexOf("Breadcrumb", StringComparison.OrdinalIgnoreCase) >= 0 || node.AutomationId.IndexOf("PageHeader", StringComparison.OrdinalIgnoreCase) >= 0 ||
          node.AutomationId.IndexOf("PageTitle", StringComparison.OrdinalIgnoreCase) >= 0;
        if ((chosen || heading || crumb) && Collapse(node.Name).Length > 0 && !parts.Contains(Collapse(node.Name))) parts.Add(Collapse(node.Name));
        var children = Children(node);
        for (int i = children.Count - 1; i >= 0; i--) stack.Push(children[i]);
      }
      if (DateTime.UtcNow >= deadline && parts.Count == 0) return null;
      return parts.Count == 0 ? null : string.Join(" > ", parts);
    } catch (Exception) {
      return null;
    }
  }
  // A terminal's tab naming Reach (Windows Terminal), in a quarter second;
  // a read that runs out counts as naming it.
  static bool TabsNameReachNow(int pid, Rules rules) {
    if (!uiaReady || rules.Mode == "full") return false;
    var deadline = DateTime.UtcNow.AddMilliseconds(250);
    bool found = false;
    Native.EnumWindowsProc each = (window, data) => {
      uint owner;
      Native.GetWindowThreadProcessId(window, out owner);
      if (owner != pid || !Native.IsWindowVisible(window)) return true;
      foreach (string tab in TabNames(window, deadline)) if (Policy.TitleReason(tab, "", rules) == Policy.ReachReason) { found = true; return false; }
      if (DateTime.UtcNow >= deadline) { found = true; return false; }
      return true;
    };
    Native.EnumWindows(each, IntPtr.Zero);
    GC.KeepAlive(each);
    return found;
  }
  static List<string> TabNames(IntPtr window, DateTime deadline) {
    var names = new List<string>();
    try {
      var root = Uia.Automation.ElementFromHandleBuildCache(window, Uia.Structure);
      if (root == null) return names;
      var stack = new Stack<Node>();
      stack.Push(Node.Of(root));
      int visited = 0;
      while (stack.Count > 0 && visited < 1500 && DateTime.UtcNow < deadline) {
        var node = stack.Pop();
        visited++;
        if (node.ControlType == Uia.TabItem) { names.Add(node.Name); continue; }
        if (node.ControlType == Uia.Document) continue;
        var children = Children(node);
        for (int i = children.Count - 1; i >= 0; i--) stack.Push(children[i]);
      }
    } catch (Exception) { }
    return names;
  }

  // --- Reading the front window (readScreen, §8.4) -------------------------------
  internal sealed class Control { public IUIAutomationElement Element; public Node Node; public string Role, Name, Context = ""; public bool Secure; public Box Frame; }
  internal sealed class Screen {
    public int Pid; public long Root; public string App = "", Bundle = "", Title = "";
    public List<Control> Controls = new List<Control>();
    public Dictionary<int, string> Values = new Dictionary<int, string>();
    public List<KeyValuePair<string, KeyValuePair<Box, string>>> Texts = new List<KeyValuePair<string, KeyValuePair<Box, string>>>();
    public List<Box> Headings = new List<Box>();
    public bool Truncated; public Box Display; public string Within; public bool? Loading;
  }
  static Box DisplayBox() { var monitor = Display(); return new Box(monitor.Rect.Left, monitor.Rect.Top, monitor.Rect.Right, monitor.Rect.Bottom); }
  // A container's own words, for the region its controls are in.
  static string ContextLabel(Node node, string role, List<Node> children) {
    if (role != "AXGroup" && role != "AXRow" && role != "AXToolbar" && role != "AXTable" && role != "AXList" && role != "AXTabGroup") return "";
    string label = Collapse(node.Name.Length > 0 ? node.Name : node.Description);
    if (label.Length == 0 && role == "AXRow" && children != null) {
      var parts = new List<string>();
      foreach (var child in children) if (child.ControlType == Uia.Text && parts.Count < 4) parts.Add(Collapse(child.Name));
      label = string.Join(" ", parts);
    }
    return label;
  }
  static string Squeezed(string text) { return Collapse(Policy.Lower(text)); }
  static readonly Regex Stop = new Regex("^stop\\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
  static bool LoadingControl(string name) { try { return Stop.IsMatch(name); } catch (RegexMatchTimeoutException) { return false; } }

  internal static Screen ReadScreen(Rules rules, bool wantText, string within) {
    if (rules.Mode == "view") throw new Refusal("This agent can only look.", "blocked");
    RequireUia();
    Win front = View.Foreground(rules);
    if (front == null || front.Pid <= 0) throw new Refusal("Nothing is in front.", "retry");
    string reason = AppVerdict(front.Id, rules);
    if (reason != null) throw new Refusal(reason, "blocked");
    CheckSeen(SeenOf(front), rules);
    var screen = new Screen { Pid = front.Pid, Root = front.Handle, App = front.Id.Name, Bundle = front.Id.Bundle, Title = Limit(front.Title, 200), Display = DisplayBox() };
    string wantedWithin = Squeezed(within ?? "");
    if (wantedWithin.Length > 0) screen.Within = within;
    Func<string, bool> includes = context => wantedWithin.Length == 0 || Squeezed(context).Contains(wantedWithin) || Squeezed(Policy.MaskAccountNumbers(context, rules)).Contains(wantedWithin);
    var rootElement = Uia.Automation.ElementFromHandleBuildCache(new IntPtr(front.Handle), Uia.Structure);
    if (rootElement == null) throw new Refusal("Nothing is in front.", "retry");
    var stack = new Stack<KeyValuePair<Node, KeyValuePair<Node, string>>>();
    stack.Push(new KeyValuePair<Node, KeyValuePair<Node, string>>(Node.Of(rootElement), new KeyValuePair<Node, string>(null, "")));
    var found = new List<Control>();
    var values = new Dictionary<int, string>();
    int visited = 0, textChars = 0;
    bool bank = false, loading = false;
    var deadline = DateTime.UtcNow.AddMilliseconds(800);
    while (stack.Count > 0 && visited < 6000 && found.Count < 400 && DateTime.UtcNow < deadline) {
      var entry = stack.Pop();
      var node = entry.Key;
      string context = entry.Value.Value;
      visited++;
      string role = node.Role(entry.Value.Key);
      string address = PageAddress(node);
      if (address != null) {
        role = "AXWebArea";
        if (Policy.UrlReason(address, rules) != null) continue;
        if (Policy.MoneySite(address, rules)) bank = true;
      }
      if (role == "AXMenu") continue; // closed menus' items are not on screen
      bool included = includes(context);
      if (!included && (role == "AXStaticText" || role == "AXHeading" || (LabelRoles.Contains(role) && role != "AXButton" && role != "AXMenuBarItem"))) continue;
      bool secure = node.Password;
      if (!included && (LabelRoles.Contains(role) || secure) && role != "AXMenuBarItem") {
        if (role == "AXButton" && node.HasRect && node.Enabled && !node.Offscreen && LoadingControl(LabelName(node, role, secure))) loading = true;
        continue;
      }
      if (role == "AXStaticText" || role == "AXHeading") {
        if (wantText && screen.Texts.Count < 500 && textChars < 20000 && node.HasRect && !node.Offscreen) {
          string words = Collapse(node.Name);
          var visible = node.Rect.Intersect(screen.Display);
          if (words.Length > 0 && !visible.Empty && visible.Height >= 2) {
            string line = Policy.HideSecrets(Limit(words, 300), typedSecrets);
            screen.Texts.Add(new KeyValuePair<string, KeyValuePair<Box, string>>(line, new KeyValuePair<Box, string>(visible, context)));
            if (role == "AXHeading") screen.Headings.Add(visible);
            textChars += line.Length;
          }
        }
        continue;
      }
      if ((LabelRoles.Contains(role) || secure) && included) {
        if (node.HasRect && node.Rect.Width >= 4 && node.Rect.Height >= 4) {
          var visible = node.Rect.Intersect(screen.Display);
          if (!visible.Empty && visible.Width >= 2 && visible.Height >= 2 && node.Enabled && !node.Offscreen) {
            // What a field holds is on screen already; a password field's never,
            // nor what the agent typed from its vault.
            if (!secure && FieldRoles.Contains(role)) {
              string value = Collapse(ValueOf(node.Element));
              if (value.Length > 0) values[found.Count] = Policy.HideSecrets(Limit(value, 120), typedSecrets);
            }
            string name = LabelName(node, role, secure);
            if (role == "AXButton" && LoadingControl(name)) loading = true;
            found.Add(new Control { Element = node.Element, Node = node, Role = secure ? "AXSecureTextField" : role, Name = name, Secure = secure, Frame = visible, Context = context });
          }
        }
        // A control's own parts (a link's text, a button's image) are the control.
        if (role != "AXMenuBarItem") continue;
      }
      var children = Children(node);
      string label = ContextLabel(node, role, children);
      string inner = label.Length > 0 ? Limit(context.Length == 0 ? label : context + " > " + label, 400) : context;
      inner = Policy.HideSecrets(inner, typedSecrets);
      for (int i = children.Count - 1; i >= 0; i--) stack.Push(new KeyValuePair<Node, KeyValuePair<Node, string>>(children[i], new KeyValuePair<Node, string>(node, inner)));
    }
    // A bank's page: account and card numbers down to their last four digits.
    if (bank) {
      foreach (var control in found) { control.Name = Policy.MaskAccountNumbers(control.Name, rules); control.Context = Policy.MaskAccountNumbers(control.Context, rules); }
      foreach (int key in new List<int>(values.Keys)) values[key] = Policy.MaskAccountNumbers(values[key], rules);
      for (int i = 0; i < screen.Texts.Count; i++) {
        var text = screen.Texts[i];
        screen.Texts[i] = new KeyValuePair<string, KeyValuePair<Box, string>>(Policy.MaskAccountNumbers(text.Key, rules),
          new KeyValuePair<Box, string>(text.Value.Key, Policy.MaskAccountNumbers(text.Value.Value, rules)));
      }
    }
    // Reading order: rows from the top, left to right inside a row.
    Comparison<Box> order = (a, b) => {
      long ay = (long)Math.Round((a.Top + a.Bottom) / 24.0), by = (long)Math.Round((b.Top + b.Bottom) / 24.0);
      return ay != by ? ay.CompareTo(by) : a.Left.CompareTo(b.Left);
    };
    var indexed = new List<KeyValuePair<int, Control>>();
    for (int i = 0; i < found.Count; i++) indexed.Add(new KeyValuePair<int, Control>(i, found[i]));
    indexed = indexed.OrderBy(pair => pair.Value.Frame, Comparer<Box>.Create(order)).ThenBy(pair => pair.Key).ToList();
    for (int position = 0; position < indexed.Count && position < 250; position++) {
      screen.Controls.Add(indexed[position].Value);
      string value;
      if (values.TryGetValue(indexed[position].Key, out value)) screen.Values[position] = value;
    }
    screen.Texts = screen.Texts.OrderBy(pair => pair.Value.Key, Comparer<Box>.Create(order)).ToList();
    screen.Truncated = found.Count > screen.Controls.Count || visited >= 6000 || screen.Texts.Count >= 500 || textChars >= 20000 || DateTime.UtcNow >= deadline;
    screen.Loading = loading;
    return screen;
  }

  // --- References: snapshots' numbers and refs (rememberElement, §8.4) ----------
  sealed class Reference { public IUIAutomationElement Element; public long Root; public int Pid; public long Created; public string Role = "", Name = "", Context = "", Runtime = ""; public uint Display; public DateTime At; }
  static readonly Dictionary<string, Reference> references = new Dictionary<string, Reference>(StringComparer.Ordinal);
  static DateTime referencesPruned = DateTime.MinValue;
  sealed class Snapshot { public string Id; public int Pid; public long Root; public List<Control> Controls; public uint Display; }
  static readonly List<Snapshot> snapshots = new List<Snapshot>();
  static uint DisplayIdNow() { return Display().Id; }
  static string Remember(IUIAutomationElement element, string prefix, long root, int pid, string role, string name, string context, string runtime) {
    var now = DateTime.UtcNow;
    if ((now - referencesPruned).TotalSeconds >= 1) {
      foreach (var key in new List<string>(references.Keys)) if ((now - references[key].At).TotalSeconds >= 300) references.Remove(key);
      referencesPruned = now;
    }
    uint display = DisplayIdNow();
    foreach (var pair in references) {
      var known = pair.Value;
      if ((now - known.At).TotalSeconds < 300 && pair.Key.StartsWith(prefix + "-", StringComparison.Ordinal) && known.Pid == pid && known.Root == root && known.Runtime == runtime &&
          runtime.Length > 0 && known.Role == role && known.Name == name && known.Context == context && known.Display == display) { known.At = now; return pair.Key; }
    }
    if (references.Count >= 2048) {
      string oldest = null;
      foreach (var pair in references) if (oldest == null || pair.Value.At < references[oldest].At) oldest = pair.Key;
      references.Remove(oldest);
    }
    string id = prefix + "-" + Guid.NewGuid().ToString().ToLowerInvariant();
    references[id] = new Reference { Element = element, Root = root, Pid = pid, Created = ProcessCreated(pid), Role = role, Name = name, Context = context, Runtime = runtime, Display = display, At = now };
    return id;
  }
  // A control's region, as its snapshot recorded it; null when it's no longer in that window.
  static string ContextOf(IUIAutomationElement element, long root) {
    var parts = new List<string>();
    Node node = Cached(element);
    for (int step = 0; step < 40 && node != null; step++) {
      Node up = Parent(node);
      if (up == null) return null;
      if (up.Window != 0 && Native.GetAncestor(new IntPtr(up.Window), Native.GA_ROOT).ToInt64() == up.Window)
        return up.Window == root ? Policy.HideSecrets(Limit(string.Join(" > ", Enumerable.Reverse(parts)), 400), typedSecrets) : null;
      string label = ContextLabel(up, up.Role(null), up.ControlType == Uia.DataItem || up.ControlType == Uia.ListItem ? Children(up) : null);
      if (label.Length > 0) parts.Add(label);
      node = up;
    }
    return null;
  }
  internal static KeyValuePair<Control, Screen> ReferencedControl(string id, Rules rules) {
    Reference entry;
    Win front = View.Foreground(rules);
    if (!id.StartsWith("e-", StringComparison.Ordinal) || !references.TryGetValue(id, out entry) || (DateTime.UtcNow - entry.At).TotalSeconds >= 300 || front == null || front.Pid != entry.Pid)
      throw new Refusal("That control reference is stale. Observe again.", "retry");
    Node node = Cached(entry.Element);
    string context = node == null ? null : ContextOf(entry.Element, entry.Root);
    if (node == null || front.Handle != entry.Root || node.Role(null) != entry.Role && !(entry.Role == "AXSecureTextField" && node.Password) || context == null ||
        Policy.MaskAccountNumbers(LabelName(node, entry.Role, node.Password), rules) != Policy.MaskAccountNumbers(entry.Name, rules) ||
        Policy.MaskAccountNumbers(context, rules) != Policy.MaskAccountNumbers(entry.Context, rules) || !node.Enabled || !node.HasRect)
      throw new Refusal("That control changed. Observe again.", "retry");
    CheckSeen(UiaSeen(node, rules), rules);
    var control = new Control { Element = entry.Element, Node = node, Role = entry.Role, Name = entry.Name, Secure = node.Password, Frame = node.Rect, Context = context };
    var screen = new Screen { Pid = entry.Pid, Root = entry.Root, App = front.Id.Name, Bundle = front.Id.Bundle, Title = Limit(front.Title, 200), Display = DisplayBox() };
    screen.Controls.Add(control);
    return new KeyValuePair<Control, Screen>(control, screen);
  }
  static Dictionary<string, object> Place(Box rect, Box display) {
    var place = new Dictionary<string, object>();
    place["x"] = (double)(rect.Left - display.Left) / display.Width;
    place["y"] = (double)(rect.Top - display.Top) / display.Height;
    place["w"] = (double)rect.Width / display.Width;
    place["h"] = (double)rect.Height / display.Height;
    return place;
  }
  internal static Dictionary<string, object> SnapshotPayload(Screen screen) {
    string id = Guid.NewGuid().ToString("N").Substring(0, 8);
    uint display = DisplayIdNow();
    snapshots.Add(new Snapshot { Id = id, Pid = screen.Pid, Root = screen.Root, Controls = screen.Controls, Display = display });
    if (snapshots.Count > 16) snapshots.RemoveRange(0, snapshots.Count - 16);
    var items = new List<object>();
    for (int i = 0; i < screen.Controls.Count; i++) {
      var control = screen.Controls[i];
      var entry = Place(control.Frame, screen.Display);
      entry["ref"] = Remember(control.Element, "e", screen.Root, screen.Pid, control.Role, control.Name, control.Context, control.Node.Runtime);
      entry["context"] = control.Context;
      entry["n"] = i + 1;
      entry["role"] = control.Role.Substring(2);
      entry["name"] = control.Name;
      entry["secure"] = control.Secure;
      string value;
      if (screen.Values.TryGetValue(i, out value)) entry["value"] = value;
      items.Add(entry);
    }
    var lines = new List<object>();
    foreach (var text in screen.Texts) {
      var entry = Place(text.Value.Key, screen.Display);
      entry["text"] = text.Key;
      entry["context"] = text.Value.Value;
      int midX = (text.Value.Key.Left + text.Value.Key.Right) / 2, midY = (text.Value.Key.Top + text.Value.Key.Bottom) / 2;
      if (screen.Headings.Exists(heading => heading.Contains(midX, midY))) entry["heading"] = true;
      lines.Add(entry);
    }
    var result = Ok();
    result["snapshot"] = id;
    var windowElement = Uia.Automation.ElementFromHandleBuildCache(new IntPtr(screen.Root), Uia.Structure);
    result["windowRef"] = windowElement != null ? Remember(windowElement, "w", screen.Root, screen.Pid, "AXWindow", "", "", Node.Of(windowElement).Runtime) : "";
    result["revision"] = (long)Interlocked.Read(ref screenRevision);
    result["displayId"] = display;
    result["app"] = screen.App;
    result["title"] = screen.Title;
    result["items"] = items;
    result["texts"] = lines;
    result["truncated"] = screen.Truncated;
    if (screen.Within != null) result["within"] = screen.Within;
    if (screen.Loading.HasValue) result["loading"] = screen.Loading.Value;
    return result;
  }
  // The display an element or snapshot reference was seen on (chooseDisplay).
  static object RememberedDisplayOf(Dictionary<string, object> action) {
    string reference = Json.Str(action, "ref"), snapshot = Json.Str(action, "snapshot");
    Reference entry;
    if (reference != null && references.TryGetValue(reference, out entry)) return (double)entry.Display;
    if (snapshot != null) foreach (var known in snapshots) if (known.Id == snapshot) return (double)known.Display;
    return null;
  }

  // The control the agent named, in a fresh read (findControl).
  internal static Control FindControl(Screen screen, string name, string role, bool fields, Native.POINT? near) {
    var graded = new List<KeyValuePair<int, double>>();
    foreach (var control in screen.Controls) {
      bool roleOk = role == null || Policy.Lower(control.Role) == "ax" + Policy.Lower(role) || Policy.Lower(control.Role) == Policy.Lower(role);
      bool kindOk = !fields || FieldRoles.Contains(control.Role) || control.Secure;
      double distance = near.HasValue ? Math.Sqrt(Math.Pow((control.Frame.Left + control.Frame.Right) / 2.0 - near.Value.X, 2) + Math.Pow((control.Frame.Top + control.Frame.Bottom) / 2.0 - near.Value.Y, 2)) : double.PositiveInfinity;
      graded.Add(new KeyValuePair<int, double>(roleOk && kindOk ? Policy.NameMatch(control.Name, name) : 0, distance));
    }
    int candidates;
    int index = Policy.PickControl(graded, out candidates);
    if (index >= 0) return screen.Controls[index];
    string what = fields ? "field" : "control", shown = Limit(name, 60);
    if (candidates > 1) {
      var list = new List<object>();
      for (int i = 0; i < screen.Controls.Count && list.Count < 8; i++) {
        if (graded[i].Key <= 0) continue;
        var control = screen.Controls[i];
        var entry = new Dictionary<string, object>();
        entry["ref"] = Remember(control.Element, "e", screen.Root, screen.Pid, control.Role, control.Name, control.Context, control.Node.Runtime);
        entry["name"] = control.Name;
        entry["role"] = control.Role.Substring(2);
        entry["context"] = control.Context;
        list.Add(entry);
      }
      throw new Refusal(candidates + " " + what + "s match \"" + shown + "\". Choose one of the returned refs.", "invalid", list);
    }
    throw new Refusal("No " + what + " named \"" + shown + "\" is on screen. Describe the screen.", "retry");
  }
  // A click at a control's live centre, judged like any click; refused when
  // another app's window, or a dialog or menu of this app, now covers it.
  static Dictionary<string, object> ClickControl(Control control, Screen screen, Dictionary<string, object> action, Box display, Rules rules, Dictionary<string, string> expected) {
    var visible = control.Frame.Intersect(display);
    if (visible.Empty) throw new Refusal("That control is out of view. Scroll to it first.", "retry");
    int x = (visible.Left + visible.Right) / 2, y = (visible.Top + visible.Bottom) / 2;
    Win at = WindowAt(View.Windows(rules), x, y, rules.Mode == "full");
    if (at != null && at.Pid > 0 && at.Pid != screen.Pid && at.Id != null && Policy.PointerIdentityKnown(at.Id.Bundle, at.Id.Name, at.Id.Path, at.Pid) && !at.Shell)
      throw new Refusal("Another app's window now covers that control. Describe the screen again.", "retry");
    try {
      var hit = Uia.Automation.ElementFromPoint(new Native.POINT { X = x, Y = y });
      Func<IUIAutomationElement, int> pid = element => (int)Uia.Number(element.GetCurrentPropertyValue(Uia.ProcessId));
      if (hit != null && pid(hit) == screen.Pid && Policy.CoveredControl<IUIAutomationElement>(hit, control.Element,
          element => { try { return Uia.Walker.GetParentElement(element); } catch (Exception) { return null; } },
          (a, b) => Uia.Automation.CompareElements(a, b) != 0, (a, b) => pid(a) == pid(b),
          element => {
            long type = Uia.Number(element.GetCurrentPropertyValue(Uia.ControlType));
            object dialog = element.GetCurrentPropertyValue(Uia.IsDialog), modal = element.GetCurrentPropertyValue(Uia.WindowIsModal);
            return type == Uia.Menu || (dialog is bool && (bool)dialog) || (type == Uia.Window && modal is bool && (bool)modal);
          }))
        throw new Refusal("A dialog or menu now covers that control. Describe the screen again and answer it first.", "retry");
    } catch (COMException) { }
    var click = new Dictionary<string, object>();
    click["type"] = "click";
    click["x"] = (double)(x - display.Left) / display.Width;
    click["y"] = (double)(y - display.Top) / display.Height;
    foreach (string key in new[] { "button", "count", "holdMs" }) if (action.ContainsKey(key)) click[key] = action[key];
    var result = Perform(click, display, rules, expected);
    result["pressed"] = control.Name;
    return result;
  }

  // Controls found through UI Automation: a number from a snapshot or a ref
  // (element), a name (press), a form (fill), a menu path (menu).
  static Dictionary<string, object> Controls(string type, Dictionary<string, object> action, Box display, Rules rules, Dictionary<string, string> expected) {
    RequireUia();
    switch (type) {
      case "element": {
        string reference = Json.Str(action, "ref");
        if (reference != null) {
          var found = ReferencedControl(reference, rules);
          return ClickControl(found.Key, found.Value, action, display, rules, expected);
        }
        // A numbered label, as the control is now: a fresh read finds the same
        // role and name nearest to where it was; unnamed or renamed, where it is now.
        string id = Json.Str(action, "snapshot");
        int? n = Json.Int(action, "n");
        Snapshot snapshot = null;
        for (int i = snapshots.Count - 1; i >= 0 && snapshot == null; i--) if (snapshots[i].Id == id) snapshot = snapshots[i];
        if (snapshot == null || !n.HasValue || n < 1 || n > snapshot.Controls.Count) throw new Refusal("That label is from an older look. Look at the labels again.", "retry");
        var remembered = snapshot.Controls[n.Value - 1];
        Win front = View.Foreground(rules);
        if (front == null || front.Pid != snapshot.Pid) throw new Refusal("Another app is in front now. Describe the screen again.", "retry");
        var screen = ReadScreen(rules, false, null);
        Control control = null;
        if (remembered.Name.Length > 0) {
          try {
            control = FindControl(screen, remembered.Name, remembered.Role.Substring(2), false,
              new Native.POINT { X = (remembered.Frame.Left + remembered.Frame.Right) / 2, Y = (remembered.Frame.Top + remembered.Frame.Bottom) / 2 });
          } catch (Refusal) { control = null; }
        }
        if (control == null) {
          var now = Cached(remembered.Element);
          if (now == null || !now.HasRect) throw new Refusal("That control is gone. Describe the screen again.", "retry");
          control = new Control { Element = remembered.Element, Node = now, Role = remembered.Role, Name = remembered.Name, Secure = remembered.Secure, Frame = now.Rect, Context = remembered.Context };
        }
        return ClickControl(control, screen, action, display, rules, expected);
      }
      case "press": {
        string wanted = Json.Str(action, "name");
        if (string.IsNullOrEmpty(wanted) || wanted.Length > 120) throw new Refusal("Name the control to press.", "invalid");
        var screen = ReadScreen(rules, false, null);
        var candidates = screen;
        string within = Json.Str(action, "within");
        if (within != null) {
          candidates = new Screen { Pid = screen.Pid, Root = screen.Root, App = screen.App, Bundle = screen.Bundle, Title = screen.Title, Truncated = screen.Truncated, Display = screen.Display };
          candidates.Controls = screen.Controls.FindAll(control => Squeezed(control.Context).Contains(Squeezed(within)));
        }
        return ClickControl(FindControl(candidates, wanted, Json.Str(action, "role"), false, null), screen, action, display, rules, expected);
      }
      case "fill": {
        var fields = Json.Get(action, "fields") as List<object>;
        if (fields == null || fields.Count == 0 || fields.Count > 12) throw new Refusal("Give the fields to fill.", "invalid");
        var screen = ReadScreen(rules, false, null);
        var filled = new List<object>();
        for (int index = 0; index < fields.Count; index++) {
          var field = fields[index] as Dictionary<string, object>;
          string label = Json.Str(field, "label"), text = Json.Str(field, "text");
          if (string.IsNullOrEmpty(label) || label.Length > 120 || string.IsNullOrEmpty(text)) throw new Refusal("Each field needs a label and text.", "invalid");
          bool secret = Json.True(field, "secret");
          // Typing can change the form (a new field appears, one goes): read again.
          if (index > 0) screen = ReadScreen(rules, false, null);
          var control = FindControl(screen, label, null, true, null);
          if (rules.Mode != "full" && control.Secure && !secret) throw new Refusal(Policy.SecureReason, "blocked");
          ClickControl(control, screen, new Dictionary<string, object>(), display, rules, expected);
          Input.Pause(150);
          if (Json.True(action, "replace") && (rules.Mode == "full" || !control.Secure))
            Perform((Dictionary<string, object>)Json.Parse("{\"type\":\"key\",\"key\":\"a\",\"modifiers\":[\"ctrl\"]}"), display, rules, expected);
          var typing = new Dictionary<string, object>();
          typing["type"] = "type";
          typing["text"] = text;
          if (secret || control.Secure) typing["secret"] = true;
          if (action.ContainsKey("terminalLikeChecked")) typing["terminalLikeChecked"] = action["terminalLikeChecked"];
          if (Json.True(action, "paste") && !secret && !control.Secure) typing["paste"] = true;
          Perform(typing, display, rules, expected);
          filled.Add(control.Name);
        }
        if (Json.True(action, "submit")) Perform((Dictionary<string, object>)Json.Parse("{\"type\":\"key\",\"key\":\"enter\"}"), display, rules, expected);
        var reached = Ok();
        reached["app"] = screen.App;
        reached["bundle"] = screen.Bundle;
        reached["filled"] = filled;
        return reached;
      }
      case "menu":
        return PressMenu(Json.Get(action, "path") as List<object>, rules);
    }
    throw new Refusal("Unknown action.", "invalid");
  }

  // The front window, checked like a look (frontApp).
  static Win FrontApp(Rules rules) {
    if (rules.Mode == "view") throw new Refusal("This agent can only look.", "blocked");
    RequireUia();
    Win front = View.Foreground(rules);
    if (front == null || front.Pid <= 0) throw new Refusal("Nothing is in front.", "retry");
    string reason = AppVerdict(front.Id, rules);
    if (reason != null) throw new Refusal(reason, "blocked");
    CheckSeen(SeenOf(front), rules);
    return front;
  }

  // find (findOnScreen): a control by name (and role), or text, anywhere in
  // the front window, scrolled into view through UI Automation, then read again.
  static Dictionary<string, object> FindOnScreen(Rules rules, string text, string name, string role) {
    var front = FrontApp(rules);
    string wantText = Squeezed(text ?? ""), wantName = Squeezed(name ?? "");
    if (wantText.Length == 0 && wantName.Length == 0) throw new Refusal("Say what to find: text, or a control's name.", "invalid");
    var rootElement = Uia.Automation.ElementFromHandleBuildCache(new IntPtr(front.Handle), Uia.Structure);
    if (rootElement == null) throw new Refusal("No window is in front.", "retry");
    Node best = null;
    int bestGrade = 0, candidates = 0;
    string bestRole = "", bestLabel = "";
    var stack = new Stack<KeyValuePair<Node, Node>>();
    stack.Push(new KeyValuePair<Node, Node>(Node.Of(rootElement), null));
    int visited = 0;
    var deadline = DateTime.UtcNow.AddMilliseconds(1500);
    while (stack.Count > 0 && visited < 15000 && DateTime.UtcNow < deadline) {
      var entry = stack.Pop();
      var node = entry.Key;
      visited++;
      // A web page's document holds the page (its value is only its address).
      string address = PageAddress(node);
      string nodeRole = address != null ? "AXWebArea" : node.Role(entry.Value);
      if (address != null && Policy.UrlReason(address, rules) != null) continue;
      if (nodeRole == "AXMenu" || nodeRole == "AXMenuBar") continue;
      bool secure = node.Password;
      int grade = 0;
      string label = "";
      if (wantName.Length > 0) {
        if ((LabelRoles.Contains(nodeRole) || secure) && (string.IsNullOrEmpty(role) || Policy.Lower(nodeRole) == "ax" + Policy.Lower(role) || Policy.Lower(nodeRole) == Policy.Lower(role))) {
          label = LabelName(node, nodeRole, secure);
          grade = Policy.NameMatch(label, name);
        }
      } else if (nodeRole == "AXStaticText" || nodeRole == "AXHeading" || LabelRoles.Contains(nodeRole) || (nodeRole == "AXRow" && node.Name.Length > 0)) {
        // A row of a Windows list is its own text (a Mac's row holds a text).
        string raw = nodeRole == "AXStaticText" || nodeRole == "AXHeading" || nodeRole == "AXRow" ? node.Name : LabelName(node, nodeRole, secure) + (secure ? "" : " " + ValueOf(node.Element));
        string words = Squeezed(Policy.HideSecrets(raw, typedSecrets));
        grade = words == wantText ? 3 : words.StartsWith(wantText, StringComparison.Ordinal) ? 2 : words.Contains(wantText) ? 1 : 0;
        label = Limit(words, 160);
      }
      if (grade > 0) {
        if (best == null || grade > bestGrade) { best = node; bestGrade = grade; bestRole = nodeRole; bestLabel = label; candidates = 1; }
        else if (grade == bestGrade) candidates++;
        if (grade == 3) break;
      }
      if (LabelRoles.Contains(nodeRole) && nodeRole != "AXMenuBarItem") continue;
      var children = Children(node);
      for (int i = children.Count - 1; i >= 0; i--) stack.Push(new KeyValuePair<Node, Node>(children[i], node));
    }
    bool unfinished = visited >= 15000 || DateTime.UtcNow >= deadline;
    if (best == null) {
      var none = Ok();
      none["found"] = false;
      none["app"] = front.Id.Name;
      none["title"] = Limit(front.Title, 200);
      none["truncated"] = unfinished;
      return none;
    }
    var display = DisplayBox();
    var shown = front.Frame.Intersect(display);
    Func<Node, bool> inView = node => node != null && node.HasRect && !node.Offscreen && node.Rect.Intersect(shown).Width >= 2 && node.Rect.Intersect(shown).Height >= 2;
    bool scrolled = false, visible = inView(best);
    if (!visible && best.ScrollItem) {
      try {
        var pattern = best.Element.GetCurrentPattern(Uia.ScrollItemPattern) as IUIAutomationScrollItemPattern;
        if (pattern != null) { pattern.ScrollIntoView(); scrolled = true; Thread.Sleep(250); }
      } catch (Exception) { }
      best = Cached(best.Element) ?? best;
      visible = inView(best);
    }
    var screen = ReadScreen(rules, true, null);
    var payload = SnapshotPayload(screen);
    payload["found"] = true;
    payload["role"] = bestRole.Length > 2 ? bestRole.Substring(2) : bestRole;
    payload[wantName.Length == 0 ? "text" : "name"] = bestLabel;
    payload["matches"] = candidates;
    payload["inView"] = visible;
    payload["scrolled"] = scrolled;
    payload["truncated"] = screen.Truncated || unfinished;
    for (int i = 0; i < screen.Controls.Count; i++) {
      if (best.Runtime.Length > 0 && screen.Controls[i].Node.Runtime == best.Runtime) { payload["n"] = i + 1; break; }
    }
    if (!visible && best.HasRect) {
      int midX = (best.Rect.Left + best.Rect.Right) / 2, midY = (best.Rect.Top + best.Rect.Bottom) / 2;
      payload["direction"] = midY > shown.Bottom ? "below" : midY < shown.Top ? "above" : midX > shown.Right ? "right" : "left";
      payload["distance"] = (int)Math.Max(Math.Abs(midY - (shown.Top + shown.Bottom) / 2.0) - shown.Height / 2.0, Math.Abs(midX - (shown.Left + shown.Right) / 2.0) - shown.Width / 2.0);
    }
    return payload;
  }

  // read (readPage): the front window's whole text, what is scrolled away
  // included; in a browser, its pages. A password field is never read.
  static Dictionary<string, object> ReadPage(Rules rules) {
    var front = FrontApp(rules);
    var rootElement = Uia.Automation.ElementFromHandleBuildCache(new IntPtr(front.Handle), Uia.Structure);
    if (rootElement == null) throw new Refusal("No window is in front.", "retry");
    var lines = new List<string>();
    int chars = 0;
    string lastLine = "", url = "";
    bool bank = false;
    Action<string, bool> add = (raw, heading) => {
      var parts = new List<string>();
      foreach (string part in (raw ?? "").Split('\n')) { string trimmed = part.Trim(); if (trimmed.Length > 0) parts.Add(trimmed); }
      string joined = string.Join("\n", parts);
      if (joined.Length == 0) return;
      string line = (heading ? "# " : "") + Policy.HideSecrets(Limit(joined, 20000), typedSecrets);
      if (line == lastLine) return;
      lines.Add(line);
      lastLine = line;
      chars += line.Length;
    };
    var roots = new List<Node> { Node.Of(rootElement) };
    if (IsBrowser(front.Id)) {
      var pages = new List<Node>();
      var look = new Stack<Node>();
      look.Push(roots[0]);
      int seen = 0;
      while (look.Count > 0 && seen < 3000 && pages.Count < 4) {
        var node = look.Pop();
        seen++;
        if (PageAddress(node) != null) { pages.Add(node); continue; }
        foreach (var child in Children(node)) look.Push(child);
      }
      if (pages.Count > 0) roots = pages;
    }
    var stack = new Stack<KeyValuePair<Node, Node>>();
    for (int i = roots.Count - 1; i >= 0; i--) stack.Push(new KeyValuePair<Node, Node>(roots[i], null));
    int visited = 0;
    var deadline = DateTime.UtcNow.AddMilliseconds(2000);
    while (stack.Count > 0 && visited < 20000 && chars < 60000 && DateTime.UtcNow < deadline) {
      var entry = stack.Pop();
      var node = entry.Key;
      visited++;
      string address = PageAddress(node);
      string role = address != null ? "AXWebArea" : node.Role(entry.Value);
      if (address != null) {
        if (Policy.UrlReason(address, rules) != null) continue;
        if (Policy.MoneySite(address, rules)) bank = true;
        if (url.Length == 0) url = address;
      }
      if (role == "AXMenu" || role == "AXMenuBar") continue;
      if (node.Password) { add("[password field]", false); continue; }
      switch (role) {
        case "AXStaticText": add(node.Name, false); continue;
        case "AXHeading": add(node.Name, true); continue;
        case "AXTextArea": case "AXTextField": case "AXComboBox": case "AXSearchField": {
          string value = ValueOf(node.Element), label = LabelName(node, role, false);
          add(label.Length == 0 ? value : value.Length == 0 ? "[" + label + "]" : label + ": " + value, false);
          continue;
        }
        case "AXButton": case "AXLink": case "AXCheckBox": case "AXRadioButton": case "AXPopUpButton": case "AXMenuButton": case "AXTab": case "AXMenuItem": case "AXMenuBarItem": {
          string label = LabelName(node, role, false);
          if (label.Length > 0) add("[" + label + "]", false);
          continue;
        }
        case "AXImage": {
          string described = Collapse(node.Name.Length > 0 ? node.Name : node.Description);
          if (described.Length > 0) add("(image: " + described + ")", false);
          continue;
        }
      }
      var children = Children(node);
      if (children.Count == 0 && role == "AXRow") add(node.Name, false);
      for (int i = children.Count - 1; i >= 0; i--) stack.Push(new KeyValuePair<Node, Node>(children[i], node));
    }
    string text = string.Join("\n", lines);
    if (bank) text = Policy.MaskAccountNumbers(text, rules);
    var result = Ok();
    result["app"] = front.Id.Name;
    result["bundle"] = front.Id.Bundle;
    result["title"] = Limit(front.Title, 200);
    result["url"] = Limit(url, 2048);
    result["text"] = Limit(text, 60000);
    result["truncated"] = visited >= 20000 || chars >= 60000 || DateTime.UtcNow >= deadline;
    return result;
  }

  // A browser window's page and tabs (windowPage, windowTabs).
  static string WindowPage(Win window, Rules rules) {
    try {
      var root = Uia.Automation.ElementFromHandleBuildCache(new IntPtr(window.Handle), Uia.Structure);
      var look = new Stack<Node>();
      look.Push(Node.Of(root));
      int seen = 0;
      var deadline = DateTime.UtcNow.AddMilliseconds(300);
      while (look.Count > 0 && seen < 3000 && DateTime.UtcNow < deadline) {
        var node = look.Pop();
        seen++;
        string address = PageAddress(node);
        if (address != null) return address.Length > 0 && Policy.UrlReason(address, rules) == null ? Limit(address, 2048) : "";
        foreach (var child in Children(node)) look.Push(child);
      }
    } catch (Exception) { }
    return "";
  }
  static List<KeyValuePair<Node, bool>> WindowTabs(Win window) {
    var tabs = new List<KeyValuePair<Node, bool>>();
    try {
      var root = Uia.Automation.ElementFromHandleBuildCache(new IntPtr(window.Handle), Uia.Structure);
      var stack = new Stack<Node>();
      stack.Push(Node.Of(root));
      int visited = 0;
      var deadline = DateTime.UtcNow.AddMilliseconds(250);
      while (stack.Count > 0 && visited < 1500 && tabs.Count < 40 && DateTime.UtcNow < deadline) {
        var node = stack.Pop();
        visited++;
        if (node.ControlType == Uia.Document || node.ControlType == Uia.Menu || node.ControlType == Uia.MenuBar) continue;
        if (node.ControlType == Uia.TabItem) { if (Collapse(node.Name).Length > 0) tabs.Add(new KeyValuePair<Node, bool>(node, node.Selected)); continue; }
        var children = Children(node);
        for (int i = children.Count - 1; i >= 0; i--) stack.Push(children[i]);
      }
    } catch (Exception) { }
    return tabs;
  }
  static List<object> TabList(Win window, Rules rules, int limit) {
    var list = new List<object>();
    foreach (var tab in WindowTabs(window)) {
      if (list.Count >= limit) break;
      var entry = new Dictionary<string, object>();
      string title = Collapse(tab.Key.Name);
      entry["ref"] = Remember(tab.Key.Element, "t", window.Handle, window.Pid, "AXTab", title, "", tab.Key.Runtime);
      entry["title"] = Policy.HideSecrets(Limit(title, 120), typedSecrets);
      entry["selected"] = tab.Value;
      list.Add(entry);
    }
    return list;
  }

  // windows (windowList): every window the agent may know of, Alt+Tab's way,
  // the closed ones left out entirely; a browser's with its page and tabs.
  static Dictionary<string, object> WindowList(Rules rules) {
    RequireUia();
    var handles = new List<IntPtr>();
    Native.EnumWindowsProc each = (window, data) => { handles.Add(window); return handles.Count < 4096; };
    Native.EnumWindows(each, IntPtr.Zero);
    GC.KeepAlive(each);
    IntPtr frontRoot = Native.GetAncestor(Native.GetForegroundWindow(), Native.GA_ROOT);
    var windows = new List<object>();
    var perApp = new Dictionary<int, int>();
    var deadline = DateTime.UtcNow.AddMilliseconds(1500);
    foreach (IntPtr handle in handles) {
      if (windows.Count >= 120 || DateTime.UtcNow > deadline) break;
      bool visible = Native.IsWindowVisible(handle), minimized = Native.IsIconic(handle);
      if (!visible && !minimized) continue;
      int cloaked;
      if (Native.DwmGetWindowAttribute(handle, Native.DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0) continue;
      uint style = ExStyleOf(handle);
      if ((style & Native.WS_EX_TOOLWINDOW) != 0 && (style & Native.WS_EX_APPWINDOW) == 0) continue;
      IntPtr owner = Native.GetWindow(handle, Native.GW_OWNER);
      if (owner != IntPtr.Zero && Native.IsWindowVisible(owner)) continue;
      var w = ReadDecided(handle, rules);
      if (w.Shell || Verdict(w, rules, false) != null) continue;
      int count;
      perApp.TryGetValue(w.Pid, out count);
      if (count >= 24) continue;
      perApp[w.Pid] = count + 1;
      var entry = new Dictionary<string, object>();
      Node windowNode = Cached(Uia.Automation.ElementFromHandle(handle));
      entry["id"] = windowNode != null ? Remember(windowNode.Element, "w", w.Handle, w.Pid, "AXWindow", "", "", windowNode.Runtime) : "";
      if ((string)entry["id"] == "") continue;
      entry["app"] = w.Id.Name;
      entry["bundle"] = w.Id.Bundle;
      entry["title"] = Policy.HideSecrets(Limit(w.Title, 200), typedSecrets);
      entry["minimized"] = minimized;
      entry["front"] = handle == frontRoot;
      if ((windowNode != null && windowNode.Dialog) || (ClassOf(handle) == "#32770" && owner != IntPtr.Zero)) entry["dialog"] = true;
      if (IsBrowser(w.Id)) {
        string page = WindowPage(w, rules);
        if (page.Length > 0) entry["url"] = page;
        var tabs = TabList(w, rules, 30);
        if (tabs.Count > 0) entry["tabs"] = tabs;
      }
      windows.Add(entry);
    }
    var result = Ok();
    result["windows"] = windows;
    return result;
  }

  // focus (focusWindow): one window by its ref, its title checked again;
  // restored, raised without taking the foreground, then asked forward once.
  // Windows may refuse that (its foreground lock): front false, as on a Mac.
  static Dictionary<string, object> FocusWindow(string id, string wanted, string tab, string tabRef, Rules rules) {
    if (rules.Mode == "view") throw new Refusal("This agent can only look.", "blocked");
    RequireUia();
    Reference reference;
    if (!id.StartsWith("w-", StringComparison.Ordinal) || !references.TryGetValue(id, out reference) || (DateTime.UtcNow - reference.At).TotalSeconds >= 300)
      throw new Refusal("That window is gone. List windows again.", "retry");
    IntPtr handle = new IntPtr(reference.Root);
    uint pid;
    Native.GetWindowThreadProcessId(handle, out pid);
    if (!Native.IsWindow(handle) || pid != reference.Pid || ProcessCreated(reference.Pid) != reference.Created || Native.GetAncestor(handle, Native.GA_ROOT) != handle)
      throw new Refusal("That window is gone. List windows again.", "retry");
    var w = ReadDecided(handle, rules);
    string reason = AppVerdict(w.Id, rules) ?? Verdict(w, rules, false);
    if (reason != null) throw new Refusal(reason, "blocked");
    if (w.Shell) throw new Refusal(Policy.NotAllowedReason, "blocked");
    if (!string.IsNullOrEmpty(wanted) && !Policy.Lower(w.Title).StartsWith(Policy.Lower(wanted), StringComparison.Ordinal) && !SameTitle(w.Title, wanted))
      throw new Refusal("That window has changed. List the windows again.", "retry");
    RuleT(w.Id);
    if (Native.IsIconic(handle)) Native.ShowWindowAsync(handle, Native.SW_RESTORE);
    Native.SetWindowPos(handle, IntPtr.Zero, 0, 0, 0, 0, Native.SWP_NOACTIVATE | Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_ASYNCWINDOWPOS);
    Native.SetForegroundWindow(handle);
    bool front = WaitFront(handle);
    var result = Ok();
    result["app"] = w.Id.Name;
    result["bundle"] = w.Id.Bundle;
    result["front"] = front;
    if (!string.IsNullOrEmpty(tab) || !string.IsNullOrEmpty(tabRef)) {
      if (!IsBrowser(w.Id)) throw new Refusal("Only a browser window has tabs.", "invalid");
      var tabs = WindowTabs(w);
      Reference chosen = null;
      if (!string.IsNullOrEmpty(tabRef)) references.TryGetValue(tabRef, out chosen);
      var graded = new List<KeyValuePair<int, double>>();
      foreach (var candidate in tabs) {
        bool exact = chosen != null && (DateTime.UtcNow - chosen.At).TotalSeconds < 300 && chosen.Pid == w.Pid && chosen.Root == w.Handle && chosen.Runtime == candidate.Key.Runtime &&
          chosen.Name == Collapse(candidate.Key.Name);
        graded.Add(new KeyValuePair<int, double>(string.IsNullOrEmpty(tabRef) ? Policy.NameMatch(candidate.Key.Name, tab) : exact ? 3 : 0, double.PositiveInfinity));
      }
      int candidates;
      int at = Policy.PickControl(graded, out candidates);
      if (at < 0) {
        if (candidates > 1) throw new Refusal(candidates + " tabs match \"" + Limit(tab ?? "", 60) + "\". Give more of the title.", "invalid");
        throw new Refusal("No tab named \"" + Limit(tab ?? "", 60) + "\" in that window. List the windows again.", "retry");
      }
      if (Policy.TitleReason(tabs[at].Key.Name, w.Id.Bundle, rules) != null) throw new Refusal(Policy.ProtectedReason, "blocked");
      if (!Choose(tabs[at].Key)) throw new Refusal("That tab couldn't be chosen. Click it instead.", "retry");
      Thread.Sleep(150);
      result["tab"] = Policy.HideSecrets(Limit(Collapse(tabs[at].Key.Name), 120), typedSecrets);
    }
    bool readable;
    result["title"] = Policy.HideSecrets(Limit(TitleOf(handle, out readable), 200), typedSecrets);
    return result;
  }
  // A tab chosen through UI Automation, never the pointer.
  static bool Choose(Node tab) {
    try {
      var select = tab.Element.GetCurrentPattern(Uia.SelectionItemPattern) as IUIAutomationSelectionItemPattern;
      if (select != null) { select.Select(); return true; }
    } catch (Exception) { }
    try {
      var invoke = tab.Element.GetCurrentPattern(Uia.InvokePattern) as IUIAutomationInvokePattern;
      if (invoke != null) { invoke.Invoke(); return true; }
    } catch (Exception) { }
    try {
      var legacy = tab.Element.GetCurrentPattern(Uia.LegacyIAccessiblePattern) as IUIAutomationLegacyIAccessiblePattern;
      if (legacy != null) { legacy.DoDefaultAction(); return true; }
    } catch (Exception) { }
    return false;
  }
  static bool WaitFront(IntPtr window) {
    var deadline = DateTime.UtcNow.AddMilliseconds(1500);
    while (true) {
      if (Native.GetAncestor(Native.GetForegroundWindow(), Native.GA_ROOT) == window) return true;
      if (DateTime.UtcNow >= deadline) return false;
      Thread.Sleep(50);
    }
  }
  // Menu and tab titles match without a trailing ellipsis or a mnemonic, whatever the case.
  internal static bool SameTitle(string a, string b) {
    Func<string, string> trim = text => Policy.Lower(text).Replace("&", "").Replace(((char)0x2026).ToString(), "").Replace("...", "").Trim();
    return trim(a) == trim(b);
  }

  // --- Menus (§8.4): read from the window's own menu bar, invisibly ------------
  sealed class MenuEntry { public string Title = "", Key = ""; public bool Enabled = true, Checked; public IntPtr Submenu; public uint Id; public int Position; }
  static List<MenuEntry> MenuEntries(IntPtr menu) {
    var entries = new List<MenuEntry>();
    int count = Native.GetMenuItemCount(menu);
    for (int i = 0; i < count && i < 200; i++) {
      var info = new Native.MENUITEMINFO { cbSize = Marshal.SizeOf(typeof(Native.MENUITEMINFO)), fMask = Native.MIIM_STRING | Native.MIIM_STATE | Native.MIIM_SUBMENU | Native.MIIM_FTYPE | Native.MIIM_ID };
      if (!Native.GetMenuItemInfoW(menu, (uint)i, true, ref info) || (info.fType & Native.MFT_SEPARATOR) != 0) continue;
      // Kept before the string is asked for: that second call needn't keep them.
      IntPtr submenu = info.hSubMenu;
      uint state = info.fState, id = info.wID;
      string text = "";
      if (info.cch > 0 && info.cch < 4096) {
        IntPtr buffer = Marshal.AllocHGlobal((int)(info.cch + 1) * 2);
        try {
          info.dwTypeData = buffer;
          info.cch += 1;
          info.fMask = Native.MIIM_STRING;
          if (Native.GetMenuItemInfoW(menu, (uint)i, true, ref info)) text = Marshal.PtrToStringUni(buffer) ?? "";
        } finally {
          Marshal.FreeHGlobal(buffer);
        }
      }
      // &File: the mnemonic's marker goes ("&&" is a real "&"); after a tab, the shortcut.
      text = text.Replace("&&", "\u0001").Replace("&", "").Replace("\u0001", "&");
      int tab = text.IndexOf('\t');
      var entry = new MenuEntry { Title = (tab >= 0 ? text.Substring(0, tab) : text).Trim(), Key = tab >= 0 ? Limit(text.Substring(tab + 1).Trim(), 12) : "",
        Enabled = (state & Native.MFS_DISABLED) == 0, Checked = (state & Native.MFS_CHECKED) != 0, Submenu = submenu, Id = id, Position = i };
      if (entry.Title.Length > 0) entries.Add(entry);
    }
    return entries;
  }
  static List<object> MenuItems(IntPtr menu, int depth, ref int count, DateTime deadline) {
    var items = new List<object>();
    foreach (var entry in MenuEntries(menu)) {
      if (count >= 400 || DateTime.UtcNow > deadline) break;
      count++;
      var item = new Dictionary<string, object>();
      item["title"] = Policy.HideSecrets(Limit(entry.Title, 80), typedSecrets);
      if (!entry.Enabled) item["enabled"] = false;
      if (entry.Key.Length > 0) item["key"] = entry.Key;
      if (entry.Checked) item["checked"] = true;
      if (entry.Submenu != IntPtr.Zero) {
        if (depth > 0) item["items"] = MenuItems(entry.Submenu, depth - 1, ref count, deadline);
        else item["submenu"] = true;
      }
      items.Add(item);
    }
    return items;
  }
  // A window's UI Automation menu bar (WinForms' and WPF's own), or null.
  static Node MenuBarOf(long root) {
    try {
      var top = Uia.Automation.ElementFromHandleBuildCache(new IntPtr(root), Uia.Structure);
      var stack = new Stack<Node>();
      stack.Push(Node.Of(top));
      int visited = 0;
      while (stack.Count > 0 && visited < 400) {
        var node = stack.Pop();
        visited++;
        // The title bar holds the window's System menu, not the app's.
        if (node.ControlType == Uia.TitleBar || node.ControlType == Uia.Document) continue;
        if (node.ControlType == Uia.MenuBar) return node;
        foreach (var child in Children(node)) stack.Push(child);
      }
    } catch (Exception) { }
    return null;
  }
  // menus (menuBar): every menu's items with their shortcuts; one menu named, with its submenus.
  static Dictionary<string, object> MenuBar(Rules rules, string wanted) {
    var front = FrontApp(rules);
    var menus = new List<object>();
    int count = 0;
    var deadline = DateTime.UtcNow.AddMilliseconds(1500);
    IntPtr bar = Native.GetMenu(new IntPtr(front.Handle));
    if (bar != IntPtr.Zero && Native.GetMenuItemCount(bar) > 0) {
      foreach (var top in MenuEntries(bar)) {
        if (menus.Count >= 30) break;
        if (!string.IsNullOrEmpty(wanted) && !SameTitle(top.Title, wanted)) continue;
        var menu = new Dictionary<string, object>();
        menu["title"] = Limit(top.Title, 80);
        menu["items"] = top.Submenu != IntPtr.Zero ? MenuItems(top.Submenu, string.IsNullOrEmpty(wanted) ? 0 : 2, ref count, deadline) : new List<object>();
        menus.Add(menu);
      }
    } else {
      // No classic menu: its UI Automation menu bar's own items, not opened.
      var uiaBar = MenuBarOf(front.Handle);
      if (uiaBar == null) throw new Refusal("This app has no menu bar to read.", "retry");
      foreach (var item in Children(uiaBar)) {
        string title = Collapse(item.Name);
        if (title.Length == 0 || menus.Count >= 30 || (!string.IsNullOrEmpty(wanted) && !SameTitle(title, wanted))) continue;
        var menu = new Dictionary<string, object>();
        menu["title"] = Limit(title, 80);
        menu["items"] = new List<object>();
        menu["submenu"] = true;
        menus.Add(menu);
      }
    }
    if (!string.IsNullOrEmpty(wanted) && menus.Count == 0) throw new Refusal("No menu named \"" + Limit(wanted, 60) + "\". Read the menus without a name first.", "invalid");
    var result = Ok();
    result["app"] = front.Id.Name;
    result["bundle"] = front.Id.Bundle;
    result["title"] = Limit(front.Title, 200);
    result["menus"] = menus;
    result["truncated"] = count >= 400 || DateTime.UtcNow > deadline;
    return result;
  }
  // A menu item by its path, matched on the menu's own titles and checked
  // (dimmed, a submenu, what would close Reach, Reach's or a protected name),
  // then pressed through UI Automation along the window's menu bar: no pointer.
  static Dictionary<string, object> PressMenu(List<object> path, Rules rules) {
    var names = new List<string>();
    if (path != null) foreach (object item in path) { var name = item as string; if (name != null) names.Add(name); }
    if (names.Count == 0 || names.Count > 6 || names.Count != path.Count || names.Exists(name => name.Length == 0 || name.Length > 80)) throw new Refusal("Give the menu path, menu title first.", "invalid");
    var target = Focus(rules, true);
    long root = target.App.Root;
    IntPtr level = Native.GetMenu(new IntPtr(root));
    if (level == IntPtr.Zero) throw new Refusal("This app has no menu bar.", "retry");
    IntPtr bar = level;
    MenuEntry chosen = null;
    var steps = new List<KeyValuePair<IntPtr, MenuEntry>>();
    for (int i = 0; i < names.Count; i++) {
      var entries = level == IntPtr.Zero ? new List<MenuEntry>() : MenuEntries(level);
      var graded = entries.ConvertAll(entry => new KeyValuePair<int, double>(SameTitle(entry.Title, names[i]) ? 3 : Policy.NameMatch(entry.Title, names[i]) == 2 ? 2 : 0, double.PositiveInfinity));
      int candidates;
      int at = Policy.PickControl(graded, out candidates);
      if (at < 0) {
        if (candidates > 1) throw new Refusal(candidates + " menu items match \"" + Limit(names[i], 60) + "\". Give the full title.", "invalid");
        throw new Refusal("No menu item \"" + Limit(names[i], 60) + "\" in " + (i == 0 ? "the menu bar" : names[i - 1]) + ". Read the menus with reach_menus.", "retry");
      }
      chosen = entries[at];
      steps.Add(new KeyValuePair<IntPtr, MenuEntry>(level, chosen));
      level = chosen.Submenu;
    }
    string title = chosen.Title, word = Policy.Lower(title);
    if (!chosen.Enabled) throw new Refusal("\"" + Limit(title, 60) + "\" is dimmed right now.", "retry");
    if (chosen.Submenu != IntPtr.Zero) throw new Refusal("\"" + Limit(title, 60) + "\" opens a submenu. Add the item inside it to the path.", "invalid");
    if (rules.Mode != "full") {
      // Quitting or closing where Reach lives would close Reach (as Ctrl+Q and Ctrl+W).
      if ((word.StartsWith("quit", StringComparison.Ordinal) || word.StartsWith("close", StringComparison.Ordinal) || word.StartsWith("exit", StringComparison.Ordinal)) &&
          (target.App.Reach || View.HostsReach(target.App.Pid, rules))) throw new Refusal(Policy.ReachReason, "blocked");
      if (Policy.MentionsReach(title, rules)) throw new Refusal(Policy.ReachReason, "blocked");
      if (rules.ProtectedTitleWords.Exists(protectedWord => protectedWord.Length > 0 && word.Contains(protectedWord)) || word.Contains("inspect element")) throw new Refusal(Policy.ProtectedReason, "blocked");
    }
    if (!PressClassic(new IntPtr(root), bar, steps) && !PressThroughUia(root, names)) throw new Refusal("That menu item couldn't be pressed. Use its shortcut key instead.", "retry");
    var result = Ok();
    result["app"] = target.App.Name;
    result["bundle"] = target.App.Bundle;
    var pressed = new List<string>();
    foreach (string name in names) pressed.Add(Limit(name, 80));
    result["pressed"] = string.Join(" " + (char)0x203A + " ", pressed);
    return result;
  }
  // A classic menu's item by its own command, as Windows sends it when the
  // item is chosen, the menu never shown (as a Mac's AXPress): the menus on
  // its path are first told to get ready, as before they open (an app may dim
  // the item then), and a dimmed item isn't pressed.
  static bool PressClassic(IntPtr window, IntPtr bar, List<KeyValuePair<IntPtr, MenuEntry>> path) {
    var item = path[path.Count - 1];
    if (item.Value.Id == 0 || item.Value.Id > 0xFFFF) return false;
    UIntPtr answer;
    Native.SendMessageTimeoutW(window, Native.WM_INITMENU, bar, IntPtr.Zero, Native.SMTO_ABORTIFHUNG, 500, out answer);
    for (int i = 0; i + 1 < path.Count; i++)
      Native.SendMessageTimeoutW(window, Native.WM_INITMENUPOPUP, path[i].Value.Submenu, new IntPtr(path[i].Value.Position & 0xFFFF), Native.SMTO_ABORTIFHUNG, 500, out answer);
    var info = new Native.MENUITEMINFO { cbSize = Marshal.SizeOf(typeof(Native.MENUITEMINFO)), fMask = Native.MIIM_STATE };
    if (!Native.GetMenuItemInfoW(item.Key, item.Value.Id, false, ref info)) return false;
    if ((info.fState & Native.MFS_DISABLED) != 0) throw new Refusal("\"" + Limit(item.Value.Title, 60) + "\" is dimmed right now.", "retry");
    return Native.PostMessageW(window, Native.WM_COMMAND, new IntPtr((int)item.Value.Id), IntPtr.Zero);
  }
  static bool PressThroughUia(long root, List<string> names) {
    try {
      Node level = MenuBarOf(root);
      if (level == null) return false;
      uint pid;
      Native.GetWindowThreadProcessId(new IntPtr(root), out pid);
      for (int i = 0; i < names.Count; i++) {
        Node item = null;
        foreach (var child in MenuChildren(level, (int)pid)) if (SameTitle(child.Name, names[i]) || Policy.NameMatch(child.Name, names[i]) == 2) { item = child; break; }
        if (item == null) return false;
        if (i == names.Count - 1) {
          var invoke = item.Element.GetCurrentPattern(Uia.InvokePattern) as IUIAutomationInvokePattern;
          if (invoke == null) return false;
          invoke.Invoke();
          return true;
        }
        var expand = item.Element.GetCurrentPattern(Uia.ExpandCollapsePattern) as IUIAutomationExpandCollapsePattern;
        if (expand == null) return false;
        expand.Expand();
        Thread.Sleep(150);
        level = item;
      }
    } catch (Exception) { }
    return false;
  }
  // A menu item's items: its own children, or the menu Windows opened for it
  // (a classic menu's popup is a window of its own).
  static List<Node> MenuChildren(Node level, int pid) {
    var items = Children(level).FindAll(child => child.ControlType == Uia.MenuItem);
    if (items.Count > 0) return items;
    foreach (var child in Children(level)) if (child.ControlType == Uia.Menu) return Children(child).FindAll(item => item.ControlType == Uia.MenuItem);
    try {
      var desktop = Node.Of(Uia.Automation.GetRootElement().BuildUpdatedCache(Uia.Structure));
      foreach (var top in Children(desktop))
        if (top.ControlType == Uia.Menu && top.Pid == pid) return Children(top).FindAll(item => item.ControlType == Uia.MenuItem);
    } catch (Exception) { }
    return items;
  }

  // --- wait-change (§8.5): UI Automation events count changes ----------------------
  static long screenRevision;
  internal static void Changed() { Interlocked.Increment(ref screenRevision); }
  static long watchedRoot;
  static readonly BlockingCollection<Action> uiaWork = new BlockingCollection<Action>();
  // Handlers are added and removed on one thread only (uia-events, MTA).
  static void UiaEvents() { foreach (var work in uiaWork.GetConsumingEnumerable()) { try { work(); } catch (Exception) { } } }
  static void WatchScreen() {
    long root = Native.GetAncestor(Native.GetForegroundWindow(), Native.GA_ROOT).ToInt64();
    if (root == watchedRoot || !uiaReady) return;
    watchedRoot = root;
    Changed();
    var done = new ManualResetEvent(false);
    uiaWork.Add(() => {
      try {
        Uia.Automation.RemoveAllEventHandlers();
        var changes = new Changes();
        Uia.Automation.AddFocusChangedEventHandler(null, changes);
        if (root != 0) {
          var element = Uia.Automation.ElementFromHandle(new IntPtr(root));
          Uia.Automation.AddStructureChangedEventHandler(element, Uia.ScopeSubtree, null, changes);
          Uia.Automation.AddPropertyChangedEventHandlerNativeArray(element, Uia.ScopeSubtree, null, changes, new[] { Uia.Name, Uia.ValueValue, Uia.BoundingRectangle }, 3);
        }
      } finally {
        done.Set();
      }
    });
    done.WaitOne(2000);
  }
  static Dictionary<string, object> WaitChange(long revision, int ms) {
    WatchScreen();
    var end = DateTime.UtcNow.AddMilliseconds(Math.Max(1, Math.Min(ms, 400)));
    while (Interlocked.Read(ref screenRevision) == revision) {
      double left = (end - DateTime.UtcNow).TotalMilliseconds;
      if (left <= 0) break;
      Thread.Sleep((int)Math.Min(50, Math.Ceiling(left)));
    }
    long now = Interlocked.Read(ref screenRevision);
    var result = Ok();
    result["revision"] = now;
    result["changed"] = now != revision;
    return result;
  }

  // A field showing what the agent typed from its vault is blacked out of the
  // screenshot, as its value is left out of the screen as text (redacted()).
  // Best effort: a window that can't be read is shown as it is.
  static void Redact(Graphics graphics, Box screen, Rules rules) {
    if (typedSecrets.Count == 0 || !uiaReady || rules.Mode == "view") return;
    Screen read;
    try { read = ReadScreen(rules, false, null); } catch (Exception) { return; }
    for (int i = 0; i < read.Controls.Count; i++) {
      var control = read.Controls[i];
      string value;
      if (!FieldRoles.Contains(control.Role) || control.Secure || !read.Values.TryGetValue(i, out value) || !value.Contains(Policy.Dots)) continue;
      graphics.FillRectangle(Brushes.Black, control.Frame.Left - screen.Left - 2, control.Frame.Top - screen.Top - 2, control.Frame.Width + 4, control.Frame.Height + 4);
    }
  }

  // --- Opening apps, websites and files (§9) ------------------------------------
  // The shell's work runs on a thread of its own (an STA, as the shell wants)
  // with eight seconds for each: a hung shell call answers "retry", and this
  // helper then ends so the next request starts afresh.
  static Thread shellThread;
  static readonly BlockingCollection<Action> shellWork = new BlockingCollection<Action>();
  static T OnShell<T>(Func<T> job, string late) {
    lock (shellWork) {
      if (shellThread == null) {
        shellThread = new Thread(() => {
          try {
            Native.CoInitializeEx(IntPtr.Zero, Native.COINIT_APARTMENTTHREADED | Native.COINIT_DISABLE_OLE1DDE);
            foreach (var work in shellWork.GetConsumingEnumerable()) work();
          } catch (Exception) {
            // Its callers time out and are answered.
          }
        }) { IsBackground = true, Name = "shell" };
        shellThread.Start();
      }
    }
    T result = default(T);
    Exception failure = null;
    var done = new ManualResetEvent(false);
    shellWork.Add(() => { try { result = job(); } catch (Exception error) { failure = error; } done.Set(); });
    if (!done.WaitOne(8000)) throw new Wedged(late, "retry");
    if (failure is Refusal) throw (Refusal)failure;
    if (failure != null) throw new Refusal("The app couldn't be opened.", "unavailable");
    return result;
  }
  const string AdminAppReason = "That app asks for administrator rights. The owner opens it at the PC.";
  static readonly Regex StoreId = new Regex("^[A-Za-z0-9.-]{3,50}_[0-9a-hjkmnp-tv-z]{13}![A-Za-z][A-Za-z0-9]*(?:\\.[A-Za-z][A-Za-z0-9]*)*$", RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
  static bool IsStoreId(string id) { try { return id != null && id.Length <= 130 && StoreId.IsMatch(id); } catch (RegexMatchTimeoutException) { return false; } }
  // An absolute program path, as Windows keeps it: X:\..., no share or device
  // path, no stream, no name ending in a dot or a space, no control character.
  static bool PlainPath(string path) {
    if (string.IsNullOrEmpty(path) || path.Length > 4096 || path.Length < 4 || !char.IsLetter(path[0]) || path[1] != ':' || path[2] != '\\') return false;
    if (path.IndexOf(':', 2) >= 0) return false;
    foreach (char c in path) if (c < 0x20 || c == '/' || c == '"' || c == '<' || c == '>' || c == '|' || c == '?' || c == '*') return false;
    foreach (string name in path.Substring(3).Split('\\')) if (name.Length == 0 || name.EndsWith(".", StringComparison.Ordinal) || name.EndsWith(" ", StringComparison.Ordinal)) return false;
    return true;
  }
  // An app by its catalog id: a Store app's id, or a program's path.
  static Ident AppIdentity(string id) {
    if (IsStoreId(id)) return new Ident { Bundle = id, Path = id, Name = id.Substring(0, id.IndexOf('_')), Known = true, Packaged = true, Integrity = ownIntegrity };
    if (PlainPath(id) && id.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) && File.Exists(id)) {
      string canonical = CanonicalFile(id);
      if (canonical == null) return null;
      return new Ident { Bundle = "exe:" + FileOf(canonical).ToLowerInvariant(), Path = canonical, Image = canonical, Name = Description(canonical), Known = true, Integrity = ownIntegrity };
    }
    return null;
  }
  // A file's one true name, from a handle to it (long names, real letters'
  // case, links followed); null when it can't be opened.
  static string CanonicalFile(string path) {
    IntPtr handle = Native.CreateFileW(path, Native.FILE_READ_ATTRIBUTES, Native.FILE_SHARE_READ | Native.FILE_SHARE_WRITE, IntPtr.Zero, Native.OPEN_EXISTING, Native.FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero);
    if (handle == new IntPtr(-1)) return null;
    try { return FinalPath(handle); } finally { Native.CloseHandle(handle); }
  }
  static string FinalPath(IntPtr handle) {
    var name = new StringBuilder(32768);
    int length = Native.GetFinalPathNameByHandleW(handle, name, name.Capacity, 0);
    if (length <= 0 || length >= name.Capacity) return null;
    string path = name.ToString(0, length);
    if (path.StartsWith("\\\\?\\UNC\\", StringComparison.OrdinalIgnoreCase)) return null;
    if (path.StartsWith("\\\\?\\", StringComparison.Ordinal)) path = path.Substring(4);
    return PlainPath(path) || (path.Length == 3 && path[1] == ':') ? path : null;
  }

  // A program that would ask for administrator rights is never started: its
  // manifest, or Windows' compatibility settings for it, say so. The check
  // works whether User Account Control is on or off.
  static readonly Regex Elevating = new Regex("level\\s*=\\s*[\"'](requireAdministrator|highestAvailable)[\"']", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
  static bool AsksForAdministrator(string exe) {
    IntPtr module = Native.LoadLibraryExW(exe, IntPtr.Zero, Native.LOAD_LIBRARY_AS_DATAFILE | Native.LOAD_LIBRARY_AS_IMAGE_RESOURCE);
    if (module == IntPtr.Zero) return true;
    try {
      IntPtr found = Native.FindResourceW(module, new IntPtr(1), new IntPtr(24));
      if (found != IntPtr.Zero) {
        IntPtr loaded = Native.LoadResource(module, found);
        IntPtr bytes = loaded == IntPtr.Zero ? IntPtr.Zero : Native.LockResource(loaded);
        int size = Native.SizeofResource(module, found);
        if (bytes != IntPtr.Zero && size > 0 && size < (1 << 20)) {
          var manifest = new byte[size];
          Marshal.Copy(bytes, manifest, 0, size);
          try { if (Elevating.IsMatch(Encoding.UTF8.GetString(manifest))) return true; } catch (RegexMatchTimeoutException) { return true; }
        }
      }
    } finally {
      Native.FreeLibrary(module);
    }
    foreach (var hive in new[] { Microsoft.Win32.Registry.CurrentUser, Microsoft.Win32.Registry.LocalMachine }) {
      try {
        using (var layers = hive.OpenSubKey("Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers")) {
          if (layers == null) continue;
          foreach (string name in layers.GetValueNames())
            if (string.Equals(name, exe, StringComparison.OrdinalIgnoreCase) && (layers.GetValue(name) as string ?? "").IndexOf("RUNASADMIN", StringComparison.OrdinalIgnoreCase) >= 0) return true;
        }
      } catch (Exception) { }
    }
    return false;
  }
  // A program started as the owner would start it: the user's own
  // environment (never this helper's), its own folder, no shell, never
  // elevated. Returns its process id.
  static int Start(string exe, string arguments) {
    if (AsksForAdministrator(exe)) throw new Refusal(AdminAppReason, "blocked");
    IntPtr token;
    if (!Native.OpenProcessToken(Native.GetCurrentProcess(), Native.TOKEN_QUERY | Native.TOKEN_DUPLICATE, out token)) throw new Refusal("The PC couldn't prepare that app's settings.", "unavailable");
    IntPtr environment = IntPtr.Zero;
    try {
      if (!Native.CreateEnvironmentBlock(out environment, token, false)) throw new Refusal("The PC couldn't prepare that app's settings.", "unavailable");
      var startup = new Native.STARTUPINFO { cb = Marshal.SizeOf(typeof(Native.STARTUPINFO)) };
      Native.PROCESS_INFORMATION started;
      var command = new StringBuilder("\"" + exe + "\"" + (string.IsNullOrEmpty(arguments) ? "" : " " + arguments));
      if (!Native.CreateProcessW(exe, command, IntPtr.Zero, IntPtr.Zero, false, Native.CREATE_UNICODE_ENVIRONMENT, environment, Path.GetDirectoryName(exe), ref startup, out started)) {
        if (Marshal.GetLastWin32Error() == Native.ERROR_ELEVATION_REQUIRED) throw new Refusal(AdminAppReason, "blocked");
        throw new Refusal("The app couldn't be opened.", "unavailable");
      }
      Native.CloseHandle(started.hThread);
      Native.CloseHandle(started.hProcess);
      return started.dwProcessId;
    } finally {
      if (environment != IntPtr.Zero) Native.DestroyEnvironmentBlock(environment);
      Native.CloseHandle(token);
    }
  }
  static readonly Guid ApplicationActivationManager = new Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C");
  static readonly Guid ShellItemId = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), ShellItemArrayId = new Guid("b63ea76d-1f85-456f-a19c-48159efa858b");
  static IApplicationActivationManager ActivationManager() { return (IApplicationActivationManager)System.Activator.CreateInstance(System.Type.GetTypeFromCLSID(ApplicationActivationManager)); }
  static IShellItemArray ItemsOf(string parsingName) {
    Guid item = ShellItemId, array = ShellItemArrayId;
    var shellItem = (IShellItem)Native.SHCreateItemFromParsingName(parsingName, IntPtr.Zero, ref item);
    return (IShellItemArray)Native.SHCreateShellItemArrayFromShellItem(shellItem, ref array);
  }
  // A window of this app's, the first Windows lists.
  static IntPtr WindowOf(Ident app) {
    IntPtr found = IntPtr.Zero;
    var identities = new Dictionary<int, Ident>();
    Native.EnumWindowsProc each = (window, data) => {
      if (!Native.IsWindowVisible(window) || Native.GetWindow(window, Native.GW_OWNER) != IntPtr.Zero) return true;
      uint pid;
      Native.GetWindowThreadProcessId(window, out pid);
      Ident id;
      if (!identities.TryGetValue((int)pid, out id)) { id = Identify((int)pid); identities[(int)pid] = id; }
      if (id.Known && string.Equals(id.Path, app.Path, StringComparison.OrdinalIgnoreCase)) { found = window; return false; }
      return true;
    };
    Native.EnumWindows(each, IntPtr.Zero);
    GC.KeepAlive(each);
    return found;
  }
  static bool Raise(IntPtr window) {
    if (Native.IsIconic(window)) Native.ShowWindowAsync(window, Native.SW_RESTORE);
    Native.SetWindowPos(window, IntPtr.Zero, 0, 0, 0, 0, Native.SWP_NOACTIVATE | Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_ASYNCWINDOWPOS);
    Native.SetForegroundWindow(window);
    return WaitFront(window);
  }
  // "Opened" means in front: the agent's next click or key goes there.
  static bool WaitFrontApp(Ident app, int pid) {
    var deadline = DateTime.UtcNow.AddMilliseconds(1500);
    while (true) {
      uint front;
      Native.GetWindowThreadProcessId(Native.GetForegroundWindow(), out front);
      if (front != 0 && (front == pid || string.Equals(Identify((int)front).Path, app.Path, StringComparison.OrdinalIgnoreCase))) return true;
      if (DateTime.UtcNow >= deadline) return false;
      Thread.Sleep(50);
    }
  }

  // open: one app, within the rules; its window brought forward if it has
  // one (as macOS activates a running app), else started.
  static Dictionary<string, object> Open(string id, Rules rules) {
    if (rules.Mode == "view") throw new Refusal("This agent can only look.", "blocked");
    var app = AppIdentity(id);
    if (app == null) throw new Refusal("Choose an app on this Windows PC.", "invalid");
    string reason = AppVerdict(app, rules);
    if (reason != null) throw new Refusal(reason, "blocked");
    var result = Ok();
    result["app"] = app.Name;
    result["bundle"] = app.Bundle;
    IntPtr window = WindowOf(app);
    if (window != IntPtr.Zero) {
      var w = ReadDecided(window, rules);
      reason = Verdict(w, rules, false);
      if (reason != null) throw new Refusal(reason, "blocked");
      RuleT(w.Id);
      result["front"] = Raise(window);
      return result;
    }
    int pid = app.Packaged
      ? OnShell(() => (int)ActivationManager().ActivateApplication(app.Bundle, null, 0), "The app is taking too long to open.")
      : Start(app.Path, null);
    result["front"] = WaitFrontApp(app, pid);
    return result;
  }

  // open-url: a website in the owner's own browser (the default for web
  // links, or one chosen), a browser checked as any app; the address goes to
  // that browser alone, as one quoted argument.
  static readonly string[] BrowserPrograms = { "chrome.exe", "msedge.exe", "firefox.exe", "brave.exe", "opera.exe", "vivaldi.exe" };
  static Dictionary<string, object> OpenUrl(string text, string browser, Rules rules) {
    if (rules.Mode == "view") throw new Refusal("This agent can only look.", "blocked");
    var url = text == null || Encoding.UTF8.GetByteCount(text) > 2048 ? null : Url.Parse(text);
    if (url == null || (Policy.Lower(url.Scheme ?? "") != "http" && Policy.Lower(url.Scheme ?? "") != "https") || string.IsNullOrEmpty(url.Host) || text.IndexOfAny(new[] { ' ', '"', '\t', '\r', '\n' }) >= 0)
      throw new Refusal("Give a web address that starts with https://.", "invalid");
    string reason = Policy.UrlReason(text, rules);
    if (reason != null) throw new Refusal(reason, "blocked");
    Ident app = string.IsNullOrEmpty(browser) ? DefaultBrowser() : AppIdentity(browser);
    if (app == null) throw new Refusal("There is no browser to open it in.", "unavailable");
    if (!IsBrowserApp(app)) throw new Refusal("Open websites in a web browser.", "invalid");
    reason = AppVerdict(app, rules);
    if (reason != null) throw new Refusal(reason, "blocked");
    int pid = app.Packaged
      ? OnShell(() => (int)ActivationManager().ActivateForProtocol(app.Bundle, ItemsOf(text)), "The browser is taking too long to open.")
      : Start(app.Path, "\"" + text + "\"");
    var result = Ok();
    result["app"] = app.Name;
    result["bundle"] = app.Bundle;
    result["front"] = WaitFrontApp(app, pid);
    return result;
  }
  static bool IsBrowserApp(Ident app) {
    if (app.Packaged) {
      string id = app.Bundle.ToLowerInvariant();
      return id.StartsWith("thebrowsercompany.arc_", StringComparison.Ordinal) || id.StartsWith("mozilla.firefox_", StringComparison.Ordinal) || id.StartsWith("duckduckgo.desktopbrowser_", StringComparison.Ordinal);
    }
    return System.Array.IndexOf(BrowserPrograms, FileOf(app.Path).ToLowerInvariant()) >= 0;
  }
  static string Association(uint flags, int kind, string what) {
    var text = new StringBuilder(4096);
    uint length = (uint)text.Capacity;
    return Native.AssocQueryStringW(flags, kind, what, null, text, ref length) == 0 ? text.ToString() : "";
  }
  static Ident DefaultBrowser() {
    string appId = Association(Native.ASSOCF_IS_PROTOCOL, Native.ASSOCSTR_APPID, "https");
    if (IsStoreId(appId) && PackageInstalled(appId)) return AppIdentity(appId);
    string exe = Association(Native.ASSOCF_IS_PROTOCOL, Native.ASSOCSTR_EXECUTABLE, "https");
    return exe.Length > 0 ? AppIdentity(exe) : null;
  }
  // Whether a Store app's package is installed for this user.
  static bool PackageInstalled(string aumid) {
    string family = aumid.Substring(0, aumid.IndexOf('!'));
    uint count = 0, length = 0;
    int error = Native.GetPackagesByPackageFamily(family, ref count, IntPtr.Zero, ref length, IntPtr.Zero);
    return (error == 0 || error == 122) && count > 0;
  }

  // open-file: a file opened in the app that owns it, or shown in File
  // Explorer: never a program or a script, never a protected file, never with
  // an app the agent may not use or one that runs what it opens.
  const string ProgramReason = "That file would run as a program. Open documents, not programs or scripts.";
  const string ProtectedPathReason = "That path holds your passwords, keys or Reach's own files.";
  static readonly string[] Runners = { "cmd", "powershell", "pwsh", "wscript", "cscript", "mshta", "msiexec", "regedit", "rundll32", "control", "mmc", "wt", "windowsterminal",
    "python", "pythonw", "node", "java", "javaw" };
  static Dictionary<string, object> OpenFile(string path, bool reveal, Rules rules) {
    if (rules.Mode == "view") throw new Refusal("This agent can only look.", "blocked");
    bool full = rules.Mode == "full";
    if (!PlainPath(path)) throw new Refusal("That file isn't there.", "invalid");
    IntPtr handle = Native.CreateFileW(path, Native.FILE_READ_ATTRIBUTES, Native.FILE_SHARE_READ | Native.FILE_SHARE_WRITE, IntPtr.Zero, Native.OPEN_EXISTING, Native.FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero);
    if (handle == new IntPtr(-1)) throw new Refusal("That file isn't there.", "invalid");
    // Held until it's opened: without shared delete, nobody renames or
    // removes it meanwhile.
    try {
      string canonical = FinalPath(handle);
      Native.BY_HANDLE_FILE_INFORMATION info;
      if (canonical == null || !Native.GetFileInformationByHandle(handle, out info)) throw new Refusal("That file isn't there.", "invalid");
      bool directory = (info.dwFileAttributes & Native.FILE_ATTRIBUTE_DIRECTORY) != 0;
      if (!full) {
        if ((info.dwFileAttributes & Native.FILE_ATTRIBUTE_REPARSE_POINT) != 0 || (!directory && info.nNumberOfLinks > 1))
          throw new Refusal("That file has another name elsewhere on the PC, so the agent leaves it alone.", "blocked");
        foreach (string root in ProtectedRoots(rules)) if (string.Equals(canonical, root, StringComparison.OrdinalIgnoreCase) || Within(canonical, root))
          throw new Refusal(ProtectedPathReason, "blocked");
        if (Policy.ProgramFile(canonical, rules) || (directory && Policy.Extension(canonical).Length > 0)) throw new Refusal(ProgramReason, "blocked");
      }
      var result = Ok();
      if (reveal || directory) {
        var explorer = new Ident { Bundle = "exe:explorer.exe", Path = Path.Combine(WindowsFolder(), "explorer.exe"), Image = Path.Combine(WindowsFolder(), "explorer.exe"), Name = "File Explorer", Known = true, Integrity = ownIntegrity };
        string reason = AppVerdict(explorer, rules);
        if (reason != null) throw new Refusal(reason, "blocked");
        OnShell(() => {
          IntPtr pidl;
          uint attributes;
          if (Native.SHParseDisplayName(canonical, IntPtr.Zero, out pidl, 0, out attributes) != 0) throw new Refusal("That file isn't there.", "invalid");
          try { return Native.SHOpenFolderAndSelectItems(pidl, 0, null, 0); } finally { Native.CoTaskMemFree(pidl); }
        }, "File Explorer is taking too long to open.");
        result["app"] = "File Explorer";
        result["bundle"] = "exe:explorer.exe";
        result["front"] = WaitFrontApp(explorer, 0);
        return result;
      }
      string extension = "." + Policy.Extension(canonical);
      // A Store app (Notepad, Photos, Media Player) opens it for its file contract.
      string appId = Association(0, Native.ASSOCSTR_APPID, extension);
      if (IsStoreId(appId) && PackageInstalled(appId)) {
        var store = AppIdentity(appId);
        string reason = AppVerdict(store, rules);
        if (reason != null) throw new Refusal(reason, "blocked");
        if (!full && Policy.TerminalLikeApp(store.Bundle, store.Name, store.Path, rules)) throw new Refusal(ProgramReason, "blocked");
        int pid = OnShell(() => (int)ActivationManager().ActivateForFile(appId, ItemsOf(canonical), "open"), "The app is taking too long to open the file.");
        result["app"] = store.Name;
        result["bundle"] = store.Bundle;
        result["front"] = WaitFrontApp(store, pid);
        return result;
      }
      // Handlers that run inside the shell can't be checked: refused.
      if (Association(0, Native.ASSOCSTR_DELEGATEEXECUTE, extension).Length > 0 || Association(0, Native.ASSOCSTR_DDECOMMAND, extension).Length > 0)
        throw new Refusal("No app on this Windows PC opens that file.", "unavailable");
      string command = Association(0, Native.ASSOCSTR_COMMAND, extension), executable = Association(0, Native.ASSOCSTR_EXECUTABLE, extension);
      string arguments;
      string program = HandlerProgram(command, executable, canonical, out arguments);
      if (program == null) throw new Refusal("No app on this Windows PC opens that file.", "unavailable");
      var handler = AppIdentity(program);
      if (handler == null) throw new Refusal("No app on this Windows PC opens that file.", "unavailable");
      string verdict = AppVerdict(handler, rules);
      if (verdict != null) throw new Refusal(verdict, "blocked");
      string name = FileOf(program).ToLowerInvariant();
      if (name.EndsWith(".exe", StringComparison.Ordinal)) name = name.Substring(0, name.Length - 4);
      if (!full && (System.Array.IndexOf(Runners, name) >= 0 || rules.RunnerApps.Contains(name) || Policy.TerminalLikeApp(handler.Bundle, handler.Name, handler.Path, rules)))
        throw new Refusal(ProgramReason, "blocked");
      int started = Start(handler.Path, arguments);
      result["app"] = handler.Name;
      result["bundle"] = handler.Bundle;
      result["front"] = WaitFrontApp(handler, started);
      return result;
    } finally {
      Native.CloseHandle(handle);
    }
  }
  // Each protected folder as it was given and as Windows names it (its long
  // name, links followed): a folder's alias is the folder.
  static List<string> ProtectedRoots(Rules rules) {
    var roots = new List<string>();
    foreach (string given in rules.ProtectedPaths) {
      string root = (given ?? "").TrimEnd('\\');
      if (root.Length == 0) continue;
      roots.Add(root);
      string named = PlainPath(root) ? CanonicalFile(root) : null;
      if (named != null && !string.Equals(named, root, StringComparison.OrdinalIgnoreCase)) roots.Add(named.TrimEnd('\\'));
    }
    return roots;
  }
  // The program an association's command runs, and its arguments with the
  // file in place: the program must be the association's own executable, and
  // the arguments only the file (%1, %L, quoted or not) and %*. Anything else
  // in it, and the file isn't opened.
  internal static string HandlerProgram(string command, string executable, string file, out string arguments) {
    arguments = null;
    if (string.IsNullOrEmpty(command) || string.IsNullOrEmpty(executable)) return null;
    string rest;
    string program;
    command = Environment.ExpandEnvironmentVariables(command.Trim());
    if (command.StartsWith("\"", StringComparison.Ordinal)) {
      int close = command.IndexOf('"', 1);
      if (close < 0) return null;
      program = command.Substring(1, close - 1);
      rest = command.Substring(close + 1);
    } else {
      int space = command.IndexOf(' ');
      program = space < 0 ? command : command.Substring(0, space);
      rest = space < 0 ? "" : command.Substring(space);
    }
    if (!PlainPath(program) || !program.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) || !string.Equals(program, Environment.ExpandEnvironmentVariables(executable), StringComparison.OrdinalIgnoreCase)) return null;
    var parts = new List<string>();
    foreach (string token in rest.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries)) {
      if (token == "%1" || token == "\"%1\"" || token == "%L" || token == "\"%L\"" || token == "%l" || token == "\"%l\"") parts.Add("\"" + file + "\"");
      else if (token == "%*") continue;
      else return null;
    }
    arguments = string.Join(" ", parts);
    return program;
  }

  // Where a File Explorer window is (the shell's own list of its windows):
  // its folder's parsing name; null when the shell won't say.
  static string ExplorerPlaceNow(IntPtr window) {
    try {
      return OnShell(() => {
        var shellWindows = System.Activator.CreateInstance(System.Type.GetTypeFromCLSID(new Guid("9BA05972-F6A8-11CF-A442-00A0C90A8F39")));
        Func<object, string, object> get = (target, name) => target.GetType().InvokeMember(name, System.Reflection.BindingFlags.GetProperty, null, target, null);
        int count = Convert.ToInt32(get(shellWindows, "Count"), CultureInfo.InvariantCulture);
        for (int i = 0; i < count && i < 64; i++) {
          object item = shellWindows.GetType().InvokeMember("Item", System.Reflection.BindingFlags.InvokeMethod, null, shellWindows, new object[] { i });
          if (item == null || Convert.ToInt64(get(item, "HWND"), CultureInfo.InvariantCulture) != window.ToInt64()) continue;
          object folder = get(get(item, "Document"), "Folder");
          return get(get(folder, "Self"), "Path") as string;
        }
        return null;
      }, "File Explorer is taking too long to answer.");
    } catch (Wedged) {
      throw;
    } catch (Exception) {
      return null;
    }
  }

  // --- The app catalog (§9) -------------------------------------------------
  // Every app in Start's list: a Store app by its id, a program by its path.
  static readonly Guid AppsFolder = new Guid("1e87508d-89c2-42f0-8a7e-645a0f50ca58"), EnumItems = new Guid("94f60519-2850-4924-aa5a-d15e84868039"),
    EnumShellItemsId = new Guid("70629033-e363-4a28-a567-0db78006e6d7");
  static Native.PROPERTYKEY Key(string format, uint id) { return new Native.PROPERTYKEY { fmtid = new Guid(format), pid = id }; }
  static Dictionary<string, object> Catalog() {
    var apps = OnShell(() => {
      var found = new SortedDictionary<string, Dictionary<string, object>>(StringComparer.OrdinalIgnoreCase);
      Guid folderId = AppsFolder, itemId = ShellItemId, enumId = EnumShellItemsId, handler = EnumItems;
      var folder = (IShellItem)Native.SHGetKnownFolderItem(ref folderId, 0, IntPtr.Zero, ref itemId);
      var items = (IEnumShellItems)folder.BindToHandler(IntPtr.Zero, ref handler, ref enumId);
      Native.PROPERTYKEY aumid = Key("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3", 5), family = Key("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3", 17), target = Key("B9B4B3FC-2B51-4A42-B5D8-324146AFCF25", 2);
      IShellItem item;
      uint fetched;
      while (found.Count < 1024 && items.Next(1, out item, out fetched) == 0 && fetched == 1) {
        var full = item as IShellItem2;
        if (full == null) continue;
        string name = Limit(full.GetDisplayName(0) ?? "", 100), id, packageFamily, link;
        if (full.GetString(ref aumid, out id) != 0) id = "";
        if (full.GetString(ref family, out packageFamily) != 0) packageFamily = "";
        if (full.GetString(ref target, out link) != 0) link = "";
        var entry = new Dictionary<string, object>();
        if (IsStoreId(id) && (packageFamily ?? "").Length > 0) { entry["id"] = id; entry["bundleId"] = id; }
        else if (!string.IsNullOrEmpty(link) && link.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) && PlainPath(link) && File.Exists(link)) {
          string canonical = CanonicalFile(link);
          if (canonical == null) continue;
          entry["id"] = canonical;
          entry["bundleId"] = "exe:" + FileOf(canonical).ToLowerInvariant();
        } else continue;
        entry["name"] = name;
        if (name.Length > 0 && !found.ContainsKey(name + "|" + entry["id"])) found[name + "|" + entry["id"]] = entry;
      }
      // File Explorer is offered as Finder is on a Mac (§16 D5), whatever
      // name Start gives it.
      string explorer = CanonicalFile(Path.Combine(WindowsFolder(), "explorer.exe"));
      bool listed = false;
      foreach (var entry in found.Values) if (explorer != null && string.Equals((string)entry["id"], explorer, StringComparison.OrdinalIgnoreCase)) listed = true;
      if (explorer != null && !listed)
        found["File Explorer|" + explorer] = new Dictionary<string, object> { { "id", explorer }, { "bundleId", "exe:explorer.exe" }, { "name", "File Explorer" } };
      return new List<Dictionary<string, object>>(found.Values);
    }, "The app list is taking too long.");
    // Running: some process's own path is the app's.
    var running = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    var seen = new HashSet<uint>();
    Native.EnumWindowsProc each = (window, data) => {
      uint pid;
      Native.GetWindowThreadProcessId(window, out pid);
      if (Native.IsWindowVisible(window) && seen.Add(pid)) { var id = Identify((int)pid); if (id.Known) running.Add(id.Path); }
      return true;
    };
    Native.EnumWindows(each, IntPtr.Zero);
    GC.KeepAlive(each);
    var list = new List<object>();
    foreach (var app in apps) { app["running"] = running.Contains((string)app["id"]); list.Add(app); }
    var result = Ok();
    result["apps"] = list;
    return result;
  }
}


sealed class WindowsView : IDesktopView {
  public Inventory Windows(Rules rules) { return Desk.InventoryNow(rules); }
  public Win RouteAt(int x, int y, Rules rules) {
    IntPtr window = Native.WindowFromPoint(new Native.POINT { X = x, Y = y });
    IntPtr root = window == IntPtr.Zero ? IntPtr.Zero : Native.GetAncestor(window, Native.GA_ROOT);
    return root == IntPtr.Zero ? null : Desk.ReadDecided(root, rules);
  }
  public Win Foreground(Rules rules) {
    IntPtr root = Native.GetAncestor(Native.GetForegroundWindow(), Native.GA_ROOT);
    return root == IntPtr.Zero ? null : Desk.ReadDecided(root, rules);
  }
  public int ForegroundIntegrity() {
    IntPtr front = Native.GetForegroundWindow();
    if (front == IntPtr.Zero) return -2;
    IntPtr root = Native.GetAncestor(front, Native.GA_ROOT);
    uint pid;
    Native.GetWindowThreadProcessId(root == IntPtr.Zero ? front : root, out pid);
    IntPtr process = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION, false, (int)pid);
    if (process == IntPtr.Zero) return -1;
    try { return Desk.IntegrityOf(process); } finally { Native.CloseHandle(process); }
  }
  public Seen ElementAt(int x, int y) { return Desk.UiaElementAt(x, y); }
  public Seen Focused() { return Desk.UiaFocused(); }
  public Box VirtualScreen() {
    int left = Native.GetSystemMetrics(Native.SM_XVIRTUALSCREEN), top = Native.GetSystemMetrics(Native.SM_YVIRTUALSCREEN);
    return new Box(left, top, left + Native.GetSystemMetrics(Native.SM_CXVIRTUALSCREEN), top + Native.GetSystemMetrics(Native.SM_CYVIRTUALSCREEN));
  }
  // The keyboard layout of the window the key goes to, not this helper's.
  static IntPtr Layout() {
    uint pid;
    return Native.GetKeyboardLayout(Native.GetWindowThreadProcessId(Native.GetForegroundWindow(), out pid));
  }
  public int KeyFor(char c) {
    short mapped = Native.VkKeyScanExW(c, Layout());
    return mapped == -1 ? -1 : mapped & 0xFFFF;
  }
  public ushort ScanFor(ushort vk) { return (ushort)Native.MapVirtualKeyExW(vk, Native.MAPVK_VK_TO_VSC, Layout()); }
  public bool HostsReach(int pid, Rules rules) { return Desk.HostsReach(pid, rules); }
  public string InputDesktop() { return Desk.InputDesktopName(); }
  public string ExplorerPlace(long window) { return Desk.ExplorerPlaceCached(new IntPtr(window)); }
}

sealed class WindowsInput : IInput {
  public bool KeyDown(int vk) { return (Native.GetAsyncKeyState(vk) & 0x8000) != 0; }
  public uint Send(Native.INPUT[] batch) { return Native.SendInput((uint)batch.Length, batch, Marshal.SizeOf(typeof(Native.INPUT))); }
  public void Pause(int ms) { Thread.Sleep(ms); }
  public int DoubleClickMs() { return (int)Math.Min(5000, Native.GetDoubleClickTime()); }
  public int DoubleClickSize() { return Math.Max(Native.GetSystemMetrics(Native.SM_CXDOUBLECLK), Native.GetSystemMetrics(Native.SM_CYDOUBLECLK)); }
}

// The clipboard, from a thread of its own that owns a message-only window (a
// clipboard owner must answer Windows' messages) and pumps them. Each use has
// a second: reading another app's delayed data can hang, and a helper whose
// clipboard thread hangs answers and ends (the next request starts afresh).
sealed class WindowsClip : IClip {
  static readonly object gate = new object();
  static readonly Queue<Action> work = new Queue<Action>();
  static Thread thread;
  static IntPtr window;
  static readonly ManualResetEvent ready = new ManualResetEvent(false);
  const string Busy = "The clipboard is busy. Type the text instead.";
  static T Run<T>(Func<T> job) {
    lock (gate) {
      if (thread == null) {
        thread = new Thread(Loop) { IsBackground = true, Name = "clipboard" };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
      }
    }
    if (!ready.WaitOne(5000) || window == IntPtr.Zero) throw new Refusal(Busy, "retry");
    T result = default(T);
    Exception failure = null;
    var done = new ManualResetEvent(false);
    lock (gate) work.Enqueue(() => { try { result = job(); } catch (Exception error) { failure = error; } done.Set(); });
    Native.PostMessageW(window, Native.WM_APP, IntPtr.Zero, IntPtr.Zero);
    if (!done.WaitOne(1000)) throw new Wedged(Busy, "retry");
    if (failure is Refusal) throw (Refusal)failure;
    if (failure != null) throw new Refusal(Busy, "retry");
    return result;
  }
  static void Loop() {
    try { Pump(); } catch (Exception) { ready.Set(); }
  }
  static void Pump() {
    window = Native.CreateWindowExW(0, "STATIC", "", 0, 0, 0, 0, 0, Native.HWND_MESSAGE, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
    ready.Set();
    Native.MSG message;
    while (Native.GetMessageW(out message, IntPtr.Zero, 0, 0) > 0) {
      if (message.message == Native.WM_APP) {
        while (true) {
          Action next;
          lock (gate) { if (work.Count == 0) break; next = work.Dequeue(); }
          next();
        }
        continue;
      }
      Native.TranslateMessage(ref message);
      Native.DispatchMessageW(ref message);
    }
  }
  static void Open() {
    for (int i = 0; i < 10; i++) {
      if (Native.OpenClipboard(window)) return;
      Thread.Sleep(20);
    }
    throw new Refusal(Busy, "retry");
  }
  public string Read() {
    return Run(() => {
      Open();
      try {
        if (!Native.IsClipboardFormatAvailable(Native.CF_UNICODETEXT)) return (string)null;
        IntPtr data = Native.GetClipboardData(Native.CF_UNICODETEXT);
        if (data == IntPtr.Zero) return null;
        IntPtr text = Native.GlobalLock(data);
        if (text == IntPtr.Zero) return null;
        try { return Marshal.PtrToStringUni(text); } finally { Native.GlobalUnlock(data); }
      } finally {
        Native.CloseClipboard();
      }
    });
  }
  // Text (or nothing) with the three formats that keep it out of Clipboard
  // History, cloud sync and clipboard monitors.
  public void Write(string text) {
    Run(() => {
      Open();
      try {
        Native.EmptyClipboard();
        if (text == null) return true;
        Put(Native.CF_UNICODETEXT, Encoding.Unicode.GetBytes(text + "\0"));
        foreach (string name in new[] { "ExcludeClipboardContentFromMonitorProcessing", "CanIncludeInClipboardHistory", "CanUploadToCloudClipboard" }) {
          uint format = Native.RegisterClipboardFormatW(name);
          if (format != 0) Put(format, new byte[4]);
        }
        return true;
      } finally {
        Native.CloseClipboard();
      }
    });
  }
  static void Put(uint format, byte[] bytes) {
    IntPtr memory = Native.GlobalAlloc(Native.GMEM_MOVEABLE, new UIntPtr((uint)bytes.Length));
    if (memory == IntPtr.Zero) throw new Refusal(Busy, "retry");
    IntPtr at = Native.GlobalLock(memory);
    if (at == IntPtr.Zero) { Native.GlobalFree(memory); throw new Refusal(Busy, "retry"); }
    Marshal.Copy(bytes, 0, at, bytes.Length);
    Native.GlobalUnlock(memory);
    if (Native.SetClipboardData(format, memory) == IntPtr.Zero) { Native.GlobalFree(memory); throw new Refusal(Busy, "retry"); }
  }
  public uint Sequence() { return Native.GetClipboardSequenceNumber(); }
}

// BEGIN NATIVE UIA
// The UI Automation client: Windows' own COM interfaces, declared as the
// Windows SDK's UIAutomationClient.idl lists them, member by member in order
// (a later member the helper never calls is left out; an earlier one is
// declared by its name). Start-up checks known answers before any is trusted.
static class Uia {
  public const int ScopeElement = 1, ScopeChildren = 2, ScopeSubtree = 7;
  public const int RuntimeId = 30000, BoundingRectangle = 30001, ProcessId = 30002, ControlType = 30003, LocalizedControlType = 30004, Name = 30005,
    IsEnabled = 30010, AutomationId = 30011, ClassName = 30012, HelpText = 30013, IsPassword = 30019, NativeWindowHandle = 30020, IsOffscreen = 30022,
    FrameworkId = 30024, IsExpandCollapsePatternAvailable = 30028, IsInvokePatternAvailable = 30031, IsScrollItemPatternAvailable = 30035,
    IsSelectionItemPatternAvailable = 30036, IsTogglePatternAvailable = 30041, IsValuePatternAvailable = 30043, ValueValue = 30045, ValueIsReadOnly = 30046,
    WindowIsModal = 30077, SelectionItemIsSelected = 30079, IsLegacyIAccessiblePatternAvailable = 30090, LegacyIAccessibleDefaultAction = 30100, AriaRole = 30101,
    FullDescription = 30159, HeadingLevel = 30173, IsDialog = 30174;
  public const int Button = 50000, CheckBox = 50002, ComboBox = 50003, Edit = 50004, Hyperlink = 50005, Image = 50006, ListItem = 50007, List = 50008,
    Menu = 50009, MenuBar = 50010, MenuItem = 50011, RadioButton = 50013, Slider = 50015, Spinner = 50016, Tab = 50018, TabItem = 50019, Text = 50020,
    ToolBar = 50021, TreeItem = 50024, Group = 50026, DataGrid = 50028, DataItem = 50029, Document = 50030, SplitButton = 50031, Window = 50032, Pane = 50033,
    Table = 50036, TitleBar = 50037;
  public const int InvokePattern = 10000, ExpandCollapsePattern = 10005, WindowPattern = 10009, SelectionItemPattern = 10010, TogglePattern = 10015,
    ScrollItemPattern = 10017, LegacyIAccessiblePattern = 10018;
  public const int FocusChangedEvent = 20005, StructureChangedEvent = 20002;
  static readonly Guid CUIAutomation8 = new Guid("e22ad333-b25f-460c-83d0-0581107395c9"), CUIAutomation = new Guid("ff48dba4-60ef-4201-aa87-54103eef594e");
  public static IUIAutomation Automation;
  public static IUIAutomationTreeWalker Walker;
  public static IUIAutomationCondition ControlView, ValueBearing;
  // Pass 1: an element's structure, never a value. Pass 2: a value, only
  // through ValueBearing (not a password, has a value), so a password field's
  // is never asked for.
  public static IUIAutomationCacheRequest Structure, Values;
  static readonly int[] StructureProperties = { RuntimeId, BoundingRectangle, ProcessId, ControlType, LocalizedControlType, Name, IsEnabled, AutomationId,
    ClassName, HelpText, IsPassword, NativeWindowHandle, IsOffscreen, FrameworkId, IsExpandCollapsePatternAvailable, IsInvokePatternAvailable,
    IsScrollItemPatternAvailable, IsSelectionItemPatternAvailable, IsTogglePatternAvailable, IsValuePatternAvailable, SelectionItemIsSelected,
    IsLegacyIAccessiblePatternAvailable, LegacyIAccessibleDefaultAction, AriaRole, FullDescription, HeadingLevel, IsDialog };

  public static bool Start() {
    try {
      object instance;
      try { instance = Activator.CreateInstance(Type.GetTypeFromCLSID(CUIAutomation8)); }
      catch (Exception) { instance = Activator.CreateInstance(Type.GetTypeFromCLSID(CUIAutomation)); }
      Automation = (IUIAutomation)instance;
      var timed = instance as IUIAutomation2;
      if (timed != null) { timed.put_ConnectionTimeout(1000); timed.put_TransactionTimeout(500); }
      // Known answers: the root is a pane whose window is the desktop's, and
      // the same as itself. Interfaces declared wrong would say otherwise.
      var root = Automation.GetRootElement();
      if (Number(root.GetCurrentPropertyValue(ControlType)) != Pane) return false;
      if (Number(root.GetCurrentPropertyValue(NativeWindowHandle)) != Native.GetDesktopWindow().ToInt64()) return false;
      if (Automation.CompareElements(root, root) == 0) return false;
      Walker = Automation.get_ControlViewWalker();
      ControlView = Automation.get_ControlViewCondition();
      ValueBearing = Automation.CreateAndCondition(Automation.CreatePropertyCondition(IsPassword, false), Automation.CreatePropertyCondition(IsValuePatternAvailable, true));
      Structure = Automation.CreateCacheRequest();
      foreach (int property in StructureProperties) {
        try { Structure.AddProperty(property); } catch (Exception) { } // newer than this Windows
      }
      Values = Automation.CreateCacheRequest();
      Values.AddProperty(ValueValue);
      Values.AddProperty(IsPassword);
      return true;
    } catch (Exception) {
      return false;
    }
  }
  public static long Number(object value) {
    if (value is int) return (int)value;
    if (value is long) return (long)value;
    if (value is uint) return (uint)value;
    if (value is short) return (short)value;
    if (value is double) return (long)(double)value;
    return long.MinValue;
  }
}

// One element as one read gave it (pass 1), never its value.
sealed class Node {
  public IUIAutomationElement Element;
  public int ControlType, Pid, Heading;
  public string Name = "", LocalizedType = "", AutomationId = "", Class = "", Help = "", Description = "", Framework = "", Aria = "", DefaultAction = "", Runtime = "";
  public Box Rect;
  public bool HasRect, Enabled = true, Offscreen, Password, Dialog, Invoke, Toggle, Select, Expand, ValuePattern, Legacy, Selected, ScrollItem;
  public long Window;
  public static Node Of(IUIAutomationElement element) {
    var node = new Node { Element = element };
    Func<int, object> get = id => { try { return element.GetCachedPropertyValue(id); } catch (Exception) { return null; } };
    Func<int, string> text = id => get(id) as string ?? "";
    Func<int, bool> flag = id => { object value = get(id); return value is bool && (bool)value; };
    node.ControlType = (int)Math.Max(int.MinValue, Uia.Number(get(Uia.ControlType)));
    node.Pid = (int)Math.Max(0, Uia.Number(get(Uia.ProcessId)));
    node.Name = text(Uia.Name);
    node.LocalizedType = text(Uia.LocalizedControlType);
    node.AutomationId = text(Uia.AutomationId);
    node.Class = text(Uia.ClassName);
    node.Help = text(Uia.HelpText);
    node.Description = text(Uia.FullDescription);
    node.Framework = text(Uia.FrameworkId);
    node.Aria = text(Uia.AriaRole);
    node.DefaultAction = text(Uia.LegacyIAccessibleDefaultAction);
    object enabled = get(Uia.IsEnabled);
    node.Enabled = !(enabled is bool) || (bool)enabled;
    node.Offscreen = flag(Uia.IsOffscreen);
    node.Password = flag(Uia.IsPassword);
    node.Dialog = flag(Uia.IsDialog);
    node.Invoke = flag(Uia.IsInvokePatternAvailable);
    node.Toggle = flag(Uia.IsTogglePatternAvailable);
    node.Select = flag(Uia.IsSelectionItemPatternAvailable);
    node.Expand = flag(Uia.IsExpandCollapsePatternAvailable);
    node.ValuePattern = flag(Uia.IsValuePatternAvailable);
    node.Legacy = flag(Uia.IsLegacyIAccessiblePatternAvailable);
    node.ScrollItem = flag(Uia.IsScrollItemPatternAvailable);
    node.Selected = flag(Uia.SelectionItemIsSelected);
    long heading = Uia.Number(get(Uia.HeadingLevel));
    node.Heading = heading > 80050 && heading < 80060 ? (int)(heading - 80050) : 0; // HeadingLevel1 is 80051
    long window = Uia.Number(get(Uia.NativeWindowHandle));
    node.Window = window == long.MinValue ? 0 : window;
    var rect = get(Uia.BoundingRectangle) as double[];
    if (rect != null && rect.Length == 4 && rect[2] > 0 && rect[3] > 0) {
      node.Rect = new Box((int)Math.Floor(rect[0]), (int)Math.Floor(rect[1]), (int)Math.Ceiling(rect[0] + rect[2]), (int)Math.Ceiling(rect[1] + rect[3]));
      node.HasRect = true;
    }
    var runtime = get(Uia.RuntimeId) as int[];
    node.Runtime = runtime != null ? string.Join(".", System.Array.ConvertAll(runtime, part => part.ToString(CultureInfo.InvariantCulture))) : "";
    return node;
  }
  // The role a Mac's accessibility would give it (§8.2): agents see the same words on both.
  public string Role(Node parent) {
    switch (ControlType) {
      case Uia.Button: return "AXButton";
      case Uia.SplitButton: return "AXMenuButton";
      case Uia.Hyperlink: return "AXLink";
      case Uia.CheckBox: return LocalizedType.IndexOf("toggle", StringComparison.OrdinalIgnoreCase) >= 0 ? "AXSwitch" : "AXCheckBox";
      case Uia.RadioButton: return "AXRadioButton";
      case Uia.ComboBox: return ValuePattern ? "AXComboBox" : "AXPopUpButton";
      case Uia.Edit:
        if (Password) return "AXSecureTextField";
        if (LocalizedType.IndexOf("search", StringComparison.OrdinalIgnoreCase) >= 0 || Aria == "searchbox") return "AXSearchField";
        return "AXTextField";
      case Uia.Document: return Web ? "AXWebArea" : ValuePattern ? "AXTextArea" : "AXGroup";
      case Uia.ToolBar: return "AXToolbar";
      case Uia.Window: return "AXWindow";
      case Uia.MenuBar: return "AXMenuBar";
      case Uia.MenuItem: return parent != null && parent.ControlType == Uia.MenuBar ? "AXMenuBarItem" : "AXMenuItem";
      case Uia.Menu: return "AXMenu";
      case Uia.Tab: return "AXTabGroup";
      case Uia.TabItem: return "AXTab";
      case Uia.Slider: return "AXSlider";
      case Uia.Spinner: return "AXIncrementor";
      case Uia.Text: return Heading > 0 || LocalizedType.IndexOf("heading", StringComparison.OrdinalIgnoreCase) >= 0 ? "AXHeading" : "AXStaticText";
      case Uia.Image: return "AXImage";
      case Uia.List: return "AXList";
      case Uia.ListItem: case Uia.TreeItem: case Uia.DataItem: return "AXRow";
      case Uia.Table: case Uia.DataGrid: return "AXTable";
      default: return "AXGroup";
    }
  }
  // A web page's document: Chromium and Firefox name their frameworks; any
  // document whose value is an address is one too (set by the reader).
  public bool Web;
  public bool Pressable { get { return Invoke || Toggle || Select || Expand || DefaultAction.Length > 0; } }
}
[ComImport, Guid("30cbe57d-d9d0-452a-ab13-7ac5ac4825ee"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IUIAutomation {
  int CompareElements(IUIAutomationElement el1, IUIAutomationElement el2);
  [PreserveSig] int CompareRuntimeIds();
  IUIAutomationElement GetRootElement();
  IUIAutomationElement ElementFromHandle(IntPtr hwnd);
  IUIAutomationElement ElementFromPoint(Native.POINT pt);
  IUIAutomationElement GetFocusedElement();
  [PreserveSig] int GetRootElementBuildCache();
  IUIAutomationElement ElementFromHandleBuildCache(IntPtr hwnd, IUIAutomationCacheRequest cacheRequest);
  IUIAutomationElement ElementFromPointBuildCache(Native.POINT pt, IUIAutomationCacheRequest cacheRequest);
  IUIAutomationElement GetFocusedElementBuildCache(IUIAutomationCacheRequest cacheRequest);
  [PreserveSig] int CreateTreeWalker();
  IUIAutomationTreeWalker get_ControlViewWalker();
  [PreserveSig] int get_ContentViewWalker();
  [PreserveSig] int get_RawViewWalker();
  [PreserveSig] int get_RawViewCondition();
  IUIAutomationCondition get_ControlViewCondition();
  [PreserveSig] int get_ContentViewCondition();
  IUIAutomationCacheRequest CreateCacheRequest();
  IUIAutomationCondition CreateTrueCondition();
  [PreserveSig] int CreateFalseCondition();
  IUIAutomationCondition CreatePropertyCondition(int propertyId, [MarshalAs(UnmanagedType.Struct)] object value);
  [PreserveSig] int CreatePropertyConditionEx();
  IUIAutomationCondition CreateAndCondition(IUIAutomationCondition condition1, IUIAutomationCondition condition2);
  [PreserveSig] int CreateAndConditionFromArray();
  [PreserveSig] int CreateAndConditionFromNativeArray();
  [PreserveSig] int CreateOrCondition();
  [PreserveSig] int CreateOrConditionFromArray();
  [PreserveSig] int CreateOrConditionFromNativeArray();
  [PreserveSig] int CreateNotCondition();
  [PreserveSig] int AddAutomationEventHandler();
  [PreserveSig] int RemoveAutomationEventHandler();
  void AddPropertyChangedEventHandlerNativeArray(IUIAutomationElement element, int scope, IUIAutomationCacheRequest cacheRequest, IUIAutomationPropertyChangedEventHandler handler, [MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 5)] int[] propertyArray, int propertyCount);
  [PreserveSig] int AddPropertyChangedEventHandler();
  [PreserveSig] int RemovePropertyChangedEventHandler();
  void AddStructureChangedEventHandler(IUIAutomationElement element, int scope, IUIAutomationCacheRequest cacheRequest, IUIAutomationStructureChangedEventHandler handler);
  [PreserveSig] int RemoveStructureChangedEventHandler();
  void AddFocusChangedEventHandler(IUIAutomationCacheRequest cacheRequest, IUIAutomationFocusChangedEventHandler handler);
  [PreserveSig] int RemoveFocusChangedEventHandler();
  void RemoveAllEventHandlers();
}
[ComImport, Guid("d22108aa-8ac5-49a5-837b-37bbb3d7591e"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IUIAutomationElement {
  [PreserveSig] int SetFocus();
  [return: MarshalAs(UnmanagedType.SafeArray, SafeArraySubType = VarEnum.VT_I4)] int[] GetRuntimeId();
  [PreserveSig] int FindFirst();
  [PreserveSig] int FindAll();
  IUIAutomationElement FindFirstBuildCache(int scope, IUIAutomationCondition condition, IUIAutomationCacheRequest cacheRequest);
  IUIAutomationElementArray FindAllBuildCache(int scope, IUIAutomationCondition condition, IUIAutomationCacheRequest cacheRequest);
  IUIAutomationElement BuildUpdatedCache(IUIAutomationCacheRequest cacheRequest);
  [return: MarshalAs(UnmanagedType.Struct)] object GetCurrentPropertyValue(int propertyId);
  [PreserveSig] int GetCurrentPropertyValueEx();
  [return: MarshalAs(UnmanagedType.Struct)] object GetCachedPropertyValue(int propertyId);
  [PreserveSig] int GetCachedPropertyValueEx();
  [PreserveSig] int GetCurrentPatternAs();
  [PreserveSig] int GetCachedPatternAs();
  [return: MarshalAs(UnmanagedType.IUnknown)] object GetCurrentPattern(int patternId);
}
[ComImport, Guid("14314595-b4bc-4055-95f2-58f2e42c9855"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IUIAutomationElementArray {
  int get_Length();
  IUIAutomationElement GetElement(int index);
}
[ComImport, Guid("b32a92b5-bc25-4078-9c08-d7ee95c48e03"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IUIAutomationCacheRequest {
  void AddProperty(int propertyId);
  [PreserveSig] int AddPattern();
  [PreserveSig] int Clone();
  [PreserveSig] int get_TreeScope();
  void put_TreeScope(int scope);
  [PreserveSig] int get_TreeFilter();
  void put_TreeFilter(IUIAutomationCondition filter);
  [PreserveSig] int get_AutomationElementMode();
  void put_AutomationElementMode(int mode);
}
[ComImport, Guid("352ffba8-0973-437c-a61f-f64cafd81df9"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IUIAutomationCondition {
}
[ComImport, Guid("4042c624-389c-4afc-a630-9df854a541fc"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IUIAutomationTreeWalker {
  IUIAutomationElement GetParentElement(IUIAutomationElement element);
  [PreserveSig] int GetFirstChildElement();
  [PreserveSig] int GetLastChildElement();
  [PreserveSig] int GetNextSiblingElement();
  [PreserveSig] int GetPreviousSiblingElement();
  [PreserveSig] int NormalizeElement();
  IUIAutomationElement GetParentElementBuildCache(IUIAutomationElement element, IUIAutomationCacheRequest cacheRequest);
}
[ComImport, Guid("fb377fbe-8ea6-46d5-9c73-6499642d3059"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IUIAutomationInvokePattern {
  void Invoke();
}
[ComImport, Guid("94cf8058-9b8d-4ab9-8bfd-4cd0a33c8c70"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IUIAutomationTogglePattern {
  void Toggle();
}
[ComImport, Guid("a8efa66a-0fda-421a-9194-38021f3578ea"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IUIAutomationSelectionItemPattern {
  void Select();
}
[ComImport, Guid("619be086-1f4e-4ee4-bafa-210128738730"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IUIAutomationExpandCollapsePattern {
  void Expand();
}
[ComImport, Guid("b488300f-d015-4f19-9c29-bb595e3645ef"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IUIAutomationScrollItemPattern {
  void ScrollIntoView();
}
[ComImport, Guid("828055ad-355b-4435-86d5-3b51c14a9b1b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IUIAutomationLegacyIAccessiblePattern {
  [PreserveSig] int Select();
  void DoDefaultAction();
}
[ComImport, Guid("34723aff-0c9d-49d0-9896-7ab52df8cd8a"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IUIAutomation2 {
  int CompareElements(IUIAutomationElement el1, IUIAutomationElement el2);
  [PreserveSig] int CompareRuntimeIds();
  IUIAutomationElement GetRootElement();
  IUIAutomationElement ElementFromHandle(IntPtr hwnd);
  IUIAutomationElement ElementFromPoint(Native.POINT pt);
  IUIAutomationElement GetFocusedElement();
  [PreserveSig] int GetRootElementBuildCache();
  IUIAutomationElement ElementFromHandleBuildCache(IntPtr hwnd, IUIAutomationCacheRequest cacheRequest);
  IUIAutomationElement ElementFromPointBuildCache(Native.POINT pt, IUIAutomationCacheRequest cacheRequest);
  IUIAutomationElement GetFocusedElementBuildCache(IUIAutomationCacheRequest cacheRequest);
  [PreserveSig] int CreateTreeWalker();
  IUIAutomationTreeWalker get_ControlViewWalker();
  [PreserveSig] int get_ContentViewWalker();
  [PreserveSig] int get_RawViewWalker();
  [PreserveSig] int get_RawViewCondition();
  IUIAutomationCondition get_ControlViewCondition();
  [PreserveSig] int get_ContentViewCondition();
  IUIAutomationCacheRequest CreateCacheRequest();
  IUIAutomationCondition CreateTrueCondition();
  [PreserveSig] int CreateFalseCondition();
  IUIAutomationCondition CreatePropertyCondition(int propertyId, [MarshalAs(UnmanagedType.Struct)] object value);
  [PreserveSig] int CreatePropertyConditionEx();
  IUIAutomationCondition CreateAndCondition(IUIAutomationCondition condition1, IUIAutomationCondition condition2);
  [PreserveSig] int CreateAndConditionFromArray();
  [PreserveSig] int CreateAndConditionFromNativeArray();
  [PreserveSig] int CreateOrCondition();
  [PreserveSig] int CreateOrConditionFromArray();
  [PreserveSig] int CreateOrConditionFromNativeArray();
  [PreserveSig] int CreateNotCondition();
  [PreserveSig] int AddAutomationEventHandler();
  [PreserveSig] int RemoveAutomationEventHandler();
  void AddPropertyChangedEventHandlerNativeArray(IUIAutomationElement element, int scope, IUIAutomationCacheRequest cacheRequest, IUIAutomationPropertyChangedEventHandler handler, [MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 5)] int[] propertyArray, int propertyCount);
  [PreserveSig] int AddPropertyChangedEventHandler();
  [PreserveSig] int RemovePropertyChangedEventHandler();
  void AddStructureChangedEventHandler(IUIAutomationElement element, int scope, IUIAutomationCacheRequest cacheRequest, IUIAutomationStructureChangedEventHandler handler);
  [PreserveSig] int RemoveStructureChangedEventHandler();
  void AddFocusChangedEventHandler(IUIAutomationCacheRequest cacheRequest, IUIAutomationFocusChangedEventHandler handler);
  [PreserveSig] int RemoveFocusChangedEventHandler();
  void RemoveAllEventHandlers();
  [PreserveSig] int IntNativeArrayToSafeArray();
  [PreserveSig] int IntSafeArrayToNativeArray();
  [PreserveSig] int RectToVariant();
  [PreserveSig] int VariantToRect();
  [PreserveSig] int SafeArrayToRectNativeArray();
  [PreserveSig] int CreateProxyFactoryEntry();
  [PreserveSig] int get_ProxyFactoryMapping();
  [PreserveSig] int GetPropertyProgrammaticName();
  [PreserveSig] int GetPatternProgrammaticName();
  [PreserveSig] int PollForPotentialSupportedPatterns();
  [PreserveSig] int PollForPotentialSupportedProperties();
  [PreserveSig] int CheckNotSupported();
  [PreserveSig] int get_ReservedNotSupportedValue();
  [PreserveSig] int get_ReservedMixedAttributeValue();
  [PreserveSig] int ElementFromIAccessible();
  [PreserveSig] int ElementFromIAccessibleBuildCache();
  [PreserveSig] int get_AutoSetFocus();
  [PreserveSig] int put_AutoSetFocus();
  [PreserveSig] int get_ConnectionTimeout();
  void put_ConnectionTimeout(uint timeout);
  [PreserveSig] int get_TransactionTimeout();
  void put_TransactionTimeout(uint timeout);
}
[ComImport, Guid("c270f6b5-5c69-4290-9745-7a7f97169468"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IUIAutomationFocusChangedEventHandler {
  void HandleFocusChangedEvent(IUIAutomationElement sender);
}
[ComImport, Guid("e81d1b4e-11c5-42f8-9754-e7036c79f054"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IUIAutomationStructureChangedEventHandler {
  void HandleStructureChangedEvent(IUIAutomationElement sender, int changeType, [MarshalAs(UnmanagedType.SafeArray, SafeArraySubType = VarEnum.VT_I4)] int[] runtimeId);
}
[ComImport, Guid("40cd37d4-c756-4b0c-8c6f-bddfeeb13b50"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IUIAutomationPropertyChangedEventHandler {
  void HandlePropertyChangedEvent(IUIAutomationElement sender, int propertyId, [MarshalAs(UnmanagedType.Struct)] object newValue);
}

// UI Automation's events: each one only moves the change counter; a changed
// value is never read.
sealed class Changes : IUIAutomationFocusChangedEventHandler, IUIAutomationStructureChangedEventHandler, IUIAutomationPropertyChangedEventHandler {
  public void HandleFocusChangedEvent(IUIAutomationElement sender) { Desk.Changed(); }
  public void HandleStructureChangedEvent(IUIAutomationElement sender, int changeType, int[] runtimeId) { Desk.Changed(); }
  public void HandlePropertyChangedEvent(IUIAutomationElement sender, int propertyId, object newValue) { Desk.Changed(); }
}
// END NATIVE UIA

// BEGIN NATIVE SHELL
// The shell's own interfaces, declared as Windows' SDK lists them (each up to
// the last member the helper calls).
[ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IShellItem {
  [return: MarshalAs(UnmanagedType.Interface)] object BindToHandler(IntPtr pbc, [In] ref Guid bhid, [In] ref Guid riid);
  [PreserveSig] int GetParent();
  [return: MarshalAs(UnmanagedType.LPWStr)] string GetDisplayName(uint sigdnName);
}
[ComImport, Guid("7e9fb0d3-919f-4307-ab2e-9b1860310c93"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IShellItem2 {
  [PreserveSig] int BindToHandler();
  [PreserveSig] int GetParent();
  [return: MarshalAs(UnmanagedType.LPWStr)] string GetDisplayName(uint sigdnName);
  [PreserveSig] int GetAttributes();
  [PreserveSig] int Compare();
  [PreserveSig] int GetPropertyStore();
  [PreserveSig] int GetPropertyStoreWithCreateObject();
  [PreserveSig] int GetPropertyStoreForKeys();
  [PreserveSig] int GetPropertyDescriptionList();
  [PreserveSig] int Update();
  [PreserveSig] int GetProperty();
  [PreserveSig] int GetCLSID();
  [PreserveSig] int GetFileTime();
  [PreserveSig] int GetInt32();
  [PreserveSig] int GetString([In] ref Native.PROPERTYKEY key, [MarshalAs(UnmanagedType.LPWStr)] out string value);
}
[ComImport, Guid("70629033-e363-4a28-a567-0db78006e6d7"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IEnumShellItems {
  [PreserveSig] int Next(uint celt, out IShellItem item, out uint fetched);
}
[ComImport, Guid("b63ea76d-1f85-456f-a19c-48159efa858b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IShellItemArray {
}
[ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IApplicationActivationManager {
  uint ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, [MarshalAs(UnmanagedType.LPWStr)] string arguments, int options);
  uint ActivateForFile([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, IShellItemArray itemArray, [MarshalAs(UnmanagedType.LPWStr)] string verb);
  uint ActivateForProtocol([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, IShellItemArray itemArray);
}
// END NATIVE SHELL

// BEGIN NATIVE WIN32
// Windows' own functions, declared as Microsoft documents them.
static class Native {
  public const uint SEM_FAILCRITICALERRORS = 0x0001, SEM_NOGPFAULTERRORBOX = 0x0002;
  public const uint WER_FAULT_REPORTING_FLAG_NOHEAP = 1;
  public static readonly IntPtr DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = new IntPtr(-4);
  public const uint WS_POPUP = 0x80000000;
  public const uint TOKEN_QUERY = 0x0008;
  public const int TokenIntegrityLevel = 25;
  public const uint DESKTOP_READOBJECTS = 0x0001;
  public const int UOI_NAME = 2;
  public const uint SRCCOPY = 0x00CC0020, CAPTUREBLT = 0x40000000;
  public const uint SYNCHRONIZE = 0x00100000, PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  public const uint INFINITE = 0xFFFFFFFF;
  public const uint WINEVENT_OUTOFCONTEXT = 0x0000, WINEVENT_SKIPOWNPROCESS = 0x0002;
  public const uint EVENT_SYSTEM_FOREGROUND = 0x0003;
  public const uint EVENT_OBJECT_SHOW = 0x8002, EVENT_OBJECT_HIDE = 0x8003, EVENT_OBJECT_REORDER = 0x8004, EVENT_OBJECT_LOCATIONCHANGE = 0x800B,
    EVENT_OBJECT_NAMECHANGE = 0x800C, EVENT_OBJECT_CLOAKED = 0x8017, EVENT_OBJECT_UNCLOAKED = 0x8018;
  public const int OBJID_WINDOW = 0;
  public const uint GA_PARENT = 1, GA_ROOT = 2, GA_ROOTOWNER = 3;
  public const int ERROR_INVALID_HANDLE = 6;
  public const uint MONITORINFOF_PRIMARY = 1;
  public const uint EDD_GET_DEVICE_INTERFACE_NAME = 1;

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)]
  public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public POINT pt; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct MONITORINFOEX {
    public int cbSize;
    public RECT rcMonitor, rcWork;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DISPLAY_DEVICE {
    public int cb;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
    public uint StateFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;
  }
  // SendInput's INPUT: a type, then the union of MOUSEINPUT, KEYBDINPUT and
  // HARDWAREINPUT, laid out as Windows does (40 bytes on 64-bit, 28 on 32-bit).
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx, dy; public int mouseData; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)]
  public struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public INPUTUNION u; }

  public delegate bool MonitorEnumProc(IntPtr monitor, IntPtr dc, ref RECT rect, IntPtr data);
  public delegate void WinEventProc(IntPtr hook, uint kind, IntPtr window, int objectId, int childId, uint thread, uint time);
  public delegate bool ConsoleCtrlHandler(uint kind);

  [DllImport("kernel32.dll")] public static extern uint SetErrorMode(uint mode);
  [DllImport("kernel32.dll")] public static extern int WerSetFlags(uint flags);
  [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] public static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetConsoleCtrlHandler(ConsoleCtrlHandler handler, bool add);
  [DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] public static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr buffer, int size, out int needed);
  [DllImport("advapi32.dll")] public static extern bool IsValidSid(IntPtr sid);
  [DllImport("advapi32.dll")] public static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
  [DllImport("advapi32.dll")] public static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
  [DllImport("user32.dll")] public static extern IntPtr GetThreadDpiAwarenessContext();
  [DllImport("user32.dll")] public static extern bool AreDpiAwarenessContextsEqual(IntPtr a, IntPtr b);
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr CreateWindowExW(uint exStyle, string className, string title, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool DestroyWindow(IntPtr window);
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern int InternalGetWindowText(IntPtr window, StringBuilder text, int max);
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr window, StringBuilder name, int max);
  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool GetUserObjectInformationW(IntPtr handle, int index, byte[] info, int length, out int needed);
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr window);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr window, IntPtr dc);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr dc);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleBitmap(IntPtr dc, int width, int height);
  [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr dc, IntPtr item);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr item);
  [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr dc);
  [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr dest, int x, int y, int width, int height, IntPtr source, int sx, int sy, uint op);
  [DllImport("user32.dll")] public static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEventProc proc, uint pid, uint thread, uint flags);
  [DllImport("user32.dll")] public static extern int GetMessageW(out MSG message, IntPtr window, uint min, uint max);
  [DllImport("user32.dll")] public static extern bool TranslateMessage(ref MSG message);
  [DllImport("user32.dll")] public static extern IntPtr DispatchMessageW(ref MSG message);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetDesktopWindow();
  [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorEnumProc proc, IntPtr data);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfoW(IntPtr monitor, ref MONITORINFOEX info);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool EnumDisplayDevicesW(string device, uint index, ref DISPLAY_DEVICE info, uint flags);
  public const uint WS_EX_TOPMOST = 0x8, WS_EX_TRANSPARENT = 0x20, WS_EX_TOOLWINDOW = 0x80, WS_EX_APPWINDOW = 0x40000, WS_EX_LAYERED = 0x80000, WS_EX_NOREDIRECTIONBITMAP = 0x200000;
  public const int GWL_EXSTYLE = -20;
  public const uint LWA_COLORKEY = 0x1, LWA_ALPHA = 0x2;
  public const int DWMWA_EXTENDED_FRAME_BOUNDS = 9, DWMWA_CLOAKED = 14, DWMWA_SYSTEMBACKDROP_TYPE = 38;
  public const uint GW_OWNER = 4;
  public const int APPMODEL_ERROR_NO_PACKAGE = 15700;
  public const int PackagePathType_Effective = 2;
  public const uint CURSOR_SHOWING = 1, DI_NORMAL = 3;
  public const uint WTD_UI_NONE = 2, WTD_REVOKE_NONE = 0, WTD_CHOICE_FILE = 1, WTD_STATEACTION_VERIFY = 1, WTD_STATEACTION_CLOSE = 2,
    WTD_REVOCATION_CHECK_NONE = 0x10, WTD_CACHE_ONLY_URL_RETRIEVAL = 0x1000;
  public const int TRUST_E_NOSIGNATURE = unchecked((int)0x800B0100), TRUST_E_SUBJECT_FORM_UNKNOWN = unchecked((int)0x800B0003), TRUST_E_PROVIDER_UNKNOWN = unchecked((int)0x800B0001);
  public static readonly Guid WINTRUST_ACTION_GENERIC_VERIFY_V2 = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");

  [StructLayout(LayoutKind.Sequential)]
  public struct CURSORINFO { public int cbSize; public uint flags; public IntPtr hCursor; public POINT ptScreenPos; }
  [StructLayout(LayoutKind.Sequential)]
  public struct ICONINFO { public int fIcon; public uint xHotspot, yHotspot; public IntPtr hbmMask, hbmColor; }
  [StructLayout(LayoutKind.Sequential)]
  public struct WINTRUST_FILE_INFO { public uint cbStruct; public IntPtr pcwszFilePath; public IntPtr hFile; public IntPtr pgKnownSubject; }
  [StructLayout(LayoutKind.Sequential)]
  public struct WINTRUST_DATA {
    public uint cbStruct;
    public IntPtr pPolicyCallbackData, pSIPClientData;
    public uint dwUIChoice, fdwRevocationChecks, dwUnionChoice;
    public IntPtr pFile;
    public uint dwStateAction;
    public IntPtr hWVTStateData, pwszURLReference;
    public uint dwProvFlags, dwUIContext;
    public IntPtr pSignatureSettings;
  }
  public delegate bool EnumWindowsProc(IntPtr window, IntPtr data);

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref int size);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern int GetLongPathNameW(string shortPath, StringBuilder longPath, int size);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern int GetPackageFullName(IntPtr process, ref uint length, StringBuilder name);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern int GetApplicationUserModelId(IntPtr process, ref uint length, StringBuilder id);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern int GetPackagePathByFullName(string fullName, ref uint length, StringBuilder path);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern int GetPackagePathByFullName2(string fullName, int type, ref uint length, StringBuilder path);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc proc, IntPtr data);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowExW(IntPtr parent, IntPtr after, string className, string title);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int value, int size);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out RECT value, int size);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out RECT rect);
  [DllImport("user32.dll")] public static extern int GetWindowRgnBox(IntPtr window, out RECT rect);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtrW(IntPtr window, int index);
  [DllImport("user32.dll")] public static extern int GetWindowLongW(IntPtr window, int index);
  [DllImport("user32.dll")] public static extern bool GetLayeredWindowAttributes(IntPtr window, out uint key, out byte alpha, out uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CURSORINFO info);
  [DllImport("user32.dll")] public static extern bool GetIconInfo(IntPtr icon, out ICONINFO info);
  [DllImport("user32.dll")] public static extern bool DrawIconEx(IntPtr dc, int x, int y, IntPtr icon, int width, int height, int step, IntPtr brush, uint flags);
  [DllImport("wintrust.dll", CharSet = CharSet.Unicode)] public static extern int WinVerifyTrust(IntPtr window, ref Guid action, ref WINTRUST_DATA data);
  public const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
  public const uint MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004, MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010,
    MOUSEEVENTF_WHEEL = 0x0800, MOUSEEVENTF_HWHEEL = 0x1000, MOUSEEVENTF_VIRTUALDESK = 0x4000, MOUSEEVENTF_ABSOLUTE = 0x8000;
  public const uint KEYEVENTF_EXTENDEDKEY = 0x1, KEYEVENTF_KEYUP = 0x2, KEYEVENTF_UNICODE = 0x4;
  public const ushort VK_LBUTTON = 0x01, VK_RBUTTON = 0x02, VK_MBUTTON = 0x04, VK_RETURN = 0x0D, VK_SHIFT = 0x10, VK_CONTROL = 0x11, VK_MENU = 0x12, VK_LWIN = 0x5B, VK_RWIN = 0x5C;
  public const int SM_XVIRTUALSCREEN = 76, SM_YVIRTUALSCREEN = 77, SM_CXVIRTUALSCREEN = 78, SM_CYVIRTUALSCREEN = 79;
  public const uint CF_UNICODETEXT = 13, GMEM_MOVEABLE = 0x0002, WM_APP = 0x8000, MAPVK_VK_TO_VSC = 0;
  public static readonly IntPtr HWND_MESSAGE = new IntPtr(-3);
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern uint GetDoubleClickTime();
  public const int SM_CXDOUBLECLK = 36, SM_CYDOUBLECLK = 37;
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern short VkKeyScanExW(char c, IntPtr layout);
  [DllImport("user32.dll")] public static extern uint MapVirtualKeyExW(uint code, uint mapType, IntPtr layout);
  [DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint thread);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool OpenClipboard(IntPtr owner);
  [DllImport("user32.dll")] public static extern bool CloseClipboard();
  [DllImport("user32.dll")] public static extern bool EmptyClipboard();
  [DllImport("user32.dll")] public static extern IntPtr GetClipboardData(uint format);
  [DllImport("user32.dll")] public static extern IntPtr SetClipboardData(uint format, IntPtr data);
  [DllImport("user32.dll")] public static extern bool IsClipboardFormatAvailable(uint format);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern uint RegisterClipboardFormatW(string name);
  [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("kernel32.dll")] public static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
  [DllImport("kernel32.dll")] public static extern IntPtr GlobalLock(IntPtr memory);
  [DllImport("kernel32.dll")] public static extern bool GlobalUnlock(IntPtr memory);
  [DllImport("kernel32.dll")] public static extern IntPtr GlobalFree(IntPtr memory);
  public const uint MIIM_STATE = 0x1, MIIM_ID = 0x2, MIIM_SUBMENU = 0x4, MIIM_STRING = 0x40, MIIM_FTYPE = 0x100, MFT_SEPARATOR = 0x800, MFS_DISABLED = 0x3, MFS_CHECKED = 0x8;
  public const uint WM_COMMAND = 0x0111, WM_INITMENU = 0x0116, WM_INITMENUPOPUP = 0x0117, SMTO_ABORTIFHUNG = 0x2;
  [DllImport("user32.dll", SetLastError = true)]
  public static extern IntPtr SendMessageTimeoutW(IntPtr window, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint ms, out UIntPtr result);
  public const int SW_RESTORE = 9;
  public const uint SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOACTIVATE = 0x10, SWP_ASYNCWINDOWPOS = 0x4000;
  [StructLayout(LayoutKind.Sequential)]
  public struct MENUITEMINFO {
    public int cbSize;
    public uint fMask, fType, fState, wID;
    public IntPtr hSubMenu, hbmpChecked, hbmpUnchecked, dwItemData, dwTypeData;
    public uint cch;
    public IntPtr hbmpItem;
  }
  [DllImport("user32.dll")] public static extern IntPtr GetMenu(IntPtr window);
  [DllImport("user32.dll")] public static extern int GetMenuItemCount(IntPtr menu);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMenuItemInfoW(IntPtr menu, uint item, bool byPosition, ref MENUITEMINFO info);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  public const uint COINIT_APARTMENTTHREADED = 0x2, COINIT_DISABLE_OLE1DDE = 0x4;
  public const uint FILE_READ_ATTRIBUTES = 0x80, FILE_SHARE_READ = 0x1, FILE_SHARE_WRITE = 0x2, OPEN_EXISTING = 3, FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
  public const uint FILE_ATTRIBUTE_DIRECTORY = 0x10, FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
  public const uint LOAD_LIBRARY_AS_DATAFILE = 0x2, LOAD_LIBRARY_AS_IMAGE_RESOURCE = 0x20;
  public const uint TOKEN_DUPLICATE = 0x0002, CREATE_UNICODE_ENVIRONMENT = 0x400;
  public const int ERROR_ELEVATION_REQUIRED = 740;
  public const uint ASSOCF_IS_PROTOCOL = 0x1000;
  public const int ASSOCSTR_COMMAND = 1, ASSOCSTR_EXECUTABLE = 2, ASSOCSTR_DDECOMMAND = 7, ASSOCSTR_DELEGATEEXECUTE = 18, ASSOCSTR_APPID = 21;
  [StructLayout(LayoutKind.Sequential)]
  public struct PROPERTYKEY { public Guid fmtid; public uint pid; }
  // Its times are FILETIMEs (two DWORDs, 4-byte aligned), so it's packed at 4.
  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  public struct BY_HANDLE_FILE_INFORMATION {
    public uint dwFileAttributes;
    public long ftCreationTime, ftLastAccessTime, ftLastWriteTime;
    public uint dwVolumeSerialNumber, nFileSizeHigh, nFileSizeLow, nNumberOfLinks, nFileIndexHigh, nFileIndexLow;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb;
    public string lpReserved, lpDesktop, lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2;
    public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [DllImport("ole32.dll")] public static extern int CoInitializeEx(IntPtr reserved, uint flags);
  [DllImport("ole32.dll")] public static extern void CoTaskMemFree(IntPtr memory);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern int GetFinalPathNameByHandleW(IntPtr file, StringBuilder path, int length, uint flags);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetFileInformationByHandle(IntPtr file, out BY_HANDLE_FILE_INFORMATION info);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr LoadLibraryExW(string file, IntPtr reserved, uint flags);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr FindResourceW(IntPtr module, IntPtr name, IntPtr type);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr LoadResource(IntPtr module, IntPtr resource);
  [DllImport("kernel32.dll")] public static extern IntPtr LockResource(IntPtr data);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern int SizeofResource(IntPtr module, IntPtr resource);
  [DllImport("kernel32.dll")] public static extern bool FreeLibrary(IntPtr module);
  [DllImport("userenv.dll", SetLastError = true)] public static extern bool CreateEnvironmentBlock(out IntPtr environment, IntPtr token, bool inherit);
  [DllImport("userenv.dll")] public static extern bool DestroyEnvironmentBlock(IntPtr environment);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags,
    IntPtr environment, string directory, ref STARTUPINFO startup, out PROCESS_INFORMATION information);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern int GetPackagesByPackageFamily(string family, ref uint count, IntPtr names, ref uint length, IntPtr buffer);
  [DllImport("shell32.dll", PreserveSig = false)]
  [return: MarshalAs(UnmanagedType.Interface)] public static extern object SHGetKnownFolderItem([In] ref Guid folder, uint flags, IntPtr token, [In] ref Guid riid);
  [DllImport("shell32.dll", PreserveSig = false)]
  [return: MarshalAs(UnmanagedType.Interface)] public static extern object SHCreateItemFromParsingName([MarshalAs(UnmanagedType.LPWStr)] string path, IntPtr bindContext, [In] ref Guid riid);
  [DllImport("shell32.dll", PreserveSig = false)]
  [return: MarshalAs(UnmanagedType.Interface)] public static extern object SHCreateShellItemArrayFromShellItem(IShellItem item, [In] ref Guid riid);
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)] public static extern int SHParseDisplayName(string name, IntPtr bindContext, out IntPtr pidl, uint attributesIn, out uint attributesOut);
  [DllImport("shell32.dll")] public static extern int SHOpenFolderAndSelectItems(IntPtr folder, uint count, IntPtr[] items, uint flags);
  [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)] public static extern int AssocQueryStringW(uint flags, int kind, string association, string extra, StringBuilder output, ref uint length);
}
// END NATIVE WIN32
