export const HERMES_GATEWAY_RUNTIME_ENV = "T3_HERMES_RUNTIME";

const HERMES_GATEWAY_RUNTIME_VALUES = new Set(["1", "true", "gateway", "tui-gateway"]);

export function isHermesGatewayRuntimeEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return HERMES_GATEWAY_RUNTIME_VALUES.has(
    (environment[HERMES_GATEWAY_RUNTIME_ENV] ?? "").trim().toLowerCase(),
  );
}
