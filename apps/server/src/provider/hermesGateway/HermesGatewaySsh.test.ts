import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { HermesSettings } from "@t3tools/contracts";

import {
  buildHermesGatewayRuntimeOptions,
  buildHermesSshGatewayRemoteCommand,
  buildHermesSshGatewaySpawnInput,
  buildHermesSshVersionArgs,
  resolveHermesSshTarget,
} from "./HermesGatewaySsh.ts";

const decodeHermesSettings = Schema.decodeSync(HermesSettings);

describe("HermesGatewaySsh", () => {
  it("builds a direct remote Hermes gateway command without T-Hermes or npm fallbacks", () => {
    const settings = decodeHermesSettings({
      sshEnabled: true,
      sshHost: "devbox",
      sshUsername: "roman",
      sshPort: "2222",
      sshHermesBinaryPath: "/opt/hermes/bin/hermes",
      sshHomePath: "/Users/roman/.hermes",
      sshRemoteCwd: "/work/project",
      sshKnownHostsFile: "/Users/roman/.t3/dev/ssh/known_hosts",
    });
    const target = resolveHermesSshTarget(settings);

    expect(target).toBeDefined();
    const spawn = buildHermesSshGatewaySpawnInput(target!);
    const commandText = [spawn.command, ...spawn.args].join(" ");
    const remoteCommand = buildHermesSshGatewayRemoteCommand(target!);

    expect(spawn.command).toBe("ssh");
    expect(spawn.args).toContain("roman@devbox");
    expect(spawn.args).toContain("2222");
    expect(spawn.args).toContain("UserKnownHostsFile=/Users/roman/.t3/dev/ssh/known_hosts");
    expect(spawn.args).toContain("StrictHostKeyChecking=yes");
    expect(remoteCommand).toContain("HERMES_BIN='/opt/hermes/bin/hermes'");
    expect(remoteCommand).toContain('"$HERMES_BIN" --version');
    expect(remoteCommand).toContain("REMOTE_CWD='/work/project'");
    expect(remoteCommand).toContain("Remote Hermes folder not found or inaccessible");
    expect(remoteCommand).toContain("python");
    expect(remoteCommand).toContain("-m tui_gateway.entry");
    expect(commandText).not.toMatch(/\bt-hermes\b/u);
    expect(commandText).not.toMatch(/t-hermes@/u);
    expect(commandText).not.toMatch(/\bnpm\b/u);
    expect(commandText).not.toMatch(/\bnpx\b/u);
    expect(remoteCommand).not.toMatch(/\bt-hermes\b/u);
    expect(remoteCommand).not.toMatch(/t-hermes@/u);
    expect(remoteCommand).not.toMatch(/\bnpm\b/u);
    expect(remoteCommand).not.toMatch(/\bnpx\b/u);
  });

  it("probes the installed remote hermes binary directly", () => {
    const settings = decodeHermesSettings({
      sshEnabled: true,
      sshHost: "hermes-host",
      sshUsername: "rm",
    });
    const target = resolveHermesSshTarget(settings)!;
    const args = buildHermesSshVersionArgs(target);
    const commandText = ["ssh", ...args].join(" ");

    expect(commandText).toContain("rm@hermes-host");
    expect(commandText).toContain("hermes");
    expect(commandText).toContain("--version");
    expect(commandText).not.toContain("node");
    expect(commandText).not.toContain("t-hermes");
    expect(commandText).not.toContain("npm");
    expect(commandText).not.toContain("npx");
  });

  it("keeps local gateway options local when SSH is disabled", () => {
    const settings = decodeHermesSettings({
      binaryPath: "/usr/local/bin/hermes",
      homePath: "/Users/roman/.hermes",
    });

    expect(
      buildHermesGatewayRuntimeOptions(settings, {
        cwd: "/repo",
        environment: { TEST: "1" },
      }),
    ).toEqual({
      hermesBinaryPath: "/usr/local/bin/hermes",
      homePath: "/Users/roman/.hermes",
      cwd: "/repo",
      environment: { TEST: "1" },
    });
  });
});
