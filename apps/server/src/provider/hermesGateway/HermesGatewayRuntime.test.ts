// @effect-diagnostics nodeBuiltinImport:off
import * as os from "node:os";
import * as path from "node:path";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { runHermesGatewaySmoke, startHermesGatewayRuntime } from "./HermesGatewayRuntime.ts";

async function makeFakeGatewayScript() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hermes-gateway-fake-"));
  const scriptPath = path.join(dir, "fake-gateway.mjs");
  const script = `import { createInterface } from "node:readline";

const write = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");

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
      result: {
        session_id: "fake-session",
        info: { model: "fake-model", cwd: process.cwd(), lazy: true },
      },
    });
    return;
  }
  if (req.method === "commands.catalog") {
    write({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        pairs: [["/help", "List available commands"]],
        categories: [],
        canon: { "/help": "/help" },
        sub: {},
        skill_count: 0,
        warning: "",
      },
    });
    return;
  }
  if (req.method === "prompt.submit") {
    write({ jsonrpc: "2.0", id: req.id, result: { status: "streaming" } });
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
        payload: { text: "hello" },
      },
    });
    write({
      jsonrpc: "2.0",
      method: "event",
      params: {
        type: "message.complete",
        session_id: "fake-session",
        payload: { text: "hello" },
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

describe("HermesGatewayRuntime", () => {
  it("starts a gateway process, waits for ready, sends requests, and stops", async () => {
    const { dir, scriptPath } = await makeFakeGatewayScript();
    const runtime = await startHermesGatewayRuntime({
      spawn: {
        command: "bun",
        args: [scriptPath],
        cwd: dir,
      },
      startupTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
      shutdownTimeoutMs: 500,
    });

    const session = await runtime.request<{ readonly session_id: string }>("session.create", {
      cols: 120,
    });
    const catalog = await runtime.request<{
      readonly pairs: ReadonlyArray<readonly [string, string]>;
    }>("commands.catalog", {});
    const complete = runtime.waitForEvent<{ readonly text: string }>("message.complete", {
      sessionId: session.session_id,
      timeoutMs: 1_000,
    });
    const prompt = await runtime.request<{ readonly status: string }>("prompt.submit", {
      session_id: session.session_id,
      text: "Say hello",
    });
    const completeEvent = await complete;
    await runtime.stop();

    expect(runtime.readyEvent?.type).toBe("gateway.ready");
    expect(session.session_id).toBe("fake-session");
    expect(catalog.pairs).toEqual([["/help", "List available commands"]]);
    expect(prompt.status).toBe("streaming");
    expect(completeEvent.payload?.text).toBe("hello");
  });

  it("runs the isolated gateway smoke sequence against an opt-in spawn input", async () => {
    const { dir, scriptPath } = await makeFakeGatewayScript();
    const result = await runHermesGatewaySmoke({
      spawn: {
        command: "bun",
        args: [scriptPath],
        cwd: dir,
      },
      startupTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
      shutdownTimeoutMs: 500,
      prompt: "Say hello",
    });

    expect(result).toEqual({
      ready: true,
      sessionId: "fake-session",
      commandCount: 1,
      promptStatus: "streaming",
      responseText: "hello",
    });
  });
});
