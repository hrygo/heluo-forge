import type { ProviderCandidate } from "./core.js";
import type { Agent,HostContext,ProviderControl } from "./host-types.js";
import type { ScopeOptions,SkillRoot } from "./types.js";
export function createProviderRuntime(local: Pick<typeof import('./core.js'), 'collectPresetRoots' | 'listProviderCandidates' | 'getProviderSkill'>) {
const { collectPresetRoots, listProviderCandidates, getProviderSkill } = local;
const PRESET_ROOTS_TTL_MS = 2000;

const MISS_REFRESH_COOLDOWN_MS = 1500;

const presetRootsCache = new WeakMap<object, { expiresAt: number; refreshedAt: number; roots?: SkillRoot[]; pending?: Promise<SkillRoot[]> }>();

function invalidatePresetRootsCache(hostCtx?: HostContext) {
  if (hostCtx && typeof hostCtx === "object") presetRootsCache.delete(hostCtx);
}

async function getPresetRootsCached(hostCtx: HostContext, forceRefresh = false): Promise<SkillRoot[]> {
  if (!hostCtx || typeof hostCtx !== "object") return [];
  const now = Date.now();
  const entry = presetRootsCache.get(hostCtx);
  if (!forceRefresh && entry) {
    if (entry.roots && entry.expiresAt > now) return entry.roots;
    if (entry.pending) return entry.pending;
  }
  const pending = collectPresetRoots(hostCtx)
    .then((roots) => {
      const doneAt = Date.now();
      presetRootsCache.set(hostCtx, { expiresAt: doneAt + PRESET_ROOTS_TTL_MS, refreshedAt: doneAt, roots });
      return roots;
    })
    .catch((err) => {
      presetRootsCache.delete(hostCtx);
      throw err;
    });
  presetRootsCache.set(hostCtx, { expiresAt: now + PRESET_ROOTS_TTL_MS, refreshedAt: entry?.refreshedAt ?? 0, roots: forceRefresh ? undefined : entry?.roots, pending });
  return pending;
}

async function getPresetRootsOnMiss(hostCtx: HostContext): Promise<SkillRoot[]> {
  if (!hostCtx || typeof hostCtx !== "object") return [];
  const entry = presetRootsCache.get(hostCtx);
  if (entry?.roots && Date.now() - entry.refreshedAt < MISS_REFRESH_COOLDOWN_MS) {
    return entry.roots;
  }
  return getPresetRootsCached(hostCtx, true);
}

async function resolveAgentPresetScope(
  hostCtx?: HostContext,
  agentCtx?: unknown,
  options: ScopeOptions = {},
): Promise<ScopeOptions> {
  if (!hostCtx || !agentCtx) return options;
  const getService = typeof hostCtx.get === "function" ? (hostCtx.get as (name: string) => unknown).bind(hostCtx) : undefined;
  const agentPresets = getService?.("agentPresets") as { composedPreset?: (ctx: unknown) => unknown } | undefined;
  const activePresetId = typeof agentPresets?.composedPreset === "function"
    ? agentPresets.composedPreset(agentCtx)
    : undefined;
  if (typeof activePresetId !== "string" || !activePresetId.trim()) return options;
  const allPresets = await getPresetRootsCached(hostCtx);
  const matchingPresets = allPresets.filter((root) => root.presetId === activePresetId && root.toggleable);
  return matchingPresets.length > 0 ? { ...options, presetRoots: matchingPresets } : options;
}

function externalSkillProvider(
  control: ProviderControl,
  invalidators: Set<() => void>,
  hostCtx?: HostContext,
  agentCtx?: unknown,
) {
  invalidators.add(control.invalidate);
  if (control.signal && typeof control.signal.addEventListener === "function") {
    control.signal.addEventListener("abort", () => {
      invalidators.delete(control.invalidate);
    }, { once: true });
  }
  return {
    name: "dsh-skills-manager-external",
    list: async (options?: ScopeOptions) => listProviderCandidates(await resolveAgentPresetScope(hostCtx, agentCtx, options)),
    get: async (candidate: ProviderCandidate, options?: ScopeOptions) => getProviderSkill(candidate, await resolveAgentPresetScope(hostCtx, agentCtx, options)),
  };
}

function registerAgentSkillProviders(ctx: HostContext, invalidators: Set<() => void>) {
  if (typeof ctx.on !== "function") return () => {};
  const registrations = new Map<string, () => void>();

  const install = (agent: Agent) => {
    if (!agent || registrations.has(agent.id)) return;
    const agentCtx = agent.ctx;
    const skills = agentCtx && typeof agentCtx.get === "function"
      ? agentCtx.get("skills")
      : agentCtx && agentCtx.skills;
    if (!skills || typeof skills.registerProvider !== "function") return;
    const dispose = skills.registerProvider((control) => externalSkillProvider(control, invalidators, ctx, agentCtx));
    registrations.set(agent.id, dispose);
  };

  const uninstall = (agent: Agent) => {
    if (!agent) return;
    const dispose = registrations.get(agent.id);
    registrations.delete(agent.id);
    if (typeof dispose === "function") dispose();
  };

  const stopCreated = ctx.on("agent/created", ({ agent }) => install(agent));
  const stopDisposed = ctx.on("agent/disposed", ({ agent }) => uninstall(agent));
  const agents = typeof ctx.get === "function" ? ctx.get("agents") : undefined;
  if (agents && typeof agents.list === "function") {
    for (const agent of agents.list()) install(agent);
  }

  return () => {
    if (typeof stopCreated === "function") stopCreated();
    if (typeof stopDisposed === "function") stopDisposed();
    for (const dispose of registrations.values()) {
      if (typeof dispose === "function") dispose();
    }
    registrations.clear();
  };
}
return { getPresetRootsCached, getPresetRootsOnMiss, invalidatePresetRootsCache, externalSkillProvider, registerAgentSkillProviders };
}
export function installProviders(ctx: HostContext, runtime: ReturnType<typeof createProviderRuntime>, notify: (ctx: HostContext, invalidate: () => void) => void) {
  const invalidators = new Set<() => void>();
  const invalidate = () => { runtime.invalidatePresetRootsCache(ctx); for (const fn of invalidators) fn(); };
  if (typeof ctx.on === 'function') ctx.effect(() => ctx.on!('agent-preset/selected', () => runtime.invalidatePresetRootsCache(ctx)), 'skills-manager preset cache invalidation');
  ctx.effect(() => ctx.skills.registerProvider(control => runtime.externalSkillProvider(control, invalidators)), 'skills-manager global external skills provider');
  ctx.effect(() => runtime.registerAgentSkillProviders(ctx, invalidators), 'skills-manager agent-scoped external skills providers');
  return { afterWrite: () => notify(ctx, invalidate), getPresetRootsCached: (force = false) => runtime.getPresetRootsCached(ctx, force), getPresetRootsOnMiss: () => runtime.getPresetRootsOnMiss(ctx) };
}
