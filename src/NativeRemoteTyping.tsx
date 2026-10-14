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
  const latest = useRef({ target, send, onClose, onError });
  latest.current = { target, send, onClose, onError };
  const queued = useRef<DesktopAction[]>([]);
  const active = useRef(false);
  const generation = useRef(0);
  const revision = useRef(target.editRevision);
  const secure = !!target.secure;
  const dispatch = (action: DesktopAction) => {
    if (!active.current) return;
    const current = latest.current;
    const sentIn = generation.current;
    if (current.target.pending) {
      if (queued.current.length >= 32) {
        active.current = false;
        current.onError("Field confirmation took too long. Tap the field again.");
        current.onClose();
      } else queued.current.push(action);
      return;
    }
    void current.send({ ...action, ...(current.target.focus ? { focus: current.target.focus } : {}) })
      .catch((error: Error) => {
        if (!active.current || sentIn !== generation.current) return;
        active.current = false;
        latest.current.onError(error.message);
        latest.current.onClose();
      });
  };
  useEffect(() => {
    let valid = true,
      shadow = "";
    active.current = true;
    generation.current++;
    if (revision.current !== target.editRevision) queued.current = [];
    revision.current = target.editRevision;
    const fail = (error: Error) => {
      if (!valid) return;
      valid = false;
      active.current = false;
      latest.current.onError(error.message);
      latest.current.onClose();
    };
    const listeners = [
      RemoteKeyboard.addListener("input", ({ value }) => {
        if (!valid) return;
        try {
          const edit = typingEdit(shadow, value);
          // The native input keeps the same bounded tail (RemoteKeyboard.tail).
          shadow = typingTail(value);
          if (!edit.delete && !edit.text) return;
          if (latest.current.target.focus || latest.current.target.pending)
            dispatch({ type: "type-edit", ...edit });
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
        if (!valid) return;
        if (key === "enter" || key === "backspace")
          dispatch({ type: "key", key, modifiers: [] });
      }),
      RemoteKeyboard.addListener("closed", () => {
        if (valid) latest.current.onClose();
      }),
    ];
    void RemoteKeyboard.show({ secure }).catch(fail);
    return () => {
      valid = false;
      active.current = false;
      for (const listener of listeners) void listener.then((l) => l.remove());
      void RemoteKeyboard.hide().catch(() => {});
    };
  }, [secure, target.editRevision]);
  useEffect(() => {
    if (target.pending || !target.focus) return;
    for (const action of queued.current.splice(0)) dispatch(action);
  }, [target.pending, target.focus]);
  return null;
}
