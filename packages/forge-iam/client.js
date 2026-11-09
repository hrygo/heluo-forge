window.__ModuleLoader__.load({
  id: '@heluo/forge-iam',
  factory(require) {
    // 分区索引（锚点只标职责、不写行号；新增逻辑落到既有分区，跨区改动在评审里说明）
    // 1 包装与共享常量 / 2 样式表 / 3 图标与纯工具 / 4 状态标签 / 5 HTTP 封装
    // 6 网关状态与徽章 / 7 登录窗口 / 8 本地存储 / 9 错误文案 / 10 诊断快照
    // 11 会话轮询 / 12 卡片与旅程条 / 13 模型卡与缓存 / 14 面板 / 15 启动器
    // 16 未登录横幅与引导 / 17 出口
    // §1 包装与共享常量
    const React = require('react');
    const h = React.createElement;
    const ONBOARDING_KEY = 'forge-iam.onboarding.v1';
    const MODEL_OPTIONS_KEY = 'forge-iam.model-options.v1';
    const REQUEST_HEADERS = { 'x-forge-iam-request': '1', 'content-type': 'application/json' };
    // Use the host palette so the embedded controls follow light and dark themes.
    const inputStyle = {
      boxSizing: 'border-box', minWidth: 0, height: 32, padding: '0 10px',
      border: '0.5px solid var(--dsw-alias-border-l4)', borderRadius: 'var(--dsw-radius-md)',
      background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 13,
    };
    const secondaryButton = {
      boxSizing: 'border-box', height: 32, minHeight: 32, padding: '0 12px',
      border: '0.5px solid var(--dsw-alias-border-l3)', borderRadius: 'var(--dsw-radius-md)',
      background: 'transparent', color: 'var(--dsw-alias-label-primary)',
      font: 'inherit', fontSize: 13, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4,
    };
    const primaryButton = {
      ...secondaryButton, border: 'none',
      background: 'var(--dsw-alias-button-primary-fill)', color: 'var(--dsw-alias-label-primary-foreground)',
    };
    const fieldLabel = { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, fontSize: 13 };
    // 界面常量不随数据变化，模块级直接引用；不作为渲染入参传递。
    const muted = { color: 'var(--dsw-alias-label-secondary)', font: 'var(--dsw-font-xxs-12)' };
    const button = secondaryButton;
    // §2 样式表（全部 CSS 走 interactionStyles）
    const interactionStyles = `
      .forge-iam-ui {
        --fiam-primary: var(--dsw-alias-state-business-primary, #2563eb);
        --fiam-success: var(--dsw-alias-state-success-primary, #10b981);
        --fiam-warn: var(--dsw-alias-state-warn-primary, #f59e0b);
        --fiam-error: var(--dsw-alias-state-error-primary, #ef4444);
      }
      .forge-iam-ui button:not(:disabled), .forge-iam-ui a { cursor: pointer; }
      .forge-iam-ui button:not(:disabled):hover { background-color: var(--dsw-alias-button-floating-hover); }
      .forge-iam-ui button.forge-iam-primary:not(:disabled):hover { background-color: var(--dsw-alias-button-primary-hover); opacity: 0.94; }
      .forge-iam-ui button:not(:disabled):active { filter: brightness(.92); transform: translateY(1px); }
      .forge-iam-ui a { color: var(--dsw-alias-state-business-primary); text-decoration: none; }
      .forge-iam-ui a:hover { text-decoration: underline; text-decoration-thickness: 1.5px; text-underline-offset: 3px; }
      .forge-iam-ui input:not(:disabled):hover { border-color: var(--dsw-alias-border-l3); }
      .forge-iam-ui input:focus { outline: none; border-color: var(--dsw-alias-state-business-primary); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 15%, transparent); }
      .forge-iam-ui :is(button, a):focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
      .forge-iam-ui :is(button, input):disabled { cursor: not-allowed; opacity: .55; }
      .fiam-personal-fold {
        box-sizing: border-box; width: 100%; height: auto; min-height: 40px; margin-top: 12px;
        display: flex; align-items: center; justify-content: flex-start;
        padding: 10px 16px; font: var(--dsw-font-s-14); text-align: left;
        color: var(--dsw-alias-label-primary);
        background: var(--dsw-alias-settings-card-fill);
        border: 0.5px dashed var(--dsw-alias-settings-card-stroke); border-radius: var(--dsw-radius-xl);
      }
      .fiam-details { margin-top: 8px; font: var(--dsw-font-xxs-12); color: var(--dsw-alias-label-secondary); }
      .fiam-details > summary { cursor: pointer; padding: 2px 0; }
      .fiam-details > summary:hover { color: var(--dsw-alias-label-primary); }
      .fiam-issues { display: flex; flex-direction: column; gap: 6px; }
      @media (prefers-reduced-motion: reduce) { .forge-iam-ui button:active { transform: none; } }

      .fiam-card {
        box-sizing: border-box;
        background: var(--dsw-alias-settings-card-fill);
        border: 0.5px solid var(--dsw-alias-settings-card-stroke);
        border-radius: var(--dsw-radius-xl);
        padding: 14px 16px;
        margin-top: 12px;
        display: flex;
        flex-direction: column;
        gap: 12px;
        transition: border-color 0.15s ease;
      }
      .fiam-card:hover { border-color: var(--dsw-alias-border-l3); }
      .fiam-card-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 2px;
      }
      .fiam-card-title-group {
        display: flex;
        align-items: center;
        gap: 10px;
        min-width: 0;
      }
      .fiam-card-title {
        font-size: 15px;
        font-weight: 600;
        color: var(--dsw-alias-label-primary);
        line-height: 22px;
      }
      .fiam-card-subtitle {
        font-size: var(--dsw-font-xxs-12);
        color: var(--dsw-alias-label-tertiary);
        line-height: 18px;
        margin-top: 1px;
      }
      .fiam-badge {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 1px 8px;
        border-radius: var(--dsw-radius-xs, 4px);
        font-size: var(--dsw-font-xxs-11);
        font-weight: 500;
        line-height: 16px;
        white-space: nowrap;
        flex-shrink: 0;
        border: 0.5px solid transparent;
      }
      .fiam-badge-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        flex-shrink: 0;
      }
      .fiam-badge-success {
        background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);
        color: var(--dsw-alias-state-success-primary);
        border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 22%, transparent);
      }
      .fiam-badge-success .fiam-badge-dot { background: var(--dsw-alias-state-success-primary); }
      .fiam-badge-idle {
        background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.04));
        color: var(--dsw-alias-label-secondary);
        border-color: var(--dsw-alias-border-l4);
      }
      .fiam-badge-idle .fiam-badge-dot { background: var(--dsw-alias-label-tertiary, #9ca3af); }
      .fiam-badge-authenticating {
        background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent);
        color: var(--dsw-alias-state-business-primary);
        border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 22%, transparent);
      }
      .fiam-badge-authenticating .fiam-badge-dot {
        background: var(--dsw-alias-state-business-primary);
        animation: fiam-pulse 1.4s ease-in-out infinite;
      }
      .fiam-badge-warn {
        background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent);
        color: var(--dsw-alias-state-warn-primary);
        border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 22%, transparent);
      }
      .fiam-badge-warn .fiam-badge-dot { background: var(--dsw-alias-state-warn-primary); }
      .fiam-badge-error {
        background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);
        color: var(--dsw-alias-state-error-primary);
        border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 22%, transparent);
      }
      .fiam-badge-error .fiam-badge-dot { background: var(--dsw-alias-state-error-primary); }
      @keyframes fiam-pulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.35; transform: scale(0.85); }
      }
      .fiam-avatar {
        width: 34px;
        height: 34px;
        border-radius: 50%;
        background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);
        color: var(--dsw-alias-state-business-primary);
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }
      .fiam-callout {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        padding: 10px 12px;
        background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.03));
        border-radius: var(--dsw-radius-sm);
        color: var(--dsw-alias-label-secondary);
        font-size: var(--dsw-font-xxs-12);
        line-height: 18px;
        margin-top: 10px;
      }
      .fiam-callout-icon {
        flex-shrink: 0;
        margin-top: 2px;
        color: var(--dsw-alias-label-tertiary);
      }
      .fiam-notice {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        border-radius: var(--dsw-radius-sm);
        font-size: var(--dsw-font-xxs-12);
        line-height: 18px;
        margin-top: 10px;
      }
      .fiam-notice-success {
        background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);
        color: var(--dsw-alias-state-success-primary);
      }
      .fiam-notice-warn {
        background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);
        color: var(--dsw-alias-state-warn-primary);
      }
      .fiam-notice-error {
        background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);
        color: var(--dsw-alias-state-error-primary);
      }
      .fiam-actions {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        margin-top: 14px;
      }
      .fiam-spinner {
        width: 20px;
        height: 20px;
        border: 2px solid var(--dsw-alias-border-l3);
        border-top-color: var(--dsw-alias-state-business-primary);
        border-radius: 50%;
        animation: fiam-spin 0.8s linear infinite;
      }
      .fiam-spin {
        animation: fiam-spin 0.8s linear infinite;
      }
      @keyframes fiam-spin {
        to { transform: rotate(360deg); }
      }

      .fiam-model-toolbar {
        position: sticky;
        top: 0;
        z-index: 10;
        background: var(--dsw-alias-settings-card-fill);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
        padding-top: 8px;
        padding-bottom: 8px;
        margin-top: 0;
        margin-bottom: 6px;
        box-shadow: 0 1px 0 var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.06));
      }
      .fiam-model-search {
        flex: 1 1 200px;
        min-width: 0;
        height: 32px;
        box-sizing: border-box;
        border: 0.5px solid var(--dsw-alias-border-l4);
        border-radius: var(--dsw-radius-md);
        background: var(--dsw-alias-bg-layer-1);
        color: var(--dsw-alias-label-primary);
        padding: 0 10px;
        font-size: 13px;
        line-height: 20px;
      }
      .fiam-model-search:focus {
        border-color: var(--dsw-alias-state-business-primary);
        outline: none;
      }
      .fiam-model-toolbar-controls {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }
      .fiam-model-filters {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        padding: 2px;
        background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-module-platform));
        border: 0.5px solid var(--dsw-alias-border-l3);
        border-radius: var(--dsw-radius-md);
        flex-shrink: 0;
      }
      .fiam-model-filters .fiam-chip {
        padding: 3px 10px;
        border-radius: var(--dsw-radius-sm);
        font-size: var(--dsw-font-xxs-12);
        line-height: 18px;
        border: none;
        background: transparent;
        color: var(--dsw-alias-label-secondary);
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .fiam-model-filters .fiam-chip:hover {
        color: var(--dsw-alias-label-primary);
        background: var(--dsw-alias-interactive-bg-hover);
      }
      .fiam-model-filters .fiam-chip-active {
        background: var(--dsw-alias-bg-layer-1);
        color: var(--dsw-alias-label-primary);
        font-weight: 500;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
      }
      .fiam-batch-btn {
        border: 0.5px solid color-mix(in srgb, var(--dsw-alias-state-business-primary) 30%, var(--dsw-alias-border-l3)) !important;
        background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 8%, var(--dsw-alias-bg-layer-1)) !important;
        color: var(--dsw-alias-state-business-primary) !important;
        font-weight: 500;
      }
      .fiam-batch-btn:hover {
        background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 15%, var(--dsw-alias-bg-layer-1)) !important;
      }
      .fiam-unsaved-banner {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 8px 12px;
        margin: 4px 0 8px 0;
        border-radius: var(--dsw-radius-md, 8px);
        background: color-mix(in srgb, var(--dsw-alias-state-warning-primary, #e6a23c) 10%, var(--dsw-alias-bg-layer-1));
        border: 0.5px solid color-mix(in srgb, var(--dsw-alias-state-warning-primary, #e6a23c) 35%, transparent);
      }
      .fiam-model-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin-top: 6px;
        margin-bottom: 6px;
        min-height: 480px;
        padding-right: 2px;
      }
      .fiam-model-item {
        border: 0.5px solid var(--dsw-alias-border-l4);
        border-radius: var(--dsw-radius-lg);
        background: var(--dsw-alias-bg-layer-1);
        overflow: hidden;
        transition: border-color 0.15s ease, box-shadow 0.15s ease;
        flex-shrink: 0;
      }
      .fiam-model-item:hover {
        border-color: var(--dsw-alias-border-l3);
      }
      .fiam-model-item.fiam-model-item-expanded {
        margin-top: 6px;
        margin-bottom: 14px;
        border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 45%, var(--dsw-alias-border-l2));
        box-shadow: 0 4px 18px rgba(0, 0, 0, 0.28), 0 0 0 1px color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent);
        border-radius: var(--dsw-radius-xl, 10px);
      }
      .fiam-model-item.fiam-model-item-expanded > .fiam-model-row {
        background: var(--dsw-alias-bg-layer-1);
        border-bottom: 0.5px solid var(--dsw-alias-border-l3);
      }
      .fiam-model-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 9px 12px;
        gap: 12px;
        min-height: 46px;
      }
      .fiam-model-info {
        display: flex;
        flex-direction: column;
        gap: 3px;
        min-width: 0;
        flex: 1 1 auto;
      }
      .fiam-model-header-line {
        display: flex;
        align-items: center;
        gap: 7px;
        min-width: 0;
        flex-wrap: nowrap;
      }
      .fiam-model-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        flex-shrink: 0;
        display: inline-block;
      }
      .fiam-model-dot-enabled {
        background: var(--dsw-alias-state-success-primary);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-success-primary) 18%, transparent);
      }
      .fiam-model-dot-disabled {
        background: var(--dsw-alias-label-dimmed, var(--dsw-alias-border-l3));
      }
      .fiam-model-name {
        font-weight: 600;
        font-size: 13px;
        color: var(--dsw-alias-label-primary);
        line-height: 19px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        min-width: 0;
        flex: 0 1 auto;
        max-width: 380px;
        letter-spacing: -0.01em;
      }
      .fiam-model-header-line .fiam-badge {
        flex-shrink: 0;
        white-space: nowrap;
      }
      .fiam-model-meta-line {
        display: flex;
        align-items: center;
        gap: 5px;
        flex-wrap: nowrap;
        min-width: 0;
        line-height: 16px;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .fiam-model-meta-status,
      .fiam-model-meta-spec,
      .fiam-model-meta-item,
      .fiam-model-meta-id {
        font-size: 11px;
        color: var(--dsw-alias-label-tertiary);
        white-space: nowrap;
        flex-shrink: 0;
      }
      .fiam-model-meta-sep {
        color: var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.18));
        font-size: 10px;
        line-height: 1;
        user-select: none;
        flex-shrink: 0;
      }
      .fiam-model-meta-id {
        font-family: var(--ds-font-family-code, monospace);
        opacity: 0.8;
      }
      .fiam-model-advanced {
        padding: 14px 16px 16px 16px;
        border-top: none;
        background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-module-platform));
        display: flex;
        flex-direction: column;
        gap: 14px;
      }
      .fiam-field-full {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .fiam-field-grid-spec {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
        gap: 14px;
      }
      .fiam-field-col {
        display: flex;
        flex-direction: column;
        gap: 5px;
        min-width: 0;
      }
      .fiam-field-title {
        font-size: 12px;
        font-weight: 500;
        color: var(--dsw-alias-label-secondary);
        line-height: 18px;
      }
      .fiam-field-hint {
        font-size: 11px;
        color: var(--dsw-alias-label-tertiary);
        line-height: 15px;
      }
      .fiam-field-section-title {
        font-size: 12px;
        font-weight: 500;
        color: var(--dsw-alias-label-secondary);
        line-height: 18px;
      }
      .fiam-help-wrap {
        position: relative;
        display: inline-flex;
        align-items: center;
        vertical-align: middle;
      }
      .fiam-help-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 15px;
        height: 15px;
        border-radius: 50%;
        border: 1px solid var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.15));
        background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.04));
        color: var(--dsw-alias-label-tertiary, #888);
        font-size: 10px;
        font-weight: 600;
        line-height: 1;
        padding: 0;
        margin-left: 5px;
        cursor: help;
        transition: all 0.15s ease;
        user-select: none;
        box-sizing: border-box;
      }
      .fiam-help-btn:hover,
      .fiam-help-btn:focus-visible {
        color: var(--dsw-alias-state-business-primary, #1890ff);
        border-color: var(--dsw-alias-state-business-primary, #1890ff);
        background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);
        outline: none;
      }
      .fiam-help-popover {
        position: absolute;
        bottom: calc(100% + 6px);
        left: -8px;
        width: max-content;
        max-width: 260px;
        padding: 6px 10px;
        border-radius: var(--dsw-radius-sm, 6px);
        background: var(--dsw-alias-bg-layer-1, #24292f);
        color: var(--dsw-alias-label-primary, #fff);
        font-size: 11px;
        font-weight: 400;
        line-height: 1.45;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.16);
        border: 0.5px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.15));
        pointer-events: none;
        opacity: 0;
        visibility: hidden;
        transition: opacity 0.15s ease, transform 0.15s ease;
        z-index: 100;
        white-space: normal;
        text-align: left;
      }
      .fiam-help-popover::after {
        content: '';
        position: absolute;
        top: 100%;
        left: 12px;
        border-width: 4px;
        border-style: solid;
        border-color: var(--dsw-alias-bg-layer-1, #24292f) transparent transparent transparent;
      }
      .fiam-help-wrap:hover .fiam-help-popover,
      .fiam-help-wrap:focus-within .fiam-help-popover {
        opacity: 1;
        visibility: visible;
        transform: translateY(-2px);
      }
      .fiam-checkbox-group {
        display: flex;
        align-items: center;
        gap: 16px;
        flex-wrap: wrap;
        margin-top: 2px;
      }
      .fiam-checkbox-item {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: var(--dsw-font-xs-13);
        color: var(--dsw-alias-label-primary);
        cursor: pointer;
      }
      .fiam-checkbox-item input[type="checkbox"] {
        cursor: pointer;
        width: 14px;
        height: 14px;
        accent-color: var(--dsw-alias-state-business-primary);
      }
      .fiam-reasoning-chips {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
        margin-top: 2px;
      }
      .fiam-chip {
        padding: 3px 10px;
        border-radius: var(--dsw-radius-sm, 6px);
        font-size: var(--dsw-font-xxs-12);
        line-height: 18px;
        border: 0.5px solid var(--dsw-alias-border-l3);
        background: var(--dsw-alias-bg-layer-1);
        color: var(--dsw-alias-label-secondary);
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .fiam-chip:hover {
        border-color: var(--dsw-alias-border-l2);
        color: var(--dsw-alias-label-primary);
        background: var(--dsw-alias-interactive-bg-hover);
      }
      .fiam-chip-active {
        background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);
        border-color: var(--dsw-alias-state-business-primary);
        color: var(--dsw-alias-state-business-primary);
        font-weight: 500;
      }
      .fiam-model-advanced-actions {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 10px;
        margin-top: 6px;
        padding-top: 12px;
        border-top: 0.5px solid var(--dsw-alias-border-l3);
        flex-wrap: wrap;
      }
      .fiam-model-actions-left {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .fiam-model-actions-right {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .fiam-journey-bar {
        position: relative;
        display: flex;
        align-items: center;
        gap: 0;
        margin-bottom: 8px;
        padding: 6px;
        border-radius: var(--dsw-radius-lg, 12px);
        background: var(--dsw-alias-bg-layer-1);
        border: 0.5px solid var(--dsw-alias-border-l3);
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.02);
      }
      .fiam-journey-step {
        position: relative;
        display: flex;
        align-items: center;
        gap: 10px;
        flex: 1;
        min-width: 0;
        padding: 8px 12px;
        border-radius: var(--dsw-radius-md, 8px);
        border: 1px solid transparent;
        background: transparent;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      }
      .fiam-journey-step + .fiam-journey-step {
        margin-left: 4px;
      }
      .fiam-journey-step-done {
        background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 5%, transparent);
      }
      .fiam-journey-step-active {
        background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 8%, var(--dsw-alias-bg-layer-1));
        border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 30%, transparent);
        box-shadow: 0 2px 8px color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);
      }
      .fiam-journey-step-warn {
        background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, var(--dsw-alias-bg-layer-1));
        border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 32%, transparent);
      }
      .fiam-journey-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 26px;
        height: 26px;
        border-radius: 50%;
        flex-shrink: 0;
        font-size: 11px;
        font-weight: 700;
        transition: all 0.2s ease;
      }
      .fiam-journey-icon-done {
        background: var(--dsw-alias-state-success-primary);
        color: #fff;
        box-shadow: 0 2px 6px color-mix(in srgb, var(--dsw-alias-state-success-primary) 35%, transparent);
      }
      .fiam-journey-icon-active {
        background: var(--dsw-alias-state-business-primary);
        color: #fff;
        box-shadow: 0 2px 6px color-mix(in srgb, var(--dsw-alias-state-business-primary) 35%, transparent);
      }
      .fiam-journey-icon-warn {
        background: var(--dsw-alias-state-warn-primary);
        color: #fff;
        box-shadow: 0 2px 6px color-mix(in srgb, var(--dsw-alias-state-warn-primary) 35%, transparent);
      }
      .fiam-journey-icon-idle {
        background: var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.05));
        color: var(--dsw-alias-label-tertiary);
        border: 0.5px solid var(--dsw-alias-border-l3);
      }
      .fiam-journey-content {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 6px;
        flex: 1;
        min-width: 0;
      }
      .fiam-journey-title {
        font-size: 13px;
        font-weight: 600;
        letter-spacing: -0.01em;
        color: var(--dsw-alias-label-primary);
        white-space: nowrap;
      }
      .fiam-journey-pill {
        font-size: 11px;
        font-weight: 500;
        padding: 2px 8px;
        border-radius: 9999px;
        line-height: 1.3;
        white-space: nowrap;
        flex-shrink: 0;
      }
      .fiam-journey-pill-done {
        color: var(--dsw-alias-state-success-primary);
        background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent);
      }
      .fiam-journey-pill-active {
        color: var(--dsw-alias-state-business-primary);
        background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);
      }
      .fiam-journey-pill-warn {
        color: var(--dsw-alias-state-warn-primary);
        background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent);
      }
      .fiam-journey-pill-idle {
        color: var(--dsw-alias-label-tertiary);
        background: color-mix(in srgb, var(--dsw-alias-label-tertiary) 8%, transparent);
      }
      .fiam-journey-arrow {
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--dsw-alias-label-tertiary);
        opacity: 0.45;
        flex-shrink: 0;
        margin: 0 -2px;
      }
      .fiam-meta-grid {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px 16px;
        padding: 10px 14px;
        background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.02)));
        border: 0.5px solid var(--dsw-alias-border-l4);
        border-radius: var(--dsw-radius-md, 8px);
      }
      .fiam-meta-item {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: var(--dsw-font-xxs-12);
        color: var(--dsw-alias-label-secondary);
        line-height: 18px;
        min-width: 0;
      }
      .fiam-auth-progress {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 10px;
        padding: 10px 14px;
        border-radius: var(--dsw-radius-md, 8px);
        background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 8%, var(--dsw-alias-bg-layer-1));
        border: 0.5px solid color-mix(in srgb, var(--dsw-alias-state-business-primary) 26%, transparent);
        font-size: var(--dsw-font-xxs-12);
        color: var(--dsw-alias-label-primary);
      }
      .fiam-search-wrap {
        position: relative;
        flex: 1 1 200px;
        min-width: 0;
        display: flex;
        align-items: center;
      }
      .fiam-search-wrap .fiam-model-search {
        width: 100%;
        padding-right: 28px;
      }
      .fiam-search-clear {
        position: absolute;
        right: 6px;
        width: 20px;
        height: 20px;
        border: none;
        border-radius: 50%;
        background: transparent;
        color: var(--dsw-alias-label-tertiary);
        font-size: 13px;
        line-height: 1;
        padding: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
      }
      .fiam-search-clear:hover {
        color: var(--dsw-alias-label-primary);
        background: var(--dsw-alias-interactive-bg-hover);
      }
      .fiam-banner {
        position: fixed;
        top: 12px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 900;
        pointer-events: auto;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-wrap: wrap;
        gap: 8px;
        box-sizing: border-box;
        max-width: calc(100vw - 24px);
        padding: 6px 14px;
        border-radius: 999px;
        background: var(--dsw-alias-bg-layer-1);
        border: 1px solid var(--dsw-alias-border-l2);
        color: var(--dsw-alias-label-primary);
        box-shadow: var(--dsw-elevation-prominent);
        font: var(--dsw-font-xs-13);
        backdrop-filter: blur(16px);
      }
      .fiam-onboarding-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 14px;
      }
      .fiam-onboarding-brand {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        font-size: 13px;
        font-weight: 600;
        color: var(--dsw-alias-label-primary);
      }
      .fiam-onboarding-stepper {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 8px;
        margin-bottom: 22px;
      }
      .fiam-onboarding-step-item {
        display: flex;
        flex-direction: column;
        gap: 6px;
        min-width: 0;
      }
      .fiam-onboarding-step-bar {
        height: 4px;
        border-radius: 999px;
        background: var(--dsw-alias-border-l3);
        transition: background-color 0.2s ease;
      }
      .fiam-onboarding-step-bar.done {
        background: var(--dsw-alias-state-success-primary);
      }
      .fiam-onboarding-step-bar.active {
        background: var(--dsw-alias-button-primary-fill);
      }
      .fiam-onboarding-step-label {
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: var(--dsw-font-xxs-12);
        color: var(--dsw-alias-label-tertiary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .fiam-onboarding-step-label.active {
        color: var(--dsw-alias-label-primary);
        font-weight: 600;
      }
      .fiam-onboarding-step-label.done {
        color: var(--dsw-alias-state-success-primary);
        font-weight: 500;
      }
      .fiam-onboarding-preview {
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin-top: 16px;
        padding: 12px 14px;
        border-radius: var(--dsw-radius-md, 8px);
        background: var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.02));
        border: 0.5px solid var(--dsw-alias-border-l3);
      }
      .fiam-onboarding-preview-row {
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: var(--dsw-font-xxs-12);
        color: var(--dsw-alias-label-secondary);
        line-height: 18px;
      }
      .fiam-onboarding-preview-num {
        width: 20px;
        height: 20px;
        border-radius: 50%;
        background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);
        color: var(--dsw-alias-state-business-primary);
        font-size: 11px;
        font-weight: 600;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }
      .fiam-onboarding-summary {
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin-top: 16px;
        padding: 12px 14px;
        border-radius: var(--dsw-radius-md, 8px);
        background: var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.02));
        border: 0.5px solid var(--dsw-alias-border-l3);
      }
      .fiam-onboarding-summary-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        font-size: var(--dsw-font-xxs-12);
        line-height: 18px;
      }
      .fiam-model-row-actions {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        flex-shrink: 0;
      }
      .fiam-quick-btn {
        box-sizing: border-box;
        min-height: 26px;
        height: 26px;
        padding: 0 10px;
        border-radius: var(--dsw-radius-sm, 6px);
        font-size: 12px;
        font-weight: 500;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        flex-shrink: 0;
      }
      .fiam-capacity-presets {
        display: grid;
        grid-template-columns: repeat(5, 1fr);
        gap: 5px;
        margin-top: 4px;
      }
      .fiam-preset-pill {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 2px 2px;
        border-radius: var(--dsw-radius-xs, 4px);
        font-size: 11px;
        line-height: 16px;
        border: 0.5px solid var(--dsw-alias-border-l4);
        background: var(--dsw-alias-bg-layer-1);
        color: var(--dsw-alias-label-secondary);
        cursor: pointer;
        transition: all 0.12s ease;
        white-space: nowrap;
        min-width: 0;
        text-align: center;
      }
      .fiam-preset-pill:hover {
        border-color: var(--dsw-alias-border-l2);
        color: var(--dsw-alias-label-primary);
      }
      .fiam-preset-pill-active {
        border-color: var(--dsw-alias-state-business-primary);
        color: var(--dsw-alias-state-business-primary);
        background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent);
        font-weight: 500;
      }
      .fiam-reasoning-bounds {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 12px;
        margin-top: 4px;
        padding: 10px 12px;
        border-radius: var(--dsw-radius-md, 8px);
        background: var(--dsw-alias-bg-layer-1);
        border: 0.5px solid var(--dsw-alias-border-l4);
      }
      .fiam-select {
        box-sizing: border-box;
        height: 32px;
        width: 100%;
        min-width: 0;
        padding: 0 10px;
        border: 0.5px solid var(--dsw-alias-border-l3);
        border-radius: var(--dsw-radius-sm, 6px);
        background: var(--dsw-alias-bg-layer-1);
        color: var(--dsw-alias-label-primary);
        font: inherit;
        font-size: 13px;
        cursor: pointer;
      }
      .fiam-select:focus {
        outline: none;
        border-color: var(--dsw-alias-state-business-primary);
      }

      /* Launcher in sidebar footArea */
      .fiam-launcher-root {
        position: relative;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        width: 100%;
        min-width: 0;
        box-sizing: border-box;
        border-radius: var(--dsw-radius-sm);
        padding: 2px;
      }
      .fiam-launcher-btn {
        display: flex;
        align-items: center;
        gap: 8px;
        flex: 1;
        min-width: 0;
        border: none;
        background: transparent;
        padding: 4px 6px;
        border-radius: var(--dsw-radius-sm);
        color: var(--dsw-alias-label-primary);
        font: var(--dsw-font-xs-13);
        text-align: left;
        cursor: pointer;
        transition: background-color 0.15s ease;
      }
      .fiam-launcher-btn:hover {
        background-color: var(--dsw-alias-button-floating-hover, rgba(0,0,0,0.05));
      }
      .fiam-launcher-rail {
        justify-content: center;
        padding: 0;
      }
      .fiam-launcher-rail .fiam-launcher-btn {
        justify-content: center;
        padding: 2px;
        flex: none;
        width: 36px;
        height: 36px;
      }
      .fiam-launcher-avatar-wrap {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border-radius: 50%;
        background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.04));
        border: 1px solid var(--dsw-alias-border-l1);
        flex-shrink: 0;
      }
      .fiam-launcher-rail .fiam-launcher-avatar-wrap {
        width: 32px;
        height: 32px;
        border-radius: var(--dsw-radius-md, 8px);
      }
      .fiam-launcher-dot {
        position: absolute;
        bottom: -1px;
        right: -1px;
        width: 7px;
        height: 7px;
        border-radius: 50%;
        border: 1.5px solid var(--dsw-alias-bg-layer-1, #fff);
        box-sizing: content-box;
      }
      .fiam-launcher-dot.idle {
        background: var(--dsw-alias-label-tertiary, #9ca3af);
      }
      .fiam-launcher-dot.success {
        background: var(--dsw-alias-state-success-primary, #10b981);
      }
      .fiam-launcher-dot.warn {
        background: var(--dsw-alias-state-warn-primary, #f59e0b);
      }
      .fiam-launcher-dot.error {
        background: var(--dsw-alias-state-error-primary, #ef4444);
      }
      .fiam-launcher-dot.authenticating {
        background: var(--dsw-alias-state-business-primary, #2563eb);
        animation: fiam-pulse 1.4s ease-in-out infinite;
      }
      .fiam-launcher-details {
        display: flex;
        flex-direction: column;
        min-width: 0;
        flex: 1;
        line-height: 1.25;
      }
      .fiam-launcher-title {
        font-weight: 600;
        font-size: var(--dsw-font-xs-13);
        color: var(--dsw-alias-label-primary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .fiam-launcher-subtitle {
        font-size: var(--dsw-font-xxs-11, 11px);
        color: var(--dsw-alias-label-secondary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        margin-top: 2px;
      }
      .fiam-launcher-gear {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border-radius: var(--dsw-radius-sm);
        border: none;
        background: transparent;
        color: var(--dsw-alias-label-secondary);
        cursor: pointer;
        flex-shrink: 0;
        transition: color 0.15s ease, background-color 0.15s ease;
      }
      .fiam-launcher-gear:hover {
        background: var(--dsw-alias-button-floating-hover, rgba(0,0,0,0.05));
        color: var(--dsw-alias-label-primary);
      }
      .fiam-launcher-menu {
        position: absolute;
        bottom: calc(100% + 8px);
        left: 0;
        right: 0;
        width: auto;
        min-width: 250px;
        max-width: 100%;
        box-sizing: border-box;
        background: var(--dsw-alias-bg-layer-1);
        border: 0.5px solid var(--dsw-alias-border-l3);
        border-radius: var(--dsw-radius-xl, 14px);
        box-shadow: 0 12px 32px -4px rgba(0, 0, 0, 0.16), 0 4px 12px rgba(0, 0, 0, 0.08);
        padding: 12px;
        z-index: 950;
        font: var(--dsw-font-xs-13);
        color: var(--dsw-alias-label-primary);
        backdrop-filter: blur(20px);
      }
      .fiam-launcher-rail .fiam-launcher-menu {
        left: calc(100% + 10px);
        right: auto;
        bottom: 0;
        width: 260px;
        max-width: 280px;
      }
      .fiam-launcher-menu-header {
        display: flex;
        align-items: center;
        gap: 10px;
        padding-bottom: 10px;
        margin-bottom: 10px;
        border-bottom: 0.5px solid var(--dsw-alias-border-l3);
      }
      .fiam-launcher-menu-avatar {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 36px;
        height: 36px;
        border-radius: 50%;
        background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);
        color: var(--dsw-alias-state-business-primary);
        font-weight: 700;
        font-size: 14px;
        flex-shrink: 0;
      }
      .fiam-launcher-menu-userinfo {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
        flex: 1;
      }
      .fiam-launcher-menu-username {
        font-size: 14px;
        font-weight: 600;
        color: var(--dsw-alias-label-primary);
        line-height: 1.2;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .fiam-launcher-menu-subtitle {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        color: var(--dsw-alias-label-tertiary);
        line-height: 1.2;
      }
      .fiam-launcher-card-section {
        background: var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.02));
        border: 0.5px solid var(--dsw-alias-border-l4, rgba(0, 0, 0, 0.06));
        border-radius: var(--dsw-radius-md, 8px);
        padding: 8px 10px;
        margin-bottom: 8px;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .fiam-launcher-menu-section {
        padding-bottom: 8px;
        margin-bottom: 8px;
        border-bottom: 0.5px solid var(--dsw-alias-border-l3);
      }
      .fiam-launcher-menu-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
        font-size: var(--dsw-font-xxs-12);
        line-height: 1.4;
        min-width: 0;
      }
      .fiam-launcher-menu-label {
        color: var(--dsw-alias-label-secondary);
        flex-shrink: 0;
        white-space: nowrap;
      }
      .fiam-launcher-menu-value {
        font-weight: 500;
        color: var(--dsw-alias-label-primary);
        text-align: right;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .fiam-launcher-menu-item {
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        box-sizing: border-box;
        padding: 8px 10px;
        border: none;
        background: transparent;
        border-radius: var(--dsw-radius-sm, 6px);
        color: var(--dsw-alias-label-primary);
        font: var(--dsw-font-xs-13);
        cursor: pointer;
        text-align: left;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        transition: all 0.15s ease;
      }
      .fiam-launcher-menu-item:hover {
        background: var(--dsw-alias-button-floating-hover, rgba(0,0,0,0.05));
      }
      .fiam-launcher-menu-item.danger {
        color: var(--dsw-alias-state-error-primary);
      }
      .fiam-launcher-menu-item.danger:hover {
        background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);
      }
      .fiam-launcher-item-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        color: var(--dsw-alias-label-secondary);
        flex-shrink: 0;
      }
      .fiam-launcher-menu-item.danger .fiam-launcher-item-icon {
        color: var(--dsw-alias-state-error-primary);
      }
    `;
    // §3 图标与纯工具
    const interactionStyle = () => h('style', null, interactionStyles);

    const SHIELD_PATHS = [
      'M3751 10793 c165 -368 440 -638 868 -852 296 -149 615 -246 1162 -355 475 -95 702 -193 875 -380 331 -356 228 -865 -246 -1216 -209 -154 -436 -267 -900 -445 -918 -353 -1453 -741 -1788 -1297 -186 -309 -267 -602 -266 -963 2 -1182 1042 -2453 2746 -3354 l117 -62 128 67 c1254 657 2030 1395 2364 2246 256 655 221 1252 -104 1773 -69 112 -143 202 -134 165 187 -771 -320 -1536 -1221 -1844 -688 -235 -1270 -115 -1931 398 -566 439 -843 994 -757 1517 118 715 858 1378 1601 1434 781 60 1105 162 1651 521 626 412 1049 538 1649 491 100 -8 100 -8 143 47 245 314 275 771 64 968 -76 71 -99 75 -282 43 -211 -36 -435 -44 -589 -21 -215 32 -335 83 -568 240 -447 301 -755 361 -1553 301 -1428 -107 -2307 69 -2987 597 -35 26 -65 48 -67 48 -3 0 8 -30 25 -67z m4081 -1089 c114 -27 237 -106 357 -227 34 -36 59 -67 54 -70 -23 -14 -228 -49 -319 -54 -181 -10 -295 31 -428 154 -91 84 -164 128 -258 153 -46 12 -84 23 -86 25 -4 3 291 35 363 39 99 5 256 -5 317 -20z',
      'M4983 9385 c-976 -330 -1784 -897 -2438 -1710 -239 -298 -237 -293 -231 -590 23 -1192 449 -2283 1186 -3036 130 -133 135 -135 55 -19 -176 256 -326 587 -400 880 -248 980 248 1944 1335 2593 271 161 546 288 995 457 424 160 587 236 749 351 377 269 364 619 -29 816 -97 49 -193 80 -444 143 -130 32 -321 84 -424 114 -103 31 -189 56 -190 56 -1 0 -75 -25 -164 -55z',
      'M9584 7936 c-797 -536 -1540 -786 -2454 -824 l-165 -7 145 -47 c80 -26 276 -85 435 -132 752 -220 1077 -392 1348 -715 676 -806 532 -1933 -377 -2951 -66 -74 -114 -130 -106 -124 735 552 1234 1222 1540 2069 254 701 311 1390 164 1993 -65 271 -299 865 -338 861 -6 -1 -92 -56 -192 -123z',
    ];

    function IamShieldIcon({ size = 20, grayscale = false }) {
      return h('svg', {
        xmlns: 'http://www.w3.org/2000/svg',
        viewBox: '0 0 320 320',
        width: size,
        height: size,
        role: 'img',
        'aria-label': 'forge-iam 精炼盘龙护盾',
        style: grayscale ? { filter: 'grayscale(1)', opacity: 0.55 } : undefined,
      },
        h('defs', null,
          h('linearGradient', { id: 'iamLauncherGradient', x1: '15%', y1: '10%', x2: '85%', y2: '90%' },
            h('stop', { offset: '0%', stopColor: '#1D4ED8' }),
            h('stop', { offset: '35%', stopColor: '#2563EB' }),
            h('stop', { offset: '70%', stopColor: '#00D2FE' }),
            h('stop', { offset: '100%', stopColor: '#00F5FF' }),
          )
        ),
        h('g', { transform: 'scale(0.2551834130781499)' },
          h('g', { transform: 'translate(0.000000,1254.000000) scale(0.100000,-0.100000)', fill: 'url(#iamLauncherGradient)' },
            ...SHIELD_PATHS.map((d, i) => h('path', { key: i, d }))
          )
        )
      );
    }

    function GearIcon({ size = 16 }) {
      return h('svg', {
        viewBox: '0 0 20 20',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('circle', { cx: 10, cy: 10, r: 3 }),
        h('path', { d: 'M16.2 12.3a1.4 1.4 0 0 0 .3 1.6l.1.1a1.6 1.6 0 1 1-2.3 2.3l-.1-.1a1.4 1.4 0 0 0-1.6-.3 1.4 1.4 0 0 0-.9 1.3V18a1.6 1.6 0 1 1-3.2 0v-.8a1.4 1.4 0 0 0-.9-1.3 1.4 1.4 0 0 0-1.6.3l-.1.1a1.6 1.6 0 1 1-2.3-2.3l.1-.1a1.4 1.4 0 0 0 .3-1.6 1.4 1.4 0 0 0-1.3-.9H2a1.6 1.6 0 1 1 0-3.2h.8a1.4 1.4 0 0 0 1.3-.9 1.4 1.4 0 0 0-.3-1.6l-.1-.1a1.6 1.6 0 1 1 2.3-2.3l.1.1a1.4 1.4 0 0 0 1.6.3 1.4 1.4 0 0 0 .9-1.3V2a1.6 1.6 0 1 1 3.2 0v.8a1.4 1.4 0 0 0 .9 1.3 1.4 1.4 0 0 0 1.6-.3l.1-.1a1.6 1.6 0 1 1 2.3 2.3l-.1.1a1.4 1.4 0 0 0-.3 1.6 1.4 1.4 0 0 0 1.3.9H18a1.6 1.6 0 1 1 0 3.2h-.8a1.4 1.4 0 0 0-1.3.9z' })
      );
    }

    function getLauncherStatus(view) {
      const ui = deriveSessionUi(view);
      if (!view || ui.signedOut || ui.unconfigured) {
        return { kind: 'signed-out', dotClass: 'idle', label: '企业账号未登录', tooltip: '点击登录企业账号' };
      }
      if (ui.authenticating) {
        return { kind: 'authenticating', dotClass: 'authenticating', label: '等待登录完成', tooltip: '正在等待浏览器授权' };
      }
      if (ui.unreachable) {
        return { kind: 'unreachable', dotClass: 'warn', label: '连接登录受阻', tooltip: '暂时无法连接登录服务，现有授权保留至到期' };
      }
      if (ui.expired || ui.failed) {
        return { kind: 'error', dotClass: 'error', label: '授权已失效', tooltip: '登录已失效，请重新登录' };
      }
      if (ui.ready) {
        const gw = deriveGatewayUi(view.gatewayCredential, 'unconfigured');
        const name = view.principal || view.subject || '企业账号';
        if (gw.configured) {
          const catalogue = deriveModelUi(view);
          if (catalogue.failed && catalogue.models.length === 0) {
            return { kind: 'model-error', dotClass: 'warn', label: '模型同步异常', tooltip: `${name} · ${errorNotice(catalogue.error)}` };
          }
          const modelCount = catalogue.models.length;
          const modelSuffix = modelCount > 0 ? ` · ${modelCount} 个模型${catalogue.stale ? '待刷新' : '可用'}` : '';
          return { kind: 'ready', dotClass: 'success', label: '企业认证有效', tooltip: `${name} · 企业认证有效${modelSuffix}` };
        }
        if (gw.ownerMismatch) {
          return { kind: 'owner-mismatch', dotClass: 'warn', label: '凭据账号不匹配', tooltip: `${name} · 网关凭据属于其他账号` };
        }
        if (gw.invalid) {
          return { kind: 'invalid-key', dotClass: 'warn', label: '凭据状态需核对', tooltip: `${name} · 网关凭据记录需核对` };
        }
        return { kind: 'ready', dotClass: 'success', label: '企业认证有效', tooltip: `${name} · 待配置网关凭据` };
      }
      return { kind: 'unknown', dotClass: 'idle', label: '状态未知', tooltip: '企业账号' };
    }

    const DEFAULT_CONTEXT_WINDOW = 200000;
    const DEFAULT_MAX_TOKENS = 64000;
    const THINKING_LEVELS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];
    const REASONING_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
    const REASONING_LEVEL_LABELS = {
      off: '关闭推理 (Off)',
      low: '轻度 (Low)',
      medium: '中度 (Medium)',
      high: '深度思考 (High)',
      xhigh: '更深 (XHigh)',
      max: '极限 (Max)',
    };
    const REASONING_LEVEL_SHORT = {
      off: 'Off',
      low: 'Low',
      medium: 'Medium',
      high: 'High',
      xhigh: 'XHigh',
      max: 'Max',
    };
    const CAPACITY_PATTERN = /^(\d+(?:\.\d+)?)([km])?$/i;
    const CAPACITY_SCALE = { k: 1000, m: 1000000 };

    function buildReasoningEffortRange(lowerBound, upperBound = lowerBound) {
      const normLower = typeof lowerBound === 'string' ? lowerBound.trim().toLowerCase() : '';
      const normUpper = typeof upperBound === 'string' ? upperBound.trim().toLowerCase() : normLower;
      const startIdx = THINKING_LEVELS.indexOf(normLower);
      const endIdx = THINKING_LEVELS.indexOf(normUpper);
      if (startIdx < 0 && endIdx < 0) return undefined;
      const resolvedStart = startIdx >= 0 ? startIdx : endIdx;
      const resolvedEnd = endIdx >= 0 ? endIdx : startIdx;
      const minIdx = Math.min(resolvedStart, resolvedEnd);
      const maxIdx = Math.max(resolvedStart, resolvedEnd);
      if (maxIdx === 0) return undefined;
      const result = { off: minIdx === 0 ? 'off' : null };
      for (let i = Math.max(1, minIdx); i <= maxIdx; i += 1) {
        const level = THINKING_LEVELS[i];
        result[level] = level;
      }
      return result;
    }

    function getReasoningEffortBounds(reasoningEfforts) {
      if (!reasoningEfforts || typeof reasoningEfforts !== 'object' || Array.isArray(reasoningEfforts)) {
        return { enabled: false, lower: 'off', upper: 'off', levels: [] };
      }
      const boundLower = reasoningEfforts.lower ?? reasoningEfforts.min;
      const boundUpper = reasoningEfforts.upper ?? reasoningEfforts.max;
      const source = (typeof boundLower === 'string' || typeof boundUpper === 'string')
        ? (buildReasoningEffortRange(boundLower, boundUpper) ?? {})
        : reasoningEfforts;
      const activeLevels = REASONING_EFFORT_LEVELS.filter(level => {
        const val = source[level];
        return typeof val === 'string' && val.trim().length > 0;
      });
      if (activeLevels.length === 0) {
        return { enabled: false, lower: 'off', upper: 'off', levels: [] };
      }
      const hasOff = typeof source.off === 'string' && source.off.trim().length > 0;
      const levels = hasOff ? ['off', ...activeLevels] : activeLevels;
      return {
        enabled: true,
        lower: levels[0],
        upper: levels[levels.length - 1],
        levels,
      };
    }

    function parseCapacity(text) {
      if (typeof text === 'number') return Number.isFinite(text) && text > 0 ? Math.round(text) : undefined;
      if (typeof text !== 'string') return undefined;
      const trimmed = text.trim();
      if (!trimmed) return undefined;
      const match = CAPACITY_PATTERN.exec(trimmed);
      if (!match) return undefined;
      const suffix = match[2]?.toLowerCase();
      const scale = suffix === 'k' || suffix === 'm' ? CAPACITY_SCALE[suffix] : 1;
      const scaled = Number(match[1]) * scale;
      return Number.isFinite(scaled) && scaled > 0 ? Math.round(scaled) : undefined;
    }

    function formatCapacity(value) {
      if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return typeof value === 'string' ? value : '';
      if (value % CAPACITY_SCALE.m === 0) return `${value / CAPACITY_SCALE.m}M`;
      if (value % CAPACITY_SCALE.k === 0) return `${value / CAPACITY_SCALE.k}K`;
      return String(value);
    }

    function formatTime(value) {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      return new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
        hour12: false, timeZoneName: 'short',
      }).format(date);
    }

    // §4 状态标签
    // 一张表同时给出文案与徽章等级：新增状态只改这里，标签与徽章不会各改一处。
    const STATUS = {
      unconfigured: { label: '企业登录尚未设置', badge: 'warn' },
      'signed-out': { label: '未登录', badge: 'idle' },
      authenticating: { label: '等待浏览器登录', badge: 'authenticating' },
      ready: { label: '已登录', badge: 'success' },
      expired: { label: '授权已过期', badge: 'warn' },
      unreachable: { label: '暂时无法连接登录服务', badge: 'error' },
      error: { label: '需要处理', badge: 'error' },
    };

    // §4.1 会话状态派生
    // view.state 只在这里读一次：其余代码用布尔量判断，新增状态时只改这里。
    function deriveSessionUi(view) {
      const state = typeof view?.state === 'string' ? view.state : null;
      return {
        state,
        known: state !== null && Object.hasOwn(STATUS, state),
        ready: state === 'ready',
        authenticating: state === 'authenticating',
        signedOut: state === 'signed-out',
        expired: state === 'expired',
        unreachable: state === 'unreachable',
        failed: state === 'error',
        unconfigured: state === 'unconfigured',
      };
    }

    // §4.2 模型目录派生
    // modelAccess.state 与 stale/configured 只在这里读；调用方用布尔量组合。
    function deriveModelUi(view) {
      const access = view?.modelAccess;
      const state = typeof access?.state === 'string' ? access.state : null;
      return {
        state,
        configured: access?.configured === true,
        ready: state === 'ready',
        loading: state === 'loading',
        failed: state === 'error',
        stale: access?.stale === true,
        models: Array.isArray(access?.models) ? access.models : [],
        error: access?.error ?? null,
      };
    }

    // §5 HTTP 封装
    async function readJson(response) {
      try {
        return await response.json();
      } catch {
        return null;
      }
    }

    async function fetchView() {
      const response = await fetch('/api/forge-iam/view');
      const view = await readJson(response);
      if (!response.ok) throw new Error(view?.error?.code ?? 'IAM_VIEW_FAILED');
      return view;
    }

    async function getJson(path) {
      const response = await fetch(path);
      return { ok: response.ok, status: response.status, body: await readJson(response) };
    }

    async function postJson(path) {
      const response = await fetch(path, { method: 'POST', headers: REQUEST_HEADERS, body: '{}' });
      return { ok: response.ok, status: response.status, body: await readJson(response) };
    }

    async function putJson(path, payload) {
      const response = await fetch(path, { method: 'PUT', headers: REQUEST_HEADERS, body: JSON.stringify(payload) });
      return { ok: response.ok, status: response.status, body: await readJson(response) };
    }

    async function deleteJson(path) {
      const response = await fetch(path, { method: 'DELETE', headers: REQUEST_HEADERS });
      return { ok: response.ok, status: response.status, body: await readJson(response) };
    }

    // 响应里的错误码只有一个读取口：调用方判断 result.ok 即可，不要再自己解包。
    function resultCode(result) { return result.body?.error?.code ?? 'IAM_REQUEST_FAILED'; }
    function resultNotice(result) { return errorNotice(resultCode(result)); }

    // §6 网关状态与徽章
    const GATEWAY_STATUS = {
      unknown: { label: '凭据状态尚未确认', badge: 'warn' },
      unconfigured: { label: '未保存', badge: 'idle' },
      configured: { label: '已保存', badge: 'success' },
      'owner-mismatch': { label: '属于其他账号，请核对记录', badge: 'error' },
      invalid: { label: '记录不一致，已保留', badge: 'error' },
    };
    const statusLabel = state => (STATUS[state] ? STATUS[state].label : '未知状态');
    const statusBadge = state => (STATUS[state] ? STATUS[state].badge : 'error');
    const gatewayLabel = (state, fallback) => (GATEWAY_STATUS[state] ? GATEWAY_STATUS[state].label : fallback);
    const gatewayBadge = state => (GATEWAY_STATUS[state] ? GATEWAY_STATUS[state].badge : 'error');

    // §6.1 网关凭据派生
    // 凭据状态只在这里读；fallback 由调用点决定（未确认用 unknown、待配置用 unconfigured）。
    function deriveGatewayUi(credential, fallback = 'unknown') {
      const state = typeof credential?.state === 'string' && Object.hasOwn(GATEWAY_STATUS, credential.state) ? credential.state : fallback;
      return {
        state,
        configured: state === 'configured',
        unconfigured: state === 'unconfigured',
        unknown: state === 'unknown',
        ownerMismatch: state === 'owner-mismatch',
        invalid: state === 'invalid',
      };
    }


    // §7 登录窗口
    function openLoginWindow() {
      try {
        const popup = window.open('', '_blank');
        if (popup) {
          try { popup.opener = null; } catch { /* cross-origin about:blank is still usable */ }
        }
        return popup;
      } catch {
        return null;
      }
    }

    function navigateLoginWindow(popup, url) {
      if (!popup) {
        if (url) {
          try { window.open(url, '_blank', 'noopener,noreferrer'); } catch { /* visible fallback link remains */ }
        }
        return;
      }
      if (!url) {
        try { popup.close(); } catch { /* already closed */ }
        return;
      }
      try {
        popup.location.replace(url);
      } catch {
        try { popup.close(); } catch { /* already closed */ }
        try { window.open(url, '_blank', 'noopener,noreferrer'); } catch { /* visible fallback link remains */ }
      }
    }

    // §8 本地存储
    // 键名、序列化与失败兜底都收在这里，其余代码不直接访问浏览器存储。
    // 存储不可用（硬化环境）时读操作给默认值、写操作静默跳过，会话保持可用且不回落到文件。
    function createClientStore() {
      const read = (key) => {
        try { return window.localStorage.getItem(key); } catch { return null; }
      };
      const write = (key, value) => {
        try { window.localStorage.setItem(key, value); } catch { /* 存储不可用时静默跳过 */ }
      };
      const remove = (key) => {
        try { window.localStorage.removeItem(key); } catch { /* 同上 */ }
      };
      const readObject = (key, fallback) => {
        try {
          const parsed = JSON.parse(read(key) ?? 'null');
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
        } catch {
          return fallback;
        }
      };
      return {
        marker: {
          read: () => read(ONBOARDING_KEY),
          write: (value) => write(ONBOARDING_KEY, value),
        },
        modelOptions: {
          read: () => readObject(MODEL_OPTIONS_KEY, {}),
          write: (next) => write(MODEL_OPTIONS_KEY, JSON.stringify(next)),
        },
        models: {
          read(key) {
            if (!key) return [];
            try {
              const parsed = JSON.parse(read(key) ?? '[]');
              return Array.isArray(parsed) ? parsed : [];
            } catch {
              return [];
            }
          },
          write(key, models) {
            if (!key) return;
            if (Array.isArray(models) && models.length > 0) write(key, JSON.stringify(models));
          },
          remove,
          // 清掉旧版条目与全部 v2 条目：换账号或网关后不得把上一个身份的目录留给下一个人。
          purge(prefix, legacy) {
            try {
              const stale = [];
              for (let index = 0; index < window.localStorage.length; index += 1) {
                const key = window.localStorage.key(index);
                if (key && (key === legacy || key.startsWith(prefix))) stale.push(key);
              }
              for (const key of stale) remove(key);
            } catch { /* 同上 */ }
          },
        },
      };
    }
    const clientStore = createClientStore();

    function readMarker() { return clientStore.marker.read(); }
    function writeMarker(value) { clientStore.marker.write(value); }
    function readModelOptions() { return clientStore.modelOptions.read(); }
    function writeModelOptions(next) { clientStore.modelOptions.write(next); }

    // §9 错误文案
    // 错误码 → 用户文案。与宿主 MESSAGES（src/managed-models.mjs）同码同句，
    // 由 test/client-error-text.test.mjs 双向比对：宿主新增错误码时这里必须补齐。
    // 用无原型对象承载：码来自服务端，不能让 Object.prototype 上的键被当成文案。
    const ERROR_NOTICE = Object.freeze(Object.assign(Object.create(null), {
      // 会话与登录
      IAM_REQUEST_HEADER_REQUIRED: '操作未完成，请刷新页面后重试。',
      IAM_UNCONFIGURED: '企业登录尚未设置完成，请联系管理员。',
      IAM_CREDENTIALS_UNAVAILABLE: '凭据存储不可用，暂时无法登录。',
      IAM_CREDENTIALS_CLEAR_FAILED: '无法清除本设备的登录信息，请联系管理员。',
      IAM_REVOCATION_FAILED: '已在此设备退出：服务器拒绝了访问令牌撤销，该令牌可能仍然有效。',
      IAM_REVOCATION_UNKNOWN: '已在此设备退出，但无法确认访问令牌是否已撤销。',
      IAM_EXCLUSIVE_CONFLICT: '登录设置有冲突，请联系管理员。',
      // 视图接口把独占配置冲突作为原始原因（不带 IAM_ 前缀）回传，同一
      // 条件必须与问题清单同句，不能落到兜底文案再显示一遍。
      'exclusive-violation': '登录设置有冲突，请联系管理员。',
      'exclusive-check-unavailable': '暂时无法确认登录设置是否与其他插件冲突，请稍后重试。',
      IAM_UNREACHABLE: '暂时无法连接登录服务，请稍后重试。',
      IAM_STATE_MISMATCH: '登录未能完成，请重新登录。',
      IAM_CALLBACK_INVALID: '登录未能完成，请重新登录。',
      IAM_ATTEMPT_EXPIRED: '登录尝试已过期，请重新登录。',
      IAM_INVALID_GRANT: '登录已失效，请重新登录。',
      IAM_REAUTH_REQUIRED: '登录已失效，请重新登录。',
      IAM_NOT_SIGNED_IN: '请先登录企业账号。',
      IAM_ATTEMPT_CANCELLED: '登录已取消，请重新登录。',
      IAM_CALLBACK_UNAVAILABLE: '登录服务暂不可用，请刷新页面后重试。',
      IAM_CALLBACK_PORT_UNAVAILABLE: '登录回调端口被占用，暂时无法登录，请联系管理员。',
      IAM_CALLBACK_BIND_FAILED: '登录回调地址无法启用，请联系管理员检查登录配置。',
      IAM_CONFIG_INVALID: '企业登录设置有误，请联系管理员。',
      IAM_DISPOSED: '登录服务已关闭，请刷新页面。',
      IAM_GRANT_CONTEXT_MISMATCH: '登录状态已变化，请重新登录。',
      IAM_REFRESH_SUBJECT_MISMATCH: '登录状态已变化，请重新登录。',
      IAM_GATEWAY_KEY_INVALID: '个人访问凭证无法保存，请重新粘贴网关提供的凭证。',
      IAM_GATEWAY_URL_INVALID: '请输入有效的网关地址；非本机地址请使用 HTTPS。',
      // 模型门禁与网关：与宿主 MESSAGES 同码同句
      ENTERPRISE_GATEWAY_CREDENTIAL_REJECTED: '网关未接受个人访问凭证，请在“设置 → 企业账号”检查或更换凭证。',
      ENTERPRISE_GATEWAY_FORBIDDEN: '当前账号没有此模型的使用权限，请联系管理员。',
      ENTERPRISE_GATEWAY_RATE_LIMIT: '请求过于频繁，请稍后重试。',
      ENTERPRISE_GATEWAY_QUOTA_EXHAUSTED: '所选模型的额度已用尽，请更换模型或联系管理员。',
    ENTERPRISE_GATEWAY_IAM_TOKEN_REJECTED: '企业身份令牌已失效，请重新登录后再试。',
    ENTERPRISE_GATEWAY_CREDENTIAL_REVOKED: '个人访问凭证已被回收，请联系管理员重新申领。',
    ENTERPRISE_GATEWAY_CREDENTIAL_SUSPENDED: '个人访问凭证已被暂停，请联系管理员。',
    ENTERPRISE_GATEWAY_IDENTITY_MISMATCH: '登录身份与凭证绑定账号不一致，请重新登录后重试。',
    ENTERPRISE_GATEWAY_CLIENT_NOT_RECOGNIZED: '当前客户端的标识未被企业网关识别，请升级客户端或联系管理员核准。',
    ENTERPRISE_GATEWAY_BUDGET_EXHAUSTED: '所选模型的预算已用尽，请联系管理员或更换模型。',
      ENTERPRISE_GATEWAY_CALL_FAILED: '本次请求未完成，请重试；持续失败请联系管理员。',
      ENTERPRISE_GATEWAY_UNAVAILABLE: '暂时无法连接企业模型，请稍后重试。',
      ENTERPRISE_GATEWAY_REQUEST_REJECTED: '网关拒绝了本次请求，请检查网关地址或所选模型是否支持当前参数。',
      ENTERPRISE_MODEL_REASONING_UNSUPPORTED: '所选模型的推理档位不受支持，请重新选择思考级别。',
      ENTERPRISE_MODEL_CATALOG_INVALID: '网关返回的模型列表无法识别，请联系管理员检查网关。',
      ENTERPRISE_MODELS_UNAVAILABLE: '企业模型暂不可用，请联系管理员检查配置。',
      ENTERPRISE_MODEL_SYNC_CANCELLED: '模型目录同步被中断，请重试。',
      ENTERPRISE_MODEL_NOT_ALLOWED: '此模型未由企业开放，请选择企业提供的模型。',
      IAM_MODEL_CONTEXT_CHANGED: '账号或凭证已变化，请重新选择模型后再试。',
      IAM_LOGIN_REQUIRED: '企业账号已退出或登录已过期，请重新登录后再使用模型。',
      IAM_GATEWAY_CREDENTIAL_REQUIRED: '请在“设置 → 企业账号”保存当前账号的个人访问凭证。',
      IAM_GATEWAY_OWNER_MISSING: '请先登录企业账号，再添加个人访问凭证。',
      IAM_GATEWAY_ATOMIC_UNVERIFIED: '暂时无法安全地保存或清除凭证，请联系管理员。',
      IAM_GATEWAY_LEGACY_READ_ONLY: '现有凭证暂时只能查看，本次没有更改。如需更换，请联系管理员。',
      IAM_GATEWAY_CHANGED: '凭证已发生变化，本次没有更改。请刷新页面后核对。',
      IAM_GATEWAY_WRITE_UNKNOWN: '无法确认凭证是否已更改。请刷新页面查看状态，暂时不要重复操作。',
      IAM_REQUEST_INVALID: '请求内容无效，请重试。',
      IAM_REQUEST_TOO_LARGE: '请求过大，请检查粘贴内容。',
      IAM_UNAUTHENTICATED: '页面会话不可用，请刷新页面后重试。',
      IAM_CONNECTION_UNAVAILABLE: '页面会话不可用，请刷新页面后重试。',
      IAM_METHOD_NOT_ALLOWED: '请求不受支持，请刷新页面。',
      IAM_NOT_FOUND: '请求不受支持，请刷新页面。',
    }));
    // 未列举的码用同一句兜底，不把原始错误码抛给用户。
    function errorNotice(code) {
      return ERROR_NOTICE[code] ?? '操作未完成，请重试；如仍有问题，请联系管理员。';
    }

    // §10 诊断快照
    const DIAGNOSTIC_ERRORS = new Set([
      'IAM_ATOMIC_STORE_UNVERIFIED', 'IAM_UNCONFIGURED', 'IAM_CONFIG_INVALID',
      'IAM_CREDENTIALS_UNAVAILABLE', 'IAM_CREDENTIALS_CLEAR_FAILED', 'IAM_REVOCATION_FAILED',
      'IAM_REVOCATION_UNKNOWN',
      'IAM_EXCLUSIVE_CONFLICT', 'IAM_UNREACHABLE', 'IAM_STATE_MISMATCH', 'IAM_CALLBACK_INVALID',
      'IAM_ATTEMPT_EXPIRED', 'IAM_INVALID_GRANT', 'IAM_REAUTH_REQUIRED', 'IAM_NOT_SIGNED_IN',
      'IAM_ATTEMPT_CANCELLED', 'IAM_CALLBACK_UNAVAILABLE', 'IAM_DISPOSED',
      'IAM_CALLBACK_PORT_UNAVAILABLE', 'IAM_CALLBACK_BIND_FAILED',
      'IAM_GRANT_CONTEXT_MISMATCH', 'IAM_REFRESH_SUBJECT_MISMATCH',
      'IAM_GATEWAY_KEY_INVALID', 'IAM_GATEWAY_OWNER_MISSING', 'IAM_REQUEST_HEADER_REQUIRED',
      'IAM_GATEWAY_ATOMIC_UNVERIFIED', 'IAM_GATEWAY_LEGACY_READ_ONLY',
      'IAM_GATEWAY_CHANGED', 'IAM_GATEWAY_WRITE_UNKNOWN',
      'IAM_REQUEST_INVALID', 'IAM_REQUEST_TOO_LARGE', 'IAM_UNAUTHENTICATED',
      'IAM_CONNECTION_UNAVAILABLE', 'IAM_METHOD_NOT_ALLOWED', 'IAM_NOT_FOUND',
      'IAM_REQUEST_FAILED', 'IAM_VIEW_FAILED',
    ]);

    // Build a new scalar object: the original view/state may contain private data.
    function diagnosticSnapshot(state) {
      const view = state.view;
      const session = deriveSessionUi(view);
      const code = view?.error ?? state.error;
      return {
        format: 'forge-iam-diagnostic', version: 1,
        pagePhase: ['loading', 'ready', 'error'].includes(state.phase) ? state.phase : 'unknown',
        iamState: session.known ? session.state : 'unknown',
        configured: typeof view?.configured === 'boolean' ? view.configured : null,
        signedIn: typeof view?.signedIn === 'boolean' ? view.signedIn : null,
        exclusive: view?.exclusive === 'ok' ? 'ok' : typeof view?.exclusive === 'string' && view.exclusive ? 'not-ok' : 'unknown',
        gatewayState: deriveGatewayUi(view?.gatewayCredential).state,
        errorCode: code == null ? null : DIAGNOSTIC_ERRORS.has(code) ? code : 'unknown',
        missingConfigCount: Array.isArray(view?.missing) ? view.missing.length : null,
      };
    }

    // §11 会话轮询
    function useSessionPoll(enabled, update, barrierRef) {
      const updateRef = React.useRef(update);
      updateRef.current = update;
      React.useEffect(() => {
        if (!enabled) return undefined;
        let live = true;
        let inFlight = false;
        const apply = (view) => {
          const epoch = barrierRef?.current.epoch;
          if (!live || (barrierRef && (barrierRef.current.pending || barrierRef.current.epoch !== epoch))) return;
          updateRef.current(view);
        };
        // Prefer the Host's read-only stream; polling stays as the fallback so
        // a proxy that buffers event-stream responses cannot freeze the panel.
        let stream = null;
        let timer = null;
        const closeStream = () => {
          if (!stream) return;
          try { stream.close(); } catch { /* already closed */ }
          stream = null;
        };
        const openStream = () => {
          if (typeof window === 'undefined' || typeof window.EventSource !== 'function') return false;
          try {
            stream = new window.EventSource('/api/forge-iam/events');
            stream.onmessage = (event) => {
              try { apply(JSON.parse(event.data)); } catch { /* ignore malformed frame */ }
            };
            stream.onerror = () => { closeStream(); startPolling(); };
            return true;
          } catch {
            stream = null;
            return false;
          }
        };
        const poll = async () => {
          if (inFlight) return;
          inFlight = true;
          const epoch = barrierRef?.current.epoch;
          try {
            const view = await fetchView();
            if (live && (!barrierRef || (!barrierRef.current.pending && barrierRef.current.epoch === epoch))) updateRef.current(view);
          } catch {
            // The next tick retries; a transient Host failure must not erase
            // the last known state.
          } finally {
            inFlight = false;
          }
        };
        const startPolling = () => { if (!timer) timer = setInterval(poll, 2000); };
        if (!openStream()) startPolling();
        return () => {
          live = false;
          closeStream();
          if (timer) clearInterval(timer);
        };
      }, [enabled]);
    }

    // §12 卡片与旅程条
    function renderAccountCard(ctx) {
      const { h, ui: input, actions } = ctx;
      const {
        view, label, principal, expiry, missing, issues, exclusive, hostError, notice, loginLink, state, copy, copyTools,
      } = input;
      const { login, cancelLogin, load, signOut, copyLink, copyDiagnostic, isViewCurrent, viewBarrier, linkIdentity } = actions;
      const ui = deriveSessionUi(view);
      return h('div', { id: 'fiam-section-account', className: 'fiam-card' },
        h('div', { className: 'fiam-card-header' },
          h('div', { className: 'fiam-card-title-group' },
            h('div', { className: 'fiam-avatar' },
              h('svg', { viewBox: '0 0 20 20', width: 20, height: 20, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 },
                h('path', { d: 'M16 17v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 15.5V17' }),
                h('circle', { cx: 10, cy: 7, r: 3 })
              )
            ),
            h('div', null,
              h('div', { className: 'fiam-card-title' }, ui.ready && view.principal ? view.principal : '企业账号认证'),
              h('div', { className: 'fiam-card-subtitle' }, ui.ready ? '已绑定企业 OIDC 身份' : '单点登录至企业账号'),
            ),
          ),
          h('span', { className: `fiam-badge fiam-badge-${statusBadge(ui.state)}` },
            h('span', { className: 'fiam-badge-dot' }),
            label,
          ),
        ),
        (view.principal || view.accessExpiresAt) ? h('div', { className: 'fiam-meta-grid' },
          principal ? h('div', { className: 'fiam-meta-item' }, principal) : null,
          expiry ? h('div', { className: 'fiam-meta-item' }, expiry) : null,
        ) : null,
        issues,
        hostError,
        notice,
        ui.authenticating
          ? h('div', { className: 'fiam-auth-progress', role: 'status', 'aria-live': 'polite' },
            h('div', { style: { display: 'inline-flex', alignItems: 'center', gap: 10 } },
              h('div', { className: 'fiam-spinner', style: { width: 16, height: 16 } }),
              h('span', null, state.authorizationUrl ? '已唤起浏览器授权页，请在浏览器中完成企业登录。' : '请在浏览器中完成登录；如果无法继续，请取消后重试。'),
            ),
            loginLink,
          )
          : loginLink,
        h('div', { className: 'fiam-actions' },
          view.canSignIn ? h('button', { type: 'button', className: 'forge-iam-primary', style: primaryButton, onClick: login }, '登录企业账号') : null,
          ui.authenticating ? h('button', { type: 'button', style: button, onClick: cancelLogin }, '取消登录') : null,
          h('button', { type: 'button', style: button, disabled: viewBarrier.current.pending, onClick: load }, '刷新'),
          view.canSignOut ? h('button', { type: 'button', style: button, onClick: signOut }, '退出') : null,
          deriveSessionUi(state.view).authenticating && linkIdentity.current && state.authorizationUrl === linkIdentity.current
            ? h('button', { type: 'button', style: button, disabled: copy.pending || viewBarrier.current.pending, onClick: copyLink }, '复制登录链接') : null,
        ),
        // The account card owns the link-copy feedback; the acknowledgement must
        // be visible while 诊断 is collapsed, not only after opening it.
        copy.notice && copy.url && isViewCurrent(copy.epoch) && copy.url === linkIdentity.current
          ? h('div', { role: 'status', 'aria-live': 'polite', className: 'fiam-notice fiam-notice-success' }, copy.notice) : null,
      );
    }

    // §12.1 网关卡
    function renderGatewayCard(ctx) {
      const { h, ui: input, actions } = ctx;
      const { view, gateway, gatewayStatus, gatewayDetails, storageWarning, credential } = input;
      const { setCredential, saveCredential, clearCredential, viewBarrier } = actions;
      const gatewayUi = deriveGatewayUi(gateway);
      const hasDraftChanges = Boolean(credential.value || (credential.baseURL !== undefined && credential.baseURL !== (gateway.baseURL ?? view.modelAccess?.baseURL ?? '')));
      return h('div', { id: 'fiam-section-gateway', className: 'fiam-card' },
        h('div', { className: 'fiam-card-header' },
          h('div', { className: 'fiam-card-title-group' },
            h('div', { className: 'fiam-avatar', style: { background: 'color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent)', color: 'var(--dsw-alias-state-business-primary)' } },
              h('svg', { viewBox: '0 0 20 20', width: 20, height: 20, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 },
                h('path', { d: 'M10 2s6 2.5 6 7c0 4.5-3.5 7.5-6 9-2.5-1.5-6-4.5-6-9 0-4.5 6-7 6-7Z' }),
                h('path', { d: 'm7.5 10 2 2 3.5-3.5' })
              )
            ),
            h('div', null,
              h('div', { className: 'fiam-card-title' }, '个人访问凭证'),
              h('div', { className: 'fiam-card-subtitle' }, '填写企业 AI 网关签发的个人访问凭证。'),
            ),
          ),
          h('span', { className: `fiam-badge fiam-badge-${gatewayBadge(gatewayUi.state)}` },
            h('span', { className: 'fiam-badge-dot' }),
            `个人访问凭证：${gatewayStatus}`,
          ),
        ),
        gatewayDetails.length ? h('div', { className: 'fiam-meta-grid' },
          ...gatewayDetails.map((item, idx) => h('span', { key: idx, className: 'fiam-meta-item' }, item))
        ) : null,
        storageWarning,
        h('label', { style: fieldLabel },
          h('span', { style: { fontWeight: 500, fontSize: 13 } }, '网关地址'),
          h('input', {
            type: 'url', 'aria-label': '网关地址', autoComplete: 'off',
            value: credential.baseURL ?? gateway.baseURL ?? view.modelAccess?.baseURL ?? '',
            placeholder: 'https://gateway.example/v1', disabled: credential.saving || viewBarrier.current.pending,
            onChange: (event) => setCredential((current) => ({ ...current, baseURL: event.target.value })), style: inputStyle
          }),
          h('span', { style: muted }, '填写网关提供的地址；修改地址时请重新输入对应的个人访问凭证。'),
        ),
        hasDraftChanges
          ? h('div', { role: 'status', className: 'fiam-unsaved-banner' },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('span', { className: 'fiam-badge fiam-badge-warn' }, '待保存'),
              h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-primary)' } }, '有未保存的更改。保存后将重新获取模型列表。'),
            ),
            h('button', {
              type: 'button',
              style: { ...secondaryButton, height: 26, minHeight: 26, padding: '0 10px', fontSize: 12 },
              disabled: credential.saving || viewBarrier.current.pending,
              onClick: () => setCredential((current) => ({ ...current, value: '', baseURL: undefined })),
            }, '重置输入'),
          ) : null,
        h('div', { className: 'fiam-callout' },
          h('svg', { className: 'fiam-callout-icon', viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 },
            h('circle', { cx: 8, cy: 8, r: 6 }),
            h('path', { d: 'M8 7v4m0-6h.01' })
          ),
          h('div', null,
            gatewayUi.configured
              ? '个人访问凭证已保存且不会显示。保存凭证不代表模型已连接或可用。'
              : gatewayUi.unknown
                ? '请刷新核实；若仍无法确认，请重新保存个人访问凭证。'
                : gatewayUi.unconfigured
                  ? '在企业 AI 网关创建个人访问凭证，然后粘贴到下方。'
                  : '请先核对现有凭证；如有疑问，请联系管理员。',
            gatewayUi.unconfigured && view.gatewayConsoleUrl
              ? h('div', { style: { marginTop: 4 } },
                h('a', { href: view.gatewayConsoleUrl, target: '_blank', rel: 'noreferrer' }, '前往企业 AI 网关创建凭证 ↗')
              )
              : null
          )
        ),
        h('div', { style: { marginTop: 14, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' } },
          h('label', { style: { ...fieldLabel, flex: '2 1 240px' } },
            h('span', { style: { fontWeight: 500, fontSize: 13 } }, '个人访问凭证'),
            h('input', {
              type: 'password',
              value: credential.value,
              placeholder: gatewayUi.configured ? '已保存，输入新凭证可更换' : '粘贴个人访问凭证',
              'aria-label': '个人访问凭证',
              autoComplete: 'off',
              spellCheck: false,
              disabled: credential.saving || viewBarrier.current.pending,
              onChange: (event) => setCredential((current) => ({ ...current, value: event.target.value })),
              style: inputStyle,
            })
          ),
          h('label', { style: { ...fieldLabel, flex: '1 1 150px' } },
            h('span', { style: { fontWeight: 500, fontSize: 13 } }, '设备标签（可选）'),
            h('input', {
              type: 'text',
              value: credential.deviceLabel,
              placeholder: '设备标签（可选）',
              'aria-label': '设备标签',
              maxLength: 64,
              disabled: credential.saving || viewBarrier.current.pending,
              onChange: (event) => setCredential((current) => ({ ...current, deviceLabel: event.target.value })),
              style: inputStyle,
            })
          ),
        ),
        h('div', { className: 'fiam-actions' },
          h('button', { type: 'button', className: 'forge-iam-primary', style: primaryButton, disabled: credential.saving || viewBarrier.current.pending, onClick: saveCredential }, credential.saving ? '正在处理…' : '保存凭据'),
          (!gatewayUi.unconfigured && !gatewayUi.unknown) || credential.value
            ? h('button', { type: 'button', style: secondaryButton, disabled: credential.saving || viewBarrier.current.pending, onClick: clearCredential }, '清除凭据')
            : null,
        ),
        credential.notice
          ? h('div', {
            role: 'status',
            'aria-live': 'polite',
            className: `fiam-notice fiam-notice-${credential.notice.includes('已保存') || credential.notice.includes('已清除') ? 'success' : 'warn'}`,
          }, credential.notice)
          : null,
      );
    }

    // §12.2 模型条目
    function renderModelItem(ctx) {
      const { h, item, actions } = ctx;
      const { model, idx, isExpanded, opt, modelOptions, modelSaving, viewBarrier, view } = item;
      const {
        toggleModelExpand, updateOptionField, commitOptionField, commitOptionFieldOnBlur, resetModelOption, disableModelOption,
        enableModelOption, enableModelWithDefaults, disableModelWithSave, saveModelOptions,
      } = actions;



      const displayName = opt.name || model.name || model.id;
      const defaultContextStr = formatCapacity(model.contextWindow ?? DEFAULT_CONTEXT_WINDOW);
      const defaultMaxTokensStr = formatCapacity(model.maxTokens ?? DEFAULT_MAX_TOKENS);
      const contextVal = opt.contextWindow !== undefined && String(opt.contextWindow).trim() !== ''
        ? opt.contextWindow
        : defaultContextStr;
      const maxTokensVal = opt.maxTokens !== undefined && String(opt.maxTokens).trim() !== ''
        ? opt.maxTokens
        : defaultMaxTokensStr;
      const contextInvalid = opt.contextWindow !== undefined && String(opt.contextWindow).trim() !== '' && parseCapacity(opt.contextWindow) === undefined;
      const maxTokensInvalid = opt.maxTokens !== undefined && String(opt.maxTokens).trim() !== '' && parseCapacity(opt.maxTokens) === undefined;
      const currentModalities = Array.isArray(opt.inputModalities) ? opt.inputModalities : (model.inputModalities ?? ['text']);
      const hasImage = currentModalities.includes('image');
      const reasoningBounds = getReasoningEffortBounds(opt.reasoningEfforts ?? model.reasoningEfforts ?? buildReasoningEffortRange('off', 'high'));
      const hasReasoning = reasoningBounds.enabled || Boolean(model.reasoning);
      const reasoningBadgeText = reasoningBounds.enabled
        ? (reasoningBounds.lower === reasoningBounds.upper
          ? `深度推理 · ${REASONING_LEVEL_SHORT[reasoningBounds.lower]}`
          : `深度推理 · ${REASONING_LEVEL_SHORT[reasoningBounds.lower]}~${REASONING_LEVEL_SHORT[reasoningBounds.upper]}`)
        : '深度推理';
      const hasCustom = Boolean(modelOptions[model.id] && Object.keys(modelOptions[model.id]).length > 0);
      // Presence in the map is what makes a model callable; otherwise it is only
      // listed here so it can be turned on.
      const isEnabled = Object.hasOwn(modelOptions, model.id);
      const isDefaultModel = view?.modelAccess?.defaultModelId === model.id;
      const actionBusy = Boolean(modelSaving || viewBarrier?.current?.pending);

      return h('div', { key: model.id, className: `fiam-model-item${isExpanded ? ' fiam-model-item-expanded' : ''}` },
        h('div', { className: 'fiam-model-row' },
          h('div', { className: 'fiam-model-info' },
            h('div', { className: 'fiam-model-header-line' },
              h('span', { className: `fiam-model-dot ${isEnabled ? 'fiam-model-dot-enabled' : 'fiam-model-dot-disabled'}` }),
              h('span', { className: 'fiam-model-name', title: `${displayName} (${model.id})` }, displayName),
              isEnabled
                ? h('span', { className: 'fiam-badge fiam-badge-success' }, isDefaultModel ? '默认可用' : '已启用')
                : null,
            ),
            h('div', { className: 'fiam-model-meta-line' },
              !isEnabled ? h('span', { className: 'fiam-model-meta-status' }, '未启用') : null,
              !isEnabled ? h('span', { className: 'fiam-model-meta-sep' }, '·') : null,
              h('span', { className: 'fiam-model-meta-spec' }, `${contextVal} · 输出 ${maxTokensVal}`),
              hasImage ? h('span', { className: 'fiam-model-meta-sep' }, '·') : null,
              hasImage ? h('span', { className: 'fiam-model-meta-item' }, '视觉图片') : null,
              hasReasoning ? h('span', { className: 'fiam-model-meta-sep' }, '·') : null,
              hasReasoning ? h('span', { className: 'fiam-model-meta-item' }, reasoningBadgeText) : null,
              displayName !== model.id ? h('span', { className: 'fiam-model-meta-sep' }, '·') : null,
              displayName !== model.id ? h('span', { className: 'fiam-model-meta-id' }, model.id) : null,
            ),
          ),
          h('div', { className: 'fiam-model-row-actions' },
            isEnabled
              ? h('button', {
                type: 'button',
                style: { ...secondaryButton, minHeight: 26, height: 26, padding: '0 8px', fontSize: 12, flexShrink: 0 },
                disabled: actionBusy,
                title: Object.keys(modelOptions).length === 1
                  ? `停用后立即生效；这是最后一个已启用模型，停用后新对话将无法选择企业模型`
                  : isDefaultModel
                    ? `停用后立即生效，不再出现在对话模型选择中；默认模型会自动切换到其他已启用模型`
                    : `停用后立即生效，不再出现在对话模型选择中`,
                'aria-label': `一键停用 ${model.id}`,
                onClick: () => disableModelWithSave(model.id),
              }, '停用')
              : null,
            !isEnabled
              ? h('button', {
                type: 'button',
                className: 'forge-iam-primary fiam-quick-btn',
                style: { ...primaryButton, minHeight: 26, height: 26, padding: '0 10px', fontSize: 12 },
                disabled: actionBusy,
                title: `采用默认参数（${defaultContextStr} 上下文 · ${defaultMaxTokensStr} 输出）一键启用并保存`,
                'aria-label': `一键启用 ${model.id}`,
                onClick: () => enableModelWithDefaults(model.id),
              }, '一键启用')
              : null,
            h('button', {
              type: 'button',
              style: { ...secondaryButton, minHeight: 26, height: 26, padding: '0 8px', fontSize: 12, flexShrink: 0 },
              'aria-expanded': isExpanded,
              'aria-label': `配置 ${model.id}`,
              onClick: () => toggleModelExpand(model.id),
            }, isExpanded ? '收起配置 ▲' : '精细配置 ▼'),
          )
        ),
        isExpanded
          ? h('div', { className: 'fiam-model-advanced' },
            h('div', { className: 'fiam-field-full' },
              h('label', { style: fieldLabel },
                h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: 4 } },
                  h('span', { className: 'fiam-field-title' }, '显示名称'),
                  renderHelpTip('模型在对话中展示的友好名称。留空时默认使用模型原生 ID。', `显示名称提示 ${idx + 1}`),
                ),
                h('input', {
                  type: 'text',
                  style: inputStyle,
                  placeholder: model.id,
                  value: opt.name ?? '',
                  'aria-label': `显示名称 ${idx + 1}`,
                  onChange: (e) => updateOptionField(model.id, 'name', e.target.value),
                  onBlur: (e) => commitOptionFieldOnBlur(model.id, 'name', e.target.value),
                }),
              ),
            ),
            h('div', { className: 'fiam-field-grid-spec' },
              h('label', { className: 'fiam-field-col', style: fieldLabel },
                h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 } },
                  h('div', { style: { display: 'flex', alignItems: 'center' } },
                    h('span', { className: 'fiam-field-title' }, '上下文窗口'),
                    renderHelpTip('单次请求允许的最大上下文容量。默认 200K，支持输入数字或 K/M（如 128K、200K、1M）。建议不高于内部约定的规格上限，避免超限溢出。', `上下文窗口提示 ${idx + 1}`),
                  ),
                  contextInvalid
                    ? h('span', { className: 'fiam-field-hint', style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 11 } }, '请输入合法容量值（如 128K、200K、1M）')
                    : null,
                ),
                h('input', {
                  type: 'text',
                  style: inputStyle,
                  placeholder: defaultContextStr,
                  value: opt.contextWindow ?? '',
                  'aria-label': `上下文窗口 ${idx + 1}`,
                  onChange: (e) => updateOptionField(model.id, 'contextWindow', e.target.value),
                  onBlur: (e) => commitOptionFieldOnBlur(model.id, 'contextWindow', e.target.value),
                }),
                h('div', { className: 'fiam-capacity-presets' },
                  ...['64K', '128K', '200K', '256K', '1M'].map(preset => {
                    const active = (opt.contextWindow ? String(opt.contextWindow).toUpperCase() : defaultContextStr) === preset;
                    return h('button', {
                      key: preset,
                      type: 'button',
                      className: `fiam-preset-pill ${active ? 'fiam-preset-pill-active' : ''}`,
                      'aria-label': `上下文预设 ${preset} ${idx + 1}`,
                      title: `预设上下文规格：${preset}${preset === defaultContextStr ? '（推荐默认）' : ''}`,
                      onClick: () => commitOptionField(model.id, 'contextWindow', preset === defaultContextStr ? undefined : preset),
                    }, preset);
                  })
                ),
              ),
              h('label', { className: 'fiam-field-col', style: fieldLabel },
                h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 } },
                  h('div', { style: { display: 'flex', alignItems: 'center' } },
                    h('span', { className: 'fiam-field-title' }, '单次最大输出'),
                    renderHelpTip('模型单次回复生成的最大 Token 数量。默认 64K，支持输入数字或 K/M（如 16K、32K、64K）。建议不高于内部约定的规格上限。', `单次最大输出提示 ${idx + 1}`),
                  ),
                  maxTokensInvalid
                    ? h('span', { className: 'fiam-field-hint', style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 11 } }, '请输入合法容量值（如 16K、64K）')
                    : null,
                ),
                h('input', {
                  type: 'text',
                  style: inputStyle,
                  placeholder: defaultMaxTokensStr,
                  value: opt.maxTokens ?? '',
                  'aria-label': `最大输出 Token ${idx + 1}`,
                  onChange: (e) => updateOptionField(model.id, 'maxTokens', e.target.value),
                  onBlur: (e) => commitOptionFieldOnBlur(model.id, 'maxTokens', e.target.value),
                }),
                h('div', { className: 'fiam-capacity-presets' },
                  ...['8K', '16K', '32K', '64K', '128K'].map(preset => {
                    const active = (opt.maxTokens ? String(opt.maxTokens).toUpperCase() : defaultMaxTokensStr) === preset;
                    return h('button', {
                      key: preset,
                      type: 'button',
                      className: `fiam-preset-pill ${active ? 'fiam-preset-pill-active' : ''}`,
                      'aria-label': `输出上限预设 ${preset} ${idx + 1}`,
                      title: `预设最大输出：${preset}${preset === defaultMaxTokensStr ? '（推荐默认）' : ''}`,
                      onClick: () => commitOptionField(model.id, 'maxTokens', preset === defaultMaxTokensStr ? undefined : preset),
                    }, preset);
                  })
                ),
              ),
            ),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              h('div', { style: { display: 'flex', alignItems: 'center' } },
                h('span', { className: 'fiam-field-section-title' }, '输入模态'),
                renderHelpTip('勾选模型支持的多模态输入能力。文本默认开启，图片按需勾选。', `输入模态提示 ${idx + 1}`),
              ),
              h('div', { className: 'fiam-checkbox-group' },
                h('label', { className: 'fiam-checkbox-item' },
                  h('input', { type: 'checkbox', checked: true, disabled: true }),
                  h('span', null, '文本 (Text)')
                ),
                h('label', { className: 'fiam-checkbox-item' },
                  h('input', {
                    type: 'checkbox',
                    checked: hasImage,
                    'aria-label': `图片输入模态 ${idx + 1}`,
                    onChange: (e) => {
                      const checked = e.target.checked;
                      const next = checked ? ['text', 'image'] : ['text'];
                      return commitOptionField(model.id, 'inputModalities', next);
                    },
                  }),
                  h('span', null, '图片附件 (Vision / Image)')
                ),
              ),
            ),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              h('div', { style: { display: 'flex', alignItems: 'center' } },
                h('span', { className: 'fiam-field-section-title' }, '深度推理上下界'),
                renderHelpTip('设置深度思考档位的下界与上界。若下界高于上界将自动对齐；初次未选择时默认采用下界最低档。', `深度推理提示 ${idx + 1}`),
              ),
              h('div', { className: 'fiam-reasoning-bounds' },
                h('label', { style: fieldLabel },
                  h('span', { className: 'fiam-field-title' }, '推理强度下界 (最低档)'),
                  h('select', {
                    className: 'fiam-select',
                    'aria-label': `推理强度下界 ${idx + 1}`,
                    value: reasoningBounds.enabled ? reasoningBounds.lower : 'off',
                    onChange: (e) => {
                      const nextLower = e.target.value;
                      const currentUpper = reasoningBounds.enabled ? reasoningBounds.upper : nextLower;
                      if (nextLower === 'off' && currentUpper === 'off') {
                        return commitOptionField(model.id, 'reasoningEfforts', { off: 'off' });
                      }
                      const lowerIdx = THINKING_LEVELS.indexOf(nextLower);
                      const upperIdx = THINKING_LEVELS.indexOf(currentUpper);
                      const resolvedUpper = upperIdx >= lowerIdx ? currentUpper : nextLower;
                      return commitOptionField(model.id, 'reasoningEfforts', buildReasoningEffortRange(nextLower, resolvedUpper));
                    },
                  },
                    ...THINKING_LEVELS.map(lv => h('option', { key: lv, value: lv }, REASONING_LEVEL_LABELS[lv])),
                  ),
                ),
                h('label', { style: fieldLabel },
                  h('span', { className: 'fiam-field-title' }, '推理强度上界 (最高档)'),
                  h('select', {
                    className: 'fiam-select',
                    'aria-label': `推理强度上界 ${idx + 1}`,
                    value: reasoningBounds.enabled ? reasoningBounds.upper : 'off',
                    onChange: (e) => {
                      const nextUpper = e.target.value;
                      if (nextUpper === 'off') {
                        return commitOptionField(model.id, 'reasoningEfforts', { off: 'off' });
                      }
                      const currentLower = reasoningBounds.enabled ? reasoningBounds.lower : nextUpper;
                      const lowerIdx = THINKING_LEVELS.indexOf(currentLower);
                      const upperIdx = THINKING_LEVELS.indexOf(nextUpper);
                      const resolvedLower = lowerIdx >= 0 && lowerIdx <= upperIdx ? currentLower : nextUpper;
                      return commitOptionField(model.id, 'reasoningEfforts', buildReasoningEffortRange(resolvedLower, nextUpper));
                    },
                  },
                    ...THINKING_LEVELS.map(lv => h('option', { key: lv, value: lv }, REASONING_LEVEL_LABELS[lv])),
                  ),
                ),
              ),
              h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginTop: 2 } },
                h('span', { style: { ...muted, color: reasoningBounds.enabled ? 'var(--dsw-alias-state-business-primary)' : undefined, fontWeight: reasoningBounds.enabled ? 500 : 400 } },
                  reasoningBounds.enabled
                    ? (reasoningBounds.lower === reasoningBounds.upper
                      ? `当前生效：固定单档：${REASONING_LEVEL_SHORT[reasoningBounds.lower]}`
                      : `当前生效：开放区间：${reasoningBounds.levels.map(l => REASONING_LEVEL_SHORT[l]).join(' → ')}（共 ${reasoningBounds.levels.length} 档，未选择时默认 ${REASONING_LEVEL_SHORT[reasoningBounds.lower]}）`)
                    : '当前生效：未开启推理强度（关闭思考，使用标准直出）'),
                reasoningBounds.enabled ? h('button', {
                  type: 'button',
                  style: { ...secondaryButton, height: 22, minHeight: 22, padding: '0 8px', fontSize: 11 },
                  onClick: () => commitOptionField(model.id, 'reasoningEfforts', { off: 'off' }),
                }, '关闭推理') : null,
              ),
            ),
            h('div', { className: 'fiam-model-advanced-actions' },
              h('div', { className: 'fiam-model-actions-left' },
                hasCustom
                  ? h('button', {
                    type: 'button',
                    style: { ...secondaryButton, height: 28, minHeight: 28, padding: '0 10px', fontSize: 12 },
                    disabled: actionBusy,
                    onClick: () => resetModelOption(model.id),
                  }, '恢复默认参数')
                  : null,
                isEnabled
                  ? h('button', {
                    type: 'button',
                    style: { ...secondaryButton, height: 28, minHeight: 28, padding: '0 10px', fontSize: 12 },
                    disabled: actionBusy,
                    'aria-label': `停用 ${model.id}`,
                    onClick: () => disableModelOption(model.id),
                  }, '停用模型')
                  : h('button', {
                    type: 'button',
                    style: { ...secondaryButton, height: 28, minHeight: 28, padding: '0 10px', fontSize: 12 },
                    disabled: actionBusy,
                    'aria-label': `启用 ${model.id}`,
                    onClick: () => enableModelOption(model.id),
                  }, '启用模型')
              ),
              h('div', { className: 'fiam-model-actions-right' },
                h('button', {
                  type: 'button',
                  style: { ...secondaryButton, height: 28, minHeight: 28, padding: '0 10px', fontSize: 12 },
                  disabled: actionBusy,
                  onClick: () => toggleModelExpand(model.id),
                }, '收起'),
                h('button', {
                  type: 'button',
                  className: 'forge-iam-primary',
                  style: { ...primaryButton, height: 28, minHeight: 28, padding: '0 12px', fontSize: 12 },
                  disabled: actionBusy,
                  'aria-label': `保存模型配置`,
                  onClick: () => saveModelOptions(),
                }, modelSaving ? '正在保存…' : '保存模型配置')
              )
            )
          )
          : null
      );
    }

    // §12.3 旅程条
    function renderJourneyBar(ctx) {
      const { h, ui: input, model } = ctx;
      const { view, gateway, onNavigateStep } = input;
      const ui = deriveSessionUi(view);
      const gatewayUi = deriveGatewayUi(gateway);
      const catalogue = deriveModelUi(view);
      const step1Done = ui.ready;
      const step1Warn = ui.expired || ui.failed || ui.unconfigured || ui.unreachable;
      const step2Done = step1Done && gatewayUi.configured && gateway.matchesAccount !== false;
      const step2Warn = step1Done && (gatewayUi.ownerMismatch || gatewayUi.invalid || gatewayUi.unknown);
      const step3Loading = step2Done && catalogue.loading;
      const step3Warn = step2Done && (catalogue.failed || (catalogue.ready && model.totalModels === 0));
      const step3Done = step2Done && catalogue.ready && model.enabledCount > 0;
      const steps = [
        {
          num: '1',
          title: '身份',
          targetId: 'fiam-section-account',
          status: step1Done ? '已认证' : (ui.authenticating ? '认证中' : (ui.unconfigured ? '待配置登录' : (ui.unreachable ? '连接受阻' : (step1Warn ? '需重新登录' : '待认证')))),
          done: step1Done,
          warn: step1Warn,
          active: !step1Done && !step1Warn,
        },
        {
          num: '2',
          title: '凭据',
          targetId: 'fiam-section-gateway',
          status: step2Done ? '已就绪' : (step2Warn ? '需核对' : '待配置'),
          done: step2Done,
          warn: step2Warn,
          active: step1Done && !step2Done && !step2Warn,
        },
        {
          num: '3',
          title: '模型',
          targetId: 'fiam-section-models',
          status: step3Done ? `已启用 ${model.enabledCount}/${model.totalModels}` : (step3Loading ? '同步中…' : (catalogue.failed ? (catalogue.stale ? '目录待刷新' : '同步异常') : (catalogue.ready && model.totalModels === 0 ? '无可用模型' : (step2Done ? '待启用' : '待解锁')))),
          done: step3Done,
          warn: step3Warn,
          active: step2Done && !step3Done && !step3Warn,
        },
      ];

      const checkIcon = h('svg', {
        viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round',
      }, h('path', { d: 'M3.5 8.5l3 3 6-6' }));

      const chevronIcon = h('svg', {
        viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
      }, h('path', { d: 'M6 3.5l4.5 4.5L6 12.5' }));

      const children = [];
      steps.forEach((s, idx) => {
        if (idx > 0) {
          children.push(h('div', { key: `sep-${idx}`, className: 'fiam-journey-arrow', 'aria-hidden': 'true' }, chevronIcon));
        }
        const stateClass = s.done ? 'done' : (s.warn ? 'warn' : (s.active ? 'active' : 'idle'));
        children.push(h('div', {
          key: s.title,
          // 步骤是入口，不是装饰：纯键盘用户也要能打开对应的卡片，所以给它按钮语义、
          // 停在 Tab 顺序里，并接受 Enter/空格（PR #215 复审 P2）。
          role: 'button',
          tabIndex: 0,
          className: `fiam-journey-step fiam-journey-step-${stateClass}`,
          style: { cursor: 'pointer' },
          onClick: () => {
            if (typeof onNavigateStep === 'function') onNavigateStep(s.targetId);
          },
          onKeyDown: (event) => {
            if (event?.key !== 'Enter' && event?.key !== ' ' && event?.key !== 'Spacebar') return;
            event.preventDefault?.();
            if (typeof onNavigateStep === 'function') onNavigateStep(s.targetId);
          },
        },
          h('div', {
            className: `fiam-journey-icon fiam-journey-icon-${stateClass}`,
            'aria-hidden': 'true',
          }, s.done ? checkIcon : s.num),
          h('div', { className: 'fiam-journey-content', 'aria-current': s.active ? 'step' : undefined },
            h('span', { className: 'fiam-journey-title' }, s.title),
            h('span', { className: `fiam-journey-pill fiam-journey-pill-${stateClass}` }, s.status),
          ),
        ));
      });

      return h('div', { className: 'fiam-journey-bar', role: 'region', 'aria-label': '模型接入进度' },
        ...children
      );
    }

    // §12.4 滚动容器定位
    function findScrollParent(el) {
      if (typeof window === 'undefined' || typeof document === 'undefined') return null;
      let parent = el?.parentElement;
      while (parent && parent !== document.body && parent !== document.documentElement) {
        try {
          const style = window.getComputedStyle?.(parent);
          const overflowY = style?.overflowY;
          if ((overflowY === 'auto' || overflowY === 'scroll') && parent.scrollHeight > parent.clientHeight) {
            return parent;
          }
        } catch { }
        parent = parent.parentElement;
      }
      return document.scrollingElement || document.documentElement || (typeof window !== 'undefined' ? window : null);
    }

    // §12.5 帮助提示：与具体条目无关，提到文件级只定义一次。
    function renderHelpTip(text, ariaLabel) {
      return h('span', { className: 'fiam-help-wrap' },
        h('button', {
          type: 'button',
          className: 'fiam-help-btn',
          'aria-label': ariaLabel || text,
          title: text,
          onClick: (e) => {
            e.preventDefault();
            e.stopPropagation();
          },
        }, '?'),
        h('span', { className: 'fiam-help-popover', role: 'tooltip' }, text)
      );
    }

    // §13 模型卡
    function renderModelsCard(ctx) {
      const { h, ui: input, model, actions } = ctx;
      const { view, credential, viewBarrier, gateway } = input;
      // 目录数据在 model、目录动作在 actions；这里只解出本地名字，函数体不变。
      const {
        list: modelList, visible: visibleModels, enabledCount, options: modelOptions, expanded: expandedModels,
        query: modelQuery, setQuery: setModelQuery, filter: modelFilter, setFilter: setModelFilter,
        toolbarRef, saving: modelSaving, notice: modelNotice, unsaved: hasUnsavedModelChanges,
      } = model;
      const {
        changeFilter: handleFilterChange, toggleExpand: toggleModelExpand, updateField: updateOptionField,
        commitField: commitOptionField, commitFieldOnBlur: commitOptionFieldOnBlur,
        resetOption: resetModelOption, enableOption: enableModelOption, disableOption: disableModelOption,
        enableWithDefaults: enableModelWithDefaults, enableAllWithDefaults: enableAllModelsWithDefaults,
        disableWithSave: disableModelWithSave,
        discard: discardModelChanges, save: saveModelOptions, refresh: refreshModels,
      } = actions;
      const ui = deriveSessionUi(view);
      const catalogueUi = deriveModelUi(view);
      const gatewayUi = deriveGatewayUi(gateway);
      const unenabledCount = Math.max(0, modelList.length - enabledCount);
      const onFilterSelect = handleFilterChange || setModelFilter;
      return h('section', { id: 'fiam-section-models', className: 'fiam-card', 'aria-label': '企业模型' },
        h('div', { className: 'fiam-card-header' },
          h('div', { className: 'fiam-card-title-group' },
            h('div', { className: 'fiam-avatar', style: { background: 'color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent)', color: 'var(--dsw-alias-state-business-primary)' } },
              h('svg', { viewBox: '0 0 20 20', width: 20, height: 20, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 },
                h('rect', { x: 3, y: 3, width: 14, height: 14, rx: 2 }),
                h('path', { d: 'M7 8h6M7 12h4' })
              )
            ),
            h('div', null,
              h('div', { className: 'fiam-card-title' }, '企业模型设置'),
              !catalogueUi.configured
                ? h('div', { className: 'fiam-card-subtitle' }, '配置网关地址和凭证后自动同步可用模型')
                : null,
            ),
          ),
          catalogueUi.ready
            ? h('span', { className: `fiam-badge fiam-badge-${modelList.length > 0 ? 'success' : 'warn'}` },
              h('span', { className: 'fiam-badge-dot' }),
              `已同步 ${modelList.length} 个模型`
            )
            : catalogueUi.stale
              ? h('span', { className: 'fiam-badge fiam-badge-warn' },
                h('span', { className: 'fiam-badge-dot' }),
                `已缓存 ${modelList.length} 个模型`
              )
            : catalogueUi.loading
              ? h('span', { className: 'fiam-badge fiam-badge-authenticating' },
                h('span', { className: 'fiam-badge-dot' }),
                '正在同步…'
              )
              : catalogueUi.failed
                ? h('span', { className: 'fiam-badge fiam-badge-error' },
                  h('span', { className: 'fiam-badge-dot' }),
                  '同步异常'
                )
                : null,
        ),
        !catalogueUi.configured
          ? h('p', { style: muted }, '请先保存网关地址和个人访问凭证。')
          : null,
        catalogueUi.stale
          ? h('div', {
            className: 'fiam-notice fiam-notice-warn',
            style: {
              marginTop: 8,
              width: '100%',
              boxSizing: 'border-box',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              flexWrap: 'wrap',
            },
          },
            h('span', { style: { flex: '1 1 0', minWidth: 200 } },
              `目录未更新：${errorNotice(catalogueUi.error)}`
              // A passed or absent retry time means the automatic chain is done;
              // pointing at the retry button or cached availability stays clear.
              + (Math.round((Number(view.modelAccess.retryAt) - Date.now()) / 1000) >= 1
                ? ` 约 ${Math.round((Number(view.modelAccess.retryAt) - Date.now()) / 1000)} 秒后自动重试。`
                : '（已加载本地缓存模型，可继续使用）。')),
            h('button', {
              type: 'button',
              className: 'fiam-quick-btn',
              style: {
                ...secondaryButton,
                minHeight: 24,
                height: 24,
                padding: '0 8px',
                fontSize: 12,
                flexShrink: 0,
                background: 'transparent',
                borderColor: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent)',
                color: 'var(--dsw-alias-state-warn-primary)',
              },
              disabled: credential.saving || modelSaving || viewBarrier.current.pending,
              onClick: refreshModels,
            }, credential.saving ? '正在刷新…' : '立即重试'),
          )
          : null,
        catalogueUi.configured && modelList.length > 0
          ? h('div', { className: 'fiam-callout', style: { marginTop: 6, marginBottom: 8 } },
            h('svg', { className: 'fiam-callout-icon', viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 },
              h('circle', { cx: 8, cy: 8, r: 6 }),
              h('path', { d: 'M8 7v4m0-6h.01' })
            ),
            h('div', null,
              h('strong', { style: { fontWeight: 500, color: 'var(--dsw-alias-label-primary)' } }, '参数配置提示：'),
              '上下文长度和最大输出不要超过模型支持的上限，否则可能导致内容截断或调用失败。'
            )
          )
          : null,
        catalogueUi.configured && modelList.length > 0
          ? h('div', { ref: toolbarRef, className: 'fiam-model-toolbar' },
            h('div', { className: 'fiam-search-wrap' },
              h('input', {
                type: 'search',
                className: 'fiam-model-search',
                style: { ...inputStyle, minHeight: 32, fontSize: 13 },
                placeholder: '搜索模型名称或 ID…',
                'aria-label': '搜索模型',
                value: modelQuery,
                onChange: (e) => setModelQuery(e.target.value),
              }),
              modelQuery.trim() !== ''
                ? h('button', {
                  type: 'button',
                  className: 'fiam-search-clear',
                  'aria-label': '清除搜索',
                  title: '清除搜索关键词',
                  onClick: () => setModelQuery(''),
                }, '×')
                : null,
            ),
            h('div', { className: 'fiam-model-toolbar-controls' },
              h('div', { className: 'fiam-model-filters' },
                h('button', {
                  type: 'button',
                  className: `fiam-chip ${modelFilter === 'all' ? 'fiam-chip-active' : ''}`,
                  onClick: () => onFilterSelect('all'),
                }, `全部 (${modelList.length})`),
                h('button', {
                  type: 'button',
                  className: `fiam-chip ${modelFilter === 'enabled' ? 'fiam-chip-active' : ''}`,
                  onClick: () => onFilterSelect('enabled'),
                }, `已启用 (${enabledCount})`),
              ),
              unenabledCount > 0
                ? h('button', {
                  type: 'button',
                  className: 'fiam-quick-btn fiam-batch-btn',
                  style: { ...secondaryButton, minHeight: 28, height: 28, padding: '0 10px', fontSize: 12 },
                  disabled: modelSaving || viewBarrier.current.pending,
                  title: '以推荐默认参数一次性启用全部未开启的模型',
                  'aria-label': '全部默认启用',
                  onClick: enableAllModelsWithDefaults,
                }, `全部默认启用 (${unenabledCount})`)
                : null,
              h('button', {
                type: 'button',
                className: 'fiam-quick-btn',
                style: {
                  ...secondaryButton,
                  minHeight: 28,
                  height: 28,
                  padding: '0 8px',
                  fontSize: 12,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                },
                disabled: credential.saving || modelSaving || viewBarrier.current.pending || !ui.ready || !gatewayUi.configured,
                title: '从企业网关重新同步最新模型目录',
                'aria-label': '刷新模型目录',
                onClick: refreshModels,
              },
                h('svg', {
                  key: 'refresh-icon',
                  viewBox: '0 0 16 16',
                  width: 12,
                  height: 12,
                  fill: 'none',
                  stroke: 'currentColor',
                  strokeWidth: 1.6,
                  className: credential.saving ? 'fiam-spin' : '',
                  style: { flexShrink: 0 },
                },
                  h('path', { d: 'M13.5 8a5.5 5.5 0 1 1-1.6-3.9l1.6-1.6' }),
                  h('path', { d: 'M13.5 2.5v4h-4' })
                ),
                credential.saving ? '正在刷新…' : '刷新目录',
              ),
            )
          )
          : null,
        catalogueUi.configured && modelList.length > 0 && hasUnsavedModelChanges
          ? h('div', { className: 'fiam-unsaved-banner' },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('span', { className: 'fiam-badge fiam-badge-warn' }, '待保存'),
              h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-primary)' } }, '模型配置有未保存的修改'),
            ),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
              h('button', {
                type: 'button',
                className: 'forge-iam-primary',
                style: { ...primaryButton, height: 26, minHeight: 26, padding: '0 10px', fontSize: 12 },
                disabled: modelSaving || viewBarrier.current.pending,
                onClick: saveModelOptions,
              }, modelSaving ? '正在保存…' : '保存模型配置'),
              h('button', {
                type: 'button',
                style: { ...secondaryButton, height: 26, minHeight: 26, padding: '0 10px', fontSize: 12 },
                disabled: modelSaving || viewBarrier.current.pending,
                onClick: discardModelChanges,
              }, '放弃修改'),
            )
          )
          : null,
        catalogueUi.configured && modelList.length > 0
          ? h('div', { className: 'fiam-model-list', 'aria-label': '企业预置模型' },
            ...(visibleModels.length === 0
              ? [h('div', { key: 'empty-filter', style: { ...muted, padding: '16px 12px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 } },
                h('span', null, '没有匹配的模型，请调整搜索词或筛选条件。'),
                (modelFilter !== 'all' || modelQuery.trim() !== '')
                  ? h('button', {
                    type: 'button',
                    style: { ...secondaryButton, height: 26, minHeight: 26, padding: '0 10px', fontSize: 12 },
                    onClick: () => { onFilterSelect('all'); setModelQuery(''); },
                  }, '重置筛选条件')
                  : null,
              )]
              : visibleModels.map((model, idx) => {
                const opt = modelOptions[model.id] || {};
                const isExpanded = Boolean(expandedModels[model.id]);
                return renderModelItem({
                  h,
                  item: { model, idx, isExpanded, opt, modelOptions, modelSaving, viewBarrier, view },
                  actions: {
                    toggleModelExpand, updateOptionField, commitOptionField, commitOptionFieldOnBlur, resetModelOption, disableModelOption,
                    enableModelOption, enableModelWithDefaults, disableModelWithSave, saveModelOptions,
                  },
                });
              }))
          )
          : null,
        (catalogueUi.loading && modelList.length === 0)
          ? h('div', { role: 'status', className: 'fiam-auth-progress' },
            h('div', { style: { display: 'inline-flex', alignItems: 'center', gap: 8 } },
              h('div', { className: 'fiam-spinner', style: { width: 16, height: 16 } }),
              h('span', null, '正在获取模型列表…'),
            )
          )
          : null,
        catalogueUi.ready && !modelList.length
          ? h('div', { role: 'status', className: 'fiam-notice fiam-notice-warn' }, '网关没有返回可用模型，请检查个人访问凭证的模型权限。') : null,
        catalogueUi.error && !catalogueUi.stale ? h('div', { role: 'status', className: 'fiam-notice fiam-notice-error' }, errorNotice(catalogueUi.error)) : null,
        h('div', { className: 'fiam-actions' },
          h('button', {
            type: 'button',
            style: secondaryButton,
            disabled: credential.saving || modelSaving || viewBarrier.current.pending || !ui.ready || !gatewayUi.configured,
            onClick: refreshModels,
          }, credential.saving ? '正在处理…' : '刷新模型列表'),
          h('button', {
            type: 'button',
            className: 'forge-iam-primary',
            style: primaryButton,
            disabled: modelSaving || viewBarrier.current.pending || !ui.ready || !gatewayUi.configured,
            onClick: saveModelOptions,
          }, modelSaving ? '正在保存…' : '保存模型配置'),
          hasUnsavedModelChanges
            ? h('button', {
              type: 'button',
              style: secondaryButton,
              disabled: modelSaving || viewBarrier.current.pending,
              onClick: discardModelChanges,
            }, '放弃修改')
            : null,
          hasUnsavedModelChanges
            ? h('span', { className: 'fiam-badge fiam-badge-warn' }, '待保存模型配置变更')
            : null,
        ),
        modelNotice
          ? h('div', {
            role: 'status',
            'aria-live': 'polite',
            className: `fiam-notice fiam-notice-${modelNotice.includes('保存') || modelNotice.includes('生效') || modelNotice.includes('恢复') ? 'success' : 'warn'}`,
          }, modelNotice)
          : null,
        h('p', { style: { ...muted, marginTop: 12 } }, !gatewayUi.configured || gateway.matchesAccount === false ? '下一步：在上方保存当前账号的个人凭证。'
          : '点击“一键启用”可直接以默认参数启用并生效；展开精细配置修改参数后，点击“保存模型配置”即可在对话窗口选用。'),
      );
    }

    // One catalogue cache per person and gateway. A shared browser profile must
    // never show another account's model list; a v1 entry has no owner, so it is
    // discarded on mount instead of being adopted by whoever signs in next.
    // §13.1 模型缓存
    const MODEL_CACHE_PREFIX = 'forge-iam.cached-models.v2';
    const MODEL_CACHE_LEGACY = 'forge-iam.cached-models.v1';
    function modelCacheKey(view) {
      const owner = typeof view?.principal === 'string' ? view.principal.trim() : '';
      const baseURL = view?.gatewayCredential?.baseURL ?? view?.modelAccess?.baseURL ?? '';
      if (!owner || !baseURL) return null;
      return `${MODEL_CACHE_PREFIX}:${owner}:${baseURL}`;
    }
    function purgeModelCache() { clientStore.models.purge(MODEL_CACHE_PREFIX, MODEL_CACHE_LEGACY); }
    function readCachedModels(key) { return clientStore.models.read(key); }
    function writeCachedModels(key, models) { clientStore.models.write(key, models); }

    // §14.1 模型目录
    // 目录缓存、参数覆盖、筛选与就地保存是一组自洽状态：只依赖 view 与 viewBarrier，
    // 不跨到会话或凭据状态，因此单独成 hook。返回按 data/actions 分簇，供渲染入口直接接收。
    function useModelCatalogue({ view, viewBarrier, setView }) {
      const initialModelOptions = readModelOptions();
      const [cachedModels, setCachedModels] = React.useState([]);
      const cacheKeyRef = React.useRef(null);
      const [modelOptions, setModelOptions] = React.useState(initialModelOptions);
      const [expandedModels, setExpandedModels] = React.useState({});
      const [modelQuery, setModelQuery] = React.useState('');
      const [modelFilter, setModelFilter] = React.useState('all');
      const [modelSaving, setModelSaving] = React.useState(false);
      const [modelNotice, setModelNotice] = React.useState(null);
      // DESIGN §4: signed out, only the login step is expanded. The other two
      // steps stay unmounted until the reader asks for them, so a signed-out
      // panel cannot offer actions that need a session.
      const [revealPersonal, setRevealPersonal] = React.useState(false);
      const lastSyncedOptions = React.useRef(initialModelOptions);
      // 草稿的最新值：事件回调里读它，避免闭包里拿到上一帧的状态。
      const optionsRef = React.useRef(initialModelOptions);
      // 串行队列：一次 PUT 提交整份启用集，后改的不能被先到的应答覆盖。
      const saveQueue = React.useRef({ busy: false, next: null });
      React.useEffect(() => { optionsRef.current = modelOptions; }, [modelOptions]);
      // 事件回调可能先于 effect 触发，写入时同步刷新镜像。
      const applyModelOptions = (next) => { optionsRef.current = next; setModelOptions(next); };
      const toolbarRef = React.useRef(null);
      // 与 Panel 的判定同式：做过期的应答不得回写视图。
      const isCurrentEpoch = (epoch) => !viewBarrier.current.pending && viewBarrier.current.epoch === epoch;

      const liveModels = view?.modelAccess?.models;
      const viewCacheKey = modelCacheKey(view);
      React.useEffect(() => {
        clientStore.models.remove(MODEL_CACHE_LEGACY);
      }, []);
      React.useEffect(() => {
        if (cacheKeyRef.current === viewCacheKey) return;
        const previous = cacheKeyRef.current;
        cacheKeyRef.current = viewCacheKey;
        // Drop the previous identity's list the moment the person or gateway changes.
        if (previous && previous !== viewCacheKey) clientStore.models.remove(previous);
        setCachedModels(readCachedModels(viewCacheKey));
      }, [viewCacheKey]);
      React.useEffect(() => {
        if (Array.isArray(liveModels) && liveModels.length > 0) {
          setCachedModels(liveModels);
          writeCachedModels(cacheKeyRef.current, liveModels);
        }
      }, [liveModels]);

      const handleFilterChange = (nextFilter) => {
        if (nextFilter === modelFilter) return;
        const toolbarEl = toolbarRef.current;
        let rectBefore = null;
        try {
          rectBefore = toolbarEl?.getBoundingClientRect?.();
        } catch { }
        setModelFilter(nextFilter);
        if (toolbarEl && rectBefore && typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => {
            try {
              const rectAfter = toolbarEl.getBoundingClientRect();
              const diff = rectAfter.top - rectBefore.top;
              if (Math.abs(diff) > 0.5) {
                const scrollParent = findScrollParent(toolbarEl);
                if (scrollParent) {
                  if (typeof scrollParent.scrollBy === 'function') {
                    scrollParent.scrollBy({ top: diff, behavior: 'instant' });
                  } else if ('scrollTop' in scrollParent) {
                    scrollParent.scrollTop += diff;
                  }
                }
              }
            } catch { }
          });
        }
      };

      const toggleModelExpand = (id) => {
        setExpandedModels(prev => ({ ...prev, [id]: !prev[id] }));
      };

      const withOptionField = (options, id, field, value) => {
        const modelOpt = { ...(options[id] || {}) };
        if (value === undefined || value === '') {
          delete modelOpt[field];
        } else {
          modelOpt[field] = value;
        }
        return { ...options, [id]: modelOpt };
      };

      // 文本输入只改草稿，失焦时才提交：逐字保存会把一次输入拆成十几个请求。
      const updateOptionField = (id, field, value) => {
        applyModelOptions(withOptionField(optionsRef.current, id, field, value));
      };

      // 离散控件（预设、勾选、档位）一次选定即提交，不需要再点保存。
      const commitOptionField = (id, field, value) => {
        const next = withOptionField(optionsRef.current, id, field, value);
        applyModelOptions(next);
        return persistModelOptions(next, '模型配置已自动保存并生效。');
      };

      // 失焦提交：值没变就不发请求，避免点进点出各写一次。
      const commitOptionFieldOnBlur = (id, field, value) => {
        const next = withOptionField(optionsRef.current, id, field, value);
        if ((next[id]?.[field] ?? undefined) === (lastSyncedOptions.current?.[id]?.[field] ?? undefined)) return;
        applyModelOptions(next);
        return persistModelOptions(next, '模型配置已自动保存并生效。');
      };

      // Clearing the overrides must not disable the model: it stays enabled with
      // catalogue defaults, so "back to defaults" never silently breaks a chat.
      const resetModelOption = (id) => {
        const next = { ...optionsRef.current, [id]: {} };
        applyModelOptions(next);
        return persistModelOptions(next, `已恢复 ${id} 的默认参数（仍启用）。`);
      };

      const enableModelOption = (id) => {
        if (Object.hasOwn(optionsRef.current, id)) return;
        const next = { ...optionsRef.current, [id]: {} };
        applyModelOptions(next);
        return persistModelOptions(next, `已启用 ${id}。`);
      };

      const disableModelOption = (id) => {
        const current = optionsRef.current;
        if (!Object.hasOwn(current, id)) return;
        const next = { ...current };
        delete next[id];
        const remaining = Object.keys(next).length;
        const wasDefault = view?.modelAccess?.defaultModelId === id;
        const notice = remaining === 0
          ? `已停用 ${id}，当前没有已启用模型，新对话将无法选择企业模型（可随时一键启用）。`
          : wasDefault
            ? `已停用 ${id}，默认模型已自动切换到其他已启用模型。`
            : `已停用 ${id}。`;
        applyModelOptions(next);
        return persistModelOptions(next, notice);
      };

      // 面板里的「停用模型」只改草稿，必须再点保存才生效。列表行上的「停用」没有面板可展开，
      // 所以与「一键启用」对称：改完草稿立即提交整份启用集合。
      // 状态机上的三个后果都在这条路径上处理：
      // - 一次 PUT 提交的是整份集合，其他未保存的修改会一并生效，提示里如实说明；
      // - 停用的是默认模型时，宿主在同一次提交里重算默认模型并同步宿主默认（SM4），
      //   这里只负责把结果说清楚；
      // - 停用最后一个模型会提交空集合，SM3 允许（设计 §13.1），SM4 回到未对齐状态，
      //   因此提示必须点明「新对话将无法选择企业模型」。
      const disableModelWithSave = async (id) => {
        if (!Object.hasOwn(modelOptions, id)) return;
        if (modelSaving || viewBarrier.current.pending) return;
        const nextOptions = { ...modelOptions };
        delete nextOptions[id];
        const wasDefault = view?.modelAccess?.defaultModelId === id;
        const dirty = JSON.stringify(modelOptions) !== JSON.stringify(lastSyncedOptions.current);
        const remaining = Object.keys(nextOptions).length;
        const notice = remaining === 0
          ? `已停用 ${id}，当前没有已启用模型，新对话将无法选择企业模型（可随时一键启用）。`
          : wasDefault
            ? `已停用 ${id}，默认模型已自动切换到其他已启用模型。`
            : dirty
              ? `已停用 ${id}，其他未保存的修改一并生效。`
              : `已停用 ${id} 并生效。`;
        applyModelOptions(nextOptions);
        await persistModelOptions(nextOptions, notice);
      };

      const discardModelChanges = () => {
        applyModelOptions(lastSyncedOptions.current);
        setModelNotice('已放弃未保存的模型配置修改。');
      };

      // 一份 PUT 只提交整份启用集；队列保证「后改的」不会被「先发的」应答覆盖。
      const sendModelOptions = async (nextOptions, successMessage) => {
        if (viewBarrier.current.pending) {
          setModelNotice('登录状态已变化，本次模型配置未保存；刷新后请重新设置。');
          return;
        }
        try {
          writeModelOptions(nextOptions);
          const result = await putJson('/api/forge-iam/models', { options: nextOptions });
          if (!result.ok) {
            setModelNotice(resultNotice(result));
            return;
          }
          lastSyncedOptions.current = nextOptions;
          setModelNotice(result.body?.persisted === false
            ? '模型配置已在本机生效，但未能写入持久存储，重启后需重新保存。'
            : successMessage);
          if (isCurrentEpoch(viewBarrier.current.epoch)) {
            setView(result.body?.view);
            if (result.body?.view) void syncModelOptions(result.body.view);
          }
        } catch {
          setModelNotice('暂时无法连接服务，配置已保存在本地。');
        }
      };

      const persistModelOptions = (nextOptions, successMessage = '模型精细化配置已保存并生效。') => {
        const queue = saveQueue.current;
        let settle;
        const job = { options: nextOptions, message: successMessage, done: new Promise(resolve => { settle = resolve; }) };
        // 被后来者覆盖的旧任务视为已完成，等待它的一方不会挂住。
        if (queue.next) queue.next.settle();
        job.settle = settle;
        queue.next = job;
        if (queue.busy) return job.done;
        queue.busy = true;
        setModelSaving(true);
        void (async () => {
          try {
            while (queue.next) {
              const current = queue.next;
              queue.next = null;
              await sendModelOptions(current.options, current.message);
              current.settle();
            }
          } finally {
            queue.busy = false;
            setModelSaving(false);
          }
        })();
        return job.done;
      };

      const saveModelOptions = async () => {
        await persistModelOptions(optionsRef.current, '模型精细化配置已保存并生效。');
      };

      const enableModelWithDefaults = async (id) => {
        const nextOptions = { ...modelOptions, [id]: {} };
        applyModelOptions(nextOptions);
        await persistModelOptions(nextOptions, `已采用默认参数启用 ${id} 并生效。`);
      };

      const enableAllModelsWithDefaults = async () => {
        const currentModels = view?.modelAccess?.models ?? [];
        const nextOptions = { ...modelOptions };
        for (const m of currentModels) {
          if (m?.id && !Object.hasOwn(nextOptions, m.id)) {
            nextOptions[m.id] = {};
          }
        }
        applyModelOptions(nextOptions);
        await persistModelOptions(nextOptions, `已采用默认参数启用全部 ${currentModels.length} 个模型并生效。`);
      };
      const optionsSync = React.useRef({ signature: null });
      const syncModelOptions = React.useCallback(async (nextView) => {
        const access = nextView?.modelAccess;
        const catalogue = deriveModelUi(nextView);
        if (!deriveSessionUi(nextView).ready) {
          optionsSync.current.signature = null;
          lastSyncedOptions.current = {};
          applyModelOptions({});
          return;
        }
        if (!catalogue.ready || !access.modelOptions || typeof access.modelOptions !== 'object' || Array.isArray(access.modelOptions)) return;
        const hostOptions = access.modelOptions;
        const signature = JSON.stringify([nextView.subject ?? nextView.principal, hostOptions]);
        if (optionsSync.current.signature === signature) return;
        optionsSync.current.signature = signature;
        lastSyncedOptions.current = hostOptions;
        applyModelOptions(hostOptions);
        writeModelOptions(hostOptions);
      }, []);

      const current = view ?? {};
      const cachedForRender = cacheKeyRef.current === viewCacheKey ? cachedModels : readCachedModels(viewCacheKey);
      const safeCached = Array.isArray(cachedForRender) ? cachedForRender : [];
      const rawModelList = (Array.isArray(current.modelAccess?.models) && current.modelAccess.models.length > 0)
        ? current.modelAccess.models
        : safeCached;
      const modelList = [...rawModelList].sort((a, b) =>
        String(a?.id ?? '').localeCompare(String(b?.id ?? ''), 'en', { numeric: true, sensitivity: 'base' })
      );
      const enabledCount = modelList.filter(m => Object.hasOwn(modelOptions, m.id)).length;
      const normalizedQuery = modelQuery.trim().toLowerCase();
      const visibleModels = modelList.filter(m => {
        const opt = modelOptions[m.id] || {};
        if (modelFilter === 'enabled' && !Object.hasOwn(modelOptions, m.id)) return false;
        if (!normalizedQuery) return true;
        const displayName = String(opt.name || m.name || m.id).toLowerCase();
        return String(m.id).toLowerCase().includes(normalizedQuery) || displayName.includes(normalizedQuery);
      });

      const hasUnsavedModelChanges = JSON.stringify(modelOptions) !== JSON.stringify(lastSyncedOptions.current);
      function resetForSignOut() {
        setCachedModels([]);
        cacheKeyRef.current = null;
        purgeModelCache();
        applyModelOptions({});
        lastSyncedOptions.current = {};
        optionsSync.current.signature = null;
        setExpandedModels({});
        setModelNotice(null);
      }

      return {
        data: {
          list: modelList, visible: visibleModels, enabledCount, options: modelOptions, expanded: expandedModels,
          query: modelQuery, setQuery: setModelQuery, filter: modelFilter, setFilter: setModelFilter,
          toolbarRef, saving: modelSaving, notice: modelNotice, unsaved: hasUnsavedModelChanges,
          revealPersonal, setRevealPersonal,
        },
        actions: {
          changeFilter: handleFilterChange, toggleExpand: toggleModelExpand, updateField: updateOptionField,
          commitField: commitOptionField, commitFieldOnBlur: commitOptionFieldOnBlur,
          resetOption: resetModelOption, enableOption: enableModelOption, disableOption: disableModelOption,
          enableWithDefaults: enableModelWithDefaults, enableAllWithDefaults: enableAllModelsWithDefaults,
          disableWithSave: disableModelWithSave,
          discard: discardModelChanges, save: saveModelOptions, syncFromView: syncModelOptions,
          reset: resetForSignOut, clearNotice: () => setModelNotice(null), collapseAll: () => setExpandedModels({}),
        },
      };
    }

    // §14.2 凭据表单
    // 凭据草稿、保存、清除与目录刷新是一组动作：写入后回写视图、并让目录重新同步。
    // 两个端口是显式的：setView（回写视图）与 catalogue（清除目录提示与展开状态）。
    function useCredentialForm({ view, viewBarrier, setView, catalogue }) {
      const [credential, setCredential] = React.useState({ value: '', deviceLabel: '', saving: false, notice: null });
      const isCurrentEpoch = (epoch) => !viewBarrier.current.pending && viewBarrier.current.epoch === epoch;
      const pendingNotice = '网关地址和个人访问凭证已保存，正在获取模型列表。';
      // 卸载后不再回写状态：与 copy 的 liveness 同式，但由本 hook 自己持有。
      const live = React.useRef(true);
      React.useEffect(() => {
        live.current = true;
        return () => { live.current = false; };
      }, []);

      // 保存后目录同步完成时，把「正在获取」换成结果；其余提示原样保留。
      function noteModelsSynced(nextView) {
        setCredential((current) => {
          if (current.notice !== pendingNotice) return current;
          const models = deriveModelUi(nextView);
          if (models.ready) return { ...current, notice: '网关地址和个人访问凭证已保存，模型目录已同步。' };
          if (models.failed) return { ...current, notice: errorNotice(models.error) };
          return current;
        });
      }

      const saveCredential = async () => {
        if (viewBarrier.current.pending) return;
        const epoch = viewBarrier.current.epoch;
        const value = credential.value.trim();
        if (!value) {
          setCredential((current) => ({ ...current, notice: '请输入个人访问凭证。' }));
          return;
        }
        setCredential((current) => ({ ...current, saving: true, notice: null }));
        try {
          const result = await putJson('/api/forge-iam/credential', {
            key: value, deviceLabel: credential.deviceLabel.trim(),
            baseURL: (credential.baseURL ?? view?.gatewayCredential?.baseURL ?? view?.modelAccess?.baseURL ?? '').trim()
          });
          if (!result.ok) {
            setCredential((current) => ({
              ...current,
              saving: false,
              notice: resultNotice(result),
            }));
            return;
          }
          // The value is never stored in component state after the write.
          setCredential({ value: '', deviceLabel: credential.deviceLabel, saving: false, notice: '网关地址和个人访问凭证已保存，正在获取模型列表。' });
          if (isCurrentEpoch(epoch)) setView(result.body?.view);
        } catch {
          setCredential((current) => ({ ...current, saving: false, notice: '暂时无法连接服务，请稍后重试。' }));
        }
      };

      const refreshModels = async () => {
        if (viewBarrier.current.pending || credential.saving) return;
        const epoch = viewBarrier.current.epoch;
        setCredential((current) => ({ ...current, saving: true, notice: null }));
        try {
          const result = await getJson('/api/forge-iam/models');
          if (!isCurrentEpoch(epoch)) return;
          setCredential((current) => ({
            ...current, saving: false, notice: result.ok
              ? `模型列表已更新，共 ${result.body?.models?.length ?? 0} 个模型。`
              : resultNotice(result)
          }));
          if (result.ok) setView(result.body?.view);
        } catch { if (isCurrentEpoch(epoch)) setCredential((current) => ({ ...current, notice: '暂时无法获取模型列表，请稍后重试。' })); }
        finally { if (live.current) setCredential((current) => ({ ...current, saving: false })); }
      };

      const clearCredential = async () => {
        if (viewBarrier.current.pending) return;
        const epoch = viewBarrier.current.epoch;
        setCredential((current) => ({ ...current, saving: true, notice: null }));
        try {
          const result = await deleteJson('/api/forge-iam/credential');
          if (!result.ok) {
            setCredential((current) => ({
              ...current,
              saving: false,
              notice: resultNotice(result),
            }));
            return;
          }
          setCredential((current) => ({ ...current, saving: false, value: '', notice: '网关凭据已清除。' }));
          catalogue.actions.clearNotice();
          catalogue.actions.collapseAll();
          if (isCurrentEpoch(epoch)) setView(result.body?.view);
        } catch {
          setCredential((current) => ({ ...current, saving: false, notice: '暂时无法连接服务，请稍后重试。' }));
        }
      };


      return {
        credential,
        setCredential,
        save: saveCredential,
        refresh: refreshModels,
        clear: clearCredential,
        noteModelsSynced,
      };
    }

    // §14.3 会话视图
    // 会话视图由 Panel 持有（单一写者），这里只提供动作与复制通道：加载、轮询、
    // 登录/取消、退出，以及「复制登录链接 / 复制问题信息」。
    function useSessionView({ state, setState, viewBarrier, catalogue, form }) {
      const isCurrentEpoch = (epoch) => !viewBarrier.current.pending && viewBarrier.current.epoch === epoch;

      const wakeRef = React.useRef({ at: 0, inFlight: false });
      const viewRef = React.useRef(state.view);
      viewRef.current = state.view;
      React.useEffect(() => {
        if (typeof document === 'undefined' || typeof window === 'undefined') return undefined;
        const kick = () => {
          if (document.visibilityState === 'hidden') return;
          const at = Date.now();
          if (wakeRef.current.inFlight || at - wakeRef.current.at < 30000) return;
          const view = viewRef.current;
          if (!deriveSessionUi(view).ready || deriveModelUi(view).loading) return;
          wakeRef.current.at = at;
          wakeRef.current.inFlight = true;
          void getJson('/api/forge-iam/models')
            .then((result) => {
              if (result?.ok && result.body?.view) setState((current) => ({ ...current, view: result.body.view }));
            })
            .catch(() => { })
            .finally(() => { wakeRef.current.inFlight = false; });
        };
        document.addEventListener('visibilitychange', kick);
        window.addEventListener('focus', kick);
        return () => {
          document.removeEventListener('visibilitychange', kick);
          window.removeEventListener('focus', kick);
        };
      }, []);

      const linkIdentity = React.useRef(null);
      const copyRequest = React.useRef(null);
      const copyLive = React.useRef(true);
      const [copy, setCopy] = React.useState({ pending: false, notice: null, epoch: null, url: null });
      React.useEffect(() => {
        copyLive.current = true;
        return () => { copyLive.current = false; copyRequest.current = null; };
      }, []);

      const load = React.useCallback(async () => {
        if (viewBarrier.current.pending) return;
        const epoch = viewBarrier.current.epoch;
        try {
          const view = await fetchView();
          if (viewBarrier.current.pending || viewBarrier.current.epoch !== epoch) return;
          if (!deriveSessionUi(view).authenticating) linkIdentity.current = null;
          setState((current) => ({ ...current, phase: 'ready', view, error: null, ...(deriveSessionUi(view).authenticating ? {} : { authorizationUrl: null }) }));
          form.noteModelsSynced(view);
          void catalogue.actions.syncFromView(view);
        } catch (error) {
          if (viewBarrier.current.pending || viewBarrier.current.epoch !== epoch) return;
          linkIdentity.current = null;
          setState({ phase: 'error', view: null, error: error.message, notice: null, authorizationUrl: null });
        }
      }, []);

      React.useEffect(() => { load(); }, [load]);
      useSessionPoll(true, (view) => {
        // Invalidate before enqueueing React state, not only on the next render.
        if (!deriveSessionUi(view).authenticating) linkIdentity.current = null;
        setState((current) => ({
          ...current, phase: 'ready', view, error: null,
          ...(deriveSessionUi(view).authenticating ? {} : { authorizationUrl: null }),
        }));
        form.noteModelsSynced(view);
        void catalogue.actions.syncFromView(view);
      }, viewBarrier);

      const login = async () => {
        if (viewBarrier.current.pending) return;
        linkIdentity.current = null;
        // A new explicit login invalidates acknowledgements of the old view.
        viewBarrier.current.epoch += 1;
        const epoch = viewBarrier.current.epoch;
        setState((current) => ({ ...current, notice: null }));
        const popup = openLoginWindow();
        try {
          const result = await postJson('/api/forge-iam/sign-in');
          if (!isCurrentEpoch(epoch)) {
            try { popup?.close(); } catch { /* already closed */ }
            return;
          }
          if (!result.ok) {
            try { popup?.close(); } catch { /* already closed */ }
            setState((current) => ({ ...current, notice: resultNotice(result) }));
            return;
          }
          const view = result.body?.view ?? null;
          const authorizationUrl = result.body?.authorizationUrl ?? null;
          linkIdentity.current = deriveSessionUi(view).authenticating && typeof authorizationUrl === 'string' && authorizationUrl.trim() ? authorizationUrl : null;
          navigateLoginWindow(popup, authorizationUrl);
          setState((current) => ({ ...current, view, authorizationUrl, notice: null }));
        } catch {
          try { popup?.close(); } catch { /* already closed */ }
          if (isCurrentEpoch(epoch)) setState((current) => ({ ...current, notice: '暂时无法连接服务，请稍后重试。' }));
        }
      };

      const cancelLogin = async () => {
        if (viewBarrier.current.pending) return;
        linkIdentity.current = null;
        const epoch = viewBarrier.current.epoch;
        try {
          const result = await postJson('/api/forge-iam/cancel');
          if (!isCurrentEpoch(epoch)) return;
          if (!result.ok) {
            setState((current) => ({ ...current, notice: resultNotice(result) }));
            return;
          }
          setState((current) => ({ ...current, view: result.body?.view ?? null, authorizationUrl: null, notice: null }));
        } catch {
          if (isCurrentEpoch(epoch)) setState((current) => ({ ...current, notice: '暂时无法连接服务，请稍后重试。' }));
        }
      };

      const signOut = async () => {
        if (viewBarrier.current.pending) return;
        linkIdentity.current = null;
        viewBarrier.current.epoch += 1;
        viewBarrier.current.pending = true;
        setState((current) => ({ ...current, view: null, authorizationUrl: null, notice: '正在退出…' }));
        try {
          const result = await postJson('/api/forge-iam/sign-out');
          if (!result.ok) {
            setState((current) => ({
              ...current,
              view: result.body?.view ?? null,
              authorizationUrl: null,
              notice: resultNotice(result),
            }));
            return;
          }
          const view = result.body?.view ?? null;
          form.setCredential({ value: '', deviceLabel: '', saving: false, notice: null });
          catalogue.actions.reset();
          // The refresh token cannot be revoked: say so instead of "signed out".
          const signedOutNotice = result.body?.revocation === 'ok'
            ? '已退出：访问令牌已撤销；刷新令牌无法撤销，将在服务端自然过期。'
            : null;
          setState((current) => ({
            ...current,
            view,
            authorizationUrl: null,
            // An unconfirmed revocation must stay attributable after the local
            // session is gone; silently showing "signed out" would overclaim.
            notice: view?.error ? errorNotice(view.error) : signedOutNotice,
          }));
          if (result.body?.logoutUrl) window.location.assign(result.body.logoutUrl);
        } catch {
          setState((current) => ({ ...current, view: null, authorizationUrl: null, notice: '无法连接服务，退出结果未确认。请刷新页面查看登录状态。' }));
        } finally {
          viewBarrier.current.epoch += 1;
          viewBarrier.current.pending = false;
        }
      };

      const copyText = async (text, url = null) => {
        if (!copyLive.current || viewBarrier.current.pending || copyRequest.current) return;
        const request = {};
        const epoch = viewBarrier.current.epoch;
        const isCurrent = () => copyLive.current && isCurrentEpoch(epoch)
          && (!url || linkIdentity.current === url);
        copyRequest.current = request;
        setCopy({ pending: true, notice: null, epoch, url });
        try {
          const clipboard = window.navigator?.clipboard;
          if (typeof clipboard?.writeText !== 'function') throw new Error('unavailable');
          // Invoke before any await to retain the browser's user activation.
          const receipt = clipboard.writeText(text);
          if (!receipt || typeof receipt.then !== 'function') throw new Error('unconfirmed');
          await receipt;
          if (isCurrent()) setCopy((current) => ({
            ...current, notice: url
              ? '登录链接已复制，请勿转发给他人。' : '问题信息已复制，反映复制时的状态，不含账号和凭证。'
          }));
        } catch {
          if (isCurrent()) setCopy((current) => ({ ...current, notice: '未确认复制，请检查浏览器剪贴板权限；页面内容已保留。' }));
        } finally {
          if (copyRequest.current === request) {
            copyRequest.current = null;
            if (copyLive.current) setCopy((current) => ({ ...current, pending: false }));
          }
        }
      };
      const copyLink = () => {
        const url = linkIdentity.current;
        if (!url || url !== state.authorizationUrl || !deriveSessionUi(state.view).authenticating) return;
        return copyText(url, url);
      };
      const copyDiagnostic = () => copyText(JSON.stringify(diagnosticSnapshot(state)));


      return {
        linkIdentity, copy, load, login, cancelLogin, signOut, copyText, copyLink, copyDiagnostic, isViewCurrent: isCurrentEpoch,
      };
    }

    // §14 面板
    function Panel() {
      const [state, setState] = React.useState({ phase: 'loading', view: null, error: null, notice: null, authorizationUrl: null });

      // Waking a laptop or returning to the tab is when a signed-in session is
      // most likely to have drifted (network moved, gateway restarted). Re-read
      // the catalogue once, throttled so a focus storm cannot hammer the gateway.
      const viewBarrier = React.useRef({ epoch: 0, pending: false });
      const setView = (next) => setState((current) => ({ ...current, view: next ?? current.view }));
      const catalogue = useModelCatalogue({ view: state.view, viewBarrier, setView });
      const form = useCredentialForm({ view: state.view, viewBarrier, setView, catalogue });
      const session = useSessionView({ state, setState, viewBarrier, catalogue, form });

      // The signed-in Host owns the selection, including an explicitly empty
      // set. A browser cache must never restore another account's old choices.
      const box = { padding: '0 0 24px', maxWidth: 720, width: '100%', boxSizing: 'border-box', color: 'var(--dsw-alias-label-primary)', font: 'var(--dsw-font-s-14)' };
      const header = h('div', { style: { marginBottom: 16 } },
        h('div', { style: { font: 'var(--dsw-font-m-18)', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, '企业账号'),
        h('div', { style: { ...muted, marginTop: 4 } }, '管理企业账号和个人访问凭证'),
        h('p', { style: { ...muted, marginTop: 4 } }, '登录只建立身份，不代表已获得业务写权限。'),
      );
      const copyTools = h('div', { className: 'fiam-actions' },
        deriveSessionUi(state.view).authenticating && session.linkIdentity.current && state.authorizationUrl === session.linkIdentity.current
          ? h('button', { type: 'button', style: button, disabled: session.copy.pending || viewBarrier.current.pending, onClick: session.copyLink }, '复制登录链接') : null,
        h('button', { type: 'button', style: button, disabled: session.copy.pending || viewBarrier.current.pending, onClick: session.copyDiagnostic }, '复制问题信息'),
        session.copy.notice && session.isViewCurrent(session.copy.epoch) && (!session.copy.url || session.copy.url === session.linkIdentity.current)
          ? h('div', { role: 'status', 'aria-live': 'polite', className: 'fiam-notice fiam-notice-success' }, session.copy.notice) : null,
      );

      if (state.phase === 'loading') {
        return h('div', { className: 'forge-iam-ui', style: box }, interactionStyle(),
          header,
          h('div', { className: 'fiam-card', style: { padding: '28px 20px', textAlign: 'center' } },
            h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 } },
              h('div', { className: 'fiam-spinner' }),
              h('div', { style: muted }, '正在读取登录状态…'),
            )
          ),
          copyTools,
        );
      }
      if (state.phase === 'error') {
        return h('div', { className: 'forge-iam-ui', style: box }, interactionStyle(),
          header,
          h('div', { className: 'fiam-card', style: { padding: '24px 20px' } },
            h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 14 } },
              h('div', { className: 'fiam-avatar', style: { background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)', color: 'var(--dsw-alias-state-error-primary)' } },
                h('svg', { viewBox: '0 0 20 20', width: 20, height: 20, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 },
                  h('circle', { cx: 10, cy: 10, r: 8 }),
                  h('path', { d: 'M10 6v5m0 3h.01' })
                )
              ),
              h('div', { style: { flex: 1, minWidth: 0 } },
                h('div', { style: { fontWeight: 600, fontSize: 15, marginBottom: 4 } }, '无法读取登录状态。'),
                h('div', { style: muted }, errorNotice(state.error)),
                h('div', { className: 'fiam-actions', style: { marginTop: 14 } },
                  h('button', { type: 'button', className: 'forge-iam-primary', style: primaryButton, onClick: session.load }, '重试'),
                  h('button', { type: 'button', style: button, disabled: session.copy.pending || viewBarrier.current.pending, onClick: session.copyDiagnostic }, '复制问题信息'),
                ),
                session.copy.notice && session.isViewCurrent(session.copy.epoch) && (!session.copy.url || session.copy.url === session.linkIdentity.current)
                  ? h('div', { role: 'status', 'aria-live': 'polite', className: 'fiam-notice fiam-notice-success' }, session.copy.notice) : null,
              )
            )
          ),
        );
      }

      const view = state.view ?? {};
      const sessionUi = deriveSessionUi(state.view);
      const label = sessionUi.known ? statusLabel(sessionUi.state) : '未知状态';
      const missing = Array.isArray(view.missing) && view.missing.length
        ? h('div', { className: 'fiam-notice fiam-notice-warn' }, '企业登录设置不完整，请联系管理员。')
        : null;
      // One issue per priority: a conflict hides the weaker "not set up yet"
      // lines; the rest stay in a fold so nothing is silently dropped.
      const conflictIssue = view.exclusive && view.exclusive !== 'ok'
        ? h('div', { className: 'fiam-notice fiam-notice-error' }, '登录设置有冲突，请联系管理员。') : null;
      const incompleteIssue = Array.isArray(view.missing) && view.missing.length
        ? h('div', { className: 'fiam-notice fiam-notice-warn' }, '企业登录设置不完整，请联系管理员。') : null;
      const unsetIssue = sessionUi.state === 'unconfigured' || view.configured === false
        ? h('div', { className: 'fiam-notice fiam-notice-warn' }, '企业登录尚未设置，请联系管理员。') : null;
      const issueList = [conflictIssue, incompleteIssue, unsetIssue].filter(Boolean);
      const issues = issueList.length === 0 ? null : h('div', { className: 'fiam-issues' },
        issueList[0],
        issueList.length > 1
          ? h('details', { className: 'fiam-details' }, h('summary', null, '查看全部问题'), ...issueList.slice(1))
          : null,
      );
      const principal = view.principal ? h('div', { style: muted }, `账号标识：${view.principal}`) : null;
      const expiry = view.accessExpiresAt ? h('div', { style: muted }, `当前访问授权到期：${formatTime(view.accessExpiresAt)}`) : null;
      // The server reports the exclusive-config conflict twice: as the issue
      // reason and as view.error. Render the issue line only, so the page does
      // not also show a generic 操作未完成 for a condition already explained.
      const hostErrorText = view.error ? errorNotice(view.error) : null;
      const hostErrorDuplicatesIssue = Boolean(conflictIssue) && hostErrorText === '登录设置有冲突，请联系管理员。';
      const hostError = hostErrorText && !hostErrorDuplicatesIssue
        ? h('div', { className: 'fiam-notice fiam-notice-error' }, hostErrorText)
        : null;
      const notice = state.notice && (!hostErrorText || state.notice !== hostErrorText)
        ? h('div', { className: 'fiam-notice fiam-notice-warn' }, state.notice) : null;
      const loginLink = state.authorizationUrl
        ? h('div', { style: { marginTop: 8 } }, h('a', { href: state.authorizationUrl, target: '_blank', rel: 'noreferrer' }, '浏览器未打开？点此继续登录'))
        : null;

      const gateway = view.gatewayCredential ?? { state: 'unknown' };
      const gatewayUi = deriveGatewayUi(gateway);
      const gatewayStatus = gatewayLabel(gatewayUi.state, '凭据状态尚未确认');
      const gatewayDetails = [
        gateway.deviceLabel ? `设备：${gateway.deviceLabel}` : null,
        gateway.enteredAt ? `录入：${formatTime(gateway.enteredAt)}` : null,
        gateway.suggestedExpiry ? `建议到期：${gateway.suggestedExpiry}` : null,
      ].filter(Boolean);
      const storageWarning = gatewayUi.configured && gateway.storage && gateway.storage !== 'keychain'
        ? h('div', { className: 'fiam-notice fiam-notice-warn' },
          '凭证未使用系统安全存储，请联系管理员。')
        : null;

      // Read the identity's cache during the render that first sees that
      // identity, so a cached list never flashes empty while the effect catches up.
      const revealPersonal = catalogue.data.revealPersonal;
      const setRevealPersonal = catalogue.data.setRevealPersonal;
      const personalVisible = sessionUi.ready || revealPersonal;
      // 保存凭据途中、或回执还没被看到时，个人区不能因为会话过期而收起：卡片一卸载，
      // 失败提示就落在看不见的地方（PR #215 复审 P2）。回执真实可见优先于折叠。
      const credentialFeedback = Boolean(form.credential.saving || form.credential.notice);
      const personalShown = personalVisible || credentialFeedback;
      // The journey bar points at the cards below. While signed out the personal
      // steps are folded (DESIGN §4), so their cards are not mounted: a click
      // must open the fold first and scroll only once the card exists, instead
      // of silently scrolling to nothing.
      const navigateStep = (targetId) => {
        let target = null;
        try { target = document?.getElementById?.(targetId) ?? null; } catch { }
        const scroll = () => {
          try { document?.getElementById?.(targetId)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }); } catch { }
        };
        if (target) { scroll(); return; }
        if (targetId !== 'fiam-section-account' && !personalVisible) {
          setRevealPersonal(true);
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(scroll);
          else if (typeof setTimeout === 'function') setTimeout(scroll, 0);
          return;
        }
        scroll();
      };
      const journeyBar = renderJourneyBar({
        h,
        ui: { view, gateway, onNavigateStep: navigateStep },
        model: { enabledCount: catalogue.data.enabledCount, totalModels: catalogue.data.list.length },
      });

      const accountCard = renderAccountCard({
        h,
        ui: { view, label, principal, expiry, missing, issues, hostError, notice, loginLink, state, copy: session.copy, copyTools },
        actions: {
          login: session.login, cancelLogin: session.cancelLogin, load: session.load, signOut: session.signOut,
          copyLink: session.copyLink, copyDiagnostic: session.copyDiagnostic, isViewCurrent: session.isViewCurrent,
          viewBarrier, linkIdentity: session.linkIdentity,
        },
      });

      const gatewayCard = renderGatewayCard({
        h,
        ui: { view, gateway, gatewayStatus, gatewayDetails, storageWarning, credential: form.credential },
        actions: { setCredential: form.setCredential, saveCredential: form.save, clearCredential: form.clear, viewBarrier },
      });

      const modelsCard = renderModelsCard({
        h,
        ui: { view, credential: form.credential, viewBarrier, gateway },
        model: catalogue.data,
        actions: { ...catalogue.actions, refresh: form.refresh },
      });

      // 收起/展开入口在未登录时必须一直在：回执可见时卡片会临时展开，但入口不能跟着消失，
      // 否则纯键盘用户就没有可操作的对象去拿回模型卡（PR #215 复审 P2）。
      const foldLabel = revealPersonal ? '收起个人设置' : (personalShown ? '查看模型设置' : '登录后可配置');
      const personalFold = sessionUi.ready
        ? null
        : h('button', {
          type: 'button',
          className: 'fiam-personal-fold',
          style: { ...button, width: '100%', justifyContent: 'space-between' },
          'aria-expanded': personalShown,
          onClick: () => setRevealPersonal((current) => !current),
        },
          foldLabel,
        );

      const diagnosticFold = h('details', { className: 'fiam-details fiam-diagnostic' },
        h('summary', null, '诊断'),
        h('div', { className: 'fiam-actions', style: { marginTop: 8 } },
          h('button', { type: 'button', style: button, disabled: session.copy.pending || viewBarrier.current.pending, onClick: session.copyDiagnostic }, '复制问题信息'),
        ),
        // Only the diagnostic copy's own acknowledgement belongs here; the
        // account card renders the link copy's feedback in its visible area.
        session.copy.notice && !session.copy.url && session.isViewCurrent(session.copy.epoch)
          ? h('div', { role: 'status', 'aria-live': 'polite', className: 'fiam-notice fiam-notice-success' }, session.copy.notice) : null,
      );

      return h('div', { className: 'forge-iam-ui', style: box }, interactionStyle(),
        header,
        journeyBar,
        accountCard,
        personalFold,
        personalShown ? gatewayCard : null,
        personalVisible ? modelsCard : null,
        diagnosticFold,
      );
    }

    // §15 启动器
    function IamLauncherMenu(props) {
      const { view, status, onCopyDiagnostics, onSignOut, confirmSignOut, signingOut, notice, openSettings, onClose } = props;
      const isSignedIn = deriveSessionUi(view).ready;
      const gatewayUi = deriveGatewayUi(view?.gatewayCredential, 'unconfigured');
      const gwState = gatewayUi.state;
      const models = deriveModelUi(view);
      const gwConfigured = gatewayUi.configured;
      const principalName = view?.principal || view?.subject || '未登录员工';
      const avatarInitial = String(principalName).replace(/^E/i, '').slice(0, 2).toUpperCase() || '企';

      // Professional Feather/Lucide-style micro SVGs
      const settingsSvg = h('svg', {
        viewBox: '0 0 16 16', width: 15, height: 15, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', className: 'fiam-launcher-item-icon',
      },
        h('circle', { cx: 8, cy: 8, r: 2.5 }),
        h('path', { d: 'M13.2 9.8l-.9-.5c-.1-.1-.2-.2-.2-.4.1-.4.1-.7 0-1.1 0-.2.1-.3.2-.4l.9-.5c.4-.2.5-.7.3-1.1l-.8-1.4c-.2-.4-.7-.5-1.1-.3l-.9.5c-.2.1-.3.1-.5 0-.3-.2-.7-.4-1.1-.5-.2 0-.3-.2-.3-.3l-.1-1c0-.4-.4-.8-.9-.8H6.8c-.5 0-.9.4-.9.8l-.1 1c0 .2-.1.3-.3.3-.4.1-.8.3-1.1.5-.2.1-.3.1-.5 0l-.9-.5c-.4-.2-.9-.1-1.1.3l-.8 1.4c-.2.4-.1.9.3 1.1l.9.5c.1.1.2.2.2.4 0 .4-.1.7 0 1.1 0 .2-.1.3-.2.4l-.9.5c-.4.2-.5.7-.3 1.1l.8 1.4c.2.4.7.5 1.1.3l.9-.5c.2-.1.3-.1.5 0 .3.2.7.4 1.1.5.2 0 .3.2.3.3l.1 1c0 .4.4.8.9.8h1.6c.5 0 .9-.4.9-.8l.1-1c0-.2.1-.3.3-.3.4-.1.8-.3 1.1-.5.2-.1.3-.1.5 0l.9.5c.4.2.9.1 1.1-.3l.8-1.4c.2-.4.1-.9-.3-1.1z' })
      );

      const copySvg = h('svg', {
        viewBox: '0 0 16 16', width: 15, height: 15, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', className: 'fiam-launcher-item-icon',
      },
        h('rect', { x: 5.5, y: 5.5, width: 8, height: 8, rx: 1.5 }),
        h('path', { d: 'M3.5 10.5h-1a1 1 0 01-1-1v-6a1 1 0 011-1h6a1 1 0 011 1v1' })
      );

      const logoutSvg = h('svg', {
        viewBox: '0 0 16 16', width: 15, height: 15, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', className: 'fiam-launcher-item-icon',
      },
        h('path', { d: 'M6 13.5H3.5a1.5 1.5 0 01-1.5-1.5V4a1.5 1.5 0 011.5-1.5H6' }),
        h('path', { d: 'M10.5 11l3-3-3-3M13.5 8H6' })
      );

      const dotSvg = (color) => h('span', {
        style: {
          display: 'inline-block', width: 6, height: 6, borderRadius: '50%', backgroundColor: color, flexShrink: 0,
        },
      });

      return h('div', {
        className: 'fiam-launcher-menu forge-iam-ui',
        role: 'dialog',
        'aria-label': '企业身份与控制台',
        onClick: (e) => e.stopPropagation(),
      },
        interactionStyle(),
        // Refined User Card Header
        h('div', { className: 'fiam-launcher-menu-header' },
          h('div', { className: 'fiam-launcher-menu-avatar' }, avatarInitial),
          h('div', { className: 'fiam-launcher-menu-userinfo' },
            h('div', { className: 'fiam-launcher-menu-username', title: principalName }, principalName),
            h('div', { className: 'fiam-launcher-menu-subtitle' },
              dotSvg(isSignedIn ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-tertiary)'),
              h('span', null, isSignedIn ? '企业认证有效' : '未登录企业账号'),
            ),
          ),
        ),
        // Grouped State Overview Section
        h('div', { className: 'fiam-launcher-card-section' },
          h('div', { className: 'fiam-launcher-menu-row' },
            h('span', { className: 'fiam-launcher-menu-label' }, '网关凭证'),
            h('span', {
              className: 'fiam-launcher-menu-value',
              style: {
                color: gwConfigured ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-warn-primary)',
                fontWeight: 600,
              },
            },
              gwConfigured ? '已就绪' : (GATEWAY_STATUS[gwState] ? gatewayLabel(gwState) : '未录入')
            ),
          ),
          isSignedIn ? h('div', { className: 'fiam-launcher-menu-row' },
            h('span', { className: 'fiam-launcher-menu-label' }, '企业模型'),
            h('span', {
              className: 'fiam-launcher-menu-value',
              style: models.failed ? { color: 'var(--dsw-alias-state-warn-primary)', fontWeight: 600 } : undefined,
            },
              models.models.length > 0
                ? (models.stale
                  ? `已缓存 ${models.models.length} 个模型（待刷新）`
                  : `已同步 ${models.models.length} 个模型`)
                : models.loading
                  ? '正在同步…'
                  : models.failed
                    ? '同步异常'
                    : (gwConfigured ? '企业模型已就绪' : '待配置凭证')
            ),
          ) : null,
          view?.gatewayCredential?.deviceLabel ? h('div', { className: 'fiam-launcher-menu-row' },
            h('span', { className: 'fiam-launcher-menu-label' }, '授权设备'),
            h('span', { className: 'fiam-launcher-menu-value' }, view.gatewayCredential.deviceLabel),
          ) : null,
        ),
        // Action List
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 } },
          h('button', {
            type: 'button',
            className: 'fiam-launcher-menu-item',
            onClick: () => {
              onClose();
              if (openSettings) openSettings();
            },
          }, settingsSvg, h('span', null, '进入企业设置')),
          h('button', {
            type: 'button',
            className: 'fiam-launcher-menu-item',
            onClick: onCopyDiagnostics,
          }, copySvg, h('span', null, '复制排障诊断信息')),
          isSignedIn ? h('button', {
            type: 'button',
            className: 'fiam-launcher-menu-item danger',
            disabled: signingOut,
            onClick: onSignOut,
          }, logoutSvg, h('span', null, confirmSignOut ? '确认退出登录？' : '退出当前账号')) : null,
        ),
        notice ? h('div', {
          role: 'status',
          'aria-live': 'polite',
          className: `fiam-notice ${/失败|无法|请/.test(notice) ? 'fiam-notice-warn' : 'fiam-notice-success'}`,
          style: { marginTop: 8, width: '100%', boxSizing: 'border-box', justifyContent: 'center' },
        }, notice) : null,
      );
    }

    function IamLauncher(props) {
      const { wide, settingsOpen, settingsShortcut, openSettings } = props;
      const [view, setView] = React.useState(null);
      const [menuOpen, setMenuOpen] = React.useState(false);
      const [notice, setNotice] = React.useState(null);
      const [confirmSignOut, setConfirmSignOut] = React.useState(false);
      const [signingOut, setSigningOut] = React.useState(false);
      const rootRef = React.useRef(null);
      const signingInRef = React.useRef(false);

      React.useEffect(() => {
        let live = true;
        fetchView()
          .then((v) => { if (live) setView(v); })
          .catch(() => { });
        return () => { live = false; };
      }, []);

      useSessionPoll(true, (nextView) => {
        setView(nextView);
        if (nextView?.state !== 'ready') {
          setMenuOpen(false);
          setConfirmSignOut(false);
        }
      });

      React.useEffect(() => {
        if (!menuOpen) return undefined;
        const onDocClick = (e) => {
          if (rootRef.current && !rootRef.current.contains(e.target)) {
            setMenuOpen(false);
            setConfirmSignOut(false);
          }
        };
        const onKey = (e) => {
          if (e.key === 'Escape') {
            setMenuOpen(false);
            setConfirmSignOut(false);
          }
        };
        document.addEventListener('mousedown', onDocClick);
        document.addEventListener('keydown', onKey);
        return () => {
          document.removeEventListener('mousedown', onDocClick);
          document.removeEventListener('keydown', onKey);
        };
      }, [menuOpen]);

      const status = getLauncherStatus(view);
      const isSignedIn = deriveSessionUi(view).ready;

      const handleMainClick = (e) => {
        e.stopPropagation();
        if (!isSignedIn) {
          if (signingInRef.current) return;
          signingInRef.current = true;
          const popup = openLoginWindow();
          postJson('/api/forge-iam/sign-in')
            .then((result) => {
              if (!result.ok) {
                try { popup?.close(); } catch { }
                return;
              }
              if (result.body?.view) setView(result.body.view);
              const authorizationUrl = result.body?.authorizationUrl ?? null;
              navigateLoginWindow(popup, authorizationUrl);
            })
            .catch(() => {
              try { popup?.close(); } catch { }
            })
            .finally(() => {
              signingInRef.current = false;
            });
          return;
        }
        setMenuOpen((current) => !current);
        setConfirmSignOut(false);
      };

      const onCopyDiagnostics = async (e) => {
        e?.stopPropagation();
        const payload = diagnosticSnapshot({ phase: 'ready', view });
        try {
          await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
          setNotice('脱敏诊断信息已复制');
          setTimeout(() => setNotice(null), 2500);
        } catch {
          setNotice('复制失败');
          setTimeout(() => setNotice(null), 2000);
        }
      };

      const onSignOut = async (e) => {
        e?.stopPropagation();
        if (!confirmSignOut) {
          setConfirmSignOut(true);
          return;
        }
        setSigningOut(true);
        try {
          const result = await postJson('/api/forge-iam/sign-out');
          if (result.ok) {
            setView(result.body?.view ?? null);
            setMenuOpen(false);
            setConfirmSignOut(false);
            // The catalogue cache is per person; a launcher sign-out is the
            // shortcut people use, so it must clear it exactly like the panel's.
            purgeModelCache();
          } else {
            setConfirmSignOut(false);
            setNotice(resultNotice(result));
            setTimeout(() => setNotice(null), 3000);
          }
        } catch {
          setConfirmSignOut(false);
          setNotice('暂时无法连接服务，请稍后重试。');
          setTimeout(() => setNotice(null), 3000);
        }
        finally {
          setSigningOut(false);
        }
      };

      const rootClassName = `fiam-launcher-root forge-iam-ui${wide ? '' : ' fiam-launcher-rail'}`;

      return h('div', {
        ref: rootRef,
        className: rootClassName,
      },
        interactionStyle(),
        h('button', {
          type: 'button',
          className: 'fiam-launcher-btn',
          title: status.tooltip,
          'aria-label': status.tooltip,
          'aria-haspopup': isSignedIn ? 'dialog' : undefined,
          'aria-expanded': isSignedIn ? menuOpen : undefined,
          onClick: handleMainClick,
        },
          h('div', { className: 'fiam-launcher-avatar-wrap' },
            h(IamShieldIcon, { size: wide ? 18 : 20, grayscale: !isSignedIn }),
            h('span', { className: `fiam-launcher-dot ${status.dotClass}` }),
          ),
          wide ? h('div', { className: 'fiam-launcher-details' },
            h('span', { className: 'fiam-launcher-title' }, isSignedIn ? (view.principal || view.subject || '企业账号') : '企业账号'),
            h('span', { className: 'fiam-launcher-subtitle' }, status.label),
          ) : null,
        ),
        wide ? h('button', {
          type: 'button',
          className: 'fiam-launcher-gear',
          'aria-label': '设置',
          'aria-keyshortcuts': settingsShortcut?.aria,
          'aria-haspopup': 'dialog',
          'aria-expanded': settingsOpen,
          onClick: (e) => {
            e.stopPropagation();
            if (openSettings) openSettings();
          },
        },
          h(GearIcon, { size: 16 }),
        ) : null,
        menuOpen ? h(IamLauncherMenu, {
          view,
          status,
          onCopyDiagnostics,
          onSignOut,
          confirmSignOut,
          signingOut,
          notice,
          openSettings,
          onClose: () => setMenuOpen(false),
        }) : null,
      );
    }

    // §16 未登录横幅与引导（16.1 横幅 / 16.2 步骤 / 16.3 流程）
    function SignedOutBanner() {
      const [state, setState] = React.useState({ visible: false, notice: null, view: null, authorizationUrl: null });
      const signingInRef = React.useRef(false);

      const bannerFor = (view) => {
        if (!view) return { visible: true, reason: 'signed-out', sessionState: null };
        const ui = deriveSessionUi(view);
        if (!ui.ready) return { visible: true, reason: 'signed-out', sessionState: ui.state };
        const gateway = deriveGatewayUi(view.gatewayCredential, 'unconfigured');
        return gateway.configured
          ? { visible: false, reason: null, gateway, sessionState: 'ready' }
          : { visible: true, reason: 'gateway', gateway, sessionState: 'ready' };
      };

      const SESSION_LABEL = {
        unconfigured: '企业登录尚未设置',
        expired: '登录已过期，请重新登录',
        unreachable: '暂时无法连接登录服务，现有授权保留至到期',
        error: '登录需要处理',
        authenticating: '等待浏览器登录完成',
      };

      React.useEffect(() => {
        let live = true;
        fetchView()
          .then((view) => { if (live) setState((current) => ({ ...current, ...bannerFor(view), view })); })
          .catch(() => {
            if (live) setState((current) => ({ ...current, visible: true, notice: '无法读取登录状态，正在重试。' }));
          });
        return () => { live = false; };
      }, []);

      // Observe for as long as the banner is mounted: display is derived from
      // the view, so keying the poll on `visible` would stop observing as soon
      // as a session becomes ready and never notice a later sign-out.
      useSessionPoll(true, (view) => setState((current) => ({
        ...current,
        view,
        ...bannerFor(view),
        ...(deriveSessionUi(view).authenticating ? {} : {
          authorizationUrl: null,
          ...(deriveSessionUi(current.view).authenticating
            ? { notice: deriveSessionUi(view).failed ? errorNotice(view.error ?? 'IAM_REQUEST_FAILED') : null }
            : {}),
        }),
      })));

      const login = async () => {
        if (signingInRef.current) return;
        signingInRef.current = true;
        const popup = openLoginWindow();
        try {
          const result = await postJson('/api/forge-iam/sign-in');
          if (!result.ok) {
            try { popup?.close(); } catch { /* already closed */ }
            setState((current) => ({ ...current, notice: resultNotice(result) }));
            return;
          }
          const view = result.body?.view;
          const authorizationUrl = result.body?.authorizationUrl ?? null;
          navigateLoginWindow(popup, authorizationUrl);
          setState((current) => ({
            ...current,
            ...bannerFor(view),
            view,
            authorizationUrl,
            notice: deriveSessionUi(view).authenticating
              ? (popup ? '浏览器已打开，等待登录完成。' : '浏览器被拦截，请使用下方链接继续。')
              : null,
          }));
        } catch {
          try { popup?.close(); } catch { /* already closed */ }
          setState((current) => ({ ...current, notice: '暂时无法连接服务，请稍后重试。' }));
        } finally {
          signingInRef.current = false;
        }
      };

      const cancelLogin = async () => {
        try {
          const result = await postJson('/api/forge-iam/cancel');
          if (!result.ok) {
            setState((current) => ({ ...current, notice: resultNotice(result) }));
            return;
          }
          const view = result.body?.view ?? null;
          setState((current) => ({ ...current, ...bannerFor(view), view, authorizationUrl: null, notice: null }));
        } catch {
          setState((current) => ({ ...current, notice: '暂时无法连接服务，请稍后重试。' }));
        }
      };

      if (!state.visible) return null;
      const dotColor = state.reason === 'gateway'
        ? 'var(--dsw-alias-state-warn-primary)'
        : state.sessionState === 'authenticating'
          ? 'var(--dsw-alias-state-business-primary)'
          : (state.sessionState === 'expired' || state.sessionState === 'error')
            ? 'var(--dsw-alias-state-error-primary)'
            : 'var(--dsw-alias-label-tertiary)';
      return h('div', {
        className: 'fiam-banner forge-iam-ui',
      },
        interactionStyle(),
        h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 500 } },
          h('span', {
            className: 'fiam-badge-dot',
            style: {
              background: dotColor,
              ...(state.sessionState === 'authenticating' ? { animation: 'fiam-pulse 1.4s ease-in-out infinite' } : {}),
            },
          }),
          state.reason === 'gateway'
            ? (state.gateway.ownerMismatch ? '个人访问凭证属于其他账号'
              : state.gateway.invalid ? '个人访问凭证信息需要检查，已保留'
                : state.gateway.unknown ? '无法确认个人访问凭证状态'
                  : '尚未保存个人访问凭证，请前往“设置 → 企业账号”添加。')
            : (SESSION_LABEL[state.sessionState] ?? '尚未登录企业账号'),
        ),
        state.reason === 'gateway'
          ? h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, state.gateway.ownerMismatch || state.gateway.invalid || state.gateway.unknown
            ? '到“设置 → 企业账号”核对现有记录'
            : '到“设置 → 企业账号”录入个人访问凭证')
          : null,
        state.reason !== 'gateway' && state.view?.canSignIn
          ? h('button', { type: 'button', className: 'forge-iam-primary', style: { ...primaryButton, minHeight: 26, height: 26, padding: '0 10px', fontSize: 12 }, onClick: login }, '登录')
          : null,
        deriveSessionUi(state.view).authenticating
          ? h('button', { type: 'button', style: { ...secondaryButton, minHeight: 26, height: 26, padding: '0 10px', fontSize: 12 }, onClick: cancelLogin }, '取消')
          : null,
        state.authorizationUrl
          ? h('a', { href: state.authorizationUrl, target: '_blank', rel: 'noreferrer', style: { fontSize: 12, fontWeight: 500 } }, '打开登录页')
          : null,
        state.notice ? h('span', { role: 'status', 'aria-live': 'polite', style: { color: 'var(--dsw-alias-state-warn-primary)', fontSize: 12 } }, state.notice) : null,
      );
    }

    // §16.2 引导步骤详情
    function renderOnboardingStepDetail(ctx) {
      const { h, state, setState } = ctx;
      if (state.step === 0) {
        return h('div', { className: 'fiam-onboarding-preview' },
          h('div', { className: 'fiam-onboarding-preview-row' },
            h('span', { className: 'fiam-onboarding-preview-num' }, '1'),
            h('span', null, '在浏览器中登录企业账号'),
          ),
          h('div', { className: 'fiam-onboarding-preview-row' },
            h('span', { className: 'fiam-onboarding-preview-num' }, '2'),
            h('span', null, '添加个人访问凭证'),
          ),
          h('div', { className: 'fiam-onboarding-preview-row' },
            h('span', { className: 'fiam-onboarding-preview-num' }, '3'),
            h('span', null, '同步可用模型并开始对话'),
          ),
        );
      }
      if (state.step === 1) {
        return h('div', { style: { marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 } },
          h('div', { className: 'fiam-callout', style: { marginTop: 0 } },
            h('svg', { className: 'fiam-callout-icon', viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 },
              h('path', { d: 'M8 1.5s5 2 5 5.8c0 3.8-2.9 6.3-5 7.7-2.1-1.4-5-3.9-5-7.7 0-3.8 5-5.8 5-5.8Z' }),
              h('path', { d: 'm6 8.2 1.5 1.5 3-3' })
            ),
            h('span', null, '授权全程在系统默认安全浏览器中进行，DeepSeek Harness 不收集或存储您的企业账号密码。'),
          ),
          deriveSessionUi(state.view).authenticating
            ? h('div', { className: 'fiam-auth-progress', role: 'status', 'aria-live': 'polite' },
              h('div', { style: { display: 'inline-flex', alignItems: 'center', gap: 8 } },
                h('div', { className: 'fiam-spinner', style: { width: 16, height: 16 } }),
                h('span', null, '正在等待浏览器完成企业身份授权…'),
              )
            )
            : null,
        );
      }
      if (state.step === 3) {
        const gatewayUi = deriveGatewayUi(state.view?.gatewayCredential);
      const gwState = gatewayUi.state;
        const models = state.view?.modelAccess?.models ?? [];
        return h('div', { style: { marginTop: 14, display: 'flex', flexDirection: 'column', gap: 12 } },
          h('div', { className: 'fiam-onboarding-summary' },
            h('div', { className: 'fiam-onboarding-summary-row' },
              h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, '企业身份认证'),
              h('span', { className: `fiam-badge fiam-badge-${deriveSessionUi(state.view).ready ? 'success' : 'warn'}` },
                deriveSessionUi(state.view).ready ? (state.view.principal || '已认证') : '待登录'
              ),
            ),
            h('div', { className: 'fiam-onboarding-summary-row' },
              h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, '个人访问凭证'),
              h('span', { className: `fiam-badge fiam-badge-${gatewayUi.configured ? 'success' : 'warn'}` },
                gatewayLabel(gwState, '待核实')
              ),
            ),
          ),
          gatewayUi.configured && deriveModelUi(state.view).loading
            ? h('div', { className: 'fiam-auth-progress', role: 'status', 'aria-live': 'polite' },
              h('div', { style: { display: 'inline-flex', alignItems: 'center', gap: 8 } },
                h('div', { className: 'fiam-spinner', style: { width: 16, height: 16 } }),
                h('span', null, '正在同步企业网关可用模型…'),
              )
            )
            : null,
          gatewayUi.configured && deriveModelUi(state.view).error
            ? h('div', { role: 'status', className: 'fiam-notice fiam-notice-warn' }, errorNotice(deriveModelUi(state.view).error))
            : null,
          models.length > 0
            ? h('div', null,
              h('div', { style: { fontSize: 13, fontWeight: 500, marginBottom: 8, color: 'var(--dsw-alias-label-primary)' } },
                `已连接企业网关可用模型（共 ${models.length} 个）：`),
              h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 160, overflowY: 'auto' } },
                ...[...models]
                  .sort((a, b) => String(a?.id ?? '').localeCompare(String(b?.id ?? ''), 'en', { numeric: true, sensitivity: 'base' }))
                  .map((m) => h('span', { key: m.id, className: 'fiam-badge fiam-badge-success' }, m.name || m.id))
              )
            )
            : null,
        );
      }
      if (state.step === 2) {
        return h('div', { style: { marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12 } },
          h('label', { style: fieldLabel },
            h('span', { style: { fontWeight: 500 } }, '网关地址'),
            h('input', {
              type: 'url', 'aria-label': '网关地址', autoComplete: 'off',
              value: state.baseURL ?? state.view?.gatewayCredential?.baseURL ?? state.view?.modelAccess?.baseURL ?? '',
              placeholder: 'https://gateway.example/v1', disabled: state.saving,
              onChange: (event) => setState((current) => ({ ...current, baseURL: event.target.value })), style: inputStyle,
            }),
          ),
          h('label', { style: fieldLabel }, '个人访问凭证', h('input', {
            type: 'password',
            value: state.keyValue,
            placeholder: '输入网关提供的个人访问凭证',
            'aria-label': '个人访问凭证',
            autoComplete: 'off',
            spellCheck: false,
            disabled: state.saving,
            onChange: (event) => setState((current) => ({ ...current, keyValue: event.target.value })),
            style: inputStyle,
          })),
          h('label', { style: fieldLabel }, '设备标签（可选）', h('input', {
            type: 'text',
            value: state.deviceLabel,
            placeholder: '设备标签（可选，例如 工作站-01）',
            'aria-label': '设备标签',
            maxLength: 64,
            disabled: state.saving,
            onChange: (event) => setState((current) => ({ ...current, deviceLabel: event.target.value })),
            style: inputStyle,
          })),
          state.view?.gatewayConsoleUrl
            ? h('a', { href: state.view.gatewayConsoleUrl, target: '_blank', rel: 'noreferrer' }, '前往企业 AI 网关创建凭证')
            : null,
          h('div', { style: { color: 'var(--dsw-alias-label-secondary)', font: 'var(--dsw-font-xxs-12)' } }, '创建时建议开启隐私保护，并设置 90 天有效期。'),
        );
      }
      return null;
    }

    // §16.3 引导流程
    function Onboarding() {
      const [state, setState] = React.useState({
        phase: 'loading', view: null, step: 0, notice: null, open: false,
        authorizationUrl: null, keyValue: '', deviceLabel: '', saving: false,
      });
      const savingRef = React.useRef(false);
      const signingInRef = React.useRef(false);

      const close = async (marker) => {
        if (savingRef.current) return;
        try { await postJson('/api/forge-iam/cancel'); } catch { /* best effort */ }
        if (marker) writeMarker(marker);
        setState((current) => ({ ...current, open: false }));
      };
      const dialogRef = React.useRef(null);

      React.useEffect(() => {
        if (!state.open) return undefined;
        const node = dialogRef.current;
        node?.focus();
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            close('skipped');
            return;
          }
          if (event.key !== 'Tab' || !node) return;
          const focusable = [...node.querySelectorAll('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
            .filter((element) => !element.disabled);
          if (focusable.length === 0) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && (document.activeElement === first || document.activeElement === node)) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [state.open, state.step, deriveSessionUi(state.view).state]);

      React.useEffect(() => {
        let live = true;
        let timer = null;
        const marker = readMarker();
        if (marker === 'done' || marker === 'skipped') return () => { live = false; };
        const attempt = () => {
          fetchView()
            .then((view) => {
              if (!live) return;
              setState((current) => ({ ...current, phase: 'ready', view, step: 0, notice: null, open: deriveSessionUi(view).signedOut, authorizationUrl: null }));
            })
            .catch(() => {
              if (!live) return;
              // A transient failure at first paint must not silently disable
              // onboarding (and its completion marker) for the whole page load.
              setState((current) => ({ ...current, phase: 'ready' }));
              timer = setTimeout(attempt, 3000);
            });
        };
        attempt();
        return () => { live = false; if (timer) clearTimeout(timer); };
      }, []);

      useSessionPoll(true, (view) => setState((current) => (!current.open ? current : {
        ...current,
        view,
        ...(deriveSessionUi(view).authenticating ? {} : { authorizationUrl: null }),
        // Advance to the success step once, then keep the user's final screen:
        // a later identical `ready` poll must not pull them back from "完成".
        // Advance into the credential step once. When this account already has a
        // matching key, skip straight to "完成"; a later identical poll must not
        // pull the user back out of the final screen.
        ...(deriveSessionUi(view).ready && current.step < 2
          ? { step: deriveGatewayUi(view.gatewayCredential).configured ? 3 : 2, authorizationUrl: null, notice: null }
          : {}),
        ...(current.step === 2 && !deriveSessionUi(view).ready
          ? { step: 1, authorizationUrl: null, notice: deriveSessionUi(view).failed ? errorNotice(view.error ?? 'IAM_REQUEST_FAILED') : '登录状态已变化，请重新登录企业账号。' }
          : {}),
        ...(deriveSessionUi(view).failed ? { notice: errorNotice(view.error ?? 'IAM_REQUEST_FAILED') } : {}),
      })));

      if (!state.open) return null;

      const startLogin = async () => {
        if (signingInRef.current) return;
        signingInRef.current = true;
        const popup = openLoginWindow();
        try {
          const result = await postJson('/api/forge-iam/sign-in');
          if (!result.ok) {
            try { popup?.close(); } catch { /* already closed */ }
            setState((current) => ({ ...current, notice: resultNotice(result) }));
            return;
          }
          const view = result.body?.view;
          navigateLoginWindow(popup, result.body?.authorizationUrl);
          setState((current) => ({
            ...current,
            view,
            step: deriveSessionUi(view).ready
              ? (deriveGatewayUi(view.gatewayCredential).configured ? 3 : 2)
              : current.step,
            authorizationUrl: result.body?.authorizationUrl,
            notice: deriveSessionUi(view).ready ? null : '浏览器已打开；若被拦截，请使用下方链接。',
          }));
        } catch {
          try { popup?.close(); } catch { /* already closed */ }
          setState((current) => ({ ...current, notice: '暂时无法连接服务，请稍后重试。' }));
        } finally {
          signingInRef.current = false;
        }
      };

      const saveCredential = async () => {
        if (savingRef.current) return;
        const value = state.keyValue.trim();
        if (!value) {
          setState((current) => ({ ...current, notice: '请输入个人访问凭证。' }));
          return;
        }
        savingRef.current = true;
        setState((current) => ({ ...current, saving: true, notice: null }));
        try {
          const result = await putJson('/api/forge-iam/credential', {
            key: value,
            baseURL: (state.baseURL ?? state.view?.gatewayCredential?.baseURL ?? state.view?.modelAccess?.baseURL ?? '').trim(),
            deviceLabel: state.deviceLabel.trim(),
          });
          if (!result.ok) {
            setState((current) => ({
              ...current,
              saving: false,
              notice: resultNotice(result),
            }));
            return;
          }
          // Do not keep the pasted value in component state once stored.
          setState((current) => ({
            ...current,
            saving: false,
            keyValue: '',
            view: result.body?.view ?? current.view,
            step: 3,
            notice: null,
          }));
          void getJson('/api/forge-iam/models').then((m) => {
            if (m.ok && m.body?.view) {
              setState((current) => ({ ...current, view: m.body.view }));
            }
          }).catch(() => { });
        } catch {
          setState((current) => ({ ...current, saving: false, notice: '暂时无法连接服务，请稍后重试。' }));
        } finally {
          savingRef.current = false;
        }
      };

      const gatewayUi = deriveGatewayUi(state.view?.gatewayCredential);
      const gatewayState = gatewayUi.state;
      const completionTitle = gatewayUi.configured
        ? (deriveSessionUi(state.view).ready ? '准备就绪' : '请先登录企业账号')
        : gatewayUi.unconfigured
          ? (deriveSessionUi(state.view).ready ? '登录完成，尚未配置凭据' : '尚未保存个人访问凭证')
          : '请检查凭证状态';
      const completionBody = gatewayUi.configured
        ? (deriveSessionUi(state.view).ready
          ? '个人访问凭证已保存。可在“设置 → 企业账号”中查看状态、更换或清除。模型能否使用仍取决于你的权限。'
          : '个人访问凭证已保存。请前往“设置 → 企业账号”登录后继续。')
        : gatewayUi.unconfigured
          ? '个人访问凭证尚未保存，模型暂不可用。可稍后前往“设置 → 企业账号”登录并配置凭证。'
          : gatewayUi.ownerMismatch
            ? '现有凭证属于其他账号，已为你保留。请前往“设置 → 企业账号”核对。'
            : gatewayUi.invalid
              ? '现有凭证信息需要检查，已为你保留。请前往“设置 → 企业账号”核对。'
              : '无法确认凭证是否已保存。请前往“设置 → 企业账号”刷新后查看。';
      const steps = [
        {
          title: '欢迎使用企业版',
          body: '登录企业账号并完成配置后，即可使用已授权的模型和工具。也可以先跳过，稍后在“设置 → 企业账号”中登录。',
          primary: '开始',
          onPrimary: () => setState((current) => ({ ...current, step: 1 })),
        },
        {
          title: '登录企业账号',
          body: '使用系统浏览器完成企业登录，不在应用内输入密码。',
          primary: '登录',
          onPrimary: startLogin,
        },
        {
          title: '添加个人访问凭证',
          body: '在企业 AI 网关创建个人访问凭证，然后粘贴到下方。',
          primary: '保存并继续',
          onPrimary: saveCredential,
        },
        {
          title: completionTitle,
          body: completionBody,
          primary: '完成',
          // Without a configured credential the model is not usable; record the
          // skip rather than claiming onboarding completed.
          onPrimary: () => close(deriveSessionUi(state.view).ready && gatewayUi.configured ? 'done' : 'skipped'),
        },
      ];
      const step = steps[state.step] ?? steps[0];
      const overlay = {
        position: 'fixed', inset: 0, zIndex: 1000, background: 'var(--dsw-alias-bg-mask-1)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
        // shell.overlay is click-through; an interactive surface must opt back
        // into pointer events or every click falls through to the app below.
        pointerEvents: 'auto',
      };
      const card = {
        boxSizing: 'border-box', width: 'min(520px, 100%)', maxHeight: 'calc(100vh - 48px)', overflowY: 'auto',
        background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 'var(--dsw-radius-lg)', padding: 28,
        boxShadow: 'var(--dsw-elevation-panel)', font: 'var(--dsw-font-s-14)',
      };

      return h('div', { className: 'forge-iam-ui', style: overlay, role: 'presentation' }, interactionStyle(),
        h('div', { ref: dialogRef, tabIndex: -1, style: card, role: 'dialog', 'aria-modal': 'true', 'aria-label': step.title },
          h('div', { className: 'fiam-onboarding-header' },
            h('div', { className: 'fiam-onboarding-brand' },
              h(IamShieldIcon, { size: 18 }),
              h('span', null, '企业统一身份与网关向导'),
            ),
            h('span', { className: 'fiam-badge fiam-badge-authenticating' }, `步骤 ${state.step + 1} / 4`),
          ),
          h('div', { className: 'fiam-onboarding-stepper', 'aria-hidden': 'true' },
            ...['欢迎', '登录', '凭据', '完成'].map((label, index) => {
              const stateCls = index < state.step ? 'done' : (index === state.step ? 'active' : '');
              return h('div', { key: label, className: 'fiam-onboarding-step-item' },
                h('div', { className: `fiam-onboarding-step-bar ${stateCls}` }),
                h('span', { className: `fiam-onboarding-step-label ${stateCls}` }, `${index + 1}. ${label}`),
              );
            })
          ),
          h('h2', { style: { margin: '0 0 10px', font: 'var(--dsw-font-l-20)' } }, step.title),
          h('p', { style: { margin: 0, color: 'var(--dsw-alias-label-secondary)', maxWidth: '42em' } }, step.body),
          renderOnboardingStepDetail({ h, state, setState }),
          state.notice ? h('p', { role: 'status', 'aria-live': 'polite', style: { margin: '12px 0 0', color: 'var(--dsw-alias-state-warn-primary)' } }, state.notice) : null,
          state.authorizationUrl ? h('p', { style: { marginTop: 10 } }, h('a', { href: state.authorizationUrl, target: '_blank', rel: 'noreferrer' }, '浏览器未打开？点此继续登录')) : null,
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 24 } },
            h('button', { type: 'button', className: 'forge-iam-primary', style: primaryButton, disabled: state.saving, onClick: step.onPrimary }, state.saving ? '正在保存…' : step.primary),
            state.step < 3
              ? h('button', {
                type: 'button', style: secondaryButton, disabled: state.saving, onClick: () => {
                  if (savingRef.current) return;
                  return state.step === 2
                    ? setState((current) => ({ ...current, step: 3, notice: null }))
                    : close('skipped');
                }
              }, state.step === 2 ? '稍后配置' : '跳过')
              : null,
          ),
        ),
      );
    }

    // §17 出口（inject / apply）
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.launcher', () => ctx.slots.register({
          name: 'settings.launcher',
          id: 'forge-iam-launcher',
        }, IamLauncher));
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'forge-iam',
          order: 30,
          label: () => '企业账号',
        }, Panel));
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'forge-iam-banner',
        }, SignedOutBanner));
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'forge-iam-onboarding',
        }, Onboarding));
      },
    };
  },
});
