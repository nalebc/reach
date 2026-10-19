import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boundedCommand } from "./bounded-command.mjs";

const build = "/Applications/Xcode_26.2.app/Contents/Developer";
const deviceType = "com.apple.CoreSimulator.SimDeviceType.iPhone-SE-3rd-generation";
const framework = "/Library/Developer/PrivateFrameworks/CoreSimulator.framework";
const setup = (condition, message) => assert.ok(condition, `UNQUALIFIED_IOS_SETUP: ${message}`);
export function iosComparisonConfiguration(id) {
  setup(["A", "B", "C"].includes(id), "unknown declared comparison configuration");
  return { id, hostMajor: id === "A" ? "15" : "26", build, buildVersion: "26.2", buildNumber: "17C52",
    simulator: id === "C" ? "/Applications/Xcode_26.4.1.app/Contents/Developer" : build,
    simulatorVersion: id === "C" ? "26.4.1" : "26.2", simulatorBuild: id === "C" ? "17E202" : "17C52",
    runtime: "26.2", deviceType };
}

// Hash normal files through one descriptor, with bounded memory/size/time.
// These hashes identify on-disk files, never a loaded image or vendor fix.
export async function iosFileIdentity(file, { deadline = Date.now() + 2000, maximum = 128 * 1024 * 1024 } = {}) {
  assert.ok(Date.now() < deadline, "provenance file deadline exhausted");
  const resolvedPath = await fs.realpath(file);
  const handle = await fs.open(resolvedPath, constants.O_RDONLY | (constants.O_NONBLOCK || 0) | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    assert.ok(stat.isFile() && stat.size <= maximum, "provenance file is not a bounded normal file");
    const hash = crypto.createHash("sha256"), buffer = Buffer.alloc(65536);
    let bytes = 0;
    while (bytes < stat.size) {
      assert.ok(Date.now() < deadline, "provenance file deadline exhausted");
      const read = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - bytes), bytes);
      assert.ok(read.bytesRead, "provenance file changed while reading");
      hash.update(buffer.subarray(0, read.bytesRead)); bytes += read.bytesRead;
    }
    const after = await handle.stat();
    assert.ok(after.size === stat.size && after.mtimeMs === stat.mtimeMs, "provenance file changed while reading");
    return { path: file, resolvedPath, bytes, sha256: hash.digest("hex"), mtimeMs: stat.mtimeMs };
  } finally { await handle.close(); }
}
const observed = async operation => {
  try { return await operation(); } catch (error) { return { unavailable: String(error.message).slice(0, 1000) }; }
};
export const iosAppIdentity = async (app, options) => ({
  scope: "App executable and Info.plist only; not a whole-bundle digest",
  executable: await observed(() => iosFileIdentity(path.join(app, "App"), options)),
  infoPlist: await observed(() => iosFileIdentity(path.join(app, "Info.plist"), options)),
});
export async function iosDaemonIdentities(rows, options, identify = iosFileIdentity) {
  const files = [...new Set(String(rows || "").split("\n").map(line => line.match(/(\/\S+(?:simdiskimaged|com\.apple\.CoreSimulator\.CoreSimulatorService))$/)?.[1])
    .filter(file => file?.startsWith(framework + "/") && path.posix.normalize(file) === file))].slice(0, 4);
  return Promise.all(files.map(file => observed(() => identify(file, options))));
}

export const captureIosBoundary = name => ["launch", "runtime shared cache ready", "bootstatus", "stalled launch bootstatus",
  "readiness (launchctl list in the device)", "stalled launch readiness"].includes(name);
export function iosComparisonRuntime(id, runtime, type, requireDevice = false) {
  if (!id) return undefined;
  const expected = iosComparisonConfiguration(id);
  setup(runtime?.isAvailable === true && runtime.version === expected.runtime && typeof runtime.buildversion === "string" && runtime.buildversion.length > 0,
    "the declared iOS26.2 runtime/build is unavailable; no substitution");
  setup(runtime.supportedDeviceTypes?.some(item => item.identifier === expected.deviceType), "runtime does not declare SE3 support");
  if (requireDevice) setup(type?.identifier === expected.deviceType, "the declared SE3 device is unavailable; no substitution");
  return { identifier: runtime.identifier, version: runtime.version, build: runtime.buildversion,
    runtimeRoot: runtime.runtimeRoot, bundlePath: runtime.bundlePath, device: type ? { identifier: type.identifier, name: type.name } : undefined };
}

export async function collectIosToolchainProvenance({ env = process.env, run = boundedCommand, identify = iosFileIdentity, arch = process.arch,
  isTool = async file => (await fs.stat(file)).isFile() } = {}) {
  const expected = iosComparisonConfiguration(env.REACH_TEST_IOS_COMPARISON);
  const deadline = Date.now() + 30000;
  const command = async (file, args) => {
    const answer = await run(file, args, Math.max(1, Math.min(10000, deadline - Date.now())), { captureLifecycle: true });
    return { command: file, args, stdout: answer.stdout.slice(0, 4096), commandEvidence: answer.commandEvidence };
  };
  const under = (developer, file, args) => command("/usr/bin/env", [`DEVELOPER_DIR=${developer}`, file, ...args]);
  const [host, buildVersion, simulatorVersion, sdk, sdkPath, simctl, source] = await Promise.all([
    command("/usr/bin/sw_vers", ["-productVersion"]),
    under(expected.build, "/usr/bin/xcodebuild", ["-version"]),
    under(expected.simulator, "/usr/bin/xcodebuild", ["-version"]),
    under(expected.build, "/usr/bin/xcrun", ["--sdk", "iphonesimulator", "--show-sdk-version"]),
    under(expected.build, "/usr/bin/xcrun", ["--sdk", "iphonesimulator", "--show-sdk-path"]),
    under(expected.simulator, "/usr/bin/xcrun", ["--find", "simctl"]),
    command("git", ["log", "-1", "--format=%H%n%T"]),
  ]);
  setup(host.stdout.trim().split(".")[0] === expected.hostMajor && arch === "arm64", "host OS/architecture differs from declared cell");
  setup(buildVersion.stdout.trim() === `Xcode ${expected.buildVersion}\nBuild version ${expected.buildNumber}`, "build Xcode differs");
  setup(simulatorVersion.stdout.trim() === `Xcode ${expected.simulatorVersion}\nBuild version ${expected.simulatorBuild}`, "simulator Xcode differs");
  setup(sdk.stdout.trim() === "26.2", "build simulator SDK differs from26.2");
  setup(sdkPath.stdout.trim() === expected.build + "/Platforms/iPhoneSimulator.platform/Developer/SDKs/iPhoneSimulator26.2.sdk", "build SDK path differs");
  setup(simctl.stdout.trim() === expected.simulator + "/usr/bin/simctl", "selected simctl path differs");
  for (const file of new Set([expected.build + "/usr/bin/xcodebuild", expected.simulator + "/usr/bin/xcodebuild", simctl.stdout.trim()]))
    setup(await isTool(file), `declared tool is missing or not a normal file: ${file}`);
  const [head, tree] = source.stdout.trim().split("\n");
  setup(/^[a-f0-9]{40}$/.test(head) && head === env.REACH_TEST_IOS_SOURCE_SHA && /^[a-f0-9]{40}$/.test(tree), "checkout/source binding differs");
  const frameworkVersion = await observed(() => command("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleVersion", framework + "/Resources/Info.plist"]));
  const files = ["/usr/bin/xcrun", simctl.stdout.trim(), framework + "/Versions/A/CoreSimulator"];
  return { status: "DECLARED_TOOLS_PRESENT_NATIVE_TEST_NOT_YET_RUN", expected, head, tree,
    image: { ImageOS: env.ImageOS?.slice(0, 128), ImageVersion: env.ImageVersion?.slice(0, 128) },
    commands: { host, buildVersion, simulatorVersion, sdk, sdkPath, simctl, source }, frameworkVersion,
    files: await Promise.all(files.map(file => observed(() => identify(file, { deadline })))),
    limits: ["On-disk framework/daemon identity is observational, not loaded-image or vendor-fix proof.",
      "Identical B/C daemon provenance provides no isolated daemon-treatment evidence.", "Runtime/device availability is checked by the original simctl calls, without a warmup."] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.env.REACH_TEST_IOS_PROVENANCE;
  let result;
  try {
    setup(!!output, "provenance report path is required");
    if (process.argv[2] === "preflight") result = await collectIosToolchainProvenance();
    else {
      setup(process.argv[2] === "built", "unknown provenance mode");
      result = JSON.parse(await fs.readFile(output, "utf8"));
      result.originalBuiltApp = await iosAppIdentity(process.env.REACH_TEST_IOS_APP);
    }
  } catch (error) {
    result = { status: "UNQUALIFIED_SETUP", error: String(error.message).slice(0, 2000), configuration: process.env.REACH_TEST_IOS_COMPARISON,
      commandEvidence: error.commandEvidence, stdout: error.stdout?.slice(0, 4096), stderr: error.stderr?.slice(0, 4096) };
    process.exitCode = 1;
  }
  if (output) {
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify(result, null, 2) + "\n");
  }
  process.stdout.write(JSON.stringify(result) + "\n");
}
