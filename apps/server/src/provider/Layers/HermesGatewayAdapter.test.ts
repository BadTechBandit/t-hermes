// @effect-diagnostics nodeBuiltinImport:off
import * as os from "node:os";
import * as path from "node:path";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  ApprovalRequestId,
  HermesSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import {
  formatHermesGatewayCommandCatalog,
  formatHermesGatewaySessionList,
  formatHermesGatewayText,
  formatHermesGatewayToolsShow,
  makeHermesGatewayAdapter,
} from "./HermesGatewayAdapter.ts";

const decodeHermesSettings = Schema.decodeSync(HermesSettings);

const provideHermesGatewayAdapterTestServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-hermes-gateway-adapter-test-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

async function makeFakeGatewayScript() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hermes-gateway-adapter-fake-"));
  const scriptPath = path.join(dir, "fake-gateway.mjs");
  const script = `import { createInterface } from "node:readline";

const write = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
let model = "fake-model";
let pendingApproval = false;
let turnCount = 0;

write({
  jsonrpc: "2.0",
  method: "event",
  params: { type: "gateway.ready", payload: { skin: {} } },
});

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const req = JSON.parse(line);
  if (req.method === "session.create") {
    write({
      jsonrpc: "2.0",
      id: req.id,
      result: { session_id: "fake-session", info: { model, cwd: process.cwd(), lazy: true } },
    });
    return;
  }
  if (req.method === "config.set") {
    model = req.params.value;
    write({ jsonrpc: "2.0", id: req.id, result: { key: req.params.key, value: model } });
    return;
  }
  if (req.method === "command.dispatch") {
    if (req.params.name === "spike") {
      write({
        jsonrpc: "2.0",
        id: req.id,
        result: { type: "skill", name: "spike", message: "skill prompt: " + req.params.arg },
      });
      return;
    }
    write({
      jsonrpc: "2.0",
      id: req.id,
      error: { code: 4018, message: "not a quick/plugin/skill command: " + req.params.name },
    });
    return;
  }
  if (req.method === "commands.catalog") {
    write({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        skill_count: 1,
        categories: [
          { name: "Core", pairs: [["/help", "List available commands"], ["/sessions", "List recent sessions"]] },
          { name: "Model", pairs: [["/model", "Show current model and provider"]] },
        ],
      },
    });
    return;
  }
  if (req.method === "tools.show") {
    write({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        total: 2,
        sections: [
          { name: "browser", tools: [{ name: "browser_open", description: "Open a URL in the browser." }] },
          { name: "shell", tools: [{ name: "terminal", description: "Execute shell commands." }] },
        ],
      },
    });
    return;
  }
  if (req.method === "session.list") {
    write({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        sessions: [
          {
            id: "session-1",
            title: "Availability check",
            preview: "Checked Hermes gateway status",
            started_at: 1778670000,
            message_count: 4,
            source: "tui",
          },
        ],
      },
    });
    return;
  }
  if (req.method === "model.options") {
    write({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        provider: "custom",
        model: model,
        providers: [
          { slug: "custom", name: "Custom", authenticated: true, is_current: true, models: [model] },
        ],
      },
    });
    return;
  }
  if (req.method === "config.get") {
    write({
      jsonrpc: "2.0",
      id: req.id,
      result: { value: "high", display: "show" },
    });
    return;
  }
  if (req.method === "slash.exec") {
    if (req.params.command === "/kanban") {
      write({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          output: "/kanban \\u2014 manage the shared task board. Common subcommands: list (alias ls) List tasks on the current board show <id> Task details + comments + events stats Per-status / per-assignee counts create <title>\\u2026 Create a task comment <id> <msg> Append a comment complete <id>\\u2026 Mark task(s) done block <id> [reason] Mark blocked; unblock <id> to revive assign <id> <profile> Reassign boards list Show all boards assignees Known profiles + counts context <id> Full worker-context dump runs <id> Attempt history log <id> Worker log Run /kanban <subcommand> -h for arguments. Read-only commands are safe while an agent is running.",
        },
      });
      return;
    }
    write({
      jsonrpc: "2.0",
      id: req.id,
      result: { output: "Reasoning set to high" },
    });
    return;
  }
  if (req.method === "image.attach") {
    write({
      jsonrpc: "2.0",
      id: req.id,
      result: { attached: true, path: req.params.path, count: 1 },
    });
    return;
  }
  if (req.method === "session.undo") {
    turnCount = Math.max(0, turnCount - 1);
    write({ jsonrpc: "2.0", id: req.id, result: { status: "ok", count: turnCount } });
    return;
  }
  if (req.method === "approval.respond") {
    pendingApproval = false;
    write({ jsonrpc: "2.0", id: req.id, result: { resolved: 1 } });
    write({
      jsonrpc: "2.0",
      method: "event",
      params: {
        type: "message.delta",
        session_id: "fake-session",
        payload: { text: "approved" },
      },
    });
    write({
      jsonrpc: "2.0",
      method: "event",
      params: {
        type: "message.complete",
        session_id: "fake-session",
        payload: { text: "approved", usage: { context_used: 64, context_max: 256000 } },
      },
    });
    return;
  }
  if (req.method === "prompt.submit") {
    write({ jsonrpc: "2.0", id: req.id, result: { status: "streaming" } });
    turnCount += 1;
    if (req.params.text === "needs approval") {
      pendingApproval = true;
      write({
        jsonrpc: "2.0",
        method: "event",
        params: { type: "message.start", session_id: "fake-session" },
      });
      write({
        jsonrpc: "2.0",
        method: "event",
        params: {
          type: "approval.request",
          session_id: "fake-session",
          payload: { command: "rm -rf /tmp/fake", description: "Dangerous shell command" },
        },
      });
      return;
    }
    const text = req.params.text.startsWith("skill prompt:")
      ? "skill invoked"
      : "gateway hello";
    write({
      jsonrpc: "2.0",
      method: "event",
      params: { type: "message.start", session_id: "fake-session" },
    });
    write({
      jsonrpc: "2.0",
      method: "event",
      params: {
        type: "message.delta",
        session_id: "fake-session",
        payload: { text },
      },
    });
    write({
      jsonrpc: "2.0",
      method: "event",
      params: {
        type: "tool.start",
        session_id: "fake-session",
        payload: { tool_id: "tool-1", name: "shell.exec", context: "running command" },
      },
    });
    write({
      jsonrpc: "2.0",
      method: "event",
      params: {
        type: "tool.progress",
        session_id: "fake-session",
        payload: { tool_id: "tool-1", name: "shell.exec", preview: "halfway" },
      },
    });
    write({
      jsonrpc: "2.0",
      method: "event",
      params: {
        type: "tool.complete",
        session_id: "fake-session",
        payload: { tool_id: "tool-1", name: "shell.exec", summary: "done" },
      },
    });
    write({
      jsonrpc: "2.0",
      method: "event",
      params: {
        type: "message.complete",
        session_id: "fake-session",
        payload: {
          text,
          usage: { context_used: 42, context_max: 256000, total: 42 },
          status: "complete",
        },
      },
    });
    return;
  }
  write({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "not found" } });
});
`;
  await writeFile(scriptPath, script, "utf8");
  await chmod(scriptPath, 0o755);
  return { dir, scriptPath };
}

describe("HermesGatewayAdapter", () => {
  it("formats rich terminal command output as readable markdown", () => {
    assert.equal(
      formatHermesGatewayText({
        commandName: "help",
        text: "\u001b[1mAvailable commands\u001b[0m\r\n┌────┬────────────┐\n│ /help │ Show help │\n└────┴────────────┘",
      }),
      [
        "**/help**",
        "",
        "```text",
        "Available commands",
        "┌────┬────────────┐",
        "│ /help │ Show help │",
        "└────┴────────────┘",
        "```",
      ].join("\n"),
    );
  });

  it("formats structured gateway help, tools, and sessions", () => {
    assert.equal(
      formatHermesGatewayCommandCatalog({
        skill_count: 2,
        categories: [{ name: "Core", pairs: [["/help", "List available commands"]] }],
      }),
      [
        "**Hermes commands**",
        "",
        "**Core**",
        "- `/help` - List available commands",
        "",
        "2 skill commands available.",
      ].join("\n"),
    );

    assert.equal(
      formatHermesGatewayToolsShow({
        total: 1,
        sections: [
          { name: "browser", tools: [{ name: "browser_open", description: "Open URL." }] },
        ],
      }),
      [
        "**Hermes tools**",
        "",
        "1 tool available.",
        "",
        "**browser**",
        "- `browser_open` - Open URL.",
      ].join("\n"),
    );

    assert.include(
      formatHermesGatewaySessionList(
        {
          sessions: [
            {
              id: "session-1",
              title: "Availability check",
              preview: "Checked Hermes status",
              started_at: 1778670000,
              message_count: 4,
              source: "tui",
            },
          ],
        },
        10,
      ),
      "- ID: `session-1`",
    );
  });

  it("formats inline kanban command help as readable markdown", () => {
    assert.equal(
      formatHermesGatewayText({
        commandName: "kanban",
        text: "/kanban \u2014 manage the shared task board.\n\nCommon subcommands: list (alias ls) List tasks on the current board show <id> Task details + comments + events stats Per-status / per-assignee counts create <title>\u2026 Create a task comment <id> <msg> Append a comment complete <id>\u2026 Mark task(s) done block <id> [reason] Mark blocked; unblock <id> to revive assign <id> <profile> Reassign boards list Show all boards assignees Known profiles + counts context <id> Full worker-context dump runs <id> Attempt history log <id> Worker log\n\nRun /kanban <subcommand> -h for arguments. Read-only commands are safe while an agent is running.",
      }),
      [
        "**/kanban**",
        "",
        "manage the shared task board.",
        "",
        "**Common subcommands**",
        "- `list` (`ls`) - List tasks on the current board",
        "- `show <id>` - Task details + comments + events",
        "- `stats` - Per-status / per-assignee counts",
        "- `create <title>...` - Create a task",
        "- `comment <id> <msg>` - Append a comment",
        "- `complete <id>...` - Mark task(s) done",
        "- `block <id> [reason]` - Mark blocked; unblock <id> to revive",
        "- `assign <id> <profile>` - Reassign",
        "- `boards list` - Show all boards",
        "- `assignees` - Known profiles + counts",
        "- `context <id>` - Full worker-context dump",
        "- `runs <id>` - Attempt history",
        "- `log <id>` - Worker log",
        "",
        "Run `/kanban <subcommand> -h` for arguments.",
        "Read-only commands are safe while an agent is running.",
      ].join("\n"),
    );
  });

  it.effect("streams prompts, gateway skills, slash command output, and usage", () =>
    provideHermesGatewayAdapterTestServices(
      Effect.scoped(
        Effect.gen(function* () {
          const { dir, scriptPath } = yield* Effect.promise(() => makeFakeGatewayScript());
          const adapter = yield* makeHermesGatewayAdapter(decodeHermesSettings({}), {
            gatewayRuntimeOptions: {
              spawn: { command: "bun", args: [scriptPath], cwd: dir },
              startupTimeoutMs: 1_000,
              requestTimeoutMs: 1_000,
              shutdownTimeoutMs: 500,
            },
          });
          const threadId = ThreadId.make("hermes-gateway-adapter");
          const textFiber = yield* adapter.streamEvents.pipe(
            Stream.filter((event) => event.type === "content.delta"),
            Stream.take(3),
            Stream.runCollect,
            Effect.forkChild,
          );
          const usageFiber = yield* adapter.streamEvents.pipe(
            Stream.filter((event) => event.type === "thread.token-usage.updated"),
            Stream.runHead,
            Effect.forkChild,
          );
          const itemFiber = yield* adapter.streamEvents.pipe(
            Stream.filter((event) => event.type === "item.started"),
            Stream.runHead,
            Effect.forkChild,
          );
          const toolFiber = yield* adapter.streamEvents.pipe(
            Stream.filter((event) => event.type === "tool.progress"),
            Stream.runHead,
            Effect.forkChild,
          );

          const session = yield* adapter.startSession({
            threadId,
            provider: ProviderDriverKind.make("hermes"),
            cwd: dir,
            runtimeMode: "full-access",
            modelSelection: {
              instanceId: ProviderInstanceId.make("hermes"),
              model: "openai-codex:gpt-5.5",
            },
          });
          assert.equal(session.model, "openai-codex:gpt-5.5");

          yield* adapter.sendTurn({ threadId, input: "hello", attachments: [] });
          yield* adapter.sendTurn({ threadId, input: "/spike try this", attachments: [] });
          yield* adapter.sendTurn({ threadId, input: "/reasoning high", attachments: [] });

          const textDeltas = Array.from(yield* Fiber.join(textFiber)).map((event) =>
            event.type === "content.delta" ? event.payload.delta : "",
          );

          assert.includeMembers(textDeltas, [
            "gateway hello",
            "skill invoked",
            "Reasoning set to high",
          ]);
          assert.isTrue(Option.isSome(yield* Fiber.join(usageFiber)));
          assert.isTrue(Option.isSome(yield* Fiber.join(itemFiber)));
          assert.isTrue(Option.isSome(yield* Fiber.join(toolFiber)));
          yield* adapter.stopSession(threadId);
        }),
      ),
    ),
  );

  it.effect("emits clean markdown for structured gateway slash commands", () =>
    provideHermesGatewayAdapterTestServices(
      Effect.scoped(
        Effect.gen(function* () {
          const { dir, scriptPath } = yield* Effect.promise(() => makeFakeGatewayScript());
          const adapter = yield* makeHermesGatewayAdapter(decodeHermesSettings({}), {
            gatewayRuntimeOptions: {
              spawn: { command: "bun", args: [scriptPath], cwd: dir },
              startupTimeoutMs: 1_000,
              requestTimeoutMs: 1_000,
              shutdownTimeoutMs: 500,
            },
          });
          const threadId = ThreadId.make("hermes-gateway-structured-output");
          const textFiber = yield* adapter.streamEvents.pipe(
            Stream.filter((event) => event.type === "content.delta"),
            Stream.take(6),
            Stream.runCollect,
            Effect.forkChild,
          );

          yield* adapter.startSession({
            threadId,
            provider: ProviderDriverKind.make("hermes"),
            cwd: dir,
            runtimeMode: "full-access",
          });

          yield* adapter.sendTurn({ threadId, input: "/help", attachments: [] });
          yield* adapter.sendTurn({ threadId, input: "/tools", attachments: [] });
          yield* adapter.sendTurn({ threadId, input: "/sessions", attachments: [] });
          yield* adapter.sendTurn({ threadId, input: "/model", attachments: [] });
          yield* adapter.sendTurn({ threadId, input: "/reasoning", attachments: [] });
          yield* adapter.sendTurn({ threadId, input: "/kanban", attachments: [] });

          const textDeltas = Array.from(yield* Fiber.join(textFiber)).map((event) =>
            event.type === "content.delta" ? event.payload.delta : "",
          );

          assert.include(textDeltas[0], "**Hermes commands**");
          assert.include(textDeltas[1], "**Hermes tools**");
          assert.include(textDeltas[2], "**Hermes sessions**");
          assert.include(textDeltas[3], "**Hermes model**");
          assert.include(textDeltas[4], "**Hermes reasoning**");
          assert.include(textDeltas[5], "**/kanban**");
          assert.include(textDeltas[5], "- `list` (`ls`) - List tasks on the current board");

          yield* adapter.stopSession(threadId);
        }),
      ),
    ),
  );

  it.effect("bridges gateway approvals and rollback", () =>
    provideHermesGatewayAdapterTestServices(
      Effect.scoped(
        Effect.gen(function* () {
          const { dir, scriptPath } = yield* Effect.promise(() => makeFakeGatewayScript());
          const adapter = yield* makeHermesGatewayAdapter(decodeHermesSettings({}), {
            gatewayRuntimeOptions: {
              spawn: { command: "bun", args: [scriptPath], cwd: dir },
              startupTimeoutMs: 1_000,
              requestTimeoutMs: 1_000,
              shutdownTimeoutMs: 500,
            },
          });
          const threadId = ThreadId.make("hermes-gateway-approval");
          const openedFiber = yield* adapter.streamEvents.pipe(
            Stream.filter((event) => event.type === "request.opened"),
            Stream.runHead,
            Effect.forkChild,
          );
          const resolvedFiber = yield* adapter.streamEvents.pipe(
            Stream.filter((event) => event.type === "request.resolved"),
            Stream.runHead,
            Effect.forkChild,
          );

          yield* adapter.startSession({
            threadId,
            provider: ProviderDriverKind.make("hermes"),
            cwd: dir,
            runtimeMode: "full-access",
          });

          const sendFiber = yield* adapter
            .sendTurn({ threadId, input: "needs approval", attachments: [] })
            .pipe(Effect.forkChild);
          const openedOption = yield* Fiber.join(openedFiber);
          if (Option.isNone(openedOption)) {
            assert.fail("expected request.opened event");
          }
          const opened = openedOption.value;
          if (opened.type !== "request.opened" || !opened.requestId) {
            assert.fail("expected request.opened with requestId");
          }
          yield* adapter.respondToRequest(
            threadId,
            ApprovalRequestId.make(opened.requestId),
            "accept",
          );
          yield* Fiber.join(sendFiber);

          assert.isTrue(Option.isSome(yield* Fiber.join(resolvedFiber)));
          const snapshot = yield* adapter.rollbackThread(threadId, 1);
          assert.equal(snapshot.turns.length, 0);
          yield* adapter.stopSession(threadId);
        }),
      ),
    ),
  );
});
