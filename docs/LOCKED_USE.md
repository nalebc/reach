# macOS locked use — implementation requirements, not a shipped feature

Reach currently prevents idle system/display sleep using process-bound power
assertions. It does **not** unlock a locked Mac. Tailscale authentication and a
ScreenControl lease do not themselves authorize macOS to unlock a desktop.

OpenAI documents a separate, opt-in authorization plug-in, a narrowly scoped
unlock window, display shielding and relocking on local input:
https://learn.chatgpt.com/docs/computer-use#locked-use
Apple's integration point is Authorization Services:
https://developer.apple.com/documentation/security/extending-authorization-services-with-plug-ins
The public product description does not provide an implementation of the complete
unlock/shield/relock protocol. Reach must implement and verify its own integration.

## Required components

- An explicitly installed macOS authorization plug-in and native broker. Installation
  needs administrator authorization, preserves the existing authorization rule,
  and provides rollback/uninstall. Do not replace the rule with `allow`, store the
  user's password, or reuse another product's authorization plug-in.
- Authenticate broker/plugin IPC by the connecting process's audit identity and
  code signature, with protected root-owned installation paths. A localhost port,
  caller-supplied PID, or writable token file is not proof of a trusted native caller.
- Bind each single-use, expiring unlock grant to one signed-in macOS session,
  Tailscale owner/device, authenticated Reach client, and live ScreenControl lease.
  Guest/agent tokens and pairing codes cannot create unlock grants. Enabling viewing
  alone does not enable locked use.
- A native session controller must establish display shields on every physical
  display before unlocking; distinguish physical from authenticated remote input;
  relock on local input, disconnect, lease revocation/expiry, display changes or
  process failure. Relock must finish before removing shields. Native process
  death must not leave an unshielded desktop unlocked.
- Stream the authorized desktop without leaking shields or lock-screen credentials,
  display a local connection indicator, and provide an emergency local disconnect.
- No unlock for FileVault pre-boot, login after reboot, another user's session,
  admin/TCC prompts, or an OS policy that disallows it. An unsupported configuration
  must remain locked and explain the reason to the remote client.

## Acceptance before enabling installation

Use a disposable macOS test installation first, then an explicitly authorized
physical-device test. Exercise stale/replayed grants, malicious local IPC clients,
wrong code signatures, revoked nodes, expired leases, process kills at each transition,
shield creation failures, hot-plugged displays, local keyboard/pointer input,
network loss, normal manual unlock, keychain availability and uninstall/rollback.
A compiled plug-in alone is not evidence that these guarantees hold.

None of these privileged components are installed by `./reach`, `./reach install`,
or the new sleep-prevention mode. Locked-use implementation and physical lock-cycle
validation remain outstanding.
