import { useEffect, useRef, useState } from "react";
import { fileBlob, type FileEntry, type Peer } from "./api";
import {
  isNative,
  nativeFileSharing,
  shareNativeFile,
  shareNativeFiles,
} from "./native";
import {
  canShareFile,
  makeShareFile,
  MAX_SHARE_BYTES,
  shareBrowserFile,
  shareCancelled,
} from "./sharing";

// Share opens the phone's share sheet straight away. Browsers only allow that
// during the tap itself, so a file is fetched as soon as someone shows they
// might share it (its actions or preview open) and is ready when they tap.
const WARM_LIMIT = 20 * 1024 * 1024;
const BUDGET = 60 * 1024 * 1024;
// Low Data / Data Saver mode: fetch only when the user actually taps Share.
const saveData = () =>
  !!(navigator as { connection?: { saveData?: boolean } }).connection?.saveData;
type Copy = { promise: Promise<File>; file?: File; failed?: boolean };
const copies = new Map<string, Copy>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((fn) => fn());
const keyOf = (peer: Peer, root: number, entry: FileEntry) =>
  JSON.stringify([
    peer.url,
    peer.token,
    root,
    entry.path,
    entry.modified,
    entry.size,
  ]);

function prepare(peer: Peer, root: number, entry: FileEntry, blob?: Blob) {
  const key = keyOf(peer, root, entry);
  const existing = copies.get(key);
  if (existing && !existing.failed) return existing;
  const copy = {} as Copy;
  copy.promise = (
    blob
      ? Promise.resolve(blob)
      : fileBlob(peer, entry.path, root, { maxBytes: MAX_SHARE_BYTES })
  )
    .then((data) => {
      copy.file = makeShareFile(data, entry.name);
      // Keep recent copies within a memory budget, oldest out first.
      const size = () =>
        [...copies.values()].reduce((n, c) => n + (c.file?.size || 0), 0);
      // Oldest finished copy out first; never one still being fetched, nor this one.
      while (size() > BUDGET) {
        const oldest = [...copies.entries()].find(
          ([, c]) => c !== copy && c.file,
        );
        if (!oldest) break;
        copies.delete(oldest[0]);
      }
      return copy.file;
    })
    .catch((e) => {
      copy.failed = true;
      throw e;
    })
    .finally(changed);
  copy.promise.catch(() => {});
  copies.delete(key);
  copies.set(key, copy);
  changed();
  return copy;
}

// A copy already on this device, so Download doesn't fetch the file twice.
export const preparedFile = (peer: Peer, root: number, entry: FileEntry) =>
  copies.get(keyOf(peer, root, entry))?.file;

export function useFileShare(
  peer: Peer,
  root: number,
  toast: (message: string) => void,
  // The file was moved or deleted on the computer.
  gone: (entry: FileEntry) => void = () => {},
) {
  const [, rerender] = useState(0);
  // Files whose share sheet the browser refused after fetching: tap again.
  const [armed, setArmed] = useState<string[]>([]);
  // Keep one prepared selection for the next tap, even if the shared cache
  // evicts part of a selection larger than its normal 60 MB warm budget.
  const waitingShare = useRef<{ key: string; files: File[] } | null>(null);
  useEffect(() => {
    waitingShare.current = null;
    setArmed([]);
  }, [peer.url, peer.token, root]);
  useEffect(() => {
    const update = () => rerender((n) => n + 1);
    listeners.add(update);
    return () => {
      listeners.delete(update);
    };
  }, []);
  const supported = isNative
    ? nativeFileSharing()
    : typeof navigator.share === "function";
  const available = (entry: FileEntry) =>
    supported && entry.type !== "directory" && entry.size <= MAX_SHARE_BYTES;
  const state = (entry: FileEntry) => {
    const key = keyOf(peer, root, entry);
    const copy = copies.get(key);
    if (!copy || copy.failed) return "idle";
    if (!copy.file) return "preparing";
    return armed.includes(key) ? "armed" : "ready";
  };
  const disarm = (key: string) => setArmed((a) => a.filter((k) => k !== key));
  const failed = (e: unknown) => {
    if (!shareCancelled(e))
      toast("Couldn’t open sharing. Use Download instead.");
  };
  const open = (key: string, file: File) => {
    disarm(key);
    if (isNative) return void shareNativeFile(file, file.name).catch(failed);
    if (!canShareFile(file))
      return toast("This browser can’t share this file. Use Download instead.");
    void shareBrowserFile(file).catch(failed);
  };
  return {
    available,
    state,
    // Start fetching a file someone is about to share (phone browsers only;
    // the app can share after a fetch). An already-loaded blob is reused.
    warm(entry: FileEntry, blob?: Blob) {
      if (!available(entry)) return;
      if (blob || (!isNative && !saveData() && entry.size <= WARM_LIMIT))
        prepare(peer, root, entry, blob);
    },
    share(entry: FileEntry) {
      if (!available(entry)) return;
      const key = keyOf(peer, root, entry);
      const copy = prepare(peer, root, entry);
      // Ready: open the share sheet within this tap.
      if (copy.file) return open(key, copy.file);
      copy.promise.then(
        (file) => {
          if (isNative || !canShareFile(file)) return open(key, file);
          // Some browsers still allow it a moment after the tap; otherwise
          // the button turns into "Tap to share".
          shareBrowserFile(file).then(
            () => disarm(key),
            (e) =>
              (e as Error)?.name === "NotAllowedError"
                ? setArmed((a) => (a.includes(key) ? a : [...a, key]))
                : failed(e),
          );
        },
        (e) =>
          (e as { status?: number })?.status === 404
            ? gone(entry)
            : toast((e as Error).message),
      );
    },
    // Several files in one share sheet (a selection). Same flow as one: share
    // at once when every copy is here, else fetch, then try or ask for a tap.
    shareMany(entries: FileEntry[]) {
      if (!entries.length) return;
      // A selection is all or nothing: never silently leave out a large file.
      if (!entries.every(available) || entries.reduce((sum, entry) => sum + entry.size, 0) > MAX_SHARE_BYTES)
        return toast("Share files totaling up to 100 MB. Use Download for larger selections.");
      const list = entries;
      if (list.length === 1) return this.share(list[0]);
      const key = JSON.stringify(list.map((e) => keyOf(peer, root, e)));
      const send = (files: File[]) => {
        waitingShare.current = null;
        disarm(key);
        if (files.reduce((sum, file) => sum + file.size, 0) > MAX_SHARE_BYTES)
          return toast("Share files totaling up to 100 MB. Use Download for larger selections.");
        if (isNative)
          return void shareNativeFiles(
            files.map((f) => ({ blob: f, name: f.name })),
          ).catch(failed);
        if (!canShareFile(files))
          return toast("This browser can’t share these files together.");
        return shareBrowserFile(files);
      };
      if (waitingShare.current?.key === key)
        return void send(waitingShare.current.files)?.catch(failed);
      const copies = list.map((e) => prepare(peer, root, e));
      if (copies.every((c) => c.file))
        return void send(copies.map((c) => c.file!))?.catch(failed);
      Promise.all(copies.map((c) => c.promise)).then(
        (files) =>
          send(files)?.catch((e) => {
            if ((e as Error)?.name === "NotAllowedError") {
              waitingShare.current = { key, files };
              setArmed((a) => (a.includes(key) ? a : [...a, key]));
            } else failed(e);
          }),
        (e) => toast((e as Error).message),
      );
    },
    manyState(entries: FileEntry[]) {
      const list = entries.filter(available);
      const states = list.map(state);
      if (states.includes("preparing")) return "preparing";
      return armed.includes(
        JSON.stringify(list.map((e) => keyOf(peer, root, e))),
      )
        ? "armed"
        : "idle";
    },
    forget(entry: FileEntry) {
      copies.delete(keyOf(peer, root, entry));
    },
  };
}
