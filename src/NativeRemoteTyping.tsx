import { useEffect, useRef } from "react";
import { typingEdit, typingTail } from "./typing-edit";
import {
  mergeTyping,
  isInputReconnect,
  type DesktopAction,
  type InputResult,
  type TextTarget,
} from "./desktop-input-queue";
import { RemoteKeyboard } from "./remote-keyboard";

// Native-app counterpart of RemoteTyping: the iPhone keyboard opens as soon as
// a text field is detected on the computer, without waiting for another tap.
// Edits use the same grapheme-safe diff, so emoji and accents behave alike.
export default function NativeRemoteTyping({
  target,
  send,
  onClose,
  onError,
  onRetarget,
  reconnectPaused = false,
}: {
  target: TextTarget;
  send: (action: DesktopAction) => Promise<InputResult>;
  onClose: () => void;
  onError: (message: string) => void;
  // Tab or Esc can move the computer's focus: confirm the field again.
  onRetarget?: () => void;
  reconnectPaused?: boolean;
}) {
  const latest = useRef({ target, send, onClose, onError, onRetarget });
  latest.current = { target, send, onClose, onError, onRetarget };
  const queued = useRef<DesktopAction[]>([]);
  const active = useRef(false);
  const generation = useRef(0);
  const wasReconnectPaused = useRef(false);
  // Dispatched input has an unknown outcome when its old connection ends.
  // It is never queued for replay; only subsequent, unsent edits wait here.
  if (reconnectPaused && !wasReconnectPaused.current) generation.current++;
  wasReconnectPaused.current = reconnectPaused;
  const revision = useRef(target.editRevision);
  const secure = !!target.secure;
  const hold = (action: DesktopAction) => {
    if (!active.current) return;
    const current = latest.current;
    const last = queued.current.at(-1);
    const merged = last && mergeTyping(last, action);
    if (merged) {
      queued.current[queued.current.length - 1] = merged;
      return;
    }
    if (queued.current.length >= 32) {
      active.current = false;
      current.onError("Field confirmation took too long. Tap the field again.");
      current.onClose();
    } else queued.current.push(action);
  };
  const dispatch = (action: DesktopAction) => {
    if (!active.current) return;
    const current = latest.current;
    if (current.target.pending) return hold(action);
    const sentIn = generation.current;
    const sentRevision = current.target.editRevision;
    void current.send({ ...action, ...(current.target.focus ? { focus: current.target.focus } : {}) })
      .catch((error: Error) => {
        if (isInputReconnect(error)) {
          if (error.notSent && sentRevision === latest.current.target.editRevision) hold(action);
          return;
        }
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
      RemoteKeyboard.addListener("key", ({ key, contextReset }) => {
        if (!valid) return;
        if (!["enter", "backspace", "tab", "escape", "up", "down", "left", "right"].includes(key)) return;
        dispatch({ type: "key", key, modifiers: [] });
        // Older installed shells retain their native context after Return.
        // Reset the shadow only when the shell confirms it cleared that text.
        if (contextReset === true) shadow = "";
        if (key === "tab" || key === "escape") latest.current.onRetarget?.();
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
