import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { browserPrivatePaths, isBrowserPrivatePath } from '../server/browser-private-paths.mjs';
import { windowsJobDenies } from '../server/windows-sandbox.mjs';
import { createWindowsPrivateStage } from '../server/windows-private-stage.mjs';

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

test('modeled Windows jobs retain the reserved helper container when broad AppData is available for tools', () => {
  for (const local of [String.raw`C:\Users\me\AppData\Local`, String.raw`D:\Local\me`]) {
    const options = {home:String.raw`C:\Users\me`,platform:'win32',env:{LOCALAPPDATA:local}};
    const config = {dataDir:String.raw`C:\Users\me\.reach`,roots:[String.raw`C:\Users\me\Projects`]};
    const denied = windowsJobDenies(config,options);
    assert.ok(!denied.some(value => value.toLowerCase()===local.toLowerCase()),'tools in the broad LocalAppData root remain readable');
    assert.ok(denied.some(value => value.toLowerCase()===`${local}\\Reach`.toLowerCase()),'the separate hook stage container stays denied');
    assert.equal(isBrowserPrivatePath(`${local}\\Reach\\reach-private-stage-0123456789abcdef0123456789abcdef\\owners.exe`,denied,options),true);
    assert.equal(isBrowserPrivatePath(`${local}\\Programs\\tool.exe`,denied,options),false,'no blanket AppData deny is added');
  }
});

test('modeled verified staging root protects sibling processes even when LOCALAPPDATA differs from the KnownFolder', async () => {
  const sid = 'S-1-5-21-1-2-3-1001', actualRoot = String.raw`D:\VerifiedLocal\Reach`;
  const env = {SystemRoot:String.raw`C:\Windows`,LOCALAPPDATA:String.raw`E:\DifferentCallerLocal`};
  const reply = parent => async (_file,_args,options) => ({stdout:`reach-private-stage ${sid} ${Buffer.from(path.win32.join(parent,options.env.REACH_PRIVATE_STAGE_LEAF)).toString('base64')}\r\n`});
  // The fixed PowerShell command's response is modeled here. Actual Windows
  // execution must establish that its default root came from KnownFolder.
  const stage = await createWindowsPrivateStage({sid,env,run:reply(actualRoot)});
  assert.equal(stage.privateRoot,actualRoot);
  const options = {home:String.raw`C:\Users\me`,platform:'win32',env};
  const denied = windowsJobDenies({dataDir:String.raw`C:\Users\me\.reach`,privatePaths:[stage.dir,stage.privateRoot]},options);
  assert.ok(denied.includes(actualRoot),'the exact verified container survives the broad AppData filter');
  assert.equal(isBrowserPrivatePath(path.win32.join(actualRoot,'reach-private-stage-another-hook','owners.exe'),denied,options),true);
  assert.equal(isBrowserPrivatePath(String.raw`D:\VerifiedLocal\Programs\tool.exe`,denied,options),false);
  const explicit = await createWindowsPrivateStage({sid,env,parent:options.home,run:reply(options.home)});
  assert.equal(Object.hasOwn(explicit,'privateRoot'),false,'an explicit disposable parent does not mark Home private');
  const explicitDenies = windowsJobDenies({dataDir:String.raw`C:\Users\me\.reach`,privatePaths:[explicit.dir]},options);
  assert.equal(isBrowserPrivatePath(String.raw`C:\Users\me\Documents\project\file.txt`,explicitDenies,options),false);
  await assert.rejects(createWindowsPrivateStage({sid,env,run:reply(String.raw`D:\Unreserved`)}),{code:'EPRIVATESTAGE'});
});

test('modeled bootstrap failures retain bounded phase/class evidence without raw paths or exception messages', async () => {
  const sid = 'S-1-5-21-1-2-3-1001', env = {SystemRoot:String.raw`C:\Windows`};
  const raw = String.raw`C:\Users\private-person\secret-token`;
  const run = stderr => async () => { throw Object.assign(Error(raw),{stderr}); };
  await assert.rejects(createWindowsPrivateStage({sid,env,run:run(`unrelated ${raw}\r\nreach-private-stage-refused ancestors exception System.Management.Automation.MethodInvocationException System.UnauthorizedAccessException MethodInvocationException 84\r\n`)}),error => {
    assert.equal(error.code,'EPRIVATESTAGE');
    assert.deepEqual(error.stage,{phase:'ancestors',reason:'exception',exception:'System.Management.Automation.MethodInvocationException',innerException:'System.UnauthorizedAccessException',id:'MethodInvocationException',line:84});
    assert.ok(!JSON.stringify(error).includes(raw)); assert.ok(!error.message.includes(raw)); return true;
  });
  await assert.rejects(createWindowsPrivateStage({sid,env,run:run(`reach-private-stage-refused ancestors exception ${raw} none message 84`)}),error => {
    assert.deepEqual(error.stage,{phase:'command',reason:'unknown'}); assert.ok(!JSON.stringify(error).includes(raw)); return true;
  });
});
