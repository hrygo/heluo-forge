import type { CodedError } from "./types.js";

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
