import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { SshPasswordPrompt } from "./auth.ts";
import { SshHostKeyPrompt, type SshHostKeyTrustRequest } from "./hostKey.ts";
import {
  buildRemoteLaunchScript,
  buildRemotePairingScript,
  buildRemoteStopScript,
  buildRemoteT3RunnerScript,
  describeReadinessCause,
  issueRemotePairingToken,
  launchOrReuseRemoteServer,
  REMOTE_T_HERMES_RUNNER_PROFILE,
  REMOTE_PICK_PORT_SCRIPT,
  SshEnvironmentManager,
  waitForHttpReady,
} from "./tunnel.ts";

const TEST_NODE_ENGINE_RANGE = "^22.16 || ^23.11 || >=24.10";

const makeSuccessfulProcess = (stdout: string) => {
  const stdoutStream = Stream.make(new TextEncoder().encode(stdout));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: stdoutStream,
    stderr: Stream.empty,
    all: stdoutStream,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const makeFailedProcess = (stderr: string, exitCode = 255) => {
  const stderrStream = Stream.make(new TextEncoder().encode(stderr));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.empty,
    stderr: stderrStream,
    all: stderrStream,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const makeRunningProcess = (onKill: () => void) => {
  let finish: ((exitCode: ChildProcessSpawner.ExitCode) => void) | null = null;
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode: Effect.callback<ChildProcessSpawner.ExitCode>((resume) => {
      finish = (exitCode) => resume(Effect.succeed(exitCode));
      return Effect.sync(() => {
        finish = null;
      });
    }),
    isRunning: Effect.succeed(true),
    kill: () =>
      Effect.sync(() => {
        onKill();
        finish?.(ChildProcessSpawner.ExitCode(143));
      }),
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const testHttpClient = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
);

const hangingHttpClient = HttpClient.make(() => Effect.never);

const testNetService = NetService.NetService.of({
  canListenOnHost: () => Effect.succeed(true),
  isPortAvailableOnLoopback: () => Effect.succeed(true),
  reserveLoopbackPort: () => Effect.succeed(41_773),
  findAvailablePort: (preferred) => Effect.succeed(preferred),
});

function commandArgs(command: ChildProcess.Command): ReadonlyArray<string> {
  return command._tag === "StandardCommand" ? command.args : [];
}

function commandName(command: ChildProcess.Command): string {
  return command._tag === "StandardCommand" ? command.command : "";
}

describe("ssh tunnel scripts", () => {
  it("builds the remote t3 runner with npx and npm fallbacks", () => {
    const script = buildRemoteT3RunnerScript({ nodeEngineRange: TEST_NODE_ENGINE_RANGE });

    assert.include(script, "T3_NODE_SCRIPT_PATH=''");
    assert.include(script, "T3_CLI_COMMAND='t3'");
    assert.include(script, 'exec "$T3_CLI_COMMAND" "$@"');
    assert.include(script, "exec npx --yes 't3@latest' \"$@\"");
    assert.include(script, "exec npm exec --yes 't3@latest' -- \"$@\"");
    assert.include(script, "could not install %s");
    assert.include(script, "\"$T3_CLI_COMMAND\" 't3@latest'");
    assert.include(script, '"$HOME/.local/bin"');
    assert.include(script, `T3_NODE_ENGINE_RANGE='${TEST_NODE_ENGINE_RANGE}'`);
    assert.include(script, "remote_node_satisfies_engine()");
    assert.include(script, "remote_node_binary_satisfies_engine()");
    assert.include(script, "use_node_dir_if_supported()");
    assert.include(script, "function satisfiesSemverRange");
    assert.include(script, "satisfiesSemverRange(rawVersion, range)");
    assert.include(script, 'prepend_path_if_dir "$VOLTA_HOME/bin"');
    assert.include(script, 'try_node_dirs "$HOME/.asdf/shims"');
    assert.include(script, 'try_node_dirs "$HOME/.local/share/mise/shims" "$HOME/.mise/shims"');
    assert.include(script, 'eval "$(fnm env --use-on-cd --shell sh)"');
    assert.include(script, 'try_node_dirs "$HOME/.nodenv/shims"');
    assert.include(script, 'NVM_DIR="$HOME/.nvm"');
    assert.include(script, "nvm use --silent default");
    assert.include(script, 'for T3_NODE_DIR in "$NVM_DIR"/versions/node/*/bin');
    assert.notInclude(script, "ensure $NVM_DIR/nvm.sh is available");
  });

  it("builds the remote t-hermes runner profile without changing the t3 default", () => {
    const script = buildRemoteT3RunnerScript({
      profile: REMOTE_T_HERMES_RUNNER_PROFILE,
      nodeEngineRange: TEST_NODE_ENGINE_RANGE,
    });

    assert.include(script, "T3_CLI_COMMAND='t-hermes'");
    assert.include(script, 'exec "$T3_CLI_COMMAND" "$@"');
    assert.include(script, "exec npx --yes 't-hermes@latest' \"$@\"");
    assert.include(script, "exec npm exec --yes 't-hermes@latest' -- \"$@\"");
    assert.notInclude(script, "exec npx --yes 't3@latest'");
  });

  it("does not hard-code a remote node engine range", () => {
    const script = buildRemoteT3RunnerScript();

    assert.include(script, "T3_NODE_ENGINE_RANGE=''");
    assert.notInclude(script, TEST_NODE_ENGINE_RANGE);
  });

  it("shell-quotes package specs in the remote t3 runner", () => {
    const script = buildRemoteT3RunnerScript({
      packageSpec: "t3@nightly; touch /tmp/t3-owned",
    });

    assert.include(script, "exec npx --yes 't3@nightly; touch /tmp/t3-owned' \"$@\"");
    assert.include(script, "exec npm exec --yes 't3@nightly; touch /tmp/t3-owned' -- \"$@\"");
    assert.notInclude(script, "exec npx --yes t3@nightly; touch /tmp/t3-owned");
  });

  it("builds the remote t3 runner with a node script override", () => {
    const script = buildRemoteT3RunnerScript({
      nodeScriptPath: "/Users/julius/Development/Work/codething-mvp/apps/server/dist/bin.mjs",
    });

    assert.include(
      script,
      "T3_NODE_SCRIPT_PATH='/Users/julius/Development/Work/codething-mvp/apps/server/dist/bin.mjs'",
    );
    assert.include(script, 'exec node "$T3_NODE_SCRIPT_PATH" "$@"');
  });

  it("uses the remote t3 runner for launch and pairing scripts", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;

    assert.include(
      buildRemoteLaunchScript({ nodeEngineRange: TEST_NODE_ENGINE_RANGE }),
      '[ -n "$REMOTE_PID" ] && [ -n "$REMOTE_PORT" ] && kill -0 "$REMOTE_PID" 2>/dev/null',
    );
    assert.include(buildRemoteLaunchScript(), "RUNNER_CHANGED=1");
    assert.include(buildRemoteLaunchScript(), 'STATE_DIR="$HOME/.t3/ssh-launch/$STATE_KEY"');
    assert.include(buildRemoteLaunchScript(), 'RUNNER_FILE="$STATE_DIR/run-t3.sh"');
    assert.include(buildRemoteLaunchScript(), "ensure_remote_node_path()");
    assert.include(buildRemoteLaunchScript(), "if ! ensure_remote_node_path; then");
    assert.include(
      buildRemoteLaunchScript({ nodeEngineRange: TEST_NODE_ENGINE_RANGE }),
      `T3_NODE_ENGINE_RANGE='${TEST_NODE_ENGINE_RANGE}'`,
    );
    assert.include(
      buildRemoteLaunchScript({ nodeEngineRange: TEST_NODE_ENGINE_RANGE }),
      "does not satisfy required range ",
    );
    assert.include(
      buildRemoteLaunchScript({ nodeEngineRange: TEST_NODE_ENGINE_RANGE }),
      "process.execPath",
    );
    assert.isBelow(
      buildRemoteLaunchScript().indexOf('"/opt/homebrew/bin"'),
      buildRemoteLaunchScript().indexOf('"/usr/local/bin"'),
    );
    assert.include(buildRemoteLaunchScript(), "use_node_dir_if_supported");
    assert.include(buildRemoteLaunchScript(), "try_nvm_node_dirs");
    assert.include(buildRemoteLaunchScript(), 'kill "$REMOTE_PID" 2>/dev/null || true');
    assert.include(buildRemoteLaunchScript(), "wait_ready");
    assert.include(buildRemoteLaunchScript(), '"$RUNNER_FILE" serve --host 127.0.0.1');
    assert.include(buildRemoteLaunchScript(), '--base-dir "$DEFAULT_SERVER_HOME"');
    assert.notInclude(buildRemoteLaunchScript(), "server-home");
    assert.include(buildRemoteLaunchScript(), "Remote T3 server did not become ready");
    assert.include(buildRemoteLaunchScript(), "nohup env T3CODE_NO_BROWSER='1'");
    assert.notInclude(buildRemoteLaunchScript(), "T3_HERMES_RUNTIME");
    assert.include(buildRemoteLaunchScript({ packageSpec: "t3@nightly" }), "t3@nightly");
    assert.include(
      buildRemotePairingScript(target),
      '"$RUNNER_FILE" auth pairing create --base-dir "$PAIRING_BASE_DIR" --json',
    );
    assert.include(buildRemotePairingScript(target), 'PAIRING_BASE_DIR="$DEFAULT_SERVER_HOME"');
    assert.notInclude(buildRemotePairingScript(target), "server-home");
    assert.include(buildRemotePairingScript(target, { packageSpec: "t3@nightly" }), "t3@nightly");
    assert.include(
      buildRemoteStopScript(target),
      'if [ "$REMOTE_MANAGED" != "external" ] && [ -n "$REMOTE_PID" ]',
    );
    assert.include(buildRemoteStopScript(target), 'kill "$REMOTE_PID" 2>/dev/null || true');
    assert.include(buildRemoteStopScript(target), 'rm -f "$PID_FILE" "$PORT_FILE" "$MANAGED_FILE"');
    assert.include(
      buildRemoteLaunchScript(),
      'DEFAULT_RUNTIME_FILE="$DEFAULT_SERVER_HOME/userdata/server-runtime.json"',
    );
    assert.include(buildRemoteLaunchScript(), "resolve_default_runtime_port()");
    assert.include(
      buildRemoteLaunchScript(),
      'DEFAULT_RUNTIME_INFO="$(resolve_default_runtime_port',
    );
    assert.include(
      buildRemoteLaunchScript(),
      "if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port))",
    );
    assert.include(buildRemoteLaunchScript(), 'PID_TO_STOP="${REMOTE_PID:-$DEFAULT_RUNTIME_PID}"');
    assert.include(buildRemoteLaunchScript(), 'REMOTE_PORT="$DEFAULT_REMOTE_PORT"');
    assert.include(buildRemoteLaunchScript(), 'rm -f "$PID_FILE"');
    assert.include(buildRemoteLaunchScript(), "printf 'external\\n' >\"$MANAGED_FILE\"");
    assert.include(buildRemoteLaunchScript(), 'if [ -z "$REMOTE_PORT" ]; then');
    assert.isBelow(
      buildRemoteLaunchScript().indexOf('if [ "$REMOTE_MANAGED" = "managed" ]'),
      buildRemoteLaunchScript().indexOf("printf 'external\\n' >\"$MANAGED_FILE\""),
    );
    assert.isBelow(
      buildRemoteLaunchScript().indexOf('DEFAULT_RUNTIME_INFO="$(resolve_default_runtime_port'),
      buildRemoteLaunchScript().indexOf('elif [ -n "$REMOTE_PID" ]'),
    );
  });

  it("builds isolated launch and pairing scripts for the t-hermes runner", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const runner = {
      profile: REMOTE_T_HERMES_RUNNER_PROFILE,
      nodeEngineRange: TEST_NODE_ENGINE_RANGE,
    };

    const launchScript = buildRemoteLaunchScript(runner);
    assert.include(launchScript, 'STATE_DIR="$HOME/.t-hermes/ssh-launch/$STATE_KEY"');
    assert.include(launchScript, 'DEFAULT_SERVER_HOME="$HOME/.t-hermes"');
    assert.include(launchScript, 'RUNNER_FILE="$STATE_DIR/run-t-hermes.sh"');
    assert.include(launchScript, "T3_HERMES_RUNTIME='gateway'");
    assert.include(launchScript, "Remote T-Hermes server did not become ready");
    assert.notInclude(launchScript, 'STATE_DIR="$HOME/.t3/ssh-launch/$STATE_KEY"');

    const pairingScript = buildRemotePairingScript(target, runner);
    assert.include(pairingScript, 'STATE_DIR="$HOME/.t-hermes/ssh-launch/');
    assert.include(pairingScript, 'DEFAULT_SERVER_HOME="$HOME/.t-hermes"');
    assert.include(pairingScript, 'RUNNER_FILE="$STATE_DIR/run-t-hermes.sh"');

    const stopScript = buildRemoteStopScript(target, runner);
    assert.include(stopScript, 'STATE_DIR="$HOME/.t-hermes/ssh-launch/');
    assert.notInclude(stopScript, 'STATE_DIR="$HOME/.t3/ssh-launch/');
  });

  it.effect("accepts launch JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(makeSuccessfulProcess('loaded nvm default\n{"remotePort":3774}\n')),
    );
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const processLayer = Layer.merge(NodeServices.layer, spawnerLayer);

    return Effect.gen(function* () {
      const result = yield* launchOrReuseRemoteServer(target);
      assert.equal(result.remotePort, 3774);
    }).pipe(Effect.provide(processLayer));
  });

  it("allows the remote port picker to run without a state file path", () => {
    assert.include(REMOTE_PICK_PORT_SCRIPT, 'const filePath = process.argv[2] ?? "";');
  });

  it.effect("bounds each HTTP readiness probe so retries cannot hang on one request", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        Effect.result(
          waitForHttpReady({
            baseUrl: "http://127.0.0.1:41773/",
            timeoutMs: 1_000,
            intervalMs: 100,
            probeTimeoutMs: 250,
          }),
        ),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(1_000));

      const result = yield* Fiber.join(fiber);

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.include(result.failure.message, "Timed out waiting 1000ms");
      }
    }).pipe(
      Effect.provide(
        Layer.merge(TestClock.layer(), Layer.succeed(HttpClient.HttpClient, hangingHttpClient)),
      ),
    ),
  );

  it("preserves primitive readiness reason values in diagnostic output", () => {
    assert.deepEqual(
      describeReadinessCause({
        _tag: "HttpClientError",
        message: "Backend readiness probe failed.",
        reason: "authentication failed",
        cause: "upstream closed",
      }),
      {
        _tag: "HttpClientError",
        message: "Backend readiness probe failed.",
        reason: "authentication failed",
        cause: "upstream closed",
      },
    );
  });

  it.effect("accepts pretty-printed pairing JSON from the remote CLI", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        makeSuccessfulProcess(`{
  "id": "88941235-6ed5-4184-a2ff-5339e2075958",
  "credential": "LCL4R2TPHDKQ",
  "role": "client",
  "expiresAt": "2026-04-29T01:01:20.994Z"
}

`),
      ),
    );
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const processLayer = Layer.merge(NodeServices.layer, spawnerLayer);
    return Effect.gen(function* () {
      const result = yield* issueRemotePairingToken(target);
      assert.equal(result.credential, "LCL4R2TPHDKQ");
    }).pipe(Effect.provide(processLayer));
  });

  it.effect("accepts pretty-printed pairing JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        makeSuccessfulProcess(`loaded nvm default
{
  "id": "88941235-6ed5-4184-a2ff-5339e2075958",
  "credential": "LCL4R2TPHDKQ",
  "role": "client",
  "expiresAt": "2026-04-29T01:01:20.994Z"
}

`),
      ),
    );
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const processLayer = Layer.merge(NodeServices.layer, spawnerLayer);
    return Effect.gen(function* () {
      const result = yield* issueRemotePairingToken(target);
      assert.equal(result.credential, "LCL4R2TPHDKQ");
    }).pipe(Effect.provide(processLayer));
  });

  it.effect("closes the tunnel scope and starts fresh after disconnect", () => {
    const spawnedCommands: Array<ReadonlyArray<string>> = [];
    let tunnelKillCount = 0;
    let stopCommandCount = 0;
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const args = commandArgs(command);
        spawnedCommands.push(args);
        if (args.includes("-N")) {
          return makeRunningProcess(() => {
            tunnelKillCount += 1;
          });
        }
        if (args.includes("sh") && args.includes("--")) {
          return makeSuccessfulProcess('{"remotePort":3773}\n');
        }
        if (args.includes("sh")) {
          stopCommandCount += 1;
          return makeSuccessfulProcess('{"stopped":true}\n');
        }
        return makeSuccessfulProcess("\n");
      }),
    );
    const layer = Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Layer.succeed(HttpClient.HttpClient, testHttpClient),
      Layer.succeed(NetService.NetService, testNetService),
      SshHostKeyPrompt.disabledLayer,
      SshPasswordPrompt.disabledLayer,
      SshEnvironmentManager.layer(),
    );
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;

    return Effect.gen(function* () {
      const manager = yield* SshEnvironmentManager;

      const first = yield* manager.ensureEnvironment(target);
      assert.equal(first.httpBaseUrl, "http://127.0.0.1:41773/");

      yield* manager.disconnectEnvironment(target);
      assert.equal(tunnelKillCount, 1);
      assert.equal(stopCommandCount, 1);

      yield* manager.ensureEnvironment(target);

      assert.equal(spawnedCommands.filter((args) => args.includes("-N")).length, 2);
      assert.equal(tunnelKillCount, 1);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.effect("prompts once for an unknown SSH host key and uses the trusted key", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-known-hosts-test-" });
      const knownHostsFile = path.join(tempDir, "known_hosts");
      const spawnedCommands: Array<{
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      }> = [];
      const trustRequests: SshHostKeyTrustRequest[] = [];
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          const name = commandName(command);
          const args = commandArgs(command);
          spawnedCommands.push({ command: name, args });

          if (name === "ssh-keyscan") {
            return makeSuccessfulProcess("devbox.example.com ssh-ed25519 QUJDRA==\n");
          }
          if (args.includes("-N")) {
            return makeRunningProcess(() => undefined);
          }
          if (args.includes("sh") && args.includes("--")) {
            return makeSuccessfulProcess('{"remotePort":3773}\n');
          }
          return makeSuccessfulProcess("\n");
        }),
      );
      const target = {
        alias: "devbox",
        hostname: "devbox.example.com",
        username: "julius",
        port: 2222,
      } as const;
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, testHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        Layer.succeed(
          SshHostKeyPrompt,
          SshHostKeyPrompt.of({
            isAvailable: true,
            request: (request) =>
              Effect.sync(() => {
                trustRequests.push(request);
                return true;
              }),
          }),
        ),
        SshPasswordPrompt.disabledLayer,
        SshEnvironmentManager.layer({ knownHostsFile }),
      );

      yield* Effect.gen(function* () {
        const manager = yield* SshEnvironmentManager;
        const result = yield* manager.ensureEnvironment(target);
        assert.equal(result.httpBaseUrl, "http://127.0.0.1:41773/");
      }).pipe(Effect.provide(layer), Effect.scoped);

      const knownHosts = yield* fs.readFileString(knownHostsFile);
      assert.include(knownHosts, "[devbox]:2222 ssh-ed25519 QUJDRA==");
      assert.equal(spawnedCommands.filter((entry) => entry.command === "ssh-keyscan").length, 1);
      assert.equal(trustRequests.length, 1);
      const sshCommands = spawnedCommands.filter(
        (entry) => entry.command === "ssh" && !entry.args.includes("-G"),
      );
      assert.isAtLeast(sshCommands.length, 2);
      for (const command of sshCommands) {
        assert.include(command.args, `UserKnownHostsFile=${knownHostsFile}`);
        assert.include(command.args, "StrictHostKeyChecking=yes");
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("disables public-key attempts on password-auth retry", () => {
    const spawnedCommands: Array<{
      readonly command: string;
      readonly args: ReadonlyArray<string>;
    }> = [];
    let launchAttempt = 0;
    let passwordPromptCount = 0;
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const name = commandName(command);
        const args = commandArgs(command);
        spawnedCommands.push({ command: name, args });

        if (name !== "ssh") {
          return makeSuccessfulProcess("\n");
        }
        if (args.includes("-N")) {
          return makeRunningProcess(() => undefined);
        }
        if (args.includes("sh") && args.includes("--")) {
          launchAttempt += 1;
          if (launchAttempt === 1) {
            return makeFailedProcess(
              "Received disconnect from devbox port 22:2: Too many authentication failures\n",
            );
          }
          return makeSuccessfulProcess('{"remotePort":3773}\n');
        }
        return makeSuccessfulProcess("\n");
      }),
    );
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const layer = Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Layer.succeed(HttpClient.HttpClient, testHttpClient),
      Layer.succeed(NetService.NetService, testNetService),
      SshHostKeyPrompt.disabledLayer,
      Layer.succeed(
        SshPasswordPrompt,
        SshPasswordPrompt.of({
          isAvailable: true,
          request: () =>
            Effect.sync(() => {
              passwordPromptCount += 1;
              return "remote-password";
            }),
        }),
      ),
      SshEnvironmentManager.layer(),
    );

    return Effect.gen(function* () {
      const manager = yield* SshEnvironmentManager;
      const result = yield* manager.ensureEnvironment(target);
      assert.equal(result.httpBaseUrl, "http://127.0.0.1:41773/");
      assert.equal(passwordPromptCount, 1);

      const launchCommands = spawnedCommands.filter(
        (entry) =>
          entry.command === "ssh" && entry.args.includes("sh") && entry.args.includes("--"),
      );
      assert.lengthOf(launchCommands, 2);
      assert.notInclude(launchCommands[0]!.args, "PubkeyAuthentication=no");
      assert.include(launchCommands[1]!.args, "PubkeyAuthentication=no");
      assert.include(
        launchCommands[1]!.args,
        "PreferredAuthentications=password,keyboard-interactive",
      );

      const tunnelCommand = spawnedCommands.find(
        (entry) => entry.command === "ssh" && entry.args.includes("-N"),
      );
      assert.isDefined(tunnelCommand);
      assert.include(tunnelCommand!.args, "PubkeyAuthentication=no");
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.effect("does not re-prompt when a known host key changes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-known-hosts-test-" });
      const knownHostsFile = path.join(tempDir, "known_hosts");
      yield* fs.writeFileString(knownHostsFile, "devbox ssh-ed25519 OLDKEY\n");
      const spawnedCommands: Array<{
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      }> = [];
      let trustRequestCount = 0;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          const name = commandName(command);
          const args = commandArgs(command);
          spawnedCommands.push({ command: name, args });

          if (name === "ssh-keyscan") {
            return makeSuccessfulProcess("devbox ssh-ed25519 NEWKEY\n");
          }
          return makeFailedProcess(
            [
              "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@",
              "@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @",
              "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@",
              "Host key verification failed.",
              "",
            ].join("\n"),
          );
        }),
      );
      const target = {
        alias: "devbox",
        hostname: "devbox.example.com",
        username: "julius",
        port: 22,
      } as const;
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, testHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        Layer.succeed(
          SshHostKeyPrompt,
          SshHostKeyPrompt.of({
            isAvailable: true,
            request: () =>
              Effect.sync(() => {
                trustRequestCount += 1;
                return true;
              }),
          }),
        ),
        SshPasswordPrompt.disabledLayer,
        SshEnvironmentManager.layer({ knownHostsFile }),
      );

      const result = yield* Effect.gen(function* () {
        const manager = yield* SshEnvironmentManager;
        return yield* Effect.result(manager.ensureEnvironment(target));
      }).pipe(Effect.provide(layer), Effect.scoped);

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.include(result.failure.message, "REMOTE HOST IDENTIFICATION HAS CHANGED");
      }
      assert.equal(spawnedCommands.filter((entry) => entry.command === "ssh-keyscan").length, 0);
      assert.equal(trustRequestCount, 0);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
