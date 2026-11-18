export const API_ERROR_CODES = {
  nonJson: "error.proto.nonJson",
  response: "error.proto.response",
  pending: "error.proto.pending",
  busy: "error.proto.busy",
} as const;

export interface FailureDetails {
  code?: string;
  params?: Record<string, unknown>;
  message: string;
  outcome: "rejected" | "pending" | "unknown";
}

export function readApiFailure(payload: unknown): FailureDetails {
  if (!payload || typeof payload !== "object") return { message: String(payload ?? ""), outcome: "unknown" };
  const item = payload as Record<string, unknown>;
  const nested = item.error !== undefined ? readApiFailure(item.error) : undefined;
  return {
    ...(typeof item.code === "string" ? { code: item.code } : nested?.code ? { code: nested.code } : {}),
    ...(item.params && typeof item.params === "object" && !Array.isArray(item.params) ? { params: item.params as Record<string, unknown> } : nested?.params ? { params: nested.params } : {}),
    message: nested?.message ?? (typeof item.message === "string" ? item.message : "Unexpected response"),
    outcome: item.outcome === "rejected" ? "rejected" : item.outcome === "pending" ? "pending" : "unknown",
  };
}

export class ApiFailure extends Error {
  readonly details: FailureDetails;
  constructor(details: FailureDetails) { super(details.message); this.name = "ApiFailure"; this.details = details; }
}

export function normalizeApiFailure(payload: unknown): ApiFailure {
  return payload instanceof ApiFailure ? payload : new ApiFailure(readApiFailure(payload));
}

export function failureDetails(payload: unknown): FailureDetails {
  return payload instanceof ApiFailure ? payload.details : readApiFailure(payload);
}

export function isConfirmedRejection(payload: unknown): boolean {
  return payload instanceof ApiFailure && payload.details.outcome === "rejected";
}

export type OperationOutcome<T> = { state: "pending" } | { state: "succeeded"; result: T } | { state: "rejected"; failure: ApiFailure };

export function decodeOperationOutcome<T>(payload: unknown, validResult: (result: unknown) => result is T): OperationOutcome<T> {
  if (!payload || typeof payload !== "object") return { state: "pending" };
  const value = payload as Record<string, unknown>;
  if (value.state === "succeeded" && Object.hasOwn(value, "result") && validResult(value.result)) return { state: "succeeded", result: value.result };
  if (value.state === "rejected") {
    const details = readApiFailure(payload);
    if (details.code?.startsWith("error.") && details.message && details.message !== "Unexpected response") return { state: "rejected", failure: new ApiFailure({ ...details, outcome: "rejected" }) };
  }
  return { state: "pending" };
}

export function isInstallReceipt(value: unknown): value is { name: string; root: string } {
  return !!value && typeof value === "object" && "name" in value && typeof value.name === "string" && "root" in value && typeof value.root === "string";
}
