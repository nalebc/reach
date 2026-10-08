// A UI fixture with sample data only: a workflow's page at each stage, the
// Workflows page (and with none yet) and New chat on Workflow. Nothing
// reaches a computer.
import React from "react";
import { createRoot } from "react-dom/client";
import { WorkflowSheet, WorkflowsPage, type Workflow, type WorkflowTask } from "../../src/Workflows";
import { NewChat } from "../../src/EverythingChat";
import ChatSheet from "../../src/ChatSheet";
import { ChatLibraryHeader } from "../../src/ChatList";
import "../../src/styles.css";
import "../../src/atmosphere.css";
import "../../src/workspace.css";
import "../../src/app-style.css";
import "../../src/chat-list.css";
import "../../src/chat-hub.css";

const peer = { id: "preview", name: "Home Mac", url: location.origin, token: "sample-only", platform: "darwin" };
const view = new URLSearchParams(location.search).get("view") || "draft";
const t = (id: string, extra: Partial<WorkflowTask>): WorkflowTask => ({ id, title: "", agent: "codex", kind: "build", together: false, task: "", state: "waiting", ...extra });
const planned = [
  t("t1", { title: "Build passkey sign-in", task: "Add WebAuthn sign-in to src/auth with a register and a sign-in route. Keep password sign-in working." }),
  t("t2", { title: "Review the sign-in", agent: "claude", kind: "review", task: "Check src/auth for replay and origin checks." }),
  t("t3", { title: "Write the docs", together: true, task: "Document passkey sign-in in docs/AUTH.md." }),
  t("t4", { title: "Fix what the review found", task: "Address the review's findings." }),
];
const base = { id: "wf", title: "Passkey sign-in", cwd: "/Users/you/code/reach", problem: "", createdAt: 1, updatedAt: 1 };
const samples: Record<string, Workflow> = {
  draft: { ...base, state: "draft", planner: { agent: "codex", id: "p", title: "Plan", working: false }, tasks: planned },
  planning: { ...base, state: "draft", title: "Add passkey sign-in", planner: { agent: "codex", id: "p", title: "Plan", working: true }, tasks: [] },
  empty: { ...base, state: "draft", title: "Pagination", tasks: [] },
  running: {
    ...base,
    state: "running",
    tasks: planned.map((x, i) => ({
      ...x,
      state: (["done", "working", "done", "waiting"] as const)[i],
      ...(i === 0 ? { summary: "Added register and sign-in routes with WebAuthn, and tests for both.", files: ["src/auth/passkeys.ts", "src/auth/routes.ts", "test/passkeys.test.ts"] } : {}),
      ...(i < 3 ? { chat: { agent: x.agent, id: `c${i}` } } : {}),
    })),
  },
  paused: {
    ...base,
    state: "paused",
    problem: "“Review the sign-in”: Claude Code ran out of usage.",
    tasks: planned.map((x, i) => ({
      ...x,
      state: (["done", "stopped", "done", "waiting"] as const)[i],
      ...(i === 1 ? { problem: "Claude Code ran out of usage." } : {}),
      ...(i < 3 ? { chat: { agent: x.agent, id: `c${i}` } } : {}),
    })),
  },
};
const sample = samples[view] || samples.draft;
window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
  if (url.pathname.startsWith("/api/sessions/workflows/")) return Response.json(init.method === "POST" ? { workflow: sample } : { ...sample, version: "v1" });
  if (url.pathname === "/api/sessions/models") return Response.json({ models: [], modes: [], mode: null });
  return Response.json({});
};
const noop = () => {};
function Preview() {
  if (view === "header")
    return (
      <div className="chat-library" style={{ padding: "0 16px" }}>
        <ChatLibraryHeader
          peer={peer}
          apps={[{ agent: "all", name: "All", supported: true }]}
          value="all"
          logos={{}}
          onChange={noop}
          onNew={noop}
          onRefresh={noop}
          searchOpen={false}
          onSearch={noop}
          workflows={{ active: 2, paused: 1, onOpen: noop }}
        />
      </div>
    );
  if (view === "list" || view === "none")
    return (
      <WorkflowsPage
        workflows={
          view === "none"
            ? []
            : [{ ...samples.paused, id: "a" }, { ...samples.running, id: "b", title: "Pagination for /api/items" }, { ...samples.draft, id: "c", title: "Dark mode", tasks: planned.slice(0, 2) }]
        }
        logos={{}}
        onOpen={noop}
        onNew={noop}
        onClose={noop}
      />
    );
  if (view === "new")
    return (
      <ChatSheet title="New conversation" className="chat-create-sheet" onClose={noop}>
        <NewChat peer={peer} agent="codex" sessions={[]} folder="/Users/you/code/reach" onStarted={noop} onWorkflow={noop} startAs="workflow" health={[]} logos={{}} />
      </ChatSheet>
    );
  return <WorkflowSheet peer={peer} id="wf" initial={sample} logos={{}} onOpenChat={noop} onClose={noop} />;
}
createRoot(document.getElementById("root")!).render(<Preview />);
