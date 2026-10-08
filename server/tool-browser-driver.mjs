import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fail } from "./core.mjs";
import { toolPageOperation } from "./tool-page-runtime.mjs";

const script = fileURLToPath(
  new URL("../scripts/native/tool-browser.js", import.meta.url),
);
export function nativeToolProcess(
  command,
  args,
  input,
  { timeoutMs = 12000, maxBytes = 16 * 1024 * 1024, signal } = {},
) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
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
    child.on("error", () =>
      finish(
        Object.assign(
          fail(
            503,
            "The browser helper could not start. The owner should check Reach’s browser setup.",
          ),
          { code: "setup_required" },
        ),
      ),
    );
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes)
        stop(fail(413, "The browser result exceeds its size limit."));
      else output.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (errors.reduce((n, c) => n + c.length, 0) < 8192) errors.push(chunk);
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
                ? "The owner needs to enable Allow JavaScript from Apple Events in this browser and allow Reach’s Terminal to control it in macOS Automation settings."
                : [
                    "The target browser window is gone.",
                    "The target tab is gone.",
                    "The target tab changed. No action was taken.",
                    "The target document changed. No action was taken.",
                    "The new browser window has not acknowledged creation. Inspect it before continuing.",
                    "The browser returned an unexpected result.",
                  ].find((detail) => message.includes(detail)) ||
                    "The browser command failed. Check browser setup with the owner, or continue in Screen.",
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
      const raw = await process(
        "/usr/bin/osascript",
        ["-l", "JavaScript", script],
        JSON.stringify({
          browser,
          ...request,
          ...(options?.appPath ? { appPath: options.appPath } : {}),
        }),
        options,
      );
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
        throw Object.assign(
          fail(result.code === "setup_required" ? 503 : 409, result.error),
          {
            code: result.code,
            uncertain: result.uncertain === true,
          },
        );
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
