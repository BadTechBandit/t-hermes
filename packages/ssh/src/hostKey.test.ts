import { assert, describe, it } from "@effect/vitest";

import {
  buildSshHostKeyArgs,
  formatKnownHostsHost,
  knownHostsContainsHost,
  parseSshKeyscanOutput,
} from "./hostKey.ts";

describe("ssh host keys", () => {
  it("formats OpenSSH known_hosts host fields", () => {
    assert.equal(formatKnownHostsHost("devbox", null), "devbox");
    assert.equal(formatKnownHostsHost("devbox", 22), "devbox");
    assert.equal(formatKnownHostsHost("devbox", 2222), "[devbox]:2222");
  });

  it("builds strict SSH host key arguments for app-managed known_hosts", () => {
    assert.deepEqual(buildSshHostKeyArgs(), []);
    assert.deepEqual(buildSshHostKeyArgs({ knownHostsFile: "  " }), []);
    assert.deepEqual(buildSshHostKeyArgs({ knownHostsFile: "/tmp/t-hermes-known-hosts" }), [
      "-o",
      "UserKnownHostsFile=/tmp/t-hermes-known-hosts",
      "-o",
      "StrictHostKeyChecking=yes",
    ]);
  });

  it("parses keyscan output into rewritten known_hosts lines", () => {
    const keys = parseSshKeyscanOutput(
      [
        "# devbox:22 SSH-2.0-OpenSSH_9.9",
        "devbox.example.com ssh-ed25519 QUJDRA==",
        "devbox.example.com ssh-ed25519 QUJDRA==",
        "devbox.example.com ssh-rsa RUZHSA==",
        "",
      ].join("\n"),
      "devbox",
    );

    assert.equal(keys.length, 2);
    assert.equal(keys[0]?.knownHostsLine, "devbox ssh-ed25519 QUJDRA==");
    assert.equal(keys[0]?.fingerprint, "SHA256:4S4RWs9FUrJWi1XpPL05OUxO+ByCRH+vyZeIKgLSNnc");
    assert.equal(keys[1]?.knownHostsLine, "devbox ssh-rsa RUZHSA==");
  });

  it("detects exact host entries without accepting hashed entries", () => {
    const rawKnownHosts = [
      "devbox,devbox.local ssh-ed25519 AAAA",
      "[devbox.example.com]:2222 ssh-ed25519 BBBB",
      "|1|hashed|entry ssh-ed25519 CCCC",
      "",
    ].join("\n");

    assert.isTrue(knownHostsContainsHost(rawKnownHosts, "devbox"));
    assert.isTrue(knownHostsContainsHost(rawKnownHosts, "devbox.local"));
    assert.isTrue(knownHostsContainsHost(rawKnownHosts, "[devbox.example.com]:2222"));
    assert.isFalse(knownHostsContainsHost(rawKnownHosts, "devbox.example.com"));
    assert.isFalse(knownHostsContainsHost(rawKnownHosts, "|1|hashed|entry"));
  });
});
