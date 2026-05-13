// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, it } from "vitest";
import { HermesSettings } from "@t3tools/contracts";

import {
  buildInitialHermesProviderSnapshot,
  checkHermesProviderStatus,
  getHermesGatewayModels,
  getHermesGatewaySlashCommands,
  getHermesGatewaySkills,
  getHermesSlashCommandsForEnvironment,
  HERMES_ACP_SLASH_COMMANDS,
  HERMES_GATEWAY_SLASH_COMMANDS,
} from "./HermesProvider.ts";

const decodeHermesSettings = Schema.decodeSync(HermesSettings);

const runNode = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));

const makeVersionWrapper = Effect.fn("makeVersionWrapper")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fileSystem.makeTempDirectory({
    directory: NodeOS.tmpdir(),
    prefix: "hermes-provider-version-",
  });
  const wrapperPath = path.join(dir, "fake-hermes.sh");
  const script = `#!/bin/sh
printf 'Hermes Agent v0.13.0 (2026.5.7)\\n'
exit 0
`;
  yield* fileSystem.writeFileString(wrapperPath, script);
  yield* fileSystem.chmod(wrapperPath, 0o755);
  return wrapperPath;
});

describe("HermesProvider", () => {
  it("includes only ACP-safe slash commands in the initial snapshot", async () => {
    const snapshot = await Effect.runPromise(
      buildInitialHermesProviderSnapshot(decodeHermesSettings({})),
    );

    expect(snapshot.slashCommands).toEqual(HERMES_ACP_SLASH_COMMANDS);
    expect(snapshot.slashCommands.map((command) => command.name)).toEqual([
      "help",
      "model",
      "tools",
      "context",
      "reset",
      "compact",
      "steer",
      "queue",
      "version",
    ]);
  });

  it("adds gateway-only slash commands when the Hermes gateway runtime is enabled", () => {
    expect(getHermesSlashCommandsForEnvironment({}).map((command) => command.name)).not.toContain(
      "reasoning",
    );
    expect(
      getHermesSlashCommandsForEnvironment({ T3_HERMES_RUNTIME: "gateway" }).map(
        (command) => command.name,
      ),
    ).toEqual(HERMES_GATEWAY_SLASH_COMMANDS.map((command) => command.name));
    expect(HERMES_GATEWAY_SLASH_COMMANDS.map((command) => command.name)).toContain("reasoning");
  });

  it("preserves ACP-safe slash commands after the Hermes health check", async () => {
    const snapshot = await runNode(
      Effect.gen(function* () {
        const binaryPath = yield* makeVersionWrapper();
        return yield* checkHermesProviderStatus(decodeHermesSettings({ binaryPath }), {});
      }),
    );

    expect(snapshot.status).toBe("warning");
    expect(snapshot.slashCommands).toEqual(HERMES_ACP_SLASH_COMMANDS);
  });

  it("maps the Hermes gateway command catalog into slash command metadata", () => {
    const slashCommands = getHermesGatewaySlashCommands({
      pairs: [
        ["/model", "Switch model for this session (usage: /model [model] [--provider name])"],
        ["/reasoning", "Manage reasoning effort (usage: /reasoning [level|show|hide])"],
        ["/goal", "Set a standing goal (usage: /goal [text | pause | resume | clear | status])"],
        ["not-a-command", "Ignored"],
        ["/model", "Duplicate ignored"],
      ],
    });

    expect(slashCommands).toEqual([
      {
        name: "model",
        description: "Switch model for this session (usage: /model [model] [--provider name])",
        input: { hint: "[model] [--provider name]" },
      },
      {
        name: "reasoning",
        description: "Manage reasoning effort (usage: /reasoning [level|show|hide])",
        input: { hint: "[level|show|hide]" },
      },
      {
        name: "goal",
        description: "Set a standing goal (usage: /goal [text | pause | resume | clear | status])",
        input: { hint: "[text | pause | resume | clear | status]" },
      },
    ]);
  });

  it("maps authenticated Hermes gateway providers into provider-scoped models", () => {
    const models = getHermesGatewayModels(
      {
        providers: [
          {
            slug: "anthropic",
            name: "Anthropic",
            authenticated: true,
            models: ["claude-sonnet-4-6", "claude-opus-4-7"],
          },
          {
            slug: "deepseek",
            name: "DeepSeek",
            authenticated: false,
            models: ["deepseek-chat"],
          },
        ],
      },
      decodeHermesSettings({ customModels: ["openai-codex:gpt-5.5"] }),
    );

    expect(models).toEqual([
      {
        slug: "anthropic:claude-sonnet-4-6",
        name: "claude-sonnet-4-6",
        shortName: "claude-sonnet-4-6",
        subProvider: "Anthropic",
        isCustom: false,
        capabilities: { optionDescriptors: [] },
      },
      {
        slug: "anthropic:claude-opus-4-7",
        name: "claude-opus-4-7",
        shortName: "claude-opus-4-7",
        subProvider: "Anthropic",
        isCustom: false,
        capabilities: { optionDescriptors: [] },
      },
      {
        slug: "openai-codex:gpt-5.5",
        name: "openai-codex:gpt-5.5",
        isCustom: true,
        capabilities: { optionDescriptors: [] },
      },
    ]);
  });

  it("maps Hermes gateway skills with descriptions from the command catalog", () => {
    const skills = getHermesGatewaySkills({
      skillsList: {
        skills: {
          "software-development": ["test-driven-development", "spike"],
          creative: ["sketch"],
        },
      },
      catalog: {
        pairs: [
          ["/spike", "Run a throwaway experiment."],
          ["/test-driven-development", "Use the TDD workflow."],
          ["/sketch", "Build a quick visual mockup."],
        ],
      },
    });

    expect(skills.map((skill) => skill.name)).toEqual([
      "sketch",
      "spike",
      "test-driven-development",
    ]);
    expect(skills.find((skill) => skill.name === "spike")).toEqual({
      name: "spike",
      path: "hermes-skill://software-development/spike",
      scope: "software-development",
      enabled: true,
      description: "Run a throwaway experiment.",
      shortDescription: "Run a throwaway experiment.",
    });
  });
});
