import { resolveRemoteT3CliPackageSpec } from "@t3tools/ssh/command";
import { REMOTE_T3_RUNNER_PROFILE, type RemoteServerRunnerOptions } from "@t3tools/ssh/tunnel";
import * as Option from "effect/Option";

import type { DesktopSettings as DesktopSettingsValue } from "../settings/DesktopAppSettings.ts";
import type { DesktopEnvironmentShape } from "../app/DesktopEnvironment.ts";

export function resolveDesktopSshCliRunner(input: {
  readonly environment: Pick<
    DesktopEnvironmentShape,
    "appVersion" | "devRemoteT3ServerEntryPath" | "isDevelopment"
  >;
  readonly settings: Pick<DesktopSettingsValue, "updateChannel">;
  readonly nodeEngineRange: string;
}): RemoteServerRunnerOptions {
  const devRemoteEntryPath = Option.getOrUndefined(input.environment.devRemoteT3ServerEntryPath);
  if (input.environment.isDevelopment && devRemoteEntryPath !== undefined) {
    return {
      profile: REMOTE_T3_RUNNER_PROFILE,
      nodeScriptPath: devRemoteEntryPath,
      nodeEngineRange: input.nodeEngineRange,
    };
  }
  return {
    profile: REMOTE_T3_RUNNER_PROFILE,
    packageSpec: resolveRemoteT3CliPackageSpec({
      appVersion: input.environment.appVersion,
      updateChannel: input.settings.updateChannel,
      isDevelopment: input.environment.isDevelopment,
    }),
    nodeEngineRange: input.nodeEngineRange,
  };
}
