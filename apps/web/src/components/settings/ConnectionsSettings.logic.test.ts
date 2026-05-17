import { describe, expect, it } from "vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";

import {
  buildRemoteHermesDisconnectSettingsPatch,
  buildRemoteHermesProviderSettingsPatch,
} from "./ConnectionsSettings";

const HERMES_INSTANCE_ID = ProviderInstanceId.make("hermes");

describe("Remote Hermes settings helpers", () => {
  it("writes Remote Hermes SSH config to the Hermes provider instance", () => {
    const patch = buildRemoteHermesProviderSettingsPatch({
      settings: {
        providers: DEFAULT_SERVER_SETTINGS.providers,
        providerInstances: {},
      },
      target: {
        alias: "mbp15-rmmbp1.tail2ec6c6.ts.net",
        hostname: "mbp15-rmmbp1.tail2ec6c6.ts.net",
        username: "rmmbp1",
        port: 22,
      },
      hermesBinaryPath: "/opt/homebrew/bin/hermes",
      hermesHomePath: "/Users/rmmbp1/.hermes",
      remoteCwd: "/Users/rmmbp1/project",
      knownHostsFile: "/Users/roman/.t3/dev/ssh/known_hosts",
    });

    expect(patch.providerInstances[HERMES_INSTANCE_ID]).toMatchObject({
      driver: "hermes",
      displayName: "Hermes · mbp15-rmmbp1.tail2ec6c6.ts.net",
      enabled: true,
      config: {
        enabled: true,
        sshEnabled: true,
        sshHost: "mbp15-rmmbp1.tail2ec6c6.ts.net",
        sshUsername: "rmmbp1",
        sshPort: "22",
        sshHermesBinaryPath: "/opt/homebrew/bin/hermes",
        sshHomePath: "/Users/rmmbp1/.hermes",
        sshRemoteCwd: "/Users/rmmbp1/project",
        sshKnownHostsFile: "/Users/roman/.t3/dev/ssh/known_hosts",
      },
    });
  });

  it("does not add remote backend runner package config", () => {
    const patch = buildRemoteHermesProviderSettingsPatch({
      settings: {
        providers: DEFAULT_SERVER_SETTINGS.providers,
        providerInstances: {},
      },
      target: {
        alias: "devbox",
        hostname: "devbox",
        username: null,
        port: null,
      },
    });

    const serialized = JSON.stringify(patch);
    expect(serialized).not.toContain("t-hermes");
    expect(serialized).not.toContain("t-hermes@nightly");
    expect(serialized).not.toContain("npm");
    expect(serialized).not.toContain("npx");
  });

  it("uses a visible Remote Hermes label when replacing the generic Hermes label", () => {
    const patch = buildRemoteHermesProviderSettingsPatch({
      settings: {
        providers: DEFAULT_SERVER_SETTINGS.providers,
        providerInstances: {
          [HERMES_INSTANCE_ID]: {
            driver: ProviderDriverKind.make("hermes"),
            displayName: "Hermes Agent",
            enabled: true,
            config: DEFAULT_SERVER_SETTINGS.providers.hermes,
          },
        },
      },
      target: {
        alias: "remote-hermes",
        hostname: "remote-hermes",
        username: "roman",
        port: 22,
      },
    });

    expect(patch.providerInstances[HERMES_INSTANCE_ID]?.displayName).toBe("Hermes · remote-hermes");
  });

  it("disconnects Remote Hermes without removing the Hermes provider instance", () => {
    const patch = buildRemoteHermesDisconnectSettingsPatch({
      providers: DEFAULT_SERVER_SETTINGS.providers,
      providerInstances: {
        [HERMES_INSTANCE_ID]: {
          driver: ProviderDriverKind.make("hermes"),
          displayName: "Hermes · remote-hermes",
          enabled: true,
          config: {
            ...DEFAULT_SERVER_SETTINGS.providers.hermes,
            sshEnabled: true,
            sshHost: "remote-hermes",
            sshUsername: "roman",
            sshPort: "22",
            sshRemoteCwd: "/work/project",
          },
        },
      },
    });

    expect(patch.providerInstances[HERMES_INSTANCE_ID]).toMatchObject({
      driver: "hermes",
      enabled: true,
      config: {
        sshEnabled: false,
        sshHost: "",
        sshUsername: "",
        sshPort: "",
        sshRemoteCwd: "",
      },
    });
  });
});
