import test from "node:test";
import assert from "node:assert/strict";
import { parseNetstat, parseScQueryex, parseWhoamiGroups } from "./helpers/windows-oracle.mjs";

// The real-Windows peer check test's second opinion (netstat, sc, whoami),
// read by position on an English and a German Windows.

test("netstat -ano: connections by address, port and process, whatever the state is called", () => {
  const english = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1012
  TCP    127.0.0.1:51234        0.0.0.0:0              LISTENING       7788
  TCP    127.0.0.1:52001        127.0.0.1:51234        ESTABLISHED     4321
  TCP    127.0.0.1:51234        127.0.0.1:52001        ESTABLISHED     7788
  TCP    [::]:135               [::]:0                 LISTENING       1012
`;
  const german = `
Aktive Verbindungen

  Proto  Lokale Adresse         Remoteadresse          Status           PID
  TCP    127.0.0.1:52001        127.0.0.1:51234        HERGESTELLT     4321
  TCP    127.0.0.1:51234        0.0.0.0:0              ABHÖREN         7788
`;
  const rows = parseNetstat(english);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[2], { proto: "TCP", local: { address: "127.0.0.1", port: 52001 }, remote: { address: "127.0.0.1", port: 51234 }, state: "ESTABLISHED", pid: 4321 });
  assert.deepEqual(rows[4].local, { address: "[::]", port: 135 });
  const [hergestellt] = parseNetstat(german);
  assert.deepEqual([hergestellt.local.port, hergestellt.remote.port, hergestellt.pid, hergestellt.state], [52001, 51234, 4321, "HERGESTELLT"]);
  assert.deepEqual(parseNetstat(""), []);
});

test("sc queryex: the service's type, state and process id, in English or German", () => {
  const english = `
SERVICE_NAME: Tailscale
        TYPE               : 10  WIN32_OWN_PROCESS
        STATE              : 4  RUNNING
                                (STOPPABLE, NOT_PAUSABLE, ACCEPTS_SHUTDOWN)
        WIN32_EXIT_CODE    : 0  (0x0)
        SERVICE_EXIT_CODE  : 0  (0x0)
        CHECKPOINT         : 0x0
        WAIT_HINT          : 0x0
        PID                : 4321
        FLAGS              :
`;
  const german = `
DIENSTNAME: Tailscale
        TYP                : 10  WIN32_OWN_PROCESS
        STATUS             : 1  STOPPED
        WIN32_EXITCODE     : 1077  (0x435)
        DIENST_EXITCODE    : 0  (0x0)
        CHECKPOINT         : 0x0
        WARTE_HINWEIS      : 0x0
        PID                : 0
        FLAGS              :
`;
  assert.deepEqual(parseScQueryex(english), { name: "Tailscale", type: 0x10, state: 4, running: true, pid: 4321 });
  assert.deepEqual(parseScQueryex(german), { name: "Tailscale", type: 0x10, state: 1, running: false, pid: 0 });
  const missing = parseScQueryex("[SC] EnumQueryServicesStatus:OpenService FAILED 1060:\n\nThe specified service does not exist as an installed service.\n");
  assert.equal(missing.running, false);
  assert.ok(Number.isNaN(missing.pid));
});

test("whoami /groups: the SIDs only, whatever the groups are called", () => {
  const english = `"Group Name","Type","SID","Attributes"
"Everyone","Well-known group","S-1-1-0","Mandatory group, Enabled by default, Enabled group"
"BUILTIN\\Users","Alias","S-1-5-32-545","Mandatory group, Enabled by default, Enabled group"
"NT AUTHORITY\\INTERACTIVE","Well-known group","S-1-5-4","Mandatory group, Enabled by default, Enabled group"
"Mandatory Label\\Medium Mandatory Level","Label","S-1-16-8192",""
`;
  const german = `"Gruppenname","Typ","SID","Attribute"
"Jeder","Bekannte Gruppe","S-1-1-0","Verbindliche Gruppe, Standardmäßig aktiviert, Aktivierte Gruppe"
"NT-AUTORITÄT\\Batch","Bekannte Gruppe","S-1-5-3","Verbindliche Gruppe, Standardmäßig aktiviert, Aktivierte Gruppe"
`;
  assert.deepEqual(parseWhoamiGroups(english), ["S-1-1-0", "S-1-5-32-545", "S-1-5-4", "S-1-16-8192"]);
  assert.ok(parseWhoamiGroups(english).includes("S-1-5-4"));
  assert.deepEqual(parseWhoamiGroups(german), ["S-1-1-0", "S-1-5-3"]);
  assert.ok(!parseWhoamiGroups(german).includes("S-1-5-4"), "a batch token isn't interactive");
});
