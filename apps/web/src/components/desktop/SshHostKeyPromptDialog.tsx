import type { DesktopSshHostKeyPromptRequest } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

function describeSshTarget(request: DesktopSshHostKeyPromptRequest): string {
  const host =
    request.port && request.port !== 22
      ? `${request.destination}:${request.port}`
      : request.destination;
  return request.username ? `${request.username}@${host}` : host;
}

function formatRemainingSeconds(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function getPromptErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "SSH host key trust failed.";
  return message.includes("expired") || message.includes("no longer pending")
    ? "This SSH host key prompt expired. Try connecting again."
    : message;
}

export function SshHostKeyPromptDialog() {
  const [queue, setQueue] = useState<readonly DesktopSshHostKeyPromptRequest[]>([]);
  const [isResponding, setIsResponding] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [responseError, setResponseError] = useState<string | null>(null);
  const currentRequest = queue[0] ?? null;

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge?.onSshHostKeyPrompt) {
      return;
    }

    return bridge.onSshHostKeyPrompt((request) => {
      setQueue((currentQueue) => [...currentQueue, request]);
    });
  }, []);

  useEffect(() => {
    setResponseError(null);
    if (currentRequest) {
      setNow(Date.now());
    }
  }, [currentRequest]);

  useEffect(() => {
    if (!currentRequest) {
      return;
    }

    const interval = window.setInterval(() => {
      setNow(Date.now());
    }, 1_000);
    return () => {
      window.clearInterval(interval);
    };
  }, [currentRequest]);

  const expiresAtMs = currentRequest ? Date.parse(currentRequest.expiresAt) : Number.NaN;
  const remainingMs = Number.isFinite(expiresAtMs) ? Math.max(0, expiresAtMs - now) : null;
  const isExpired = remainingMs !== null && remainingMs <= 0;
  const remainingSeconds = remainingMs === null ? null : Math.ceil(remainingMs / 1_000);
  const remainingLabel =
    remainingSeconds === null ? null : formatRemainingSeconds(remainingSeconds);

  useEffect(() => {
    if (isExpired) {
      setResponseError("This SSH host key prompt expired. Try connecting again.");
    }
  }, [isExpired]);

  const removeCurrentPrompt = (requestId: string) => {
    setQueue((currentQueue) =>
      currentQueue[0]?.requestId === requestId ? currentQueue.slice(1) : currentQueue,
    );
    setResponseError(null);
  };

  const respond = async (trusted: boolean) => {
    if (!currentRequest || isResponding) {
      return;
    }

    const requestId = currentRequest.requestId;
    if (trusted && isExpired) {
      setResponseError("This SSH host key prompt expired. Try connecting again.");
      return;
    }

    setIsResponding(true);
    setResponseError(null);
    try {
      await window.desktopBridge?.resolveSshHostKeyPrompt(requestId, trusted);
      removeCurrentPrompt(requestId);
    } catch (error) {
      if (!trusted) {
        removeCurrentPrompt(requestId);
      } else {
        setResponseError(getPromptErrorMessage(error));
      }
    } finally {
      setIsResponding(false);
    }
  };

  const dismissExpiredPrompt = () => {
    if (currentRequest) {
      removeCurrentPrompt(currentRequest.requestId);
    }
  };

  const cancelPrompt = () => {
    if (isExpired) {
      dismissExpiredPrompt();
      return;
    }
    void respond(false);
  };

  const target = currentRequest ? describeSshTarget(currentRequest) : null;

  return (
    <Dialog
      open={currentRequest !== null}
      onOpenChange={(open) => {
        if (!open) {
          cancelPrompt();
        }
      }}
    >
      <DialogPopup className="max-w-lg" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Trust SSH Host?</DialogTitle>
          <DialogDescription>
            T-Hermes has not connected to {target ? <code>{target}</code> : "this SSH host"} before.
            Confirm the fingerprint matches the remote machine, then trust it for future
            connections.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4" scrollFade={false}>
          <div className="rounded-lg border border-border bg-muted/35 p-3 text-sm">
            <div className="grid gap-2 sm:grid-cols-[6rem_1fr]">
              <span className="text-muted-foreground">Host</span>
              <code className="break-all text-foreground">{currentRequest?.hostname}</code>
              <span className="text-muted-foreground">Alias</span>
              <code className="break-all text-foreground">{currentRequest?.destination}</code>
              <span className="text-muted-foreground">Port</span>
              <code className="text-foreground">{currentRequest?.port ?? 22}</code>
            </div>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium text-foreground">Host key fingerprints</p>
              {remainingLabel ? (
                <span
                  className={
                    isExpired
                      ? "shrink-0 text-xs font-medium text-destructive"
                      : "shrink-0 text-xs text-muted-foreground"
                  }
                >
                  {isExpired ? "Expired" : remainingLabel}
                </span>
              ) : null}
            </div>
            <div className="max-h-48 space-y-2 overflow-auto rounded-lg border border-border bg-background p-3">
              {currentRequest?.fingerprints.map((entry) => (
                <div key={`${entry.keyType}:${entry.fingerprint}`} className="space-y-1">
                  <div className="text-xs font-medium text-muted-foreground">{entry.keyType}</div>
                  <code className="block break-all text-sm text-foreground">
                    {entry.fingerprint}
                  </code>
                </div>
              ))}
            </div>
          </div>
          {responseError ? (
            <p className="text-sm text-destructive">{responseError}</p>
          ) : (
            <p className="text-sm text-muted-foreground">
              T-Hermes will save this key in its app data. It will not edit your personal SSH
              known_hosts file.
            </p>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button disabled={isResponding} type="button" variant="outline" onClick={cancelPrompt}>
            {isExpired ? "Dismiss" : "Cancel"}
          </Button>
          <Button
            disabled={isResponding || isExpired}
            type="button"
            onClick={() => {
              void respond(true);
            }}
          >
            Trust and Connect
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
