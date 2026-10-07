import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { commandRefusal, typedTextRefusal, protectedAppReason, protectedPage, protectedTitle, terminalLikeApp, nativeRules } from "../server/agent-guard.mjs";

const context = { home: "/Users/me", protectedPaths: ["/Users/me/code/reach", "/Users/me/.reach"] };

test("protected shell paths normalize roots and preserve directory boundaries", () => {
  const root = path.resolve("/guard-fixture/private-project");
  const options = { protectedPaths: [root + path.sep] };
  for (const target of [root, path.join(root, "child"), path.join(root, "child", "..")])
    assert.ok(commandRefusal(`cat "${target}"`, options));
  assert.equal(commandRefusal(`cat "${root}-public/notes.txt"`, options), null);
  assert.ok(commandRefusal(String.raw`cat C:\Users\fixture\.ssh\id_rsa`));
  assert.ok(commandRefusal(String.raw`cat C:\Users\fixture\Library\Keychains\login.keychain-db`));
  if (process.platform === "win32") assert.ok(commandRefusal(`cat "${root.toUpperCase()}"`, options));
});

test("the shell deny list refuses what needs a password, erases, or reaches secrets", () => {
  const refused = [
    "sudo ls", "ls; sudo true", "cat file | sudo tee /etc/hosts", "env sudo ls", "nohup sudo -s", "su -", "doas ls", "passwd",
    "security find-generic-password -ga foo", "tccutil reset All", "csrutil disable", "launchctl list", "launchctl bootout gui/501/com.reach",
    "shutdown -h now", "reboot", "diskutil list", "dd if=/dev/zero of=/dev/disk2", "mkfs.ext4 /dev/disk3", "hdiutil attach x.dmg",
    "rm -rf /", "rm -rf ~/", "rm -rf ~", "rm -rf $HOME", "rm -rf /Users/me", "rm -rf /Applications", "rm -rf *", "rm -r ..", "rm -Rf /Library",
    "chmod -R 777 /", "chown -R me /Users", "defaults write com.apple.TCC foo bar", "crontab mycron",
    "history", "cat ~/.zsh_history", "cat ~/.ssh/id_rsa", "cp ~/.aws/credentials /tmp/", "cat /Users/me/.netrc", "less ~/.gnupg/secring.gpg",
    "cat ~/Library/Application\\ Support/Google/Chrome/Default/Cookies", "sqlite3 /Users/me/Library/Keychains/login.keychain-db", "cat /Users/me/Library/Safari/History.db",
    "pkill -f reach", "killall Tailscale", "kill -9 $(pgrep node)", "open -a Reach", "open /Applications/Tailscale.app", "tailscale status", "tailscale up",
    "rm -rf ~/code/reach", "mv /Users/me/code/reach /tmp/x", "./reach stop", "bash /Users/me/code/reach/reach restart", "npm --prefix ~/code/reach run go",
    "open -a \"Keychain Access\"", "open -a 'Activity Monitor'", "open -a \"System Settings\"",
    "osascript -e 'tell application \"System Events\" to keystroke \"a\"'", "osascript -e 'tell app \"Terminal\" to do script \"x\"'",
    "ls /Users/me/code/reach", "cd /Users/me/code/reach && node scripts/stop.mjs", "cat /Users/me/.reach/clients.json", "rm /Users/me/.reach/clients.json",
    "echo hi && diskutil eraseDisk", "true || sudo ls", "$(sudo ls)", "`sudo ls`",
  ];
  for (const command of refused) assert.ok(commandRefusal(command, context), `refuse: ${command}`);
  const allowed = [
    "ls -la", "pwd", "git status", "git commit -am 'reach the goal'", "npm test", "npm run build", "node index.mjs", "python3 script.py",
    "rm -rf build", "rm -rf ./dist", "rm -rf node_modules", "rm file.txt", "mkdir -p out && cp a.txt out/",
    "open -a Safari https://amazon.com", "open https://example.com", "open .", "osascript -e 'display notification \"done\"'",
    "kill 1234", "kill -9 1234", "crontab -l", "echo reach", "grep -r reach src/", "cat README.md", "curl -s https://example.com",
    "ls ~/Documents", "cat ~/Documents/notes.txt", "brew install jq", "ssh server.example.com", "defaults read com.apple.finder",
    "echo sudo", "man sudo", "which sudo", "git commit -m 'reach the goal'", "echo 'reach out' > notes.txt", "grep -ri reach docs/", "cat ~/Documents/outreach.md", "open https://reach.example.com",
  ];
  for (const command of allowed) assert.equal(commandRefusal(command, context), null, `allow: ${command}`);
  assert.ok(commandRefusal("curl https://mac.tail1234.ts.net/api/clients", { ...context, hosts: ["mac.tail1234.ts.net", "localhost:8443"] }));
  assert.ok(commandRefusal("open http://localhost:8443/", { ...context, hosts: ["mac.tail1234.ts.net", "localhost:8443"] }));
  assert.equal(commandRefusal("curl https://example.com/", { ...context, hosts: ["mac.tail1234.ts.net"] }), null);
  assert.ok(commandRefusal("", context));
  assert.ok(commandRefusal("ls ‮", context));
});

test("typed text is a command in a terminal, and never a protected page address", () => {
  assert.equal(typedTextRefusal("sudo rm -rf /", { terminalLike: true }), "That needs your password. The agent never gets it.");
  assert.equal(typedTextRefusal("sudo rm -rf /", { terminalLike: false }), null, "prose in a document may mention sudo");
  assert.equal(typedTextRefusal("ls -la\ncat notes.txt", { terminalLike: true }), null);
  assert.equal(typedTextRefusal("echo one\nhistory", { terminalLike: true }), "Shell history can hold your secrets.");
  for (const address of ["chrome://password-manager/passwords", "chrome://settings/passwords", "chrome://settings/payments", "brave://password-manager", "edge://wallet/passwords", "about:logins", "javascript:alert(1)", "JavaScript:void(0)", "data:text/html,<script>", "devtools://devtools/bundled/inspector.html", "https://mac.tail1234.ts.net/"])
    assert.ok(typedTextRefusal(address, { hosts: ["mac.tail1234.ts.net", "localhost:8443"] }), `refuse address ${address}`);
  for (const text of ["https://www.amazon.com/", "chrome://newtab", "chrome://settings/appearance", "about:blank", "Hello, how are you?", "search for weather", "password reset instructions"])
    assert.equal(typedTextRefusal(text, { hosts: ["mac.tail1234.ts.net"] }), null, `allow ${text}`);
  assert.equal(protectedPage(""), false);
  assert.equal(protectedPage("https://example.com/?next=chrome://settings/passwords"), false);
  assert.ok(protectedTitle("DevTools - amazon.com"));
  assert.ok(protectedTitle("Force Quit Applications"));
  assert.equal(protectedTitle("Amazon.com: Online Shopping"), false);
});

test("protected apps and terminal-like apps are recognised by id, name or path", () => {
  for (const app of [
    { bundleId: "com.1password.1password", name: "1Password" }, { bundleId: "com.apple.keychainaccess", name: "Keychain Access" },
    { bundleId: "com.apple.Passwords", name: "Passwords" }, { id: "/System/Applications/Passwords.app" },
    { bundleId: "com.apple.ScreenContinuity", name: "iPhone Mirroring" }, { bundleId: "com.apple.ActivityMonitor", name: "Activity Monitor" },
    { bundleId: "io.tailscale.ipn.macos", name: "Tailscale" }, { bundleId: "com.reach.app", name: "Reach" }, { id: "/Applications/Reach.app" },
    { bundleId: "com.bitwarden.desktop" }, { name: "Proton Pass" }, { bundleId: "com.apple.SecurityAgent" },
  ]) assert.ok(protectedAppReason(app), JSON.stringify(app));
  for (const app of [
    { bundleId: "com.google.Chrome", name: "Google Chrome" }, { bundleId: "com.apple.Safari", name: "Safari" }, { bundleId: "com.apple.Terminal", name: "Terminal" },
    { bundleId: "com.apple.finder", name: "Finder" }, { bundleId: "com.apple.systempreferences", name: "System Settings" }, { bundleId: "com.apple.mail", name: "Mail" },
    { bundleId: "com.microsoft.VSCode", name: "Visual Studio Code" }, { id: "/Applications/Preacher.app", name: "Preacher" },
  ]) assert.equal(protectedAppReason(app), null, JSON.stringify(app));
  assert.ok(terminalLikeApp({ bundleId: "com.apple.Terminal" }));
  assert.ok(terminalLikeApp({ bundleId: "com.googlecode.iterm2" }));
  assert.ok(terminalLikeApp({ name: "Visual Studio Code" }));
  assert.ok(terminalLikeApp({ bundleId: "dev.warp.Warp-Stable" }));
  assert.equal(terminalLikeApp({ bundleId: "com.google.Chrome", name: "Google Chrome" }), false);
  assert.equal(terminalLikeApp({ bundleId: "com.apple.Notes" }), false);
});

test("native rules carry the whole protected list and the preset's app set", () => {
  const rules = nativeRules({ preset: "apps", apps: [{ id: "/Applications/Google Chrome.app", bundleId: "com.google.Chrome" }] }, { hosts: ["Mac.tail1.ts.net"], titles: ["Reach"], protectedPaths: ["/Users/me/.reach"], home: "/Users/me" });
  assert.equal(rules.mode, "apps");
  assert.deepEqual(rules.hosts, ["mac.tail1.ts.net"]);
  assert.deepEqual(rules.titles, ["reach"]);
  assert.deepEqual(rules.allowedApps, [{ id: "/Applications/Google Chrome.app", bundleId: "com.google.Chrome", identity: "" }]);
  assert.ok(rules.protectedAppIds.includes("com.apple.keychainaccess"));
  assert.ok(rules.privatePanes.includes("privacy"));
  assert.ok(rules.terminalLike.includes("terminal"));
  assert.ok(rules.protectedPagePatterns.every((pattern) => typeof pattern === "string"));
  assert.equal(nativeRules({ preset: "full" }).mode, "full");
  assert.equal(nativeRules({ preset: "readonly" }).mode, "view");
  assert.deepEqual(nativeRules({ preset: "full", hidden: [{ id: "/System/Applications/Messages.app", name: "Messages" }] }).hiddenApps, [{ id: "/System/Applications/Messages.app", bundleId: "", name: "Messages" }]);
});
