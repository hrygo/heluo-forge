function notifyChatCatalog(ctx, invalidateSkills) {
  try {
    if (typeof invalidateSkills === "function") invalidateSkills();
  } catch {
  }
  try {
    if (typeof ctx.emit === "function") ctx.emit("commands/change");
  } catch {
  }
  try {
    const sessions = typeof ctx.get === "function" ? ctx.get("sessions") : void 0;
    const list = sessions && typeof sessions.list === "function" ? sessions.list() : [];
    for (const session of list) {
      const id = session && (session.id ?? session.header?.id);
      const preset = session && session.header && typeof session.header.agentPreset === "string" ? session.header.agentPreset : void 0;
      if (id == null || !preset || typeof ctx.emit !== "function") continue;
      ctx.emit("agent-preset/selected", id, preset);
    }
  } catch {
  }
}
export {
  notifyChatCatalog
};
