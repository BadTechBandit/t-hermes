# T-Hermes

T-Hermes is an experimental fork of [T3 Code](https://github.com/pingdotgg/t3code) with [Hermes Agent](https://github.com/NousResearch/hermes-agent) added as a provider.

Hermes is a serious coding agent, but the usual ways to talk to it are not ideal for long coding sessions. The TUI works. Telegram, Discord, WhatsApp, and the other channels are useful when you want to ping an agent from somewhere else. But they do not feel like a real coding workspace.

T3 Code already had the shape this needed: projects, threads, approvals, tool output, and a desktop app that feels closer to Codex or Claude Code than a chat bot. T-Hermes keeps that shape and adds Hermes beside the other agents.

This is a fork, not an official T3 Code release and not an official Hermes release. Credit where it is due: the foundation is the T3 team's open-source T3 Code app, and the agent is Hermes by the Hermes/Nous Research team.

## What Works Right Now

- Hermes appears as a provider next to Codex, Claude, Cursor, and OpenCode.
- Local Hermes works through ACP by default.
- Gateway mode adds Hermes slash commands, skills, model discovery, sessions, reasoning controls, and context usage.
- Remote Hermes works over SSH against a normal Hermes install on another machine.
- Hermes uses its own local config and auth. The app does not edit `~/.hermes`.
- T-Hermes does not modify Hermes Agent source, install plugins, or rewrite Hermes config.
- Basic Hermes health checks run with `hermes --version`.

## Before You Start

For local use, install these on the Mac running T-Hermes:

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

For Remote Hermes over SSH, the remote machine needs:

- SSH access from this Mac.
- Hermes already installed and working there.
- A remote project folder you want Hermes to work in.

Remote Hermes does not install T-Hermes on the remote machine and does not require the remote T3 backend.

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

## Local Hermes

Local Hermes uses the Hermes binary configured in provider settings. Leave the binary as `hermes` unless it is not on PATH.

ACP is the stable local fallback. Gateway mode is available for fuller Hermes features:

```bash
T3_HERMES_RUNTIME=gateway bun run dev:desktop
```

Gateway mode enables the live Hermes command catalog, skills, model options, sessions, reasoning controls, and better context reporting.

## Remote Hermes Over SSH

Use this when Hermes is installed on another machine.

In the app:

```text
Settings -> Connections -> Add environment -> Remote Hermes
```

Enter the SSH host, username, optional port, and the remote project folder. T-Hermes connects over SSH and starts Hermes' existing gateway on that machine.

Remote Hermes is separate from generic T3 remote environments. It does not run `t-hermes`, `npm`, `npx`, or a remote T3 backend.

SSH keys or an active SSH agent are recommended. The app handles host-key review before using a strict known-hosts file for Remote Hermes commands.

### Electron Postinstall On Hardened npm Setups

If your `~/.npmrc` sets `ignore-scripts=true` as supply-chain protection (a sensible default given recent npm-ecosystem zero-days), Bun reads that file and skips lifecycle scripts even for packages this repo lists in `trustedDependencies`. The Electron binary will not download, and `bun run dev:desktop` will fail with:

```text
Error: Electron failed to install correctly, please delete node_modules/electron and try installing again
```

Fix without weakening your global setting. Install with a per-command override:

```bash
npm_config_ignore_scripts=false bun install
```

Or, if you already ran `bun install` and just want to recover, run Electron's installer directly:

```bash
node node_modules/electron/install.js
```

If you do not have `ignore-scripts=true` set, you will not hit this and can skip the section.

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
6. Verify the Electron binary downloaded. Confirm `node_modules/electron/dist/Electron.app` exists. If it is missing (common when `~/.npmrc` sets `ignore-scripts=true` for supply-chain protection), recover with `node node_modules/electron/install.js`, or rerun the install as `npm_config_ignore_scripts=false bun install`. Do not silently disable the user's global `ignore-scripts` setting.
7. Run `bun run dev:desktop`.
8. If the app launches but Hermes is not detected, run `command -v hermes` and set that absolute path as the Hermes provider Binary path in the app settings.
9. For Remote Hermes, open Settings -> Connections -> Add environment -> Remote Hermes and enter the SSH host plus remote project folder.

Do not edit `~/.hermes`. T-Hermes should use the existing Hermes install and config. Do not install Hermes plugins.
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
