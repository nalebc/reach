import test from 'node:test';
import assert from 'node:assert/strict';
import { browserPrivatePaths, isBrowserPrivatePath } from '../server/browser-private-paths.mjs';

test('broad shares exclude enforcement source, state, owner profiles and credentials', () => {
  const paths = browserPrivatePaths({ dataDir: '/workspace/state', agentPolicyFile: '/workspace/policy.json', privatePaths: ['/workspace/secret'] },
    { home: '/owner', appRoot: '/workspace/reach' });
  for (const file of ['/workspace/reach/server/index.mjs', '/workspace/state/clients.json', '/workspace/policy.json',
    '/workspace/secret/token', '/owner/Library/Application Support/Google/Chrome/Default/Cookies',
    '/owner/.ssh/id_ed25519', '/some/share/.aws/credentials', '/some/share/.CODEX/auth.json', '/Library/Keychains/keychain'])
    assert.equal(isBrowserPrivatePath(file, paths), true, file);
  for (const file of ['/owner/Desktop/task.txt', '/workspace/reach-project/readme.md', '/workspace/secrets-example'])
    assert.equal(isBrowserPrivatePath(file, paths), false, file);
});

// Windows (docs/WINDOWS_AGENT_PARITY.md, workstream A): what a Mac keeps in
// ~/Library is in AppData, protected as a whole as ~/Library is; and the
// places outside it a Mac protects have Windows equivalents. On any host.
const win = { platform: 'win32' };
const windowsPaths = (env = {}) => browserPrivatePaths({ dataDir: String.raw`C:\Users\me\.reach`, agentPolicyFile: String.raw`C:\Users\me\.reach\policy.json` },
  { home: String.raw`C:\Users\me`, appRoot: String.raw`C:\Users\me\code\reach`, env, ...win });

test('on Windows, browser profiles, mail, credential stores and startup places are private', () => {
  const paths = windowsPaths();
  for (const file of [
    String.raw`C:\Users\me\AppData\Local\Google\Chrome\User Data\Default\Login Data`, String.raw`C:\Users\me\AppData\Local\Microsoft\Edge\User Data\Default\Cookies`,
    String.raw`C:\Users\me\AppData\Local\BraveSoftware\Brave-Browser\User Data\Default\Login Data`, String.raw`C:\Users\me\AppData\Roaming\Mozilla\Firefox\Profiles\x.default\logins.json`,
    String.raw`C:\Users\me\AppData\Roaming\Opera Software\Opera Stable\Login Data`, String.raw`C:\Users\me\AppData\Local\Vivaldi\User Data\Default\Login Data`,
    String.raw`C:\Users\me\AppData\Local\Microsoft\Outlook\me@example.com.ost`, String.raw`C:\Users\me\AppData\Roaming\Thunderbird\Profiles\x\logins.json`,
    String.raw`C:\Users\me\AppData\Local\Packages\microsoft.windowscommunicationsapps_8wekyb3d8bbwe\LocalState\x`,
    String.raw`C:\Users\me\AppData\Roaming\Microsoft\Credentials\ABC`, String.raw`C:\Users\me\AppData\Local\Microsoft\Credentials\ABC`,
    String.raw`C:\Users\me\AppData\Roaming\Microsoft\Protect\S-1-5-21-1\key`, String.raw`C:\Users\me\AppData\Local\Microsoft\Vault\x`,
    String.raw`C:\Users\me\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\run.lnk`, String.raw`C:\Users\me\AppData\LocalLow\x`,
    String.raw`C:\ProgramData\Microsoft\Windows\Start Menu\Programs\StartUp\run.lnk`, String.raw`C:\ProgramData\Tailscale\server-state.conf`,
    String.raw`C:\Program Files\Tailscale\tailscaled.exe`, String.raw`C:\Windows\System32\config\SAM`, String.raw`C:\Windows\System32\Tasks\job`,
    String.raw`C:\Users\me\Documents\PowerShell\Microsoft.PowerShell_profile.ps1`, String.raw`C:\Users\me\Documents\WindowsPowerShell\profile.ps1`,
    String.raw`C:\Users\me\.ssh\id_ed25519`, String.raw`C:\Users\me\code\reach\server\index.mjs`, String.raw`C:\Users\me\.reach\clients.json`,
    // One file whatever its letters' case, prefix or trimmed dots.
    String.raw`c:\users\ME\appdata\roaming\microsoft\credentials\abc`, String.raw`\\?\C:\Users\me\AppData\Local\x`, String.raw`C:\Users\me\AppData.\Local\x`,
  ])
    assert.equal(isBrowserPrivatePath(file, paths, win), true, file);
  for (const file of [String.raw`C:\Users\me\Documents\notes.txt`, String.raw`C:\Users\me\Desktop\task.txt`, String.raw`C:\Users\me\AppDataBackup\x`,
    String.raw`C:\Program Files\Other\x.exe`, String.raw`C:\Users\me\code\reach-notes\a.txt`, String.raw`C:\Windows\System32\notepad.exe`])
    assert.equal(isBrowserPrivatePath(file, paths, win), false, file);
});

test('on Windows, the folders come from where Windows says they are', () => {
  const paths = windowsPaths({ APPDATA: String.raw`D:\Roaming\me`, LOCALAPPDATA: String.raw`D:\Local\me`, ProgramData: String.raw`E:\ProgramData`,
    SystemRoot: String.raw`E:\Windows`, ProgramFiles: String.raw`E:\Apps`, OneDrive: String.raw`C:\Users\me\OneDrive`, windir: 'relative\\not-a-folder' });
  for (const file of [String.raw`D:\Roaming\me\Mozilla\Firefox\x`, String.raw`D:\Local\me\Google\Chrome\x`, String.raw`E:\ProgramData\Tailscale\x`,
    String.raw`E:\ProgramData\Microsoft\Windows\Start Menu\Programs\StartUp\x.lnk`, String.raw`E:\Windows\System32\config\SAM`, String.raw`E:\Apps\Tailscale\x.exe`,
    String.raw`C:\Users\me\OneDrive\Documents\PowerShell\profile.ps1`, String.raw`C:\Users\me\AppData\Roaming\x`])
    assert.equal(isBrowserPrivatePath(file, paths, win), true, file);
  assert.ok(!paths.some((entry) => /not-a-folder/.test(entry)), 'a folder that is not an absolute path is ignored');
});

test('a Mac keeps exactly its own list', () => {
  const options = { home: '/owner', appRoot: '/workspace/reach' };
  const config = { dataDir: '/workspace/state', agentPolicyFile: '/workspace/policy.json', privatePaths: ['/workspace/secret'] };
  if (process.platform === 'darwin') assert.deepEqual(browserPrivatePaths(config, { ...options, platform: 'darwin', env: { APPDATA: 'C:\\x' } }), browserPrivatePaths(config, options));
  assert.ok(!browserPrivatePaths(config, { ...options, platform: 'darwin' }).some((entry) => /AppData|ProgramData|System32/i.test(entry)));
});
