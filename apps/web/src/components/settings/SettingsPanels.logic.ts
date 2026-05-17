import type {
  HermesProfile,
  HermesSettings,
  ProviderDriverKind,
  ProviderInstanceConfig,
  ProviderInstanceId,
  ServerSettings,
  UnifiedSettings,
} from "@t3tools/contracts";
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind as DriverKind,
  ProviderInstanceId as InstanceId,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

const HERMES_DRIVER_KIND = DriverKind.make("hermes");
const HERMES_DEFAULT_INSTANCE_ID = defaultInstanceIdForDriver(HERMES_DRIVER_KIND);

function collapseOtelSignalsUrl(input: {
  readonly tracesUrl: string;
  readonly metricsUrl: string;
}): string | null {
  const tracesSuffix = "/traces";
  const metricsSuffix = "/metrics";
  if (!input.tracesUrl.endsWith(tracesSuffix) || !input.metricsUrl.endsWith(metricsSuffix)) {
    return null;
  }

  const tracesBase = input.tracesUrl.slice(0, -tracesSuffix.length);
  const metricsBase = input.metricsUrl.slice(0, -metricsSuffix.length);
  if (tracesBase !== metricsBase) {
    return null;
  }

  return `${tracesBase}/{traces,metrics}`;
}

export function formatDiagnosticsDescription(input: {
  readonly localTracingEnabled: boolean;
  readonly otlpTracesEnabled: boolean;
  readonly otlpTracesUrl?: string | undefined;
  readonly otlpMetricsEnabled: boolean;
  readonly otlpMetricsUrl?: string | undefined;
}): string {
  const mode = input.localTracingEnabled ? "Local trace file" : "Terminal logs only";
  const tracesUrl = input.otlpTracesEnabled ? input.otlpTracesUrl : undefined;
  const metricsUrl = input.otlpMetricsEnabled ? input.otlpMetricsUrl : undefined;

  if (tracesUrl && metricsUrl) {
    const collapsedUrl = collapseOtelSignalsUrl({ tracesUrl, metricsUrl });
    return collapsedUrl
      ? `${mode}. Exporting OTEL to ${collapsedUrl}.`
      : `${mode}. Exporting OTEL traces to ${tracesUrl} and metrics to ${metricsUrl}.`;
  }

  if (tracesUrl) {
    return `${mode}. Exporting OTEL traces to ${tracesUrl}.`;
  }

  if (metricsUrl) {
    return `${mode}. Exporting OTEL metrics to ${metricsUrl}.`;
  }

  return `${mode}.`;
}

export function buildProviderInstanceUpdatePatch(input: {
  readonly settings: Pick<ServerSettings, "providers" | "providerInstances">;
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly driver: ProviderDriverKind;
  readonly isDefault: boolean;
  readonly textGenerationModelSelection?:
    | ServerSettings["textGenerationModelSelection"]
    | undefined;
}): Partial<UnifiedSettings> {
  type LegacyProviderSettings = ServerSettings["providers"][keyof ServerSettings["providers"]];
  const legacyProviderDefaults = DEFAULT_UNIFIED_SETTINGS.providers as Record<
    string,
    LegacyProviderSettings | undefined
  >;
  const legacyProviderDefault = input.isDefault ? legacyProviderDefaults[input.driver] : undefined;
  return {
    ...(legacyProviderDefault !== undefined
      ? {
          providers: {
            ...input.settings.providers,
            [input.driver]: legacyProviderDefault,
          } as ServerSettings["providers"],
        }
      : {}),
    providerInstances: {
      ...input.settings.providerInstances,
      [input.instanceId]: input.instance,
    },
    ...(input.textGenerationModelSelection !== undefined
      ? { textGenerationModelSelection: input.textGenerationModelSelection }
      : {}),
  };
}

function objectConfig(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function trimTrailingSeparators(value: string): string {
  return value.replace(/[\\/]+$/u, "");
}

function normalizeHomePathForComparison(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";
  const normalized = trimTrailingSeparators(trimmed);
  return normalized || trimmed;
}

function slugifyHermesProfileName(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .replace(/_{2,}/gu, "_");
  return slug || "profile";
}

function makeProviderInstanceId(base: string): ProviderInstanceId {
  return InstanceId.make(base.slice(0, 64).replace(/[_-]+$/u, "") || "hermes_profile");
}

export function findHermesProfileProviderInstanceId(
  settings: Pick<ServerSettings, "providers" | "providerInstances">,
  profile: HermesProfile,
): ProviderInstanceId | undefined {
  const profileHomePath = normalizeHomePathForComparison(profile.homePath);

  if (profile.kind === "default") {
    const defaultInstance = settings.providerInstances?.[HERMES_DEFAULT_INSTANCE_ID];
    const defaultConfig = (objectConfig(defaultInstance?.config) ??
      settings.providers.hermes) as Partial<HermesSettings>;
    const effectiveDefaultConfig = {
      ...DEFAULT_UNIFIED_SETTINGS.providers.hermes,
      ...defaultConfig,
    } satisfies HermesSettings;
    const defaultHomePath = normalizeHomePathForComparison(effectiveDefaultConfig.homePath);
    if (
      !effectiveDefaultConfig.sshEnabled &&
      (defaultHomePath.length === 0 || defaultHomePath === profileHomePath)
    ) {
      return HERMES_DEFAULT_INSTANCE_ID;
    }
  }

  for (const [rawInstanceId, instance] of Object.entries(settings.providerInstances ?? {})) {
    if (instance.driver !== HERMES_DRIVER_KIND) {
      continue;
    }
    const config = objectConfig(instance.config) as Partial<HermesSettings> | undefined;
    if (config?.sshEnabled) {
      continue;
    }
    if (normalizeHomePathForComparison(config?.homePath) === profileHomePath) {
      return rawInstanceId as ProviderInstanceId;
    }
  }

  return undefined;
}

export function deriveHermesProfileProviderInstanceId(
  settings: Pick<ServerSettings, "providerInstances">,
  profile: HermesProfile,
): ProviderInstanceId {
  if (profile.kind === "default") {
    const fallback = makeProviderInstanceId("hermes_default");
    if (!settings.providerInstances?.[fallback]) {
      return fallback;
    }
  }

  const slug = slugifyHermesProfileName(profile.name);
  const base = makeProviderInstanceId(`hermes_${slug}`);
  if (!settings.providerInstances?.[base]) {
    return base;
  }

  for (let index = 2; index < 100; index += 1) {
    const suffix = `_${index}`;
    const candidateBase = `hermes_${slug}`.slice(0, 64 - suffix.length);
    const candidate = makeProviderInstanceId(`${candidateBase}${suffix}`);
    if (!settings.providerInstances?.[candidate]) {
      return candidate;
    }
  }

  return makeProviderInstanceId(`hermes_profile_${Date.now()}`);
}

export function buildHermesProfileProviderSettingsPatch(input: {
  readonly settings: Pick<ServerSettings, "providers" | "providerInstances">;
  readonly profile: HermesProfile;
}): Pick<ServerSettings, "providerInstances"> | null {
  if (findHermesProfileProviderInstanceId(input.settings, input.profile) !== undefined) {
    return null;
  }

  const baseHermesSettings = {
    ...DEFAULT_UNIFIED_SETTINGS.providers.hermes,
    ...input.settings.providers.hermes,
  } satisfies HermesSettings;
  const instanceId = deriveHermesProfileProviderInstanceId(input.settings, input.profile);
  const config = {
    ...baseHermesSettings,
    enabled: true,
    homePath: input.profile.homePath,
    sshEnabled: false,
    sshHost: "",
    sshUsername: "",
    sshPort: "",
    sshHermesBinaryPath: "",
    sshHomePath: "",
    sshRemoteCwd: "",
    sshKnownHostsFile: "",
  } satisfies HermesSettings;

  return {
    providerInstances: {
      ...input.settings.providerInstances,
      [instanceId]: {
        driver: HERMES_DRIVER_KIND,
        displayName: `Hermes - ${input.profile.displayName}`,
        enabled: true,
        config,
      } satisfies ProviderInstanceConfig,
    },
  };
}
