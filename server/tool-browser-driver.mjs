import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fail } from "./core.mjs";
import { toolPageOperation } from "./tool-page-runtime.mjs";

const script = fileURLToPath(
  new URL("../scripts/native/tool-browser.js", import.meta.url),
);
// Native stderr and page exceptions may contain URLs, fields or local paths.
// Keep only protocol codes and fixed guidance across this trust boundary.
const ERRORS = {
  setup_required: [503, "The owner needs to enable Allow JavaScript from Apple Events in this browser and allow Reach's Terminal to control it in macOS Automation settings. In Reach: Agents → Saved tools on this Mac."],
  unavailable: [503, "The browser helper could not start or stay connected. Inspect the browser before continuing."],
  browser_changed: [409, "The browser command failed or its target changed. Inspect the browser before continuing."],
  browser_window_required: [503, "The owner needs to open a browser window in the intended profile before running this tool."],
  browser_closed: [409, "The selected browser is not running."],
  cancelled: [409, "The browser run was cancelled. Inspect any completed effects."],
  uncertain: [504, "The browser did not acknowledge this command. Inspect it before continuing."],
  result_limit: [413, "The browser result exceeds its size limit."],
  loading: [409, "The requested browser page is still loading."],
  wrong_site: [409, "The page left the tool's allowed websites."],
  protected: [403, "This browser page or field is protected."],
  stale: [409, "The selected browser document or item changed. Obtain a new handle before continuing."],
  invalid_selector: [409, "The declared selector is invalid."],
  ambiguous: [409, "More than one target matches. Inspect the page before continuing."],
  missing: [409, "The expected target is missing."],
  limit: [409, "This page reached the tool operation limit."],
  unexpected: [409, "An existing dialog or target must be resolved before continuing."],
  unsupported: [409, "The browser result or target could not be verified."],
  verification: [409, "The browser did not confirm the expected result. Inspect any completed effects."],
  disabled: [409, "The expected control is disabled."],
  invalid: [409, "The browser operation is invalid."],
  download_failed: [409, "The browser could not download this attachment."],
};
const FIXED_DETAILS = [
  "The target browser window is gone.",
  "The target tab is gone.",
  "The target tab changed. No action was taken.",
  "The target document changed. No action was taken.",
  "The new browser window has not acknowledged creation. Inspect it before continuing.",
  "The browser returned an unexpected result.",
];
const browserError = (code, uncertain = false, fallback = "unsupported") => {
  const safeCode = typeof code === "string" && Object.hasOwn(ERRORS, code) ? code : fallback;
  const [status, message] = ERRORS[safeCode];
  return Object.assign(fail(status, message), { code: safeCode, ...(uncertain ? { uncertain: true } : {}) });
};
export function nativeToolProcess(
  command,
  args,
  input,
  { timeoutMs = 12000, maxBytes = 16 * 1024 * 1024, signal } = {},
) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(browserError("cancelled", true));
      return;
    }
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const output = [],
      errors = [];
    let size = 0,
      done = false,
      stopped = null,
      force = null;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(force);
      signal?.removeEventListener("abort", abort);
      error ? reject(error) : resolve(value);
    };
    const stop = (error) => {
      if (stopped || done) return;
      stopped = error;
      child.kill("SIGTERM");
      force = setTimeout(() => child.kill("SIGKILL"), 300);
      force.unref();
    };
    const abort = () =>
      stop(
        Object.assign(
          fail(
            409,
            "The browser run was cancelled. Inspect any completed effects.",
          ),
          { code: "cancelled", uncertain: true },
        ),
      );
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () =>
        stop(
          Object.assign(
            fail(
              504,
              "The browser did not acknowledge this command. Inspect it before continuing.",
            ),
            { code: "uncertain", uncertain: true },
          ),
        ),
      timeoutMs,
    );
    child.on("error", () => {
      const error = browserError("unavailable", true);
      // A failed spawn has no process to retire. Any existing child must
      // still close before its caller can release desktop ownership.
      if (!child.pid) finish(error);
      else stop(error);
    });
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes)
        stop(browserError("result_limit", true));
      else output.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      const left = 8192 - errors.reduce((n, c) => n + c.length, 0);
      if (left > 0) errors.push(chunk.subarray(0, left));
    });
    child.on("close", (code) => {
      if (stopped) {
        finish(stopped);
        return;
      }
      const message = Buffer.concat(errors).toString().slice(0, 500);
      if (code !== 0) {
        const setup =
          /Allow JavaScript from Apple Events|JavaScript.*(disabled|turned off|not allowed|not enabled)|not authorized|not permitted|-1743\b|-1744\b/i.test(
            message,
          );
        finish(
          Object.assign(
            fail(
              setup ? 503 : 409,
              setup
                ? ERRORS.setup_required[1]
                : // Reach's own fixed words for the target it lost, never
                  // the browser's text (it can hold URLs or paths).
                  FIXED_DETAILS.find((detail) => message.includes(detail)) || ERRORS.browser_changed[1],
            ),
            { code: setup ? "setup_required" : "browser_changed" },
          ),
        );
      } else finish(null, Buffer.concat(output).toString().trim());
    });
    child.stdin.end(input);
  });
}
export function createToolBrowserDriver({
  process = nativeToolProcess,
  platform = globalThis.process.platform,
} = {}) {
  return {
    async transport(browser, request, options) {
      if (platform !== "darwin" || !fs.existsSync(script))
        throw Object.assign(
          fail(503, "Deterministic browser tools require macOS."),
          { code: "setup_required" },
        );
      let raw;
      try { raw = await process(
        "/usr/bin/osascript",
        ["-l", "JavaScript", script],
        JSON.stringify({
          browser,
          ...request,
          ...(options?.appPath ? { appPath: options.appPath } : {}),
        }),
        options,
      ); } catch (error) {
        const mapped = browserError(error?.code, error?.uncertain === true || !Object.hasOwn(ERRORS, error?.code || ""), "uncertain");
        // Keep Reach's own fixed detail (e.g. "No action was taken"), never the browser's text.
        const detail = FIXED_DETAILS.find((text) => error?.message === text);
        if (detail) mapped.message = detail;
        throw mapped;
      }
      let result;
      try {
        result = JSON.parse(raw);
      } catch {
        throw Object.assign(
          fail(503, "The browser result could not be verified."),
          { code: "uncertain", uncertain: true },
        );
      }
      if (result?.error)
        throw browserError(result.code, result.uncertain === true);
      // Download errors are nested status results, not ordinary page errors.
      // Their fetch/stream exception text is untrusted diagnostic data too.
      if (result?.state === "failed") throw browserError("download_failed");
      return result;
    },
    async page(browser, target, request, options) {
      return this.transport(
        browser,
        {
          op: "evaluate",
          target,
          expectedURL: target.url,
          source: `(${toolPageOperation.toString()})(${JSON.stringify(request)})`,
        },
        options,
      );
    },
  };
}
