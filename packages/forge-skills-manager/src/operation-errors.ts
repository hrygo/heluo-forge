import type { CodedError } from "./types.js";

/** A storage owner supplies read-only evidence for its own uncertain commit. */
export class PendingOperationError extends Error {
  readonly code = "error.repo.installState";
  readonly statusCode = 500;
  readonly inspect: () => Promise<PendingInspection | undefined>;
  constructor(message: string, inspect: () => Promise<PendingInspection | undefined>) { super(message); this.inspect = inspect; }
}
type PendingInspection = { state: "succeeded"; result: unknown } | { state: "rejected"; code: string; error: string };

export function operationRejection(result: object): { code: string; error: string } {
  return {
    code: "code" in result && typeof result.code === "string" && /^error\.[a-zA-Z0-9.]+$/.test(result.code) ? result.code : "error.proto.rejected",
    error: "error" in result && typeof result.error === "string" && result.error.trim() ? result.error : "操作已拒绝",
  };
}

export function isExpectedOperationError(error: unknown): error is CodedError {
  if (error instanceof ReferenceError || error instanceof TypeError) return false;
  if (!error || typeof error !== "object" || !("code" in error) || typeof error.code !== "string") return false;
  return /^error\.[a-zA-Z0-9.]+$/.test(error.code) || /^E[A-Z0-9]+$/.test(error.code);
}
