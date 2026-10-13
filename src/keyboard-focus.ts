type Editor = HTMLInputElement | HTMLTextAreaElement;

// Async field detection can focus the sink without showing the phone keyboard.
// An explicit keyboard-opening tap must make a real focus transition, while
// this one intentional blur must not close typing or discard its focus guard.
const renewing = new WeakSet<Editor>();
export const renewingKeyboardFocus = (editor: Editor) => renewing.has(editor);

// Prepare on finger-down, then focus on finger-up. Safari can coalesce a blur
// and refocus in one event and leave its software keyboard hidden even though
// the DOM reports a new focus event.
export function prepareKeyboard(editor: Editor | null) {
  if (!editor || editor.ownerDocument.activeElement !== editor) return;
  renewing.add(editor);
  try {
    editor.blur();
  } finally {
    renewing.delete(editor);
  }
}

export function focusKeyboard(editor: Editor | null) {
  if (!editor) return;
  prepareKeyboard(editor);
  editor.focus({ preventScroll: true });
}
