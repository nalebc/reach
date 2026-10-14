// A voice memo from the phone, as words, on this PC: Windows' own speech
// recognizer (System.Speech, on the PC, nothing sent anywhere), the twin of
// a Mac's scripts/native/transcribe.swift. The phone sends 16 kHz mono WAV
// (src/voice-memo.ts). `transcribe <wav file> [locale]` prints
// {"text": "...", "locale": "..."}; on failure it prints the reason to stderr
// and exits 1, and Reach attaches the recording instead.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Speech.Recognition;
using System.Text;
using System.Threading;

static class Transcribe {
  static int Fail(string message) {
    Console.Error.WriteLine(message);
    return 1;
  }
  static string Json(string value) {
    var out_ = new StringBuilder("\"");
    foreach (char c in value) {
      if (c == '"' || c == '\\') out_.Append('\\').Append(c);
      else if (c < 0x20) out_.Append("\\u").Append(((int)c).ToString("x4"));
      else out_.Append(c);
    }
    return out_.Append('"').ToString();
  }
  // The phone's language when this PC has a recognizer for it (its exact
  // culture, else the same language), else the PC's own language's.
  static RecognizerInfo Pick(string wanted) {
    var installed = SpeechRecognitionEngine.InstalledRecognizers();
    if (installed.Count == 0) return null;
    var tries = new List<CultureInfo>();
    try { if (!string.IsNullOrEmpty(wanted)) tries.Add(new CultureInfo(wanted.Replace('_', '-'))); } catch (CultureNotFoundException) {}
    tries.Add(CultureInfo.CurrentUICulture);
    tries.Add(CultureInfo.CurrentCulture);
    foreach (var culture in tries) {
      foreach (var r in installed) if (r.Culture.Name.Equals(culture.Name, StringComparison.OrdinalIgnoreCase)) return r;
      foreach (var r in installed) if (r.Culture.TwoLetterISOLanguageName == culture.TwoLetterISOLanguageName) return r;
    }
    return null;
  }
  static int Main(string[] args) {
    if (args.Length < 1) return Fail("usage: transcribe <wav file> [locale]");
    RecognizerInfo info;
    try { info = Pick(args.Length > 1 ? args[1] : null); }
    catch (Exception) { info = null; }
    if (info == null) return Fail("This PC has no speech recognizer for this language.");
    var words = new StringBuilder();
    using (var engine = new SpeechRecognitionEngine(info)) {
      try { engine.SetInputToWaveFile(args[0]); }
      catch (Exception) { return Fail("This recording's format can't be read on the PC."); }
      engine.LoadGrammar(new DictationGrammar());
      var done = new ManualResetEvent(false);
      Exception failed = null;
      engine.SpeechRecognized += delegate(object sender, SpeechRecognizedEventArgs e) {
        if (e.Result != null && !string.IsNullOrEmpty(e.Result.Text)) words.Append(words.Length > 0 ? " " : "").Append(e.Result.Text);
      };
      engine.RecognizeCompleted += delegate(object sender, RecognizeCompletedEventArgs e) {
        failed = e.Error;
        done.Set();
      };
      // Every phrase until the recording ends.
      engine.RecognizeAsync(RecognizeMode.Multiple);
      if (!done.WaitOne(TimeSpan.FromMinutes(3))) {
        engine.RecognizeAsyncCancel();
        return Fail("Transcribing took too long.");
      }
      if (failed != null) return Fail("This recording's format can't be read on the PC.");
    }
    Console.Out.Write("{\"text\":" + Json(words.ToString().Trim()) + ",\"locale\":" + Json(info.Culture.Name) + "}\n");
    return 0;
  }
}
