// The installed Capacitor App plugin sends pause only from iOS's
// didEnterBackground notification. isActive:false is weaker (resigning active
// can just be a dialog), so it must never certify this smoke's backgrounding.
// Self-contained: copied into only the disposable simulator's test script.
export function installIosLifecycleProbe(native, notify) {
  let armed = false, paused = false, active = false;
  native.nativeCallback("App", "addListener", { eventName: "pause" }, () => {
    if (!armed || paused) return;
    paused = true;
    notify("native-backgrounded");
  });
  native.nativeCallback("App", "addListener", { eventName: "appStateChange" }, (state) => {
    if (!paused || active || state?.isActive !== true) return;
    active = true;
    notify("native-active");
  });
  return { armDownload() { armed = true; } };
}

// Evidence from this run's nonce-scoped page only. Keep the order explicit:
// a native download request, iOS background entry, then becoming active.
export function createIosLifecycleEvidence() {
  let downloadRequested = false, backgrounded = false, activeAfterBackground = false;
  let noteBackgrounded, noteActive;
  const background = new Promise(resolve => { noteBackgrounded = resolve; });
  const active = new Promise(resolve => { noteActive = resolve; });
  return {
    background, active,
    beginDownload() { downloadRequested = true; },
    event(kind) {
      if (downloadRequested && !backgrounded && kind === "native-backgrounded") {
        backgrounded = true;
        noteBackgrounded();
      } else if (backgrounded && !activeAfterBackground && kind === "native-active") {
        activeAfterBackground = true;
        noteActive();
      }
    },
    snapshot() { return { downloadRequested, backgrounded, activeAfterBackground }; },
  };
}
