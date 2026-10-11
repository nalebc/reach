#!/usr/bin/env node
const url = process.env.REACH_URL || "http://localhost:4317",
  token = process.env.REACH_TOKEN;
const u = new URL(url);
// One path segment from an id: never empty, "." or "..", which would become
// another route once the address is read (security audit L6).
const segment = (value) => {
  const text = String(value ?? "");
  if (!text || text === "." || text === ".." || /[\u0000-\u001f\u007f]/.test(text)) throw Error("Give a valid job id.");
  return encodeURIComponent(text);
};
const local = ["localhost", "127.0.0.1"].includes(u.hostname);
if (u.protocol !== "https:" && !local)
  throw Error("Remote connections require HTTPS.");
// A remote Reach is on your tailnet: the token never goes anywhere else
// (connections audit, Oct 10).
if (!local && !/\.ts\.net$/i.test(u.hostname))
  throw Error("REACH_URL must be the computer's Tailscale address, ending in .ts.net.");
if (process.argv[2] === "connect") {
  // Ask for access; the person approves it from Reach on their phone.
  const flag = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : fallback;
  };
  const name = flag("--name", "My agent");
  const scopes = flag("--scopes", "files").split(",");
  const post = await fetch(u.origin + "/api/agents/requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, scopes }),
    redirect: "error",
  });
  const ask = await post.json();
  if (!post.ok) {
    console.error(ask.error);
    process.exit(1);
  }
  console.error(
    `Waiting for approval of "${name}" (${scopes.join(", ")}) in Reach on your phone…`,
  );
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    const r = await fetch(`${u.origin}/api/agents/requests/${ask.id}/status`, {
      headers: { "X-Request-Secret": ask.secret },
      redirect: "error",
    });
    const result = await r.json();
    if (!r.ok) {
      console.error(result.error);
      process.exit(1);
    }
    if (result.status === "denied") {
      console.error("Access was denied.");
      process.exit(1);
    }
    if (result.status === "approved") {
      console.error(
        "Approved. Store this key in your agent's secret store; it is shown once.",
      );
      console.log(`REACH_TOKEN=${result.token}`);
      process.exit(0);
    }
  }
}
if (!token) {
  console.error(
    "Set REACH_TOKEN, or run: node scripts/agent.mjs connect --name MyAgent --scopes files,exec",
  );
  process.exit(1);
}
async function api(route, body, method) {
  const r = await fetch(u.origin + route, {
    method: method || (body ? "POST" : "GET"),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "error",
    signal: AbortSignal.timeout(35000),
  });
  const result = await r.json();
  if (!r.ok) throw Error(result.error);
  return result;
}
const [action, ...args] = process.argv.slice(2);
try {
  if (action === "device")
    console.log(JSON.stringify(await api("/api/device"), null, 2));
  else if (action === "files")
    console.log(
      JSON.stringify(
        await api(
          "/api/files?" +
            new URLSearchParams({
              root: process.env.REACH_ROOT || "0",
              path: args[0] || "",
            }),
        ),
        null,
        2,
      ),
    );
  else if (action === "exec") {
    if (!args[0])
      throw Error(
        'Usage: node scripts/agent.mjs exec "command" [relative-folder]',
      );
    let job = await api("/api/jobs", {
      command: args[0],
      path: args[1] || "",
      root: Number(process.env.REACH_ROOT || 0),
      timeoutMs: Number(process.env.REACH_TIMEOUT || 60000),
    });
    console.error(`Job ${job.id}`);
    process.once("SIGINT", async () => {
      await api(`/api/jobs/${segment(job.id)}`, undefined, "DELETE");
      process.exit(130);
    });
    while (job.status === "running") {
      await new Promise((r) => setTimeout(r, 500));
      job = await api(`/api/jobs/${segment(job.id)}`);
    }
    process.stdout.write(job.output);
    if (job.status !== "completed") {
      console.error(`\n${job.status}`);
      process.exit(job.exitCode || 1);
    }
  } else if (action === "jobs")
    console.log(JSON.stringify(await api("/api/jobs"), null, 2));
  else if (action === "cancel")
    console.log(
      await api(
        `/api/jobs/${segment(args[0])}`,
        undefined,
        "DELETE",
      ),
    );
  else
    console.log(
      'Reach agent CLI\n  connect --name NAME --scopes files,exec   (approve on your phone)\n  device\n  files [folder]\n  exec "command" [folder]\n  jobs\n  cancel JOB_ID\n\nEnvironment: REACH_URL, REACH_TOKEN, REACH_ROOT, REACH_TIMEOUT',
    );
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
