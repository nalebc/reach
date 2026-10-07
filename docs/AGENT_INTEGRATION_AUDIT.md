# Agent integration audit — 2026-10-05

## Conclusion

The chat adapters needed more than a UI fix. Reach had unsafe assumptions about delivery acknowledgements, lifecycle events and approval responses. The fixes in this audit are applied to the working checkout. They have not been deployed to the separately running Reach service.

**Release remains blocked by the browser-agent invitation regression suite.** Those APIs are absent from the current application, while their tests still expect them. This audit does not silently restore a removed access model or delete its security tests.

## Why the earlier checks missed this

1. OpenClaw fixtures represented a simpler send/finish flow than the installed Gateway. Its external `agent` call can acknowledge acceptance and later report completion or delivery failure on the same request ID. An accepted run is not a WhatsApp delivery receipt.
2. Compatibility tests existed, but several corresponding runtime guards had been overwritten. Version/help probes alone did not establish protocol compatibility.
3. Concurrent editing and copies between checkouts changed files during validation. A passing result from an earlier snapshot was incorrectly treated as evidence for a later one.
4. Success-path tests did not sufficiently exercise disconnection after a write, delayed callbacks, stale process exits, and restarts during queued delivery.

The audit used an isolated snapshot, reconciled concurrent changes, checked source hashes before applying the merge, and tested the combined code. Earlier release verification records are historical, not evidence that this checkout is release-ready.

## Findings and fixes

| Area | Failure | Applied protection |
| --- | --- | --- |
| OpenClaw delivery | Acceptance, generation completion and external delivery were conflated. Missing finals left a spinner. | Retained the preceding delivery fix: separate states, channel preflight, explicit destination, same-ID completion handling, reconciliation, and honest unconfirmed delivery. No automatic resend. |
| OpenClaw protocol | A JSON `null` envelope could escape the message handler; changed session labels could reach React as objects. | Reject malformed envelopes and consumed session fields. Close only the adapter connection; surface a supported error. |
| OpenClaw approvals | An uncertain resolution could be attempted again. | Bind approvals to their requesting socket, require a positive acknowledgement, and block a second attempt after an uncertain write. |
| Codex transport | Runtime validators and compatibility guards had been disconnected. | Restore per-method result validation, malformed-message containment, capability reporting and upgrade recovery. Unknown mutation outcomes remain non-retryable. |
| Codex queue | A missing queue ID or uncertain delete could look delivered or encourage resending. | Require real queue/steer acknowledgements. Only a confirmed queue deletion permits the “try again” path. |
| Codex lifecycle | A delayed completion from an older turn could finish the current one. | Check the turn identity before applying completion; disconnect errors no longer recommend an unqualified resend. |
| Codex approvals | Responses could cross a replaced connection or be retried after an uncertain write. Requested permission scope was not displayed. | Socket-bound one-shot responses with write acknowledgement. Display permission scope. Form, URL and device-verification elicitations cannot send an empty acceptance; finish them in Codex. |
| Legacy Codex chat API | Its independent adapter had weaker response and approval handling. | Validate replies, await approval writes at the HTTP route, reject repeated attempts, contain stale process callbacks, and handle stdin failure. |
| Claude hosted sessions | Sends raced initialization; parallel sends could create competing processes; old exit events could clear a replacement. | Wait for initialization, serialize sends, scope output/exit events to the current process, bound parsing, and report malformed streams visibly. |
| Claude hosted approvals | A write could be reported answered before delivery or be replayed after failure. | Wait for the write callback; reject on disconnection; retain uncertain state without replay; validate questions. |
| Claude desktop helpers | Missing acknowledgement could be retried; native consent pressed a still-visible button twice. | Require action-specific acknowledgement. Check the intended session/request again, serialize native consent, and press once. |
| Durable outbox | A crash between agent acceptance and queue removal could cause duplicate delivery. Failed persistence could still report a queued message. | Persist a sending marker before acting, pause uncertain/restarted deliveries, roll back a failed enqueue, and prevent “Send now” from bypassing uncertainty. Preserve queue ordering features. |
| Approval notifications | Removing the hook broker also removed the notification path. | Subscribe to real Claude/Codex host prompt changes, deduplicate notifications, and notify only the owner's subscribed devices. No approval is inferred from transcript text. |
| Gemini | Malformed historical messages/tool entries could throw while rendering history. | Handle unsupported records safely. Keep this integration read-only; do not imply send/stop/approval capabilities. |
| Other agents/terminals | Discovery does not imply a supported structured chat protocol. | Existing discovery/terminal tests verify unsupported chat actions remain unavailable. No new speculative provider adapter was added. |
| Release canary | `--help` success was too weak a release signal. | Add account-free Claude initialization and checks against generated Codex queue/turn/approval schemas. CI retains failure rather than enabling a fallback. |

## Verification

Final full regression run: **934 tests; 906 passed, 26 failed, 2 skipped, no cancellations** (about 69 seconds). All remaining failures are the browser-agent invitation/API cases listed below. Chat integration, approval transport, notification, owner/agent boundary, and shutdown checks passed.

An earlier focused run passed all 321 chat/security/shutdown checks. Additional malformed-Gateway and real-service notification regression tests were added afterwards and are included in the final full run. The two skipped checks are optional native checks; this is not a physical-phone end-to-end certification.

- Installed Claude Code **2.1.289**: isolated initialization handshake passed, without a user/model turn.
- Installed Codex **0.160.0**: generated-schema checks passed for seven consumed contracts, without a user/model turn.
- The production build and TypeScript check passed.
- Modified native Claude helpers passed Swift type checking; existing harmless cast warnings remain in the composer helper.
- No real WhatsApp message, user approval, paid model turn or usage reset was sent during this audit.

Commands:

```sh
npm test
npm run build
node scripts/check-agent-compatibility.mjs claude
node scripts/check-agent-compatibility.mjs codex
```

The canary is a protocol check, not proof that every signed-in workflow works. The GitHub workflow was updated locally; it has not been run on GitHub by this audit.

## Remaining release blockers

The browser invitation failures span `test/browser-access.test.mjs`, `test/browser-approval-routes.test.mjs`, and `test/browser-invite-auth.test.mjs`. Examples: `auth.inviteBrowser` is missing and browser-grant HTTP routes return 404. The feature's intended contract must be reconciled with the concurrent removal: restore and review the supported access path, or explicitly retire the feature across product, documentation and tests. Do not call a failing authorization suite a successful security review.

Before deployment/release, also perform a real iPhone/iPad check of Claude multi-question prompts, Codex queues, backgrounding/reconnect, native desktop send/consent, and a deliberately authorized WhatsApp delivery. Those experiences were not proven on a physical phone by this audit.

## Limits that remain

- No client can promise compatibility with every future Claude, Codex or OpenClaw update. Changed semantics can pass a schema check. Native Accessibility labels and private transcript formats are especially fragile.
- A write acknowledgement confirms transport acceptance, not model completion or an external channel receipt. Reach must continue to distinguish them.
- One-shot approval guards and OpenClaw request deduplication are process-local. Native approvals after a Reach restart require checking the Mac; the durable message outbox has a separate persisted restart guard.
- OpenClaw's administrative scope remains in place for the existing conversation-transfer feature. This audit did not expand Gateway permissions or review the entire networking/authentication architecture.
- The running deployment and this working checkout are separate. A local build is not proof that the phone is using these new files.

Protocol references: [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server), plus schemas generated by the installed CLI. Claude's initialization was exercised directly against the installed CLI. Native app controls still require the real-device release checklist in [AGENT_COMPATIBILITY.md](AGENT_COMPATIBILITY.md).
