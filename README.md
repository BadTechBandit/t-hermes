# T-Hermes

T-Hermes is an experimental fork of [T3 Code](https://github.com/pingdotgg/t3code) with [Hermes Agent](https://github.com/NousResearch/hermes-agent) added as a local ACP-backed provider.

Hermes is a serious coding agent, but the usual ways to talk to it are not ideal for long coding sessions. The TUI works. Telegram, Discord, WhatsApp, and the other channels are useful when you want to ping an agent from somewhere else. But they do not feel like a real coding workspace.

T3 Code already had the shape this needed: projects, threads, approvals, tool output, and a desktop app that feels closer to Codex or Claude Code than a chat bot. T-Hermes keeps that shape and adds Hermes beside the other agents.

This is a fork, not an official T3 Code release and not an official Hermes release. Credit where it is due: the foundation is the T3 team's open-source T3 Code app, and the agent is Hermes by the Hermes/Nous Research team.

## What Works Right Now

- Hermes appears as a provider next to Codex, Claude, Cursor, and OpenCode.
- The app starts Hermes locally through `hermes acp`.
- Hermes uses its own local config and auth. The app does not edit `~/.hermes`.
- Chat/session workflows work through ACP.
- Basic Hermes health checks run with `hermes --version`.

## Before You Start

You need these on the same Mac where you run T-Hermes:

- `git`
- `bun`
- `node`
- `hermes`

Check Hermes first:

```bash
hermes --version
```

If that command works, Hermes is installed and T-Hermes should be able to use it.

If Hermes is installed but T-Hermes cannot find it later, get the full path:

```bash
command -v hermes
```

Then put that path in the Hermes provider settings under `Binary path`.

Leave `HERMES_HOME` blank unless you intentionally use a non-default Hermes home. By default, Hermes should use its normal local state, usually under `~/.hermes`.

## Install And Run From Source

There is no signed public DMG yet. For now, run it from source.

Open Terminal and run:

```bash
mkdir -p ~/t-hermes-work
cd ~/t-hermes-work
git clone https://github.com/BadTechBandit/t-hermes.git
cd t-hermes
bun install
bun run dev:desktop
```

Do not run `bun install` before you `cd t-hermes`. It has to run inside the cloned repo.

Expected healthy desktop logs include:

```text
Listening on http://127.0.0.1:13773
backend ready
main window created
```

When the app opens, choose Hermes as the provider and start a session.

## Agent Install Prompt

If you want Claude Code, Codex, Hermes, or another local coding agent to do the setup for you, paste this:

```text
Install and run T-Hermes from source on this Mac.

Use this repository:
https://github.com/BadTechBandit/t-hermes

Steps:
1. Check that `git`, `bun`, `node`, and `hermes` are available.
2. Run `hermes --version` and confirm Hermes is installed.
3. Create a normal workspace folder such as `~/t-hermes-work`.
4. Clone the repo into that folder.
5. Run `bun install` inside the cloned `t-hermes` repo.
6. Run `bun run dev:desktop`.
7. If the app launches but Hermes is not detected, run `command -v hermes` and set that absolute path as the Hermes provider Binary path in the app settings.

Do not edit `~/.hermes`. T-Hermes should use the existing local Hermes install and config.
```

## Updating Later

If you already cloned the repo and want the latest source:

```bash
cd ~/t-hermes-work/t-hermes
git pull
bun install
bun run dev:desktop
```

## Packaging

Developer/test DMGs can be built locally.

Apple Silicon:

```bash
bun run dist:desktop:dmg:arm64
```

Intel Mac:

```bash
bun run dist:desktop:dmg:x64
```

These builds are unsigned unless you set up Apple signing and notarization. macOS may warn before opening them.

Auto-updates are disabled in this fork until T-Hermes has its own signed release channel. That avoids accidentally pulling official T3 Code updates into this fork.

## Upstream

This project tracks T3 Code as an upstream source. The intended maintenance model is:

```text
official T3 Code -> periodic manual merge -> T-Hermes -> T-Hermes releases
```

Remote layout:

```text
upstream -> https://github.com/pingdotgg/t3code.git
origin   -> https://github.com/BadTechBandit/t-hermes.git
```

## Attribution

- [T3 Code](https://github.com/pingdotgg/t3code)
- [Hermes Agent](https://github.com/NousResearch/hermes-agent)
