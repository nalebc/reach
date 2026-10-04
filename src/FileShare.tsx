import { useEffect, useRef, useState } from "react";
import { Download, Share2, FileText } from "lucide-react";
import { bytes, fileBlob, type FileEntry, type Peer } from "./api";
import {
  isNative,
  nativeFileSharing,
  saveBlob,
  shareNativeFile,
} from "./native";
import {
  canShareFile,
  makeShareFile,
  MAX_SHARE_BYTES,
  shareBrowserFile,
  shareCancelled,
} from "./sharing";
import { ErrorLine, Modal, Spinner } from "./ui";

export default function FileShare({
  peer,
  entry,
  root,
  close,
  download,
}: {
  peer: Peer;
  entry: FileEntry;
  root: number;
  close: () => void;
  download: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState("");
  const sharing = useRef(false);
  const tooLarge = entry.size > MAX_SHARE_BYTES;
  useEffect(() => {
    if (tooLarge) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
      setError(
        "The transfer took too long. Check that your computer is awake and connected, then try again.",
      );
    }, 120000);
    setError("");
    setFile(null);
    fileBlob(peer, entry.path, root, {
      signal: controller.signal,
      maxBytes: MAX_SHARE_BYTES,
    })
      .then((blob) => {
        if (!controller.signal.aborted)
          setFile(makeShareFile(blob, entry.name));
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [
    peer.id,
    peer.url,
    peer.token,
    entry.path,
    entry.name,
    root,
    attempt,
    tooLarge,
  ]);
  const supported =
    file && (isNative ? nativeFileSharing() : canShareFile(file));
  const share = async () => {
    if (!file || sharing.current) return;
    sharing.current = true;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      // Keep this call in the click gesture. Preparation has already finished.
      await (isNative
        ? shareNativeFile(file, file.name)
        : shareBrowserFile(file));
      setStatus("You can share this file again or close this window.");
    } catch (e) {
      if (shareCancelled(e))
        setStatus(
          "Sharing canceled. Your file is ready if you want to try again.",
        );
      else
        setError(
          "Couldn’t open sharing. Try again, or download the file and share it from your phone’s Files or Downloads app.",
        );
    } finally {
      sharing.current = false;
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Share file"
      onClose={() => {
        if (!sharing.current) close();
      }}
    >
      <div className="share-file-summary">
        <span className="file-icon">
          <FileText size={24} />
        </span>
        <div>
          <strong>{entry.name}</strong>
          <small>
            {bytes(file?.size ?? entry.size)} · From {peer.name}
          </small>
        </div>
      </div>
      <p className="share-description">
        Send a copy to an app on this device. The original stays on your
        computer.
      </p>
      {tooLarge ? (
        <p className="share-description">
          For files over 100 MB, download first, then share from Files or
          Downloads.
        </p>
      ) : !file && !error ? (
        <Spinner label="Getting your file ready…" />
      ) : null}
      <ErrorLine error={error} />
      {file && !supported && (
        <p className="share-description">
          {isNative
            ? "Update the Reach app to enable sharing, or open Reach’s HTTPS link in Safari."
            : "This browser can’t share this file directly. Download it, then share from Files or Downloads. On your phone, open Reach’s HTTPS link in Safari or Chrome."}
        </p>
      )}
      <div className="share-file-actions">
        {supported && (
          <button
            className="button primary full"
            disabled={busy}
            onClick={share}
          >
            <Share2 size={18} />
            {busy ? "Sharing…" : "Share to an app…"}
          </button>
        )}
        {error && !file && (
          <button
            className="button secondary full"
            onClick={() => setAttempt((n) => n + 1)}
          >
            Try again
          </button>
        )}
        {(file || tooLarge || error) &&
          (!isNative || (nativeFileSharing() && !supported)) && (
            <button
              className="button secondary full"
              disabled={busy}
              onClick={async () => {
                if (!file) {
                  close();
                  download();
                  return;
                }
                setBusy(true);
                try {
                  await saveBlob(file, file.name);
                  setStatus(
                    isNative
                      ? "Share sheet closed."
                      : "Download started. Open Files or Downloads to share it.",
                  );
                } catch (e) {
                  if (!shareCancelled(e)) setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Download size={18} />
              {isNative ? "Save or share a copy…" : "Download a copy"}
            </button>
          )}
      </div>
      {status && (
        <p className="share-description" role="status">
          {status}
        </p>
      )}
    </Modal>
  );
}
