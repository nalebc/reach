import path from "node:path";
import { windowsReaches } from "../../scripts/instances.mjs";
import { windowsProcesses } from "../../server/windows-processes.mjs";

// What `stop` finds (scripts/stop.mjs `reaches`), limited to one test's Reach
// (`pid`), started with launch() directly: on a real PC from Windows' own
// process list, where it has no scripts\bootstrap.mjs entry to be known by;
// where the list can't be read, from its status file. Never another Reach on
// this computer.
export const onlyReach = ({ pid, root, state = path.join(root, ".reach") }) => async () => {
  const found = await windowsReaches({ root, state, list: () => windowsProcesses({ nativeDir: path.join(state, "native") }) });
  if (found.partial) return { ...found, hosts: found.hosts.filter((host) => host.pid === pid) };
  const listed = found.processes.find((p) => p.pid === pid);
  return { ...found, hosts: listed ? [{ pid, startedAt: listed.startedAt, root, terminals: [], descendants: [] }] : [] };
};
