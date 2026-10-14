// Render OpenClaw's own questions in Reach. Answers are never commands.
import { scrubLine } from "./openclaw-health.mjs";
const fail = (status, message) => Object.assign(new Error(message), { status });
const types = new Set(["note", "select", "multiselect", "confirm", "text"]);
// Each line scrubbed on its own. Never .map(scrubLine): map's index became
// each line's length cap, so line 2 kept one letter and every one-line text
// (titles, option labels) came back empty (Oct 13).
const clean = (value) =>
  typeof value === "string"
    ? value.split("\n").slice(0, 80).map((line) => scrubLine(line)).join("\n")
    : "";
// The options OpenClaw would start on, by index: a default's value never
// leaves the host (it can be a credential), only where it is in the list.
const same = (a, b) => {
  if (Object.is(a, b)) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
};
const preset = (step) => {
  const options = step.options || [];
  const at = (value) => options.findIndex((o) => same(o.value, value));
  if (step.type === "select") {
    const index = at(step.initialValue);
    return index >= 0 ? [index] : [];
  }
  if (step.type === "multiselect" && Array.isArray(step.initialValue))
    return [...new Set(step.initialValue.map(at).filter((index) => index >= 0))];
  return [];
};
// A sign-in by code (GitHub's device login): its page, to open on the phone.
// Only then: a browser sign-in elsewhere returns to the computer itself.
const signInPage = (step) => {
  if (!step.deviceCode || typeof step.externalUrl !== "string" || step.externalUrl.length > 2048) return "";
  try {
    const url = new URL(step.externalUrl);
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
};
// OpenClaw's own progress (Installing Gateway service…) asks nothing.
const isProgress = (result) => !result.done && result.step?.type === "progress";
const PROGRESS_STEPS = 500;
// One wait for OpenClaw's next step that ran out (a long install): asked
// again, as asking without an answer changes nothing.
const SLOW_WAITS = 20;

export function routes(app, client, { base, authorize }) {
  let sessionId = null,
    step = null,
    busy = false,
    status = "idle",
    problem = "",
    progress = null;
  const supported = () =>
    ["wizard.start", "wizard.next", "wizard.cancel"].every((m) =>
      client.can(m),
    );
  const view = () => ({
    supported: supported(),
    busy,
    status,
    problem,
    progress,
    step: step
      ? {
          id: step.id,
          type: step.type,
          title: clean(step.title),
          message: clean(step.message),
          // Raw option values stay on the host. The UI submits indexes only.
          options: (step.options || []).map((o, index) => ({
            index,
            label: clean(o.label),
            hint: clean(o.hint),
          })),
          selected: preset(step),
          // Text defaults may be credentials, including in older OpenClaw versions
          // which don't mark them sensitive. Never send them back to the phone.
          sensitive:
            step.sensitive === true ||
            /key|token|secret|password|credential/i.test(step.message || ""),
          placeholder: clean(step.placeholder),
        }
      : null,
  });
  const accept = (result) => {
    if (result.sessionId) sessionId = result.sessionId;
    step = result.done ? null : result.step || null;
    // Done only when OpenClaw says so, without an error: an error, or a
    // status Reach doesn't know, is never shown as success.
    status = !result.done ? "running"
      : result.error ? "error"
        : ["done", "cancelled", "error"].includes(result.status || "done") ? result.status || "done"
          : "error";
    // Still running with an error: OpenClaw refused the answer (an API key
    // in the wrong shape) and asks the same question again. Its own words.
    problem = !result.error ? ""
      : result.done ? "OpenClaw stopped this setup. Earlier changes may already be saved."
        : clean(result.error).split("\n")[0] || "OpenClaw didn't accept that answer. Try again.";
    if (step && (!types.has(step.type) || step.executor === "gateway")) {
      problem =
        "This OpenClaw step isn't supported in Reach yet. Stop the setup here and finish it on your computer.";
      step = null;
    }
    if (result.done) sessionId = null;
  };
  const run = (method, params, current) => {
    busy = true;
    problem = "";
    progress = null;
    Promise.resolve()
      .then(async () => {
        current();
        let result = await client.call(method, params, current, 180000);
        // Shown while Reach asks for what comes next, in this same run (busy
        // until a question or the end arrives).
        for (let shown = 0; isProgress(result); shown++) {
          if (shown >= PROGRESS_STEPS) throw new Error("Too many progress steps.");
          if (result.sessionId) sessionId = result.sessionId;
          progress = {
            title: clean(result.step.title).split("\n")[0],
            message: clean(result.step.message),
            code: typeof result.step.deviceCode?.code === "string" ? scrubLine(result.step.deviceCode.code, 40) : "",
            link: signInPage(result.step),
          };
          for (let waits = 1; ; waits++) {
            current();
            try {
              result = await client.call("wizard.next", { sessionId }, current, 180000);
              break;
            } catch (error) {
              if (error?.status !== 504 || waits >= SLOW_WAITS) throw error;
            }
          }
        }
        accept(result);
      })
      .catch(() => {
        step = null;
        status = "uncertain";
        problem =
          "The connection was interrupted. Your last choice may already be saved: check again before answering.";
      })
      .finally(() => {
        busy = false;
        progress = null;
      });
  };
  app.get(`${base}/wizard`, (_req, res) => res.json(view()));
  app.post(`${base}/wizard/start`, (req, res) => {
    const current = authorize(req);
    current();
    if (!supported())
      throw fail(
        409,
        "This OpenClaw version doesn't offer guided setup in Reach.",
      );
    // A start that failed before any session existed has nothing to recover.
    if (busy || sessionId)
      throw fail(
        409,
        "A setup may already be running. Check again in a moment.",
      );
    status = "running";
    run("wizard.start", { mode: "local" }, current);
    res.json(view());
  });
  app.post(`${base}/wizard/answer`, (req, res) => {
    const current = authorize(req);
    current();
    if (busy || !sessionId || !step || req.body?.stepId !== step.id)
      throw fail(409, "This question has changed. Check again.");
    let value = req.body?.value;
    const option = (index) => {
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= (step.options || []).length
      )
        throw fail(400, "Choose an offered option.");
      return step.options[index].value;
    };
    if (step.type === "select") value = option(value);
    else if (step.type === "multiselect") {
      if (!Array.isArray(value) || new Set(value).size !== value.length)
        throw fail(400, "Choose the options to use.");
      value = value.map(option);
    } else if (step.type === "confirm") {
      if (typeof value !== "boolean") throw fail(400, "Choose Yes or No.");
    } else if (step.type === "text") {
      if (
        typeof value !== "string" ||
        value.length > 16384 ||
        value.includes("\0")
      )
        throw fail(400, "Enter a valid answer.");
    } else value = null;
    const stepId = step.id;
    step = null;
    run("wizard.next", { sessionId, answer: { stepId, value } }, current);
    res.json(view());
  });
  app.post(`${base}/wizard/refresh`, (req, res) => {
    const current = authorize(req);
    current();
    if (busy) return res.json(view());
    if (!sessionId)
      throw fail(
        409,
        "Reach couldn't recover this setup session. Check OpenClaw's connection before starting another setup.",
      );
    // No answer: recover the pending question without repeating an action.
    run("wizard.next", { sessionId }, current);
    res.json(view());
  });
  app.post(`${base}/wizard/cancel`, async (req, res) => {
    const current = authorize(req);
    current();
    if (busy)
      throw fail(
        409,
        "Wait for OpenClaw to finish this step before stopping.",
      );
    if (!sessionId) throw fail(409, "No recoverable setup session.");
    busy = true;
    try {
      await client.call("wizard.cancel", { sessionId }, current);
      sessionId = null;
      step = null;
      status = "cancelled";
      problem = "";
    } catch {
      throw fail(
        409,
        "OpenClaw didn't confirm it stopped. Check again.",
      );
    } finally {
      busy = false;
    }
    res.json(view());
  });
}
