import { useEffect, useState } from "react";
import { useDesktopInput as connected } from "./desktop-input.mjs";
import { computer } from "./computer.mjs";

// The fake input socket of ./desktop-input.mjs, from a computer that can say
// whether a text field is under the finger (unless computer.probeSupported
// is false, as an older Reach). computer.blink(true) drops the connection
// (control stays on, reconnecting) and computer.blink(false) brings it back.
export function useDesktopInput(...args) {
  const [, changed] = useState(0);
  useEffect(() => {
    const listen = () => changed((n) => n + 1);
    computer.inputListeners.add(listen);
    return () => computer.inputListeners.delete(listen);
  }, []);
  const input = { ...connected(...args), probe: computer.probeSupported !== false };
  if (!computer.inputDown) return input;
  return {
    ...input,
    ready: false,
    reconnecting: true,
    send: async () => Promise.reject(Object.assign(Error("Desktop input is not connected."), { notSent: true })),
  };
}
