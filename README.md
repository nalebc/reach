<p align="center">
  <img src="public/icons/reach-192.png" width="96" height="96" alt="Reach mascot">
</p>

<h1 align="center">Reach</h1>

<p align="center">
  <strong>Your Mac, for you and your agents. Wherever you are.</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-c4ebd3?style=flat-square" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/macOS-primary-c4ebd3?style=flat-square&logo=apple&logoColor=white" alt="macOS">
  <img src="https://img.shields.io/badge/node-%E2%89%A522-c4ebd3?style=flat-square&logo=node.js&logoColor=white" alt="Node 22 or newer">
  <img src="https://img.shields.io/badge/network-Tailscale-c4ebd3?style=flat-square&logo=tailscale&logoColor=white" alt="Runs on Tailscale">
  <img src="https://img.shields.io/badge/agents-CLI%20%2B%20MCP-c4ebd3?style=flat-square" alt="CLI and MCP">
</p>

<p align="center">
  <a href="#give-agents-control-of-your-mac-with-cli-and-mcp">Agents: CLI &amp; MCP</a> ·
  <a href="#control-your-mac-from-your-phone">Control your Mac</a> ·
  <a href="#move-chats-between-claude-and-codex">Move chats</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#security">Security</a> ·
  <a href="docs/GUIDE.md">Full guide</a>
</p>

Give AI agents control of your **Mac apps, browser, files and terminals through CLI tools and MCP**. You choose what they can do, with scoped access secured by Tailscale.

Bring **Claude, Codex, Grok, Muse, Dots or another agent**. Connect through Reach's CLI, MCP or its browser interface, depending on what your agent supports.

Control the same Mac from your phone with a sharp picture and smooth, real-time control at up to **60 fps**. Reply to your coding agents and **move chats between Claude Code and Codex with their history**. Free and open source, running on your Mac.

<p align="center">
  <a href="docs/media/reach-demo.mp4"><img src="docs/media/reach-demo.gif" alt="Reach on a phone: live screen, inviting an agent over MCP, approving it, chats and files" width="760"></a>
  <br>
  <sub>Interface tour with sample data. <a href="docs/media/reach-demo.mp4">Watch the MP4</a>.</sub>
</p>

## Highlights

- **CLI tools and MCP to control your Mac.** Agents can open native apps, switch windows, click, type and use menus. Grant Full control or limit access to selected apps, folders or read-only actions.
- **Smooth control from your phone.** High-quality screen sharing at up to 60 fps, with touch, trackpad, zoom and your phone's keyboard.
- **Chats that move with you.** Continue a Claude Code chat in Codex or the other way around. Read and reply to chats, send files and answer approvals from your phone.
- **Secure connections through Tailscale.** Use your private tailnet or an authenticated Funnel link. Reach's agent client automatically switches to the private route when it becomes reachable.
- **Files and terminals, wherever you are.** Browse, share and upload files, run commands, and return to your Mac's open terminals.

## Give agents control of your Mac with CLI and MCP

Your agent can work on your actual laptop: native Mac apps, your signed-in browser, files and shell. Use the tools directly from the command line or through MCP, with the same permissions. Every tool call is checked against the access you grant, which you can pause or revoke from your phone.

1. On your phone, tap **Invite** on Home and choose **An agent**. Name it, pick a preset and how long it gets, keep **Connects: Tools**, then tap **Copy invite**.
2. Paste the invite into the agent. It runs one command in its terminal, on any computer with Node.js 22+.
3. Match the code it shows with the one on your phone under **Needs you**, and approve.

Once approved, the agent can list and call tools from the CLI; the join command also prints its MCP setup instructions. Ask it to open an app and fill a form, find a document, or run a project's tests. See the [agent setup guide](docs/AGENTS.md) and [full tool reference](docs/BROWSER_AGENT_TOOLS.md).

Each agent gets one **preset**:

| Preset           | The agent can                                            |
| ---------------- | -------------------------------------------------------- |
| **Full control** | Use the screen, apps, browser, files and a shell, as you |
| **Apps**         | See and use only the apps you pick                       |
| **Files**        | Read, or read and edit, only the folders you pick        |
| **Read only**    | Watch the screen and read shared files                   |

### Private tailnet or public Funnel

Agents with Tailscale support, including **Muse**, can join your private tailnet. Agents outside it can connect through an authenticated **Tailscale Funnel** link.

Reach's agent client prefers the private connection. If it starts over Funnel and later joins your tailnet, it automatically switches to the private route when detected, keeping the same permissions and MCP setup. Hosted MCP connectors use the URL configured in their service.

For an agent working through a browser, choose **Connects: Web page**: it gets your live screen and permitted controls in a page. For a service that takes a hosted MCP connector (claude.ai, ChatGPT), choose **Connects: Hosted** and add the URL it gives you (new, still being tested). See [agents](docs/AGENTS.md) and the [tool reference](docs/BROWSER_AGENT_TOOLS.md).

## Control your Mac from your phone

Open Reach in your phone's browser for high-quality screen sharing and smooth, real-time control at up to **60 fps**, secured by Tailscale. Click, drag, zoom, switch displays and type with your phone's keyboard. Reach adjusts to your connection to keep control responsive.

No phone app or Reach account needed. Use Tailscale on your phone or connect through Reach's browser sign-in.

## Move chats between Claude and Codex

Start a conversation in Claude Code, then hand it to Codex to continue—or move it back. Reach carries the conversation history into the destination chat so the next agent can pick up the work. For long chats, recent messages are preserved and older history is condensed to fit.

From your phone, read and reply to Claude Code, Codex and OpenClaw chats, send files, and answer Claude and Codex approval requests. Keep the conversation moving alongside your Mac's apps, live screen and terminals. Install and sign in to each coding agent on your Mac first.

## Quick start

### Install the CLI

Reach includes a `reach` command for use from any terminal. The npm package is **not published yet**; once the first release is available, install it with [Node.js 22 or newer](https://nodejs.org/) and run:

```sh
npm install --global @nalebc/reach
reach
```

The npm package includes the built phone interface and browser connection, so you won't need to clone the repository or install Go. `reach` walks you through setup; `reach update` installs later releases.

### Run from source (available now)

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

Already using a source checkout? Run `./reach cli` once to make `reach`, `reach status` and the other commands work from any terminal. Keep the checkout: this command links to it.

On macOS, allow **Screen Recording** and **Accessibility** when asked so Reach can show and control the screen. Linux, Windows and npm installs are covered in the [full guide](docs/GUIDE.md#install).

## Security

- **You control who connects.** Reach supports device approval and temporary pairing codes. The normal connection QR contains only an address; pairing QRs include a one-use code. Optional passkey sign-in is implemented, but Face ID on a real iPhone still needs testing.
- **Agents start with nothing.** You match a code to let one in. Its preset and end time are checked on every request, and you can pause or stop it from your phone. When you use the Mac yourself, agent input pauses.
- **Guardrails** keep agents' clicks and typing away from Reach and Tailscale, password managers and password fields, `sudo` and security prompts, and System Settings' security panes.
- **Full control is your account, not a sandbox.** Its shell runs as you. Give it only to agents you trust, and use **Apps** or **Files** for everything else.

Read the [security model](docs/SECURITY.md). To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Platforms

| Host        | Status                                                                             |
| ----------- | ---------------------------------------------------------------------------------- |
| **macOS**   | Primary: screen, control, files, terminals, chats, agents                          |
| **Linux**   | Files, terminals and command-line agents; no screen or agent presets               |
| **Windows** | Experimental: guided setup, pairing code, files and terminals; no invite links yet |
| **Phone**   | Safari on iPhone, Chrome on Android. No app needed                                 |

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
