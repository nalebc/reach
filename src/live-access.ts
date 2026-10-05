// Whether what this device may use changed: the owner changed an invited
// person's or agent's access (server/index.mjs, the `access` part of the
// live changes). `previous`/`next`: the live changes as JSON text.
export function accessChanged(previous?: string, next?: string) {
  const access = (text?: string) => {
    try {
      return text ? JSON.parse(text)?.access : undefined;
    } catch {
      return undefined;
    }
  };
  return previous !== undefined && access(previous) !== access(next);
}
