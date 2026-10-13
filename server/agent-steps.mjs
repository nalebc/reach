import { computerWord } from "./computer-word.mjs";

// What a command-line agent reads at its link (Oct 12: "a very small prompt
// with a link"): how to get Reach for agents and join. The link's fragment
// (the invitation, and r=, the SHA-256 of the runtime the computer named
// when it invited) never reaches the server, so the steps take both from
// the agent's own link: nothing here is secret, and nothing is from the
// request. A download that isn't exactly the runtime the link names never
// replaces the agent's (security audit M8); the link goes in on standard
// input, never as an argument other processes can list (L5).

export const YOUR_LINK = "<YOUR WHOLE LINK>";

// Node, given the link on standard input and the download: the runtime its
// r= names, or a refusal. No single quotes: it sits inside sh's.
const CHECK = [
  'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{',
  'let r="";try{r=new URLSearchParams(new URL(s.trim()).hash.slice(1)).get("r")||""}catch{}',
  'if(!/^[0-9a-f]{64}$/.test(r))throw Error("Your link names no runtime (r=). Ask for a new invitation.");',
  'if(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex")!==r)throw Error("This is not the runtime your invitation names. Ask for a new invitation.")})',
].join("");

// macOS and Linux (sh): the link once, in a shell variable.
export const stepsCommand = (start) =>
  `L='${YOUR_LINK}' && curl -fsSL --create-dirs -o ~/.reach-agent/agent.mjs.new ${start}/agent.mjs && printf '%s' "$L" | node -e '${CHECK}' ~/.reach-agent/agent.mjs.new && mv ~/.reach-agent/agent.mjs.new ~/.reach-agent/agent.mjs && printf '%s\\n' "$L" | node ~/.reach-agent/agent.mjs join`;

// Windows (PowerShell 5.1 and later ship with Windows 10 and 11): the same.
// Get-FileHash's hex is upper case; -ne doesn't mind.
export const windowsStepsCommand = (start) =>
  `$L = '${YOUR_LINK}'; [Net.ServicePointManager]::SecurityProtocol = 'Tls12'; $d = "$HOME\\.reach-agent"; New-Item -ItemType Directory -Force $d | Out-Null; Invoke-WebRequest -UseBasicParsing -Uri ${start}/agent.mjs -OutFile "$d\\agent.mjs.new"; $r = [regex]::Match($L, '[#&]r=([0-9a-f]{64})(&|$)').Groups[1].Value; if (-not $r -or (Get-FileHash "$d\\agent.mjs.new" -Algorithm SHA256).Hash -ne $r) { throw 'This is not the runtime your invitation names. Ask for a new invitation.' }; Move-Item -Force "$d\\agent.mjs.new" "$d\\agent.mjs"; $L | node "$d\\agent.mjs" join`;

// The steps, as plain text. `start`: this computer's public start page
// (https://<computer>.<tailnet>.ts.net), where its agent links point.
export function agentSteps(start, { platform = process.platform } = {}) {
  const word = computerWord(platform);
  return [
    `Reach: connect an AI agent to this ${word}`,
    "",
    `Your link starts with ${start}/agent#. The part after # is your invitation: this page never sees it. Keep the link to yourself.`,
    "",
    "You need Node.js 22 or later. Then, once:",
    "",
    `1. Run this, with your whole link in place of ${YOUR_LINK}. It downloads Reach for agents from this ${word}, checks that it is exactly the runtime your link names (its r=), puts it in place, then joins with your link.`,
    "",
    "   macOS or Linux (sh):",
    "",
    `   ${stepsCommand(start)}`,
    "",
    "   Windows (PowerShell 5.1 or later):",
    "",
    `   ${windowsStepsCommand(start)}`,
    "",
    "2. It shows a connection code. Tell the person who invited you: they approve it in Reach.",
    "",
    `3. Once approved, it prints what you may do on this ${word} and the rules, then how to add Reach's tools to your agent (MCP). Reach's tools tell you them again any time (reach_device or reach_access).`,
    "",
  ].join("\n");
}

// Whether a request wants the page rather than the steps: a browser names
// text/html. curl's */*, no Accept at all, or text/plain or text/markdown
// named as high get the text.
export function wantsPage(accept) {
  let page = 0, text = 0;
  for (const part of String(accept || "").toLowerCase().split(",")) {
    const [type, ...params] = part.split(";").map((piece) => piece.trim());
    const weight = params.find((piece) => piece.startsWith("q="));
    const q = weight ? Number(weight.slice(2)) : 1;
    if (!(q >= 0 && q <= 1)) continue;
    if (type === "text/html" || type === "application/xhtml+xml") page = Math.max(page, q);
    else if (["text/plain", "text/markdown", "text/*"].includes(type)) text = Math.max(text, q);
  }
  return page > 0 && page > text;
}

const escape = (text) =>
  text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
// The start page with the steps in it as readable text, for tools that turn
// a page into text: in the start page's own place for its first screen,
// which its script replaces for people (src/start.ts).
export function agentStepsPage(html, text) {
  const steps = `<section id="agent-steps" style="min-height:100dvh;box-sizing:border-box;padding:32px;background:#111816;color:#edf2ee;font:16px/1.5 system-ui,sans-serif"><pre style="margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace">${escape(text)}</pre></section>`;
  const main = /(<main id="start"[^>]*>)[\s\S]*?(<\/main>)/;
  if (main.test(html)) return html.replace(main, (_, open, close) => `${open}${steps}${close}`);
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, () => `${steps}</body>`) : html + steps;
}
