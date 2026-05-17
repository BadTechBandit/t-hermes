import type {
  DesktopDiscoveredSshHost,
  DesktopSshEnvironmentBootstrap,
  DesktopSshEnvironmentTarget,
  DesktopSshTargetPreparationResult,
} from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import {
  SshPasswordPrompt,
  type SshPasswordPromptShape,
  type SshPasswordRequest,
} from "@t3tools/ssh/auth";
import { discoverSshHosts } from "@t3tools/ssh/config";
import { resolveSshTarget } from "@t3tools/ssh/command";
import {
  SshCommandError,
  SshHostDiscoveryError,
  SshHostKeyPromptError,
  SshInvalidTargetError,
  SshLaunchError,
  SshPairingError,
  SshPasswordPromptError,
  SshReadinessError,
} from "@t3tools/ssh/errors";
import {
  ensureTrustedSshHostKey,
  SshHostKeyPrompt,
  type SshHostKeyPromptShape,
  type SshHostKeyTrustRequest,
} from "@t3tools/ssh/hostKey";
import { SshEnvironmentManager, type RemoteT3RunnerOptions } from "@t3tools/ssh/tunnel";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as DesktopSshHostKeyPrompts from "./DesktopSshHostKeyPrompts.ts";
import * as DesktopSshPasswordPrompts from "./DesktopSshPasswordPrompts.ts";

export type DesktopSshEnvironmentRuntimeServices =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | NetService.NetService;

export type DesktopSshEnvironmentOperationError =
  | SshCommandError
  | SshInvalidTargetError
  | SshLaunchError
  | SshPairingError
  | SshReadinessError
  | SshHostKeyPromptError
  | SshPasswordPromptError
  | NetService.NetError;

export type DesktopSshEnvironmentDiscoverError = SshHostDiscoveryError;

export type DesktopSshEnvironmentError =
  | DesktopSshEnvironmentDiscoverError
  | DesktopSshEnvironmentOperationError;

export interface DesktopSshEnvironmentShape {
  readonly discoverHosts: (input?: {
    readonly homeDir?: string;
  }) => Effect.Effect<readonly DesktopDiscoveredSshHost[], DesktopSshEnvironmentDiscoverError>;
  readonly ensureEnvironment: (
    target: DesktopSshEnvironmentTarget,
    options?: { readonly issuePairingToken?: boolean },
  ) => Effect.Effect<DesktopSshEnvironmentBootstrap, DesktopSshEnvironmentOperationError>;
  readonly prepareTarget: (
    target: DesktopSshEnvironmentTarget,
  ) => Effect.Effect<DesktopSshTargetPreparationResult, DesktopSshEnvironmentOperationError>;
  readonly disconnectEnvironment: (
    target: DesktopSshEnvironmentTarget,
  ) => Effect.Effect<void, DesktopSshEnvironmentOperationError>;
}

export class DesktopSshEnvironment extends Context.Service<
  DesktopSshEnvironment,
  DesktopSshEnvironmentShape
>()("t3/desktop/SshEnvironment") {}

export interface DesktopSshEnvironmentLayerOptions {
  readonly resolveCliPackageSpec?: () => string;
  readonly resolveCliRunner?: Effect.Effect<RemoteT3RunnerOptions>;
  readonly knownHostsFile?: string | null;
}

function discoverDesktopSshHostsEffect(input?: { readonly homeDir?: string }) {
  return discoverSshHosts(input ?? {});
}

export function isDesktopSshPasswordPromptCancellation(
  error: unknown,
): error is SshPasswordPromptError {
  return (
    error instanceof SshPasswordPromptError &&
    DesktopSshPasswordPrompts.isDesktopSshPasswordPromptCancellation(error.cause)
  );
}

export function isDesktopSshHostKeyPromptCancellation(
  error: unknown,
): error is SshHostKeyPromptError {
  return (
    error instanceof SshHostKeyPromptError &&
    DesktopSshHostKeyPrompts.isDesktopSshHostKeyPromptCancellation(error.cause)
  );
}

const makeHostKeyPrompt = (
  prompts: DesktopSshHostKeyPrompts.DesktopSshHostKeyPromptsShape,
): SshHostKeyPromptShape => ({
  isAvailable: true,
  request: (request: SshHostKeyTrustRequest) =>
    prompts.request(request).pipe(
      Effect.mapError(
        (cause) =>
          new SshHostKeyPromptError({
            message: cause.message,
            cause,
          }),
      ),
    ),
});

const makePasswordPrompt = (
  prompts: DesktopSshPasswordPrompts.DesktopSshPasswordPromptsShape,
): SshPasswordPromptShape => ({
  isAvailable: true,
  request: (request: SshPasswordRequest) =>
    prompts.request(request).pipe(
      Effect.mapError(
        (cause) =>
          new SshPasswordPromptError({
            message: cause.message,
            cause,
          }),
      ),
    ),
});

const resolveDesktopSshTarget = Effect.fn("desktop.ssh.resolveTarget")(function* (
  target: DesktopSshEnvironmentTarget,
) {
  const baseResolved = yield* resolveSshTarget(target.alias || target.hostname);
  return {
    ...baseResolved,
    ...(target.username !== null ? { username: target.username } : {}),
    ...(target.port !== null ? { port: target.port } : {}),
  } satisfies DesktopSshEnvironmentTarget;
});

const make = (options: DesktopSshEnvironmentLayerOptions = {}) =>
  Effect.gen(function* () {
    const manager = yield* SshEnvironmentManager;
    const hostKeyPrompts = yield* DesktopSshHostKeyPrompts.DesktopSshHostKeyPrompts;
    const passwordPrompts = yield* DesktopSshPasswordPrompts.DesktopSshPasswordPrompts;
    const runtimeContext = yield* Effect.context<DesktopSshEnvironmentRuntimeServices>();
    const hostKeyPrompt = SshHostKeyPrompt.of(makeHostKeyPrompt(hostKeyPrompts));
    const passwordPrompt = SshPasswordPrompt.of(makePasswordPrompt(passwordPrompts));

    return DesktopSshEnvironment.of({
      discoverHosts: (input) =>
        discoverDesktopSshHostsEffect(input).pipe(
          Effect.provide(runtimeContext),
          Effect.withSpan("desktop.ssh.discoverHosts"),
        ),
      ensureEnvironment: (target, ensureOptions) =>
        manager
          .ensureEnvironment(target, ensureOptions)
          .pipe(
            Effect.provideService(SshHostKeyPrompt, hostKeyPrompt),
            Effect.provideService(SshPasswordPrompt, passwordPrompt),
            Effect.provide(runtimeContext),
            Effect.withSpan("desktop.ssh.ensureEnvironment"),
          ),
      prepareTarget: (target) =>
        Effect.gen(function* () {
          const resolvedTarget = yield* resolveDesktopSshTarget(target);
          if (options.knownHostsFile !== undefined && options.knownHostsFile !== null) {
            yield* ensureTrustedSshHostKey(resolvedTarget, {
              knownHostsFile: options.knownHostsFile,
            });
          }
          return {
            target: resolvedTarget,
            knownHostsFile: options.knownHostsFile ?? null,
          } satisfies DesktopSshTargetPreparationResult;
        }).pipe(
          Effect.provideService(SshHostKeyPrompt, hostKeyPrompt),
          Effect.provide(runtimeContext),
          Effect.withSpan("desktop.ssh.prepareTarget"),
        ),
      disconnectEnvironment: (target) =>
        manager
          .disconnectEnvironment(target)
          .pipe(
            Effect.provideService(SshHostKeyPrompt, hostKeyPrompt),
            Effect.provideService(SshPasswordPrompt, passwordPrompt),
            Effect.provide(runtimeContext),
            Effect.withSpan("desktop.ssh.disconnectEnvironment"),
          ),
    });
  });

export const layer = (options: DesktopSshEnvironmentLayerOptions = {}) =>
  Layer.effect(DesktopSshEnvironment, make(options)).pipe(
    Layer.provide(
      SshEnvironmentManager.layer({
        ...(options.resolveCliPackageSpec === undefined
          ? {}
          : { resolveCliPackageSpec: options.resolveCliPackageSpec }),
        ...(options.resolveCliRunner === undefined
          ? {}
          : { resolveCliRunner: options.resolveCliRunner }),
        ...(options.knownHostsFile === undefined ? {} : { knownHostsFile: options.knownHostsFile }),
      }),
    ),
  );
