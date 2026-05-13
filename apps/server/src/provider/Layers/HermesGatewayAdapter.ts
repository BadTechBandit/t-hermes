// @effect-diagnostics globalDate:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics outdatedApi:off
// @effect-diagnostics runEffectInsideEffect:off
import {
  ApprovalRequestId,
  EventId,
  type HermesSettings,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  startHermesGatewayRuntime,
  type HermesGatewayRuntime,
  type HermesGatewayRuntimeOptions,
} from "../hermesGateway/HermesGatewayRuntime.ts";
import type {
  HermesGatewayCommandsCatalogResult,
  HermesGatewayEvent,
  HermesGatewayModelOptionsResult,
} from "../hermesGateway/HermesGatewayProtocol.ts";
import { formatHermesAcpText } from "./HermesAdapter.ts";

const PROVIDER = ProviderDriverKind.make("hermes");
const HERMES_FALLBACK_MODEL_SLUG = "hermes-agent";
const GATEWAY_STARTUP_TIMEOUT_MS = 15_000;
const GATEWAY_REQUEST_TIMEOUT_MS = 120_000;

export interface HermesGatewayAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly instanceId?: typeof ProviderInstanceId.Type;
  readonly gatewayRuntimeOptions?: Partial<HermesGatewayRuntimeOptions>;
}

interface GatewaySessionContext {
  session: ProviderSession;
  readonly runtime: HermesGatewayRuntime;
  readonly gatewaySessionId: string;
  readonly turns: Array<{ readonly id: TurnId; readonly items: ReadonlyArray<unknown> }>;
  readonly pendingApprovals: Map<
    ApprovalRequestId,
    { readonly turnId: TurnId | undefined; readonly detail: string; readonly payload: unknown }
  >;
  readonly pendingUserInputs: Map<
    ApprovalRequestId,
    {
      readonly turnId: TurnId | undefined;
      readonly gatewayRequestId: string;
      readonly method: "clarify.respond" | "sudo.respond" | "secret.respond";
      readonly answerKey: "answer" | "password" | "value";
      readonly questionId: string;
    }
  >;
}

interface GatewayCommandDispatchResult {
  readonly type?: string;
  readonly message?: string;
  readonly output?: string;
  readonly notice?: string;
  readonly warning?: string;
  readonly name?: string;
}

interface GatewaySlashExecResult {
  readonly output?: string;
  readonly warning?: string;
}

interface GatewayToolsShowResult {
  readonly total?: number;
  readonly sections?: ReadonlyArray<unknown>;
}

interface GatewaySessionListResult {
  readonly sessions?: ReadonlyArray<unknown>;
}

interface GatewayReasoningConfigResult {
  readonly value?: string;
  readonly display?: string;
}

const ANSI_ESCAPE_PATTERN = new RegExp(
  String.raw`[\u001b\u009b][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))`,
  "gu",
);
const OSC_ESCAPE_PATTERN = new RegExp(String.raw`\u001b\][^\u0007]*(?:\u0007|\u001b\\)`, "gu");
const CONTROL_CHARACTER_PATTERN = new RegExp(
  String.raw`[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]`,
  "gu",
);
const BOX_DRAWING_PATTERN = /[┌┐└┘├┤┬┴┼─│╭╮╰╯═║╔╗╚╝]/u;
const MAX_DESCRIPTION_LENGTH = 220;
const DEFAULT_SESSION_LIST_LIMIT = 30;
const MAX_SESSION_LIST_LIMIT = 100;

function nowIso(): string {
  return new Date().toISOString();
}

function eventStamp(): { readonly eventId: EventId; readonly createdAt: string } {
  return { eventId: EventId.make(crypto.randomUUID()), createdAt: nowIso() };
}

function requestedHermesModel(
  modelSelection: { readonly instanceId: ProviderInstanceId; readonly model: string } | undefined,
  boundInstanceId: ProviderInstanceId,
): string | undefined {
  if (modelSelection?.instanceId !== boundInstanceId) {
    return undefined;
  }
  const model = modelSelection.model.trim();
  if (!model || model === HERMES_FALLBACK_MODEL_SLUG) {
    return undefined;
  }
  return model;
}

function parseSlash(input: string): { readonly name: string; readonly arg: string } | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }
  const [name = "", ...rest] = trimmed.slice(1).split(/\s+/u);
  const normalizedName = name.trim().toLowerCase();
  if (!normalizedName) {
    return undefined;
  }
  return { name: normalizedName, arg: rest.join(" ").trim() };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(value: unknown, key: string): string | undefined {
  const candidate = asRecord(value)[key];
  return typeof candidate === "string" && candidate.trim() ? candidate : undefined;
}

function stringArrayField(value: unknown, key: string): ReadonlyArray<string> {
  const candidate = asRecord(value)[key];
  if (!Array.isArray(candidate)) {
    return [];
  }
  return candidate
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

function removeBackspaceOverwrites(input: string): string {
  const chars: string[] = [];
  for (const char of input) {
    if (char === "\b") {
      chars.pop();
      continue;
    }
    chars.push(char);
  }
  return chars.join("");
}

function cleanHermesGatewayText(text: string): string {
  return removeBackspaceOverwrites(text)
    .replace(OSC_ESCAPE_PATTERN, "")
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(/\r\n/gu, "\n")
    .replace(/\r/gu, "\n")
    .replace(CONTROL_CHARACTER_PATTERN, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""))
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function compactDescription(value: unknown, maxLength = MAX_DESCRIPTION_LENGTH): string {
  const cleaned = cleanHermesGatewayText(typeof value === "string" ? value : String(value ?? ""))
    .replace(/\s+/gu, " ")
    .trim();
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  return `${cleaned.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function markdownCode(value: string): string {
  return `\`${value.replace(/`/gu, "\\`")}\``;
}

function markdownBullet(label: string, value: string): string {
  return `- ${label}: ${value}`;
}

function commandPairs(
  value: unknown,
): ReadonlyArray<{ readonly name: string; readonly description: string }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (!Array.isArray(entry) || entry.length < 2) {
      return [];
    }
    const name = typeof entry[0] === "string" ? entry[0].trim() : "";
    const description = compactDescription(entry[1]);
    if (!name.startsWith("/") || !description) {
      return [];
    }
    return [{ name, description }];
  });
}

function parseSessionLimit(arg: string): number {
  const raw = arg.trim().match(/\d+/u)?.[0];
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_SESSION_LIST_LIMIT;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SESSION_LIST_LIMIT;
  }
  return Math.min(parsed, MAX_SESSION_LIST_LIMIT);
}

function formatEpoch(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  const timestampMs = value > 10_000_000_000 ? value : value * 1000;
  const date = new Date(timestampMs);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date.toISOString().replace("T", " ").slice(0, 16);
}

function formatLabeledOutput(title: string, text: string): string {
  const cleaned = cleanHermesGatewayText(text);
  const lines = cleaned
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.toLowerCase() !== title.toLowerCase());
  const formatted = lines.map((line) => {
    const match = line.match(/^([^:]{2,48}):\s*(.+)$/u);
    if (!match) {
      return line;
    }
    return markdownBullet(match[1]?.trim() ?? "", match[2]?.trim() ?? "");
  });
  return [`**${title}**`, "", ...formatted].join("\n");
}

export function formatHermesGatewayCommandCatalog(
  catalog: HermesGatewayCommandsCatalogResult,
): string {
  const lines = ["**Hermes commands**"];
  const seen = new Set<string>();
  const categories = Array.isArray(catalog.categories) ? catalog.categories : [];

  for (const rawCategory of categories) {
    const category = asRecord(rawCategory);
    const categoryName =
      typeof category.name === "string" && category.name.trim() ? category.name.trim() : "Commands";
    const pairs = commandPairs(category.pairs).filter((pair) => {
      const key = pair.name.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
    if (pairs.length === 0) {
      continue;
    }
    lines.push(
      "",
      `**${categoryName}**`,
      ...pairs.map((pair) => `- ${markdownCode(pair.name)} - ${pair.description}`),
    );
  }

  const uncategorized = commandPairs(catalog.pairs).filter((pair) => {
    const key = pair.name.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  if (uncategorized.length > 0) {
    lines.push(
      "",
      "**Other**",
      ...uncategorized.map((pair) => `- ${markdownCode(pair.name)} - ${pair.description}`),
    );
  }

  if (typeof catalog.skill_count === "number" && catalog.skill_count > 0) {
    lines.push(
      "",
      `${catalog.skill_count} skill command${catalog.skill_count === 1 ? "" : "s"} available.`,
    );
  }
  if (catalog.warning?.trim()) {
    lines.push("", `Warning: ${compactDescription(catalog.warning)}`);
  }
  if (lines.length === 1) {
    lines.push("", "No gateway commands were returned.");
  }
  return lines.join("\n");
}

export function formatHermesGatewayToolsShow(result: GatewayToolsShowResult): string {
  const lines = ["**Hermes tools**"];
  const sections = Array.isArray(result.sections) ? result.sections : [];
  let renderedTools = 0;

  if (typeof result.total === "number" && Number.isFinite(result.total)) {
    lines.push("", `${result.total} tool${result.total === 1 ? "" : "s"} available.`);
  }

  for (const rawSection of sections) {
    const section = asRecord(rawSection);
    const sectionName =
      typeof section.name === "string" && section.name.trim() ? section.name.trim() : "Tools";
    const tools = Array.isArray(section.tools) ? section.tools : [];
    const rows = tools.flatMap((rawTool) => {
      const tool = asRecord(rawTool);
      const name = typeof tool.name === "string" ? tool.name.trim() : "";
      if (!name) {
        return [];
      }
      renderedTools += 1;
      return [{ name, description: compactDescription(tool.description || "No description.") }];
    });
    if (rows.length === 0) {
      continue;
    }
    lines.push(
      "",
      `**${sectionName}**`,
      ...rows.map((row) => `- ${markdownCode(row.name)} - ${row.description}`),
    );
  }

  if (renderedTools === 0) {
    lines.push("", "No tools were returned.");
  }
  return lines.join("\n");
}

export function formatHermesGatewaySessionList(
  result: GatewaySessionListResult,
  requestedLimit = DEFAULT_SESSION_LIST_LIMIT,
): string {
  const sessions = Array.isArray(result.sessions) ? result.sessions : [];
  if (sessions.length === 0) {
    return ["**Hermes sessions**", "", "No sessions found."].join("\n");
  }

  const renderedSessions = sessions.slice(0, requestedLimit);
  const lines = [
    "**Hermes sessions**",
    "",
    `Showing ${renderedSessions.length} recent session${renderedSessions.length === 1 ? "" : "s"}.`,
  ];

  renderedSessions.forEach((rawSession, index) => {
    const session = asRecord(rawSession);
    const id = typeof session.id === "string" ? session.id.trim() : "";
    const title = compactDescription(session.title || session.preview || id || "Untitled", 96);
    const preview = compactDescription(session.preview || "", 160);
    const source = typeof session.source === "string" ? session.source.trim() : "";
    const messageCount =
      typeof session.message_count === "number" && Number.isFinite(session.message_count)
        ? session.message_count
        : undefined;
    const startedAt = formatEpoch(session.started_at);
    lines.push(
      "",
      `${index + 1}. **${title}**`,
      ...(id ? [markdownBullet("ID", markdownCode(id))] : []),
      ...(source ? [markdownBullet("Source", markdownCode(source))] : []),
      ...(messageCount !== undefined ? [markdownBullet("Messages", String(messageCount))] : []),
      ...(startedAt ? [markdownBullet("Started", `${startedAt} UTC`)] : []),
      ...(preview ? [markdownBullet("Preview", preview)] : []),
    );
  });

  return lines.join("\n");
}

export function formatHermesGatewayModelOptions(result: HermesGatewayModelOptionsResult): string {
  const lines = [
    "**Hermes model**",
    "",
    markdownBullet("Provider", markdownCode(result.provider || "unknown")),
    markdownBullet("Model", markdownCode(result.model || "unknown")),
  ];
  const providers = Array.isArray(result.providers) ? result.providers : [];
  const authenticated = providers.filter(
    (provider) => provider.authenticated || provider.is_current,
  );

  if (authenticated.length > 0) {
    lines.push(
      "",
      "**Available providers**",
      ...authenticated.map((provider) => {
        const slug = provider.slug || provider.name || "provider";
        const name = provider.name && provider.name !== slug ? ` (${provider.name})` : "";
        const modelCount = Array.isArray(provider.models) ? provider.models.length : undefined;
        const count =
          modelCount !== undefined ? ` - ${modelCount} model${modelCount === 1 ? "" : "s"}` : "";
        const current = provider.is_current ? " - current" : "";
        return `- ${markdownCode(slug)}${name}${count}${current}`;
      }),
    );
  }

  return lines.join("\n");
}

export function formatHermesGatewayReasoning(result: GatewayReasoningConfigResult): string {
  return [
    "**Hermes reasoning**",
    "",
    markdownBullet("Effort", markdownCode(result.value || "default")),
    markdownBullet("Display", markdownCode(result.display || "unknown")),
  ].join("\n");
}

export function formatHermesGatewayText(input: {
  readonly commandName?: string | undefined;
  readonly text: string;
}): string {
  const cleaned = cleanHermesGatewayText(input.text);
  if (!cleaned) {
    return input.text;
  }

  const acpFormatted = formatHermesAcpText(cleaned);
  if (acpFormatted !== cleaned) {
    return acpFormatted;
  }

  if (BOX_DRAWING_PATTERN.test(cleaned)) {
    const title = input.commandName ? `/${input.commandName}` : "Hermes output";
    return [`**${title}**`, "", "```text", cleaned, "```"].join("\n");
  }

  return cleaned;
}

function usageNumber(usage: unknown, key: string): number | undefined {
  const value = asRecord(usage)[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function answerFromUserInputAnswers(answers: ProviderUserInputAnswers, questionId: string): string {
  const direct = answers[questionId];
  const value = direct !== undefined ? direct : Object.values(answers)[0];
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry).trim())
      .filter((entry) => entry.length > 0)
      .join(", ");
  }
  return value === undefined || value === null ? "" : String(value).trim();
}

function approvalChoice(decision: ProviderApprovalDecision): "once" | "session" | "deny" {
  switch (decision) {
    case "accept":
      return "once";
    case "acceptForSession":
      return "session";
    case "cancel":
    case "decline":
    default:
      return "deny";
  }
}

function gatewayRequestError(method: string, cause: unknown): ProviderAdapterRequestError {
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}

function makeContentDeltaEvent(input: {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly itemId?: string;
  readonly text: string;
  readonly streamKind: "assistant_text" | "reasoning_text";
  readonly rawPayload: unknown;
}): ProviderRuntimeEvent {
  return {
    type: "content.delta",
    ...eventStamp(),
    provider: PROVIDER,
    threadId: input.threadId,
    turnId: input.turnId,
    ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
    payload: {
      streamKind: input.streamKind,
      delta: input.text,
    },
    raw: {
      source: "acp.hermes-gateway.extension",
      method: "event",
      payload: input.rawPayload,
    },
  };
}

function makeGatewayAssistantItemEvent(input: {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly itemId: string;
  readonly lifecycle: "item.started" | "item.completed";
  readonly rawPayload: unknown;
}): ProviderRuntimeEvent {
  return {
    type: input.lifecycle,
    ...eventStamp(),
    provider: PROVIDER,
    threadId: input.threadId,
    turnId: input.turnId,
    itemId: RuntimeItemId.make(input.itemId),
    payload: {
      itemType: "assistant_message",
      status: input.lifecycle === "item.completed" ? "completed" : "inProgress",
    },
    raw: {
      source: "acp.hermes-gateway.extension",
      method: "event",
      payload: input.rawPayload,
    },
  };
}

function makeGatewayToolItemEvent(input: {
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly lifecycle: "item.started" | "item.updated" | "item.completed";
  readonly payload: unknown;
  readonly rawPayload: unknown;
}): ProviderRuntimeEvent {
  const payload = asRecord(input.payload);
  const toolId =
    stringField(payload, "tool_id") ??
    stringField(payload, "id") ??
    stringField(payload, "name") ??
    crypto.randomUUID();
  const name = stringField(payload, "name") ?? stringField(payload, "tool_name") ?? "tool";
  const summary =
    stringField(payload, "summary") ??
    stringField(payload, "preview") ??
    stringField(payload, "context") ??
    stringField(payload, "error");
  const failed = Boolean(payload.error);
  return {
    type: input.lifecycle,
    ...eventStamp(),
    provider: PROVIDER,
    threadId: input.threadId,
    turnId: input.turnId,
    itemId: RuntimeItemId.make(toolId),
    payload: {
      itemType:
        name.includes("shell") || name.includes("exec") ? "command_execution" : "dynamic_tool_call",
      status:
        input.lifecycle === "item.completed" ? (failed ? "failed" : "completed") : "inProgress",
      title: name,
      ...(summary ? { detail: summary } : {}),
      data: payload,
    },
    raw: {
      source: "acp.hermes-gateway.extension",
      method: "event",
      payload: input.rawPayload,
    },
  };
}

function makeGatewayToolProgressEvent(input: {
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly payload: unknown;
  readonly rawPayload: unknown;
}): ProviderRuntimeEvent {
  const payload = asRecord(input.payload);
  return {
    type: "tool.progress",
    ...eventStamp(),
    provider: PROVIDER,
    threadId: input.threadId,
    turnId: input.turnId,
    payload: {
      ...(stringField(payload, "tool_id") ? { toolUseId: stringField(payload, "tool_id") } : {}),
      ...(stringField(payload, "name") ? { toolName: stringField(payload, "name") } : {}),
      ...(stringField(payload, "preview")
        ? { summary: stringField(payload, "preview") }
        : stringField(payload, "text")
          ? { summary: stringField(payload, "text") }
          : {}),
    },
    raw: {
      source: "acp.hermes-gateway.extension",
      method: "event",
      payload: input.rawPayload,
    },
  };
}

function makeGatewayApprovalRequestEvent(input: {
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly requestId: RuntimeRequestId;
  readonly payload: unknown;
}): ProviderRuntimeEvent {
  const detail =
    stringField(input.payload, "description") ??
    stringField(input.payload, "command") ??
    "Hermes requested approval.";
  return {
    type: "request.opened",
    ...eventStamp(),
    provider: PROVIDER,
    threadId: input.threadId,
    turnId: input.turnId,
    requestId: input.requestId,
    payload: {
      requestType: "exec_command_approval",
      detail,
      args: input.payload,
    },
    raw: {
      source: "acp.hermes-gateway.extension",
      method: "approval.request",
      payload: input.payload,
    },
  };
}

function makeGatewayApprovalResolvedEvent(input: {
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly requestId: RuntimeRequestId;
  readonly decision: ProviderApprovalDecision;
}): ProviderRuntimeEvent {
  return {
    type: "request.resolved",
    ...eventStamp(),
    provider: PROVIDER,
    threadId: input.threadId,
    turnId: input.turnId,
    requestId: input.requestId,
    payload: {
      requestType: "exec_command_approval",
      decision: input.decision,
    },
  };
}

function questionForGatewayInput(input: {
  readonly kind: "clarify" | "sudo" | "secret";
  readonly requestId: string;
  readonly payload: unknown;
}): UserInputQuestion {
  if (input.kind === "clarify") {
    const choices = stringArrayField(input.payload, "choices");
    return {
      id: "answer",
      header: "Hermes",
      question: stringField(input.payload, "question") ?? "Hermes needs clarification.",
      options:
        choices.length > 0
          ? choices.map((choice) => ({ label: choice, description: choice }))
          : [{ label: "Answer", description: "Type a custom answer." }],
    };
  }
  if (input.kind === "sudo") {
    return {
      id: "password",
      header: "Sudo",
      question: "Hermes requested a sudo password.",
      options: [{ label: "Skip", description: "Continue without providing a password." }],
    };
  }
  return {
    id: "value",
    header: "Secret",
    question: stringField(input.payload, "prompt") ?? "Hermes requested a secret value.",
    options: [{ label: "Skip", description: "Continue without saving a value." }],
  };
}

function makeGatewayUserInputRequestedEvent(input: {
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly requestId: RuntimeRequestId;
  readonly question: UserInputQuestion;
  readonly rawPayload: unknown;
  readonly method: string;
}): ProviderRuntimeEvent {
  return {
    type: "user-input.requested",
    ...eventStamp(),
    provider: PROVIDER,
    threadId: input.threadId,
    turnId: input.turnId,
    requestId: input.requestId,
    payload: { questions: [input.question] },
    raw: {
      source: "acp.hermes-gateway.extension",
      method: input.method,
      payload: input.rawPayload,
    },
  };
}

function makeGatewayUserInputResolvedEvent(input: {
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly requestId: RuntimeRequestId;
  readonly answers: ProviderUserInputAnswers;
}): ProviderRuntimeEvent {
  return {
    type: "user-input.resolved",
    ...eventStamp(),
    provider: PROVIDER,
    threadId: input.threadId,
    turnId: input.turnId,
    requestId: input.requestId,
    payload: { answers: input.answers },
  };
}

function makeRuntimeErrorEvent(input: {
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly message: string;
  readonly rawPayload: unknown;
}): ProviderRuntimeEvent {
  return {
    type: "runtime.error",
    ...eventStamp(),
    provider: PROVIDER,
    threadId: input.threadId,
    turnId: input.turnId,
    payload: {
      message: input.message,
      class: "provider_error",
    },
    raw: {
      source: "acp.hermes-gateway.extension",
      method: "event",
      payload: input.rawPayload,
    },
  };
}

function makeUsageEvent(input: {
  readonly threadId: ThreadId;
  readonly usage: unknown;
  readonly rawPayload: unknown;
}): ProviderRuntimeEvent | undefined {
  const usedTokens =
    usageNumber(input.usage, "context_used") ??
    usageNumber(input.usage, "total") ??
    usageNumber(input.usage, "input");
  if (usedTokens === undefined) {
    return undefined;
  }
  const maxTokens = usageNumber(input.usage, "context_max");
  return {
    type: "thread.token-usage.updated",
    ...eventStamp(),
    provider: PROVIDER,
    threadId: input.threadId,
    payload: {
      usage: {
        usedTokens,
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        compactsAutomatically: true,
      },
    },
    raw: {
      source: "acp.hermes-gateway.extension",
      method: "event",
      payload: input.rawPayload,
    },
  };
}

export function makeHermesGatewayAdapter(
  hermesSettings: HermesSettings,
  options?: HermesGatewayAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("hermes");
    const gatewayRequestTimeoutMs =
      options?.gatewayRuntimeOptions?.requestTimeoutMs ?? GATEWAY_REQUEST_TIMEOUT_MS;
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, GatewaySessionContext>();

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);
    const emitRuntimeEvent = (event: ProviderRuntimeEvent) => {
      Effect.runFork(offerRuntimeEvent(event));
    };

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<GatewaySessionContext, ProviderAdapterSessionNotFoundError> =>
      Effect.sync(() => sessions.get(threadId)).pipe(
        Effect.flatMap((session) =>
          session
            ? Effect.succeed(session)
            : Effect.fail(
                new ProviderAdapterSessionNotFoundError({
                  provider: PROVIDER,
                  threadId,
                }),
              ),
        ),
      );

    const requestGateway = <T>(
      ctx: GatewaySessionContext,
      method: string,
      params: unknown,
    ): Effect.Effect<T, ProviderAdapterRequestError> =>
      Effect.tryPromise({
        try: () => ctx.runtime.request<T>(method, params),
        catch: (cause) => gatewayRequestError(method, cause),
      });

    const switchGatewayModel = (
      ctx: GatewaySessionContext,
      model: string,
    ): Effect.Effect<void, ProviderAdapterRequestError> =>
      requestGateway(ctx, "config.set", {
        session_id: ctx.gatewaySessionId,
        key: "model",
        value: model,
      }).pipe(Effect.asVoid);

    const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
      Effect.gen(function* () {
        const runtime = yield* Effect.tryPromise({
          try: () => {
            const runtimeOptions: HermesGatewayRuntimeOptions = {
              hermesBinaryPath: hermesSettings.binaryPath,
              cwd: input.cwd ?? process.cwd(),
              homePath: hermesSettings.homePath,
              startupTimeoutMs: GATEWAY_STARTUP_TIMEOUT_MS,
              requestTimeoutMs: GATEWAY_REQUEST_TIMEOUT_MS,
              ...(options?.environment ? { environment: options.environment } : {}),
              ...options?.gatewayRuntimeOptions,
            };
            return startHermesGatewayRuntime(runtimeOptions);
          },
          catch: (cause) => gatewayRequestError("gateway.start", cause),
        });
        const created = yield* Effect.tryPromise({
          try: () =>
            runtime.request<{
              readonly session_id: string;
              readonly info?: { readonly model?: string };
            }>("session.create", { cols: 120 }),
          catch: (cause) => gatewayRequestError("session.create", cause),
        });
        const selectedModel = requestedHermesModel(input.modelSelection, boundInstanceId);
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd: input.cwd,
          model: selectedModel ?? created.info?.model ?? HERMES_FALLBACK_MODEL_SLUG,
          threadId: input.threadId,
          resumeCursor: {
            schemaVersion: 1,
            sessionId: created.session_id,
            transport: "hermes-gateway",
          },
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        const ctx: GatewaySessionContext = {
          session,
          runtime,
          gatewaySessionId: created.session_id,
          turns: [],
          pendingApprovals: new Map(),
          pendingUserInputs: new Map(),
        };
        sessions.set(input.threadId, ctx);
        if (selectedModel) {
          yield* switchGatewayModel(ctx, selectedModel);
        }

        yield* offerRuntimeEvent({
          type: "session.started",
          ...eventStamp(),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { resume: { sessionId: created.session_id, transport: "hermes-gateway" } },
        });
        yield* offerRuntimeEvent({
          type: "session.state.changed",
          ...eventStamp(),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { state: "ready", reason: "Hermes gateway session ready" },
        });
        yield* offerRuntimeEvent({
          type: "thread.started",
          ...eventStamp(),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { providerThreadId: created.session_id },
        });
        return session;
      });

    const emitTextTurn = (
      ctx: GatewaySessionContext,
      turnId: TurnId,
      text: string,
      options?: { readonly commandName?: string; readonly preformatted?: boolean },
    ): Effect.Effect<void> =>
      offerRuntimeEvent(
        makeContentDeltaEvent({
          threadId: ctx.session.threadId,
          turnId,
          text: options?.preformatted
            ? text
            : formatHermesGatewayText({ commandName: options?.commandName, text }),
          streamKind: "assistant_text",
          rawPayload: { text },
        }),
      );

    const attachGatewayImages = (
      ctx: GatewaySessionContext,
      attachments: NonNullable<ProviderSendTurnInput["attachments"]>,
    ): Effect.Effect<ReadonlyArray<unknown>, ProviderAdapterRequestError> =>
      Effect.forEach(
        attachments,
        (attachment) =>
          Effect.gen(function* () {
            const attachmentPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (!attachmentPath) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "image.attach",
                detail: `Invalid attachment id '${attachment.id}'.`,
              });
            }
            return yield* requestGateway(ctx, "image.attach", {
              session_id: ctx.gatewaySessionId,
              path: attachmentPath,
            });
          }),
        { concurrency: 1 },
      );

    const handleGatewayInteractiveEvent = (
      ctx: GatewaySessionContext,
      turnId: TurnId,
      event: HermesGatewayEvent,
    ): void => {
      const payload = event.payload;
      if (event.type === "approval.request") {
        const requestId = ApprovalRequestId.make(crypto.randomUUID());
        const runtimeRequestId = RuntimeRequestId.make(requestId);
        ctx.pendingApprovals.set(requestId, {
          turnId,
          detail:
            stringField(payload, "description") ??
            stringField(payload, "command") ??
            "Hermes requested approval.",
          payload,
        });
        emitRuntimeEvent(
          makeGatewayApprovalRequestEvent({
            threadId: ctx.session.threadId,
            turnId,
            requestId: runtimeRequestId,
            payload,
          }),
        );
        return;
      }

      const userInputConfig =
        event.type === "clarify.request"
          ? {
              kind: "clarify" as const,
              method: "clarify.respond" as const,
              answerKey: "answer" as const,
            }
          : event.type === "sudo.request"
            ? {
                kind: "sudo" as const,
                method: "sudo.respond" as const,
                answerKey: "password" as const,
              }
            : event.type === "secret.request"
              ? {
                  kind: "secret" as const,
                  method: "secret.respond" as const,
                  answerKey: "value" as const,
                }
              : undefined;

      if (!userInputConfig) {
        return;
      }
      const gatewayRequestId = stringField(payload, "request_id");
      if (!gatewayRequestId) {
        emitRuntimeEvent(
          makeRuntimeErrorEvent({
            threadId: ctx.session.threadId,
            turnId,
            message: `Hermes gateway ${event.type} did not include request_id.`,
            rawPayload: event,
          }),
        );
        return;
      }
      const requestId = ApprovalRequestId.make(gatewayRequestId);
      const runtimeRequestId = RuntimeRequestId.make(requestId);
      const question = questionForGatewayInput({
        kind: userInputConfig.kind,
        requestId,
        payload,
      });
      ctx.pendingUserInputs.set(requestId, {
        turnId,
        gatewayRequestId,
        method: userInputConfig.method,
        answerKey: userInputConfig.answerKey,
        questionId: question.id,
      });
      emitRuntimeEvent(
        makeGatewayUserInputRequestedEvent({
          threadId: ctx.session.threadId,
          turnId,
          requestId: runtimeRequestId,
          question,
          rawPayload: event,
          method: event.type,
        }),
      );
    };

    const submitGatewayPrompt = (
      ctx: GatewaySessionContext,
      turnId: TurnId,
      text: string,
    ): Effect.Effect<unknown, ProviderAdapterRequestError> =>
      Effect.tryPromise({
        try: () =>
          new Promise<unknown>((resolvePromise, rejectPromise) => {
            let sawAssistantDelta = false;
            let assistantItemId: string | undefined;
            const timeout = setTimeout(() => {
              unsubscribe();
              const logTail = ctx.runtime.logs.slice(-8).join("\n");
              rejectPromise(
                new Error(`Hermes gateway prompt timed out.${logTail ? `\n${logTail}` : ""}`),
              );
            }, gatewayRequestTimeoutMs);
            const unsubscribe = ctx.runtime.onEvent((event: HermesGatewayEvent) => {
              if (event.session_id !== ctx.gatewaySessionId) {
                return;
              }
              const payload = event.payload;
              handleGatewayInteractiveEvent(ctx, turnId, event);
              if (event.type === "message.start") {
                assistantItemId = `hermes-gateway-${turnId}-assistant`;
                emitRuntimeEvent(
                  makeGatewayAssistantItemEvent({
                    threadId: ctx.session.threadId,
                    turnId,
                    itemId: assistantItemId,
                    lifecycle: "item.started",
                    rawPayload: event,
                  }),
                );
              } else if (event.type === "message.delta") {
                const textDelta = stringField(payload, "text");
                if (textDelta) {
                  sawAssistantDelta = true;
                  emitRuntimeEvent(
                    makeContentDeltaEvent({
                      threadId: ctx.session.threadId,
                      turnId,
                      ...(assistantItemId ? { itemId: assistantItemId } : {}),
                      text: textDelta,
                      streamKind: "assistant_text",
                      rawPayload: event,
                    }),
                  );
                }
              } else if (event.type === "reasoning.delta") {
                const textDelta = stringField(payload, "text");
                if (textDelta) {
                  emitRuntimeEvent(
                    makeContentDeltaEvent({
                      threadId: ctx.session.threadId,
                      turnId,
                      ...(assistantItemId ? { itemId: assistantItemId } : {}),
                      text: textDelta,
                      streamKind: "reasoning_text",
                      rawPayload: event,
                    }),
                  );
                }
              } else if (event.type === "message.complete") {
                clearTimeout(timeout);
                unsubscribe();
                const completeText = stringField(payload, "text");
                if (completeText && !sawAssistantDelta) {
                  emitRuntimeEvent(
                    makeContentDeltaEvent({
                      threadId: ctx.session.threadId,
                      turnId,
                      ...(assistantItemId ? { itemId: assistantItemId } : {}),
                      text: completeText,
                      streamKind: "assistant_text",
                      rawPayload: event,
                    }),
                  );
                }
                const usageEvent = makeUsageEvent({
                  threadId: ctx.session.threadId,
                  usage: asRecord(payload).usage,
                  rawPayload: event,
                });
                if (usageEvent) {
                  emitRuntimeEvent(usageEvent);
                }
                if (assistantItemId) {
                  emitRuntimeEvent(
                    makeGatewayAssistantItemEvent({
                      threadId: ctx.session.threadId,
                      turnId,
                      itemId: assistantItemId,
                      lifecycle: "item.completed",
                      rawPayload: event,
                    }),
                  );
                }
                resolvePromise(payload);
              } else if (event.type === "tool.start") {
                emitRuntimeEvent(
                  makeGatewayToolItemEvent({
                    threadId: ctx.session.threadId,
                    turnId,
                    lifecycle: "item.started",
                    payload,
                    rawPayload: event,
                  }),
                );
              } else if (event.type === "tool.progress") {
                emitRuntimeEvent(
                  makeGatewayToolProgressEvent({
                    threadId: ctx.session.threadId,
                    turnId,
                    payload,
                    rawPayload: event,
                  }),
                );
              } else if (event.type === "tool.complete") {
                emitRuntimeEvent(
                  makeGatewayToolItemEvent({
                    threadId: ctx.session.threadId,
                    turnId,
                    lifecycle: "item.completed",
                    payload,
                    rawPayload: event,
                  }),
                );
              } else if (event.type === "error") {
                clearTimeout(timeout);
                unsubscribe();
                const message = stringField(payload, "message") ?? "Hermes gateway error";
                emitRuntimeEvent(
                  makeRuntimeErrorEvent({
                    threadId: ctx.session.threadId,
                    turnId,
                    message,
                    rawPayload: event,
                  }),
                );
                rejectPromise(new Error(message));
              }
            });
            ctx.runtime
              .request("prompt.submit", {
                session_id: ctx.gatewaySessionId,
                text,
              })
              .catch((error) => {
                clearTimeout(timeout);
                unsubscribe();
                rejectPromise(error);
              });
          }),
        catch: (cause) => gatewayRequestError("prompt.submit", cause),
      });

    const structuredGatewaySlashOutput = (
      ctx: GatewaySessionContext,
      slash: { readonly name: string; readonly arg: string },
    ): Effect.Effect<string | void, ProviderAdapterRequestError> => {
      switch (slash.name) {
        case "help":
          return requestGateway<HermesGatewayCommandsCatalogResult>(
            ctx,
            "commands.catalog",
            {},
          ).pipe(Effect.map(formatHermesGatewayCommandCatalog));
        case "tools":
          if (slash.arg.trim()) {
            return Effect.void;
          }
          return requestGateway<GatewayToolsShowResult>(ctx, "tools.show", {
            session_id: ctx.gatewaySessionId,
          }).pipe(Effect.map(formatHermesGatewayToolsShow));
        case "sessions": {
          const limit = parseSessionLimit(slash.arg);
          return requestGateway<GatewaySessionListResult>(ctx, "session.list", { limit }).pipe(
            Effect.map((result) => formatHermesGatewaySessionList(result, limit)),
          );
        }
        case "status":
          return requestGateway<{ readonly output?: string }>(ctx, "session.status", {
            session_id: ctx.gatewaySessionId,
          }).pipe(
            Effect.map((result) => formatLabeledOutput("Hermes status", result.output ?? "")),
          );
        case "model":
          if (slash.arg.trim()) {
            return Effect.void;
          }
          return requestGateway<HermesGatewayModelOptionsResult>(ctx, "model.options", {
            session_id: ctx.gatewaySessionId,
          }).pipe(Effect.map(formatHermesGatewayModelOptions));
        case "reasoning":
          if (slash.arg.trim()) {
            return Effect.void;
          }
          return requestGateway<GatewayReasoningConfigResult>(ctx, "config.get", {
            session_id: ctx.gatewaySessionId,
            key: "reasoning",
          }).pipe(Effect.map(formatHermesGatewayReasoning));
        default:
          return Effect.void;
      }
    };

    const runGatewaySlash = (
      ctx: GatewaySessionContext,
      turnId: TurnId,
      input: string,
    ): Effect.Effect<unknown, ProviderAdapterRequestError> =>
      Effect.gen(function* () {
        const slash = parseSlash(input);
        if (!slash) {
          return yield* submitGatewayPrompt(ctx, turnId, input);
        }

        const structuredOutput = yield* structuredGatewaySlashOutput(ctx, slash).pipe(
          Effect.result,
        );
        if (Result.isSuccess(structuredOutput) && structuredOutput.success) {
          yield* emitTextTurn(ctx, turnId, structuredOutput.success, { preformatted: true });
          return { type: "exec", output: structuredOutput.success };
        }

        const dispatched = yield* requestGateway<GatewayCommandDispatchResult>(
          ctx,
          "command.dispatch",
          {
            session_id: ctx.gatewaySessionId,
            name: slash.name,
            arg: slash.arg,
          },
        ).pipe(Effect.result);

        if (Result.isSuccess(dispatched)) {
          const result = dispatched.success;
          if (result.notice) {
            yield* emitTextTurn(ctx, turnId, result.notice, { commandName: slash.name });
          }
          if (result.type === "skill" || result.type === "send") {
            const message = result.message;
            if (!message) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "command.dispatch",
                detail: `Hermes gateway returned no message for /${slash.name}.`,
              });
            }
            return yield* submitGatewayPrompt(ctx, turnId, message);
          }
          if (result.output) {
            yield* emitTextTurn(ctx, turnId, result.output, { commandName: slash.name });
            return result;
          }
        }

        const slashResult = yield* requestGateway<GatewaySlashExecResult>(ctx, "slash.exec", {
          session_id: ctx.gatewaySessionId,
          command: input,
        });
        const output = [slashResult.output, slashResult.warning].filter(Boolean).join("\n\n");
        yield* emitTextTurn(ctx, turnId, output || "(no output)", { commandName: slash.name });
        return slashResult;
      });

    const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        const attachmentResults =
          (input.attachments?.length ?? 0) > 0
            ? yield* attachGatewayImages(ctx, input.attachments ?? [])
            : [];
        const prompt = input.input?.trim();
        if (!prompt && attachmentResults.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text or attachments.",
          });
        }

        const selectedModel = requestedHermesModel(input.modelSelection, boundInstanceId);
        if (selectedModel && selectedModel !== ctx.session.model) {
          yield* switchGatewayModel(ctx, selectedModel);
          ctx.session = { ...ctx.session, model: selectedModel, updatedAt: nowIso() };
        }

        const turnId = TurnId.make(crypto.randomUUID());
        ctx.session = { ...ctx.session, activeTurnId: turnId, updatedAt: nowIso() };
        yield* offerRuntimeEvent({
          type: "turn.started",
          ...eventStamp(),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: { model: ctx.session.model ?? HERMES_FALLBACK_MODEL_SLUG },
        });

        const promptText = prompt || "What do you see in this image?";
        const result = promptText.startsWith("/")
          ? yield* runGatewaySlash(ctx, turnId, promptText)
          : yield* submitGatewayPrompt(ctx, turnId, promptText);

        ctx.turns.push({ id: turnId, items: [{ prompt, attachments: attachmentResults, result }] });
        ctx.session = { ...ctx.session, activeTurnId: turnId, updatedAt: nowIso() };
        yield* offerRuntimeEvent({
          type: "turn.completed",
          ...eventStamp(),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: { state: "completed", stopReason: null },
        });

        return { threadId: input.threadId, turnId, resumeCursor: ctx.session.resumeCursor };
      });

    const stopSessionInternal = (ctx: GatewaySessionContext) =>
      Effect.promise(() => ctx.runtime.stop()).pipe(Effect.ignore);

    const stopSession: ProviderAdapterShape<ProviderAdapterError>["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        sessions.delete(threadId);
        ctx.pendingApprovals.clear();
        ctx.pendingUserInputs.clear();
        yield* stopSessionInternal(ctx);
      });

    const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* requestGateway(ctx, "session.interrupt", {
          session_id: ctx.gatewaySessionId,
        }).pipe(Effect.ignore);
        ctx.pendingApprovals.clear();
        ctx.pendingUserInputs.clear();
      });

    const readThread: ProviderAdapterShape<ProviderAdapterError>["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: ProviderAdapterShape<ProviderAdapterError>["rollbackThread"] = (
      threadId,
      numTurns,
    ) =>
      Effect.gen(function* () {
        if (numTurns <= 0) {
          return yield* readThread(threadId);
        }
        const ctx = yield* requireSession(threadId);
        for (let index = 0; index < numTurns; index += 1) {
          yield* requestGateway(ctx, "session.undo", {
            session_id: ctx.gatewaySessionId,
          });
          ctx.turns.pop();
        }
        return { threadId, turns: ctx.turns };
      });

    const stopAll = () =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }).pipe(
        Effect.tap(() => Effect.sync(() => sessions.clear())),
      );

    yield* Effect.addFinalizer(() =>
      stopAll().pipe(Effect.tap(() => PubSub.shutdown(runtimeEventPubSub))),
    );

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest: (threadId, requestId, decision) =>
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          const pending = ctx.pendingApprovals.get(requestId);
          if (!pending) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "approval.respond",
              detail: `Unknown pending approval request: ${requestId}`,
            });
          }
          yield* requestGateway(ctx, "approval.respond", {
            session_id: ctx.gatewaySessionId,
            choice: approvalChoice(decision),
          });
          ctx.pendingApprovals.delete(requestId);
          yield* offerRuntimeEvent(
            makeGatewayApprovalResolvedEvent({
              threadId,
              turnId: pending.turnId,
              requestId: RuntimeRequestId.make(requestId),
              decision,
            }),
          );
        }),
      respondToUserInput: (threadId, requestId, answers) =>
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          const pending = ctx.pendingUserInputs.get(requestId);
          if (!pending) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "gateway.respond",
              detail: `Unknown pending user-input request: ${requestId}`,
            });
          }
          const answer = answerFromUserInputAnswers(answers, pending.questionId);
          yield* requestGateway(ctx, pending.method, {
            request_id: pending.gatewayRequestId,
            [pending.answerKey]:
              (pending.answerKey === "password" || pending.answerKey === "value") &&
              answer === "Skip"
                ? ""
                : answer,
          });
          ctx.pendingUserInputs.delete(requestId);
          yield* offerRuntimeEvent(
            makeGatewayUserInputResolvedEvent({
              threadId,
              turnId: pending.turnId,
              requestId: RuntimeRequestId.make(requestId),
              answers,
            }),
          );
        }),
      stopSession,
      listSessions: () => Effect.succeed([...sessions.values()].map((ctx) => ctx.session)),
      hasSession: (threadId) => Effect.succeed(sessions.has(threadId)),
      readThread,
      rollbackThread,
      stopAll,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies ProviderAdapterShape<ProviderAdapterError>;
  });
}
