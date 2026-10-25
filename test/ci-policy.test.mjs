import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { requiredFailures } from "../.github/scripts/required-check.mjs";
import { testFiles, suites } from "../.github/scripts/run-tests.mjs";

const workflow = name => parse(fs.readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8"));
const nodeBlock = (run, marker = "CHECK") => {
  const block = run.match(new RegExp(`<<'${marker}'\\n([\\s\\S]*?)\\n${marker}(?:\\n|$)`));
  assert.ok(block, `missing ${marker} script`);
  return block[1];
};
const runBlock = (source, env = {}, cwd) => spawnSync(process.execPath, ["--input-type=module", "-e", source], {
  env: { ...process.env, ...env }, cwd, encoding: "utf8", timeout: 10000,
});

test("required CI gates fail closed for missing, skipped, cancelled and failed prerequisites", () => {
  const required = ["privacy", "verify", "security"];
  const success = Object.fromEntries(required.map(name => [name, { result: "success" }]));
  assert.deepEqual(requiredFailures(success, required), []);
  for (const result of ["failure", "cancelled", "skipped", "timed_out", undefined]) {
    for (const name of required) {
      assert.deepEqual(requiredFailures({ ...success, [name]: { result } }, required), [name]);
    }
  }
  assert.deepEqual(requiredFailures({}, required), required);
  for (const value of [undefined, null, false, 0, "success", []]) assert.throws(() => requiredFailures(value, required), /malformed/);
  assert.throws(() => requiredFailures(success, []), /prerequisites/);
});

test("required gate invocation rejects absent or malformed input instead of succeeding silently", () => {
  const command = fileURLToPath(new URL("../.github/scripts/required-check.mjs", import.meta.url));
  for (const value of [undefined, "", "not JSON", "null", "[]", "{}", '{"verify":{"result":"skipped"}}']) {
    const env = { ...process.env };
    delete env.REACH_CI_NEEDS;
    if (value !== undefined) env.REACH_CI_NEEDS = value;
    const result = spawnSync(process.execPath, [command, "verify"], { env, encoding: "utf8" });
    assert.notEqual(result.status, 0, `must fail for ${value}`);
  }
  const success = spawnSync(process.execPath, [command, "verify"], { env: { ...process.env, REACH_CI_NEEDS: '{"verify":{"result":"success"}}' }, encoding: "utf8" });
  assert.equal(success.status, 0, success.stderr);
});

test("main requires CodeQL findings to pass separately from successful scan execution", () => {
  const ruleset = JSON.parse(fs.readFileSync(new URL("../.github/rulesets/main.json", import.meta.url), "utf8"));
  assert.equal(ruleset.target, "branch");
  assert.equal(ruleset.enforcement, "active");
  assert.deepEqual(ruleset.bypass_actors, []);
  assert.ok(ruleset.conditions.ref_name.include.includes("refs/heads/main"));
  assert.deepEqual(ruleset.conditions.ref_name.exclude, []);
  const review = ruleset.rules.find(rule => rule.type === "pull_request")?.parameters;
  assert.ok(review, "solo maintenance still requires every change to use a pull request");
  assert.equal(review.required_approving_review_count, 0);
  assert.equal(review.require_code_owner_review, false);
  assert.equal(review.require_last_push_approval, false);
  assert.equal(review.required_review_thread_resolution, true);
  for (const type of ["deletion", "non_fast_forward"]) assert.ok(ruleset.rules.some(rule => rule.type === type));
  const scanning = ruleset.rules.filter(rule => rule.type === "code_scanning");
  assert.equal(scanning.length, 1, "green CodeQL analysis jobs alone do not reject detected vulnerabilities");
  const tools = scanning[0].parameters.code_scanning_tools;
  const codeql = tools.filter(tool => tool.tool === "CodeQL");
  assert.equal(codeql.length, 1, "the same CodeQL tool used by both language scans must be required");
  assert.ok(["medium_or_higher", "all"].includes(codeql[0].security_alerts_threshold), "medium, high and critical security findings must block merges");
  assert.ok(["errors", "errors_and_warnings", "all"].includes(codeql[0].alerts_threshold), "error-level findings must block merges");
  const status = ruleset.rules.find(rule => rule.type === "required_status_checks").parameters;
  assert.equal(status.strict_required_status_checks_policy, true);
  assert.equal(status.do_not_enforce_on_create, false);
  assert.deepEqual(status.required_status_checks, [
    { context: "CI required", integration_id: 15368 },
    { context: "Security required", integration_id: 15368 },
  ], "alert merge protection supplements the required execution checks");
});

test("CI test selection never silently loses a renamed required platform test", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-ci-selection-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "test"));
  assert.throws(() => testFiles("all", root), /empty/);
  assert.throws(() => testFiles("windows", root), /ENOENT|Missing required test/);
  assert.throws(() => testFiles("unsupported", root), /Unknown/);
  fs.writeFileSync(path.join(root, "test", "b.test.mjs"), "");
  fs.writeFileSync(path.join(root, "test", "a.test.mjs"), "");
  fs.writeFileSync(path.join(root, "test", "helper.mjs"), "");
  assert.deepEqual(testFiles("all", root), [path.join("test", "a.test.mjs"), path.join("test", "b.test.mjs")]);
  for (const suite of Object.keys(suites)) assert.equal(testFiles(suite).length, suites[suite].length);
});

test("every test runs on Windows unless a lane owns it or it is a listed pending Windows fix", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-ci-windows-rest-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "test"));
  for (const name of [...suites.windows, ...suites.native, ...suites.windowsPending, "brand-new"]) {
    const file = path.join(root, "test", `${name}.test.mjs`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "");
  }
  // A file nobody listed runs on Windows by default.
  assert.deepEqual(testFiles("windows-rest", root), [path.join("test", "brand-new.test.mjs")]);
  // A pending Windows fix is not also claimed by the Windows lane.
  assert.deepEqual(suites.windowsPending.filter(name => suites.windows.includes(name)), []);
  const real = testFiles("windows-rest");
  for (const name of [...suites.windows, ...suites.native, ...suites.windowsPending])
    assert.equal(real.includes(path.join("test", `${name}.test.mjs`)), false, `${name} has its own lane`);
});

test("Windows CI retains the atomic JSON sharing regression beside installed pairing", () => {
  assert.ok(suites.windows.includes("windows-atomic-json"), "transient and permanent state-write refusals need Windows execution");
  assert.ok(suites.windows.includes("qr-onboarding-e2e"), "the installed pairing flow remains required");
  assert.ok(testFiles("windows").includes(path.join("test","windows-atomic-json.test.mjs")));
  assert.ok(testFiles("windows").includes(path.join("test", "private-artifact.test.mjs")), "fresh artifact copy controls must execute on Windows too");
});

test("the CI runner passes a long file vector to guarded Node and aggregates failures and skips", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-ci-runner-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "test"));
  const runner = new URL("../.github/scripts/run-tests.mjs", import.meta.url).href;
  const guard = new URL("./helpers/runaway-guard.mjs", import.meta.url).href;
  const name = `guarded-${"x".repeat(120)}`;
  const names = [...Array(80).fill(name), "tail"];
  assert.ok(names.map(name => path.join("test", `${name}.test.mjs`)).join(" ").length > 8191,
    "the real child argument vector must exceed cmd.exe's script limit");
  fs.writeFileSync(path.join(root, "runner.mjs"), `
    import { run, suites } from ${JSON.stringify(runner)};
    suites.windows = ${JSON.stringify(names)};
    await run("windows");
  `);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ private: true, scripts: {
    "test:file": "node -e \"throw Error('unexpected nested npm script shell')\"",
    "test:ci": "node runner.mjs",
  } }));
  fs.writeFileSync(path.join(root, "test", `${name}.test.mjs`), `
    import test from 'node:test';
    import assert from 'node:assert/strict';
    test('guard is active in the real child', () => {
      assert.equal(assert.equal.pageSafe, true);
      assert.equal(process.execArgv[process.execArgv.indexOf('--import') + 1], ${JSON.stringify(guard)});
    });
  `);
  const file = path.join(root, "test", "tail.test.mjs");
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // The nested runner needs its own reporters.
  if (process.platform === "darwin") {
    // Full CI already supplies this build. A focused test:file invocation may
    // be cold: prepare the real helper before timing the launcher, and share
    // it across both children. Only a cache inside this fixture is removed.
    const inherited = env.REACH_TEST_NATIVE_DIR;
    const shared = inherited && fs.statSync(inherited, { throwIfNoEntry: false })?.isDirectory();
    const nativeDir = shared ? inherited : fs.mkdtempSync(path.join(root, "native-builds-"));
    const before = process.env.REACH_TEST_NATIVE_DIR;
    const started = performance.now();
    try {
      process.env.REACH_TEST_NATIVE_DIR = nativeDir;
      const { desktopBinary } = await import("../server/desktop-native.mjs");
      await desktopBinary({ dataDir: nativeDir }, "browser-files");
    } finally {
      if (before === undefined) delete process.env.REACH_TEST_NATIVE_DIR;
      else process.env.REACH_TEST_NATIVE_DIR = before;
    }
    env.REACH_TEST_NATIVE_DIR = nativeDir;
    t.diagnostic(`Launcher native cache prepared before timed spawn: ${JSON.stringify({ shared: Boolean(shared), elapsedMs: Math.round(performance.now() - started) })}`);
  }
  const run = () => {
    const started = performance.now();
    const result = spawnSync(process.execPath, [process.env.npm_execpath, "run", "test:ci"], { cwd: root, env, encoding: "utf8", timeout: 20000 });
    return { ...result, elapsedMs: Math.round(performance.now() - started) };
  };
  const diagnosis = result => JSON.stringify({ status: result.status, signal: result.signal, elapsedMs: result.elapsedMs,
    error: result.error ? { code: result.error.code ?? null, message: result.error.message.slice(0, 1024) } : null,
    stdout: (result.stdout || "").slice(-4096), stderr: (result.stderr || "").slice(-4096) });
  const report = name => fs.readFileSync(path.join(root, "reports", `windows.${name}`), "utf8");
  fs.writeFileSync(file, "import test from 'node:test'; test('tail fixture', () => {}); test.skip('expected fixture skip', () => {});\n");
  let result = run();
  assert.equal(result.status, 0, diagnosis(result));
  assert.match(report("xml"), /testcase/);
  assert.match(report("tap"), /ok \d+ - tail fixture/);
  assert.match(report("tap"), /# tests 3\n/);
  assert.match(report("tap"), /# pass 2\n# fail 0\n# cancelled 0\n# skipped 1\n/);
  fs.writeFileSync(file, "import test from 'node:test'; test('tail fixture', () => { throw Error('expected fixture failure'); }); test.skip('expected fixture skip', () => {});\n");
  result = run();
  assert.equal(result.status, 1, diagnosis(result));
  assert.match(report("xml"), /expected fixture failure/);
  assert.match(report("tap"), /not ok \d+ - tail fixture/);
  assert.match(report("tap"), /# tests 3\n/);
  assert.match(report("tap"), /# pass 1\n# fail 1\n# cancelled 0\n# skipped 1\n/);
});

test("release handoff copies only the exact npm and portable bytes that passed installation smoke", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-ci-artifact-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "release", "reach"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@nalebc/reach", version: "0.1.0" }));
  fs.writeFileSync(path.join(root, "release", "reach", "reach"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const filename = "nalebc-reach-0.1.0.tgz", content = "synthetic verified artifact";
  const portable = "reach-0.1.0-portable.tar.gz", portableContent = "synthetic verified portable archive";
  const artifact = path.join(root, "release", filename);
  const portableArtifact = path.join(root, "release", portable);
  fs.writeFileSync(artifact, content);
  fs.writeFileSync(portableArtifact, portableContent);
  const hash = value => crypto.createHash("sha256").update(value).digest("hex");
  const receipt = { filename, package: "@nalebc/reach", version: "0.1.0", commit: "a".repeat(40), sha256: hash(content), portable: { filename: portable, sha256: hash(portableContent) } };
  const receiptFile = path.join(root, "release", "package-verification.json");
  fs.writeFileSync(receiptFile, JSON.stringify(receipt));
  const command = fileURLToPath(new URL("../.github/scripts/package-candidate.mjs", import.meta.url));
  const run = commit => spawnSync(process.execPath, [command], { cwd: root, env: { ...process.env, GITHUB_SHA: commit }, encoding: "utf8", timeout: 10000 });
  let result = run(receipt.commit);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(root, "release", "candidate", filename), "utf8"), content);
  assert.equal(fs.readFileSync(path.join(root, "release", "candidate", portable), "utf8"), portableContent);
  assert.match(fs.readFileSync(path.join(root, "release", "candidate", "SHA256SUMS"), "utf8"), new RegExp(`^${receipt.sha256}  ${filename}`));
  assert.match(fs.readFileSync(path.join(root, "release", "candidate", "SHA256SUMS"), "utf8"), new RegExp(`${receipt.portable.sha256}  ${portable}`));
  fs.rmSync(path.join(root, "release", "reach"), { recursive: true });
  result = run(receipt.commit);
  assert.equal(result.status, 0, "handoff must copy the verified archive without rebuilding from mutable staging files");
  assert.equal(fs.readFileSync(path.join(root, "release", "candidate", portable), "utf8"), portableContent);
  assert.notEqual(run("b".repeat(40)).status, 0, "another commit cannot reuse the receipt");
  fs.writeFileSync(artifact, "bytes changed after passing smoke");
  assert.notEqual(run(receipt.commit).status, 0, "changed archive cannot be published as tested");
  fs.writeFileSync(artifact, content);
  fs.writeFileSync(portableArtifact, "portable bytes changed after smoke");
  assert.notEqual(run(receipt.commit).status, 0, "changed portable archive cannot be published as tested");
  fs.writeFileSync(portableArtifact, portableContent);
  fs.writeFileSync(receiptFile, JSON.stringify({ ...receipt, portable: undefined }));
  assert.notEqual(run(receipt.commit).status, 0, "an npm-only receipt cannot certify a portable archive");
  fs.writeFileSync(receiptFile, JSON.stringify(receipt));
  if (process.platform !== "win32") {
    fs.renameSync(portableArtifact, `${portableArtifact}.original`);
    fs.symlinkSync(`${portableArtifact}.original`, portableArtifact);
    assert.notEqual(run(receipt.commit).status, 0, "a symlink cannot replace a verified archive");
    fs.rmSync(portableArtifact);
    fs.renameSync(`${portableArtifact}.original`, portableArtifact);
  }
  fs.rmSync(receiptFile);
  assert.notEqual(run(receipt.commit).status, 0, "missing receipt cannot be treated as success");
});

test("CI orchestration uses npm and publishing cannot run package scripts", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["test:ci"], "node .github/scripts/run-tests.mjs all");
  assert.equal(pkg.scripts["test:ci:windows"], "node .github/scripts/run-tests.mjs windows");
  assert.equal(pkg.scripts["test:ci:native"], "node .github/scripts/run-tests.mjs native");
  const ci = fs.readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(ci, /merge_group:/);
  assert.doesNotMatch(ci, /continue-on-error:|secrets\.|pull_request_target:/);
  const publish = workflow("release").jobs.publish;
  assert.equal(publish.environment, "npm-release");
  const commands = publish.steps.map(step => step.run || "").join("\n");
  assert.match(commands, /npm publish .* --ignore-scripts --provenance/);
  assert.ok(!publish.steps.some(step => step.uses?.startsWith("actions/checkout@")));
  assert.doesNotMatch(commands, /(?:^|\n)\s*npm (?:ci|install|run)\b/);
  assert.doesNotMatch(JSON.stringify(publish), /secrets\.NPM_TOKEN/);
  // The one-time first-publish token: only in the publish step, only while
  // the package doesn't exist, and refused once it does.
  const uses = publish.steps.filter(step => JSON.stringify(step).includes("secrets.NPM_FIRST_PUBLISH_TOKEN"));
  assert.equal(uses.length, 1);
  assert.match(uses[0].run, /npm publish .* --ignore-scripts --provenance/);
  assert.match(uses[0].run, /if \[ "\$PACKAGE_EXISTS" = "true" \]; then\n\s+if \[ -n "\$FIRST_PUBLISH_TOKEN" \]; then[\s\S]*?exit 1/);
  assert.equal(uses[0].env.PACKAGE_EXISTS, "${{ steps.registry.outputs.exists }}");
  assert.doesNotMatch(uses[0].run, /echo[^\n]*\$(?:FIRST_PUBLISH_TOKEN|NODE_AUTH_TOKEN)/, "never printed");
  assert.doesNotMatch(uses[0].run, /_authToken=\$\{?FIRST_PUBLISH_TOKEN|_authToken="?\$FIRST/, "never written out");
});


test("every Batch 1 platform-gated regression has a CI lane that enables its gate", () => {
  for (const name of ["agent-input", "browser-terminal-routes", "money-sites", "screen-sound-chrome-e2e"])
    assert.ok(suites.native.includes(name), `${name} needs the native lane`);
  for (const name of ["agent-install", "browser-mutations", "private-ingress-platform"])
    assert.ok(suites.windows.includes(name), `${name} needs the Windows lane`);
  const runner = fs.readFileSync(new URL('../.github/scripts/run-tests.mjs', import.meta.url), 'utf8');
  for (const flag of ['REACH_TEST_APP_NATIVE', 'REACH_TEST_SCRIPT_SANDBOX', 'REACH_TEST_SOUND_CHROME'])
    assert.ok(runner.includes(`${flag}: "1"`), `${flag} must be enabled`);
});


test("Windows CI runs the real screen helpers under a normal PC's script policy", () => {
  // Oct 11: GitHub's runners allow every script, so a helper refused on a
  // normal PC passed CI. The lane sets Restricted, then runs them for real.
  const ci = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(ci, /Set-ExecutionPolicy Restricted -Scope LocalMachine -Force/);
  assert.match(ci, /test\/windows-desktop-native\.test\.mjs/);
  assert.match(ci, /test\/windows-desktop-e2e\.test\.mjs/);
  assert.match(ci, /REACH_TEST_WINDOWS_DESKTOP: "1"/);
  for (const name of ["windows-screen-helpers", "phone-link"])
    assert.ok(suites.windows.includes(name), `${name} needs the Windows lane`);
  // Windows helpers are compiled with the PC's own csc.exe: built and run for real there.
  assert.match(ci, /test\/windows-native-build\.test\.mjs/);
  // The fresh hook verifier is gated on the native lane's environment.
  // Selection in the shared Windows suite alone would silently skip it.
  for (const name of ["windows-owner-rights", "windows-state-normalization", "windows-claude-hooks"])
    assert.ok(ci.includes(`test/${name}.test.mjs`), `${name} must execute in the Restricted native lane`);
  for (const name of ["app-identity", "agent-desktop-windows", "agent-guard-windows", "windows-native-build"])
    assert.ok(suites.windows.includes(name), `${name} needs the Windows lane`);
  for (const name of ["agent-tabs", "browser-worker", "browser-extension-bridge"])
    assert.ok(suites.windows.includes(name), `${name} must retain tab ownership, queued dispatch and cleanup retirement regressions on Windows`);
  for (const name of ["agent-tools", "tool-page-runtime", "mac-terminal-watch"])
    assert.ok(suites.windows.includes(name), `${name} must retain explicit browser platform and watcher shutdown regressions on Windows`);
  for (const name of ["app-icons", "windows-app-icons", "file-icons"])
    assert.ok(suites.windows.includes(name), `${name} must retain icon/catalog helper shutdown and native close regressions on Windows`);
  // Workstream C: the sandbox unit tests in the lane, and the escape e2e in the
  // real-Windows step as a standard user (docs/parity/C-sandbox.md §9.3).
  for (const name of ["windows-sandbox", "windows-path-validation", "windows-sandbox-e2e", "windows-file-boundary-e2e"])
    assert.ok(suites.windows.includes(name), `${name} needs the Windows lane`);
  assert.match(ci, /test\/windows-sandbox-e2e\.test\.mjs/);
  assert.match(ci, /test\/windows-file-boundary-e2e\.test\.mjs/);
});

test("Windows CI runs both terminal journey files in the serial native lane", () => {
  const native = workflow("ci").jobs.verify.steps.find(step => step.run?.includes("test/journeys/terminals.test.mjs"));
  assert.ok(native, "the actual native lane must retain the original terminal journeys");
  for (const name of ["journeys/terminals", "journeys/terminal-paste-target"]) {
    assert.ok(suites.windows.includes(name), `${name} must remain in the Windows selection`);
    assert.ok(native.run.includes(`test/${name}.test.mjs`), `${name} must execute in the native lane`);
  }
  assert.equal(native.env.REACH_TEST_WINDOWS_DESKTOP, "1");
  assert.match(native.run, /(?:^|\s)--test-concurrency=1(?:\s|$)/, "native files stay serial");
});

test("Windows CI covers shared phone navigation, agent workspace privacy, updates, gesture accuracy, accelerated scrolling and native input sequences", () => {
  for (const name of ["back-stack-ui", "agent-tool-workspace-ui", "agent-too-old-ui", "touch-scroll", "screen-scroll-momentum-ui", "screen-scroll-ui", "screen-touch-accuracy-ui",
    "screen-pointer", "desktop-performance", "desktop-control-safety", "desktop-input-lifecycle", "windows-desktop-input-native",
    "screen-owner-first-ui", "screen-presentation", "screen-bar-placement", "screen-bar-ui",
    "screen-typing-integration", "screen-tap-to-type-ui", "field-probe-ui", "field-map", "remote-typing", "remote-keyboard",
    "tap-clicks", "screen-double-click-ui", "desktop-control-reconnect", "screen-typing-reconnect-chrome",
    "screen-control-diagnostics", "private-recovery-chrome"])
    assert.ok(suites.windows.includes(name), `${name} needs the Windows lane`);
});

test("installed CI covers a real portable first launch and npm 12 on Linux", () => {
  assert.ok(suites.windows.includes("notice-versions"), "Windows must validate notices using native checkout line endings");
  const installed = fs.readFileSync(new URL('../.github/scripts/test-installed-package.mjs', import.meta.url), 'utf8');
  assert.match(installed, /test\/portable-install\.test\.mjs/);
  assert.match(installed, /REACH_TEST_PORTABLE_ARCHIVE/);
  const ci = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(ci, /npm install --global npm@12\./);
  assert.match(ci, /test\/npm12-install\.test\.mjs/);
  assert.match(ci, /REACH_TEST_NPM12_INSTALL: "1"/);
});

test("default Windows QR onboarding is required in source CI and the installed-artifact gate", () => {
  assert.ok(suites.windows.includes("qr-onboarding-e2e"));
  assert.ok(suites.windows.includes("windows-sign-in-launch"));
  const ci = workflow("ci");
  assert.ok(ci.jobs.verify.strategy.matrix.include.some(entry => entry.os.startsWith("windows-")));
  const installed = ci.jobs.verify.steps.find(step => step.run === "npm run test:ci:installed");
  assert.ok(installed, "the built package must be installed and exercised");
  assert.equal(installed.if, "${{ !cancelled() && steps.package_build.outcome == 'success' }}",
    "every platform must run the installed QR gate once its package exists, including after another test phase failed");
  assert.equal(ci.jobs.verify.steps.find(step => step.id === "package_build")?.run, "npm run package",
    "the prerequisite must be the actual package build");
  assert.equal(ci.jobs.verify.steps.find(step => step.run?.includes("package-candidate.mjs"))?.if, "${{ success() }}",
    "failed phases must still prevent release candidate handoff");
  const runner = fs.readFileSync(new URL("../.github/scripts/test-installed-package.mjs", import.meta.url), "utf8");
  assert.match(runner, /test\/qr-onboarding-e2e\.test\.mjs/);
  assert.match(runner, /REACH_TEST_PACKAGE: path\.join\(temp, "node_modules", "@nalebc", "reach"\)/);
  assert.doesNotMatch(runner, /process\.platform === "win32"\) throw/);
  const regression = fs.readFileSync(new URL("./qr-onboarding-e2e.test.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(regression, /\bskip\s*:/, "the critical path cannot silently skip on Windows");
  assert.doesNotMatch(regression, /browserCheck\s*:/, "production public DNS and TLS readiness must run");
  const startup = fs.readFileSync(new URL("./windows-sign-in-launch.test.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(startup, /\bskip\s*:/, "Windows startup and route recovery must run on Windows itself");
});

test("required workflows cover every job and evaluate the same declared prerequisites", () => {
  const ci = workflow("ci"), security = workflow("security");
  for (const { jobs } of [ci, security]) {
    assert.equal(jobs.required.if, "always()");
    assert.deepEqual([...jobs.required.needs].sort(), Object.keys(jobs).filter(name => name !== "required").sort());
  }
  const invocation = ci.jobs.required.steps.find(step => step.run?.includes("required-check.mjs"));
  assert.deepEqual(invocation.run.trim().split(/\s+/).slice(2).sort(), [...ci.jobs.required.needs].sort());
  assert.equal(invocation.env.REACH_CI_NEEDS, "${{ toJSON(needs) }}");
  const gate = security.jobs.required.steps.find(step => step.run);
  assert.equal(gate.env.RESULTS, "${{ toJSON(needs) }}");
  const script = nodeBlock(gate.run);
  for (const publicRepo of [true, false]) for (const event of ["pull_request", "push", "merge_group"]) {
    const results = Object.fromEntries(security.jobs.required.needs.map(name => [name, { result: "success" }]));
    results.visibility.outputs = { public: String(publicRepo) };
    if (!publicRepo) results.codeql.result = "skipped";
    if (!publicRepo || event !== "pull_request") results["dependency-review"].result = "skipped";
    const run = value => runBlock(script, { RESULTS: JSON.stringify(value), EVENT_NAME: event });
    assert.equal(run(results).status, 0);
    for (const visibility of [undefined, null, "", "private", false, true]) {
      const broken = structuredClone(results);
      broken.visibility.outputs = visibility === undefined ? undefined : { public: visibility };
      assert.notEqual(run(broken).status, 0, `malformed visibility must fail: ${visibility}`);
    }
    for (const name of security.jobs.required.needs) for (const state of ["failure", "cancelled", "missing", "skipped"]) {
      if (state === results[name].result) continue;
      const broken = structuredClone(results);
      if (state === "missing") delete broken[name]; else broken[name].result = state;
      assert.notEqual(run(broken).status, 0, `${name}: ${state}, public=${publicRepo}, event=${event}`);
    }
  }
});

test("Scorecard publication cannot block tags or grant OIDC to reusable release checks", () => {
  const scorecard = workflow("scorecard"), security = workflow("security"), release = workflow("release");
  assert.deepEqual(Object.keys(scorecard.on).sort(), ["push", "schedule", "workflow_dispatch"]);
  assert.deepEqual(scorecard.on.push.branches, ["main"]);
  assert.equal(scorecard.jobs.scorecard.if, "needs.visibility.outputs.public == 'true' && github.ref == format('refs/heads/{0}', github.event.repository.default_branch)");
  assert.equal(scorecard.jobs.scorecard.permissions["id-token"], "write");
  assert.equal(scorecard.jobs.scorecard.steps.find(step => step.uses?.startsWith("ossf/scorecard-action@")).with.publish_results, true);
  for (const job of Object.values(security.jobs)) assert.notEqual(job.permissions?.["id-token"], "write");
  assert.equal(release.jobs.security.permissions["id-token"], undefined);
  assert.deepEqual(release.jobs.eligible.permissions, { contents: "read", actions: "read" });
});

test("release eligibility rejects administrator bypass and absent environment protections", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-release-policy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = nodeBlock(workflow("release").jobs.eligible.steps.find(step => step.env?.GH_TOKEN).run);
  const good = { can_admins_bypass: false, protection_rules: [{ type: "required_reviewers", reviewers: [{ id: 1 }], prevent_self_review: false }], deployment_branch_policy: { custom_branch_policies: true } };
  fs.writeFileSync(path.join(root, "release-branches.json"), JSON.stringify({ branch_policies: [{ type: "tag", name: "v*" }] }));
  const run = environment => {
    fs.writeFileSync(path.join(root, "release-environment.json"), JSON.stringify(environment));
    return runBlock(script, { RUNNER_TEMP: root });
  };
  assert.equal(run(good).status, 0);
  assert.equal(run({ ...good, protection_rules: [{ ...good.protection_rules[0], prevent_self_review: true }] }).status, 0, "a later team can require independent approval without changing release code");
  for (const value of [true, undefined, null]) assert.notEqual(run({ ...good, can_admins_bypass: value }).status, 0);
  assert.notEqual(run({ ...good, protection_rules: [] }).status, 0);
  assert.notEqual(run({ ...good, protection_rules: [{ type: "required_reviewers", reviewers: [], prevent_self_review: false }] }).status, 0, "allowing self-review must not remove explicit release approval");
  assert.notEqual(run({ ...good, protection_rules: [{ type: "wait_timer", wait_timer: 1 }] }).status, 0, "a timer cannot substitute for a required reviewer");
  assert.notEqual(run({ ...good, deployment_branch_policy: {} }).status, 0);
});

test("trusted publishing rejects npm older than 11.5.1 and malformed versions", () => {
  const step = workflow("release").jobs.publish.steps.find(step => step.run?.includes("NPMCHECK"));
  const script = nodeBlock(step.run, "NPMCHECK");
  for (const version of ["11.5.1", "11.5.10", "11.19.0", "12.0.0"]) assert.equal(runBlock(script, { NPM_VERSION: version }).status, 0);
  for (const version of ["10.99.9", "11.4.9", "11.5.0", "", "12", "12.0.0-beta.1", "garbage"]) assert.notEqual(runBlock(script, { NPM_VERSION: version }).status, 0);
});

test("release retry skips npm only for the exact already-published candidate bytes", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-release-retry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "candidate"));
  const bytes = "verified synthetic archive", version = "0.1.0";
  fs.writeFileSync(path.join(root, "candidate", `nalebc-reach-${version}.tgz`), bytes);
  const steps = workflow("release").jobs.publish.steps;
  const script = nodeBlock(steps.find(step => step.id === "registry").run, "REGISTRY");
  const output = path.join(root, "output");
  const good = { name: "@nalebc/reach", version, dist: { integrity: `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}` } };
  const run = (status, body = good) => {
    fs.writeFileSync(output, "");
    // The registry's answer goes in as data (environment), never as code.
    // The package itself: absent before the first publish, there after.
    const mock = "globalThis.fetch = async (url, options) => { if (!options.signal) throw Error('unbounded lookup'); if (url === 'https://registry.npmjs.org/@nalebc%2freach') { const status = Number(process.env.MOCK_PACKAGE); return {status, ok: status === 200}; } if (url !== 'https://registry.npmjs.org/@nalebc%2freach/0.1.0') throw Error('unexpected lookup'); const status = Number(process.env.MOCK_STATUS); return {status, ok: status === 200, json: async () => JSON.parse(process.env.MOCK_BODY)}; };\n";
    return runBlock(mock + script, { VERSION: version, GITHUB_OUTPUT: output, MOCK_STATUS: String(status), MOCK_PACKAGE: String(pkg), MOCK_BODY: JSON.stringify(body) }, root);
  };
  let pkg = 404;
  assert.equal(run(404).status, 0);
  assert.equal(fs.readFileSync(output, "utf8"), "exists=false\npublished=false\n", "a first publish");
  pkg = 200;
  assert.equal(run(404).status, 0);
  assert.equal(fs.readFileSync(output, "utf8"), "exists=true\npublished=false\n", "a new version");
  assert.equal(run(200).status, 0);
  assert.equal(fs.readFileSync(output, "utf8"), "exists=true\npublished=true\n");
  pkg = 500;
  assert.notEqual(run(404).status, 0, "an unknown package state never counts as absent");
  pkg = 200;
  for (const status of [401, 403, 429, 500]) assert.notEqual(run(status).status, 0);
  for (const body of [{ ...good, version: "0.2.0" }, { ...good, name: "other" }, { ...good, dist: {} }, { ...good, dist: { integrity: "different bytes" } }]) assert.notEqual(run(200, body).status, 0);
  assert.notEqual(runBlock("globalThis.fetch = async () => { throw Error('network down'); };\n" + script, { VERSION: version, GITHUB_OUTPUT: output }, root).status, 0);
  const publish = steps.find(step => step.run?.includes("npm publish"));
  assert.equal(publish.if, "steps.registry.outputs.published == 'false'");
  assert.ok(steps.indexOf(publish) < steps.findIndex(step => step.id === "github-release"));
});

function assertPublishIsolation(publish) {
  assert.equal(publish.environment, "npm-release");
  for (const step of publish.steps) {
    assert.ok(!step.uses?.startsWith("actions/checkout@"));
    if (!step.run) continue;
    assert.doesNotMatch(step.run, /\b(?:npm|npx)\s+(?:ci|i|install|install-test|exec|run|run-script|rebuild)\b/);
    assert.doesNotMatch(step.run, /\b(?:node|bash|sh|source)\s+["']?candidate\//);
    if (/\bnpm\s+publish\b/.test(step.run)) {
      assert.match(step.run, /npm publish .* --ignore-scripts --provenance/);
      // Without "./" npm reads candidate/x.tgz as a GitHub user/repo (v0.1.0).
      for (const [, target] of step.run.matchAll(/\bnpm\s+publish\s+("[^"]*"|\S+)/g))
        assert.match(target, /^"?\.\/candidate\//, "npm publish takes the verified tarball by a ./ path");
      assert.equal(({ ...publish.env, ...step.env }).NPM_CONFIG_IGNORE_SCRIPTS, "true");
    }
  }
  const downloads = publish.steps.filter(step => step.uses?.startsWith("actions/download-artifact@"));
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].with["artifact-ids"], "${{ needs.prepare.outputs.artifact-id }}");
  for (const key of ["name", "pattern", "run-id", "github-token", "repository"]) assert.equal(downloads[0].with[key], undefined);
}

test("publishing isolation covers multiline commands, script settings and same-run artifact identity", () => {
  const publish = workflow("release").jobs.publish;
  assertPublishIsolation(publish);
  for (const command of ["npm ci", "npm install", "npm run prepublish", "npx exec payload"]) {
    const changed = structuredClone(publish);
    changed.steps.push({ run: `echo setup\n${command}\n` });
    assert.throws(() => assertPublishIsolation(changed));
  }
  const bareTarball = structuredClone(publish);
  const publishStep = bareTarball.steps.find(step => step.run?.includes("npm publish"));
  publishStep.run = publishStep.run.replace('npm publish "./candidate/', 'npm publish "candidate/');
  assert.throws(() => assertPublishIsolation(bareTarball));
  const missingEnv = structuredClone(publish);
  delete missingEnv.steps.find(step => step.run?.includes("npm publish")).env.NPM_CONFIG_IGNORE_SCRIPTS;
  assert.throws(() => assertPublishIsolation(missingEnv));
  for (const changes of [{ "artifact-ids": undefined, name: "candidate" }, { "run-id": 123 }, { repository: "other/repo" }]) {
    const changed = structuredClone(publish);
    Object.assign(changed.steps.find(step => step.uses?.startsWith("actions/download-artifact@")).with, changes);
    assert.throws(() => assertPublishIsolation(changed));
  }
});

test("Windows CI enforces private-first selection, fallback, recovery and private bootstrap boundaries", () => {
  for (const name of [
    "private-public-availability", "agent-transport-recovery", "private-recovery-ui", "private-bootstrap-chrome", "connection-report", "private-gateway", "native-fallback-setup", "native-fallback-setup-chrome", "offline-shell", "offline-shell-chrome",
    "one-address-ui", "background-transfer-ui", "security", "delivery", "start-info-route",
    "start-native-ui", "start-screens-ui", "funnel-agent-cors", "funnel-agent-gateway",
    "ios-launch", "ios-page-evidence", "ios-proxy", "bounded-command", "headless-chrome-lifecycle",
  ]) assert.ok(suites.windows.includes(name), `${name} needs the Windows lane`);
});
