# Reach Agent CLI

Use a cloud agent to access selected folders on your Mac over private Tailscale HTTPS. No Supabase account, public tunnel, SSH server, or tailnet administrator credential is required in the agent runtime.

There are two independent permissions: Tailscale grants determine which network services the agent can reach; your Mac's Reach policy determines which API operations and folders its credential can access. Both must be configured. This implementation does not deploy AWS resources or modify your tailnet policy automatically.

## On your Mac

From the Reach folder, create a policy for the exact project you want the agent to use:

```sh
./reach-agent policy init --folder "$HOME/Documents/MyProject" --out .reach/agent-policy.json
./reach --folder "$HOME/Documents/MyProject" --agent-policy .reach/agent-policy.json
```

`reach-agent` requires Node.js 22 or later. You can also run `node scripts/agent-cli.mjs ...`; the CLI and MCP client themselves use only Node built-ins. The `./reach` companion launcher still prepares the companion's dependencies. `reach-agent.cmd` works on Windows with an existing Tailscale connection; isolated joining is supported on Linux/macOS.

The generated `workspace` profile permits reading and writing that folder, for one hour. It grants **no shell execution, terminal, app, screen, or Codex access**. Use `--access read-only` when initializing a read-only profile. The policy file must stay on the Mac; the agent never receives it. A profile can contain multiple absolute folder paths.

In another terminal on the Mac, issue a credential:

```sh
./reach-agent grant --profile workspace --name bedrock --out .reach/bedrock.json
```

Only metadata appears in stdout. The bearer credential is saved to a new file with mode `0600`, and its hash is stored by the Mac. Existing files are never overwritten. Keep credentials outside folders exposed to agents; `.reach` is excluded from file access. Send the credential through your secret manager into the cloud runtime, owned by the runtime user with mode `0600`/`0400`. Do not put it into prompts, command-line values, Git, container images, or logs.

The grant command reads the running launcher's private host configuration. For a non-default data directory, supply `--data-dir /path/to/state` (or `REACH_DATA`). It does not rotate your phone's pairing code. `--ttl 600` issues a ten-minute grant; the profile controls the maximum (60–86,400 seconds).

Example policy:

```json
{
  "version": 1,
  "profiles": {
    "workspace": {
      "scopes": ["device", "files:read", "files:write"],
      "roots": ["/Users/you/Documents/MyProject"],
      "ttlSeconds": 3600,
      "maxJobMs": 60000
    }
  }
}
```

Folders must be inside Reach's shared folders. Each credential receives its own folder list, indexed from zero in `device`. Scope/TTL/folder reductions apply to subsequent requests without a restart. Existing credentials never gain broader scopes or folders from a policy expansion; issue a new grant for that. Removing a profile or making the policy unavailable invalidates its credentials. Enabling profiles also blocks legacy, unprofiled agent keys; phone credentials remain valid. A missing policy explicitly configured at startup prevents startup.

Allowed policy scopes: `device`, `files:read`, `files:write`, `exec`, `terminal`, `codex`, `apps`, `screen`. `device` is included in each profile. `admin` and the legacy broad `files` scope are rejected in policies. Desktop Terminal/iTerm2 access and Codex approval decisions remain reserved for full-access paired people.

**Shell-capable scopes are not a filesystem sandbox.** `exec`, `terminal`, `codex`, and app launching can perform actions as the Mac user beyond the selected working directory. Do not add them to a file-only agent. File writes can also alter code or configuration that another program later executes; choose folders deliberately. Already-started commands may continue after credential revocation; use job cancellation or stop the companion when necessary. `maxJobMs` caps newly started jobs, not arbitrary detached processes.

## Restrict the tailnet connection

Get your Mac's Tailscale IPv4 address from Tailscale, then generate a reviewable fragment (replace the example address):

```sh
./reach-agent network-policy --mac-ip 100.90.80.70 --port 8443 --tag tag:reach-agent
```

The fragment authorizes `tag:reach-agent` to reach only that IP's TCP 8443 port, declares tag ownership, and includes an accept test for Reach and a deny test for SSH. A tailnet administrator must review it alongside the **entire existing policy**, merge it, and validate the tests. Do not replace your policy blindly: that could remove your own access. Add deny tests for other sensitive tailnet destinations.

Tailscale grants and legacy ACLs are additive. An existing `* → *` allow rule still authorizes the agent; adding a narrow grant does not override it. Tag verification in the CLI cannot prove the tailnet's effective policy is restrictive. Remove/refine broader rules that cover the agent before giving it an enrollment credential. See [Tailscale grants](https://tailscale.com/docs/reference/syntax/grants).

Create a short-lived, tagged, preferably single-use auth key limited to `tag:reach-agent`, or configure workload identity federation for the cloud workload. Never give the runtime an owner login, API admin key, or broad OAuth client secret. [Tailscale auth keys](https://tailscale.com/docs/features/access-control/auth-keys) and [workload identity federation](https://tailscale.com/docs/features/workload-identity-federation) describe the control-plane setup.

## In the agent runtime

For an agent already connected to the tailnet:

```sh
./reach-agent device --credential /run/secrets/reach.json
./reach-agent files list --credential /run/secrets/reach.json --root 0 --path .
./reach-agent files read --credential /run/secrets/reach.json --path README.md
./reach-agent files mkdir --credential /run/secrets/reach.json --path . --name results
./reach-agent files put --credential /run/secrets/reach.json --path results --file ./report.txt
```

`files put` uploads a new file, up to 100 MiB, and refuses overwriting. `files read` returns UTF-8 text up to 1 MiB plus its `sha256`. To edit an existing text file, supply that hash:

```sh
./reach-agent files write --credential /run/secrets/reach.json \
  --path notes.txt --file ./updated-notes.txt --if-match SHA256_FROM_LAST_READ
```

Edits are limited to 128 KiB and use an atomic replacement. A changed hash returns a conflict; read the new version and reconcile it rather than blindly retrying. All operations return JSON. Errors go to stderr with a nonzero exit status. Commands, uploads, and other writes are never automatically retried. Redirects are refused, TLS certificates are validated, and secrets are not sent in URLs. Remote origins must be private `.ts.net` HTTPS URLs. `--allow-local` exists for loopback integration tests only.

To join from an isolated Linux cloud runtime, install the official `tailscale` and `tailscaled` binaries alongside Node, then wrap the **whole agent process**, not each tool call:

```sh
./reach-agent join --tag tag:reach-agent \
  --auth-key-file /run/secrets/tailscale-key --max-seconds 3600 -- \
  python /app/agent.py
```

Or use a workload identity token supplied by your cloud environment:

```sh
./reach-agent join --tag tag:reach-agent \
  --client-id YOUR_TAILSCALE_FEDERATION_CLIENT_ID \
  --id-token-file /run/secrets/workload-oidc -- \
  python /app/agent.py
```

Federation requires a matching Tailscale trust configuration and an identity token with the right issuer/audience/claims. This CLI does not mint AWS identity tokens or set IAM permissions. Workload federation requires Tailscale 1.90.1 or later. An arbitrary AWS access key or session token is not an OIDC token.

The wrapper launches a private userspace daemon, an owner-only control socket, memory-only ephemeral state, and a loopback HTTP proxy. It disables incoming connections, Tailscale SSH, route acceptance and DNS changes, checks that the node has exactly the requested tag, and passes `REACH_PROXY` to the child. Reach CLI/MCP requests automatically use that proxy; it does not reroute the child's unrelated AWS API calls. It never operates on the machine's default Tailscale socket. Exit, timeout, or daemon failure ends the wrapped child, logs out the node, and removes temporary state. Hard kills/platform crashes rely on Tailscale's ephemeral-node cleanup; this is not an OS sandbox against a malicious process running as the same cloud user.

[Userspace daemon flags](https://tailscale.com/docs/reference/tailscaled) and [ephemeral node lifecycle](https://tailscale.com/docs/features/ephemeral-nodes) document the underlying behavior. Frequent restarts create new nodes, so wrap a runtime/session rather than reconnecting for every read.

## Bedrock / AgentCore

A Bedrock model calls tools through your application; the model itself does not run this CLI. The application running in AgentCore, a container, EC2, or another worker invokes Reach. For example, a narrow Python tool can call the CLI with a fixed argument list:

```python
import json
import subprocess


def read_laptop_file(relative_path: str) -> dict:
    completed = subprocess.run(
        ["/opt/reach/reach-agent", "files", "read",
         "--credential", "/run/secrets/reach.json", "--path", relative_path],
        capture_output=True, text=True, check=True, timeout=40,
    )
    return json.loads(completed.stdout)
```

Register this function in your existing agent's tool framework. Give the model relative file paths, not bearer tokens or a general tool for constructing arbitrary shell commands. The Mac remains the authority even if a model asks for disallowed operations.

If your framework supports MCP stdio, run `reach-agent mcp --credential /run/secrets/reach.json` inside the same wrapped process. It uses the same proxy and server-enforced permissions. MCP advertises tools allowed by the credential: device information, file reads/edits, folder creation, jobs, and Codex. Use CLI file commands for binary uploads.

AgentCore packaging must support Node, Tailscale binaries, child processes and loopback sockets. The runtime also needs outbound connectivity to the Tailscale control/relay services; VPC deployments may need NAT/internet egress. A private VPC alone does not join a tailnet. See [AWS AgentCore VPC configuration](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-vpc.html). No real AWS runtime deployment or live restricted tailnet enrollment is claimed by the local test suite.

## Revoke and validate

```sh
./reach-agent grants
./reach-agent revoke --id CLIENT_ID
```

A revoked/expired credential cannot make new API calls; terminal/screen sockets are rechecked. This is independent of tailnet membership. To remove network access too, revoke the Tailscale node or its grant; revoking an enrollment key alone does not remove an already-enrolled node. The wrapper logs its node out when it finishes.

The automated tests use disposable folders and servers to exercise CLI issuance, read/write, root and symlink escape denial, forbidden capabilities, token expiry/revocation, policy reductions, no privilege expansion, secret file permissions, redirect refusal, TLS certificate verification through a CONNECT proxy, and isolated daemon cleanup/tag mismatch with fake Tailscale processes. Test your final tailnet grants and cloud runtime with a throwaway folder before production use.
