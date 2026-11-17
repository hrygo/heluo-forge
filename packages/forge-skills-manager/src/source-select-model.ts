interface SourceMenuEscapeEvent {
  readonly key: string;
  preventDefault(): void;
  stopPropagation(): void;
  stopImmediatePropagation(): void;
}

/** 打开的筛选或操作菜单在捕获阶段吃掉 Escape，避免关掉弹窗或宿主设置页。 */
export function handleSourceMenuEscape(event: SourceMenuEscapeEvent, close: () => void) {
  if (event.key !== "Escape") return false;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  close();
  return true;
}
