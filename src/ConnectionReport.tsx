import { useRef, useState } from "react";
import { Copy, Wifi } from "lucide-react";
import type { Peer } from "./api";
import { Modal } from "./ui";
import { connectionReport } from "./connection-report";

export default function ConnectionReport({ peer, toast }: { peer: Peer; toast(message: string): void }) {
  const [fallback, setFallback] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const copy = () => {
    const text = connectionReport(peer);
    try {
      if (!navigator.clipboard?.writeText) throw Error("Clipboard unavailable");
      // Safari needs the write to start inside the original tap.
      navigator.clipboard.writeText(text).then(() => toast("Connection report copied"), () => setFallback(text));
    } catch { setFallback(text); }
  };
  return <>
    <button className="gs-row" onClick={copy} aria-label="Copy connection report">
      <Wifi size={21} />
      <span className="gs-label">Connection report</span>
      <span className="gs-value">Copy</span>
      <Copy className="gs-chevron" size={18} />
    </button>
    {fallback && <Modal title="Connection report" onClose={() => setFallback("")}>
      <p>Select and copy these connection details into your bug report.</p>
      <textarea ref={field} readOnly value={fallback} rows={14} aria-label="Connection report text" style={{ width: "100%" }} onFocus={event => event.currentTarget.select()} />
      <button className="button" onClick={() => { field.current?.focus(); field.current?.select(); }}>Select report</button>
    </Modal>}
  </>;
}
