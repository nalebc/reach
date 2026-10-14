import { useEffect, useRef, useState } from "react";
import { Keyboard } from "lucide-react";

// Safari only shows the keyboard during a tap. Text-field detection finishes
// after the tap, so when a field is found but the keyboard stayed closed,
// offer one clear button. Focusing inside this tap opens the keyboard.
export default function TapToType({
  onOpen,
  onPrepare,
}: {
  onOpen: () => void;
  onPrepare: () => void;
}) {
  const [needed, setNeeded] = useState(false);
  const touchedAt = useRef(-Infinity);
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
      onPointerDown={(event) => {
        event.preventDefault();
        onPrepare();
      }}
      onTouchStart={onPrepare}
      onTouchEnd={(event) => {
        // Safari grants keyboard activation inside touch-end, even when it
        // omits the synthetic click. Cancel that click to avoid opening twice.
        event.preventDefault();
        touchedAt.current = performance.now();
        onOpen();
      }}
      // The viewport check hides this once the keyboard is actually open.
      onClick={(event) => {
        event.preventDefault();
        if (event.detail > 0 && performance.now() - touchedAt.current < 500) return;
        onOpen();
      }}
    >
      <Keyboard size={19} />
      Tap to type
    </button>
  );
}
