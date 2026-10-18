import path from "node:path";
import { windowsReaches } from "../../scripts/instances.mjs";
import { windowsProcesses } from "../../server/windows-processes.mjs";

// `stop` also recognizes background starters in `processes`, independently
// of `hosts`. Keep both inventories within the selected fixture's tree.
export const scopeWindowsStop = (found, pid) => {
  const hosts = found.hosts.filter((host) => host.pid === pid);
  const owned = new Set([pid, ...hosts.flatMap((host) => host.descendants.map((child) => child.pid))]);
  return { ...found, hosts, processes: found.processes?.filter((entry) => owned.has(entry.pid)) ?? null };
};

// Foreground fixtures never operate a PC-wide Scheduled Task. A wrongly
// scoped starter must fail the fixture before any real task operation.
const unexpectedTask = () => { throw Error("A foreground stop fixture tried to operate a background task."); };
export const foregroundTask = Object.freeze({
  state: () => ({ installed: false, ours: false }),
  hold: unexpectedTask, end: unexpectedTask, release: unexpectedTask, run: unexpectedTask,
});

// What `stop` finds (scripts/stop.mjs `reaches`), limited to one test's Reach
// (`pid`), started with launch() directly: on a real PC from Windows' own
// process list, where it has no scripts\bootstrap.mjs entry to be known by;
// where the list can't be read, from its status file. Never another Reach on
// this computer.
export const onlyReach = ({ pid, root, state = path.join(root, ".reach") }) => async () => {
  const found = await windowsReaches({ root, state, list: () => windowsProcesses({ nativeDir: path.join(state, "native") }) });
  if (found.partial) return scopeWindowsStop(found, pid);
  const listed = found.processes.find((p) => p.pid === pid);
  return scopeWindowsStop({ ...found, hosts: listed ? [{ pid, startedAt: listed.startedAt, root, terminals: [], descendants: [] }] : [] }, pid);
};
