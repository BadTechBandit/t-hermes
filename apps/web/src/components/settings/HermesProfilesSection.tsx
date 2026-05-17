"use client";

import { CheckIcon, LoaderIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { HermesProfile, ServerSettings, UnifiedSettings } from "@t3tools/contracts";

import { ensureLocalApi } from "../../localApi";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import {
  buildHermesProfileProviderSettingsPatch,
  findHermesProfileProviderInstanceId,
} from "./SettingsPanels.logic";

interface HermesProfilesSectionProps {
  readonly settings: ServerSettings;
  readonly updateSettings: (patch: Partial<UnifiedSettings>) => void;
}

function profileDescription(profile: HermesProfile): string {
  return profile.kind === "default"
    ? `Main Hermes profile at ${profile.homePath}.`
    : `Hermes profile home: ${profile.homePath}.`;
}

export function HermesProfilesSection({ settings, updateSettings }: HermesProfilesSectionProps) {
  const [profiles, setProfiles] = useState<ReadonlyArray<HermesProfile>>([]);
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const loadProfiles = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await ensureLocalApi().server.discoverHermesProfiles();
      setProfiles(result.profiles);
      setWarning(result.warning ?? null);
    } catch (unknownError) {
      const message =
        unknownError instanceof Error ? unknownError.message : "Could not read Hermes profiles.";
      setError(message);
      setProfiles([]);
      setWarning(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  const addProfile = useCallback(
    (profile: HermesProfile) => {
      const patch = buildHermesProfileProviderSettingsPatch({ settings, profile });
      if (!patch) return;

      updateSettings(patch);
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "Hermes profile added",
          description: `${profile.displayName} is now available as a Hermes provider.`,
        }),
      );
      void ensureLocalApi()
        .server.refreshProviders()
        .catch(() => undefined);
    },
    [settings, updateSettings],
  );

  return (
    <SettingsSection
      title="Hermes Profiles"
      headerAction={
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                disabled={isLoading}
                onClick={() => void loadProfiles()}
                aria-label="Refresh Hermes profiles"
              >
                {isLoading ? (
                  <LoaderIcon className="size-3 animate-spin" />
                ) : (
                  <RefreshCwIcon className="size-3" />
                )}
              </Button>
            }
          />
          <TooltipPopup side="top">Refresh profiles</TooltipPopup>
        </Tooltip>
      }
    >
      <SettingsRow
        title="Profile picker"
        description="Add Hermes profiles as separate provider choices. Each one uses its own HERMES_HOME."
        status={
          error ? (
            <span className="block text-destructive">{error}</span>
          ) : warning ? (
            <span className="block text-amber-500">{warning}</span>
          ) : null
        }
      />

      {profiles.map((profile) => {
        const instanceId = findHermesProfileProviderInstanceId(settings, profile);
        const isAdded = instanceId !== undefined;
        return (
          <SettingsRow
            key={`${profile.kind}:${profile.homePath}`}
            title={profile.displayName}
            description={profileDescription(profile)}
            status={
              isAdded ? (
                <span className="font-mono text-[11px] text-muted-foreground/80">
                  Provider: {instanceId}
                </span>
              ) : null
            }
            control={
              <Button
                size="xs"
                variant={isAdded ? "secondary" : "outline"}
                disabled={isAdded}
                onClick={() => addProfile(profile)}
              >
                {isAdded ? <CheckIcon className="size-3" /> : <PlusIcon className="size-3" />}
                {isAdded ? "Added" : "Add provider"}
              </Button>
            }
          />
        );
      })}

      {!isLoading && profiles.length === 0 && !error ? (
        <SettingsRow
          title="No profiles found"
          description="Hermes profiles are discovered from the local Hermes profiles directory."
        />
      ) : null}
    </SettingsSection>
  );
}
