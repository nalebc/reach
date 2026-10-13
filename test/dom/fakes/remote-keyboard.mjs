// A native keyboard bridge stand-in. Browser tests leave the capability off;
// native lifecycle tests enable it and observe show/hide and listener cleanup.
export let nativeKeyboard = false;
export const keyboard = {
  visible: false,
  shows: [],
  hides: 0,
  listeners: new Map(),
  reset(native = false) {
    nativeKeyboard = native;
    this.visible = false;
    this.shows = [];
    this.hides = 0;
    this.listeners.clear();
  },
  emit(name, event) {
    for (const listener of this.listeners.get(name) || []) listener(event);
  },
};
export const RemoteKeyboard = {
  async show(options) {
    keyboard.shows.push(options);
    keyboard.visible = true;
  },
  async hide() {
    keyboard.hides++;
    keyboard.visible = false;
  },
  async addListener(name, listener) {
    if (!keyboard.listeners.has(name)) keyboard.listeners.set(name, new Set());
    const set = keyboard.listeners.get(name);
    set.add(listener);
    return {
      async remove() {
        set.delete(listener);
      },
    };
  },
};
