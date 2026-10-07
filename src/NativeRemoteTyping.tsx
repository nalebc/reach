import { useEffect, useRef } from "react";
import { typingEdit, typingTail } from "./typing-edit";
import type {
  DesktopAction,
  InputResult,
  TextTarget,
} from "./desktop-input-queue";
import { RemoteKeyboard } from "./remote-keyboard";

// Native-app counterpart of RemoteTyping: the iPhone keyboard opens as soon as
// a text field is detected on the computer, without waiting for another tap.
// Edits use the same grapheme-safe diff, so autocorrect and emoji behave alike.
export default function NativeRemoteTyping({
  target,
  send,
  onClose,
  onError,
}: {
  target: TextTarget;
  send: (action: DesktopAction) => Promise<InputResult>;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const latest = useRef({ send, onClose, onError });
  latest.current = { send, onClose, onError };
  useEffect(() => {
    let valid = true,
      shadow = "";
    const fail = (error: Error) => {
      if (!valid) return;
      valid = false;
      latest.current.onError(error.message);
      latest.current.onClose();
    };
    const dispatch = (action: DesktopAction) => {
      if (!valid) return;
      void latest.current
        .send({ ...action, ...(target.focus ? { focus: target.focus } : {}) })
        .catch(fail);
    };
    const listeners = [
      RemoteKeyboard.addListener("input", ({ value }) => {
        try {
          const edit = typingEdit(shadow, value);
          // The native input keeps the same bounded tail (RemoteKeyboard.tail).
          shadow = typingTail(value);
          if (!edit.delete && !edit.text) return;
          if (target.focus) dispatch({ type: "type-edit", ...edit });
          else {
            // Keyboard-button fallback for apps without accessibility fields.
            for (let i = 0; i < edit.delete; i++)
              dispatch({ type: "key", key: "backspace" });
            if (edit.text) dispatch({ type: "text", text: edit.text });
          }
        } catch (error) {
          fail(error as Error);
        }
      }),
      RemoteKeyboard.addListener("key", ({ key }) => {
        if (key === "enter" || key === "backspace")
          dispatch({ type: "key", key, modifiers: [] });
      }),
      RemoteKeyboard.addListener("closed", () => {
        if (valid) latest.current.onClose();
      }),
    ];
    void RemoteKeyboard.show({ secure: !!target.secure }).catch(fail);
    return () => {
      valid = false;
      for (const listener of listeners) void listener.then((l) => l.remove());
      void RemoteKeyboard.hide().catch(() => {});
    };
  }, [target.focus, target.secure]);
  return null;
}
