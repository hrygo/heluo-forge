import type { HostContext } from "./host-types.js";
import { isExpectedOperationError } from "./operation-errors.js";
export function notifyChatCatalog(ctx: HostContext, invalidateSkills?: () => void) {
  try {
    if (typeof invalidateSkills === "function") invalidateSkills();
  } catch (error) {
    if (!isExpectedOperationError(error)) throw error;
  }
  try {
    if (typeof ctx.emit === "function") ctx.emit("commands/change");
  } catch (error) {
    if (!isExpectedOperationError(error)) throw error;
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
  } catch (error) {
    if (!isExpectedOperationError(error)) throw error;
  }
}
