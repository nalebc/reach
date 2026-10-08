// A voice memo from the phone, as words, on this Mac: macOS 26's on-device
// speech model (SpeechAnalyzer), which needs no permission and sends nothing
// anywhere. `transcribe <audio file> [locale]` prints {"text": "..."}; on
// failure it prints the reason to stderr and exits 1, and Reach attaches the
// recording instead.
import AVFoundation
import Foundation
import Speech

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}

@main
struct Transcribe {
  static func main() async {
    let args = CommandLine.arguments
    guard args.count >= 2 else { fail("usage: transcribe <audio file> [locale]") }
    guard #available(macOS 26, *) else { fail("Transcribing needs macOS 26 or later.") }
    do {
      print(try await words(URL(fileURLWithPath: args[1]), args.count > 2 ? args[2] : nil))
    } catch {
      fail("\(error.localizedDescription)")
    }
  }

  @available(macOS 26, *)
  static func words(_ url: URL, _ wanted: String?) async throws -> String {
    // The phone's language when this Mac has a model for it; else the Mac's.
    var locale: Locale? = nil
    if let wanted, !wanted.isEmpty { locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: wanted)) }
    if locale == nil { locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale.current) }
    guard let locale else { fail("This Mac has no speech model for this language.") }
    let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
    // The model downloads once, the first time a language is used.
    if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
      try await request.downloadAndInstall()
    }
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    let file: AVAudioFile
    do { file = try AVAudioFile(forReading: url) } catch { fail("This recording's format can't be read on the Mac.") }
    async let text: String = transcriber.results.reduce("") { $0 + String($1.text.characters) }
    if let last = try await analyzer.analyzeSequence(from: file) {
      try await analyzer.finalizeAndFinish(through: last)
    } else {
      await analyzer.cancelAndFinishNow()
    }
    let result = try await text.trimmingCharacters(in: .whitespacesAndNewlines)
    let json = try JSONSerialization.data(withJSONObject: ["text": result, "locale": locale.identifier])
    return String(decoding: json, as: UTF8.self)
  }
}
