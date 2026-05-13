import { type HermesSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";

import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
} from "./AcpSessionRuntime.ts";

type HermesAcpRuntimeSettings = Pick<HermesSettings, "authMethodId" | "binaryPath" | "homePath">;

export interface HermesAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "authMethodId" | "discardNonJsonStdoutLines" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly hermesSettings: HermesAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildHermesAcpSpawnInput(
  hermesSettings: HermesAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSpawnInput {
  const env = {
    ...(environment ?? {}),
    ...(hermesSettings?.homePath ? { HERMES_HOME: hermesSettings.homePath } : {}),
  };
  return {
    command: hermesSettings?.binaryPath || "hermes",
    args: ["acp"],
    cwd,
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

export const resolveHermesAcpAuthMethodId = (
  hermesSettings: HermesAcpRuntimeSettings | null | undefined,
): string => hermesSettings?.authMethodId?.trim() || "openai-codex";

export const makeHermesAcpRuntime = (
  input: HermesAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, EffectAcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildHermesAcpSpawnInput(input.hermesSettings, input.cwd, input.environment),
        authMethodId: resolveHermesAcpAuthMethodId(input.hermesSettings),
        discardNonJsonStdoutLines: true,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(acpContext));
  });
