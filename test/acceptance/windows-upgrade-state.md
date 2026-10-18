# Installed Windows upgrade probe

Explicitly select `acceptance/windows-upgrade-state` in the existing Windows
validation workflow. This test creates a genuine standard account only on a
disposable GitHub-hosted Windows VM and runs its worker through the existing
Windows credential/profile API harness. No owner service is used. A new
upgrade-only helper requires the actual visible `WinSta0`, captures the original
station DACL, adds a single noninheriting generated-account ACE with station
mask `0x123`, and creates a unique desktop with account mask `0xC7`. It activates
only that disposable VM desktop. The worker independently verifies its actual
station, desktop, `WSF_VISIBLE` and input-desktop provenance; the native console
`IsWindowVisible` requirement remains unchanged. No daemon-only helper is changed.
Cleanup restores the original input desktop and exact original station DACL
(including ACL bytes, control flags, SDDL and hash), closes the owned desktop and
verifies removal, then removes the generated account/profile/grants. A missing
interactive station is a fixture prerequisite failure, never a product pass.
If the station ACL changes unexpectedly, cleanup fails rather than restoring an
old snapshot over other changes. It removes only a uniquely identifiable exact
generated-account ACE after rechecking the current ACL, preserving every other
rule and current control flags; ambiguous or further-changed ACLs remain untouched.
That path never reports exact restoration or a fixture pass.

The first two version phases download the official published npm tarballs for
0.3.1 and 0.3.3, compare SHA-512 SRI to the registry metadata, install each into
the same private prefix, and run the actual npm `reach.cmd` in a native console.
They retain that same genuine user's default `USERPROFILE\.reach` with no
HOME/REACH_HOME/REACH_DATA override and no injected ACL changes. Each version's
actual production read-only folder checker records the native ACL outcome after
that CLI launch. A second hardening call is never used to hide a failed launch.
The CLI stops between phases, answers its actual confirmation when present,
and checks `status` before another start.

Only after both ordinary version phases, separate real NTFS fixtures add a
same-owner explicit file grant and a protected child-directory grant. The fixture
helper is copied unchanged from public commit
576818ffc2e41b57087b2e7fc002b22c87781be7. Actual permissions and harmless content
hashes are recorded before/after; successful owner local access alone cannot pass
the folder assertion. Any observed refusal remains a failed probe.

The containing selected-test allowance is 20 minutes for this new file only.
Each registry query/compiler/status/stop is bounded at 60 seconds, pack and native
checker at 120 seconds, and install/start at 180 seconds. The worker has a
15-minute overall limit, credential process 15.5 minutes, parent process 19
minutes, and parent test 19.5 minutes, leaving cleanup time inside the dispatcher.
Existing test budgets are unchanged. Reports distinguish worker failures from
account/profile/cleanup harness failures; unfinished phases are failures.

Artifacts are under `reports/windows-upgrade-state`. They contain allowlisted
native ACL/owner metadata, package provenance, checker hashes/results, redacted
CLI evidence and separate cleanup outcomes. The random account password remains
in memory, and raw console buffers, auth files, package logs and tokens are not
uploaded. The generated account/profile and owned grants/processes are removed.

This is actual VM execution, not a physical Windows device or authenticated
onboarding qualification. The configured-owner browser/private QR case stays
BLOCKED: the lane neither enrolls Tailscale nor fabricates setup preferences.
No provider inference, phone behavior or private/public handoff is claimed.
