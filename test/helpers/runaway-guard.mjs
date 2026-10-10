import assert from "node:assert";
import { spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { inspect, isDeepStrictEqual } from "node:util";

// A test must never be able to take the Mac down. On Oct 9 three UI test
// processes grew to 39, 36 and 6 GB within four minutes; macOS compressed
// and swapped until WindowServer stopped answering, its watchdog killed it,
// and the session logged out. The one traced was a failing assertion handed
// a rendered element (the others fit the same pattern). Node's assert (24.x)
// prints both values in full and diffs them line by line, keeping a copy of
// its working array for every differing line: memory grows with differing
// lines × all lines, outside the JavaScript heap limit. Two objects of 5,000
// lines each take 0.7 GB, two 200 KB Buffers pass 2.7 GB, and an element
// (React's links reach the whole page) prints millions of lines.
//
// Loaded by the DOM harness and by `npm test` for every file: assertions
// decide pass or fail themselves and let Node describe only values that print
// small, and a watcher outside this process ends it if its memory runs away
// for any other reason.

// --- Page objects ---------------------------------------------------------------
// A node or window becomes a short label with an identity number, so equality
// means the same as before (same node, same label) and a failure reads
// `<button> #3 "24 hours"`.
const isPage = (value) => {
  if (value === null || typeof value !== "object") return false;
  try {
    return (
      (typeof value.nodeType === "number" &&
        typeof value.nodeName === "string") ||
      (value.window === value && typeof value.document === "object")
    );
  } catch {
    return false;
  }
};
const ids = new WeakMap();
let lastId = 0;
const label = (value) => {
  if (!ids.has(value)) ids.set(value, ++lastId);
  const id = ids.get(value);
  if (value.window === value) return `[window #${id}]`;
  if (value.nodeType !== 1) return `[${value.nodeName} #${id}]`;
  const text = (value.textContent || "").trim().replace(/\s+/g, " ");
  const shown = text.length > 60 ? `${text.slice(0, 57)}…` : text;
  return `<${value.localName}> #${id}${shown ? ` "${shown}"` : ""}`;
};
const plain = (value) =>
  value !== null &&
  typeof value === "object" &&
  (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype);
const holdsPage = (value, depth = 0) =>
  isPage(value) ||
  (depth < 3 &&
    plain(value) &&
    Object.values(value).some((item) => holdsPage(item, depth + 1)));
const standIn = (value, depth = 0) => {
  if (isPage(value)) return label(value);
  if (depth >= 3 || !plain(value)) return value;
  if (Array.isArray(value))
    return value.map((item) => standIn(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, standIn(item, depth + 1)]),
  );
};

// --- How much Node would print ------------------------------------------------
// Counts the lines assert's inspection would produce, without calling getters
// or custom inspectors, and stops at the limit. It walks a tree the way the
// printer does: a shared object prints again wherever it appears, and only one
// repeating on its own path is circular. Anything it can't walk counts as big.
const LINES = 1000;
const tooMany = Symbol("too many");
const printedLines = (value) => {
  let lines = 0;
  const path = new Set();
  const add = (n) => {
    lines += n;
    if (lines > LINES) throw tooMany;
  };
  const walk = (item) => {
    add(1);
    if (typeof item === "string") {
      for (
        let at = item.indexOf("\n");
        at !== -1;
        at = item.indexOf("\n", at + 1)
      )
        add(1);
      return;
    }
    if (
      item === null ||
      (typeof item !== "object" && typeof item !== "function")
    )
      return;
    if (path.has(item)) return;
    path.add(item);
    if (ArrayBuffer.isView(item)) add(item.length ?? item.byteLength);
    else if (item instanceof ArrayBuffer) add(item.byteLength);
    else if (Array.isArray(item))
      for (let i = 0; i < item.length; i++) walk(item[i]);
    else {
      if (item instanceof Map)
        for (const [key, entry] of item) (walk(key), walk(entry));
      else if (item instanceof Set) for (const entry of item) walk(entry);
      if (item instanceof Error) walk(`${item.stack}`);
      for (const key of Reflect.ownKeys(item)) {
        const property = Object.getOwnPropertyDescriptor(item, key);
        if (!property?.enumerable) continue;
        if ("value" in property) walk(property.value);
        else add(1);
      }
    }
    path.delete(item);
  };
  try {
    walk(value);
    return lines;
  } catch {
    return Infinity;
  }
};

// --- Describing a big failure ---------------------------------------------------
const brief = (value) => {
  const text = inspect(value, {
    depth: 2,
    maxArrayLength: 20,
    maxStringLength: 200,
    breakLength: 100,
    customInspect: false,
  });
  return text.length > 1200 ? `${text.slice(0, 1200)}…` : text;
};
// The path to the first place two values part, within a budget.
const firstDifference = (actual, expected) => {
  let budget = 20000;
  const seen = new WeakSet();
  const walk = (a, b, at) => {
    if (--budget < 0) throw tooMany;
    if (Object.is(a, b)) return null;
    if (
      a === null ||
      b === null ||
      typeof a !== "object" ||
      typeof b !== "object" ||
      Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)
    )
      return { at, a, b };
    if (seen.has(a)) return null;
    seen.add(a);
    if (Array.isArray(a) || ArrayBuffer.isView(a)) {
      if (a.length !== b.length)
        return { at: `${at}.length`, a: a.length, b: b.length };
      for (let i = 0; i < a.length; i++) {
        const found = walk(a[i], b[i], `${at}[${i}]`);
        if (found) return found;
      }
      return null;
    }
    if (a instanceof Map || a instanceof Set)
      return a.size === b.size
        ? null
        : { at: `${at}.size`, a: a.size, b: b.size };
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const where = `${at}.${key}`;
      if (!Object.hasOwn(b, key))
        return { at: where, a: a[key], b: "(missing)" };
      if (!Object.hasOwn(a, key))
        return { at: where, a: "(missing)", b: b[key] };
      const found = walk(a[key], b[key], where);
      if (found) return found;
    }
    return null;
  };
  try {
    return walk(actual, expected, "");
  } catch {
    return null;
  }
};
const failBig = (name, actual, expected, message, from) => {
  if (message instanceof Error) throw message;
  const lines = [message ?? `${name} failed`];
  if (name.startsWith("not"))
    lines.push("  the values are equal, and they were expected not to be");
  else {
    const part = firstDifference(actual, expected);
    if (part)
      lines.push(
        `  first difference at ${part.at || "the top"}: ${brief(part.a)} vs ${brief(part.b)}`,
      );
    else if (name === "strictEqual")
      lines.push("  same contents, but not the same object");
  }
  lines.push(
    "  (Node's full diff skipped: these values print over 1,000 lines, and its diff memory grows with their square)",
  );
  return new assert.AssertionError({
    message: lines.join("\n"),
    actual: brief(actual),
    expected: brief(expected),
    operator: name,
    stackStartFn: from,
  });
};

// --- Every equality assertion ---------------------------------------------------
// Pass or fail is decided here with Node's own strict rules, so a passing
// assertion costs only the comparison; Node describes a failure only when
// both values print small.
const strict = {
  strictEqual: (a, b) => Object.is(a, b),
  notStrictEqual: (a, b) => !Object.is(a, b),
  deepStrictEqual: isDeepStrictEqual,
  notDeepStrictEqual: (a, b) => !isDeepStrictEqual(a, b),
};
const decide = (target, name) => {
  if (target === assert.strict) {
    const same =
      {
        equal: "strictEqual",
        notEqual: "notStrictEqual",
        deepEqual: "deepStrictEqual",
        notDeepEqual: "notDeepStrictEqual",
      }[name] || name;
    return strict[same] && [same, strict[same]];
  }
  if (name === "equal") return ["equal", (a, b) => a == b];
  if (name === "notEqual") return ["notEqual", (a, b) => a != b];
  return strict[name] && [name, strict[name]];
};
const compared = [
  "equal",
  "notEqual",
  "strictEqual",
  "notStrictEqual",
  "deepEqual",
  "notDeepEqual",
  "deepStrictEqual",
  "notDeepStrictEqual",
  "partialDeepStrictEqual",
];
for (const target of new Set([assert, assert.strict]))
  for (const name of compared) {
    const original = target[name];
    if (typeof original !== "function" || original.pageSafe) continue;
    const rule = decide(target, name);
    const safe = function (actual, expected, message) {
      if (arguments.length < 2) return original.apply(this, arguments);
      // Node already shortens two strings before diffing them.
      if (typeof actual === "string" && typeof expected === "string")
        return original.call(this, actual, expected, message);
      if (holdsPage(actual) || holdsPage(expected)) {
        actual = standIn(actual);
        expected = standIn(expected);
      }
      if (rule) {
        if (rule[1](actual, expected)) return;
        if (printedLines(actual) + printedLines(expected) > LINES)
          throw failBig(rule[0], actual, expected, message, safe);
      }
      return original.call(this, actual, expected, message);
    };
    safe.pageSafe = true;
    target[name] = safe;
  }
// `import { equal } from "node:assert/strict"` binds early; this refreshes it.
syncBuiltinESMExports();

// --- Memory watcher -----------------------------------------------------------
// It runs as its own small process because a runaway assertion is one long
// synchronous loop: nothing on this process's threads gets a turn. It reads
// the physical footprint (what macOS counts, compressed pages included; the
// resident size stayed near 1.5 GB while one of those processes passed 80 GB)
// and ends this process at the limit, saying why. Healthy UI test files stay
// under 300 MB; REACH_TEST_MEMORY_MB raises the limit for one that needs more.
const limitMb = Number(process.env.REACH_TEST_MEMORY_MB) || 2048;
const watcher = `
import ctypes, os, signal, sys, time
pid, limit = int(sys.argv[1]), int(sys.argv[2])
libproc = ctypes.CDLL("/usr/lib/libproc.dylib") if sys.platform == "darwin" else None
info = ctypes.create_string_buffer(512)
def footprint():
    if libproc:
        # proc_pid_rusage(RUSAGE_INFO_V2): ri_phys_footprint sits at byte 72.
        if libproc.proc_pid_rusage(pid, 2, info) != 0: return None
        return int.from_bytes(info.raw[72:80], "little")
    try:
        fields = dict(line.split(":", 1) for line in open(f"/proc/{pid}/status"))
        return sum(int(fields.get(k, "0 kB").split()[0]) for k in ("VmRSS", "VmSwap")) * 1024
    except OSError:
        return None
while os.getppid() == pid:
    used = footprint()
    if used is None: break
    if used > limit:
        sys.stderr.write(
            f"\\n[runaway guard] This test process reached {used / 2**30:.1f} GB of memory "
            f"(limit {limit / 2**30:.1f} GB) and was stopped before it could slow down or crash the Mac. "
            "A failing assertion on a large object is the usual cause; "
            "REACH_TEST_MEMORY_MB raises the limit for a test that truly needs more.\\n")
        os.kill(pid, signal.SIGKILL)
        break
    time.sleep(0.1)
`;
if (process.platform === "darwin" || process.platform === "linux") {
  const child = spawn(
    "python3",
    ["-I", "-c", watcher, String(process.pid), String(limitMb * 2 ** 20)],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  // Without Python the assertions above still hold; only the backstop is gone.
  child.on("error", () => {});
  child.unref();
}
