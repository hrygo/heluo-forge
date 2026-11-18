import type { ApiCall, ApiRoutes } from "./client-types.js";
import { API_ERROR_CODES, ApiFailure, decodeOperationOutcome, isConfirmedRejection } from "./api-errors.js";

export interface ClientMutation { id: string; path: string; phase: "submitting" | "pending" }
const readOnlyPosts = new Set(["/detail", "/browse", "/workspace-skills", "/custom-source-scan", "/nacos/detail", "/nacos/install"]);

export function createClientOperations(send: ApiCall) {
  let current: ClientMutation | null = null;
  let checking = false;
  const listeners = new Set<() => void>();
  function update(next: ClientMutation | null) { current = next; for (const listener of listeners) listener(); }
  async function request<K extends keyof ApiRoutes>(path: K, options?: RequestInit): Promise<ApiRoutes[K]> {
    if (options?.method?.toUpperCase() !== "POST" || readOnlyPosts.has(path)) return send(path, options);
    if (current) throw new ApiFailure({ code: API_ERROR_CODES.busy, message: "A previous operation must be confirmed first", outcome: "pending" });
    const operation: ClientMutation = { id: crypto.randomUUID(), path, phase: "submitting" };
    update(operation);
    const headers = Object.fromEntries(new Headers(options.headers).entries());
    headers["x-dsh-skills-operation"] = operation.id;
    try {
      const result = await send(path, { ...options, headers });
      update(null);
      return result;
    } catch (error) {
      update(isConfirmedRejection(error) ? null : { ...operation, phase: "pending" });
      throw error;
    }
  }
  async function confirm() {
    if (!current || current.phase !== "pending" || checking) return { state: "pending" } as const;
    const operation = current;
    checking = true;
    try {
      const outcome = decodeOperationOutcome(await send(`/operation-status?operationId=${encodeURIComponent(operation.id)}`), (result): result is unknown => result !== undefined);
      if (outcome.state !== "pending" && current === operation) update(null);
      return outcome;
    } finally { checking = false; }
  }
  return { request, confirm, getSnapshot: () => current, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; } };
}
