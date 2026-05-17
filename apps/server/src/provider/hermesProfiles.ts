// @effect-diagnostics nodeBuiltinImport:off
import { readdir as nodeReaddir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import type { HermesProfile, HermesProfileDiscoveryResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

type Readdir = typeof nodeReaddir;

export interface HermesProfileDiscoveryInput {
  readonly configuredHomePath?: string | undefined;
  readonly homeDirectory?: string | undefined;
  readonly readdir?: Readdir | undefined;
}

function expandHomePath(input: string, homeDirectory: string): string {
  if (input === "~") {
    return homeDirectory;
  }
  if (input.startsWith("~/")) {
    return join(homeDirectory, input.slice(2));
  }
  return resolve(input);
}

export function resolveHermesProfilesRoot(input: {
  readonly configuredHomePath?: string | undefined;
  readonly homeDirectory?: string | undefined;
}): string {
  const homeDirectory = input.homeDirectory ?? homedir();
  const configuredHomePath = input.configuredHomePath?.trim() || "~/.hermes";
  const expandedHomePath = expandHomePath(configuredHomePath, homeDirectory);

  if (basename(dirname(expandedHomePath)) === "profiles") {
    return dirname(dirname(expandedHomePath));
  }

  return expandedHomePath;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function discoverHermesProfilesFromFileSystem(
  input: HermesProfileDiscoveryInput = {},
): Promise<HermesProfileDiscoveryResult> {
  const rootHomePath = resolveHermesProfilesRoot(input);
  const profilesDirectory = join(rootHomePath, "profiles");
  const readdir = input.readdir ?? nodeReaddir;
  const profiles: HermesProfile[] = [
    {
      id: "default",
      name: "default",
      displayName: "Default",
      homePath: rootHomePath,
      kind: "default",
    },
  ];
  let warning: string | undefined;

  try {
    const entries = await readdir(profilesDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const name = entry.name.trim();
      if (!entry.isDirectory() || name.length === 0 || name.startsWith(".")) {
        continue;
      }
      profiles.push({
        id: name,
        name,
        displayName: name,
        homePath: join(profilesDirectory, entry.name),
        kind: "profile",
      });
    }
  } catch (error) {
    const code = errorCode(error);
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      warning = `Could not read Hermes profiles from ${profilesDirectory}: ${errorMessage(error)}`;
    }
  }

  const [defaultProfile, ...namedProfiles] = profiles;
  namedProfiles.sort((left, right) =>
    left.displayName.localeCompare(right.displayName, undefined, { sensitivity: "base" }),
  );

  return {
    rootHomePath,
    profiles: [defaultProfile!, ...namedProfiles],
    ...(warning ? { warning } : {}),
  };
}

export function discoverHermesProfiles(
  input: HermesProfileDiscoveryInput = {},
): Effect.Effect<HermesProfileDiscoveryResult> {
  return Effect.promise(() => discoverHermesProfilesFromFileSystem(input));
}
