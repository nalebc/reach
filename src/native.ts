import { Capacitor, registerPlugin } from "@capacitor/core";
import { App as NativeApp } from "@capacitor/app";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { shareName, shareCancelled } from "./sharing";

export const isNative = Capacitor.isNativePlatform();

// Implemented in ios/App/App/QRScanner.swift.
const QRScanner = registerPlugin<{ scan(): Promise<{ value: string }> }>(
  "QRScanner",
);

import { parsePairLink, type PairLink } from "./connection-link";
export { parsePairLink, type PairLink } from "./connection-link";

export class ScanCancelled extends Error {}

export async function scanPairCode(): Promise<PairLink> {
  let value: string;
  try {
    ({ value } = await QRScanner.scan());
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code === "CANCELLED") throw new ScanCancelled();
    throw Error(err.message || "The camera could not start.");
  }
  const link = parsePairLink(value);
  if (!link)
    throw Error(
      "That isn’t a Reach code. Scan the code shown by Reach on your computer.",
    );
  return link;
}

// Deep links from the system Camera, and the link that launched the app.
export function onPairLink(handle: (link: PairLink) => void) {
  // A browser QR uses a fragment: it is never sent in the HTTP request or Referer.
  // Consume it before any API request and remove it from the visible URL/history.
  const acceptBrowser = () => {
    const fragment = new URLSearchParams(location.hash.slice(1));
    const code = fragment.get("pair");
    if (!code) return;
    history.replaceState(null, "", location.pathname + location.search);
    if (
      /^\d{8}$/.test(code) &&
      (location.protocol === "https:" ||
        ["localhost", "127.0.0.1"].includes(location.hostname))
    ) {
      handle({
        url: location.origin,
        code,
        name: (fragment.get("name") || "your computer").slice(0, 80),
      });
    }
  };
  acceptBrowser();
  window.addEventListener("hashchange", acceptBrowser);
  if (!isNative)
    return () => window.removeEventListener("hashchange", acceptBrowser);
  const seen = (code: string) => {
    if (localStorage.getItem("reach.lastPairCode") === code) return true;
    localStorage.setItem("reach.lastPairCode", code);
    return false;
  };
  const accept = (url?: string) => {
    const link = url ? parsePairLink(url) : null;
    if (link && (!link.code || !seen(link.code))) handle(link);
  };
  NativeApp.getLaunchUrl().then((r) => accept(r?.url));
  const listener = NativeApp.addListener("appUrlOpen", (e) => accept(e.url));
  return () => {
    window.removeEventListener("hashchange", acceptBrowser);
    listener.then((l) => l.remove());
  };
}

const toBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

// WKWebView ignores <a download>; on iPhone hand the file to the share sheet.
export async function saveBlob(blob: Blob, name: string) {
  if (!isNative) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return;
  }
  try {
    await shareNativeFile(blob, name);
  } catch (e) {
    if (!shareCancelled(e)) throw e;
  }
}

export function nativeFileSharing() {
  return (
    Capacitor.isPluginAvailable("Share") &&
    Capacitor.isPluginAvailable("Filesystem")
  );
}

export async function shareNativeFile(blob: Blob, name: string) {
  if (!nativeFileSharing())
    throw Error(
      "Update the Reach app to enable file sharing, or open Reach’s HTTPS link in Safari.",
    );
  // A unique folder preserves the filename without overwriting another share.
  const folder = `reach-share-${crypto.randomUUID()}`;
  const file = await Filesystem.writeFile({
    path: `${folder}/${shareName(name)}`,
    data: await toBase64(blob),
    directory: Directory.Cache,
    recursive: true,
  });
  try {
    await Share.share({ files: [file.uri] });
  } finally {
    // iOS completes after the activity finishes. Android can resolve as soon as
    // a target is chosen, so leave its file in the OS-managed cache for readers.
    if (Capacitor.getPlatform() === "ios") {
      await Filesystem.rmdir({
        path: folder,
        directory: Directory.Cache,
        recursive: true,
      }).catch(() => {});
    }
  }
}
