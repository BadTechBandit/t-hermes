import * as Crypto from "node:crypto";

import type { DesktopSshEnvironmentTarget } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { SshCommandError, SshHostKeyPromptError } from "./errors.ts";

const DEFAULT_KEYSCAN_TIMEOUT_SECONDS = 10;

export interface SshHostKeyFingerprint {
  readonly keyType: string;
  readonly fingerprint: string;
}

export interface SshScannedHostKey extends SshHostKeyFingerprint {
  readonly publicKey: string;
  readonly knownHostsLine: string;
}

export interface SshHostKeyTrustRequest {
  readonly destination: string;
  readonly hostname: string;
  readonly username: string | null;
  readonly port: number | null;
  readonly fingerprints: ReadonlyArray<SshHostKeyFingerprint>;
}

export interface SshHostKeyPromptShape {
  readonly isAvailable: boolean;
  readonly request: (
    request: SshHostKeyTrustRequest,
  ) => Effect.Effect<boolean, SshHostKeyPromptError>;
}

export class SshHostKeyPrompt extends Context.Service<SshHostKeyPrompt, SshHostKeyPromptShape>()(
  "@t3tools/ssh/SshHostKeyPrompt",
) {
  static readonly disabledLayer = Layer.succeed(
    SshHostKeyPrompt,
    SshHostKeyPrompt.of({
      isAvailable: false,
      request: () =>
        Effect.fail(
          new SshHostKeyPromptError({
            message: "SSH host key trust prompt is not available.",
          }),
        ),
    }),
  );
}

export interface SshHostKeyOptions {
  readonly knownHostsFile?: string | null;
}

export function formatKnownHostsHost(host: string, port: number | null): string {
  const normalizedHost = host.trim();
  const normalizedPort = port ?? 22;
  return normalizedPort === 22 ? normalizedHost : `[${normalizedHost}]:${normalizedPort}`;
}

export function buildSshHostKeyArgs(input?: SshHostKeyOptions): string[] {
  const knownHostsFile = input?.knownHostsFile?.trim();
  if (!knownHostsFile) {
    return [];
  }
  return ["-o", `UserKnownHostsFile=${knownHostsFile}`, "-o", "StrictHostKeyChecking=yes"];
}

function fingerprintPublicKey(publicKey: string): string {
  const digest = Crypto.createHash("sha256")
    .update(Buffer.from(publicKey, "base64"))
    .digest("base64")
    .replace(/=+$/u, "");
  return `SHA256:${digest}`;
}

export function parseSshKeyscanOutput(
  stdout: string,
  knownHost: string,
): ReadonlyArray<SshScannedHostKey> {
  const keys = new Map<string, SshScannedHostKey>();
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const [, keyType = "", publicKey = ""] = trimmed.split(/\s+/u);
    if (keyType.length === 0 || publicKey.length === 0) {
      continue;
    }
    if (!keyType.startsWith("ssh-") && !keyType.startsWith("ecdsa-")) {
      continue;
    }
    const keyId = `${keyType}\u0000${publicKey}`;
    if (keys.has(keyId)) {
      continue;
    }
    keys.set(keyId, {
      keyType,
      publicKey,
      fingerprint: fingerprintPublicKey(publicKey),
      knownHostsLine: `${knownHost} ${keyType} ${publicKey}`,
    });
  }
  return [...keys.values()];
}

function knownHostsLineHostField(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) {
    return null;
  }
  const parts = trimmed.split(/\s+/u);
  if (parts[0]?.startsWith("@")) {
    return parts[1] ?? null;
  }
  return parts[0] ?? null;
}

export function knownHostsContainsHost(rawKnownHosts: string, knownHost: string): boolean {
  for (const line of rawKnownHosts.split(/\r?\n/u)) {
    const hostField = knownHostsLineHostField(line);
    if (!hostField || hostField.startsWith("|")) {
      continue;
    }
    if (hostField.split(",").some((entry) => entry.trim() === knownHost)) {
      return true;
    }
  }
  return false;
}

const collectProcessOutput = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

function makeKeyscanCommandError(
  args: ReadonlyArray<string>,
  cause: unknown,
  message = "Failed to run ssh-keyscan.",
): SshCommandError {
  return new SshCommandError({
    command: ["ssh-keyscan", ...args],
    exitCode: null,
    stderr: "",
    message: cause instanceof Error ? cause.message : message,
    cause,
  });
}

function makeKnownHostsFileError(knownHostsFile: string, cause: unknown): SshHostKeyPromptError {
  return new SshHostKeyPromptError({
    message: `Failed to update SSH known_hosts file at ${knownHostsFile}.`,
    cause,
  });
}

export const scanSshHostKeys = Effect.fn("ssh/hostKey.scan")(function* (
  target: DesktopSshEnvironmentTarget,
): Effect.fn.Return<
  ReadonlyArray<SshScannedHostKey>,
  SshCommandError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  const scanHost = target.hostname.trim() || target.alias.trim();
  const knownHost = formatKnownHostsHost(target.alias.trim() || scanHost, target.port);
  const port = target.port ?? 22;
  const args = [
    "-T",
    String(DEFAULT_KEYSCAN_TIMEOUT_SECONDS),
    ...(port === 22 ? [] : ["-p", String(port)]),
    scanHost,
  ];
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const [stdout, stderr, exitCode] = yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner
        .spawn(
          ChildProcess.make("ssh-keyscan", args, {
            shell: process.platform === "win32",
          }),
        )
        .pipe(Effect.mapError((cause) => makeKeyscanCommandError(args, cause)));
      return yield* Effect.all(
        [
          collectProcessOutput(child.stdout),
          collectProcessOutput(child.stderr),
          child.exitCode.pipe(Effect.map(Number)),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.mapError((cause) => makeKeyscanCommandError(args, cause)));
    }),
  );
  const keys = parseSshKeyscanOutput(stdout, knownHost);
  if (exitCode !== 0 && keys.length === 0) {
    return yield* new SshCommandError({
      command: ["ssh-keyscan", ...args],
      exitCode,
      stderr,
      message: stderr.trim() || `Could not read the SSH host key for ${scanHost}:${String(port)}.`,
    });
  }
  if (keys.length === 0) {
    return yield* new SshCommandError({
      command: ["ssh-keyscan", ...args],
      exitCode,
      stderr,
      message: `Could not read the SSH host key for ${scanHost}:${String(port)}.`,
    });
  }
  return keys;
});

export const ensureTrustedSshHostKey = Effect.fn("ssh/hostKey.ensureTrusted")(function* (
  target: DesktopSshEnvironmentTarget,
  input: { readonly knownHostsFile?: string | null },
): Effect.fn.Return<
  void,
  SshCommandError | SshHostKeyPromptError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path | SshHostKeyPrompt
> {
  const knownHostsFile = input.knownHostsFile?.trim();
  if (!knownHostsFile) {
    return;
  }

  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const knownHost = formatKnownHostsHost(
    target.alias.trim() || target.hostname.trim(),
    target.port,
  );
  yield* fs
    .makeDirectory(path.dirname(knownHostsFile), { recursive: true })
    .pipe(Effect.mapError((cause) => makeKnownHostsFileError(knownHostsFile, cause)));
  const knownHostsExists = yield* fs
    .exists(knownHostsFile)
    .pipe(Effect.mapError((cause) => makeKnownHostsFileError(knownHostsFile, cause)));
  const existingRaw = knownHostsExists
    ? yield* fs
        .readFileString(knownHostsFile)
        .pipe(Effect.mapError((cause) => makeKnownHostsFileError(knownHostsFile, cause)))
    : "";
  if (knownHostsContainsHost(existingRaw, knownHost)) {
    return;
  }

  const prompt = yield* SshHostKeyPrompt;
  if (!prompt.isAvailable) {
    return yield* new SshHostKeyPromptError({
      message: `SSH host key for ${knownHost} is not trusted yet.`,
    });
  }

  const keys = yield* scanSshHostKeys(target);
  const trusted = yield* prompt.request({
    destination: target.alias.trim() || target.hostname.trim(),
    hostname: target.hostname.trim() || target.alias.trim(),
    username: target.username,
    port: target.port,
    fingerprints: keys.map(({ keyType, fingerprint }) => ({ keyType, fingerprint })),
  });
  if (!trusted) {
    return yield* new SshHostKeyPromptError({
      message: `SSH host key trust was cancelled for ${knownHost}.`,
    });
  }

  const prefix =
    existingRaw.length === 0 || existingRaw.endsWith("\n") ? existingRaw : `${existingRaw}\n`;
  yield* fs
    .writeFileString(
      knownHostsFile,
      `${prefix}${keys.map((key) => key.knownHostsLine).join("\n")}\n`,
    )
    .pipe(Effect.mapError((cause) => makeKnownHostsFileError(knownHostsFile, cause)));
  yield* fs.chmod(knownHostsFile, 0o600).pipe(Effect.ignore);
});
