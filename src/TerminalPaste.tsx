import { useLayoutEffect, useRef, useState } from "react";
import { X } from "lucide-react";

// Paste from the phone into a terminal. A terminal's screen is drawn, not a
// text field, so the phone's own Paste never shows on it: Paste in the key
// row reads the phone's clipboard instead. Where the phone won't hand it
// over (no clipboard access here, or its Paste prompt dismissed or refused),
// a small box above the keys takes the phone's own paste.
export function usePhonePaste(
  clipboardTarget: readonly unknown[],
  draftTarget: readonly unknown[],
  deliver: (text: string) => void | false,
  say: (message: string) => void,
) {
  // A clipboard prompt can outlive this terminal. Each committed target
  // gets a fresh lifetime, including a switch away and back to the same ID.
  // Invalidate before the replacement terminal can receive input; merely
  // comparing its current ID would accept an old A → B → A read.
  const lifetime = useRef<object | null>(null);
  // Text already placed in the manual box is unsent work. A verified
  // same-workspace handoff keeps it, while pending clipboard reads expire.
  const draftLifetime = useRef<object | null>(null);
  const [open, setOpen] = useState<object | null>(null);
  useLayoutEffect(() => {
    const current = {};
    lifetime.current = current;
    return () => { lifetime.current = null; };
  }, clipboardTarget);
  useLayoutEffect(() => {
    const current = {};
    draftLifetime.current = current;
    setOpen(null);
    return () => { draftLifetime.current = null; };
  }, draftTarget);
  const paste = () => {
    const current = lifetime.current;
    const draft = draftLifetime.current;
    if (!current || !draft) return;
    const valid = () => lifetime.current === current && draftLifetime.current === draft;
    // Read inside the tap: phones refuse a clipboard read that comes later.
    let reading: Promise<string> | undefined;
    try {
      reading = navigator.clipboard?.readText?.();
    } catch {}
    if (!reading) return setOpen(draft);
    reading.then(
      (text) => {
        if (valid()) text ? deliver(text) : say("Nothing to paste on this phone");
      },
      () => { if (valid()) setOpen(draft); },
    );
  };
  const box = open && open === draftLifetime.current ? (
    <PasteBox
      onPaste={(text) => {
        if (open !== draftLifetime.current) return;
        // false means nothing was sent. Keep that known-unsent text for a
        // fresh tap; an attempted dispatch is never queued or retried here.
        if (deliver(text) !== false) setOpen(null);
      }}
      onClose={() => setOpen(null)}
    />
  ) : null;
  return { paste, box };
}

function PasteBox({
  onPaste,
  onClose,
}: {
  onPaste: (text: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  return (
    <form
      className="terminal-paste"
      onSubmit={(e) => {
        e.preventDefault();
        if (text) onPaste(text);
      }}
    >
      <textarea
        aria-label="Text to paste"
        placeholder="Touch and hold here, then Paste"
        rows={2}
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
      />
      <button type="submit" disabled={!text}>
        Paste
      </button>
      <button type="button" aria-label="Close" onClick={onClose}>
        <X size={16} />
      </button>
    </form>
  );
}
