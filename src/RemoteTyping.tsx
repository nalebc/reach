import { useEffect, useRef, useState, type RefObject } from "react";
import { typingEdit, typingTail } from "./typing-edit";
import { renewingKeyboardFocus } from "./keyboard-focus";
import KeyRow, { type RowKey } from "./KeyRow";
import "./typing-keys.css";
import {
  mergeTyping,
  type DesktopAction,
  type InputResult,
  type TextTarget,
} from "./desktop-input-queue";

type Editor = HTMLInputElement | HTMLTextAreaElement;
// Local-only text lets iOS keep repeating Delete even when we have not read
// any host text. It is never sent to the computer.
const PAD = "\u200b".repeat(32);
export default function RemoteTyping({
  target,
  send,
  onClose,
  onError,
  editorRef,
  keyRow = false,
  modifier = "meta",
  onRetarget,
  reconnectPaused = false,
}: {
  // Tab or Esc can move the computer's focus: confirm the field again,
  // keeping the keyboard open.
  onRetarget?: () => void;
  reconnectPaused?: boolean;
  keyRow?: boolean;
  // The key row's sticky modifier: ⌘ on a Mac, ctrl on Windows.
  modifier?: "meta" | "control";
  target: TextTarget;
  send: (action: DesktopAction) => Promise<InputResult>;
  onClose: () => void;
  onError: (message: string) => void;
  editorRef: RefObject<Editor | null>;
}) {
  const shadow = useRef(""),
    composing = useRef(false),
    valid = useRef(true);
  const beforeInput = useRef<(e: InputEvent) => void>(() => {});
  const queued = useRef<DesktopAction[]>([]);
  const generation = useRef(0);
  const wasReconnectPaused = useRef(false);
  if (reconnectPaused && !wasReconnectPaused.current) generation.current++;
  wasReconnectPaused.current = reconnectPaused;
  const deleting = useRef(false);
  const setDraft = (text: string) => {
    const element = editorRef.current;
    const value = PAD + text;
    if (element && element.value !== value) {
      element.value = value;
      element.setSelectionRange(value.length, value.length);
    }
  };
  // Armed by the key row: the next letter or key goes with the modifier.
  const [armed, setArmed] = useState(false);
  const armedRef = useRef(false);
  const arm = (value: boolean) => {
    armedRef.current = value;
    setArmed(value);
  };
  useEffect(() => {
    valid.current = true;
    const element = editorRef.current;
    const handler = (event: Event) => beforeInput.current(event as InputEvent);
    element?.addEventListener("beforeinput", handler);
    element?.focus({ preventScroll: true });
    element?.setSelectionRange(element.value.length, element.value.length);
    return () => {
      valid.current = false;
      shadow.current = "";
      queued.current = [];
      element?.removeEventListener("beforeinput", handler);
    };
  }, [editorRef]);
  const fail = (error: Error) => {
    if (!valid.current) return;
    valid.current = false;
    shadow.current = "";
    setDraft("");
    onError(error.message);
    onClose();
  };
  const dispatch = (action: DesktopAction) => {
    if (!valid.current) return;
    if (target.pending) {
      // Waiting letters go as one edit (the queue never fills while a slow
      // computer confirms the field).
      const last = queued.current.at(-1);
      const merged = last && mergeTyping(last, action);
      if (merged) {
        queued.current[queued.current.length - 1] = merged;
        return;
      }
      if (queued.current.length >= 32) return fail(Error("Field confirmation took too long. Tap the field again."));
      queued.current.push(action);
      return;
    }
    const sentIn = generation.current;
    void send({
      ...action,
      ...(target.focus ? { focus: target.focus } : {}),
    }).catch((error: Error) => {
      // An old, dispatched chunk is not part of the known-unsent queue.
      if (sentIn === generation.current) fail(error);
    });
  };
  useEffect(() => {
    // A remote click changes the selection independently of this local sink.
    // Start the next diff from an empty draft without closing the keyboard.
    shadow.current = "";
    queued.current = [];
    composing.current = false;
    deleting.current = false;
    setDraft("");
  }, [target.editRevision]);
  useEffect(() => {
    if (target.pending || !target.focus) return;
    const actions = queued.current.splice(0);
    for (const action of actions) dispatch(action);
  }, [target.pending, target.focus]);
  const key = (name: string, modifiers: string[] = []) => {
    // ⌘ (or ctrl) armed in the key row goes with this key too, once.
    if (armedRef.current) {
      arm(false);
      if (!modifiers.includes(modifier)) modifiers = [...modifiers, modifier];
    }
    dispatch({ type: "key", key: name, modifiers });
    shadow.current = "";
    setDraft("");
  };
  // A word still being composed (Android's keyboard, Japanese, Chinese)
  // goes before a key from the key row, never lost under it.
  const settle = () => {
    const element = editorRef.current;
    if (!composing.current || !element) return;
    composing.current = false;
    commit(element.value);
  };
  const commit = (raw: string) => {
    if (composing.current || !valid.current) return;
    try {
      let prefix = 0;
      while (prefix < PAD.length && raw[prefix] === PAD[0]) prefix++;
      const next = raw.slice(prefix);
      const edit = typingEdit(shadow.current, next);
      if (deleting.current) edit.delete += PAD.length - prefix;
      deleting.current = false;
      // ⌘ (or ctrl) armed: the letter typed is a shortcut, not text.
      if (armedRef.current && edit.text && !edit.delete) {
        arm(false);
        const letter = [...edit.text].at(-1)!;
        const name = letter === " " ? "space" : letter.toLowerCase();
        shadow.current = "";
        setDraft("");
        if (/^([a-z0-9]|space)$/.test(name)) {
          dispatch({
            type: "key",
            key: name,
            modifiers: [
              modifier,
              ...(letter !== name && name !== "space" ? ["shift"] : []),
            ],
          });
        } else onError(`${modifier === "meta" ? "⌘" : "Ctrl"} goes with a letter or a number.`);
        return;
      }
      // Retain enough context for autocorrection without silently stopping long
      // typing sessions at an invisible maxlength. Never copy host text here.
      shadow.current = typingTail(next.split(/\r?\n/).at(-1) || "");
      setDraft(shadow.current);
      if (!edit.delete && !edit.text) return;
      if (target.focus || target.pending) dispatch({ type: "type-edit", ...edit });
      else {
        // Explicit keyboard-button fallback for apps without accessibility fields.
        for (let i = 0; i < edit.delete; i++)
          dispatch({ type: "key", key: "backspace" });
        if (edit.text) dispatch({ type: "text", text: edit.text });
      }
    } catch (error) {
      fail(error as Error);
    }
  };
  beforeInput.current = (event) => {
    if (event.isComposing || composing.current) return;
    deleting.current = event.inputType.startsWith("delete");
    if (
      ["insertLineBreak", "insertParagraph"].includes(event.inputType)
    ) {
      event.preventDefault();
      key("enter");
    }
  };
  const editorProps = {
    "aria-label": "Type directly on your computer",
    defaultValue: PAD,
    autoComplete: "off",
    // The phone must not rewrite what was already sent: autocorrect and
    // Safari's inline word suggestions replace earlier letters, which reach
    // the computer as deletions.
    autoCorrect: "off",
    autoCapitalize: target.secure ? "off" : "sentences",
    spellCheck: false,
    writingsuggestions: "false",
    enterKeyHint: "enter" as const,
    onBlur: (event: React.FocusEvent<Editor>) => {
      if (!renewingKeyboardFocus(event.currentTarget)) onClose();
    },
    onChange: (e: React.ChangeEvent<Editor>) => commit(e.target.value),
    onPaste: (e: React.ClipboardEvent<Editor>) => {
      const text = e.clipboardData.getData("text/plain");
      // A stable input element keeps its keyboard when the detected field
      // becomes secure. Preserve multiline paste before input strips newlines.
      if (/\r|\n/.test(text)) {
        e.preventDefault();
        deleting.current = false;
        commit(PAD + shadow.current + text.replace(/\r\n?/g, "\n"));
      }
    },
    onCompositionStart: () => {
      composing.current = true;
    },
    onCompositionEnd: (e: React.CompositionEvent<Editor>) => {
      composing.current = false;
      commit(e.currentTarget.value);
    },
    onKeyDown: (e: React.KeyboardEvent<Editor>) => {
      if (e.nativeEvent.isComposing || composing.current || e.keyCode === 229)
        return;
      const navigation: Record<string, string> = {
        ArrowLeft: "left",
        ArrowRight: "right",
        ArrowUp: "up",
        ArrowDown: "down",
        Home: "home",
        End: "end",
        PageUp: "pageup",
        PageDown: "pagedown",
        Delete: "delete",
      };
      const modifiers = [
        ...(e.metaKey ? ["meta"] : []),
        ...(e.ctrlKey ? ["control"] : []),
        ...(e.altKey ? ["alt"] : []),
        ...(e.shiftKey ? ["shift"] : []),
      ];
      if (
        navigation[e.key] ||
        ((e.metaKey || e.ctrlKey || e.altKey) && /^[a-z0-9]$/i.test(e.key))
      ) {
        e.preventDefault();
        key(navigation[e.key] || e.key.toLowerCase(), modifiers);
      } else if (e.key === "Enter") {
        e.preventDefault();
        key("enter", modifiers);
      } else if (e.key === "Backspace" && (modifiers.length || armedRef.current)) {
        e.preventDefault();
        key("backspace", modifiers);
      } else if (e.key === "Tab" || e.key === "Escape") {
        // Both reach the computer (Tab completes in a terminal; Esc leaves
        // vim's insert mode). Either can move its focus: confirm it again.
        e.preventDefault();
        key(e.key === "Tab" ? "tab" : "escape", modifiers);
        if (onRetarget) onRetarget();
        else if (e.key === "Tab") onClose();
      }
    },
  };
  // iOS requires a rendered editable element for its native keyboard. Keep it
  // within the viewport, visually absent. The remote screen is the text surface.
  const sink = (
    <input
      {...editorProps}
      ref={(el) => {
        editorRef.current = el;
      }}
      className="remote-keyboard-sink"
      type={target.secure ? "password" : "text"}
      tabIndex={-1}
    />
  );
  if (!keyRow) return sink;
  // The terminal's key row, right above the phone keyboard.
  const rowKey = (name: RowKey) => {
    settle();
    key(name);
    if ((name === "tab" || name === "escape") && onRetarget) onRetarget();
  };
  return (
    <>
      {sink}
      <KeyRow
        className="typing-keys"
        label="Computer keys"
        modifier={modifier === "meta" ? "⌘" : "ctrl"}
        armed={armed}
        onArm={arm}
        onKey={rowKey}
      />
    </>
  );
}
