import { useEffect, useRef } from "react";
import ScreenPopup from "./ScreenPopup";
import "./settings-list.css";
import "./sub-page.css";

// Asking before something that can't be undone, in Reach's own sheet (not
// the browser's confirm, which titles itself with the address and holds the
// page): the question, one quiet line, the red action, then Cancel apart.
// Cancel takes focus; Escape or a tap outside cancels.
export default function ConfirmSheet({
  title,
  detail,
  confirm,
  onConfirm,
  onCancel,
}: {
  title: string;
  detail?: string;
  confirm: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancel.current?.focus({ preventScroll: true });
  }, []);
  return (
    <ScreenPopup title={title} className="confirm-sheet" onClose={onCancel}>
      {detail && <p className="confirm-sheet-detail">{detail}</p>}
      <div className="gs-group">
        <button type="button" className="gs-row confirm-sheet-yes" onClick={onConfirm}>
          {confirm}
        </button>
      </div>
      <div className="gs-group">
        <button type="button" className="gs-row confirm-sheet-no" ref={cancel} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </ScreenPopup>
  );
}
