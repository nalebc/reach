// The connection screen must stay attached until the workspace code loads.
// Otherwise a failed import tries to report its error into a detached element.
export async function openReach(
  load: () => Promise<unknown>,
  loading: HTMLElement | null = document.getElementById("reach-startup"),
) {
  try {
    await load();
    loading?.remove();
    return true;
  } catch (error) {
    console.error("Reach couldn't load its interface.", error);
    const host = loading?.isConnected
      ? loading
      : document.getElementById("root");
    if (!host) return false;
    const recovery = document.createElement("section");
    recovery.setAttribute("role", "alert");
    recovery.style.cssText =
      "min-height:100dvh;display:grid;align-content:center;justify-items:start;gap:16px;padding:32px;box-sizing:border-box;background:#111816;color:#edf2ee;font:16px/1.5 system-ui,sans-serif";
    const title = document.createElement("h1");
    title.textContent = "Reach couldn't open";
    title.style.cssText = "margin:0;font-size:28px";
    const detail = document.createElement("p");
    detail.textContent =
      "Check your connection, then reload Reach. Your saved computers and connections are still here.";
    detail.style.cssText = "margin:0;max-width:38em;color:#a0afa4";
    const reload = document.createElement("a");
    reload.textContent = "Reload Reach";
    const url = new URL(location.href);
    url.searchParams.set("reach-update", String(Date.now()));
    reload.href = url.href;
    reload.style.cssText =
      "display:inline-block;padding:12px 20px;border-radius:10px;background:#b9efd4;color:#111816;text-decoration:none;font-weight:600";
    recovery.append(title, detail, reload);
    host.replaceChildren(recovery);
    return false;
  }
}
