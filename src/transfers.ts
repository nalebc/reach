import { useEffect, useState } from "react";
import { Capacitor, registerPlugin } from "@capacitor/core";
import { Share } from "@capacitor/share";
import { isNative } from "./native";
import { tailnetBrowser } from "./tailnet-transport";
import {
  fileBlob,
  post,
  request,
  retryable,
  whenReachable,
  type FileEntry,
  type Peer,
} from "./api";

// Uploads and downloads in progress, app-wide, so they keep going when you
// leave Files and show in one small tray. Uploads go in chunks that resume
// after a dropped connection or a phone that slept.
export type Transfer = {
  id: string;
  kind: "upload" | "download" | "send";
  name: string;
  where: string;
  done: number;
  total: number;
  rate: number;
  state: "running" | "waiting" | "done" | "failed" | "canceled";
  error?: string;
  cancel: () => void;
  retry?: () => void;
  // Shown once finished, e.g. "Save" for a file the phone downloaded.
  action?: { label: string; run: () => void };
};
const transfers = new Map<string, Transfer>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((fn) => fn());
let sequence = 0;

export function useTransfers() {
  const [, rerender] = useState(0);
  useEffect(() => {
    const update = () => rerender((n) => n + 1);
    listeners.add(update);
    return () => {
      listeners.delete(update);
    };
  }, []);
  return [...transfers.values()];
}
export const clearFinished = () => {
  for (const [id, t] of transfers)
    if (t.state === "done" || t.state === "canceled") transfers.delete(id);
  changed();
};
export const dismiss = (id: string) => {
  transfers.delete(id);
  changed();
};

// Closing the page mid-upload would lose it: the browser asks first.
window.addEventListener("beforeunload", (event) => {
  if (
    [...transfers.values()].some(
      (t) => t.state === "running" || t.state === "waiting",
    )
  )
    event.preventDefault();
});

function track(
  kind: Transfer["kind"],
  name: string,
  total: number,
  where: string,
) {
  const controller = new AbortController();
  const id = `t${++sequence}`;
  const transfer: Transfer = {
    id,
    kind,
    name,
    where,
    done: 0,
    total,
    rate: 0,
    state: "running",
    cancel: () => {
      controller.abort();
      if (transfer.state === "running" || transfer.state === "waiting") {
        transfer.state = "canceled";
        changed();
      }
    },
  };
  transfers.set(id, transfer);
  changed();
  let last = { at: performance.now(), done: 0 };
  return {
    transfer,
    signal: controller.signal,
    progress(done: number) {
      if (controller.signal.aborted) return;
      const now = performance.now();
      if (now - last.at >= 500) {
        // Smoothed speed, for "2.1 MB/s · 30 s left".
        const rate = ((done - last.done) / (now - last.at)) * 1000;
        transfer.rate = transfer.rate ? transfer.rate * 0.7 + rate * 0.3 : rate;
        last = { at: now, done };
      }
      transfer.done = done;
      transfer.state = "running";
      changed();
    },
    waiting() {
      if (controller.signal.aborted) return;
      transfer.state = "waiting";
      transfer.rate = 0;
      changed();
    },
    // Finished items leave on their own, unless they still offer an action.
    finish(leave = true) {
      if (controller.signal.aborted) return;
      transfer.done = transfer.total;
      transfer.state = "done";
      changed();
      if (leave)
        setTimeout(() => {
          if (transfers.get(id)?.state === "done") dismiss(id);
        }, 5000);
    },
    fail(error: unknown) {
      if (controller.signal.aborted) return;
      transfer.state = "failed";
      transfer.error = (error as Error)?.message || "This transfer stopped.";
      changed();
    },
  };
}
const checkCanceled = (signal: AbortSignal) => {
  if (signal.aborted) throw signal.reason || new DOMException("Canceled", "AbortError");
};
const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  checkCanceled(signal);
  const abort = () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    reject(signal.reason || new DOMException("Canceled", "AbortError"));
  };
  const timer = setTimeout(() => {
    signal.removeEventListener("abort", abort);
    resolve();
  }, ms);
  signal.addEventListener("abort", abort);
});
// A computer running an older Reach that doesn't have this endpoint (as
// opposed to a 404 for a file or folder that's gone).
const olderReach = (e: unknown) =>
  (e as { status?: number })?.status === 404 &&
  (e as Error).message === "This action does not exist.";
const IDLE_MS = 45000;

// One chunk with upload progress (fetch can't report it). Fails if nothing
// moves for 45 seconds rather than after a fixed time.
function putChunk(
  peer: Peer,
  id: string,
  offset: number,
  chunk: Blob,
  onLoaded: (loaded: number) => void,
  signal: AbortSignal,
) {
  checkCanceled(signal);
  if (tailnetBrowser())
    return putChunkThroughTailnet(peer, id, offset, chunk, onLoaded, signal);
  return new Promise<{ offset: number }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `${peer.url}/api/files/uploads/${id}?offset=${offset}`);
    xhr.setRequestHeader("Authorization", `Bearer ${peer.token}`);
    // Raw bytes: the computer must never parse a chunk (say of a .json file).
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    let idle = setTimeout(() => xhr.abort(), IDLE_MS);
    const settle = () => {
      clearTimeout(idle);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => xhr.abort();
    signal.addEventListener("abort", abort);
    xhr.upload.onprogress = (e) => {
      clearTimeout(idle);
      idle = setTimeout(() => xhr.abort(), IDLE_MS);
      onLoaded(e.loaded);
    };
    xhr.onload = () => {
      settle();
      let body: { offset?: number; error?: string } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {}
      if (
        xhr.status >= 200 &&
        xhr.status < 300 &&
        typeof body.offset === "number"
      )
        resolve({ offset: body.offset });
      else
        reject(
          Object.assign(Error(body.error || "The upload was interrupted."), {
            status: xhr.status,
            offset: body.offset,
          }),
        );
    };
    xhr.onerror = xhr.onabort = () => {
      settle();
      reject(Error("The connection dropped."));
    };
    xhr.send(chunk);
  });
}

// Signed in through the browser (no Tailscale app), requests travel through
// the page's own tailnet node, which XMLHttpRequest can't use: send the chunk
// with fetch; progress moves a chunk at a time.
async function putChunkThroughTailnet(
  peer: Peer,
  id: string,
  offset: number,
  chunk: Blob,
  onLoaded: (loaded: number) => void,
  signal: AbortSignal,
) {
  let body: { offset?: number; error?: string } = {};
  let status = 0;
  // (AbortSignal.any is missing on older iOS.)
  const stop = new AbortController();
  const abort = () => stop.abort();
  const timer = setTimeout(abort, IDLE_MS * 4);
  signal.addEventListener("abort", abort);
  try {
    const response = await fetch(
      `${peer.url}/api/files/uploads/${id}?offset=${offset}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${peer.token}`,
          "Content-Type": "application/octet-stream",
        },
        body: chunk,
        redirect: "error",
        signal: stop.signal,
      },
    );
    status = response.status;
    body = await response.json().catch(() => ({}));
  } catch {
    throw Error("The connection dropped.");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
  if (status >= 200 && status < 300 && typeof body.offset === "number") {
    onLoaded(chunk.size);
    return { offset: body.offset };
  }
  throw Object.assign(Error(body.error || "The upload was interrupted."), {
    status,
    offset: body.offset,
  });
}

// Computers running an older Reach take one request per file.
function legacyUpload(
  peer: Peer,
  root: number,
  dir: string,
  file: File,
  onLoaded: (loaded: number) => void,
  signal: AbortSignal,
) {
  return new Promise<void>((resolve, reject) => {
    checkCanceled(signal);
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append("file", file);
    xhr.open(
      "POST",
      `${peer.url}/api/files/upload?${new URLSearchParams({ root: String(root), path: dir })}`,
    );
    xhr.setRequestHeader("Authorization", `Bearer ${peer.token}`);
    let idle = setTimeout(() => xhr.abort(), IDLE_MS);
    const abort = () => xhr.abort();
    const settle = () => {
      clearTimeout(idle);
      signal.removeEventListener("abort", abort);
    };
    signal.addEventListener("abort", abort);
    xhr.upload.onprogress = (e) => {
      clearTimeout(idle);
      idle = setTimeout(() => xhr.abort(), IDLE_MS);
      onLoaded(e.loaded);
    };
    xhr.onload = () => {
      settle();
      let body: { error?: string } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else
        reject(
          Object.assign(Error(body.error || "The upload didn't finish."), {
            status: xhr.status,
          }),
        );
    };
    xhr.onerror = xhr.onabort = () => {
      settle();
      reject(Error("The connection dropped. Try again."));
    };
    xhr.send(form);
  });
}

async function sendFile(
  peer: Peer,
  root: number,
  dir: string,
  file: Blob,
  name: string,
  signal: AbortSignal,
  progress: (done: number) => void,
  waiting: () => void,
) {
  checkCanceled(signal);
  const begin = () =>
    post<{ id: string; offset: number; chunk: number }>(
      peer,
      "/api/files/uploads",
      { root, path: dir, name, size: file.size },
    );
  let session: { id: string; offset: number; chunk: number };
  try {
    session = await begin();
  } catch (e) {
    checkCanceled(signal);
    if (!olderReach(e)) throw e;
    return legacyUpload(
      peer,
      root,
      dir,
      new File([file], name),
      progress,
      signal,
    );
  }
  let offset = session.offset,
    failures = 0,
    restarts = 0;
  const cancel = () =>
    void request(peer, `/api/files/uploads/${session.id}`, {
      method: "DELETE",
    }).catch(() => {});
  signal.addEventListener("abort", cancel);
  try {
    if (signal.aborted) cancel();
    checkCanceled(signal);
    while (offset < file.size) {
      checkCanceled(signal);
      const end = Math.min(file.size, offset + session.chunk);
      try {
        ({ offset } = await putChunk(
          peer,
          session.id,
          offset,
          file.slice(offset, end),
          (loaded) => progress(offset + loaded),
          signal,
        ));
        failures = 0;
        progress(offset);
      } catch (e) {
        if (signal.aborted) throw e;
        const failure = e as { status?: number; offset?: number };
        // Out of step (a retry after a chunk that did arrive): continue there.
        if (failure.status === 409 && typeof failure.offset === "number") {
          offset = failure.offset;
          continue;
        }
        if (!retryable(e) || ++failures > 8) throw e;
        waiting();
        await whenReachable(signal);
        await pause(Math.min(15000, 1000 * 2 ** (failures - 1)), signal);
        // Ask where to continue; the computer may have restarted.
        try {
          ({ offset } = await request<{ offset: number }>(
            peer,
            `/api/files/uploads/${session.id}`,
            { signal },
          ));
        } catch (lost) {
          checkCanceled(signal);
          if ((lost as { status?: number }).status !== 404 || ++restarts > 2)
            throw lost;
          session = await begin();
          if (signal.aborted) cancel();
          checkCanceled(signal);
          offset = 0;
        }
      }
    }
    checkCanceled(signal);
    await request(peer, `/api/files/uploads/${session.id}/complete`, {
      method: "POST", body: JSON.stringify({}), signal,
    }).catch((e) => {
      if ((e as { status?: number }).status === 404)
        throw Error(
          `The folder you were uploading to no longer exists on ${peer.name}.`,
        );
      throw e;
    });
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

// Upload files one after another; `onEach` runs as each one lands.
export function uploadFiles(
  peer: Peer,
  root: number,
  dir: string,
  files: File[],
  onEach: (name: string) => void,
) {
  const jobs = files.map((file) => ({
    file,
    job: track("upload", file.name, file.size, peer.name),
  }));
  const run = async ({ file, job }: (typeof jobs)[number]) => {
    try {
      await sendFile(
        peer,
        root,
        dir,
        file,
        file.name,
        job.signal,
        job.progress,
        job.waiting,
      );
      checkCanceled(job.signal);
      job.finish();
      onEach(file.name);
    } catch (e) {
      job.fail(e);
      job.transfer.retry = () => {
        dismiss(job.transfer.id);
        uploadFiles(peer, root, dir, [file], onEach);
      };
    }
  };
  void (async () => {
    for (const item of jobs) if (!item.job.signal.aborted) await run(item);
  })();
}

// A file's bytes with progress in the tray (for the app, and as a fallback).
export async function downloadWithProgress(
  peer: Peer,
  root: number,
  entry: FileEntry,
) {
  const job = track("download", entry.name, entry.size, peer.name);
  try {
    const blob = await fileBlob(peer, entry.path, root, {
      signal: job.signal,
      onProgress: (done) => job.progress(done),
    });
    job.finish();
    return blob;
  } catch (e) {
    job.fail(e);
    throw e;
  }
}

// In a browser: hand the file to the browser's own download manager through
// a short-lived link (progress, background, and no copy held in memory).
// False when the computer's Reach is too old to make links.
export async function downloadThroughBrowser(
  peer: Peer,
  root: number,
  entry: FileEntry,
) {
  // The download manager can't reach the computer without the Tailscale app.
  if (tailnetBrowser()) return false;
  try {
    const { url } = await request<{ url: string }>(
      peer,
      `/api/files/download-link?${new URLSearchParams({ root: String(root), path: entry.path })}`,
    );
    const a = document.createElement("a");
    a.href = peer.url + url;
    a.download = entry.name;
    a.rel = "noreferrer";
    document.body.append(a);
    a.click();
    a.remove();
    return true;
  } catch (e) {
    if (olderReach(e)) return false;
    throw e;
  }
}

// Copy a file from one computer to another: download, then resumable upload.
export async function sendToComputer(
  from: Peer,
  root: number,
  entry: FileEntry,
  to: Peer,
) {
  const job = track("send", entry.name, entry.size * 2, to.name);
  try {
    const blob = await fileBlob(from, entry.path, root, {
      signal: job.signal,
      onProgress: (done) => job.progress(done),
    });
    await sendFile(
      to,
      0,
      "",
      blob,
      entry.name,
      job.signal,
      (done) => job.progress(entry.size + done),
      job.waiting,
    );
    job.finish();
  } catch (e) {
    job.fail(e);
    throw e;
  }
}

// The iPhone app: downloads run in an iOS background session, so they carry
// on while Reach is in the background or closed (ios/App/App/BackgroundTransfer.swift).
type Finished = { id: string; name: string; uri: string };
const native = registerPlugin<{
  download(options: {
    url: string;
    headers: Record<string, string>;
    name: string;
  }): Promise<{ id: string }>;
  cancel(options: { id: string }): Promise<void>;
  finished(): Promise<{ files: Finished[] }>;
  addListener(
    event: "progress" | "done" | "failed",
    listener: (data: {
      id: string;
      done?: number;
      total?: number;
      name?: string;
      uri?: string;
      status?: number;
      error?: string;
      canceled?: boolean;
    }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}>("BackgroundTransfer");
export const backgroundDownloads = () =>
  isNative && Capacitor.isPluginAvailable("BackgroundTransfer");
const saveAction = (file: Finished) => ({
  label: "Save",
  run: () => void Share.share({ files: [file.uri] }).catch(() => {}),
});
// Downloads that finished while the app was closed, offered to save.
let collected = false;
export async function collectFinishedDownloads() {
  if (collected || !backgroundDownloads()) return;
  collected = true;
  const { files } = await native.finished().catch(() => ({ files: [] }));
  for (const file of files) {
    const job = track("download", file.name, 0, "");
    job.transfer.action = saveAction(file);
    job.finish(false);
  }
}

export async function downloadInBackground(
  peer: Peer,
  root: number,
  entry: FileEntry,
  gone: () => void,
) {
  const job = track("download", entry.name, entry.size, peer.name);
  // Listen first: the native side answers `download` before any event.
  let id = "";
  const handles: { remove: () => Promise<void> }[] = [];
  const stop = () => handles.splice(0).forEach((h) => void h.remove());
  handles.push(
    await native.addListener("progress", (e) => {
      if (e.id === id && e.done !== undefined) job.progress(e.done);
    }),
    await native.addListener("done", (e) => {
      if (e.id !== id || !e.uri) return;
      stop();
      const action = saveAction({ id, name: entry.name, uri: e.uri });
      job.transfer.action = action;
      job.finish(false);
      // Still in front: open Save / Share straight away, as before.
      if (document.visibilityState === "visible") action.run();
    }),
    await native.addListener("failed", (e) => {
      if (e.id !== id) return;
      stop();
      if (e.canceled) return;
      if (e.status === 404) gone();
      job.fail(
        Error(
          e.status === 401 || e.status === 403
            ? "This device's access to the computer ended."
            : e.status === 404
              ? `${entry.name} was moved or deleted.`
              : e.error || "The download stopped.",
        ),
      );
    }),
  );
  try {
    ({ id } = await native.download({
      url: `${peer.url}/api/files/content?${new URLSearchParams({ path: entry.path, root: String(root) })}`,
      headers: { Authorization: `Bearer ${peer.token}` },
      name: entry.name,
    }));
  } catch (e) {
    stop();
    job.fail(e);
    return;
  }
  job.signal.addEventListener("abort", () => void native.cancel({ id }));
}
