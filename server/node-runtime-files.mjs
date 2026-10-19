import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fail } from "./core.mjs";

const nativeArchitecture = process.arch === "arm64" ? "arm64" : "x86_64";
function inspectMachO(file, flag, architecture) {
  const output = execFileSync("/usr/bin/otool", ["-arch", architecture, flag, file], { encoding: "utf8", timeout: 5000, maxBuffer: 262144, stdio: "pipe" });
  // otool can exit successfully while reporting a non-object file. Both
  // thin and selected universal slices must have an exact Mach-O heading;
  // accepting diagnostic prose as an empty graph would skip isolation checks.
  const header = output.split("\n", 1)[0];
  if ((header !== `${file}:` && header !== `${file} (architecture ${architecture}):`) ||
      (flag === "-l" && !/^Load command \d+$/m.test(output)))
    throw Object.assign(new Error("Invalid runtime inspection output."), { code: "INVALID_MACHO" });
  return output;
}

// Enumerate exact Mach-O runtime files for the folder-scoped script sandbox.
// Homebrew Node may keep libnode in ../lib and name it through LC_RPATH.
// Never turn a missing dependency into a recursive library-directory grant.
export function nodeRuntimeFiles(executable = process.execPath, {
  architecture = nativeArchitecture,
  inspect = (file, flag) => inspectMachO(file, flag, architecture),
  realpath = fs.realpathSync,
  exists = fs.existsSync,
} = {}) {
  const posix = path.posix;
  const system = file => file.startsWith("/usr/lib/") || file.startsWith("/System/Library/");
  const refused = () => fail(503, "The script runtime libraries could not be isolated. Nothing was run.");
  let retryUsed = false, inspectionFailure;
  const inspectFile = (file, flag) => {
    let attempts = 0;
    for (;;) {
      attempts++;
      try { return inspect(file, flag); }
      catch (error) {
        // Only a confirmed tool deadline may spend one extra read-only
        // attempt across this entire graph. Every attempt keeps its 5 s
        // limit, and no script has been spawned at this point.
        if (error?.code === "ETIMEDOUT" && !retryUsed) { retryUsed = true; continue; }
        // Raw tool errors contain host paths/stdout/stderr. Preserve only
        // fixed diagnostic fields so refusals stay useful without exposing
        // any of those values through the API or test failure reports.
        const code = ["ETIMEDOUT", "EACCES", "EPERM", "ENOENT", "ENOBUFS", "INVALID_MACHO"].includes(error?.code) ? error.code : "INSPECT_FAILED";
        inspectionFailure = Object.assign(refused(), { code: "RUNTIME_INSPECTION_FAILED", runtimeInspection: {
          phase: flag === "-l" ? "load-commands" : "dependencies", code, attempts, retryUsed,
        } });
        throw inspectionFailure;
      }
    }
  };
  try {
    if (!["arm64", "x86_64"].includes(architecture)) throw refused();
    const entry = realpath(executable), executableDir = posix.dirname(entry);
    const pending = [{ file: entry, inherited: [] }], files = new Set(), visited = new Set();
    const expand = (value, file) => {
      for (const [prefix, base] of [["@loader_path", posix.dirname(file)], ["@executable_path", executableDir]]) {
        if (value === prefix) return base;
        if (value.startsWith(prefix + "/")) return posix.resolve(base, value.slice(prefix.length + 1));
      }
      if (!value.startsWith("/")) throw refused();
      return posix.normalize(value);
    };
    while (pending.length) {
      const { file, inherited } = pending.pop();
      if (system(file) || visited.has(file)) continue;
      visited.add(file); files.add(file);
      if (files.size > 100) throw refused();
      const ownPaths = [...inspectFile(file, "-l").matchAll(/\bcmd LC_RPATH\s+cmdsize \d+\s+path (.+) \(offset \d+\)/g)]
        .map(match => expand(match[1], file));
      const rpaths = [...new Set([...ownPaths, ...inherited])];
      if (rpaths.length > 100) throw refused();
      for (const line of inspectFile(file, "-L").split("\n").slice(1)) {
        const dependency = line.trim().split(" (")[0];
        if (!dependency) continue;
        const resolved = dependency.startsWith("@rpath/")
          ? rpaths.map(root => posix.resolve(root, dependency.slice(7))).find(candidate => system(candidate) || exists(candidate))
          : expand(dependency, file);
        if (!resolved) throw refused();
        if (system(resolved)) continue;
        const canonical = realpath(resolved);
        files.add(resolved); files.add(canonical);
        files.add(posix.join(realpath(posix.dirname(resolved)), posix.basename(resolved)));
        if (files.size > 100) throw refused();
        pending.push({ file: canonical, inherited: rpaths });
      }
    }
    return [...files];
  } catch (error) {
    throw error === inspectionFailure ? error : refused();
  }
}
