import { useState } from "react";
import { X } from "lucide-react";

// Paste from the phone into a terminal. A terminal's screen is drawn, not a
// text field, so the phone's own Paste never shows on it: Paste in the key
// row reads the phone's clipboard instead. Where the phone won't hand it
// over (no clipboard access here, or its Paste prompt dismissed or refused),
// a small box above the keys takes the phone's own paste.
export function usePhonePaste(
  deliver: (text: string) => void,
  say: (message: string) => void,
) {
  const [open, setOpen] = useState(false);
  const paste = () => {
    // Read inside the tap: phones refuse a clipboard read that comes later.
    let reading: Promise<string> | undefined;
    try {
      reading = navigator.clipboard?.readText?.();
    } catch {}
    if (!reading) return setOpen(true);
    reading.then(
      (text) => (text ? deliver(text) : say("Nothing to paste on this phone")),
      () => setOpen(true),
    );
  };
  const box = open ? (
    <PasteBox
      onPaste={(text) => {
        setOpen(false);
        deliver(text);
      }}
      onClose={() => setOpen(false)}
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
