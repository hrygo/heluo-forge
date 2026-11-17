import type { HostContext } from "./host-types.js";
export function notifyChatCatalog(ctx: HostContext, invalidateSkills?: () => void) {
  try {
    if (typeof invalidateSkills === "function") invalidateSkills();
  } catch {
    /* 目录缓存失效失败不影响已完成的文件操作 */
  }
  try {
    if (typeof ctx.emit === "function") ctx.emit("commands/change");
  } catch {
    /* 命令目录刷新失败不影响已完成的文件操作 */
  }
  try {
    const sessions = typeof ctx.get === "function" ? ctx.get("sessions") : undefined;
    const list = sessions && typeof sessions.list === "function" ? sessions.list() : [];
    for (const session of list) {
      const id = session && (session.id ?? session.header?.id);
      const preset = session && session.header && typeof session.header.agentPreset === "string"
        ? session.header.agentPreset
        : undefined;
      if (id == null || !preset || typeof ctx.emit !== "function") continue;
      // Web `/` 技能菜单缓存在 dsh-client-ui-skill，只在 agent-preset/selected 时失效；
      // skills/change 未进入官方转发白名单，只能借用这条已转发事件。
      ctx.emit("agent-preset/selected", id, preset);
    }
  } catch {
    /* 斜杠菜单刷新失败不影响已完成的文件操作 */
  }
}
