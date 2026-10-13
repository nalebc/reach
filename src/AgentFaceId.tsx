import { useEffect, useState } from "react";
import { ScanFace } from "lucide-react";
import { post, request, type Peer } from "./api";
import { useFaceOptions } from "./face-options";
import {
  faceIdError,
  faceIdReady,
  sameComputer,
  signWithFaceId,
  unlockWords,
  type FaceOptions,
} from "./passkeys";
import "./settings-list.css";
import "./faceid.css";

// Settings → Agents: Face ID on your phone (in its own words: Touch ID,
// fingerprint or face unlock, Windows Hello…) confirms each agent connection
// you allow. One row with a switch, only while a passkey is set up on this
// computer and only for your own devices: anyone else asking the Mac for
// either gets refused, and sees nothing here. Turning it off takes Face ID
// (the switch guards against a phone in the wrong hands): its options come
// before the tap, since Safari shows Face ID straight from a tap only, the
// tap calls WebAuthn first thing, and nothing asks for new options while
// Face ID is up (src/face-options.ts). A tap that can't do it yet says why.
export default function AgentFaceIdSetting({ peer }: { peer: Peer }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [note, setNote] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const here = sameComputer(peer.url);
  const said = unlockWords();
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
  const face = useFaceOptions(
    on && ready && here
      ? () => post<FaceOptions>(peer, "/api/settings/passkey/options", {})
      : null,
    `${peer.url} ${peer.token}`,
  );
  if (on === null) return null;
  const toggle = async () => {
    if (busy) return setNote("One moment…");
    // Off: Face ID first thing in the tap. On: the switch alone.
    let answer: ReturnType<typeof signWithFaceId> | null = null;
    if (on && ready && here) {
      const got = face.take();
      if (!("options" in got))
        return setNote(
          got.wait === "failed"
            ? `${said.Word} isn't ready: ${got.error} Asking again; tap once more in a moment.`
            : got.wait === "renewed"
              ? "Renewed after a while on this page. Tap again."
              : `Getting ${said.word} ready. Tap again in a moment.`,
        );
      answer = signWithFaceId(got.options);
    }
    setBusy(true);
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
          ? err.body?.error || faceIdError(err, said)
          : err.message,
      );
    } finally {
      setBusy(false);
      if (answer) face.done();
    }
  };
  const shown =
    note || (on && face.error ? `${said.Word} isn't ready: ${face.error}` : "");
  return (
    <section className="agent-faceid" aria-label={`${said.title} for agents`}>
      <div className="gs-group">
        <div className="gs-row">
          <ScanFace size={21} />
          <span className="gs-label">
            {said.title} confirms approvals
            <small>Each agent connection you allow</small>
          </span>
          <button
            role="switch"
            aria-checked={on}
            aria-label={`${said.title} confirms approvals`}
            className={`switch ${on ? "on" : ""}`}
            onClick={() => void toggle()}
          >
            <span />
          </button>
        </div>
      </div>
      {shown && <p className="gs-foot">{shown}</p>}
    </section>
  );
}
