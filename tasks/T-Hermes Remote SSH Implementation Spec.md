# T-Hermes Remote Hermes SSH Implementation Spec

## Objective

Remote Hermes SSH must connect T-Hermes to the regular Hermes Agent already installed on a remote
machine.

The remote machine is expected to have Hermes. It is not expected to have T-Hermes.

Correct path:

```text
local T-Hermes desktop/server
-> local ssh process
-> remote Hermes gateway / Hermes CLI
-> remote Hermes Agent runtime
```

Wrong path:

```text
local T-Hermes desktop/server
-> ssh
-> remote T-Hermes backend
-> remote npm/npx t-hermes package
-> remote Hermes Agent runtime
```

The current bug is that Remote Hermes can fall into the generic T3 remote backend flow and tries to
run `t-hermes@nightly` on the remote host. That must be removed from the Remote Hermes path.

## Non-Negotiables

- Do not modify Hermes Agent source, config, plugins, `.env`, or `~/.hermes/config.yaml`.
- Do not run `hermes update`.
- Do not install or enable Hermes plugins.
- Do not require T-Hermes on the remote machine.
- Do not run `t-hermes`, `t-hermes@nightly`, `t-hermes@latest`, `npm`, or `npx` for Remote Hermes.
- Do not require remote Node for Remote Hermes unless a verified Hermes-owned command requires it.
- Keep original T3 SSH remote backend behavior intact for non-Hermes remote environments.

## Product Model

There are two separate SSH features.

### Generic T3 Remote Environment

Existing T3 behavior. It may:

- launch a remote T3 backend
- require Node
- use package runners
- create generic remote environments

This path must keep working as it does today.

### Remote Hermes

New Hermes provider transport. It must:

- SSH into a machine that already has Hermes installed
- start/probe Hermes directly
- expose that remote Hermes instance as a Hermes provider in T-Hermes
- use the gateway bridge for slash commands, skills, sessions, model state, reasoning, context, and
  command formatting
- never bootstrap a remote T3/T-Hermes backend

## Backend Design

Add/keep a Hermes-specific SSH gateway module under:

```text
apps/server/src/provider/hermesGateway/
```

Expected shape:

```text
HermesProvider / HermesGatewayAdapter
-> HermesGatewayRuntime
-> local gateway process transport
-> ssh gateway process transport
```

The SSH transport should spawn a local `ssh` child process. The remote command starts the Hermes
gateway process on the remote machine. The SSH process stdio becomes the gateway protocol transport.

No HTTP server has to be started on the remote machine for Remote Hermes.

## Implementation Plan

### 1. Split Remote Hermes From Generic Remote Backend

Find every place where the Connections UI currently creates a remote environment for the Remote
Hermes option. Remote Hermes must not call the generic remote backend launcher. It should only:

1. collect SSH target fields
2. prepare/trust the SSH target
3. save those fields on the Hermes provider instance
4. refresh provider discovery

The generic T3 SSH flow can still launch a package-backed remote server. Remote Hermes cannot.

### 2. Add Hermes-Specific SSH Gateway Transport

Implement a server-side transport that starts the Hermes gateway over a local `ssh` process.

Required behavior:

- Build SSH args from Hermes provider SSH settings.
- Use the configured Hermes binary or `hermes`.
- Probe the remote binary with `hermes --version`.
- Resolve the installed Hermes source/gateway entrypoint from the remote Hermes installation.
- Start the Hermes gateway protocol over stdio.
- Wait for `gateway.ready`.
- Fail with a Hermes-specific message if the gateway cannot start.

Forbidden behavior:

- no remote T-Hermes package
- no remote `npm`
- no remote `npx`
- no remote Node preflight for Remote Hermes
- no remote file edits to Hermes

### 3. Provider Wiring

When Hermes provider settings contain Remote Hermes SSH fields:

- provider status checks should probe the remote Hermes binary, not local Hermes
- gateway snapshot discovery should use remote SSH gateway transport
- chat sessions should use remote SSH gateway transport
- ACP remains the stable local fallback only when Remote Hermes SSH is not enabled

The provider picker should still show Hermes as Hermes, but the backing runtime must be remote.

### 4. SSH Trust And Authentication UX

Host key verification must be handled inside the app instead of telling users to run manual terminal
commands first.

Required:

- scan host key
- show fingerprint for approval
- write approval to an app-managed known_hosts file
- run later SSH commands with strict host-key checking against that file

Authentication can use local SSH config, keys, agent, or ephemeral password prompt support. Do not
persist passwords or private keys.

### 5. Remote Hermes UI

Connections page empty state must make the entry point obvious:

```text
To connect to Hermes on another machine, click Add environment and choose Remote Hermes.
```

Remote Hermes setup must say:

```text
Connect over SSH to the Hermes Agent already installed on that machine.
No T-Hermes install is required on the remote host.
```

Remote Hermes setup must not show Node requirements. If Node copy appears in this flow, the
implementation is still using the wrong backend path.

### 6. Gateway Feature Discovery

After the remote gateway is ready, discover real runtime features from Hermes:

- models
- slash command catalog
- skills
- sessions support
- reasoning controls, if exposed by gateway
- context/usage events

Do not fake a full command list unless the gateway actually supports it.

## Remote Command Discovery

Before finalizing the remote command, re-read Hermes reference files as read-only material:

```text
~/.hermes/hermes-agent/tui_gateway/server.py
~/.hermes/hermes-agent/acp_adapter/server.py
~/.hermes/hermes-agent/ui-tui/src/app/createGatewayEventHandler.ts
~/.hermes/hermes-agent/ui-tui/src/app/createSlashHandler.ts
```

Preferred command order:

1. Use an official `hermes` CLI gateway subcommand if one exists.
2. Use a shipped Hermes gateway entrypoint from the installed Hermes source.
3. If gateway startup is not available, show a clear unsupported state and keep ACP as a local-only
   fallback. Do not invent or install remote code.

Remote probing should use commands in this spirit:

```sh
command -v hermes
hermes --version
```

Then validate the actual gateway command by waiting for the gateway-ready event/handshake.

## Remote Hermes Settings

Store Remote Hermes SSH config on the Hermes provider instance, or in a dedicated Remote Hermes
connection store that feeds the Hermes provider. Do not use the generic saved remote backend store as
the execution path.

Minimum fields:

- display label
- SSH host or alias
- username
- port
- optional Hermes binary path
- optional `HERMES_HOME`
- optional remote working directory / Hermes source override

Do not store passwords or private keys.

Use local SSH config, known hosts, SSH agent, and any existing password prompt support. Passwords
must be ephemeral for the current connection attempt only.

## Provider Runtime Behavior

When a Hermes provider instance has Remote Hermes SSH enabled:

1. Build the SSH target from provider settings.
2. Probe SSH reachability.
3. Probe the remote Hermes binary and version.
4. Start the Hermes gateway over SSH.
5. Wait for gateway ready.
6. Create/resume a gateway session.
7. Use the gateway catalog for slash commands.
8. Stream provider events through the existing T-Hermes event pipeline.
9. Map usage/context updates into the context wheel.
10. Cleanly stop the SSH/gateway process when the provider session ends.

Remote Hermes must use the same gateway command path needed for:

- full slash command catalog
- formatted command output
- `/model`
- `/skills`
- `/reasoning`
- `/sessions`
- `/help`
- `/tools`
- `/context`

If any command remains unsupported, the UI should say why instead of silently falling back to inline
text.

## UI Requirements

### Connections Page

The Connections page must make Remote Hermes obvious. The empty Remote environments state should
explicitly say that Remote Hermes is added from `Add environment`.

Suggested copy:

```text
To connect to Hermes on another machine, click Add environment and choose Remote Hermes.
```

### Add Environment Dialog

The Remote Hermes option should say:

```text
Connect over SSH to the Hermes Agent already installed on that machine.
No T-Hermes install is required on the remote host.
```

Remove Node requirement copy from Remote Hermes. Node belongs to generic T3 remote backend only.

If a Node error appears in Remote Hermes flow, that is a bug unless the verified Hermes gateway
command itself requires Node.

### Error Copy

Use specific errors:

```text
Hermes was not found on the remote machine. Install Hermes there or set the Hermes binary path.
```

```text
Hermes was found, but its gateway protocol could not be started over SSH.
```

```text
SSH host key is not trusted yet. Review the fingerprint and approve it, or connect once with ssh in
Terminal.
```

```text
SSH authentication failed. Check username, key, agent, or password for this remote machine.
```

Never show `t-hermes@nightly` or npm package failures in Remote Hermes UI.

## Security And Safety

- Do not mutate remote Hermes files.
- Do not write remote Hermes config.
- Do not install packages remotely.
- Do not bypass SSH host key verification silently.
- Do not persist passwords.
- Do not log secrets, tokens, passwords, or private key material.

## Tests

Add or update tests proving:

- Remote Hermes SSH does not call the generic T3 remote backend launcher.
- Remote Hermes SSH never includes `t-hermes`, `t-hermes@nightly`, `npm`, or `npx` in its command path.
- Remote Hermes probes `hermes` on the remote host.
- Remote Hermes builds an SSH gateway command from Hermes settings.
- Generic T3 SSH still uses its existing remote backend/package runner path.
- Node checks remain generic T3 SSH only, not Remote Hermes.
- Remote Hermes provider settings persist SSH target fields.
- Remote Hermes UI copy says no remote T-Hermes install is required.
- Connections empty state tells users where Remote Hermes setup lives.
- Local Hermes gateway behavior still works.

## Acceptance Evidence To Collect

Before calling the work complete, collect concrete evidence:

- `rg` or tests showing the Remote Hermes command path does not contain `t-hermes`, `npm`, or `npx`.
- Tests showing generic T3 SSH still uses its existing package runner path.
- Tests showing Remote Hermes UI calls the Hermes-specific path, not generic remote environment launch.
- Tests showing Remote Hermes settings persist SSH fields.
- Tests showing host-key trust uses strict checking and an app-managed known_hosts file.
- Passing output from `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test`.

## Manual Verification

1. Start desktop app.
2. Open Settings -> Connections.
3. Confirm the page explains how to add Remote Hermes.
4. Click Add environment -> Remote Hermes.
5. Enter SSH host/user/port for a machine with regular Hermes installed and no T-Hermes installed.
6. Confirm no Node requirement is shown.
7. Confirm no npm/npx/t-hermes package install is attempted remotely.
8. Confirm preflight detects `hermes --version`.
9. Confirm gateway reaches ready state.
10. Select/use the Remote Hermes provider.
11. Run `/version`, `/help`, `/model`, `/tools`, `/skills`, `/reasoning`, `/sessions`, and `/context`.
12. Send one harmless prompt.
13. Confirm context usage updates.
14. Confirm process cleanup after ending the session/app.

## Required Gates

Before calling implementation complete:

```sh
bun fmt
bun lint
bun typecheck
bun run test
```

Never run `bun test`.

## Completion Criteria

Remote Hermes SSH is complete only when:

- It works against a remote host with regular Hermes installed and no T-Hermes installed.
- It does not use npm, npx, or any T-Hermes package on the remote host.
- Original T3 SSH remote backend still works.
- Hermes Agent repo remains untouched.
- The UI makes Remote Hermes setup clear.
- Required gates pass.
