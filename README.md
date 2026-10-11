<p align="center">
  <img src="public/icons/reach-192.png" width="96" height="96" alt="Reach mascot">
</p>

<h1 align="center">Reach</h1>

<p align="center">
  <strong>Your Mac, from your phone. And for your agents.</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-c4ebd3?style=flat-square" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/macOS-primary-c4ebd3?style=flat-square&logo=apple&logoColor=white" alt="macOS">
  <img src="https://img.shields.io/badge/node-%E2%89%A522-c4ebd3?style=flat-square&logo=node.js&logoColor=white" alt="Node 22 or newer">
  <img src="https://img.shields.io/badge/network-Tailscale-c4ebd3?style=flat-square&logo=tailscale&logoColor=white" alt="Runs on Tailscale">
  <img src="https://img.shields.io/badge/agents-MCP-c4ebd3?style=flat-square" alt="MCP">
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#give-an-agent-your-mac-over-mcp">Agents over MCP</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#security">Security</a> ·
  <a href="docs/GUIDE.md">Full guide</a>
</p>

Reach runs on your Mac and puts the whole computer in your pocket: its live screen, its files, its terminals and your Codex and Claude chats. Invite an AI agent and it gets the same Mac as a set of MCP tools, browser included. Everything travels over your own Tailscale network. There's no Reach account, no hosted backend and nothing to install on your phone.

<p align="center">
  <a href="docs/media/reach-demo.mp4"><img src="docs/media/reach-demo.gif" alt="Reach on a phone: live screen, inviting an agent over MCP, approving it, chats and files" width="760"></a>
  <br>
  <sub>Interface tour with sample data. <a href="docs/media/reach-demo.mp4">Watch the MP4</a>.</sub>
</p>

## Highlights

- **Full control of your Mac, in real time.** Hardware H.264 (ScreenCaptureKit + VideoToolbox) at up to 60 fps, with touch, trackpad, pinch-zoom and your phone's keyboard. With the Tailscale app, the stream goes straight from Mac to phone over WireGuard, with no Reach server in between.
- **Agents drive your browser over MCP.** Invite Claude Code, Codex or any MCP client with one command. It uses your real Chrome or Safari, already signed in: it opens a page, reads the screen as text, presses buttons by name, fills a form in one call and waits for the result.
- **Fast for agents too.** Agents read the screen as text instead of uploading screenshots, send up to 10 actions per call and get the new screen in the same reply.
- **Private by default, thanks to Tailscale.** Your devices reach Reach at a private `*.ts.net` address. No Tailscale app on the phone? The start page runs Tailscale inside the browser.
- **Your coding agents in your pocket.** Read and reply to Codex, Claude Code and OpenClaw chats, and answer Codex and Claude approvals, from the phone.
- **Files and terminals.** Browse, preview, share and upload files. Open real shells, or pick up the Terminal and iTerm2 tabs already open on the Mac.
- **Invite, approve, done.** Give a person or an agent a link with a time limit. Approve it on your phone, and end it from there whenever you want.

## Quick start

You need a Mac and [Tailscale](https://tailscale.com/download). `./reach` installs its own Node.js if yours is older than 22. [Go](https://go.dev/dl/) is optional: it builds the in-browser Tailscale client, so phones don't need the Tailscale app.

```sh
git clone https://github.com/nalebc/reach.git
cd reach
./reach
```

The first run walks you through Tailscale, the HTTPS link and optional background mode. Scan the QR code with your phone, tap **Connect**, and approve the phone in the Mac's terminal. That's it.

No Tailscale app on the phone? Then the link only opens while pairing: for 15 minutes after each start, or after `./reach pair`. The rest of the time it shows "Not found".

```sh
./reach status    # where Reach runs, and its link
./reach restart   # stop it and start it again
./reach stop      # stop it
./reach pair      # open pairing again, for another phone
./reach setup     # change setup choices
```

On macOS, allow **Screen Recording** and **Accessibility** when asked so Reach can show and control the screen. Linux, Windows and npm installs are covered in the [full guide](docs/GUIDE.md#install).

## Give an agent your Mac over MCP

1. On your phone, tap **Invite** on Home and choose **An agent**. Name it, pick a preset and how long it gets, keep **Connects: Tools**, then tap **Copy invite**.
2. Paste the invite into the agent. It runs one command in its terminal, on any computer with Node.js 22+.
3. Match the code it shows with the one on your phone under **Needs you**, and approve.

The agent's terminal then prints:

```text
Connected to Home Mac (through the owner's tailnet; its public link when that's away).
Access: …, until ….

Add it to your agent (once):
  Claude Code:  claude mcp add --scope user reach -- node ~/.reach-agent/agent.mjs mcp
  Codex:        codex mcp add reach -- node ~/.reach-agent/agent.mjs mcp
  Gemini CLI:   gemini mcp add -s user reach node ~/.reach-agent/agent.mjs mcp
  Claude Desktop, Cursor, Windsurf, VS Code, any other: paste the JSON from  node ~/.reach-agent/agent.mjs config
```

Now just ask, for example: _"Open Gmail in Chrome and find my last Walmart receipt."_ With **Full control** or **Apps**, the agent gets tools like these:

| Tool                    | What it does                                                          |
| ----------------------- | --------------------------------------------------------------------- |
| `reach_open_url`        | Opens a page in your own browser, with your sign-ins and cookies      |
| `reach_describe_screen` | The front window as text: every button, link and field, numbered      |
| `reach_press`           | Presses a button, link, tab or menu item by its name                  |
| `reach_fill`            | Fills a form's fields by their labels, in one call                    |
| `reach_wait_for`        | Waits until some text or a control appears, then returns the screen   |
| `reach_act`             | Clicks, types, keys, scrolls, pastes and presses menu items, up to 10 actions per call |
| `reach_find`            | Finds text or a control anywhere in the window and scrolls it into view |
| `reach_windows`, `reach_focus_window` | Every open window and tab, and bringing the right one forward |
| `reach_menus`           | The menu bar with its keyboard shortcuts; items press without the pointer |
| `reach_read_page`       | The whole page, email or document as text, in pages                   |
| `reach_open_file`       | Opens a shared file in its app, or shows it in the Finder             |
| `reach_run_mac_shortcut` | Runs a Shortcuts-app shortcut you switched on for agents             |
| `reach_screenshot`      | A picture of the screen, when text isn't enough                       |
| `reach_tools`           | Saved browser tools (Gmail, Walmart, your own) that replay on the Mac |

Each agent gets one **preset**:

| Preset           | The agent can                                            |
| ---------------- | -------------------------------------------------------- |
| **Full control** | Use the screen, apps, browser, files and a shell, as you |
| **Apps**         | See and use only the apps you pick                       |
| **Files**        | Read, or read and edit, only the folders you pick        |
| **Read only**    | Watch the screen and read shared files                   |

For an agent that only has a browser (ChatGPT agent, Muse, a Grok bot), choose **Connects: Web page** instead: it gets your live screen in a page. For a hosted agent that takes a custom MCP connector (claude.ai, ChatGPT), choose **Connects: Hosted** and add the URL it gives you (new, still being tested). See [agents](docs/AGENTS.md) and the [tool reference](docs/BROWSER_AGENT_TOOLS.md).

## How it works

```text
  Your phone (any browser)                          Your Mac
 ┌────────────────────────┐                      ┌────────────────────────────┐
 │ Reach web app          │◀── private :8443 ──▶ │ Reach (Node)               │
 │ (Tailscale app, or     │    Tailscale Serve   │  screen  ScreenCaptureKit  │
 │  Tailscale in the page)│                      │          → VideoToolbox    │
 └────────────────────────┘                      │  files · shells · chats    │
                                                 │  MCP tools for agents      │
  An AI agent (anywhere)                         │                            │
 ┌────────────────────────┐   your tailnet, or   │                            │
 │ Claude Code / Codex    │◀── public :443 ────▶ │                            │
 │ + Reach MCP server     │    while invited     └────────────────────────────┘
 └────────────────────────┘
```

- **Your devices** reach Reach through [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) on a private address only your tailnet can see. TLS ends on your Mac.
- **A phone without the Tailscale app** signs in to Tailscale from the start page and joins your tailnet inside the browser (Tailscale compiled to WebAssembly).
- **Agents** use your tailnet when they can. Otherwise they come through [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) on port 443, which Reach answers only while an invite, an agent session or a pairing window is open. Each agent request is signed with that agent's own key, and owner APIs are never reachable from the internet. Everything else gets "Not found".
- **Nothing in the cloud is Reach's.** Tailscale provides the network; everything else runs on your Mac.

## Security

- **Every new device needs your approval**, on the Mac or with Face ID once you've set it up. The QR code holds only an address, never a credential.
- **Agents start with nothing.** You match a code to let one in. Its preset and end time are checked on every request, and you can pause or stop it from your phone. When you use the Mac yourself, agent input pauses.
- **Guardrails** keep agents' clicks and typing away from Reach and Tailscale, password managers and password fields, `sudo` and security prompts, and System Settings' security panes.
- **Full control is your account, not a sandbox.** Its shell runs as you. Give it only to agents you trust, and use **Apps** or **Files** for everything else.

Read the [security model](docs/SECURITY.md). To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Platforms

| Host        | Status                                                               |
| ----------- | -------------------------------------------------------------------- |
| **macOS**   | Primary: screen, control, files, terminals, chats, agents            |
| **Linux**   | Files, terminals and command-line agents; no screen or agent presets |
| **Windows** | Experimental: guided setup, pairing code, files and terminals; no invite links yet |
| **Phone**   | Safari on iPhone, Chrome on Android. No app needed                   |

## Docs

- [Full guide](docs/GUIDE.md): install options, pairing, background mode, configuration, limits
- [Remote desktop](docs/REMOTE_DESKTOP.md): gestures, video and performance
- [Agents](docs/AGENTS.md) and [browser-agent tools](docs/BROWSER_AGENT_TOOLS.md): presets, MCP setup, every tool
- [Agent CLI](docs/AGENT_CLI.md): short-lived access for cloud agents
- [HTTP API](docs/API.md) · [Security model](docs/SECURITY.md)

## Status

Early access (0.1.0). macOS comes first, and testing on physical phones is still in progress. Install from source until the npm package is published.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first. Run tests with `npm test`, or `npm run test:file -- test/x.test.mjs` for one file.

## License

[MIT](LICENSE)
