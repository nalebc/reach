import { useEffect, useState } from "react";
import { request, type Device, type Peer } from "./api";
import type { CodexStatus } from "./capabilities";

export function useCodexAvailability(
  peer: Peer | undefined,
  device: Device | null,
  revision: number,
): CodexStatus {
  const key = peer ? `${peer.id}:${peer.url}:${peer.token}` : "";
  const permitted =
    !!device && (!device.access || device.access.scopes.includes("codex"));
  const installed =
    permitted &&
    device.capabilities.codex &&
    device.tools?.codex?.installed !== false;
  const [result, setResult] = useState<{
    key: string;
    state: CodexStatus["state"];
  } | null>(null);
  useEffect(() => {
    if (!peer || !installed) {
      setResult(null);
      return;
    }
    const controller = new AbortController();
    let checking = false;
    setResult((old) => (old?.key === key ? old : { key, state: "checking" }));
    const check = async () => {
      if (checking || document.hidden) return;
      checking = true;
      try {
        const status = await request<{ available: boolean; signedIn: boolean }>(
          peer,
          "/api/codex/status",
          {
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(12000),
            ]),
          },
        );
        if (!controller.signal.aborted)
          setResult({
            key,
            state:
              status.available === true
                ? status.signedIn === true
                  ? "ready"
                  : "signin"
                : "unavailable",
          });
      } catch {
        if (!controller.signal.aborted)
          setResult({ key, state: "unavailable" });
      } finally {
        checking = false;
      }
    };
    void check();
    const timer = setInterval(check, 30000);
    document.addEventListener("visibilitychange", check);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, [key, installed, revision]);
  if (!installed) return { state: "missing" };
  return result?.key === key ? { state: result.state } : { state: "checking" };
}
