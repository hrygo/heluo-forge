function registeredWorkspacePaths(ctx) {
  try {
    const registry = typeof ctx.get === "function" ? ctx.get("workspaceRegistry") : void 0;
    if (!registry || typeof registry.list !== "function") return void 0;
    return [...registry.list()].flatMap((item) => {
      const path = item?.path ?? item?.cwd;
      return typeof path === "string" && path.trim() ? [path.trim()] : [];
    });
  } catch {
    return void 0;
  }
}
function activeSessionCwds(ctx, sessionId) {
  if (typeof sessionId !== "string" || !sessionId.trim()) return [];
  const sessions = ctx.sessions || (typeof ctx.get === "function" ? ctx.get("sessions") : void 0);
  if (!sessions) return [];
  const session = typeof sessions.get === "function" ? sessions.get(sessionId) : (typeof sessions.list === "function" ? sessions.list() : []).find((item) => (item.id ?? item.header?.id) === sessionId);
  const cwd = session?.header?.cwd;
  return typeof cwd === "string" && cwd.trim() ? [cwd.trim()] : [];
}
export {
  activeSessionCwds,
  registeredWorkspacePaths
};
