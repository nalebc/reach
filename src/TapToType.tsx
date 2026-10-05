import { useEffect, useState, type RefObject } from "react";
import { Keyboard } from "lucide-react";

// Safari only shows the keyboard during a tap. Text-field detection finishes
// after the tap, so when a field is found but the keyboard stayed closed,
// offer one clear button. Focusing inside this tap opens the keyboard.
export default function TapToType({
  editorRef,
}: {
  editorRef: RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
}) {
  const [needed, setNeeded] = useState(false);
  useEffect(() => {
    const viewport = window.visualViewport;
    // The on-screen keyboard shrinks the visual viewport.
    const check = () =>
      setNeeded(!viewport || viewport.height > window.innerHeight - 120);
    const timer = setTimeout(check, 450);
    viewport?.addEventListener("resize", check);
    return () => {
      clearTimeout(timer);
      viewport?.removeEventListener("resize", check);
    };
  }, []);
  if (!needed) return null;
  return (
    <button
      className="button primary tap-to-type"
      data-immersive-keep
      onPointerDown={(event) => event.preventDefault()}
      // The viewport check hides this once the keyboard is actually open.
      onClick={() => editorRef.current?.focus({ preventScroll: true })}
    >
      <Keyboard size={19} />
      Tap to type
    </button>
  );
}
