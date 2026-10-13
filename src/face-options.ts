import { useEffect, useRef, useState } from "react";
import type { FaceOptions } from "./passkeys";

// A passkey's options from the computer, for a page that asks for Face ID
// (or the device's own unlock) from a tap. Fetched before the tap: Safari
// only shows Face ID straight from one. Renewed before the computer's
// two-minute challenge runs out. And never fetched while Face ID is up or
// its answer is on its way: the computer keeps one challenge per purpose,
// and a new one replaces the one that answer was made for. That is what
// refused every add in Settings until Oct 13: the page asked for a new
// challenge the moment it was tapped.
const LIFE = 120000;
const MARGIN = 10000;

export type FaceTake =
  | { options: FaceOptions }
  // Why not now: still fetching, a fetch that failed (`error`, fetched
  // again), options too old (fetched again: tap again), or an answer
  // already on its way.
  | { wait: "loading" | "failed" | "renewed" | "busy"; error?: string };

export function useFaceOptions(
  load: (() => Promise<FaceOptions>) | null,
  key: string,
) {
  const [options, setOptions] = useState<FaceOptions | null>(null);
  const [error, setError] = useState("");
  const [round, setRound] = useState(0);
  const fetchedAt = useRef(0);
  const inFlight = useRef(false);
  const loader = useRef(load);
  loader.current = load;
  const enabled = !!load;
  useEffect(() => {
    if (!enabled || inFlight.current) return;
    let live = true;
    setOptions(null);
    setError("");
    loader.current!().then(
      (fetched) => {
        if (!live || inFlight.current) return;
        fetchedAt.current = Date.now();
        setOptions(fetched);
      },
      (e: Error) => live && setError(e?.message || "The computer didn't answer."),
    );
    const timer = setTimeout(() => {
      if (live && !inFlight.current) setRound((n) => n + 1);
    }, LIFE - MARGIN);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [enabled, key, round]);
  return {
    options,
    error,
    // In the tap: the options to use now (used once), or why not.
    take(): FaceTake {
      if (inFlight.current) return { wait: "busy" };
      if (!options) {
        if (!error) return { wait: "loading" };
        setRound((n) => n + 1);
        return { wait: "failed", error };
      }
      if (Date.now() - fetchedAt.current > LIFE - MARGIN) {
        setRound((n) => n + 1);
        return { wait: "renewed" };
      }
      inFlight.current = true;
      setOptions(null);
      return { options };
    },
    // The answer was sent, or Face ID didn't happen: the computer has used
    // that challenge either way, so fresh options for the next tap.
    done() {
      inFlight.current = false;
      setRound((n) => n + 1);
    },
  };
}
