import { spawn } from "node:child_process";

import { desktopDir } from "./electron-launcher.mjs";

const childSpecs = [
  { name: "bundle", args: ["run", "dev:bundle"] },
  { name: "electron", args: ["run", "dev:electron"] },
];

const children = new Set();
let shuttingDown = false;
let exitCode = 0;

function waitForChildrenToExit() {
  if (children.size === 0) {
    process.exit(exitCode);
  }
}

function shutdown(code, signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  exitCode = code;

  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
    }
  }

  waitForChildrenToExit();
}

for (const spec of childSpecs) {
  const child = spawn("bun", spec.args, {
    cwd: desktopDir,
    env: process.env,
    stdio: "inherit",
  });

  children.add(child);

  child.once("error", (error) => {
    console.error(`[desktop-dev] ${spec.name} failed to start: ${error.message}`);
    children.delete(child);
    shutdown(1, "SIGTERM");
  });

  child.once("exit", (code, signal) => {
    children.delete(child);

    if (!shuttingDown) {
      const nextExitCode = code ?? (signal === null ? 0 : 1);
      shutdown(nextExitCode, "SIGTERM");
    }

    waitForChildrenToExit();
  });
}

process.once("SIGINT", () => {
  shutdown(130, "SIGINT");
});
process.once("SIGTERM", () => {
  shutdown(143, "SIGTERM");
});
process.once("SIGHUP", () => {
  shutdown(129, "SIGHUP");
});
