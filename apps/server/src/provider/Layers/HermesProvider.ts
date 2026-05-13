import {
  type HermesSettings,
  type ModelCapabilities,
  ProviderDriverKind,
  type ServerProviderModel,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";

import {
  startHermesGatewayRuntime,
  type HermesGatewayRuntimeOptions,
} from "../hermesGateway/HermesGatewayRuntime.ts";
import type {
  HermesGatewayCommandsCatalogResult,
  HermesGatewayModelOptionsResult,
  HermesGatewaySkillsListResult,
} from "../hermesGateway/HermesGatewayProtocol.ts";
import { isHermesGatewayRuntimeEnabled } from "../hermesGateway/HermesGatewayMode.ts";
import {
  buildServerProvider,
  collectStreamAsString,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  type CommandResult,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const PROVIDER = ProviderDriverKind.make("hermes");
const HERMES_PRESENTATION = {
  displayName: "Hermes",
  badgeLabel: "Experimental",
  showInteractionModeToggle: true,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});
const VERSION_TIMEOUT_MS = 4_000;
const GATEWAY_DISCOVERY_TIMEOUT_MS = 8_000;
const HERMES_FALLBACK_MODEL_SLUG = "hermes-agent";

class HermesGatewayDiscoveryError extends Data.TaggedError("HermesGatewayDiscoveryError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const HERMES_ACP_SLASH_COMMANDS = [
  { name: "help", description: "List available commands" },
  {
    name: "model",
    description: "Show current model and provider, or switch models",
    input: { hint: "model name to switch to" },
  },
  { name: "tools", description: "List available tools with descriptions" },
  { name: "context", description: "Show conversation message counts by role" },
  { name: "reset", description: "Clear conversation history" },
  { name: "compact", description: "Compress conversation context" },
  {
    name: "steer",
    description: "Inject guidance into the currently running agent turn",
    input: { hint: "guidance for the active turn" },
  },
  {
    name: "queue",
    description: "Queue a prompt to run after the current turn finishes",
    input: { hint: "prompt to run next" },
  },
  { name: "version", description: "Show Hermes version" },
] satisfies ReadonlyArray<ServerProviderSlashCommand>;

export const HERMES_GATEWAY_SLASH_COMMANDS = [
  ...HERMES_ACP_SLASH_COMMANDS,
  {
    name: "reasoning",
    description: "Manage reasoning effort and reasoning display",
    input: { hint: "minimal, low, medium, high, xhigh, show, or hide" },
  },
] satisfies ReadonlyArray<ServerProviderSlashCommand>;

export function getHermesSlashCommandsForEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): ReadonlyArray<ServerProviderSlashCommand> {
  return isHermesGatewayRuntimeEnabled(environment)
    ? HERMES_GATEWAY_SLASH_COMMANDS
    : HERMES_ACP_SLASH_COMMANDS;
}

export function getHermesFallbackModels(hermesSettings: Pick<HermesSettings, "customModels">) {
  return providerModelsFromSettings(
    [
      {
        slug: HERMES_FALLBACK_MODEL_SLUG,
        name: "Hermes Agent",
        isCustom: false,
        capabilities: EMPTY_CAPABILITIES,
      },
    ],
    PROVIDER,
    hermesSettings.customModels,
    EMPTY_CAPABILITIES,
  );
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function hermesGatewayModelSlug(providerSlug: string, modelId: string): string {
  return `${providerSlug}:${modelId}`;
}

export function getHermesGatewayModels(
  modelOptions: HermesGatewayModelOptionsResult,
  hermesSettings: Pick<HermesSettings, "customModels">,
): ReadonlyArray<ServerProviderModel> {
  const models: ServerProviderModel[] = [];
  const seen = new Set<string>();

  for (const provider of modelOptions.providers ?? []) {
    if (provider.authenticated !== true) {
      continue;
    }
    const providerSlug = nonEmptyString(provider.slug);
    if (!providerSlug) {
      continue;
    }
    const providerName = nonEmptyString(provider.name) ?? providerSlug;
    for (const rawModel of provider.models ?? []) {
      const modelId = nonEmptyString(rawModel);
      if (!modelId) {
        continue;
      }
      const slug = hermesGatewayModelSlug(providerSlug, modelId);
      if (seen.has(slug)) {
        continue;
      }
      seen.add(slug);
      models.push({
        slug,
        name: modelId,
        shortName: modelId,
        subProvider: providerName,
        isCustom: false,
        capabilities: EMPTY_CAPABILITIES,
      });
    }
  }

  return providerModelsFromSettings(
    models.length > 0 ? models : getHermesFallbackModels(hermesSettings),
    PROVIDER,
    hermesSettings.customModels,
    EMPTY_CAPABILITIES,
  );
}

function catalogDescriptionBySkillName(
  catalog: HermesGatewayCommandsCatalogResult,
): ReadonlyMap<string, string> {
  const descriptions = new Map<string, string>();
  for (const pair of catalog.pairs ?? []) {
    const command = nonEmptyString(pair[0]);
    const description = nonEmptyString(pair[1]);
    if (!command || !description || !command.startsWith("/")) {
      continue;
    }
    descriptions.set(command.slice(1), description);
  }
  return descriptions;
}

function inputHintFromCatalogDescription(
  commandName: string,
  description: string,
): string | undefined {
  const usageMatch = description.match(/\(usage:\s*\/[^\s)]+(?:\s+([^)]+))?\)/iu);
  const hint = usageMatch?.[1]?.trim();
  if (!hint || hint === `[${commandName}]`) {
    return undefined;
  }
  return hint;
}

export function getHermesGatewaySlashCommands(
  catalog: HermesGatewayCommandsCatalogResult,
): ReadonlyArray<ServerProviderSlashCommand> {
  const commands: ServerProviderSlashCommand[] = [];
  const seen = new Set<string>();

  for (const pair of catalog.pairs ?? []) {
    const command = nonEmptyString(pair[0]);
    if (!command) {
      continue;
    }
    const commandMatch = command.match(/^\/([a-zA-Z0-9][\w-]*)\b/u);
    const name = commandMatch?.[1]?.trim();
    if (!name) {
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const description = nonEmptyString(pair[1]);
    const inputHint = description ? inputHintFromCatalogDescription(name, description) : undefined;
    commands.push({
      name,
      ...(description ? { description } : {}),
      ...(inputHint ? { input: { hint: inputHint } } : {}),
    });
  }

  return commands.length > 0 ? commands : HERMES_GATEWAY_SLASH_COMMANDS;
}

export function getHermesGatewaySkills(input: {
  readonly skillsList: HermesGatewaySkillsListResult;
  readonly catalog: HermesGatewayCommandsCatalogResult;
}): ReadonlyArray<ServerProviderSkill> {
  const descriptions = catalogDescriptionBySkillName(input.catalog);
  const skills: ServerProviderSkill[] = [];
  const seen = new Set<string>();

  for (const [scope, rawNames] of Object.entries(input.skillsList.skills ?? {})) {
    const normalizedScope = nonEmptyString(scope);
    if (!normalizedScope) {
      continue;
    }
    for (const rawName of rawNames) {
      const name = nonEmptyString(rawName);
      if (!name || seen.has(name)) {
        continue;
      }
      seen.add(name);
      const description = descriptions.get(name);
      skills.push({
        name,
        path: `hermes-skill://${normalizedScope}/${name}`,
        scope: normalizedScope,
        enabled: true,
        ...(description ? { description, shortDescription: description } : {}),
      });
    }
  }

  return skills.toSorted((a, b) => a.name.localeCompare(b.name));
}

interface HermesGatewayDiscovery {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly authenticatedProviderCount: number;
}

const discoverHermesGatewaySnapshot = (
  hermesSettings: HermesSettings,
  environment: NodeJS.ProcessEnv,
): Effect.Effect<HermesGatewayDiscovery, HermesGatewayDiscoveryError> =>
  Effect.tryPromise({
    try: async () => {
      const runtimeOptions: HermesGatewayRuntimeOptions = {
        hermesBinaryPath: hermesSettings.binaryPath,
        cwd: process.cwd(),
        homePath: hermesSettings.homePath,
        environment,
        startupTimeoutMs: GATEWAY_DISCOVERY_TIMEOUT_MS,
        requestTimeoutMs: GATEWAY_DISCOVERY_TIMEOUT_MS,
        shutdownTimeoutMs: 750,
      };
      const runtime = await startHermesGatewayRuntime(runtimeOptions);
      try {
        const session = await runtime.request<{ readonly session_id: string }>("session.create", {
          cols: 120,
        });
        const [modelOptions, catalog, skillsList] = await Promise.all([
          runtime.request<HermesGatewayModelOptionsResult>("model.options", {
            session_id: session.session_id,
          }),
          runtime.request<HermesGatewayCommandsCatalogResult>("commands.catalog", {}),
          runtime.request<HermesGatewaySkillsListResult>("skills.manage", { action: "list" }),
        ]);
        const authenticatedProviderCount = (modelOptions.providers ?? []).filter(
          (provider) => provider.authenticated === true,
        ).length;
        return {
          models: getHermesGatewayModels(modelOptions, hermesSettings),
          skills: getHermesGatewaySkills({ catalog, skillsList }),
          slashCommands: getHermesGatewaySlashCommands(catalog),
          authenticatedProviderCount,
        };
      } finally {
        await runtime.stop();
      }
    },
    catch: (cause) =>
      new HermesGatewayDiscoveryError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });

export function buildInitialHermesProviderSnapshot(
  hermesSettings: HermesSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = getHermesFallbackModels(hermesSettings);
    const slashCommands = getHermesSlashCommandsForEnvironment(environment);

    if (!hermesSettings.enabled) {
      return buildServerProvider({
        presentation: HERMES_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        slashCommands,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Hermes is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      slashCommands,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Hermes availability...",
      },
    });
  });
}

const runHermesCommand = (
  hermesSettings: HermesSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const env = {
      ...environment,
      ...(hermesSettings.homePath ? { HERMES_HOME: hermesSettings.homePath } : {}),
    };
    const command = ChildProcess.make(hermesSettings.binaryPath, [...args], {
      env,
      shell: process.platform === "win32",
    });
    const child = yield* spawner.spawn(command);
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );

    return { stdout, stderr, code: exitCode } satisfies CommandResult;
  }).pipe(Effect.scoped);

export const checkHermesProviderStatus = Effect.fn("checkHermesProviderStatus")(function* (
  hermesSettings: HermesSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const models = getHermesFallbackModels(hermesSettings);
  const slashCommands = getHermesSlashCommandsForEnvironment(environment);

  if (!hermesSettings.enabled) {
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      slashCommands,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Hermes is disabled in T3 Code settings.",
      },
    });
  }

  const versionProbe = yield* runHermesCommand(hermesSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: hermesSettings.enabled,
      checkedAt,
      models,
      slashCommands,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Hermes CLI (`hermes`) is not installed or not on PATH."
          : `Failed to execute Hermes CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: hermesSettings.enabled,
      checkedAt,
      models,
      slashCommands,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Hermes CLI is installed but timed out while running `hermes --version`.",
      },
    });
  }

  const result = versionProbe.success.value;
  const combined = `${result.stdout}\n${result.stderr}`;
  const version = parseGenericCliVersion(combined);
  if (result.code === 0) {
    const gatewayProbe = yield* discoverHermesGatewaySnapshot(hermesSettings, environment).pipe(
      Effect.result,
    );
    if (Result.isSuccess(gatewayProbe)) {
      const gateway = gatewayProbe.success;
      return buildServerProvider({
        presentation: HERMES_PRESENTATION,
        enabled: hermesSettings.enabled,
        checkedAt,
        models: gateway.models,
        slashCommands: isHermesGatewayRuntimeEnabled(environment)
          ? gateway.slashCommands
          : slashCommands,
        skills: gateway.skills,
        probe: {
          installed: true,
          version,
          status: "ready",
          auth:
            gateway.authenticatedProviderCount > 0
              ? {
                  status: "authenticated",
                  label: `${gateway.authenticatedProviderCount} Hermes provider${
                    gateway.authenticatedProviderCount === 1 ? "" : "s"
                  }`,
                }
              : { status: "unknown" },
        },
      });
    }

    const error = gatewayProbe.failure;
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: hermesSettings.enabled,
      checkedAt,
      models,
      slashCommands,
      probe: {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unknown" },
        message: `Hermes CLI is installed, but model discovery through the gateway failed: ${error.message}.`,
      },
    });
  }

  return buildServerProvider({
    presentation: HERMES_PRESENTATION,
    enabled: hermesSettings.enabled,
    checkedAt,
    models,
    slashCommands,
    probe: {
      installed: true,
      version,
      status: "warning",
      auth: { status: "unknown" },
      message: "Hermes CLI responded with a non-zero exit code.",
    },
  });
});
