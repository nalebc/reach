import Capacitor
import UIKit

/// Opens the iPhone keyboard for typing on the remote computer.
///
/// A web view may only show the keyboard during a user's tap, but text-field
/// detection on the computer finishes after the tap. Native code can show the
/// keyboard at any time, so Reach pops it up as soon as a field is detected.
/// The JavaScript side receives the field's full value and diffs it with the
/// same grapheme-safe logic used for the web keyboard.
@objc(RemoteKeyboardPlugin)
public class RemoteKeyboardPlugin: CAPPlugin, CAPBridgedPlugin, UITextViewDelegate,
  UITextFieldDelegate
{
  public let identifier = "RemoteKeyboardPlugin"
  public let jsName = "RemoteKeyboard"
  public let pluginMethods: [CAPPluginMethod] = [
    CAPPluginMethod(name: "show", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "hide", returnType: CAPPluginReturnPromise),
  ]
  /// Matches typingTail() in src/typing-edit.ts: keep the last 128 graphemes.
  static let tail = 128
  private var textView: SinkTextView?
  private var secureField: SinkTextField?
  private var closing = false

  @objc func show(_ call: CAPPluginCall) {
    let secure = call.getBool("secure") ?? false
    DispatchQueue.main.async {
      guard let host = self.bridge?.viewController?.view else {
        call.reject("The keyboard is not available right now.")
        return
      }
      self.dismiss()
      let input: UIView
      if secure {
        let field = SinkTextField()
        field.isSecureTextEntry = true
        field.delegate = self
        field.onEmptyBackspace = { [weak self] in self?.emit(key: "backspace") }
        field.addTarget(self, action: #selector(self.fieldChanged(_:)), for: .editingChanged)
        self.secureField = field
        input = field
      } else {
        let view = SinkTextView()
        view.delegate = self
        view.autocorrectionType = .yes
        view.autocapitalizationType = .sentences
        view.spellCheckingType = .yes
        view.onEmptyBackspace = { [weak self] in self?.emit(key: "backspace") }
        self.textView = view
        input = view
      }
      // Must be in the view hierarchy and not hidden to become first responder.
      input.frame = CGRect(x: 0, y: host.bounds.height - 2, width: 1, height: 1)
      input.alpha = 0.01
      input.isAccessibilityElement = true
      input.accessibilityLabel = "Type directly on your computer"
      host.addSubview(input)
      input.becomeFirstResponder()
      call.resolve()
    }
  }

  @objc func hide(_ call: CAPPluginCall) {
    DispatchQueue.main.async {
      self.dismiss()
      call.resolve()
    }
  }

  private func dismiss() {
    closing = true
    textView?.resignFirstResponder()
    textView?.removeFromSuperview()
    secureField?.resignFirstResponder()
    secureField?.removeFromSuperview()
    textView = nil
    secureField = nil
    closing = false
  }

  private func emit(key: String) {
    notifyListeners("key", data: ["key": key])
  }

  private func emit(value: String, reset: (String) -> Void) {
    notifyListeners("input", data: ["value": value])
    // Stay in step with the JavaScript shadow text, which keeps only the tail.
    if value.count > RemoteKeyboardPlugin.tail {
      reset(String(value.suffix(RemoteKeyboardPlugin.tail)))
    }
  }

  // MARK: Text view (normal fields)

  public func textView(
    _ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String
  ) -> Bool {
    if text == "\n" {
      emit(key: "enter")
      return false
    }
    return true
  }

  public func textViewDidChange(_ textView: UITextView) {
    // Wait for composed input (e.g. Japanese, Chinese) to be committed.
    guard textView.markedTextRange == nil else { return }
    emit(value: textView.text ?? "") { textView.text = $0 }
  }

  public func textViewDidEndEditing(_ textView: UITextView) {
    if !closing { notifyListeners("closed", data: [:]) }
  }

  // MARK: Secure field (passwords)

  @objc private func fieldChanged(_ field: UITextField) {
    emit(value: field.text ?? "") { field.text = $0 }
  }

  public func textFieldShouldReturn(_ textField: UITextField) -> Bool {
    emit(key: "enter")
    return false
  }

  public func textFieldDidEndEditing(_ textField: UITextField) {
    if !closing { notifyListeners("closed", data: [:]) }
  }
}

/// Backspace on an empty input still deletes on the computer.
final class SinkTextView: UITextView {
  var onEmptyBackspace: (() -> Void)?
  override func deleteBackward() {
    if text.isEmpty { onEmptyBackspace?() } else { super.deleteBackward() }
  }
}

final class SinkTextField: UITextField {
  var onEmptyBackspace: (() -> Void)?
  override func deleteBackward() {
    if text?.isEmpty ?? true { onEmptyBackspace?() } else { super.deleteBackward() }
  }
}
