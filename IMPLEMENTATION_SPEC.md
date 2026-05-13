# T-Hermes Implementation Spec

## Purpose

Build a working T3 Code-based desktop app with Hermes as an additional coding-agent provider.

The app should live at:

```text
/glitch-labs/t-hermes
```

This should be implemented on the target machine, whose absolute user path may differ. Do not hardcode a full home directory path in code, docs, scripts, or settings. Use `/glitch-labs/...`, repository-relative paths, `~`, or runtime-discovered home paths.

## Source Projects

Use these projects as source/reference material:

- T3 Code: `https://github.com/pingdotgg/t3code`
- Hermes Desktop: `https://github.com/fathah/hermes-desktop`

If reference clones are needed, fork or clone them under `/glitch-labs/`, for example:

```text
/glitch-labs/t3code-reference
/glitch-labs/hermes-desktop-reference
```

The actual app under active development should be:

```text
/glitch-labs/t-hermes
```

Recommended starting point: fork T3 Code into `/glitch-labs/t-hermes` and add Hermes support there. Treat Hermes Desktop as a reference for Hermes API behavior only, not as the architectural base.

## Codex Goal Setup

This project is intended to be run with Codex `/goal`, using OpenAI's goal workflow:

```text
https://developers.openai.com/codex/use-cases/follow-goals
```

Before starting, enable goals if needed:

```toml
[features]
goals = true
```

Then start the work with this goal:

```text
/goal Implement Hermes as a working ACP-backed provider in /glitch-labs/t-hermes without stopping until the app can launch locally, detect an installed Hermes binary, start at least one Hermes session from the T3 UI, stream a reply, show tool/approval events when Hermes emits them, and pass the relevant typecheck/test/build validation. Keep a short progress log, work in checkpoints, and stop only when the verifiable end state is reached or a true external blocker is documented.
```

Use `/goal` to inspect status during the run. Pause or clear the goal only when the app is working, the stopping condition is met, or a blocker requires human action.

## Non-Negotiables

- Do not edit, patch, or rewrite the user's installed Hermes source/config under `~/.hermes`.
- Do not mutate `~/.hermes/config.yaml` automatically.
- Do not require users to paste OpenAI API keys into T3 for Hermes.
- Do not bundle Hermes into the app.
- Do not create accounts, purchases, or externally visible releases without explicit approval.
- Do not turn this into a large product rewrite. The first working version should be a focused provider integration.

It is acceptable to run the installed `hermes` binary for testing. Hermes may naturally read its config/auth and write session runtime state during normal use. The restriction is against manually editing the Hermes install or config.

## Product Goal

Users who already have Hermes installed should be able to use a T3 Code-style GUI instead of the Hermes TUI or Hermes Desktop.

The first version should support:

- Hermes as a selectable provider beside Codex, Claude, Cursor, and OpenCode.
- Multiple Hermes tabs/sessions.
- Local Hermes execution through `hermes acp`.
- Hermes-owned auth/config through `~/.hermes`.
- Session start, user prompt, streaming assistant output, cancellation, and approval handling.
- A path that could plausibly become a small upstream PR to T3 Code.

Later versions can support:

- Remote Hermes through T3 remote environments.
- Direct Hermes API server mode.
- Rich Hermes settings.
- Session import/history browsing from Hermes state.
- Branded open-source fork distribution.

## Strategic Direction

There are three viable outcomes. Keep all three possible while implementing.

### 1. Upstream PR To T3 Code

Make the change small and defensible:

- Add Hermes as another ACP-backed provider.
- Reuse existing ACP runtime infrastructure.
- Avoid UI redesigns.
- Avoid special Hermes Desktop behavior.
- Avoid modifying user Hermes config.
- Add narrow tests around provider registration, settings decoding, ACP spawn input, and adapter event mapping.

T3 Code's current contribution guidance is conservative, so the upstreamable change should look like "support one more ACP agent" rather than "change T3's product direction."

### 2. Standalone Fork/Repackage

T3 Code is MIT licensed, so a fork can be redistributed if the MIT license and copyright notice are preserved.

If upstream does not accept the change, package `/glitch-labs/t-hermes` as a forked desktop app. Avoid confusing users into thinking it is the official T3 app unless it has been accepted upstream.

### 3. Remote Hermes

Remote support should build on T3's existing remote environment model when possible.

Preferred remote model:

- T3 desktop connects to a remote T3 server through the existing SSH/tunnel flow.
- The remote T3 server runs `hermes acp` on that remote machine.
- Hermes uses the remote machine's own `~/.hermes` auth/config.

Fallback/later model:

- Connect to a remote Hermes API server over SSH tunnel, Tailscale, or another secure transport.
- Use Hermes `/v1/runs`, SSE events, approval response, and stop endpoints.

Do not make remote API mode part of the first success condition unless local ACP mode is already working.

## Architecture Choice

Use Hermes ACP first.

Hermes already provides an ACP adapter. T3 Code already has a generic ACP session runtime and a Cursor ACP provider. The fastest and cleanest path is to add Hermes as another ACP-backed provider.

Avoid using Hermes Desktop as the base. Hermes Desktop is useful for learning:

- the local API server default: `http://127.0.0.1:8642`
- OpenAI-compatible streaming shapes
- Hermes session headers
- fallback CLI behavior

But do not copy its auto-config mutation behavior.

## Implementation Plan

### Checkpoint 1: Repo And Baseline

1. Create or clone the working app at `/glitch-labs/t-hermes`.
2. Install dependencies using the package manager the project expects.
3. Run baseline validation before edits:

```bash
bun install
bun run typecheck
bun run test
bun run build
```

If the upstream repo has known failures, record them in `PROGRESS.md` with exact commands and errors before making Hermes changes.

### Checkpoint 2: Understand Existing Provider Shape

Inspect the T3 provider files before editing:

```text
packages/contracts/src/settings.ts
packages/contracts/src/providerInstance.ts
apps/server/src/provider/ProviderDriver.ts
apps/server/src/provider/builtInDrivers.ts
apps/server/src/provider/Drivers/CursorDriver.ts
apps/server/src/provider/Layers/CursorAdapter.ts
apps/server/src/provider/acp/AcpSessionRuntime.ts
apps/server/src/provider/acp/CursorAcpSupport.ts
apps/web/src/components/settings/providerDriverMeta.ts
```

Expected finding: Cursor is the closest pattern because it is ACP-backed.

### Checkpoint 3: Add Hermes Settings

Add a `HermesSettings` schema in `packages/contracts/src/settings.ts`.

Recommended fields:

- `enabled`: hidden boolean, default `true` or default `false` if matching Cursor's early-access posture.
- `binaryPath`: default `hermes`.
- `homePath`: optional `HERMES_HOME` path, default empty.
- `authMethodId`: optional, default empty. If empty, auto-select the first auth method returned by ACP `initialize`.
- `customModels`: hidden string array for consistency with existing providers.

Keep this minimal. Do not add Hermes API server settings in the first pass.

Also update:

- legacy `providers` schema if current T3 patterns still require it
- `ServerSettingsPatch`
- any settings tests that assert provider schemas

### Checkpoint 4: Add Client Metadata

Update provider metadata so Hermes appears in settings/model picker UI:

```text
apps/web/src/components/settings/providerDriverMeta.ts
```

Use a simple existing icon if there is no Hermes icon yet. Do not block the integration on branding.

Suggested label:

```text
Hermes
```

Suggested badge:

```text
Experimental
```

### Checkpoint 5: Add Hermes ACP Support

Create a Hermes ACP support module similar to Cursor's:

```text
apps/server/src/provider/acp/HermesAcpSupport.ts
```

Spawn shape:

```ts
{
  command: hermesSettings.binaryPath || "hermes",
  args: ["acp"],
  cwd,
  env
}
```

If `homePath` is set, pass:

```text
HERMES_HOME=<homePath>
```

Do not infer or hardcode a user-specific home path.

The ACP auth handling should ideally be generic:

- Start ACP.
- Read `initialize` response.
- If `authMethodId` setting is present, use it.
- Otherwise use the first advertised auth method.

If that generic improvement is too large, use `openai-codex` as a temporary default and document it as a follow-up.

### Checkpoint 6: Add Hermes Provider Snapshot

Create:

```text
apps/server/src/provider/Layers/HermesProvider.ts
```

The first provider snapshot can be simple:

- disabled state if settings disabled
- warning/unavailable if `hermes` binary is missing
- ready/checking state if binary exists
- models from Hermes ACP if a lightweight probe is practical
- fallback model list if not

Do not block session execution on perfect model discovery.

Good first fallback model:

```text
hermes-agent
```

If ACP exposes the configured model, prefer that.

### Checkpoint 7: Add Hermes Adapter

Create:

```text
apps/server/src/provider/Layers/HermesAdapter.ts
```

Start from the Cursor adapter structure and adjust:

- provider naming
- settings type
- ACP spawn helper
- auth method handling
- model selection behavior
- event labels

Required adapter behavior:

- `startSession`
- `sendTurn`
- `interruptTurn`
- `respondToRequest`
- `respondToUserInput`
- `stopSession`
- `listSessions`
- `hasSession`
- `readThread`
- `streamEvents`

Use existing ACP event mapping where possible. Hermes ACP should already emit content, tool, reasoning, approval, and lifecycle updates in ACP-compatible forms.

### Checkpoint 8: Add Hermes Driver

Create:

```text
apps/server/src/provider/Drivers/HermesDriver.ts
```

Register it in:

```text
apps/server/src/provider/builtInDrivers.ts
```

Driver kind:

```text
hermes
```

Metadata:

```ts
{
  displayName: "Hermes",
  supportsMultipleInstances: true
}
```

Multiple instances matter because users may want:

- local Hermes
- remote Hermes
- isolated Hermes homes
- work/personal Hermes configurations

### Checkpoint 9: Text Generation

T3 providers often provide text generation for thread titles, commit messages, PR descriptions, or branch names.

For the first working version, choose the smallest non-broken option:

1. Reuse Hermes ACP for text generation, similar to Cursor text generation.
2. Or return an explicit unsupported `TextGenerationError` and keep normal chat/session behavior working.

Do not let text-generation polish block the core Hermes session path.

### Checkpoint 10: Local End-To-End Test

Verify on the target machine:

```bash
command -v hermes
hermes --version
```

Then run the app locally:

```bash
bun run dev
```

or the repo's current desktop dev command:

```bash
bun run dev:desktop
```

Manual validation:

1. Open the app.
2. Confirm Hermes appears in provider settings/model picker.
3. Start a new thread with Hermes selected.
4. Send a simple prompt.
5. Confirm assistant text streams back.
6. Confirm multiple Hermes threads can be open.
7. Interrupt a running turn and confirm cancellation works.
8. Trigger or observe a tool/approval event if practical.

Record results in `PROGRESS.md`.

### Checkpoint 11: Automated Validation

Run:

```bash
bun run typecheck
bun run test
bun run build
```

Add or update targeted tests for:

- `HermesSettings` decode/defaults.
- Hermes provider client metadata.
- Hermes ACP spawn input.
- built-in driver registration.
- provider instance creation if there is an existing driver-registry test pattern.
- adapter event mapping if practical with mocks.

### Checkpoint 12: Packaging Smoke Test

Once local dev works, run the desktop build path:

```bash
bun run build:desktop
```

If packaging scripts support platform artifacts, test the relevant platform artifact command. Do not publish or release without approval.

## Remote Hermes Plan

After local ACP mode works, validate remote behavior through T3's existing remote environment feature.

Target behavior:

- The remote T3 server runs on the remote machine.
- The remote provider registry detects Hermes on the remote machine.
- `hermes acp` is spawned remotely.
- Remote sessions use remote `~/.hermes`.

Validation:

1. Connect a remote environment in T3.
2. Open a remote project.
3. Select Hermes.
4. Start a Hermes thread.
5. Confirm the session runs on the remote machine, not locally.

Only after this works should direct Hermes API server mode be considered.

## Direct Hermes API Mode Later

Hermes has an API server that can expose:

- health checks
- chat completions
- responses
- run creation
- SSE run events
- approval responses
- stop/cancel endpoints

This can support remote Hermes when ACP is not available, but it should be a separate adapter mode.

Potential settings for a later version:

- `transport`: `acp` or `api`
- `apiBaseUrl`
- `apiKey`
- `sshTunnel`

Keep these out of the first version unless ACP is impossible.

## Expected File Changes

Likely files to add:

```text
apps/server/src/provider/Drivers/HermesDriver.ts
apps/server/src/provider/Layers/HermesAdapter.ts
apps/server/src/provider/Layers/HermesProvider.ts
apps/server/src/provider/acp/HermesAcpSupport.ts
apps/server/src/textGeneration/HermesTextGeneration.ts
```

Likely files to edit:

```text
packages/contracts/src/settings.ts
apps/server/src/provider/builtInDrivers.ts
apps/web/src/components/settings/providerDriverMeta.ts
apps/web/src/components/Icons.tsx
```

Possible generic ACP files to edit:

```text
apps/server/src/provider/acp/AcpSessionRuntime.ts
```

Only edit generic ACP runtime if needed for auth-method auto-selection or small Hermes-compatible behavior. Keep the change provider-neutral.

## Success Criteria

The goal is complete when all of these are true:

- `/glitch-labs/t-hermes` contains the working app.
- Hermes appears as a selectable provider.
- The app can launch locally.
- A Hermes session can be started from the UI.
- A prompt sent through the UI reaches Hermes through ACP.
- Streaming assistant output appears in the UI.
- At least two Hermes sessions can be opened without replacing each other.
- Interrupt/cancel works.
- Approval/tool events are handled if Hermes emits them during testing.
- The implementation does not modify `~/.hermes` config/source.
- `bun run typecheck` passes, or any pre-existing failures are clearly separated from new failures.
- Relevant tests pass.
- Desktop build or dev launch is validated.
- `PROGRESS.md` contains a concise checkpoint log and final verification notes.

## Stop Conditions

Do not stop early for normal implementation uncertainty. Continue diagnosing and iterating.

Stop only when:

- the success criteria are met, or
- Hermes is not installed/authenticated on the target machine and cannot be tested, or
- the T3 repo cannot be installed/built because of an external dependency outage, or
- a change would require editing the user's Hermes install/config, or
- credentials, account creation, payment, release publishing, or another explicit approval is required.

When blocked, write:

- exact command run
- exact error
- what was already verified
- what human action is required
- the smallest next command to resume

## Progress Log Template

Create and maintain:

```text
/glitch-labs/t-hermes/PROGRESS.md
```

Suggested format:

```markdown
# T-Hermes Progress

## Checkpoint Log

- [ ] Baseline install/build recorded
- [ ] Provider architecture mapped
- [ ] Hermes settings added
- [ ] Hermes ACP spawn works
- [ ] Hermes provider appears in UI
- [ ] First Hermes session streams output
- [ ] Multiple Hermes sessions verified
- [ ] Interrupt/approval behavior verified
- [ ] Tests/typecheck/build completed

## Current Status

...

## Validation Commands

...

## Blockers

...
```

## Final Deliverable

At the end, produce:

- concise summary of implemented Hermes support
- changed file list
- validation commands and results
- remaining limitations
- instructions for running locally
- notes on upstream PR suitability
- notes on fork/repackage suitability
- notes on remote Hermes readiness

