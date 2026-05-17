import type { DesktopSshHostKeyPromptRequest } from "@t3tools/contracts";
import { DesktopSshHostKeyPromptResolutionInputSchema } from "@t3tools/contracts";
import type { SshHostKeyTrustRequest } from "@t3tools/ssh/hostKey";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";

const DEFAULT_SSH_HOST_KEY_PROMPT_TIMEOUT_MS = 3 * 60 * 1000;
const WINDOW_UNAVAILABLE_MESSAGE = "T-Hermes window is not available for SSH host key trust.";

type DesktopSshHostKeyPromptResolutionInput =
  typeof DesktopSshHostKeyPromptResolutionInputSchema.Type;

export class DesktopSshHostKeyPromptWindowUnavailableError extends Data.TaggedError(
  "DesktopSshHostKeyPromptWindowUnavailableError",
)<{
  readonly destination: string;
}> {
  override get message() {
    return WINDOW_UNAVAILABLE_MESSAGE;
  }
}

export class DesktopSshHostKeyPromptSendError extends Data.TaggedError(
  "DesktopSshHostKeyPromptSendError",
)<{
  readonly requestId: string;
  readonly destination: string;
  readonly cause: unknown;
}> {
  override get message() {
    return WINDOW_UNAVAILABLE_MESSAGE;
  }
}

export class DesktopSshHostKeyPromptTimedOutError extends Data.TaggedError(
  "DesktopSshHostKeyPromptTimedOutError",
)<{
  readonly requestId: string;
  readonly destination: string;
}> {
  override get message() {
    return `SSH host key trust timed out for ${this.destination}.`;
  }
}

export class DesktopSshHostKeyPromptCancelledError extends Data.TaggedError(
  "DesktopSshHostKeyPromptCancelledError",
)<{
  readonly requestId: string;
  readonly destination: string;
  readonly reason: string;
}> {
  override get message() {
    return this.reason;
  }
}

export class DesktopSshHostKeyPromptInvalidRequestIdError extends Data.TaggedError(
  "DesktopSshHostKeyPromptInvalidRequestIdError",
)<{
  readonly requestId: string;
}> {
  override get message() {
    return "Invalid SSH host key prompt id.";
  }
}

export class DesktopSshHostKeyPromptExpiredError extends Data.TaggedError(
  "DesktopSshHostKeyPromptExpiredError",
)<{
  readonly requestId: string;
}> {
  override get message() {
    return "SSH host key prompt expired. Try connecting again.";
  }
}

export type DesktopSshHostKeyPromptRequestError =
  | DesktopSshHostKeyPromptWindowUnavailableError
  | DesktopSshHostKeyPromptSendError
  | DesktopSshHostKeyPromptTimedOutError
  | DesktopSshHostKeyPromptCancelledError;

export type DesktopSshHostKeyPromptResolveError =
  | DesktopSshHostKeyPromptInvalidRequestIdError
  | DesktopSshHostKeyPromptExpiredError;

export type DesktopSshHostKeyPromptError =
  | DesktopSshHostKeyPromptRequestError
  | DesktopSshHostKeyPromptResolveError;

export function isDesktopSshHostKeyPromptCancellation(
  error: unknown,
): error is DesktopSshHostKeyPromptCancelledError | DesktopSshHostKeyPromptTimedOutError {
  return (
    error instanceof DesktopSshHostKeyPromptCancelledError ||
    error instanceof DesktopSshHostKeyPromptTimedOutError
  );
}

export interface DesktopSshHostKeyPromptsShape {
  readonly request: (
    request: SshHostKeyTrustRequest,
  ) => Effect.Effect<boolean, DesktopSshHostKeyPromptRequestError>;
  readonly resolve: (
    input: DesktopSshHostKeyPromptResolutionInput,
  ) => Effect.Effect<void, DesktopSshHostKeyPromptResolveError>;
  readonly cancelPending: (reason: string) => Effect.Effect<void>;
}

export class DesktopSshHostKeyPrompts extends Context.Service<
  DesktopSshHostKeyPrompts,
  DesktopSshHostKeyPromptsShape
>()("t3/desktop/SshHostKeyPrompts") {}

interface PendingSshHostKeyPrompt {
  readonly requestId: string;
  readonly destination: string;
  readonly deferred: Deferred.Deferred<boolean, DesktopSshHostKeyPromptRequestError>;
}

interface LayerOptions {
  readonly hostKeyPromptTimeoutMs?: number;
}

const removePending = (
  pendingRef: Ref.Ref<Map<string, PendingSshHostKeyPrompt>>,
  requestId: string,
) =>
  Ref.modify(pendingRef, (pending) => {
    const entry = pending.get(requestId);
    if (entry === undefined) {
      return [Option.none<PendingSshHostKeyPrompt>(), pending] as const;
    }

    const nextPending = new Map(pending);
    nextPending.delete(requestId);
    return [Option.some(entry), nextPending] as const;
  });

const failPending = (
  pending: PendingSshHostKeyPrompt,
  error: DesktopSshHostKeyPromptRequestError,
) => Deferred.fail(pending.deferred, error).pipe(Effect.asVoid);

const make = Effect.fn("desktop.sshHostKeyPrompts.make")(function* (options: LayerOptions = {}) {
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const pendingRef = yield* Ref.make(new Map<string, PendingSshHostKeyPrompt>());
  const hostKeyPromptTimeoutMs =
    options.hostKeyPromptTimeoutMs ?? DEFAULT_SSH_HOST_KEY_PROMPT_TIMEOUT_MS;

  const cancelPending = (reason: string): Effect.Effect<void> =>
    Ref.getAndSet(pendingRef, new Map()).pipe(
      Effect.flatMap((pending) =>
        Effect.forEach(
          pending.values(),
          (entry) =>
            failPending(
              entry,
              new DesktopSshHostKeyPromptCancelledError({
                requestId: entry.requestId,
                destination: entry.destination,
                reason,
              }),
            ),
          { discard: true },
        ),
      ),
      Effect.asVoid,
    );

  yield* Effect.addFinalizer(() =>
    cancelPending("SSH host key prompt service stopped.").pipe(Effect.ignore),
  );

  const resolve = Effect.fn("desktop.sshHostKeyPrompts.resolve")(function* (
    input: DesktopSshHostKeyPromptResolutionInput,
  ): Effect.fn.Return<void, DesktopSshHostKeyPromptResolveError> {
    const requestId = input.requestId.trim();
    if (requestId.length === 0) {
      return yield* new DesktopSshHostKeyPromptInvalidRequestIdError({
        requestId: input.requestId,
      });
    }

    const pending = yield* removePending(pendingRef, requestId);
    if (Option.isNone(pending)) {
      return yield* new DesktopSshHostKeyPromptExpiredError({ requestId });
    }

    const entry = pending.value;
    if (!input.trusted) {
      yield* failPending(
        entry,
        new DesktopSshHostKeyPromptCancelledError({
          requestId,
          destination: entry.destination,
          reason: `SSH host key trust cancelled for ${entry.destination}.`,
        }),
      );
      return;
    }

    yield* Deferred.succeed(entry.deferred, true).pipe(Effect.asVoid);
  });

  const request = Effect.fn("desktop.sshHostKeyPrompts.request")(function* (
    input: SshHostKeyTrustRequest,
  ): Effect.fn.Return<boolean, DesktopSshHostKeyPromptRequestError> {
    const window = yield* electronWindow.main;
    if (Option.isNone(window) || window.value.isDestroyed()) {
      return yield* new DesktopSshHostKeyPromptWindowUnavailableError({
        destination: input.destination,
      });
    }

    const requestId = yield* Random.nextUUIDv4;
    const now = yield* DateTime.now;
    const expiresAt = DateTime.formatIso(
      DateTime.add(now, { milliseconds: hostKeyPromptTimeoutMs }),
    );
    const promptRequest: DesktopSshHostKeyPromptRequest = {
      requestId,
      destination: input.destination,
      hostname: input.hostname,
      username: input.username,
      port: input.port,
      fingerprints: input.fingerprints,
      expiresAt,
    };
    const deferred = yield* Deferred.make<boolean, DesktopSshHostKeyPromptRequestError>();
    const pending: PendingSshHostKeyPrompt = {
      requestId,
      destination: input.destination,
      deferred,
    };
    yield* Ref.update(pendingRef, (entries) => new Map(entries).set(requestId, pending));

    const context = yield* Effect.context();
    const runFork = Effect.runForkWith(context);

    const cancelOnWindowClosed = () => {
      runFork(
        removePending(pendingRef, requestId).pipe(
          Effect.flatMap((entry) =>
            Option.match(entry, {
              onNone: () => Effect.void,
              onSome: (pendingEntry) =>
                failPending(
                  pendingEntry,
                  new DesktopSshHostKeyPromptCancelledError({
                    requestId,
                    destination: input.destination,
                    reason: "SSH host key trust was cancelled because the app window closed.",
                  }),
                ),
            }),
          ),
        ),
      );
    };
    const cleanup = Effect.sync(() => {
      if (!window.value.isDestroyed()) {
        window.value.removeListener("closed", cancelOnWindowClosed);
      }
    }).pipe(Effect.andThen(removePending(pendingRef, requestId)), Effect.asVoid);
    const waitForTrust = Deferred.await(deferred).pipe(
      Effect.timeoutOption(Duration.millis(hostKeyPromptTimeoutMs)),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new DesktopSshHostKeyPromptTimedOutError({
                requestId,
                destination: input.destination,
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

    return yield* Effect.try({
      try: () => {
        if (window.value.isDestroyed()) {
          throw new Error(WINDOW_UNAVAILABLE_MESSAGE);
        }
        window.value.once("closed", cancelOnWindowClosed);
        window.value.webContents.send(IpcChannels.SSH_HOST_KEY_PROMPT_CHANNEL, promptRequest);
        if (window.value.isDestroyed()) {
          throw new Error(WINDOW_UNAVAILABLE_MESSAGE);
        }
        if (window.value.isMinimized()) {
          window.value.restore();
        }
        if (window.value.isDestroyed()) {
          throw new Error(WINDOW_UNAVAILABLE_MESSAGE);
        }
        window.value.focus();
      },
      catch: (cause) =>
        new DesktopSshHostKeyPromptSendError({
          requestId,
          destination: input.destination,
          cause,
        }),
    }).pipe(Effect.andThen(waitForTrust), Effect.ensuring(cleanup));
  });

  return DesktopSshHostKeyPrompts.of({
    request,
    resolve,
    cancelPending,
  });
});

export const layer = (options: LayerOptions = {}) =>
  Layer.effect(DesktopSshHostKeyPrompts, make(options));
