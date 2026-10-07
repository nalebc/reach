# OpenClaw conversations in Reach

Reach connects to the OpenClaw Gateway running on the same computer. Gateway credentials remain on the computer. These routes require a full-access owner device; guest and agent credentials cannot use them.

## Where replies go

- **Reply in Reach** continues the selected OpenClaw conversation. The prompt and answer appear in its history, including OpenClaw's own interface. Reach does not request forwarding to WhatsApp, Discord, or another channel.
- **Reach + WhatsApp** (or another channel) asks OpenClaw to deliver the **agent's answer** to that session's existing channel destination too. It does not post your typed prompt to WhatsApp. Changing the selector affects the next message, not a reply already generated.

The computer derives the destination, account and thread from OpenClaw's session metadata, checks channel health, then uses the Gateway's `agent` method with an explicit reply route and strict delivery. The phone cannot override a recipient. Reach does not silently fall back to a different channel or send the answer itself.

## Working, delivery and failures

Reach follows both chat events and agent lifecycle events. It reconciles missed completion events with the read-only `agent.wait` method. Reconnecting never resends a message. Repeated taps share a request ID, and conflicting reuse of that ID is rejected.

Generation and channel delivery are separate. `agent` can acknowledge a request, then return a second response with the same RPC ID after execution/delivery. Reach handles both. Only an explicit delivery receipt produces **sent**. Older Gateways without receipts show **delivery unconfirmed**; check the channel before retrying. This is not a WhatsApp read receipt.

If completion cannot be confirmed, Reach replaces the spinner with an explanation, keeps sending blocked for that run, and provides Refresh. A failed channel check leaves the draft intact. Reach does not automatically retry a message with an uncertain outcome.

OpenClaw 2026.3.13 exposes `chat.abort` for chat sends, but it does not provide the same cancellation contract for channel-delivering `agent` calls. Reach therefore does not advertise a working Stop button for that path. Use OpenClaw on the computer to manage the run. A stop request on the chat path must be acknowledged before Reach claims it stopped.

Runtime tracking and duplicate-request protection last for the companion process. A companion restart does not replay messages, but cannot recover every prior in-flight run or delivery receipt; inspect OpenClaw's history before manually resending an uncertain message.

## Validation

`node --test test/openclaw.test.mjs test/openclaw-ui.test.mjs` covers routing, account/thread selection, channel health, two-stage responses, missing completion events, reconnect, duplicate submissions, unsupported response shapes, owner-only access, and visible delivery failures. Tests use a fake Gateway and do not send external messages.

The installed 2026.3.13 Gateway was checked read-only for protocol capabilities, session metadata and channel connection health. A real external-send acceptance test still requires an explicitly chosen recipient and message. Never use a family/group conversation as an automatic test target.

Protocol references: [Gateway API](https://docs.openclaw.ai/gateway/protocol), [agent delivery](https://docs.openclaw.ai/gateway/protocol/operator-methods), [agent send](https://docs.openclaw.ai/agent-send). Future Gateway changes can still require adapter updates.
