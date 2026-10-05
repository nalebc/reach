import { useEffect, useRef, useState, type RefObject } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  CornerDownLeft,
  Delete,
} from "lucide-react";
import { typingEdit, typingTail } from "./typing-edit";
import "./typing-keys.css";
import type {
  DesktopAction,
  InputResult,
  TextTarget,
} from "./desktop-input-queue";

type Editor = HTMLInputElement | HTMLTextAreaElement;
export default function RemoteTyping({
  target,
  send,
  onClose,
  onError,
  editorRef,
  keyRow = false,
}: {
  keyRow?: boolean;
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
  const [draft, setDraft] = useState("");
  useEffect(() => {
    valid.current = true;
    const element = editorRef.current;
    const handler = (event: Event) => beforeInput.current(event as InputEvent);
    element?.addEventListener("beforeinput", handler);
    element?.focus({ preventScroll: true });
    return () => {
      valid.current = false;
      shadow.current = "";
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
    void send({
      ...action,
      ...(target.focus ? { focus: target.focus } : {}),
    }).catch(fail);
  };
  const key = (name: string, modifiers: string[] = []) => {
    dispatch({ type: "key", key: name, modifiers });
    shadow.current = "";
    setDraft("");
  };
  const commit = (next: string) => {
    setDraft(next);
    if (composing.current || !valid.current) return;
    try {
      const edit = typingEdit(shadow.current, next);
      // Retain enough context for autocorrection without silently stopping long
      // typing sessions at an invisible maxlength. Never copy host text here.
      shadow.current = typingTail(next);
      setDraft(shadow.current);
      if (!edit.delete && !edit.text) return;
      if (target.focus) dispatch({ type: "type-edit", ...edit });
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
    if (event.inputType === "deleteContentBackward" && !shadow.current) {
      event.preventDefault();
      key("backspace");
    } else if (
      ["insertLineBreak", "insertParagraph"].includes(event.inputType)
    ) {
      event.preventDefault();
      key("enter");
    }
  };
  const editorProps = {
    "aria-label": "Type directly on your computer",
    value: draft,
    autoComplete: "off",
    // The phone must not rewrite what was already sent: autocorrect and
    // Safari's inline word suggestions replace earlier letters, which reach
    // the computer as deletions.
    autoCorrect: "off",
    autoCapitalize: target.secure ? "off" : "sentences",
    spellCheck: false,
    writingsuggestions: "false",
    enterKeyHint: "enter" as const,
    onBlur: onClose,
    onChange: (e: React.ChangeEvent<Editor>) => commit(e.target.value),
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
      } else if (e.key === "Backspace" && (!draft || modifiers.length)) {
        e.preventDefault();
        key("backspace", modifiers);
      } else if (e.key === "Tab") {
        e.preventDefault();
        key("tab", modifiers);
        onClose();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
  };
  // iOS requires a rendered editable element for its native keyboard. Keep it
  // within the viewport, visually absent. The remote screen is the text surface.
  const sink = target.secure ? (
    <input
      {...editorProps}
      ref={(el) => {
        editorRef.current = el;
      }}
      className="remote-keyboard-sink"
      type="password"
      tabIndex={-1}
    />
  ) : (
    <textarea
      {...editorProps}
      ref={(el) => {
        editorRef.current = el;
      }}
      className="remote-keyboard-sink"
      rows={1}
      tabIndex={-1}
    />
  );
  if (!keyRow) return sink;
  // Keys the phone keyboard lacks, right above it. Pressing one keeps the
  // keyboard open (no focus change).
  const keep = (event: React.PointerEvent | React.MouseEvent) =>
    event.preventDefault();
  return (
    <>
      {sink}
      <div className="typing-keys" role="toolbar" aria-label="Computer keys" data-immersive-keep>
        <button className="typing-enter" onPointerDown={keep} onMouseDown={keep} onClick={() => key("enter")}>
          <CornerDownLeft size={16} /> Enter
        </button>
        <button onPointerDown={keep} onMouseDown={keep} onClick={() => key("tab")}>Tab</button>
        <button onPointerDown={keep} onMouseDown={keep} onClick={() => key("escape")}>Esc</button>
        <button aria-label="Left" onPointerDown={keep} onMouseDown={keep} onClick={() => key("left")}>
          <ArrowLeft size={16} />
        </button>
        <button aria-label="Up" onPointerDown={keep} onMouseDown={keep} onClick={() => key("up")}>
          <ArrowUp size={16} />
        </button>
        <button aria-label="Down" onPointerDown={keep} onMouseDown={keep} onClick={() => key("down")}>
          <ArrowDown size={16} />
        </button>
        <button aria-label="Right" onPointerDown={keep} onMouseDown={keep} onClick={() => key("right")}>
          <ArrowRight size={16} />
        </button>
        <button aria-label="Delete" onPointerDown={keep} onMouseDown={keep} onClick={() => key("backspace")}>
          <Delete size={16} />
        </button>
        <button
          aria-label="Hide keyboard"
          onPointerDown={keep}
          onMouseDown={keep}
          onClick={() => {
            editorRef.current?.blur();
            onClose();
          }}
        >
          <ChevronDown size={18} />
        </button>
      </div>
    </>
  );
}
