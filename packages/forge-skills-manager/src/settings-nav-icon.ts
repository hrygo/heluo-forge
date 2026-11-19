import React from "react";

/**
 * 技能管理器在 DSH 设置侧边导航栏中的专属图标。
 *
 * 渲染方式使用纯属性标记控制 ::before 伪元素渲染，不修改或插入 DOM 节点：
 * 第三方皮肤（如 orca-link / dsh-deep-whale）会按 svg 内部形状识别图标，
 * 给 svg 打标记后用 CSS 隐藏其子节点。直接替换 svg.innerHTML 会与皮肤的
 * 内容级识别机制互相覆盖，并残留皮肤标记，最终导致图标整体不可见 (#49)。
 * 伪元素渲染不参与皮肤对 svg 子节点的识别与隐藏，宿主 svg 只负责被隐藏。
 */

export const NAV_ICON_MARKER = "data-dssm-nav-icon";
/**
 * 宿主原生设置弹窗的导航按钮 + dsh-codex-ui 1.x 接管设置页时的导航行。
 * 后者不是宿主 DOM（宿主的行是 `[role="dialog"] nav button`），类名与容器都来自
 * dsh-codex-ui 1.x 的 `dcu-settings-page > dcu-settings-groups > button.dcu-settings-link`；
 * 当前 dsh-codex-ui 2.x 已不再重绘导航，因此这里限定容器，避免全页命中同名类。
 */
export const NAV_ROW_SELECTOR = '[role="dialog"] nav button, .dcu-settings-page .dcu-settings-link';

const SKILL_BOOK_PATH = "M8 4.25C6.25 3 4 2.75 1.5 3.25v9c2.5-.5 4.75-.25 6.5 1 1.75-1.25 4-1.5 6.5-1v-9c-2.5-.5-4.75-.25-6.5 1Zm0 0v9M4 6h1.5M4 8.5h1.5M10.5 6H12m-1.5 2.5H12";

export const SKILL_PATHS = `<path d="${SKILL_BOOK_PATH}" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>`;

export function SkillsNavIcon({ size = 16 }: { size?: number }): React.ReactElement {
  return React.createElement(
    "svg",
    {
      xmlns: "http://www.w3.org/2000/svg",
      viewBox: "0 0 16 16",
      width: size,
      height: size,
      fill: "none",
      "aria-hidden": true,
      focusable: false,
    },
    React.createElement("path", {
      d: SKILL_BOOK_PATH,
      stroke: "currentColor",
      strokeWidth: 1.25,
      strokeLinecap: "round",
      strokeLinejoin: "round",
    }),
  );
}

const SKILL_ICON_MASK = `url("data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${SKILL_PATHS.replace(/currentColor/g, "black")}</svg>`,
)}")`;

const NAV_ICON_STYLE_ID = "dssm-settings-nav-icon-style";
const NAV_ICON_CSS = [
  `[${NAV_ICON_MARKER}] svg { display: none !important; }`,
  `[${NAV_ICON_MARKER}]::before {`,
  `  content: '';`,
  `  flex: none;`,
  `  width: 16px;`,
  `  height: 16px;`,
  `  color: var(--dcu-sidebar-icon, currentColor);`,
  `  background-color: currentColor;`,
  `  -webkit-mask: ${SKILL_ICON_MASK} center / contain no-repeat;`,
  `  mask: ${SKILL_ICON_MASK} center / contain no-repeat;`,
  `  -webkit-mask-repeat: no-repeat;`,
  `  mask-repeat: no-repeat;`,
  `  -webkit-mask-position: center;`,
  `  mask-position: center;`,
  `  -webkit-mask-size: 16px 16px;`,
  `  mask-size: 16px 16px;`,
  `}`,
  `.dcu-sb-row[${NAV_ICON_MARKER}]::before, .dcu-sb-row::before { content: none !important; }`,
].join("\n");

export function isOwnNavRow(rowText: string | null | undefined, wantedLabel: string | null | undefined): boolean {
  const wanted = String(wantedLabel ?? "").trim();
  if (wanted.length === 0) return false;
  const current = String(rowText ?? "").trim();
  return current === wanted;
}

/** 判定是否属于侧边栏导航入口（包括移动端抽屉下的侧栏、面板列表入口等） */
export function isSidebarNavButton(button: Element | null | undefined): boolean {
  if (!button) return false;
  const anyBtn = button as unknown as {
    matches?: (selector: string) => boolean;
    closest?: (selector: string) => boolean;
    className?: unknown;
    hasAttribute?: (name: string) => boolean;
    querySelector?: (selector: string) => Element | null;
  };
  if (typeof anyBtn.matches === "function") {
    if (anyBtn.matches('.dcu-sb-row, [data-dcu-panel-id], nav[class*="panelList"] button')) return true;
  }
  if (typeof anyBtn.closest === "function") {
    if (anyBtn.closest('.dcu-sidebar-nav-root, .dcu-sb-root, nav[class*="panelList"], [data-dcu-managed], [data-dcu-sidebar-active]')) return true;
  }
  const cls = String(anyBtn.className || "");
  if (cls.includes("dcu-sb-row") || cls.includes("panelRow")) return true;
  if (typeof anyBtn.hasAttribute === "function" && anyBtn.hasAttribute("data-dcu-panel-id")) return true;
  if (typeof anyBtn.querySelector === "function") {
    if (anyBtn.querySelector('span[class*="dcu-sb-glyph"], span[class*="glyph"]')) return true;
  }
  return false;
}

/** 注入导航图标的样式；重复安装时复用同一个 style 元素 */
function ensureNavIconStyle(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(NAV_ICON_STYLE_ID) !== null) return;
  const style = document.createElement("style");
  style.id = NAV_ICON_STYLE_ID;
  style.textContent = NAV_ICON_CSS;
  (document.head ?? document.documentElement).appendChild(style);
}

/**
 * 100% 对齐 dshmarket：用纯属性标记控制 ::before 伪元素渲染图标。
 * 不修改任何 DOM 节点，避免移动端列表项排版下与文字重叠冲突。
 */
export function applySettingsNavIcon(button: Element, wantedLabel: () => string): boolean {
  if (isSidebarNavButton(button)) {
    if (button.hasAttribute(NAV_ICON_MARKER)) {
      button.removeAttribute(NAV_ICON_MARKER);
      return true;
    }
    return false;
  }
  const isOwn = isOwnNavRow(button.textContent, wantedLabel());
  if (isOwn) {
    const hasSlotIcon = Array.from(button.children).some((child) => {
      if (!child || child.tagName !== "SPAN") return false;
      const cls = String((child as Element).className || "");
      return cls.includes("navIcon") || cls.includes("dcu-sb-glyph");
    }) || Boolean(button.querySelector?.('span[class*="navIcon"], span[class*="dcu-sb-glyph"]'));
    if (hasSlotIcon) {
      if (button.hasAttribute(NAV_ICON_MARKER)) {
        button.removeAttribute(NAV_ICON_MARKER);
        return true;
      }
      return false;
    }
    if (button.getAttribute(NAV_ICON_MARKER) === "") return false;
    button.setAttribute(NAV_ICON_MARKER, "");
    return true;
  }
  if (button.hasAttribute(NAV_ICON_MARKER)) {
    button.removeAttribute(NAV_ICON_MARKER);
    return true;
  }
  return false;
}

/** 移除本插件添加的标记，宿主 svg 恢复显示 */
export function restoreSettingsNavIcon(button: Element): boolean {
  if (!button.hasAttribute(NAV_ICON_MARKER)) return false;
  button.removeAttribute(NAV_ICON_MARKER);
  return true;
}

export interface NavIconContext {
  effect(callback: () => unknown, label?: string): void;
}

export function installSettingsNavIcon(ctx: NavIconContext, resolveLabel: () => string): void {
  if (typeof document === "undefined") return;
  ensureNavIconStyle();

  ctx.effect(() => {
    let disposed = false;
    let scheduled = false;

    const sync = () => {
      scheduled = false;
      if (disposed) return;
      for (const row of document.querySelectorAll(NAV_ROW_SELECTOR)) {
        applySettingsNavIcon(row, resolveLabel);
      }
    };

    const schedule = () => {
      if (scheduled || disposed) return;
      scheduled = true;
      queueMicrotask(sync);
    };

    sync();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    return () => {
      disposed = true;
      observer.disconnect();
      for (const row of document.querySelectorAll(`[${NAV_ICON_MARKER}]`)) {
        restoreSettingsNavIcon(row);
      }
    };
  }, "skills-manager: settings nav icon");
}
