export interface HermesGatewaySpawnInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface HermesGatewayEvent<TPayload = unknown> {
  readonly type: string;
  readonly session_id?: string;
  readonly payload?: TPayload;
}

export interface HermesGatewayRpcError {
  readonly code?: number;
  readonly message?: string;
  readonly data?: unknown;
}

export interface HermesGatewayJsonRpcSuccess<T = unknown> {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly result: T;
}

export interface HermesGatewayJsonRpcFailure {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly error: HermesGatewayRpcError;
}

export interface HermesGatewayJsonRpcEvent<TPayload = unknown> {
  readonly jsonrpc: "2.0";
  readonly method: "event";
  readonly params: HermesGatewayEvent<TPayload>;
}

export type HermesGatewayJsonRpcFrame<T = unknown> =
  | HermesGatewayJsonRpcSuccess<T>
  | HermesGatewayJsonRpcFailure
  | HermesGatewayJsonRpcEvent;

export interface HermesGatewaySessionCreateResult {
  readonly session_id: string;
  readonly info?: {
    readonly model?: string;
    readonly cwd?: string;
    readonly lazy?: boolean;
    readonly [key: string]: unknown;
  };
}

export interface HermesGatewayCommandsCatalogResult {
  readonly pairs?: ReadonlyArray<readonly [string, string]>;
  readonly categories?: ReadonlyArray<unknown>;
  readonly canon?: Record<string, string>;
  readonly sub?: Record<string, ReadonlyArray<string>>;
  readonly skill_count?: number;
  readonly warning?: string;
}

export interface HermesGatewayModelProviderOption {
  readonly slug?: string;
  readonly name?: string;
  readonly authenticated?: boolean;
  readonly models?: ReadonlyArray<unknown>;
  readonly is_current?: boolean;
  readonly warning?: string;
}

export interface HermesGatewayModelOptionsResult {
  readonly providers?: ReadonlyArray<HermesGatewayModelProviderOption>;
  readonly model?: string;
  readonly provider?: string;
}

export interface HermesGatewaySkillsListResult {
  readonly skills?: Record<string, ReadonlyArray<unknown>>;
}

export interface HermesGatewayPromptSubmitResult {
  readonly status?: string;
}

export interface HermesGatewaySmokeResult {
  readonly ready: boolean;
  readonly sessionId: string;
  readonly commandCount: number;
  readonly promptStatus: string | undefined;
  readonly responseText: string;
}
