function createProviderRuntime(local) {
  const { collectPresetRoots, listProviderCandidates, getProviderSkill } = local;
  const PRESET_ROOTS_TTL_MS = 2e3;
  const MISS_REFRESH_COOLDOWN_MS = 1500;
  const presetRootsCache = /* @__PURE__ */ new WeakMap();
  function invalidatePresetRootsCache(hostCtx) {
    if (hostCtx && typeof hostCtx === "object") presetRootsCache.delete(hostCtx);
  }
  async function getPresetRootsCached(hostCtx, forceRefresh = false) {
    if (!hostCtx || typeof hostCtx !== "object") return [];
    const now = Date.now();
    const entry = presetRootsCache.get(hostCtx);
    if (!forceRefresh && entry) {
      if (entry.roots && entry.expiresAt > now) return entry.roots;
      if (entry.pending) return entry.pending;
    }
    const pending = collectPresetRoots(hostCtx).then((roots) => {
      const doneAt = Date.now();
      presetRootsCache.set(hostCtx, { expiresAt: doneAt + PRESET_ROOTS_TTL_MS, refreshedAt: doneAt, roots });
      return roots;
    }).catch((err) => {
      presetRootsCache.delete(hostCtx);
      throw err;
    });
    presetRootsCache.set(hostCtx, { expiresAt: now + PRESET_ROOTS_TTL_MS, refreshedAt: entry?.refreshedAt ?? 0, roots: forceRefresh ? void 0 : entry?.roots, pending });
    return pending;
  }
  async function getPresetRootsOnMiss(hostCtx) {
    if (!hostCtx || typeof hostCtx !== "object") return [];
    const entry = presetRootsCache.get(hostCtx);
    if (entry?.roots && Date.now() - entry.refreshedAt < MISS_REFRESH_COOLDOWN_MS) {
      return entry.roots;
    }
    return getPresetRootsCached(hostCtx, true);
  }
  async function resolveAgentPresetScope(hostCtx, agentCtx, options = {}) {
    if (!hostCtx || !agentCtx) return options;
    const getService = typeof hostCtx.get === "function" ? hostCtx.get.bind(hostCtx) : void 0;
    const agentPresets = getService?.("agentPresets");
    const activePresetId = typeof agentPresets?.composedPreset === "function" ? agentPresets.composedPreset(agentCtx) : void 0;
    if (typeof activePresetId !== "string" || !activePresetId.trim()) return options;
    const allPresets = await getPresetRootsCached(hostCtx);
    const matchingPresets = allPresets.filter((root) => root.presetId === activePresetId && root.toggleable);
    return matchingPresets.length > 0 ? { ...options, presetRoots: matchingPresets } : options;
  }
  function externalSkillProvider(control, invalidators, hostCtx, agentCtx) {
    invalidators.add(control.invalidate);
    if (control.signal && typeof control.signal.addEventListener === "function") {
      control.signal.addEventListener("abort", () => {
        invalidators.delete(control.invalidate);
      }, { once: true });
    }
    return {
      name: "dsh-skills-manager-external",
      list: async (options) => listProviderCandidates(await resolveAgentPresetScope(hostCtx, agentCtx, options)),
      get: async (candidate, options) => getProviderSkill(candidate, await resolveAgentPresetScope(hostCtx, agentCtx, options))
    };
  }
  function registerAgentSkillProviders(ctx, invalidators) {
    if (typeof ctx.on !== "function") return () => {
    };
    const registrations = /* @__PURE__ */ new Map();
    const install = (agent) => {
      if (!agent || registrations.has(agent.id)) return;
      const agentCtx = agent.ctx;
      const skills = agentCtx && typeof agentCtx.get === "function" ? agentCtx.get("skills") : agentCtx && agentCtx.skills;
      if (!skills || typeof skills.registerProvider !== "function") return;
      const dispose = skills.registerProvider((control) => externalSkillProvider(control, invalidators, ctx, agentCtx));
      registrations.set(agent.id, dispose);
    };
    const uninstall = (agent) => {
      if (!agent) return;
      const dispose = registrations.get(agent.id);
      registrations.delete(agent.id);
      if (typeof dispose === "function") dispose();
    };
    const stopCreated = ctx.on("agent/created", ({ agent }) => install(agent));
    const stopDisposed = ctx.on("agent/disposed", ({ agent }) => uninstall(agent));
    const agents = typeof ctx.get === "function" ? ctx.get("agents") : void 0;
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
function installProviders(ctx, runtime, notify) {
  const invalidators = /* @__PURE__ */ new Set();
  const invalidate = () => {
    runtime.invalidatePresetRootsCache(ctx);
    for (const fn of invalidators) fn();
  };
  if (typeof ctx.on === "function") ctx.effect(() => ctx.on("agent-preset/selected", () => runtime.invalidatePresetRootsCache(ctx)), "skills-manager preset cache invalidation");
  ctx.effect(() => ctx.skills.registerProvider((control) => runtime.externalSkillProvider(control, invalidators)), "skills-manager global external skills provider");
  ctx.effect(() => runtime.registerAgentSkillProviders(ctx, invalidators), "skills-manager agent-scoped external skills providers");
  return { afterWrite: () => notify(ctx, invalidate), getPresetRootsCached: (force = false) => runtime.getPresetRootsCached(ctx, force), getPresetRootsOnMiss: () => runtime.getPresetRootsOnMiss(ctx) };
}
export {
  createProviderRuntime,
  installProviders
};
