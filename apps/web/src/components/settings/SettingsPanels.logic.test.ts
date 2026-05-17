import {
  DEFAULT_SERVER_SETTINGS,
  type HermesProfile,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import {
  buildHermesProfileProviderSettingsPatch,
  buildProviderInstanceUpdatePatch,
  findHermesProfileProviderInstanceId,
  formatDiagnosticsDescription,
} from "./SettingsPanels.logic";

describe("formatDiagnosticsDescription", () => {
  it("collapses trace and metric URLs that share the same OTEL base path", () => {
    expect(
      formatDiagnosticsDescription({
        localTracingEnabled: true,
        otlpTracesEnabled: true,
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsEnabled: true,
        otlpMetricsUrl: "http://localhost:4318/v1/metrics",
      }),
    ).toBe("Local trace file. Exporting OTEL to http://localhost:4318/v1/{traces,metrics}.");
  });

  it("keeps separate trace and metric URLs when their base paths differ", () => {
    expect(
      formatDiagnosticsDescription({
        localTracingEnabled: true,
        otlpTracesEnabled: true,
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsEnabled: true,
        otlpMetricsUrl: "http://localhost:9000/v1/metrics",
      }),
    ).toBe(
      "Local trace file. Exporting OTEL traces to http://localhost:4318/v1/traces and metrics to http://localhost:9000/v1/metrics.",
    );
  });

  it("omits OTEL text when no exporter is enabled", () => {
    expect(
      formatDiagnosticsDescription({
        localTracingEnabled: true,
        otlpTracesEnabled: false,
        otlpMetricsEnabled: false,
      }),
    ).toBe("Local trace file.");
  });
});

describe("buildProviderInstanceUpdatePatch", () => {
  it("promotes an edited default provider into providerInstances and resets the legacy provider", () => {
    const instanceId = ProviderInstanceId.make("codex");
    const nextInstance = {
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: {
        binaryPath: "/opt/t3/codex",
      },
    } satisfies ProviderInstanceConfig;

    const patch = buildProviderInstanceUpdatePatch({
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          codex: {
            ...DEFAULT_SERVER_SETTINGS.providers.codex,
            binaryPath: "/legacy/codex",
          },
        },
      },
      instanceId,
      instance: nextInstance,
      driver: ProviderDriverKind.make("codex"),
      isDefault: true,
    });

    expect(patch.providerInstances?.[instanceId]).toEqual(nextInstance);
    expect(patch.providers?.codex).toEqual(DEFAULT_SERVER_SETTINGS.providers.codex);
  });

  it("updates custom instances without touching legacy provider settings", () => {
    const instanceId = ProviderInstanceId.make("codex_personal");
    const nextInstance = {
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: {
        homePath: "/Users/example/.codex-personal",
      },
    } satisfies ProviderInstanceConfig;

    const patch = buildProviderInstanceUpdatePatch({
      settings: DEFAULT_SERVER_SETTINGS,
      instanceId,
      instance: nextInstance,
      driver: ProviderDriverKind.make("codex"),
      isDefault: false,
    });

    expect(patch.providerInstances?.[instanceId]).toEqual(nextInstance);
    expect(patch.providers).toBeUndefined();
  });
});

describe("Hermes profile provider instances", () => {
  const coderProfile = {
    id: "coder",
    name: "coder",
    displayName: "coder",
    homePath: "/Users/example/.hermes/profiles/coder",
    kind: "profile",
  } satisfies HermesProfile;

  it("adds a Hermes profile as an isolated provider instance", () => {
    const patch = buildHermesProfileProviderSettingsPatch({
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          hermes: {
            ...DEFAULT_SERVER_SETTINGS.providers.hermes,
            binaryPath: "/opt/bin/hermes",
            authMethodId: "openai-codex",
            sshEnabled: true,
            sshHost: "remote.example.com",
            sshHomePath: "/remote/hermes",
          },
        },
      },
      profile: coderProfile,
    });

    const instance = patch?.providerInstances?.[ProviderInstanceId.make("hermes_coder")];
    expect(instance).toMatchObject({
      driver: ProviderDriverKind.make("hermes"),
      displayName: "Hermes - coder",
      enabled: true,
    });
    expect(instance?.config).toMatchObject({
      binaryPath: "/opt/bin/hermes",
      authMethodId: "openai-codex",
      homePath: "/Users/example/.hermes/profiles/coder",
      sshEnabled: false,
      sshHost: "",
      sshHomePath: "",
    });
  });

  it("does not add a duplicate provider for an existing profile home", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [ProviderInstanceId.make("hermes_coder")]: {
          driver: ProviderDriverKind.make("hermes"),
          enabled: true,
          config: {
            ...DEFAULT_SERVER_SETTINGS.providers.hermes,
            homePath: "/Users/example/.hermes/profiles/coder/",
          },
        },
      },
    };

    expect(findHermesProfileProviderInstanceId(settings, coderProfile)).toBe(
      ProviderInstanceId.make("hermes_coder"),
    );
    expect(buildHermesProfileProviderSettingsPatch({ settings, profile: coderProfile })).toBeNull();
  });

  it("treats the default Hermes profile as the built-in Hermes provider", () => {
    const defaultProfile = {
      id: "default",
      name: "default",
      displayName: "Default",
      homePath: "/Users/example/.hermes",
      kind: "default",
    } satisfies HermesProfile;

    expect(findHermesProfileProviderInstanceId(DEFAULT_SERVER_SETTINGS, defaultProfile)).toBe(
      ProviderInstanceId.make("hermes"),
    );
    expect(
      buildHermesProfileProviderSettingsPatch({
        settings: DEFAULT_SERVER_SETTINGS,
        profile: defaultProfile,
      }),
    ).toBeNull();
  });

  it("can add the local default profile when the built-in Hermes instance is remote", () => {
    const defaultProfile = {
      id: "default",
      name: "default",
      displayName: "Default",
      homePath: "/Users/example/.hermes",
      kind: "default",
    } satisfies HermesProfile;
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [ProviderInstanceId.make("hermes")]: {
          driver: ProviderDriverKind.make("hermes"),
          enabled: true,
          config: {
            ...DEFAULT_SERVER_SETTINGS.providers.hermes,
            sshEnabled: true,
            sshHost: "remote.example.com",
          },
        },
      },
    };

    const patch = buildHermesProfileProviderSettingsPatch({ settings, profile: defaultProfile });

    expect(findHermesProfileProviderInstanceId(settings, defaultProfile)).toBeUndefined();
    expect(patch?.providerInstances?.[ProviderInstanceId.make("hermes_default")]).toMatchObject({
      driver: ProviderDriverKind.make("hermes"),
      displayName: "Hermes - Default",
      config: {
        homePath: "/Users/example/.hermes",
        sshEnabled: false,
        sshHost: "",
      },
    });
  });
});
