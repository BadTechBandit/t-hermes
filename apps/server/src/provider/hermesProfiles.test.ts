// @effect-diagnostics nodeBuiltinImport:off
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  discoverHermesProfilesFromFileSystem,
  resolveHermesProfilesRoot,
} from "./hermesProfiles.ts";

describe("Hermes profile discovery", () => {
  it("discovers the default profile and named profile directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "t-hermes-profiles-"));
    await mkdir(join(root, "profiles", "researcher"), { recursive: true });
    await mkdir(join(root, "profiles", "coder"), { recursive: true });
    await mkdir(join(root, "profiles", ".hidden"), { recursive: true });
    await writeFile(join(root, "profiles", "notes.txt"), "");

    const result = await discoverHermesProfilesFromFileSystem({ configuredHomePath: root });

    expect(result.rootHomePath).toBe(root);
    expect(result.warning).toBeUndefined();
    expect(result.profiles.map((profile) => profile.name)).toEqual([
      "default",
      "coder",
      "researcher",
    ]);
    expect(result.profiles[0]).toMatchObject({
      kind: "default",
      displayName: "Default",
      homePath: root,
    });
    expect(result.profiles[1]).toMatchObject({
      kind: "profile",
      homePath: join(root, "profiles", "coder"),
    });
  });

  it("treats a configured profile home as part of the same Hermes profile root", () => {
    const root = join(tmpdir(), "hermes-home");

    expect(resolveHermesProfilesRoot({ configuredHomePath: join(root, "profiles", "coder") })).toBe(
      root,
    );
  });

  it("keeps the default profile available when the profiles directory is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "t-hermes-no-profiles-"));

    const result = await discoverHermesProfilesFromFileSystem({ configuredHomePath: root });

    expect(result.warning).toBeUndefined();
    expect(result.profiles).toEqual([
      {
        id: "default",
        name: "default",
        displayName: "Default",
        homePath: root,
        kind: "default",
      },
    ]);
  });
});
