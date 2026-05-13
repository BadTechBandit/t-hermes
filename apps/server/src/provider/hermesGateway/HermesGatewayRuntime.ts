// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";

import type {
  HermesGatewayCommandsCatalogResult,
  HermesGatewayEvent,
  HermesGatewayJsonRpcFrame,
  HermesGatewayPromptSubmitResult,
  HermesGatewaySessionCreateResult,
  HermesGatewaySmokeResult,
  HermesGatewaySpawnInput,
} from "./HermesGatewayProtocol.ts";

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 1_500;
const DEFAULT_SMOKE_PROMPT = "Say hello in one short sentence.";
const MAX_LOG_LINES = 200;

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

export interface HermesGatewayRuntimeOptions {
  readonly spawn?: HermesGatewaySpawnInput;
  readonly hermesBinaryPath?: string;
  readonly sourceRoot?: string;
  readonly cwd?: string;
  readonly homePath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly startupTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
}

export interface HermesGatewayRuntime {
  readonly readyEvent: HermesGatewayEvent | undefined;
  readonly logs: ReadonlyArray<string>;
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  onEvent(listener: (event: HermesGatewayEvent) => void): () => void;
  waitForEvent<TPayload = unknown>(
    type: string,
    options?: {
      readonly sessionId?: string;
      readonly timeoutMs?: number;
      readonly predicate?: (event: HermesGatewayEvent<TPayload>) => boolean;
    },
  ): Promise<HermesGatewayEvent<TPayload>>;
  stop(): Promise<void>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function rpcErrorMessage(raw: unknown): string {
  const error = asRecord(raw);
  const message = error?.message;
  return typeof message === "string" && message.trim()
    ? message.trim()
    : "Hermes gateway request failed";
}

function frameId(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function isGatewayEvent(value: unknown): value is HermesGatewayEvent {
  const record = asRecord(value);
  return typeof record?.type === "string";
}

function pushBounded(lines: string[], line: string): void {
  lines.push(line);
  if (lines.length > MAX_LOG_LINES) {
    lines.splice(0, lines.length - MAX_LOG_LINES);
  }
}

function parseHermesSourceRoot(versionOutput: string): string | undefined {
  const match = /^Project:\s*(.+)$/m.exec(versionOutput);
  return match?.[1]?.trim() || undefined;
}

async function collectCommandOutput(input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
}): Promise<{ readonly stdout: string; readonly stderr: string; readonly code: number | null }> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(input.command, [...input.args], {
      env: { ...process.env, ...input.env },
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error(`Timed out running ${input.command} ${input.args.join(" ")}`));
    }, input.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolvePromise({ stdout, stderr, code });
    });
  });
}

export async function resolveHermesSourceRootFromCli(input?: {
  readonly hermesBinaryPath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}): Promise<string | undefined> {
  const result = await collectCommandOutput({
    command: input?.hermesBinaryPath || "hermes",
    args: ["--version"],
    ...(input?.environment ? { env: input.environment } : {}),
    timeoutMs: input?.timeoutMs ?? 4_000,
  });
  return parseHermesSourceRoot(`${result.stdout}\n${result.stderr}`);
}

export function resolveHermesGatewayPython(
  sourceRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment.HERMES_PYTHON?.trim() || environment.PYTHON?.trim();
  if (configured) {
    return configured;
  }

  const virtualEnv = environment.VIRTUAL_ENV?.trim();
  const candidates = [
    virtualEnv ? resolve(virtualEnv, "bin/python") : undefined,
    virtualEnv ? resolve(virtualEnv, "Scripts/python.exe") : undefined,
    resolve(sourceRoot, ".venv/bin/python"),
    resolve(sourceRoot, ".venv/bin/python3"),
    resolve(sourceRoot, "venv/bin/python"),
    resolve(sourceRoot, "venv/bin/python3"),
  ];
  return (
    candidates.find((candidate): candidate is string =>
      Boolean(candidate && existsSync(candidate)),
    ) ?? (process.platform === "win32" ? "python" : "python3")
  );
}

export async function resolveHermesGatewaySpawnInput(
  input: Omit<HermesGatewayRuntimeOptions, "spawn">,
): Promise<HermesGatewaySpawnInput> {
  const environment = { ...process.env, ...input.environment };
  const sourceRoot =
    input.sourceRoot ??
    environment.HERMES_PYTHON_SRC_ROOT?.trim() ??
    (await resolveHermesSourceRootFromCli({
      ...(input.hermesBinaryPath ? { hermesBinaryPath: input.hermesBinaryPath } : {}),
      environment,
    }));

  if (!sourceRoot) {
    throw new Error("Could not resolve Hermes Agent source root from `hermes --version`.");
  }

  const python = resolveHermesGatewayPython(sourceRoot, environment);
  const workspaceCwd = input.cwd ?? process.cwd();
  const existingPythonPath = environment.PYTHONPATH?.trim();
  environment.PYTHONPATH = existingPythonPath
    ? `${sourceRoot}${delimiter}${existingPythonPath}`
    : sourceRoot;
  environment.HERMES_PYTHON_SRC_ROOT = sourceRoot;
  environment.TERMINAL_CWD = workspaceCwd;
  environment.HERMES_CWD = workspaceCwd;
  if (input.homePath?.trim()) {
    environment.HERMES_HOME = input.homePath.trim();
  }

  return {
    command: python,
    args: ["-m", "tui_gateway.entry"],
    cwd: workspaceCwd,
    env: environment,
  };
}

class NodeHermesGatewayRuntime implements HermesGatewayRuntime {
  readonly logs: string[] = [];
  readyEvent: HermesGatewayEvent | undefined;

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly stdout: ReadlineInterface;
  private readonly stderr: ReadlineInterface;
  private readonly options: {
    readonly requestTimeoutMs: number;
    readonly shutdownTimeoutMs: number;
  };
  private readonly pending = new Map<string, PendingRequest>();
  private readonly eventWaiters = new Set<{
    readonly type: string;
    readonly sessionId?: string;
    readonly predicate?: (event: HermesGatewayEvent) => boolean;
    readonly resolve: (event: HermesGatewayEvent) => void;
    readonly reject: (error: Error) => void;
    readonly timeout: ReturnType<typeof setTimeout>;
  }>();
  private readonly listeners = new Set<(event: HermesGatewayEvent) => void>();
  private requestId = 0;
  private exited = false;

  constructor(
    spawnInput: HermesGatewaySpawnInput,
    options: {
      readonly requestTimeoutMs: number;
      readonly shutdownTimeoutMs: number;
    },
  ) {
    this.options = options;
    this.child = spawn(spawnInput.command, [...spawnInput.args], {
      ...(spawnInput.cwd ? { cwd: spawnInput.cwd } : {}),
      ...(spawnInput.env ? { env: { ...process.env, ...spawnInput.env } } : {}),
      shell: process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.stdout = createInterface({ input: this.child.stdout });
    this.stderr = createInterface({ input: this.child.stderr });
    this.stdout.on("line", (line) => this.handleStdoutLine(line));
    this.stderr.on("line", (line) => {
      const trimmed = line.trim();
      if (trimmed) {
        pushBounded(this.logs, trimmed);
      }
    });
    this.child.once("error", (error) => {
      this.rejectAll(error);
    });
    this.child.once("exit", (code, signal) => {
      this.exited = true;
      this.rejectAll(new Error(`Hermes gateway exited (${code ?? signal ?? "unknown"})`));
    });
  }

  request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    if (this.exited || !this.child.stdin.writable) {
      return Promise.reject(new Error("Hermes gateway is not running."));
    }

    const id = String(++this.requestId);
    const payload = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    return new Promise<T>((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`Hermes gateway request timed out: ${method}`));
      }, this.options.requestTimeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => resolvePromise(value as T),
        reject: rejectPromise,
        timeout,
      });
      this.child.stdin.write(payload, (error) => {
        if (!error) {
          return;
        }
        const pending = this.pending.get(id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pending.delete(id);
        }
        rejectPromise(error);
      });
    });
  }

  onEvent(listener: (event: HermesGatewayEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  waitForEvent<TPayload = unknown>(
    type: string,
    options?: {
      readonly sessionId?: string;
      readonly timeoutMs?: number;
      readonly predicate?: (event: HermesGatewayEvent<TPayload>) => boolean;
    },
  ): Promise<HermesGatewayEvent<TPayload>> {
    if (type === "gateway.ready" && this.readyEvent) {
      return Promise.resolve(this.readyEvent as HermesGatewayEvent<TPayload>);
    }
    return new Promise((resolvePromise, rejectPromise) => {
      const waiter = {
        type,
        ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
        ...(options?.predicate
          ? { predicate: options.predicate as (event: HermesGatewayEvent) => boolean }
          : {}),
        resolve: (event: HermesGatewayEvent) =>
          resolvePromise(event as HermesGatewayEvent<TPayload>),
        reject: (error: Error) => rejectPromise(error),
        timeout: setTimeout(() => {
          this.eventWaiters.delete(waiter);
          rejectPromise(new Error(`Timed out waiting for Hermes gateway event: ${type}`));
        }, options?.timeoutMs ?? this.options.requestTimeoutMs),
      };
      this.eventWaiters.add(waiter);
    });
  }

  async stop(): Promise<void> {
    this.stdout.close();
    this.stderr.close();
    if (this.exited || this.child.exitCode !== null || this.child.signalCode !== null) {
      this.rejectAll(new Error("Hermes gateway stopped."));
      return;
    }

    await new Promise<void>((resolvePromise) => {
      const timeout = setTimeout(() => {
        this.child.kill("SIGKILL");
        resolvePromise();
      }, this.options.shutdownTimeoutMs);
      this.child.once("exit", () => {
        clearTimeout(timeout);
        resolvePromise();
      });
      this.child.stdin.end();
    });
    this.rejectAll(new Error("Hermes gateway stopped."));
  }

  private handleStdoutLine(line: string): void {
    let frame: HermesGatewayJsonRpcFrame;
    try {
      frame = JSON.parse(line) as HermesGatewayJsonRpcFrame;
    } catch {
      const preview = line.trim();
      if (preview) {
        pushBounded(this.logs, `[protocol] malformed stdout: ${preview.slice(0, 240)}`);
      }
      return;
    }

    const record = asRecord(frame);
    const id = frameId(record?.id);
    if (id) {
      this.resolvePending(id, frame);
      return;
    }

    if (record?.method === "event" && isGatewayEvent(record.params)) {
      this.publishEvent(record.params);
    }
  }

  private resolvePending(id: string, frame: HermesGatewayJsonRpcFrame): void {
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(id);

    const record = asRecord(frame);
    if (record && "error" in record) {
      pending.reject(new Error(`${pending.method}: ${rpcErrorMessage(record.error)}`));
      return;
    }
    pending.resolve(record?.result);
  }

  private publishEvent(event: HermesGatewayEvent): void {
    if (event.type === "gateway.ready") {
      this.readyEvent = event;
    }

    for (const listener of Array.from(this.listeners)) {
      try {
        listener(event);
      } catch (error) {
        pushBounded(
          this.logs,
          `[listener] ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    for (const waiter of Array.from(this.eventWaiters)) {
      if (waiter.type !== event.type) {
        continue;
      }
      if (waiter.sessionId && waiter.sessionId !== event.session_id) {
        continue;
      }
      if (waiter.predicate && !waiter.predicate(event)) {
        continue;
      }
      clearTimeout(waiter.timeout);
      this.eventWaiters.delete(waiter);
      waiter.resolve(event);
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      this.pending.delete(id);
      pending.reject(error);
    }
    for (const waiter of Array.from(this.eventWaiters)) {
      clearTimeout(waiter.timeout);
      this.eventWaiters.delete(waiter);
      waiter.reject(error);
    }
  }
}

export async function startHermesGatewayRuntime(
  input: HermesGatewayRuntimeOptions = {},
): Promise<HermesGatewayRuntime> {
  const spawnInput = input.spawn ?? (await resolveHermesGatewaySpawnInput(input));
  const runtime = new NodeHermesGatewayRuntime(spawnInput, {
    requestTimeoutMs: input.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    shutdownTimeoutMs: input.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
  });
  await runtime.waitForEvent("gateway.ready", {
    timeoutMs: input.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
  });
  return runtime;
}

export async function runHermesGatewaySmoke(
  input: HermesGatewayRuntimeOptions & {
    readonly prompt?: string;
  } = {},
): Promise<HermesGatewaySmokeResult> {
  const runtime = await startHermesGatewayRuntime(input);
  try {
    const session = await runtime.request<HermesGatewaySessionCreateResult>("session.create", {
      cols: 120,
    });
    const catalog = await runtime.request<HermesGatewayCommandsCatalogResult>(
      "commands.catalog",
      {},
    );
    const complete = runtime.waitForEvent<{ readonly text?: string }>("message.complete", {
      sessionId: session.session_id,
      timeoutMs: input.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    });
    const promptResult = await runtime.request<HermesGatewayPromptSubmitResult>("prompt.submit", {
      session_id: session.session_id,
      text: input.prompt ?? DEFAULT_SMOKE_PROMPT,
    });
    const completeEvent = await complete;
    return {
      ready: runtime.readyEvent?.type === "gateway.ready",
      sessionId: session.session_id,
      commandCount: catalog.pairs?.length ?? 0,
      promptStatus: promptResult.status,
      responseText:
        typeof completeEvent.payload?.text === "string" ? completeEvent.payload.text : "",
    };
  } finally {
    await runtime.stop();
  }
}
