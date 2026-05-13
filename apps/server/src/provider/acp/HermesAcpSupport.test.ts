import { describe, expect, it } from "vitest";

import { buildHermesAcpSpawnInput, resolveHermesAcpAuthMethodId } from "./HermesAcpSupport.ts";

describe("buildHermesAcpSpawnInput", () => {
  it("builds the default Hermes ACP command", () => {
    expect(buildHermesAcpSpawnInput(undefined, "/tmp/project")).toEqual({
      command: "hermes",
      args: ["acp"],
      cwd: "/tmp/project",
    });
  });

  it("passes configured binary and HERMES_HOME without hardcoding a user path", () => {
    expect(
      buildHermesAcpSpawnInput(
        {
          binaryPath: "/opt/homebrew/bin/hermes",
          homePath: "~/.hermes-work",
          authMethodId: "",
        },
        "/tmp/project",
        { FOO: "bar" },
      ),
    ).toEqual({
      command: "/opt/homebrew/bin/hermes",
      args: ["acp"],
      cwd: "/tmp/project",
      env: { FOO: "bar", HERMES_HOME: "~/.hermes-work" },
    });
  });
});

describe("resolveHermesAcpAuthMethodId", () => {
  it("defaults to the Hermes-compatible ACP auth method", () => {
    expect(resolveHermesAcpAuthMethodId(undefined)).toBe("openai-codex");
  });

  it("uses an explicit auth method id when configured", () => {
    expect(
      resolveHermesAcpAuthMethodId({
        binaryPath: "hermes",
        homePath: "",
        authMethodId: "hermes-local",
      }),
    ).toBe("hermes-local");
  });
});
