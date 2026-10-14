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
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

sealed class Refusal : Exception {
  public readonly string Kind;
  public readonly List<object> Candidates;
  public Refusal(string message, string kind) : base(message) { Kind = kind; Candidates = new List<object>(); }
  public Refusal(string message, string kind, List<object> candidates) : base(message) { Kind = kind; Candidates = candidates ?? new List<object>(); }
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
    double value = double.Parse(s.Substring(start, at - start), NumberStyles.Float, CultureInfo.InvariantCulture);
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

static partial class Desk {
  // --- The protocol -------------------------------------------------------
  // One line at a time from stdin, as raw bytes: a line over 256 KiB, or one
  // that isn't strict UTF-8, is answered "Invalid request." and the next one
  // read. Console.In is never used (it decodes with the console's code page).
  const int MaxLine = 262144;
  static readonly string InvalidLine = new string('\0', 1);
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
    var line = new MemoryStream();
    var utf8 = new UTF8Encoding(false, true);
    bool skipping = false;
    try {
      while (true) {
        int count = input.Read(buffer, 0, buffer.Length);
        if (count <= 0) break;
        int start = 0;
        while (start < count) {
          int end = System.Array.IndexOf(buffer, (byte)10, start, count - start);
          int stop = end < 0 ? count : end;
          if (!skipping) {
            if (line.Length + (stop - start) > MaxLine) { skipping = true; line.SetLength(0); }
            else line.Write(buffer, start, stop - start);
          }
          if (end < 0) break;
          if (skipping) lines.Add(InvalidLine);
          else {
            byte[] bytes = line.ToArray();
            int length = bytes.Length;
            if (length > 0 && bytes[length - 1] == 13) length--;
            string text;
            try { text = utf8.GetString(bytes, 0, length); } catch (ArgumentException) { text = InvalidLine; }
            lines.Add(text);
          }
          line.SetLength(0);
          skipping = false;
          start = end + 1;
        }
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
  static int ownIntegrity = -1;
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
  static int IntegrityOf(IntPtr process) {
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
  static string InputDesktopName() {
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
    return null;
  }

  // --- Held input (§5.4) ----------------------------------------------------
  // What this helper holds down between a press and its release: buttons (at
  // the last point it sent for them) and keys. Stopped mid-click or mid-drag,
  // it lets go of them where it held them before exiting, so the owner never
  // inherits a held button. Once stopping, nothing more is sent.
  static readonly object heldLock = new object();
  static bool stopping;
  static readonly Dictionary<int, Native.POINT> heldButtons = new Dictionary<int, Native.POINT>();
  static readonly HashSet<ushort> heldKeys = new HashSet<ushort>();
  static void LetGo() {
    lock (heldLock) {
      stopping = true;
      heldButtons.Clear();
      heldKeys.Clear();
    }
  }

  // --- The app catalog (§9) -------------------------------------------------
  static Dictionary<string, object> Catalog() {
    throw new Refusal("The Windows PC couldn't do that.", "unavailable");
  }
}

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
}
// END NATIVE WIN32
