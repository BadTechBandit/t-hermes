import type { DesktopSshEnvironmentTarget, HermesSettings } from "@t3tools/contracts";

import type { HermesGatewaySpawnInput } from "./HermesGatewayProtocol.ts";
import type { HermesGatewayRuntimeOptions } from "./HermesGatewayRuntime.ts";

const DEFAULT_SSH_CONNECT_TIMEOUT_SECONDS = 10;

export interface HermesSshTarget {
  readonly target: DesktopSshEnvironmentTarget;
  readonly hermesBinaryPath: string;
  readonly homePath: string;
  readonly remoteCwd: string;
  readonly knownHostsFile: string;
}

export function isHermesSshEnabled(settings: HermesSettings): boolean {
  return Boolean(settings.sshEnabled && settings.sshHost.trim().length > 0);
}

function parseSshPort(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : null;
}

export function resolveHermesSshTarget(settings: HermesSettings): HermesSshTarget | undefined {
  if (!isHermesSshEnabled(settings)) {
    return undefined;
  }

  const host = settings.sshHost.trim();
  const username = settings.sshUsername.trim();
  return {
    target: {
      alias: host,
      hostname: host,
      username: username ? username : null,
      port: parseSshPort(settings.sshPort),
    },
    hermesBinaryPath: settings.sshHermesBinaryPath.trim() || "hermes",
    homePath: settings.sshHomePath.trim(),
    remoteCwd: settings.sshRemoteCwd.trim(),
    knownHostsFile: settings.sshKnownHostsFile.trim(),
  };
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

export function buildHermesSshHostSpec(target: DesktopSshEnvironmentTarget): string {
  const destination = target.alias.trim() || target.hostname.trim();
  if (!destination) {
    throw new Error("Remote Hermes SSH host is required.");
  }
  return target.username ? `${target.username}@${destination}` : destination;
}

export function buildHermesSshBaseArgs(
  target: DesktopSshEnvironmentTarget,
  input?: { readonly knownHostsFile?: string },
): string[] {
  const knownHostsFile = input?.knownHostsFile?.trim();
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${DEFAULT_SSH_CONNECT_TIMEOUT_SECONDS}`,
    ...(knownHostsFile
      ? ["-o", `UserKnownHostsFile=${knownHostsFile}`, "-o", "StrictHostKeyChecking=yes"]
      : []),
    ...(target.port !== null ? ["-p", String(target.port)] : []),
    buildHermesSshHostSpec(target),
  ];
}

function remoteHermesEnvironmentPrefix(input: Pick<HermesSshTarget, "homePath">): string {
  return input.homePath ? `export HERMES_HOME=${shellQuote(input.homePath)}\n` : "";
}

export function buildHermesSshVersionRemoteCommand(input: HermesSshTarget): string {
  return [
    "set -eu",
    `HERMES_BIN=${shellQuote(input.hermesBinaryPath)}`,
    remoteHermesEnvironmentPrefix(input),
    'if ! command -v "$HERMES_BIN" >/dev/null 2>&1 && [ ! -x "$HERMES_BIN" ]; then',
    '  printf "Hermes binary not found: %s\\n" "$HERMES_BIN" >&2',
    "  exit 127",
    "fi",
    'exec "$HERMES_BIN" --version',
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildHermesSshGatewayRemoteCommand(input: HermesSshTarget): string {
  const hasExplicitRemoteCwd = input.remoteCwd.trim().length > 0;
  const remoteCwd = hasExplicitRemoteCwd ? input.remoteCwd : "$HOME";
  return [
    "set -eu",
    `HERMES_BIN=${shellQuote(input.hermesBinaryPath)}`,
    `REMOTE_CWD=${remoteCwd === "$HOME" ? '"$HOME"' : shellQuote(remoteCwd)}`,
    remoteHermesEnvironmentPrefix(input),
    'if ! command -v "$HERMES_BIN" >/dev/null 2>&1 && [ ! -x "$HERMES_BIN" ]; then',
    '  printf "Hermes binary not found: %s\\n" "$HERMES_BIN" >&2',
    "  exit 127",
    "fi",
    'VERSION_OUTPUT="$("$HERMES_BIN" --version 2>&1)"',
    'SOURCE_ROOT="$(printf "%s\\n" "$VERSION_OUTPUT" | sed -n \'s/^Project:[[:space:]]*//p\' | head -n 1)"',
    'if [ -z "$SOURCE_ROOT" ]; then',
    '  printf "Could not resolve Hermes Agent source root from hermes --version.\\n" >&2',
    "  exit 1",
    "fi",
    'PYTHON_BIN="${HERMES_PYTHON:-}"',
    'if [ -z "$PYTHON_BIN" ]; then',
    '  for candidate in "$SOURCE_ROOT/.venv/bin/python" "$SOURCE_ROOT/.venv/bin/python3" "$SOURCE_ROOT/venv/bin/python" "$SOURCE_ROOT/venv/bin/python3" python3 python; do',
    '    if command -v "$candidate" >/dev/null 2>&1 || [ -x "$candidate" ]; then',
    '      PYTHON_BIN="$candidate"',
    "      break",
    "    fi",
    "  done",
    "fi",
    'if [ -z "$PYTHON_BIN" ]; then',
    '  printf "Python was not found for Hermes gateway startup.\\n" >&2',
    "  exit 127",
    "fi",
    'export HERMES_PYTHON_SRC_ROOT="$SOURCE_ROOT"',
    'export PYTHONPATH="$SOURCE_ROOT${PYTHONPATH:+:$PYTHONPATH}"',
    'export TERMINAL_CWD="$REMOTE_CWD"',
    'export HERMES_CWD="$REMOTE_CWD"',
    'if ! cd "$REMOTE_CWD" 2>/dev/null; then',
    '  printf "Remote Hermes folder not found or inaccessible: %s\\n" "$REMOTE_CWD" >&2',
    "  exit 1",
    "fi",
    'exec "$PYTHON_BIN" -m tui_gateway.entry',
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildHermesSshRemoteShellCommand(remoteCommand: string): string {
  return `sh -lc ${shellQuote(remoteCommand)}`;
}

export function buildHermesSshVersionArgs(input: HermesSshTarget): string[] {
  return [
    ...buildHermesSshBaseArgs(input.target, { knownHostsFile: input.knownHostsFile }),
    buildHermesSshRemoteShellCommand(buildHermesSshVersionRemoteCommand(input)),
  ];
}

export function buildHermesSshGatewaySpawnInput(input: HermesSshTarget): HermesGatewaySpawnInput {
  return {
    command: "ssh",
    args: [
      ...buildHermesSshBaseArgs(input.target, { knownHostsFile: input.knownHostsFile }),
      buildHermesSshRemoteShellCommand(buildHermesSshGatewayRemoteCommand(input)),
    ],
  };
}

export function buildHermesGatewayRuntimeOptions(
  settings: HermesSettings,
  input: Omit<HermesGatewayRuntimeOptions, "spawn" | "hermesBinaryPath" | "homePath">,
): HermesGatewayRuntimeOptions {
  const sshTarget = resolveHermesSshTarget(settings);
  if (!sshTarget) {
    return {
      hermesBinaryPath: settings.binaryPath,
      homePath: settings.homePath,
      ...input,
    };
  }

  return {
    ...input,
    spawn: buildHermesSshGatewaySpawnInput(sshTarget),
  };
}
