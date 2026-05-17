import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { REMOTE_T3_RUNNER_PROFILE } from "@t3tools/ssh/tunnel";

import { resolveDesktopSshCliRunner } from "./DesktopSshRunner.ts";

const TEST_NODE_ENGINE_RANGE = "^22.16 || ^23.11 || >=24.10";

describe("DesktopSshRunner", () => {
  it("keeps generic SSH environments on the T3 remote runner profile", () => {
    const runner = resolveDesktopSshCliRunner({
      environment: {
        appVersion: "0.0.23",
        devRemoteT3ServerEntryPath: Option.none(),
        isDevelopment: false,
      },
      settings: { updateChannel: "latest" },
      nodeEngineRange: TEST_NODE_ENGINE_RANGE,
    });

    assert.deepEqual(runner, {
      profile: REMOTE_T3_RUNNER_PROFILE,
      packageSpec: "t3@0.0.23",
      nodeEngineRange: TEST_NODE_ENGINE_RANGE,
    });
  });

  it("keeps dev SSH launches on the local server entrypoint", () => {
    const runner = resolveDesktopSshCliRunner({
      environment: {
        appVersion: "0.0.0-dev",
        devRemoteT3ServerEntryPath: Option.some("/tmp/t-hermes/dist/bin.mjs"),
        isDevelopment: true,
      },
      settings: { updateChannel: "latest" },
      nodeEngineRange: TEST_NODE_ENGINE_RANGE,
    });

    assert.deepEqual(runner, {
      profile: REMOTE_T3_RUNNER_PROFILE,
      nodeScriptPath: "/tmp/t-hermes/dist/bin.mjs",
      nodeEngineRange: TEST_NODE_ENGINE_RANGE,
    });
  });
});
