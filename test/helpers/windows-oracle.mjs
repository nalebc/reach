// Windows' own tools, read independently of Reach's helpers: the second
// opinion test/windows-tailscaled-peer.test.mjs checks the peer check against
// (docs/parity/D-public-door.md §8). Every parser reads numbers, SIDs and
// addresses by position, never by localized words.

// `netstat -ano -p tcp`: one row per connection. The state word is localized
// (ESTABLISHED, HERGESTELLT…), so it's kept as said.
export function parseNetstat(text) {
  const rows = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = /^\s*(TCP)\s+(\S+):(\d+)\s+(\S+):(\d+)\s+(\S+)\s+(\d+)\s*$/i.exec(line);
    if (!match) continue;
    const [, proto, localAddress, localPort, remoteAddress, remotePort, state, pid] = match;
    rows.push({
      proto: proto.toUpperCase(),
      local: { address: localAddress, port: Number(localPort) },
      remote: { address: remoteAddress, port: Number(remotePort) },
      state,
      pid: Number(pid),
    });
  }
  return rows;
}

// `sc queryex <service>`: its type and state codes and its process id.
// Field names are localized (TYPE/TYP, STATE/STATUS); the codes aren't.
export function parseScQueryex(text) {
  const lines = String(text || "").split(/\r?\n/);
  const field = (pattern) => lines.map((line) => pattern.exec(line)).find(Boolean);
  const name = field(/^\s*\S+\s*:\s*(\S.*?)\s*$/);
  const type = field(/:\s*([0-9a-f]+)\s+\w*(?:WIN32|KERNEL|FILE_SYSTEM|USER)\w*\s*$/i);
  const state = field(/:\s*(\d)\s+(STOPPED|START_PENDING|STOP_PENDING|RUNNING|CONTINUE_PENDING|PAUSE_PENDING|PAUSED)\b/);
  const pid = field(/^\s*PID\s*:\s*(\d+)\s*$/);
  return {
    name: name ? name[1] : "",
    type: type ? parseInt(type[1], 16) : NaN,
    state: state ? Number(state[1]) : NaN,
    running: state ? state[2] === "RUNNING" : false,
    pid: pid ? Number(pid[1]) : NaN,
  };
}

// `whoami /groups /fo csv`: the SIDs of the groups in this token (S-1-5-4,
// INTERACTIVE, for a signed-in session).
export function parseWhoamiGroups(csv) {
  const sids = [];
  for (const line of String(csv || "").split(/\r?\n/))
    for (const [, field] of line.matchAll(/"([^"]*)"/g))
      if (/^S-1-\d+(?:-\d+)+$/.test(field)) sids.push(field);
  return sids;
}
