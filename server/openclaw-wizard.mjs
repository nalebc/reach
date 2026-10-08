// Render OpenClaw's own questions in Reach. Answers are never commands.
import { scrubLine } from "./openclaw-health.mjs";
const fail = (status, message) => Object.assign(new Error(message), { status });
const types = new Set(["note", "select", "multiselect", "confirm", "text"]);
const clean = (value) =>
  typeof value === "string"
    ? value.split("\n").slice(0, 80).map(scrubLine).join("\n")
    : "";

export function routes(app, client, { base, authorize }) {
  let sessionId = null,
    step = null,
    busy = false,
    status = "idle",
    problem = "";
  const supported = () =>
    ["wizard.start", "wizard.next", "wizard.cancel"].every((m) =>
      client.can(m),
    );
  const view = () => ({
    supported: supported(),
    busy,
    status,
    problem,
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
    status = result.done ? result.status || "done" : "running";
    problem = result.error
      ? "OpenClaw stopped this setup. Earlier changes may already be saved."
      : "";
    if (step && (!types.has(step.type) || step.executor === "gateway")) {
      problem =
        "This OpenClaw step isn't supported in Reach yet. You can cancel setup here.";
      step = null;
    }
    if (result.done) sessionId = null;
  };
  const run = (method, params, current) => {
    busy = true;
    problem = "";
    Promise.resolve()
      .then(() => {
        current();
        return client.call(method, params, current, 180000);
      })
      .then(accept)
      .catch(() => {
        step = null;
        status = "uncertain";
        problem =
          "The connection was interrupted. Check setup status before continuing; your last choice may already have been applied.";
      })
      .finally(() => {
        busy = false;
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
    if (busy || sessionId || status === "uncertain")
      throw fail(
        409,
        "A setup may already be running. Check its status first.",
      );
    status = "running";
    run("wizard.start", { mode: "local" }, current);
    res.json(view());
  });
  app.post(`${base}/wizard/answer`, (req, res) => {
    const current = authorize(req);
    current();
    if (busy || !sessionId || !step || req.body?.stepId !== step.id)
      throw fail(409, "This question has changed. Refresh setup.");
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
        "Wait for OpenClaw to finish this step before cancelling.",
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
        "OpenClaw didn't confirm cancellation. Check setup status.",
      );
    } finally {
      busy = false;
    }
    res.json(view());
  });
}
