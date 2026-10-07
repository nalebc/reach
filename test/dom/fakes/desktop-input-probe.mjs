import { useDesktopInput as connected } from "./desktop-input.mjs";
import { computer } from "./computer.mjs";

// The fake input socket of ./desktop-input.mjs, from a computer that can say
// whether a text field is under the finger (unless computer.probeSupported
// is false, as an older Reach).
export function useDesktopInput(...args) {
  return { ...connected(...args), probe: computer.probeSupported !== false };
}
