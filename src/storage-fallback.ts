// Some browsers refuse a site its storage (Safari's "Block All Cookies",
// some private modes, a full disk): even reading localStorage throws, and
// Reach, which keeps this phone's computers and settings there, couldn't
// open at all. Then it keeps them in memory for this visit instead: it opens
// and works, but forgets this phone once the page closes (the next visit
// asks to approve it again; ConnectForm.tsx says so).
// Loaded before anything else reads storage (boot.ts, start.ts, App.tsx).

class MemoryStorage implements Storage {
  #items = new Map<string, string>();
  get length() {
    return this.#items.size;
  }
  clear() {
    this.#items.clear();
  }
  getItem(key: string) {
    return this.#items.has(String(key)) ? this.#items.get(String(key))! : null;
  }
  key(index: number) {
    return [...this.#items.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.#items.delete(String(key));
  }
  setItem(key: string, value: string) {
    this.#items.set(String(key), String(value));
  }
}

const refused = new Set<string>();
for (const name of ["localStorage", "sessionStorage"] as const) {
  try {
    const area = (globalThis as unknown as Record<string, Storage>)[name];
    const probe = "reach.storage-check";
    area.setItem(probe, "1");
    area.removeItem(probe);
  } catch {
    refused.add(name);
    try {
      Object.defineProperty(globalThis, name, { configurable: true, value: new MemoryStorage() });
    } catch {
      /* can't be replaced: what reads it still guards itself */
    }
  }
}
// Whether this browser refused to keep anything for Reach.
export const storageBlocked = () => refused.has("localStorage");
