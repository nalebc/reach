// Drives scripts/native/sandbox.cs for the Windows escape e2e
// (test/windows-sandbox-e2e.test.mjs, test/windows-file-boundary-e2e.test.mjs,
// docs/parity/C-sandbox.md §9.3). Run as a standard user through run-as.cs: it
// reads a request spec, frames it to the helper on stdin (kept open as the
// lifeline), and writes the framed outcome so the elevated test can assert it.
//
//   node drive-sandbox.mjs <sandbox.exe> <spec.json> <out.json>
//
// spec.json: { "entries": [["mode","jobs"], ["grant","C:\\..."], ...] }
import fs from "node:fs";
import { spawn } from "node:child_process";
import { encodeSandboxRequest, createSandboxFrameReader } from "../../../server/windows-sandbox.mjs";

const [, , exe, specFile, outFile] = process.argv;
const spec = JSON.parse(fs.readFileSync(specFile, "utf8"));
const out = { started: false, stdout: "", stderr: "", exit: null, result: null, refused: null };
const child = spawn(exe, ["run"], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
const read = createSandboxFrameReader({
  onStarted: () => { out.started = true; },
  onStdout: (b) => { out.stdout += b.toString(); },
  onStderr: (b) => { out.stderr += b.toString(); },
  onExit: (c) => { out.exit = c; },
  onResult: (b) => { out.result = b.toString(); },
  onRefused: (r) => { out.refused = r; },
});
child.stdout.on("data", read);
child.on("error", (error) => { out.error = String(error.message); fs.writeFileSync(outFile, JSON.stringify(out)); process.exit(0); });
child.on("close", () => { fs.writeFileSync(outFile, JSON.stringify(out)); process.exit(0); });
try { child.stdin.write(encodeSandboxRequest(spec.entries)); } catch {}
