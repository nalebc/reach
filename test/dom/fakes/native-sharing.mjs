export const state = { platform: "ios", failWrite: 0, writes: [], shares: [], removed: [] };
export const reset = (platform = "ios") => {
  state.platform = platform; state.failWrite = 0; state.writes = []; state.shares = []; state.removed = [];
};
export const Capacitor = { isNativePlatform: () => true, isPluginAvailable: () => true, getPlatform: () => state.platform };
export const registerPlugin = () => ({});
export const App = {};
export const Directory = { Cache: "CACHE" };
export const Filesystem = {
  async writeFile(request) {
    state.writes.push(request);
    if (state.writes.length === state.failWrite) throw Error("Cache write failed");
    return { uri: `file:///fixture/${request.path}` };
  },
  async rmdir(request) { state.removed.push(request); },
};
export const Share = { async share(request) { state.shares.push(request); } };
