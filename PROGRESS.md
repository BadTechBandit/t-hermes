# T-Hermes Progress

## Baseline

- Initialized this workspace from T3 Code `origin/main`.
- Installed dependencies with `bun install`.
- Verified baseline before Hermes changes:
  - `bun run typecheck` passed.
  - `bun run test` passed.
  - `bun run build` passed.
- Confirmed the local Hermes CLI is available:
  - `command -v hermes` -> `/Users/rmmbp1/.local/bin/hermes`
  - `hermes --version` -> `Hermes Agent v0.13.0 (2026.5.7)`

## Implementation

- Added Hermes settings to shared contracts under `providers.hermes`, including binary path, optional `HERMES_HOME`, auth method override, enabled flag, and hidden custom model list.
- Registered Hermes in the provider settings UI metadata with an experimental badge and form fields.
- Added a Hermes built-in driver and provider status probe that checks `hermes --version`.
- Added Hermes ACP support:
  - Spawns `hermes acp`.
  - Passes `HERMES_HOME` only when configured.
  - Defaults blank auth method to `openai-codex`.
  - Enables a stdout JSON-line filter because Hermes currently emits non-JSON log lines before JSON-RPC messages.
- Added a Hermes provider adapter for ACP-backed sessions:
  - Starts/stops sessions and streams runtime events.
  - Sends text/image user prompts.
  - Supports interruption through `session/cancel`.
  - Handles `session/request_permission`, including full-access auto-approval for allow-once/allow-always options.
  - Handles ACP `session/elicitation` through the existing T3 user-input request/response path.
  - Persists simple Hermes resume cursors.
- Added an unsupported Hermes text generation implementation so the provider can be registered without pretending to support out-of-session text generation.

## Tests Added

- `packages/contracts/src/settings.test.ts`
  - Hermes settings defaults.
  - Legacy server settings provider schema and patch schema coverage.
- `apps/server/src/provider/acp/HermesAcpSupport.test.ts`
  - Spawn command defaults.
  - `HERMES_HOME` environment merge.
  - Default and explicit auth method resolution.
- `apps/server/src/provider/builtInDrivers.test.ts`
  - Hermes is registered as a multi-instance built-in driver.
- `apps/web/src/components/settings/ProviderSettingsForm.test.ts`
  - Hermes metadata, badge, and visible settings fields.
- Updated `apps/server/src/provider/Layers/ProviderRegistry.test.ts` for the new built-in provider list.

## Validation

- `bun run typecheck --filter=t3 --filter=@t3tools/contracts --filter=@t3tools/web` passed.
- Targeted package tests passed:
  - `packages/contracts`: `bun run test src/settings.test.ts`
  - `apps/server`: `bun run test src/provider/acp/HermesAcpSupport.test.ts src/provider/builtInDrivers.test.ts`
  - `apps/web`: `bun run test src/components/settings/ProviderSettingsForm.test.ts`
- `apps/server`: `bun run test src/provider/Layers/ProviderRegistry.test.ts` passed after updating the expected provider list.
- Full validation passed:
  - `bun run typecheck`
  - `bun run test` -> 16 tasks successful; server package reported 1,018 passing tests and 4 skipped.
  - `bun run build`
  - `bun run build:desktop`
- Live Hermes ACP smoke passed:
  - `initialize` returned protocol version 1.
  - `authenticate` with `openai-codex` succeeded.
  - `session/new` created a Hermes ACP session.
  - `session/prompt` returned `stopReason: "end_turn"` and response `T-Hermes ACP smoke ok`.
- Local desktop launch smoke:
  - Sandboxed `bun run dev:desktop` could not find ports due process/port sandboxing.
  - Unrestricted `bun run dev:desktop` launched the dev runner, built desktop preload/main bundles, and served the web app at `http://127.0.0.1:5733/`.
  - The dev runner and child processes were stopped after the smoke.

## Notes

- Hermes `initialize` did not advertise auth methods in the live probe, so the adapter uses `openai-codex` as the default when the setting is blank.
- Hermes writes logs under `~/.hermes/logs`; live ACP smoke requires allowing that write. The implementation does not modify Hermes config.
- Hermes currently emits INFO/WARNING log lines outside JSON-RPC. The ACP runtime now supports discarding non-JSON stdout lines and Hermes enables that option.
- Hermes text generation is intentionally unsupported; Hermes is available for chat/session workflows through ACP.
