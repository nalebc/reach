import { useEffect, useState } from "react";
import { ScanFace } from "lucide-react";
import { post, request, type Peer } from "./api";
import {
  faceIdError,
  faceIdReady,
  sameComputer,
  signWithFaceId,
  type FaceOptions,
} from "./passkeys";
import "./settings-list.css";
import "./faceid.css";

// Settings → Agents: Face ID on your phone confirms each agent connection
// you allow. One row with a switch, only while Face ID is set up on this
// computer and only for your own devices: anyone else asking the Mac for
// either gets refused, and sees nothing here. Turning it off takes Face ID
// (the switch guards against a phone in the wrong hands): its options come
// before the tap, since Safari shows Face ID straight from a tap only, and
// the tap calls WebAuthn first thing.
export default function AgentFaceIdSetting({ peer }: { peer: Peer }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [note, setNote] = useState("");
  const [ready, setReady] = useState(false);
  const [options, setOptions] = useState<FaceOptions | null>(null);
  const here = sameComputer(peer.url);
  useEffect(() => {
    let live = true;
    Promise.all([
      request<{ passkeys?: unknown[] }>(peer, "/api/auth/passkeys"),
      request<{ faceIdForAgents?: boolean }>(peer, "/api/settings"),
    ]).then(
      ([keys, settings]) =>
        live &&
        setOn(keys.passkeys?.length ? settings.faceIdForAgents === true : null),
      () => live && setOn(null),
    );
    void faceIdReady().then((value) => live && setReady(value));
    return () => {
      live = false;
    };
  }, [peer.url, peer.token]);
  useEffect(() => {
    if (!on || !ready || !here || options) return;
    let live = true;
    post<FaceOptions>(peer, "/api/settings/passkey/options", {}).then(
      (fetched) => live && setOptions(fetched),
      (e: Error) => live && setNote(e.message),
    );
    return () => {
      live = false;
    };
  }, [on, ready, here, options]);
  if (on === null) return null;
  const toggle = async () => {
    // Off: Face ID first thing in the tap. On: the switch alone.
    const answer = on && options ? signWithFaceId(options) : null;
    if (answer) setOptions(null); // used once, whatever the answer
    setNote("");
    try {
      const credential = answer ? await answer : undefined;
      const settings = await post<{ faceIdForAgents?: boolean }>(
        peer,
        "/api/settings",
        { faceIdForAgents: !on, ...(credential ? { credential } : {}) },
      );
      setOn(settings.faceIdForAgents === true);
    } catch (e) {
      const err = e as Error & { status?: number; body?: { error?: string } };
      setNote(
        answer && (!err.status || err.status === 400 || err.status === 401)
          ? err.body?.error || faceIdError(err)
          : err.message,
      );
    }
  };
  return (
    <section className="agent-faceid" aria-label="Face ID for agents">
      <div className="gs-group">
        <div className="gs-row">
          <ScanFace size={21} />
          <span className="gs-label">
            Face ID confirms approvals
            <small>Each agent connection you allow</small>
          </span>
          <button
            role="switch"
            aria-checked={on}
            aria-label="Face ID confirms approvals"
            className={`switch ${on ? "on" : ""}`}
            onClick={() => void toggle()}
          >
            <span />
          </button>
        </div>
      </div>
      {note && <p className="gs-foot">{note}</p>}
    </section>
  );
}
