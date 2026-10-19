// Actual OS/browser diagnostic: record archived behavior and identify an
// original failure only when it is actually observed. This is not a
// release pass, a physical network test, or permission to relax an assertion.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

assert.ok(
  process.env.npm_execpath,
  "run through npm run test:ci:regression-baseline",
);
assert.ok(
  ["darwin", "win32"].includes(process.platform),
  "requires an actual Mac or Windows host",
);
const scenario = process.argv[2];
assert.equal(
  process.argv.length,
  3,
  "select exactly one isolated baseline scenario",
);
assert.ok(
  ["windows-lifetime", "audio-batch"].includes(scenario),
  "select exactly one isolated baseline scenario",
);
if (scenario === "windows-lifetime") assert.equal(process.platform, "win32");
const root = fileURLToPath(new URL("../..", import.meta.url));
const dir = path.join(root, "reports", "native-baseline");
fs.mkdirSync(dir, { recursive: true });
const archived = "6a82cb17043e27468d0c338ab5e4138dcaf68187";
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const readLimit = 16 << 20;
// Keep metadata and bounded reads on one owned descriptor. A size check on a
// path followed by a second open could read a replacement file instead.
function readDescriptor(fd) {
  assert.ok(
    fs.fstatSync(fd).isFile(),
    "diagnostic input must be a regular file",
  );
  const buffer = Buffer.alloc(readLimit + 1);
  let length = 0;
  while (length < buffer.length) {
    const count = fs.readSync(
      fd,
      buffer,
      length,
      buffer.length - length,
      length,
    );
    if (!count) break;
    length += count;
  }
  return {
    bytes: Buffer.from(buffer.subarray(0, length)),
    oversized: length > readLimit,
  };
}
function readDiagnostic(file) {
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
  );
  try {
    return readDescriptor(fd);
  } finally {
    fs.closeSync(fd);
  }
}
const current = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const observations = [];
const save = () =>
  fs.writeFileSync(
    path.join(dir, "result.json"),
    JSON.stringify(
      {
        scope:
          "Actual OS processes and browser/helper execution with controlled fixtures; no physical network or phone qualification",
        host: process.platform,
        architecture: process.arch,
        node: process.versions.node,
        archivedCommit: archived,
        currentCommit: current,
        observations,
      },
      null,
      2,
    ) + "\n",
  );

function baseline(file, digest, name) {
  const bytes = execFileSync("git", ["show", `${archived}:${file}`], {
    cwd: root,
    maxBuffer: 1 << 20,
  });
  assert.equal(
    hash(bytes),
    digest,
    "the baseline must be the exact archived public source",
  );
  const output = path.join(dir, name);
  fs.writeFileSync(output, bytes);
  return output;
}

async function observeOriginal(name, file, pattern, env, reportName, inspect) {
  const logs = ["stdout", "stderr"].map((kind) =>
    path.join(dir, `${name}.${kind}`),
  );
  const fds = logs.map((file) => fs.openSync(file, "w+"));
  const args = [
    process.env.npm_execpath,
    "run",
    "test:file",
    "--",
    "--test-timeout=300000",
    "--test-concurrency=1",
    `--test-name-pattern=${pattern}`,
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=junit",
    `--test-reporter-destination=reports/native-baseline/${name}.xml`,
    file,
  ];
  const report = path.join(root, "reports", reportName);
  fs.rmSync(report, { force: true });
  const retainedReport = path.join(dir, `${name}.json`);
  let retainedReportBytes;
  const preserveReport = () => {
    let captured;
    try {
      captured = readDiagnostic(report);
    } catch (error) {
      if (error.code === "ENOENT") return { present: false };
      throw error;
    }
    retainedReportBytes = captured.bytes;
    fs.writeFileSync(retainedReport, retainedReportBytes, { flag: "wx" });
    return {
      present: true,
      file: path.basename(retainedReport),
      bytes: retainedReportBytes.length,
      sha256: hash(retainedReportBytes),
      ...(captured.oversized
        ? { oversized: true, retainedPrefixOnly: true }
        : {}),
    };
  };
  let rawReport;
  const began = Date.now();
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: root,
        env: { ...process.env, ...env },
        stdio: ["ignore", ...fds],
      });
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    // Preserve even a rejected/partial original report before the current
    // implementation's unconditional GREEN step can write its normal name.
    rawReport = preserveReport();
    assert.equal(result.signal, null);
    assert.ok(
      result.code === 1 || (name === "audio-batch" && result.code === 0),
      "the actual selected case must complete with a recognized result",
    );
    const reproduced = result.code === 1;
    const logBytes = fds.map((fd) => {
      const captured = readDescriptor(fd);
      assert.equal(
        captured.oversized,
        false,
        "bounded retained diagnostic output",
      );
      return captured.bytes;
    });
    const text = logBytes.map((bytes) => bytes.toString("utf8")).join("\n");
    assert.doesNotMatch(
      text,
      /fixture cleanup failed|cancelledByParent|testTimeoutFailure/,
    );
    const junitInput = readDiagnostic(path.join(dir, `${name}.xml`));
    assert.equal(junitInput.oversized, false);
    const junit = junitInput.bytes.toString("utf8");
    assert.equal(
      [...junit.matchAll(/<testcase\b/g)].length,
      1,
      "exactly one selected original case must execute",
    );
    assert.doesNotMatch(junit, /<skipped\b/);
    const failures = [
      ...junit.matchAll(/<failure\b[^>]*\btype="([^"]+)"[^>]*>/g),
    ].map((match) => match[1]);
    assert.equal(
      failures.length,
      reproduced ? 1 : 0,
      "only the selected original result may be reported",
    );
    assert.ok(
      !/<error\b|type="(?:cancelledByParent|testTimeoutFailure|uncaughtException|unhandledRejection)"/.test(
        junit,
      ),
    );
    if (name === "audio-batch") {
      if (reproduced)
        assert.deepEqual(
          failures,
          ["testCodeFailure"],
          "Chrome cleanup cannot substitute for the audio assertion",
        );
      // Node 22 can suppress a second after-hook rejection once the body has
      // failed. The current helper diagnoses every cleanup rejection itself.
      assert.doesNotMatch(
        text,
        /Chrome lifetime /,
        "an additional Chrome cleanup failure invalidates audio-only RED",
      );
    } else assert.ok(["testCodeFailure", "hookFailed"].includes(failures[0]));
    assert.equal(
      rawReport.present,
      true,
      "the selected original case must retain its actual report",
    );
    assert.notEqual(rawReport.oversized, true);
    const evidence = JSON.parse(retainedReportBytes);
    inspect(evidence, text, result.code);
    observations.push({
      name,
      result: reproduced
        ? "EXPECTED_ORIGINAL_FAILURE_REPRODUCED"
        : "ORIGINAL_PASSED_THIS_ENVIRONMENT",
      reproduced,
      currentImplementationQualified: false,
      originalTestExitCode: result.code,
      durationMs: Date.now() - began,
      rawReport,
      logs: logs.map((file, index) => ({
        file: path.basename(file),
        sha256: hash(logBytes[index]),
      })),
    });
    save();
    console.log(
      `${name}: ${reproduced ? "expected original failure reproduced" : "original passed this environment; failure not reproduced"} on ${process.platform}/${process.arch}`,
    );
  } catch (error) {
    try {
      rawReport ||= preserveReport();
    } catch (capture) {
      rawReport = { error: capture.message };
    }
    observations.push({
      name,
      result: "REPRODUCTION_NOT_ESTABLISHED",
      durationMs: Date.now() - began,
      error: error.message,
      rawReport,
    });
    save();
    throw error;
  } finally {
    for (const fd of fds) fs.closeSync(fd);
  }
}

// Each scenario runs on a separate disposable hosted machine from the other
// baselines and current tests. Existing test deadlines and the job deadline
// remain authoritative; no wrapper-only PID kill can strand a worker while
// another scenario starts in the same workspace.
if (scenario === "windows-lifetime") {
  const original = baseline(
    "test/helpers/headless-chrome.mjs",
    "fddf632b95a42ac541a4d25f0abeab914f1914cc7e1223f5b047157860409c97",
    "original-headless-chrome.mjs",
  );
  await observeOriginal(
    "windows-lifetime",
    "test/windows-browser-lifetime-native.test.mjs",
    "^Windows browser lifetime: parent exit cannot abandon inherited pipes and a locked profile$",
    {
      REACH_TEST_BROWSER_LIFETIME_HELPER: original,
      REACH_TEST_WINDOWS_DESKTOP: "1",
    },
    "windows-browser-lifetime.json",
    (report, output) => {
      const rows = report.observations;
      assert.equal(rows.length, 1);
      const row = rows[0];
      assert.equal(row.platform, "win32");
      assert.equal(row.mode, "orphan");
      assert.equal(row.helper, "explicit-baseline");
      assert.equal(row.outcome, "failed");
      assert.equal(
        row.error,
        "Disposable Chrome did not close after bounded termination",
      );
      assert.match(
        output,
        /Disposable Chrome did not close after bounded termination/,
      );
      const state = (identity) =>
        row.beforeCleanup.find(
          (item) =>
            item.identity.pid === identity.pid &&
            item.identity.creationTime === identity.creationTime,
        );
      assert.equal(
        state(row.identities.parent).alive,
        false,
        "the original parent already exited",
      );
      for (const identity of [row.identities.descendant, row.canary]) {
        assert.equal(state(identity).alive, true);
        assert.equal(state(identity).creationMatches, true);
      }
    },
  );
}

if (scenario === "audio-batch") {
  const original = baseline(
    "src/sound-worklet.js",
    "6f02777932f43d5f6eb9239fc434ebe188f35afc253c77df573c9e27e0161982",
    "original-sound-worklet.js",
  );
  await observeOriginal(
    "audio-batch",
    "test/screen-sound-chrome-e2e.test.mjs",
    "^in a real browser, controlled seven-packet native batches stay steady under Reach's own page policy$",
    {
      REACH_TEST_SOUND_WORKLET_BASELINE: original,
      REACH_TEST_SOUND_CHROME: "1",
      REACH_TEST_WINDOWS_DESKTOP: "1",
    },
    "sound-chrome-batch-baseline-e2e.json",
    (report, output, code) => {
      assert.equal(report.host, process.platform);
      assert.equal(report.scenario, "controlled-native-packet-delivery");
      assert.equal(report.worklet.kind, "verified-old-M-baseline");
      assert.equal(
        report.worklet.sha256,
        "6f02777932f43d5f6eb9239fc434ebe188f35afc253c77df573c9e27e0161982",
      );
      assert.equal(report.worklet.assetSHA256, report.worklet.sha256);
      assert.equal(report.worklet.servedSHA256, report.worklet.sha256);
      assert.ok(report.worklet.servedCount >= 1);
      assert.equal(report.steadyLevels.length, 40);
      if (code === 0) {
        assert.equal(report.timing.stage, 5);
        assert.equal(report.timing.completed, 1);
        assert.ok(
          report.ranDry <= 1 && report.blips <= 1,
          "the original stability assertion completed in this environment",
        );
      } else {
        assert.equal(report.timing.stage, 3);
        assert.equal(report.timing.completed, 0);
        assert.ok(
          report.ranDry > 1 || report.blips > 1,
          "only the intended tone stability failure establishes RED",
        );
        assert.match(output, /ran dry \d+ times; blips \d+/);
      }
      assert.equal(report.delivery.physicalNetwork, false);
      assert.equal(report.delivery.batches.length, 1);
      const delivery = report.delivery.batches[0];
      assert.deepEqual(delivery.violations, []);
      assert.ok(delivery.batches >= 20);
      assert.equal(delivery.received, delivery.delivered);
      assert.equal(delivery.receivedSHA256, delivery.deliveredSHA256);
      assert.equal(delivery.pending, 0);
      assert.equal(delivery.timerPending, false);
      assert.equal(delivery.ignoredAfterClose, 0);
    },
  );
}
