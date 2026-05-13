// @effect-diagnostics nodeBuiltinImport:off
import * as os from "node:os";
import * as path from "node:path";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  HermesSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { formatHermesAcpText, makeHermesAdapter } from "./HermesAdapter.ts";

const decodeHermesSettings = Schema.decodeSync(HermesSettings);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockAgentPath = path.join(__dirname, "../../../scripts/acp-mock-agent.ts");

async function makeMockAgentWrapper(extraEnv?: Record<string, string>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hermes-acp-mock-"));
  const wrapperPath = path.join(dir, "fake-hermes.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec ${JSON.stringify("bun")} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await writeFile(wrapperPath, script, "utf8");
  await chmod(wrapperPath, 0o755);
  return wrapperPath;
}

const provideHermesAdapterTestServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-hermes-adapter-test-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

async function readLoggedMethods(logPath: string): Promise<ReadonlyArray<string>> {
  const raw = await readFile(logPath, "utf8");
  return raw
    .split(/\n+/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as { method?: unknown };
        return typeof parsed.method === "string" ? [parsed.method] : [];
      } catch {
        return [];
      }
    });
}

describe("HermesAdapter", () => {
  it("formats Hermes ACP command responses as markdown blocks", () => {
    assert.equal(
      formatHermesAcpText(
        [
          "Available commands:",
          "",
          "  /help       Show available commands",
          "  /model      Show or change current model",
          "",
          "Unrecognized /commands are sent to the model as normal messages.",
        ].join("\n"),
      ),
      [
        "**Available commands**",
        "",
        "- `/help` - Show available commands",
        "- `/model` - Show or change current model",
        "",
        "Unrecognized slash commands are sent to Hermes as normal messages.",
      ].join("\n"),
    );
  });

  it.effect("switches selected Hermes models through ACP session/set_model", () =>
    provideHermesAdapterTestServices(
      Effect.scoped(
        Effect.gen(function* () {
          const tempDir = yield* Effect.promise(() =>
            mkdtemp(path.join(os.tmpdir(), "hermes-acp-model-switch-")),
          );
          const requestLogPath = path.join(tempDir, "requests.ndjson");
          const wrapperPath = yield* Effect.promise(() =>
            makeMockAgentWrapper({
              T3_ACP_REQUEST_LOG_PATH: requestLogPath,
            }),
          );
          const adapter = yield* makeHermesAdapter(
            decodeHermesSettings({ binaryPath: wrapperPath }),
          );
          const threadId = ThreadId.make("hermes-model-switch");

          const session = yield* adapter.startSession({
            threadId,
            provider: ProviderDriverKind.make("hermes"),
            cwd: process.cwd(),
            runtimeMode: "full-access",
            modelSelection: {
              instanceId: ProviderInstanceId.make("hermes"),
              model: "openai-codex:gpt-5.5",
            },
          });

          assert.equal(session.model, "openai-codex:gpt-5.5");

          yield* adapter.sendTurn({
            threadId,
            input: "hello mock",
            attachments: [],
            modelSelection: {
              instanceId: ProviderInstanceId.make("hermes"),
              model: "anthropic:claude-sonnet-4-6",
            },
          });

          const methods = yield* Effect.promise(() => readLoggedMethods(requestLogPath));
          assert.includeMembers([...methods], ["session/set_model", "session/prompt"]);
          assert.notInclude(methods, "session/set_config_option");

          yield* adapter.stopSession(threadId);
        }),
      ),
    ),
  );

  it.effect("stores the current ACP session model from session setup", () =>
    provideHermesAdapterTestServices(
      Effect.scoped(
        Effect.gen(function* () {
          const wrapperPath = yield* Effect.promise(() =>
            makeMockAgentWrapper({
              T3_ACP_MODEL_STATE_CURRENT_ID: "openai-codex:gpt-5.5",
              T3_ACP_MODEL_STATE_NAME: "gpt-5.5",
            }),
          );
          const adapter = yield* makeHermesAdapter(
            decodeHermesSettings({ binaryPath: wrapperPath }),
          );
          const threadId = ThreadId.make("hermes-model-capture");

          const session = yield* adapter.startSession({
            threadId,
            provider: ProviderDriverKind.make("hermes"),
            cwd: process.cwd(),
            runtimeMode: "full-access",
            modelSelection: {
              instanceId: ProviderInstanceId.make("hermes"),
              model: "hermes-agent",
            },
          });

          assert.equal(session.model, "openai-codex:gpt-5.5");
          yield* adapter.stopSession(threadId);
        }),
      ),
    ),
  );

  it.effect("maps ACP usage_update notifications to thread token usage events", () =>
    provideHermesAdapterTestServices(
      Effect.scoped(
        Effect.gen(function* () {
          const wrapperPath = yield* Effect.promise(() =>
            makeMockAgentWrapper({
              T3_ACP_EMIT_USAGE_UPDATE: "1",
              T3_ACP_USAGE_SIZE: "272000",
              T3_ACP_USAGE_USED: "11231",
              T3_ACP_MODEL_STATE_CURRENT_ID: "openai-codex:gpt-5.5",
              T3_ACP_MODEL_STATE_NAME: "gpt-5.5",
            }),
          );
          const adapter = yield* makeHermesAdapter(
            decodeHermesSettings({ binaryPath: wrapperPath }),
          );
          const threadId = ThreadId.make("hermes-usage-update");
          const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 10).pipe(
            Stream.runCollect,
            Effect.forkChild,
          );

          yield* adapter.startSession({
            threadId,
            provider: ProviderDriverKind.make("hermes"),
            cwd: process.cwd(),
            runtimeMode: "full-access",
            modelSelection: {
              instanceId: ProviderInstanceId.make("hermes"),
              model: "hermes-agent",
            },
          });

          yield* adapter.sendTurn({
            threadId,
            input: "hello mock",
            attachments: [],
          });

          const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
          const usageEvent = runtimeEvents.find(
            (event) => event.type === "thread.token-usage.updated",
          );
          assert.isDefined(usageEvent);
          if (usageEvent?.type === "thread.token-usage.updated") {
            assert.deepStrictEqual(usageEvent.payload.usage, {
              usedTokens: 11231,
              maxTokens: 272000,
              compactsAutomatically: true,
            });
          }

          const turnStarted = runtimeEvents.find((event) => event.type === "turn.started");
          assert.isDefined(turnStarted);
          if (turnStarted?.type === "turn.started") {
            assert.equal(turnStarted.payload.model, "openai-codex:gpt-5.5");
          }

          yield* adapter.stopSession(threadId);
        }),
      ),
    ),
  );
});
