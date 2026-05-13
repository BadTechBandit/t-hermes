# T-Hermes

T-Hermes is an experimental fork of [T3 Code](https://github.com/pingdotgg/t3code) with [Hermes Agent](https://github.com/NousResearch/hermes-agent) added as a local ACP-backed provider.

The reason this exists is pretty simple: Hermes is a serious agent, but its usual surfaces are not great for long coding sessions. The TUI works. Telegram, Discord, WhatsApp, and the other channels are useful when you want to ping an agent from somewhere else. But none of those feel like a real coding workspace.

T3 Code already had the shape we wanted: threads, projects, approvals, tool output, and a desktop app that feels closer to Codex or Claude Code than a chat bot. T-Hermes keeps that shape and adds Hermes beside the other agents.

This is a fork, not an official T3 Code release and not an official Hermes release. Credit where it is due: the foundation is the T3 team's open-source T3 Code app, and the agent is Hermes by the Hermes/Nous Research team.

## What Works Right Now

- Hermes appears as a provider next to Codex, Claude, Cursor, and OpenCode.
- The app starts Hermes locally through `hermes acp`.
- Hermes uses its own local config and auth. The app does not edit `~/.hermes`.
- Chat/session workflows work through ACP.
- Basic Hermes health checks run with `hermes --version`.

## Requirements

You need Hermes installed on the same machine running T-Hermes.

Check:

```bash
hermes --version
```

If that works, T-Hermes should be able to find Hermes through the default `hermes` binary path. If not, set the Hermes provider's binary path to the absolute path from:

```bash
command -v hermes
```

Leave `HERMES_HOME` blank unless you intentionally use a non-default Hermes home. By default, Hermes should use its normal local state, usually under `~/.hermes`.

## Local Development

```bash
bun install
bun run dev:desktop
```

Expected healthy desktop logs include:

```text
Listening on http://127.0.0.1:13773
backend ready
main window created
```

## Packaging

Apple Silicon:

```bash
bun run dist:desktop:dmg:arm64
```

Intel Mac:

```bash
bun run dist:desktop:dmg:x64
```

Auto-updates are disabled in this fork until T-Hermes has its own signed and notarized release channel. That avoids accidentally pulling official T3 Code updates into this fork.

## Upstream

This project tracks T3 Code as an upstream source. The intended maintenance model is:

```text
official T3 Code -> periodic manual merge -> T-Hermes -> T-Hermes releases
```

Remote layout:

```text
upstream -> https://github.com/pingdotgg/t3code.git
origin   -> this T-Hermes repo
```

## Attribution

- [T3 Code](https://github.com/pingdotgg/t3code)
- [Hermes Agent](https://github.com/NousResearch/hermes-agent)
