# Reach extension: store listing

For the owner's Chrome Web Store and Edge Add-ons listings
(docs/parity/G-browser-tools.md). Upload `npm run build:extension`'s
`dist-extension/reach-browser-extension-<version>.zip` (the store package
leaves out the repo build's `key`; each store assigns its own id).

## Listing

- **Name:** Reach
- **Summary (132 characters max):** Runs the saved browser tools your Reach agents use, in your own browser, for the Reach app on this computer only.
- **Category:** Productivity (Chrome Web Store) / Productivity (Edge Add-ons)
- **Language:** English
- **Description:**

  Reach lets your AI agents use your own computer while you watch from your
  phone. This extension is how they run saved browser tools on Windows: a
  ready-made task (search your mail, read an order, add items to a cart)
  replayed step by step in your own Chrome or Edge, with your sign-ins, instead
  of being clicked through on screen.

  It works only with the Reach app on this computer, through Chrome's and
  Edge's native messaging. It does nothing until you allow it in Reach on your
  phone (Agents → Browser tools → Allow), and nothing that Reach didn't ask
  for after that. Every tool runs on the websites it names, never on password
  managers or bank pages, never typing into password fields, and you can stop
  it from your phone at any time.

  Requires Reach (https://github.com/nalebc/reach) running on this computer.

- **Single purpose:** Run the saved browser tools of the user's own Reach app
  on this computer, in this browser.

## Permission justifications

| Permission | Why |
|---|---|
| `nativeMessaging` | The only channel to the Reach app on this computer (host `com.reach.browser_tools`, registered by Reach for this user). Nothing else is contacted. |
| `scripting` | Runs Reach's one fixed, packaged page interpreter in the tab a saved tool works in (isolated world, top frame). No code is downloaded or evaluated; tools are data. |
| `storage` | Keeps this browser's install id and the secret it shares with Reach after the user allowed it, locally only. |
| `alarms` | Retries the connection to Reach once a minute while Reach is not running, so tools work again after Reach restarts without restarting the browser. |
| Host access `https://*/*` | Saved tools are defined by the user's agents for any public HTTPS website (shopping, mail, order history); the extension must be able to read and act in that tab. No `http:`, no other schemes, no `tabs` permission: it sees the address of HTTPS tabs only. |

- **Remote code:** No. All code is in the package; `eval` and `new Function`
  are not used.
- **Data use:** Page content a tool reads goes only to the Reach app on the same
  computer, over native messaging, and from there to the user's own agent. The
  extension sends nothing to the developer or any server. No analytics.
- **Data categories (for the disclosure form):** Website content and
  authentication state are handled locally on the user's behalf; nothing is
  collected or transmitted off the device by the extension.

## Assets

- Icons: `icons/reach-16.png`, `-32`, `-48`, `-128` (from `public/icons/reach-512.png`).
- Store tile and screenshots: still needed from the owner (1280×800 screenshot
  of Reach's Browser tools sheet on the phone beside the PC's browser).

## After publishing

Put each store's id and listing URL into `server/browser-extension-ids.mjs`
(`EXTENSION_STORES`): Reach then accepts that id, and setup's **Add** opens the
store page. Both stores' ids differ.
