export const isNative = true;
export const Capacitor = { isPluginAvailable: () => true };
export const state = { listeners: new Map(), canceled: [], start: null, finish: null, failListener: 0, registrations: 0 };
export function reset() {
  state.listeners.clear();
  state.canceled = [];
  state.start = state.finish = null;
  state.failListener = state.registrations = 0;
}
const transfer = {
  async addListener(event, listener) {
    if (++state.registrations === state.failListener) throw Error("Listener unavailable");
    state.listeners.set(event, listener);
    return { async remove() { state.listeners.delete(event); } };
  },
  async download() { state.start = true; return new Promise(resolve => { state.finish = resolve; }); },
  async cancel({ id }) { state.canceled.push(id); },
  async finished() { return { files: [] }; },
};
export const registerPlugin = () => transfer;
export const Share = { async share() {} };
