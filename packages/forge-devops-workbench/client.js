/**
 * `@heluo/forge-devops-workbench` — Browser 单文件客户端插件（CORP-DSH-ENG-003 P1–P9）。
 *
 * 严格约束：
 *   1. 零相对 ESM import/export，零内置 Mock，仅通过 require('react') 获取宿主 React；
 *   2. 点击左侧 sidebar.footer.action 时优先 openTab('forge-devops-workbench') 打开右侧多页签，
 *      基线宿主不支持或无当前会话时优雅降级为 shell.overlay 抽屉；
 *   3. 取消分队切换下拉框，顶栏仅保留只读端点提示（仅回环）、待办[N]▾ 与 定制；
 *   4. 一期卡片动作只生成工程提示词，二次确认后填入草稿箱或剪贴板，绝不调用 send()/submit()。
 */
window.__ModuleLoader__.load({
  id: '@heluo/forge-devops-workbench',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback, useMemo } = React;

    // §1 Constants & Styles
    const PLUGIN_ID = '@heluo/forge-devops-workbench';
    const TAB_KIND = 'forge-devops-workbench';
    const NS = 'forgeDevopsWorkbench';
    const STYLE_ID = 'heluo-forge-devops-workbench-style';
    const API_PREFIX = '/api/forge-devops-workbench';
    const REQUEST_HEADER = 'x-forge-workbench-request';

    const CSS = `
.heluo-wb-root{
  --wb-bg:#FAFBFD;--wb-surface:#FFFFFF;--wb-sub-bg:#F7F9FC;--wb-sub-border:#EAEEF5;
  --wb-blue:#3B6CF5;--wb-blue-hover:#2C5BE0;--wb-blue-soft:#EFF4FF;--wb-blue-border:#C7D7FE;
  --wb-text:#111827;--wb-text-sub:#374151;--wb-text-muted:#6B7280;--wb-text-light:#9CA3AF;
  --wb-border:#E2E8F0;--wb-border-soft:#EEF2F6;
  --wb-green:#059669;--wb-green-soft:#ECFDF5;--wb-green-border:#A7F3D0;
  --wb-amber:#D97706;--wb-amber-soft:#FFFBEB;--wb-amber-border:#FDE68A;
  --wb-red:#DC2626;--wb-red-soft:#FEF2F2;--wb-red-border:#FECACA;
  --wb-purple:#6D28D9;--wb-purple-soft:#F5F3FF;--wb-purple-border:#DDD6FE;
  --wb-mono:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;
  box-sizing:border-box;display:flex;flex-direction:column;height:100%;overflow:hidden;
  background:var(--wb-bg);color:var(--wb-text);
  font:13px/1.45 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Segoe UI",Roboto,sans-serif;
}
.heluo-wb-root *,.heluo-wb-root *::before,.heluo-wb-root *::after{box-sizing:border-box}
.heluo-wb-topbar{
  height:48px;padding:0 12px;background:var(--wb-surface);border-bottom:1px solid var(--wb-border);
  display:flex;align-items:center;justify-content:space-between;gap:8px;flex-shrink:0;position:relative;z-index:40;
}
.heluo-wb-top-left{display:flex;align-items:center;gap:7px;min-width:0;flex:1}
.heluo-wb-top-right{display:flex;align-items:center;gap:5px;flex-shrink:0}
.heluo-wb-todo-wrap{position:relative;flex-shrink:0}
.heluo-wb-todo-capsule{
  height:30px;padding:0 9px;border-radius:9px;border:1px solid #FECACA;background:#FEF2F2;color:#991B1B;
  font-size:12.5px;font-weight:600;display:inline-flex;align-items:center;gap:5px;cursor:pointer;transition:all .14s;white-space:nowrap;
}
.heluo-wb-todo-capsule:hover,.heluo-wb-todo-capsule.open{background:#FEE2E2;border-color:#FCA5A5}
.heluo-wb-todo-badge{
  background:#DC2626;color:#FFFFFF;font-family:var(--wb-mono);font-size:11px;font-weight:700;
  padding:0 6px;height:17px;line-height:17px;border-radius:99px;
}
.heluo-wb-badge-local{
  display:inline-flex;align-items:center;height:22px;padding:0 7px;border-radius:99px;font-size:11px;font-weight:600;
  background:var(--wb-amber-soft);color:var(--wb-amber);border:1px solid var(--wb-amber-border);white-space:nowrap;
}
.heluo-wb-todo-pop{
  position:absolute;top:calc(100% + 7px);left:0;width:min(324px,calc(100vw - 32px));max-height:70vh;overflow-y:auto;
  background:#FFFFFF;border:1px solid var(--wb-border);border-radius:13px;
  box-shadow:0 14px 36px rgba(15,23,42,.13),0 2px 8px rgba(15,23,42,.05);z-index:150;
}
.heluo-wb-todo-head{
  padding:9px 12px;background:#F8FAFC;border-bottom:1px solid var(--wb-border);
  display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;font-weight:600;color:var(--wb-text-sub);
}
.heluo-wb-todo-list{padding:6px;display:flex;flex-direction:column;gap:4px}
.heluo-wb-todo-row{
  padding:7px 9px;border-radius:8px;display:flex;flex-direction:column;gap:4px;transition:background .13s;
}
.heluo-wb-todo-row:hover{background:var(--wb-blue-soft)}
.heluo-wb-todo-row-top{display:flex;align-items:center;justify-content:space-between;gap:6px;font-size:12.5px;font-weight:600;color:var(--wb-text)}
.heluo-wb-todo-num{font-family:var(--wb-mono);font-size:11.5px;font-weight:700;padding:1px 7px;border-radius:99px}
.heluo-wb-todo-num.has{background:#FEE2E2;color:#DC2626}
.heluo-wb-todo-num.zero{background:#F1F5F9;color:#94A3B8}
.heluo-wb-todo-sub{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11.5px;color:var(--wb-text-muted);padding-left:2px}
.heluo-wb-custom-btn{
  height:29px;padding:0 9px;border-radius:8px;border:1px solid var(--wb-border);background:#FFFFFF;
  color:var(--wb-text-sub);font-size:12px;font-weight:600;display:inline-flex;align-items:center;gap:4px;cursor:pointer;transition:all .14s;white-space:nowrap;
}
.heluo-wb-custom-btn:hover{border-color:var(--wb-blue-border);background:var(--wb-blue-soft);color:var(--wb-blue)}
.heluo-wb-icon-btn{
  width:29px;height:29px;border-radius:8px;border:1px solid var(--wb-border);background:#FFFFFF;color:var(--wb-text-muted);
  font-size:13px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;transition:all .14s;
}
.heluo-wb-icon-btn:hover:not(:disabled){border-color:var(--wb-blue-border);background:var(--wb-blue-soft);color:var(--wb-blue)}
.heluo-wb-icon-btn:disabled{opacity:.5;cursor:not-allowed}
.heluo-wb-banner{
  margin:8px 12px 0;padding:7px 10px;border-radius:9px;font-size:12px;line-height:1.45;
  border:1px solid var(--wb-border);background:#F8FAFC;color:var(--wb-text-sub);
  display:flex;justify-content:space-between;align-items:center;gap:8px;flex-shrink:0;
}
.heluo-wb-banner-warn{background:var(--wb-amber-soft);border-color:var(--wb-amber-border);color:#92400E}
.heluo-wb-banner-err{background:var(--wb-red-soft);border-color:var(--wb-red-border);color:#991B1B}
.heluo-wb-prog-sec{padding:10px 12px 9px;background:#FFFFFF;border-bottom:1px solid var(--wb-border);flex-shrink:0}
.heluo-wb-prog-card{background:var(--wb-sub-bg);border:1px solid var(--wb-sub-border);border-radius:12px;padding:9px 11px 11px}
.heluo-wb-prog-head{display:flex;align-items:center;justify-content:space-between;gap:6px}
.heluo-wb-prog-pills{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.heluo-wb-prog-pill{
  height:25px;padding:0 9px;border-radius:7px;border:none;background:transparent;color:var(--wb-text-muted);
  font-size:12px;font-weight:600;cursor:pointer;transition:all .14s ease;white-space:nowrap;
}
.heluo-wb-prog-pill:hover{background:#EBF1FF;color:var(--wb-text)}
.heluo-wb-prog-pill.active{background:var(--wb-blue);color:#FFFFFF;box-shadow:0 2px 6px rgba(59,108,245,.24)}
.heluo-wb-prog-collapse{
  height:24px;padding:0 7px;border-radius:6px;border:none;background:transparent;color:var(--wb-text-muted);
  font-size:11.5px;cursor:pointer;white-space:nowrap;
}
.heluo-wb-prog-collapse:hover{background:#EAEFF7;color:var(--wb-text)}
.heluo-wb-prog-body{margin-top:8px;padding-top:8px;border-top:1px solid #E8EDF5;display:flex;flex-direction:column;gap:9px}
.heluo-wb-prog-sub{display:flex;align-items:center;justify-content:space-between;gap:6px;font-size:11.5px;color:var(--wb-text-muted)}
.heluo-wb-seg{display:inline-flex;background:#E9EEF6;padding:2px;border-radius:7px;gap:2px}
.heluo-wb-seg-btn{
  height:20px;padding:0 8px;border-radius:5px;border:none;background:transparent;color:var(--wb-text-muted);
  font-size:11px;font-weight:500;cursor:pointer;transition:all .13s;white-space:nowrap;
}
.heluo-wb-seg-btn.active{background:#FFFFFF;color:var(--wb-blue);font-weight:700;box-shadow:0 1px 2px rgba(15,23,42,.08)}
.heluo-wb-kpi-4{display:grid;grid-template-columns:repeat(4,1fr);gap:4px}
.heluo-wb-kpi-lite{border-radius:8px;padding:5px 4px;display:flex;flex-direction:column;align-items:center;transition:all .14s ease}
.heluo-wb-kpi-lite:hover{background:rgba(59,108,245,.07);transform:translateY(-1px)}
.heluo-wb-kpi-lite.danger:hover{background:rgba(220,38,38,.07)}
.heluo-wb-kpi-top{display:inline-flex;align-items:center;gap:4px}
.heluo-wb-kpi-val{font-family:var(--wb-mono);font-size:14px;font-weight:800;color:var(--wb-text);line-height:1.2}
.heluo-wb-kpi-lite.danger .heluo-wb-kpi-val{color:var(--wb-red)}
.heluo-wb-kpi-lbl{font-size:10.5px;color:var(--wb-text-muted);margin-top:2px;white-space:nowrap}
.heluo-wb-sym-u{display:flex;align-items:stretch;gap:8px;padding:2px 0}
.heluo-wb-inprog-pill{
  width:50px;flex-shrink:0;background:#EBF2FF;border-radius:10px;display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:2px;transition:all .14s ease;
}
.heluo-wb-inprog-pill:hover{background:var(--wb-blue);box-shadow:0 3px 10px rgba(59,108,245,.25)}
.heluo-wb-inprog-pill:hover .heluo-wb-inprog-num,.heluo-wb-inprog-pill:hover .heluo-wb-inprog-txt{color:#FFFFFF}
.heluo-wb-inprog-num{font-family:var(--wb-mono);font-size:15px;font-weight:800;color:var(--wb-blue);line-height:1.15}
.heluo-wb-inprog-txt{font-size:10.5px;font-weight:600;color:var(--wb-blue)}
.heluo-wb-u-212{
  flex:1;min-width:0;position:relative;display:grid;grid-template-columns:1fr 1fr 78px;grid-template-rows:1fr 1fr;
  gap:10px 8px;align-items:center;padding:2px 4px;
}
.heluo-wb-u-414{
  width:100%;position:relative;display:grid;grid-template-columns:repeat(4,1fr) 64px;grid-template-rows:1fr 1fr;
  gap:10px 4px;align-items:center;padding:2px 0;
}
.heluo-wb-u-rail{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:0}
.heluo-wb-u-node{
  position:relative;z-index:1;border-radius:8px;padding:4px 10px;width:fit-content;min-width:68px;justify-self:center;
  background:#F7F9FC;display:flex;flex-direction:column;align-items:center;justify-content:center;transition:all .14s ease;
}
.heluo-wb-u-414 .heluo-wb-u-node{min-width:54px;padding:4px 6px}
.heluo-wb-u-node.lit{background:#EBF2FF;box-shadow:0 2px 6px rgba(59,108,245,.12)}
.heluo-wb-u-node:hover{background:#E1ECFF;transform:translateY(-1px)}
.heluo-wb-u-node-top{display:inline-flex;align-items:center;gap:3px}
.heluo-wb-u-node-num{font-family:var(--wb-mono);font-size:13px;font-weight:800;color:#94A3B8;line-height:1.15}
.heluo-wb-u-node.lit .heluo-wb-u-node-num{color:var(--wb-blue)}
.heluo-wb-u-node-name{font-size:10px;color:var(--wb-text-muted);white-space:nowrap;margin-top:2px}
.heluo-wb-u-node.lit .heluo-wb-u-node-name{color:var(--wb-text);font-weight:600}
.heluo-wb-impl-lbl{font-size:11px;font-weight:600;color:var(--wb-text-muted);margin-bottom:5px;display:flex;align-items:center;justify-content:space-between}
.heluo-wb-rail-5{display:grid;grid-template-columns:repeat(5,1fr);gap:4px}
.heluo-wb-rail-tile{border-radius:8px;padding:5px 2px;display:flex;flex-direction:column;align-items:center;transition:all .14s ease}
.heluo-wb-rail-tile.lit{background:#EBF2FF}
.heluo-wb-rail-tile.lit-warn{background:#FEF2F2}
.heluo-wb-rail-tile:hover{background:#E1ECFF;transform:translateY(-1px)}
.heluo-wb-rail-top{display:inline-flex;align-items:center;gap:3px}
.heluo-wb-rail-num{font-family:var(--wb-mono);font-size:13.5px;font-weight:800;color:#94A3B8;line-height:1.15}
.heluo-wb-rail-tile.lit .heluo-wb-rail-num{color:var(--wb-blue)}
.heluo-wb-rail-tile.lit-warn .heluo-wb-rail-num{color:var(--wb-red)}
.heluo-wb-rail-lbl{font-size:10px;color:var(--wb-text-muted);margin-top:2px;white-space:nowrap}
.heluo-wb-rail-tile.lit .heluo-wb-rail-lbl,.heluo-wb-rail-tile.lit-warn .heluo-wb-rail-lbl{color:var(--wb-text);font-weight:600}
.heluo-wb-hbar{width:100%;height:6px;border-radius:99px;background:#E2E8F0;overflow:hidden;display:flex;gap:1.5px;margin-bottom:6px}
.heluo-wb-hb-seg{height:100%;transition:width .25s ease}
.heluo-wb-hlegend-4{display:grid;grid-template-columns:repeat(4,1fr);gap:3px}
.heluo-wb-hl-item{border-radius:7px;padding:3px 2px;display:flex;flex-direction:column;align-items:center}
.heluo-wb-hl-top{display:inline-flex;align-items:center;gap:4px}
.heluo-wb-hl-dot{width:7px;height:7px;border-radius:99px;flex-shrink:0}
.heluo-wb-hl-num{font-family:var(--wb-mono);font-size:13px;font-weight:800;color:var(--wb-text);line-height:1.15}
.heluo-wb-hl-lbl{font-size:10px;color:var(--wb-text-muted);margin-top:1px;white-space:nowrap}
.heluo-wb-tabs{display:flex;align-items:center;background:#FFFFFF;border-bottom:1px solid var(--wb-border);padding:0 8px;flex-shrink:0}
.heluo-wb-tab{
  flex:1;height:36px;border:none;background:transparent;color:var(--wb-text-muted);font-size:13px;font-weight:500;
  cursor:pointer;position:relative;transition:color .14s;white-space:nowrap;
}
.heluo-wb-tab:hover{color:var(--wb-text)}
.heluo-wb-tab.active{color:var(--wb-blue);font-weight:700}
.heluo-wb-tab.active::after{
  content:"";position:absolute;left:10px;right:10px;bottom:0;height:2px;background:var(--wb-blue);border-radius:2px;
}
.heluo-wb-body{flex:1;min-height:0;overflow-y:auto;padding:11px 12px 18px;display:flex;flex-direction:column;gap:9px}
.heluo-wb-quick-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px}
.heluo-wb-quick-btn{
  height:34px;border-radius:9px;border:1px solid var(--wb-blue-border);background:var(--wb-blue-soft);color:var(--wb-blue);
  font-size:12.5px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:4px;transition:all .14s;
}
.heluo-wb-quick-btn:hover{background:var(--wb-blue);color:#FFFFFF}
.heluo-wb-subtabs{display:flex;background:#EEF2F6;padding:3px;border-radius:8px;gap:3px}
.heluo-wb-subtab{
  flex:1;height:26px;border-radius:6px;border:none;background:transparent;color:var(--wb-text-muted);
  font-size:12px;font-weight:500;cursor:pointer;transition:all .14s;white-space:nowrap;
}
.heluo-wb-subtab.active{background:#FFFFFF;color:var(--wb-text);font-weight:600;box-shadow:0 1px 2px rgba(15,23,42,.06)}
.heluo-wb-filter-bar{display:flex;flex-direction:column;gap:6px}
.heluo-wb-search-row{display:flex;gap:6px;align-items:center}
.heluo-wb-item{
  background:#FFFFFF;border:1px solid var(--wb-border);border-radius:10px;padding:10px 11px;
  display:flex;flex-direction:column;gap:6px;transition:all .15s ease;
}
.heluo-wb-item:hover{border-color:#CBD5E1;box-shadow:0 3px 10px rgba(15,23,42,.04)}
.heluo-wb-item-top{display:flex;align-items:center;justify-content:space-between;gap:6px}
.heluo-wb-item-code{font-family:var(--wb-mono);font-size:11.5px;font-weight:700;color:var(--wb-blue)}
.heluo-wb-item-title{font-size:13px;font-weight:600;color:var(--wb-text);line-height:1.4;word-break:break-word}
.heluo-wb-item-meta{display:flex;flex-wrap:wrap;gap:5px;font-size:11.5px;color:var(--wb-text-muted)}
.heluo-wb-item-actions{
  padding-top:7px;border-top:1px dashed #EEF2F6;display:flex;flex-wrap:wrap;align-items:center;gap:6px;
}
.heluo-wb-sso-link{
  margin-left:auto;height:25px;padding:0 7px;border-radius:6px;border:none;background:transparent;
  color:var(--wb-text-muted);font-size:11.5px;font-weight:500;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;
}
.heluo-wb-sso-link:hover{background:#F1F5F9;color:var(--wb-blue)}
.heluo-wb-tag{font-size:11px;font-weight:500;padding:1.5px 6px;border-radius:5px;display:inline-flex;align-items:center;white-space:nowrap}
.heluo-wb-tag-gray{background:#F1F5F9;color:#475569}
.heluo-wb-tag-blue{background:var(--wb-blue-soft);color:var(--wb-blue);border:1px solid var(--wb-blue-border)}
.heluo-wb-tag-green{background:var(--wb-green-soft);color:var(--wb-green);border:1px solid var(--wb-green-border)}
.heluo-wb-tag-amber{background:var(--wb-amber-soft);color:var(--wb-amber);border:1px solid var(--wb-amber-border)}
.heluo-wb-tag-red{background:var(--wb-red-soft);color:var(--wb-red);border:1px solid var(--wb-red-border)}
.heluo-wb-tag-purple{background:var(--wb-purple-soft);color:var(--wb-purple);border:1px solid var(--wb-purple-border)}
.heluo-wb-btn-sm,.heluo-wb-btn{
  height:26px;padding:0 9px;border-radius:7px;font-size:12px;font-weight:500;cursor:pointer;
  display:inline-flex;align-items:center;gap:4px;border:1px solid var(--wb-border);background:#FFFFFF;
  color:var(--wb-text-sub);transition:all .14s;white-space:nowrap;
}
.heluo-wb-btn-sm:hover:not(:disabled),.heluo-wb-btn:hover:not(:disabled){background:#F8FAFC;border-color:#CBD5E1;color:var(--wb-text)}
.heluo-wb-btn-sm.primary{background:var(--wb-blue-soft);border-color:var(--wb-blue-border);color:var(--wb-blue);font-weight:600}
.heluo-wb-btn-sm.primary:hover:not(:disabled){background:var(--wb-blue);border-color:var(--wb-blue);color:#FFFFFF}
.heluo-wb-btn-sm.solid,.heluo-wb-btn-primary{background:var(--wb-blue);border-color:var(--wb-blue);color:#FFFFFF;font-weight:600}
.heluo-wb-btn-sm.solid:hover:not(:disabled),.heluo-wb-btn-primary:hover:not(:disabled){background:var(--wb-blue-hover)}
.heluo-wb-btn-sm:disabled,.heluo-wb-btn:disabled{opacity:.52;cursor:not-allowed}
.heluo-wb-card{border:1px solid var(--wb-border);border-radius:10px;background:#FFFFFF;padding:12px;display:flex;flex-direction:column;gap:8px}
.heluo-wb-card-hdr{display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap}
.heluo-wb-card-title{margin:0;font-size:13px;font-weight:600;color:var(--wb-text)}
.heluo-wb-empty{text-align:center;padding:24px 12px;font-size:12px;color:var(--wb-text-light);background:#FFFFFF;border:1px dashed var(--wb-border);border-radius:10px}
.heluo-wb-input,.heluo-wb-textarea{
  width:100%;border:1px solid var(--wb-border);border-radius:8px;padding:6px 9px;font:inherit;font-size:12.5px;
  background:#FFFFFF;color:var(--wb-text);transition:border-color .14s;
}
.heluo-wb-input:focus,.heluo-wb-textarea:focus{outline:none;border-color:var(--wb-blue)}
.heluo-wb-textarea{min-height:110px;resize:vertical;font-family:var(--wb-mono);line-height:1.55}
.heluo-wb-modal-backdrop{position:fixed;inset:0;z-index:1200;background:rgba(15,23,42,.42);display:flex;align-items:center;justify-content:center;padding:16px}
.heluo-wb-modal{
  width:min(510px,100%);max-height:88vh;background:#FFFFFF;color:var(--wb-text);border-radius:16px;
  overflow:hidden;display:flex;flex-direction:column;box-shadow:0 24px 64px rgba(15,23,42,.22);
}
.heluo-wb-modal-head{
  padding:14px 18px;border-bottom:1px solid var(--wb-border);display:flex;align-items:center;
  justify-content:space-between;font-size:15px;font-weight:700;background:#FFFFFF;
}
.heluo-wb-modal-close{
  width:28px;height:28px;border-radius:7px;border:none;background:transparent;color:var(--wb-text-muted);font-size:16px;cursor:pointer;
}
.heluo-wb-modal-close:hover{background:#ECEEF2;color:var(--wb-text)}
.heluo-wb-modal-body{padding:15px 18px;overflow-y:auto;display:flex;flex-direction:column;gap:12px}
.heluo-wb-modal-foot{padding:11px 18px;border-top:1px solid var(--wb-border);background:#F8FAFC;display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap}
.heluo-wb-cfg-title{font-size:12.5px;font-weight:700;color:var(--wb-text);margin-bottom:6px;display:flex;align-items:center;justify-content:space-between}
.heluo-wb-role-grid{display:flex;flex-wrap:wrap;gap:6px}
.heluo-wb-role-chip{
  height:30px;padding:0 11px;border-radius:8px;border:1px solid var(--wb-border);background:#F8FAFC;
  color:var(--wb-text-sub);font-size:12.5px;font-weight:500;cursor:pointer;transition:all .13s;
}
.heluo-wb-role-chip:hover{border-color:#CBD5E1;background:#F1F5F9}
.heluo-wb-role-chip.active{background:var(--wb-blue-soft);border-color:var(--wb-blue);color:var(--wb-blue);font-weight:700}
.heluo-wb-drawer-backdrop{position:fixed;inset:0;z-index:1100;background:rgba(15,23,42,.28);display:flex;justify-content:flex-end}
.heluo-wb-drawer{width:min(440px,100%);height:100%;background:var(--wb-bg);border-left:1px solid var(--wb-border);display:flex;flex-direction:column;box-shadow:-8px 0 28px rgba(0,0,0,.14)}
.heluo-wb-entry-btn{
  appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-primary,#1f2937);display:flex;
  align-items:center;gap:8px;width:100%;padding:6px 10px;border-radius:8px;cursor:pointer;font-size:13px;text-align:left;
}
.heluo-wb-entry-btn:hover{background:var(--dsw-alias-bg-hover,rgba(0,0,0,.06))}
.heluo-wb-entry-btn:focus-visible{outline:2px solid var(--wb-blue)}
.heluo-wb-link{color:var(--wb-blue);text-decoration:none;font-weight:700;cursor:pointer;background:transparent;border:0;padding:0;font-family:inherit;font-size:inherit}
.heluo-wb-link:hover{text-decoration:underline}
.heluo-wb-clickable{cursor:pointer}
.heluo-wb-clickable:focus-visible{outline:2px solid var(--wb-blue);outline-offset:1px}
@media (max-width:340px){.heluo-wb-kpi-4{grid-template-columns:repeat(2,minmax(0,1fr))}.heluo-wb-rail-5{grid-template-columns:repeat(3,minmax(0,1fr))}}
`;

    const CFG_CSS = `
.heluo-wb-cfg-wrap{
  box-sizing:border-box;background:#FFFFFF;border:1px solid #E2E8F0;border-radius:12px;
  padding:14px 16px;display:flex;flex-direction:column;gap:12px;color:#111827;
  font:13px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Segoe UI",Roboto,sans-serif;
}
.heluo-wb-cfg-wrap *,.heluo-wb-cfg-wrap *::before,.heluo-wb-cfg-wrap *::after{box-sizing:border-box}
.heluo-wb-cfg-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.heluo-wb-cfg-heading{margin:0;font-size:14px;font-weight:700;color:#111827}
.heluo-wb-cfg-sub{margin:0;font-size:12px;color:#6B7280}
.heluo-wb-cfg-field{display:flex;flex-direction:column;gap:5px}
.heluo-wb-cfg-label{font-size:12px;font-weight:600;color:#374151;display:flex;align-items:center;justify-content:space-between;gap:6px}
.heluo-wb-cfg-hint{font-size:11.5px;color:#6B7280}
.heluo-wb-cfg-input{
  width:100%;height:34px;border:1px solid #CBD5E1;border-radius:8px;padding:0 10px;
  font:inherit;font-size:12.5px;background:#FFFFFF;color:#111827;outline:none;transition:border-color .14s;
}
.heluo-wb-cfg-input:focus{border-color:#3B6CF5;box-shadow:0 0 0 2px rgba(59,108,245,.14)}
.heluo-wb-cfg-seg{display:inline-flex;background:#EEF2F6;padding:3px;border-radius:8px;gap:3px;align-self:flex-start}
.heluo-wb-cfg-seg-btn{
  height:26px;padding:0 12px;border-radius:6px;border:none;background:transparent;color:#475569;
  font-size:12px;font-weight:500;cursor:pointer;transition:all .13s;
}
.heluo-wb-cfg-seg-btn.active{background:#FFFFFF;color:#3B6CF5;font-weight:700;box-shadow:0 1px 2px rgba(15,23,42,.08)}
.heluo-wb-cfg-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end;margin-top:2px}
.heluo-wb-cfg-btn{
  height:30px;padding:0 12px;border-radius:8px;border:1px solid #CBD5E1;background:#FFFFFF;color:#374151;
  font-size:12.5px;font-weight:500;cursor:pointer;display:inline-flex;align-items:center;gap:5px;transition:all .14s;
}
.heluo-wb-cfg-btn:hover:not(:disabled){background:#F8FAFC;border-color:#94A3B8}
.heluo-wb-cfg-btn.solid{background:#3B6CF5;border-color:#3B6CF5;color:#FFFFFF;font-weight:600}
.heluo-wb-cfg-btn.solid:hover:not(:disabled){background:#2C5BE0}
.heluo-wb-cfg-btn:disabled{opacity:.52;cursor:not-allowed}
.heluo-wb-cfg-msg{padding:7px 10px;border-radius:8px;font-size:12px;line-height:1.45}
.heluo-wb-cfg-msg.ok{background:#ECFDF5;border:1px solid #A7F3D0;color:#065F46}
.heluo-wb-cfg-msg.err{background:#FEF2F2;border:1px solid #FECACA;color:#991B1B}
`;

    // §2 Locales & Icons
    const zh = {
      entryLabel: 'DOP 工作台',
      entryTooltip: '打开 DOP 工作台（右侧多页签）',
      tabTitle: 'DOP 工作台',
      localLoopback: '本地联调',
      drawerNotice: '正在独立抽屉中展示 DOP 工作台。',
      refresh: '刷新',
      todos: '待办',
      customize: '定制',
      loading: '正在加载 DOP 工作台数据...',
      retry: '重试',
      configMissingTitle: '未配置 DOP 服务地址',
      configMissingDesc: '请设置环境变量 HELUO_DOP_BASE_URL，或在下方「连接配置」填写 DOP 服务地址（apiBaseUrl）并保存生效。',
      unauthorizedTitle: '尚未登录企业账号',
      unauthorizedDesc: '请先前往「设置 → 企业账号」完成 IAM 登录，然后点击重试。',
      phase2Notice: '二期待澄清：该领域业务接口与提示词动作将在二期评审对齐后接入，一期暂不发起上游查询或写操作。',
    };

    const en = {
      entryLabel: 'DOP Workbench',
      entryTooltip: 'Open DOP Workbench (Right Sidebar Tab)',
      tabTitle: 'DOP Workbench',
      localLoopback: 'Local Endpoint',
      drawerNotice: 'Showing DOP Workbench in standalone drawer.',
      refresh: 'Refresh',
      todos: 'Todos',
      customize: 'Customize',
      loading: 'Loading DOP Workbench...',
      retry: 'Retry',
      configMissingTitle: 'DOP Base URL Required',
      configMissingDesc: 'Set HELUO_DOP_BASE_URL or save your DOP base URL under Connection Settings below.',
      unauthorizedTitle: 'Sign-In Required',
      unauthorizedDesc: 'Please sign in under Settings → Enterprise Account (IAM), then click Retry.',
      phase2Notice: 'Phase-2 pending clarification: domain APIs and prompt templates will be added after Phase-2 alignment.',
    };

    function WorkbenchIcon(props) {
      const size = Number.isFinite(props?.size) ? props.size : 16;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 320 320',
          fill: 'none',
          'aria-hidden': 'true',
          style: {
            width: `${size}px`,
            height: `${size}px`,
            display: 'block',
            flexShrink: 0,
          },
        },
        h('rect', { x: 20, y: 20, width: 280, height: 280, rx: 64, fill: '#EFF6FF' }),
        h('path', { d: 'M128 214 L84 238 L94 186 Z', fill: '#F97316' }),
        h('path', { d: 'M192 214 L236 238 L226 186 Z', fill: '#F97316' }),
        h('path', { d: 'M160 44 C198 84 214 140 206 202 L114 202 C106 140 122 84 160 44 Z', fill: '#2563EB' }),
        h('path', { d: 'M160 44 C180 70 192 98 197 126 L123 126 C128 98 140 70 160 44 Z', fill: '#60A5FA', fillOpacity: 0.4 }),
        h('circle', { cx: 160, cy: 138, r: 24, fill: '#FFFFFF', stroke: '#1D4ED8', strokeWidth: 8 }),
        h('circle', { cx: 160, cy: 138, r: 10, fill: '#38BDF8' }),
        h('rect', { x: 132, y: 202, width: 56, height: 16, rx: 6, fill: '#1E3A8A' }),
        h('path', { d: 'M138 220 C138 250 148 272 160 284 C172 272 182 250 182 220 Z', fill: '#F97316' }),
        h('path', { d: 'M150 222 C150 242 155 256 160 264 C165 256 170 242 170 222 Z', fill: '#FDE047' }),
      );
    }

    const DUOTONE_PALETTE = {
      blue: '#3B6CF5',
      red: '#DC2626',
      cyan: '#0284C7',
      amber: '#D97706',
      green: '#059669',
      muted: '#94A3B8',
    };

    function DuotoneIcon({ name, tone = 'blue', size = 14 }) {
      const c = DUOTONE_PALETTE[tone] || DUOTONE_PALETTE.blue;
      const body = (() => {
        switch (name) {
          case 'alertTri':
            return [
              h('path', { key: '1', d: 'M10 3L18 17H2L10 3Z', fill: c, fillOpacity: 0.18, stroke: c, strokeWidth: 1.7, strokeLinejoin: 'round' }),
              h('path', { key: '2', d: 'M10 8v4M10 14.5h.01', stroke: c, strokeWidth: 1.8, strokeLinecap: 'round' }),
            ];
          case 'clock':
            return [
              h('circle', { key: '1', cx: 10, cy: 10, r: 7, fill: c, fillOpacity: 0.18, stroke: c, strokeWidth: 1.7 }),
              h('path', { key: '2', d: 'M10 6.5V10l2.5 1.5', stroke: c, strokeWidth: 1.7, strokeLinecap: 'round' }),
            ];
          case 'searchDoc':
            return [
              h('circle', { key: '1', cx: 9, cy: 9, r: 5.5, fill: c, fillOpacity: 0.18, stroke: c, strokeWidth: 1.7 }),
              h('path', { key: '2', d: 'M13.5 13.5L17 17', stroke: c, strokeWidth: 1.8, strokeLinecap: 'round' }),
            ];
          case 'inbox':
            return [
              h('path', { key: '1', d: 'M3 12l2-7h10l2 7v5H3v-5z', fill: c, fillOpacity: 0.18, stroke: c, strokeWidth: 1.6, strokeLinejoin: 'round' }),
              h('path', { key: '2', d: 'M3 12h4l1.5 2h3L13 12h4', stroke: c, strokeWidth: 1.5 }),
            ];
          case 'clipboard':
            return [
              h('rect', { key: '1', x: 5, y: 4, width: 10, height: 13, rx: 2, fill: c, fillOpacity: 0.18, stroke: c, strokeWidth: 1.6 }),
              h('path', { key: '2', d: 'M8 4V3h4v1M7.5 10l2 2 3.5-3.5', stroke: c, strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }),
            ];
          case 'shield':
            return [
              h('path', { key: '1', d: 'M10 2.5L16.5 5v5c0 4.2-2.8 6.8-6.5 7.8C6.3 16.8 3.5 14.2 3.5 10V5L10 2.5z', fill: c, fillOpacity: 0.18, stroke: c, strokeWidth: 1.6 }),
              h('path', { key: '2', d: 'M7.5 10l1.8 1.8 3.5-3.5', stroke: c, strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }),
            ];
          case 'gear':
            return [
              h('circle', { key: '1', cx: 10, cy: 10, r: 3, fill: c, fillOpacity: 0.24, stroke: c, strokeWidth: 1.6 }),
              h('path', { key: '2', d: 'M10 3v2M10 15v2M3 10h2M15 10h2M5.1 5.1l1.4 1.4M13.5 13.5l1.4 1.4M14.9 5.1l-1.4 1.4M6.5 13.5l-1.4 1.4', stroke: c, strokeWidth: 1.5, strokeLinecap: 'round' }),
            ];
          case 'rocket':
            return [
              h('path', { key: '1', d: 'M10 3c3.5 1.5 5 5 5 8.5l-2.5 2.5h-5L5 11.5C5 8 6.5 4.5 10 3z', fill: c, fillOpacity: 0.18, stroke: c, strokeWidth: 1.6, strokeLinejoin: 'round' }),
              h('circle', { key: '2', cx: 10, cy: 9, r: 1.4, fill: c }),
            ];
          case 'calendar':
            return [
              h('rect', { key: '1', x: 3.5, y: 4.5, width: 13, height: 12, rx: 2, fill: c, fillOpacity: 0.18, stroke: c, strokeWidth: 1.6 }),
              h('path', { key: '2', d: 'M7 3v3M13 3v3M3.5 8.5h13', stroke: c, strokeWidth: 1.6, strokeLinecap: 'round' }),
            ];
          case 'plane':
            return [h('path', { key: '1', d: 'M16.5 4.5L3.5 9.5l4.5 2 2 4.5 6.5-11.5z', fill: c, fillOpacity: 0.18, stroke: c, strokeWidth: 1.6, strokeLinejoin: 'round' })];
          case 'flame':
            return [h('path', { key: '1', d: 'M10.5 3c1.5 2.5 4.5 4.2 4.5 8a5 5 0 0 1-10 0c0-2.2 1.2-4 2.5-5.2-.2 1.5.8 2.4 1.8 2.4.8 0 1.2-.8 1.2-2.2V3z', fill: c, fillOpacity: 0.2, stroke: c, strokeWidth: 1.6, strokeLinejoin: 'round' })];
          case 'refresh':
            return [
              h('path', { key: '1', d: 'M4.5 9.5A5.5 5.5 0 0 1 14 6l1.5 1.5M15.5 10.5A5.5 5.5 0 0 1 6 14l-1.5-1.5', stroke: c, strokeWidth: 1.7, strokeLinecap: 'round' }),
              h('circle', { key: '2', cx: 10, cy: 10, r: 2.2, fill: c, fillOpacity: 0.22 }),
            ];
          case 'radio':
            return [
              h('circle', { key: '1', cx: 10, cy: 10, r: 2.2, fill: c }),
              h('path', { key: '2', d: 'M6.2 6.2a5.4 5.4 0 0 0 0 7.6M13.8 6.2a5.4 5.4 0 0 1 0 7.6M3.8 3.8a8.8 8.8 0 0 0 0 12.4M16.2 3.8a8.8 8.8 0 0 1 0 12.4', stroke: c, strokeWidth: 1.5, strokeLinecap: 'round' }),
            ];
          case 'folderProj':
            return [h('path', { key: '1', d: 'M3 6a2 2 0 0 1 2-2h3.5l1.8 2H15a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z', fill: c, fillOpacity: 0.18, stroke: c, strokeWidth: 1.7 })];
          case 'filePlus':
            return [
              h('rect', { key: '1', x: 4.5, y: 3, width: 11, height: 14, rx: 2, fill: c, fillOpacity: 0.18, stroke: c, strokeWidth: 1.6 }),
              h('path', { key: '2', d: 'M10 7.5v5M7.5 10h5', stroke: c, strokeWidth: 1.6, strokeLinecap: 'round' }),
            ];
          case 'compass':
            return [
              h('circle', { key: '1', cx: 10, cy: 10, r: 6.8, fill: c, fillOpacity: 0.18, stroke: c, strokeWidth: 1.6 }),
              h('polygon', { key: '2', points: '12.5,7.5 11,11 7.5,12.5 9,9', fill: c }),
            ];
          case 'codeBox':
            return [
              h('rect', { key: '1', x: 3.5, y: 4, width: 13, height: 12, rx: 2, fill: c, fillOpacity: 0.18, stroke: c, strokeWidth: 1.6 }),
              h('path', { key: '2', d: 'M8 8l-2 2 2 2M12 8l2 2-2 2', stroke: c, strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }),
            ];
          case 'flask':
            return [h('path', { key: '1', d: 'M8 3h4M9 3v4.5L5.5 14.5A1.5 1.5 0 0 0 6.8 16.5h6.4a1.5 1.5 0 0 0 1.3-2L11 7.5V3', fill: c, fillOpacity: 0.18, stroke: c, strokeWidth: 1.6, strokeLinejoin: 'round' })];
          case 'checkCircle':
            return [
              h('circle', { key: '1', cx: 10, cy: 10, r: 6.8, fill: c, fillOpacity: 0.18, stroke: c, strokeWidth: 1.6 }),
              h('path', { key: '2', d: 'M7.2 10.2l1.9 1.9 3.8-4', stroke: c, strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }),
            ];
          case 'repeat':
            return [
              h('path', { key: '1', d: 'M4 8h11l-2.5-2.5M16 12H5l2.5 2.5', stroke: c, strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }),
              h('rect', { key: '2', x: 6, y: 8, width: 8, height: 4, rx: 1, fill: c, fillOpacity: 0.18 }),
            ];
          case 'flag':
            return [h('path', { key: '1', d: 'M5 3v14M5 4h9.5l-1.8 3 1.8 3H5', fill: c, fillOpacity: 0.2, stroke: c, strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' })];
          case 'docTotal':
          default:
            return [
              h('rect', { key: '1', x: 4, y: 3, width: 12, height: 15, rx: 2, fill: c, fillOpacity: 0.18, stroke: c, strokeWidth: 1.7 }),
              h('path', { key: '2', d: 'M8 7h5M8 11h5M8 15h3', stroke: c, strokeWidth: 1.6, strokeLinecap: 'round' }),
            ];
        }
      })();
      return h('svg', { width: size, height: size, viewBox: '0 0 20 20', fill: 'none', 'aria-hidden': 'true' }, ...body);
    }

    const BOARD_LABELS = {
      requirement: '需求进展',
      implementation: '实施进展',
      project: '项目进展',
    };

    const DOMAIN_TABS = [
      { key: 'requirement', label: '需求', phase1: true },
      { key: 'project', label: '项目', phase1: false },
      { key: 'dev', label: '研发', phase1: false },
      { key: 'efficiency', label: '效能', phase1: false },
      { key: 'test', label: '测试', phase1: false },
    ];

    const ROLE_LABELS = {
      req_mgr: '需求经理',
      biz_mgr: '业务经理',
      dev_owner: '研发负责',
      tech_lead: '技术主管',
      custom: '自定义',
    };

    function formatNullable(val) {
      return val === null || val === undefined || val === '' ? '--' : String(val);
    }

    // §3 Same-Origin HTTP Client
    async function apiRequest(subPath, { method = 'GET', query = null, body = undefined, signal } = {}) {
      const params = new URLSearchParams();
      if (query && typeof query === 'object') {
        for (const [k, v] of Object.entries(query)) {
          if (v === undefined || v === null || v === '') continue;
          params.set(k, String(v));
        }
      }
      const qs = params.toString();
      const url = `${API_PREFIX}${subPath}${qs ? `?${qs}` : ''}`;
      const headers = {
        [REQUEST_HEADER]: '1',
        accept: 'application/json',
      };
      const init = { method, headers, credentials: 'same-origin' };
      if (signal) init.signal = signal;
      if (body !== undefined) {
        headers['content-type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      const fetchFn = globalThis.fetch;
      if (typeof fetchFn !== 'function') {
        throw new Error('Browser fetch is unavailable');
      }
      const res = await fetchFn(url, init);
      const data = await res.json().catch(() => null);
      if (!res.ok || (data && data.ok === false)) {
        const msg = data?.error?.message || `HTTP ${res.status}`;
        const err = new Error(msg);
        err.code = data?.error?.code || 'HTTP_ERROR';
        err.httpStatus = res.status;
        throw err;
      }
      return data;
    }

    const workbenchApi = {
      getBootstrap: (opts = {}) => apiRequest('/bootstrap', opts),
      getConfig: (opts = {}) => apiRequest('/config', opts),
      updateConfig: (body, opts = {}) => apiRequest('/config', { ...opts, method: 'PUT', body }),
      getSummary: (query, opts = {}) => apiRequest('/summary', { ...opts, query }),
      getRequirements: (query, opts = {}) => apiRequest('/requirements', { ...opts, query }),
      searchRmpDocs: (query, opts = {}) => apiRequest('/rmp/docs', { ...opts, query }),
      getRmpOutline: (query, opts = {}) => apiRequest('/rmp/outline', { ...opts, query }),
      buildPrompt: (body, opts = {}) => apiRequest('/prompt/build', { ...opts, method: 'POST', body }),
      savePreferences: (body, opts = {}) => apiRequest('/preferences', { ...opts, method: 'PUT', body }),
      resolveItsmOpenUrl: (wjbiid, opts = {}) => apiRequest('/itsm/open-url', { ...opts, query: { wjbiid } }),
    };

    // §4 Host Conversation Draft Bridge
    function sanitizePortalHref(rawUrl) {
      if (typeof rawUrl !== 'string' || rawUrl.trim() === '') return '';
      const trimmed = rawUrl.trim();
      if (typeof URL === 'function') {
        try {
          const baseOrigin = typeof globalThis.location?.origin === 'string' && globalThis.location.origin !== 'null'
            ? globalThis.location.origin
            : undefined;
          const parsed = new URL(trimmed, baseOrigin);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
          if (parsed.username !== '' || parsed.password !== '') return '';
          return parsed.toString();
        } catch {
          return '';
        }
      }
      return /^https?:\/\/[^@\s]+$/iu.test(trimmed) ? trimmed : '';
    }

    function openExternalUrl(rawUrl) {
      const safeUrl = sanitizePortalHref(rawUrl);
      if (!safeUrl) return false;
      const win = globalThis.window ?? globalThis;
      if (win && typeof win.open === 'function') {
        win.open(safeUrl, '_blank', 'noopener,noreferrer');
        return true;
      }
      return false;
    }

    function resolveDraftBridge(ctxOrOptions, actxArg = null) {
      const isOpts = ctxOrOptions && typeof ctxOrOptions === 'object'
        && ('ctx' in ctxOrOptions || 'sessionId' in ctxOrOptions || 'conversation' in ctxOrOptions || 'sessions' in ctxOrOptions);
      const ctx = isOpts ? ctxOrOptions.ctx : ctxOrOptions;
      const convSvc = (isOpts ? ctxOrOptions.conversation : null) ?? ctx?.conversation ?? null;
      const sessSvc = (isOpts ? ctxOrOptions.sessions : null) ?? ctx?.sessions ?? null;
      const sessionId = isOpts ? ctxOrOptions.sessionId : null;
      const resolver = convSvc?.input ?? ctx?.sessionInput ?? null;

      let face = null;
      if (resolver && typeof resolver.for === 'function') {
        if (sessionId && typeof sessSvc?.binding === 'function') {
          try {
            const binding = sessSvc.binding(sessionId);
            if (binding?.ctx) {
              face = resolver.for(binding.ctx);
            }
          } catch {
            face = null;
          }
        }
        if (!face && actxArg) {
          try {
            face = resolver.for(actxArg);
          } catch {
            face = null;
          }
        }
      } else if (resolver && typeof resolver.setDraft === 'function') {
        face = resolver;
      }

      const canSetDraft = Boolean(face && typeof face.setDraft === 'function');
      return {
        canWriteDraft: canSetDraft,
        writeDraft(promptText, mode = 'replace') {
          if (!canSetDraft) return { ok: false, target: 'unsupported' };
          let nextText = String(promptText ?? '');
          if (mode === 'append') {
            const currentDraft = typeof face.state?.getSnapshot === 'function'
              ? String(face.state.getSnapshot()?.draft ?? '')
              : '';
            if (currentDraft.trim() !== '') {
              nextText = `${currentDraft.replace(/\s+$/u, '')}\n\n${nextText}`;
            }
          }
          // 只写入草稿并聚焦输入框，一期严格绝不自动发送消息
          face.setDraft(nextText);
          if (typeof face.focus === 'function') face.focus();
          if (typeof face.notify === 'function') {
            face.notify('info', '已将 DOP 工作台提示词填入草稿箱，请检查确认后手动发送。');
          }
          return { ok: true, target: 'draft' };
        },
      };
    }

    async function copyTextToClipboard(text) {
      const value = String(text ?? '');
      if (typeof globalThis.navigator?.clipboard?.writeText === 'function') {
        await globalThis.navigator.clipboard.writeText(value);
        return true;
      }
      if (typeof globalThis.document?.createElement === 'function') {
        const el = globalThis.document.createElement('textarea');
        el.value = value;
        el.setAttribute('readonly', 'readonly');
        el.style.position = 'fixed';
        el.style.opacity = '0';
        globalThis.document.body?.appendChild(el);
        el.select?.();
        const copied = Boolean(globalThis.document.execCommand?.('copy'));
        el.remove?.();
        if (copied) return true;
      }
      return false;
    }

    // §5 Progress Boards & Top Bar Components
    function makePortalClickProps(url, titleText) {
      const safe = sanitizePortalHref(url);
      if (!safe) return { title: titleText || undefined };
      const trigger = () => openExternalUrl(safe);
      return {
        role: 'button',
        tabIndex: 0,
        title: titleText ? `${titleText}（点击打开 DOP 页面）` : '点击打开 DOP 页面',
        onClick: trigger,
        onKeyDown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            trigger();
          }
        },
      };
    }

    function TodosPopover({ summary, onClose }) {
      const categories = summary?.todos?.categories ? Object.values(summary.todos.categories) : [];
      const total = summary?.todos?.totalCount ?? 0;

      const handleTodoItemOpen = async (catKey, item) => {
        if (catKey === 'itsm' && item?.wjbiid) {
          try {
            const res = await workbenchApi.resolveItsmOpenUrl(item.wjbiid);
            if (res?.url && openExternalUrl(res.url)) return;
          } catch {
            // 降级使用静态构造的外链
          }
        }
        if (item?.portalUrl) openExternalUrl(item.portalUrl);
      };

      return h(
        'div',
        {
          className: 'heluo-wb-todo-pop',
          role: 'region',
          'aria-label': '7 路待办汇聚',
          onClick: (e) => e.stopPropagation(),
        },
        h(
          'div',
          { className: 'heluo-wb-todo-head' },
          h('span', null, '我的待处理事项（点击直跳）'),
          h(
            'div',
            { style: { display: 'inline-flex', alignItems: 'center', gap: '8px' } },
            h('span', { style: { color: '#3B6CF5', fontFamily: 'var(--wb-mono)' } }, `共 ${total} 项`),
            h(
              'button',
              { type: 'button', className: 'heluo-wb-prog-collapse', style: { height: '22px' }, onClick: onClose },
              '收起',
            ),
          ),
        ),
        h(
          'div',
          { className: 'heluo-wb-todo-list' },
          categories.map((cat) =>
            h(
              'div',
              { key: cat.key, className: 'heluo-wb-todo-row' },
              h(
                'div',
                { className: 'heluo-wb-todo-row-top' },
                h(
                  'div',
                  { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', minWidth: 0 } },
                  h('span', null, cat.label),
                  cat.degraded
                    ? h('span', { className: 'heluo-wb-tag heluo-wb-tag-amber' }, `局部降级: ${cat.error?.code || 'ERR'}`)
                    : null,
                ),
                h(
                  'span',
                  { className: `heluo-wb-todo-num ${Number(cat.count || 0) > 0 ? 'has' : 'zero'}` },
                  String(cat.count ?? 0),
                ),
              ),
              cat.items.length > 0
                ? cat.items.slice(0, 3).map((it, idx) =>
                  h(
                    'div',
                    { key: it.id || idx, className: 'heluo-wb-todo-sub' },
                    h(
                      'span',
                      { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                      it.code ? `[${it.code}] ` : '',
                      it.title,
                      it.state ? ` · ${it.state}` : '',
                    ),
                    (it.portalUrl || (cat.key === 'itsm' && it.wjbiid))
                      ? h(
                        'a',
                        {
                          href: sanitizePortalHref(it.portalUrl) || '#',
                          target: '_blank',
                          rel: 'noopener noreferrer',
                          className: 'heluo-wb-link',
                          style: { flex: 'none', fontSize: '11px' },
                          onClick: (e) => {
                            e.preventDefault();
                            void handleTodoItemOpen(cat.key, it);
                          },
                        },
                        '查看 ↗',
                      )
                      : null,
                  ),
                )
                : (!cat.degraded
                  ? h('div', { style: { fontSize: '11px', color: 'var(--wb-text-light)', paddingLeft: '2px' } }, '暂无待办项')
                  : null),
            ),
          ),
        ),
      );
    }

    function TopBar({
      bootstrap,
      summary,
      showTodos,
      onToggleTodos,
      onCloseTodos,
      onOpenCustomize,
      onRefresh,
      loading,
      t,
    }) {
      const totalTodos = summary?.todos?.totalCount ?? 0;
      return h(
        'div',
        { className: 'heluo-wb-topbar' },
        h(
          'div',
          { className: 'heluo-wb-top-left' },
          h(
            'div',
            { className: 'heluo-wb-todo-wrap' },
            h(
              'button',
              {
                type: 'button',
                className: `heluo-wb-todo-capsule${showTodos ? ' open' : ''}`,
                onClick: onToggleTodos,
                'aria-expanded': showTodos,
                'data-testid': 'wb-todos-btn',
                title: '点击查看跨平台 7 路待办汇聚',
              },
              h('span', null, t('todos')),
              h('span', { className: 'heluo-wb-todo-badge' }, String(totalTodos)),
              h('span', { style: { fontSize: '10px' } }, '▾'),
            ),
            showTodos && summary ? h(TodosPopover, { summary, onClose: onCloseTodos }) : null,
          ),
          bootstrap?.isLoopbackEndpoint
            ? h('span', { className: 'heluo-wb-badge-local', title: '127.0.0.1 / localhost' }, t('localLoopback'))
            : null,
        ),
        h(
          'div',
          { className: 'heluo-wb-top-right' },
          h(
            'button',
            {
              type: 'button',
              className: 'heluo-wb-icon-btn',
              onClick: onRefresh,
              disabled: loading,
              'data-testid': 'wb-refresh-btn',
              'aria-label': t('refresh'),
              title: t('refresh'),
            },
            loading ? '…' : '↻',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'heluo-wb-custom-btn',
              onClick: onOpenCustomize,
              'data-testid': 'wb-customize-btn',
              title: '按角色预设或自定义进展看板与业务域页签',
            },
            '⚙ ',
            t('customize'),
          ),
        ),
      );
    }

    function SegmentedSwitch({ options, value, onChange, testIdPrefix }) {
      return h(
        'div',
        { className: 'heluo-wb-seg', role: 'tablist' },
        options.map((opt) =>
          h(
            'button',
            {
              key: opt.key,
              type: 'button',
              role: 'tab',
              'aria-selected': value === opt.key,
              'data-testid': testIdPrefix ? `${testIdPrefix}-${opt.key}` : undefined,
              className: `heluo-wb-seg-btn${value === opt.key ? ' active' : ''}`,
              onClick: () => onChange(opt.key),
            },
            opt.label,
          ),
        ),
      );
    }

    function RequirementBoard({ data, view, onViewChange }) {
      const p = data?.progress;
      const ip = data?.inProgress;
      const links = data?.links || {};
      const hasAbnormal = p && (p.unAnalyzed != null || p.notAccepted != null);
      const unAnalyzed = Number(p?.unAnalyzed ?? 0);
      const notAccepted = Number(p?.notAccepted ?? 0);
      const abnormalTotal = hasAbnormal ? String(unAnalyzed + notAccepted) : '--';
      const abnormalDanger = hasAbnormal && (unAnalyzed + notAccepted) > 0;
      const acceptDaysText = p?.averageAcceptDays != null ? `${formatNullable(p.averageAcceptDays)}天` : '--';
      const analyzeDaysText = p?.averageAnalyzeDays != null ? `${formatNullable(p.averageAnalyzeDays)}天` : '--';

      const uNode = (val, label, icon, style, linkUrl) => {
        const num = Number(val ?? 0);
        const lit = num > 0;
        const clickProps = makePortalClickProps(linkUrl, `需求进展 · ${label}`);
        return h(
          'div',
          {
            key: label,
            className: `heluo-wb-u-node${lit ? ' lit' : ''}${linkUrl ? ' heluo-wb-clickable' : ''}`,
            style,
            ...clickProps,
          },
          h(
            'div',
            { className: 'heluo-wb-u-node-top' },
            h(DuotoneIcon, { name: icon, tone: lit ? 'blue' : 'muted', size: 14 }),
            h('span', { className: 'heluo-wb-u-node-num' }, formatNullable(val)),
          ),
          h('span', { className: 'heluo-wb-u-node-name' }, label),
        );
      };

      return h(
        'section',
        { 'aria-label': '需求进展板', style: { display: 'flex', flexDirection: 'column', gap: '9px' } },
        h(
          'div',
          { className: 'heluo-wb-prog-sub' },
          h('span', null, '统计口径'),
          h(SegmentedSwitch, {
            options: [
              { key: 'manager', label: '需求经理' },
              { key: 'business', label: '业务负责' },
            ],
            value: view,
            onChange: onViewChange,
            testIdPrefix: 'wb-req-view',
          }),
        ),
        data?.errors?.length > 0
          ? h('div', { className: 'heluo-wb-banner heluo-wb-banner-warn', style: { margin: 0 } }, `部分需求看板指标加载受限：${data.errors[0].message}`)
          : null,
        h(
          'div',
          { className: 'heluo-wb-kpi-4' },
          h(
            'div',
            {
              className: `heluo-wb-kpi-lite${links.total ? ' heluo-wb-clickable' : ''}`,
              'data-testid': 'wb-kpi-req-total',
              ...makePortalClickProps(links.total, '需求总数'),
            },
            h('div', { className: 'heluo-wb-kpi-top' }, h(DuotoneIcon, { name: 'docTotal', tone: 'blue' }), h('span', { className: 'heluo-wb-kpi-val' }, formatNullable(p?.total))),
            h('span', { className: 'heluo-wb-kpi-lbl' }, '需求总数'),
          ),
          h(
            'div',
            {
              className: `heluo-wb-kpi-lite${abnormalDanger ? ' danger' : ''}${links.abnormal ? ' heluo-wb-clickable' : ''}`,
              ...makePortalClickProps(links.abnormal, hasAbnormal ? `未分析 ${unAnalyzed} · 未验收 ${notAccepted}` : '未分析 / 未验收'),
            },
            h('div', { className: 'heluo-wb-kpi-top' }, h(DuotoneIcon, { name: 'alertTri', tone: abnormalDanger ? 'red' : 'muted' }), h('span', { className: 'heluo-wb-kpi-val' }, abnormalTotal)),
            h('span', { className: 'heluo-wb-kpi-lbl' }, '异常需求'),
          ),
          h(
            'div',
            {
              className: `heluo-wb-kpi-lite${links.avgAccept ? ' heluo-wb-clickable' : ''}`,
              ...makePortalClickProps(links.avgAccept, '平均受理'),
            },
            h('div', { className: 'heluo-wb-kpi-top' }, h(DuotoneIcon, { name: 'clock', tone: 'cyan' }), h('span', { className: 'heluo-wb-kpi-val', style: { fontSize: '13px' } }, acceptDaysText)),
            h('span', { className: 'heluo-wb-kpi-lbl' }, '平均受理'),
          ),
          h(
            'div',
            {
              className: `heluo-wb-kpi-lite${links.avgAnalyze ? ' heluo-wb-clickable' : ''}`,
              ...makePortalClickProps(links.avgAnalyze, '平均分析'),
            },
            h('div', { className: 'heluo-wb-kpi-top' }, h(DuotoneIcon, { name: 'searchDoc', tone: 'amber' }), h('span', { className: 'heluo-wb-kpi-val', style: { fontSize: '13px' } }, analyzeDaysText)),
            h('span', { className: 'heluo-wb-kpi-lbl' }, '平均分析'),
          ),
        ),
        h(
          'div',
          { className: 'heluo-wb-sym-u' },
          h(
            'div',
            {
              className: `heluo-wb-inprog-pill${links.inProgress ? ' heluo-wb-clickable' : ''}`,
              ...makePortalClickProps(links.inProgress, '进行中需求'),
            },
            h('span', { className: 'heluo-wb-inprog-num' }, formatNullable(ip?.progressTotal)),
            h('span', { className: 'heluo-wb-inprog-txt' }, '进行中'),
          ),
          h(
            'div',
            { className: 'heluo-wb-u-212' },
            h(
              'svg',
              { className: 'heluo-wb-u-rail', viewBox: '0 0 280 106', preserveAspectRatio: 'none', 'aria-hidden': 'true' },
              h('path', { d: 'M 46 25 H 214 C 234 25 244 37 244 53 C 244 69 234 81 214 81 H 46', stroke: '#CBD8F0', strokeWidth: 1.6, fill: 'none', strokeLinecap: 'round' }),
              h('polyline', { points: '106,21.5 111,25 106,28.5', stroke: '#6B9BF5', strokeWidth: 1.7, fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round' }),
              h('polyline', { points: '111,77.5 106,81 111,84.5', stroke: '#6B9BF5', strokeWidth: 1.7, fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round' }),
            ),
            uNode(ip?.pending, '待分析', 'inbox', { gridColumn: '1', gridRow: '1' }, links.pending),
            uNode(ip?.reviewed, '已评审', 'shield', { gridColumn: '2', gridRow: '1' }, links.reviewed),
            uNode(ip?.inOperation, '实施中', 'gear', { gridColumn: '3', gridRow: '1 / 3', justifySelf: 'center', width: '72px' }, links.inOperation),
            uNode(ip?.accepted, '已验收', 'clipboard', { gridColumn: '2', gridRow: '2' }, links.accepted),
            uNode(ip?.released, '已发布', 'rocket', { gridColumn: '1', gridRow: '2' }, links.released),
          ),
        ),
      );
    }

    function ImplementationBoard({ data, view, onViewChange }) {
      const rel = data?.release;
      const st = data?.story;
      const links = data?.links || {};
      const nNormal = Number(st?.normalNum ?? 0);
      const nPause = Number(st?.pauseNum ?? 0);
      const nRelDelay = Number(st?.releaseDelayNum ?? 0);
      const nSchedDelay = Number(st?.scheduleDelayNum ?? 0);
      const rawTotalSt = nNormal + nPause + nRelDelay + nSchedDelay;
      const denom = Math.max(1, rawTotalSt);

      const relTiles = [
        { key: 'approving', label: '审批中', val: rel?.approvingNum, icon: 'calendar', warn: false },
        { key: 'changing', label: '变更中', val: rel?.changingNum, icon: 'refresh', warn: false },
        { key: 'waitReleasing', label: '待发布', val: rel?.waitReleasingNum, icon: 'plane', warn: false },
        { key: 'releasing', label: '发布中', val: rel?.releasingNum, icon: 'radio', warn: false },
        { key: 'delayed', label: '已延期', val: rel?.delayedNum, icon: 'flame', warn: true },
      ];

      const storyLegend = [
        { key: 'normal', label: '正常', val: st?.normalNum, count: nNormal, color: '#10B981' },
        { key: 'pause', label: '暂停', val: st?.pauseNum, count: nPause, color: '#94A3B8' },
        { key: 'releaseDelay', label: '发布延期', val: st?.releaseDelayNum, count: nRelDelay, color: '#F59E0B' },
        { key: 'scheduleDelay', label: '排期延期', val: st?.scheduleDelayNum, count: nSchedDelay, color: '#EF4444' },
      ];

      return h(
        'section',
        { 'aria-label': '实施进展板', style: { display: 'flex', flexDirection: 'column', gap: '9px' } },
        h(
          'div',
          { className: 'heluo-wb-prog-sub' },
          h('span', null, '统计范围'),
          h(SegmentedSwitch, {
            options: [
              { key: 'responsible', label: '我负责' },
              { key: 'participate', label: '我参与' },
              { key: 'creator', label: '我创建' },
            ],
            value: view,
            onChange: onViewChange,
            testIdPrefix: 'wb-impl-view',
          }),
        ),
        data?.errors?.length > 0
          ? h('div', { className: 'heluo-wb-banner heluo-wb-banner-warn', style: { margin: 0 } }, `部分实施指标加载受限：${data.errors[0].message}`)
          : null,
        h(
          'div',
          null,
          h('div', { className: 'heluo-wb-impl-lbl' }, h('span', null, '排期进行时')),
          h(
            'div',
            { className: 'heluo-wb-rail-5' },
            relTiles.map((rd) => {
              const num = Number(rd.val ?? 0);
              const litCls = num > 0 ? (rd.warn ? ' lit-warn' : ' lit') : '';
              const tone = num > 0 ? (rd.warn ? 'red' : 'blue') : 'muted';
              const linkUrl = links?.release?.[rd.key];
              return h(
                'div',
                {
                  key: rd.label,
                  className: `heluo-wb-rail-tile${litCls}${linkUrl ? ' heluo-wb-clickable' : ''}`,
                  ...makePortalClickProps(linkUrl, `排期进行时 · ${rd.label}`),
                },
                h(
                  'div',
                  { className: 'heluo-wb-rail-top' },
                  h(DuotoneIcon, { name: rd.icon, tone, size: 14 }),
                  h('span', { className: 'heluo-wb-rail-num' }, formatNullable(rd.val)),
                ),
                h('span', { className: 'heluo-wb-rail-lbl' }, rd.label),
              );
            }),
          ),
        ),
        h(
          'div',
          null,
          h(
            'div',
            { className: 'heluo-wb-impl-lbl' },
            h('span', null, '故事进行时'),
            h(
              'span',
              {
                className: links?.story?.total ? 'heluo-wb-clickable' : undefined,
                style: { fontFamily: 'var(--wb-mono)' },
                ...makePortalClickProps(links?.story?.total, '故事进行时总数'),
              },
              `共 ${st ? rawTotalSt : '--'}`,
            ),
          ),
          h(
            'div',
            { className: 'heluo-wb-hbar', title: '故事健康度分布' },
            storyLegend.map((seg) =>
              seg.count > 0
                ? h('div', { key: seg.label, className: 'heluo-wb-hb-seg', style: { width: `${((seg.count / denom) * 100).toFixed(1)}%`, background: seg.color } })
                : null,
            ),
          ),
          h(
            'div',
            { className: 'heluo-wb-hlegend-4' },
            storyLegend.map((seg) => {
              const linkUrl = links?.story?.[seg.key];
              return h(
                'div',
                {
                  key: seg.label,
                  className: `heluo-wb-hl-item${linkUrl ? ' heluo-wb-clickable' : ''}`,
                  ...makePortalClickProps(linkUrl, `故事进行时 · ${seg.label}`),
                },
                h(
                  'div',
                  { className: 'heluo-wb-hl-top' },
                  h('span', { className: 'heluo-wb-hl-dot', style: { background: seg.color } }),
                  h('span', { className: 'heluo-wb-hl-num' }, formatNullable(seg.val)),
                ),
                h('span', { className: 'heluo-wb-hl-lbl' }, seg.label),
              );
            }),
          ),
        ),
      );
    }

    function ProjectBoard({ data, view, onViewChange }) {
      const p = data?.progress;
      const links = data?.links || {};
      const stageVals = [
        p?.newCreateNum,
        p?.requirementAnalysisNum,
        p?.projectApplicationNum,
        p?.projectPlanningNum,
        p?.designAndDevelopmentNum,
        p?.systemTestingNum,
        p?.acceptanceTestingNum,
        p?.regressionTestingNum,
        p?.releaseNum,
      ];
      const totalProj = p ? stageVals.reduce((acc, v) => acc + Number(v ?? 0), 0) : null;
      const delayCount = Number(p?.delayNum ?? 0);

      const pNode = (val, label, icon, style, linkUrl) => {
        const lit = Number(val ?? 0) > 0;
        return h(
          'div',
          {
            key: label,
            className: `heluo-wb-u-node${lit ? ' lit' : ''}${linkUrl ? ' heluo-wb-clickable' : ''}`,
            style,
            ...makePortalClickProps(linkUrl, `项目进展 · ${label}`),
          },
          h(
            'div',
            { className: 'heluo-wb-u-node-top' },
            h(DuotoneIcon, { name: icon, tone: lit ? 'blue' : 'muted', size: 14 }),
            h('span', { className: 'heluo-wb-u-node-num' }, formatNullable(val)),
          ),
          h('span', { className: 'heluo-wb-u-node-name' }, label),
        );
      };

      return h(
        'section',
        { 'aria-label': '项目进展板', style: { display: 'flex', flexDirection: 'column', gap: '9px' } },
        h(
          'div',
          { className: 'heluo-wb-prog-sub' },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
            h(
              'span',
              {
                className: links.total ? 'heluo-wb-clickable' : undefined,
                style: { display: 'inline-flex', alignItems: 'center', gap: '4px', fontWeight: 600, color: 'var(--wb-text)' },
                ...makePortalClickProps(links.total, '项目总数'),
              },
              h(DuotoneIcon, { name: 'folderProj', tone: 'blue' }),
              h('span', null, '总数'),
              h('strong', { style: { color: '#3B6CF5', fontFamily: 'var(--wb-mono)', fontSize: '13.5px' } }, formatNullable(totalProj)),
            ),
            h(
              'span',
              {
                className: links.delay ? 'heluo-wb-clickable' : undefined,
                style: { display: 'inline-flex', alignItems: 'center', gap: '4px', fontWeight: 600, color: delayCount > 0 ? '#DC2626' : 'var(--wb-text-muted)' },
                ...makePortalClickProps(links.delay, '延期项目'),
              },
              h(DuotoneIcon, { name: 'flame', tone: delayCount > 0 ? 'red' : 'muted' }),
              h('span', null, '延期'),
              h('strong', { style: { fontFamily: 'var(--wb-mono)', fontSize: '13.5px' } }, formatNullable(p?.delayNum)),
            ),
          ),
          h(SegmentedSwitch, {
            options: [
              { key: 'responsible', label: '我负责' },
              { key: 'participant', label: '我参与' },
            ],
            value: view,
            onChange: onViewChange,
            testIdPrefix: 'wb-proj-view',
          }),
        ),
        data?.errors?.length > 0
          ? h('div', { className: 'heluo-wb-banner heluo-wb-banner-warn', style: { margin: 0 } }, `项目进展加载受限：${data.errors[0].message}`)
          : null,
        h(
          'div',
          { className: 'heluo-wb-u-414' },
          h(
            'svg',
            { className: 'heluo-wb-u-rail', viewBox: '0 0 360 106', preserveAspectRatio: 'none', 'aria-hidden': 'true' },
            h('path', { d: 'M 36 25 H 302 C 322 25 332 37 332 53 C 332 69 322 81 302 81 H 36', stroke: '#CBD8F0', strokeWidth: 1.6, fill: 'none', strokeLinecap: 'round' }),
            h('polyline', { points: '148,21.5 153,25 148,28.5', stroke: '#6B9BF5', strokeWidth: 1.7, fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round' }),
            h('polyline', { points: '153,77.5 148,81 153,84.5', stroke: '#6B9BF5', strokeWidth: 1.7, fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round' }),
          ),
          pNode(p?.newCreateNum, '新建', 'filePlus', { gridColumn: '1', gridRow: '1' }, links.newCreate),
          pNode(p?.requirementAnalysisNum, '需分', 'searchDoc', { gridColumn: '2', gridRow: '1' }, links.requirementAnalysis),
          pNode(p?.projectApplicationNum, '立项', 'clipboard', { gridColumn: '3', gridRow: '1' }, links.projectApplication),
          pNode(p?.projectPlanningNum, '规划', 'compass', { gridColumn: '4', gridRow: '1' }, links.projectPlanning),
          pNode(p?.designAndDevelopmentNum, '设研', 'codeBox', { gridColumn: '5', gridRow: '1 / 3', justifySelf: 'center', width: '60px' }, links.designAndDevelopment),
          pNode(p?.releaseNum, '投产', 'flag', { gridColumn: '1', gridRow: '2' }, links.release),
          pNode(p?.regressionTestingNum, '回测', 'repeat', { gridColumn: '2', gridRow: '2' }, links.regressionTesting),
          pNode(p?.acceptanceTestingNum, '验测', 'checkCircle', { gridColumn: '3', gridRow: '2' }, links.acceptanceTesting),
          pNode(p?.systemTestingNum, '系测', 'flask', { gridColumn: '4', gridRow: '2' }, links.systemTesting),
        ),
      );
    }

    // §5.5 Shared Modals & Connection Settings
    function stateTagClass(name) {
      if (!name) return 'heluo-wb-tag-gray';
      if (/延期|超时|阻塞|失败|异常/.test(name)) return 'heluo-wb-tag-red';
      if (/完成|已发布|已验收|上线|已澄清/.test(name)) return 'heluo-wb-tag-green';
      if (/实施|进行|分析|评审|开发|测试/.test(name)) return 'heluo-wb-tag-blue';
      return 'heluo-wb-tag-gray';
    }

    function ConnectionSettingsForm({ onSaved, compact = false }) {
      const [apiBaseUrl, setApiBaseUrl] = useState('');
      const [placeholderUrl, setPlaceholderUrl] = useState('https://dop.corp.example');
      const [requestTimeoutMs, setRequestTimeoutMs] = useState('10000');
      const [configSource, setConfigSource] = useState('unconfigured');
      const [inheritedEnvKey, setInheritedEnvKey] = useState('');
      const [inheritedApiBaseUrl, setInheritedApiBaseUrl] = useState('');
      const [hasOverride, setHasOverride] = useState(false);
      const [loadingCfg, setLoadingCfg] = useState(true);
      const [savingCfg, setSavingCfg] = useState(false);
      const [okMsg, setOkMsg] = useState('');
      const [errMsg, setErrMsg] = useState('');

      const syncFromRes = (res) => {
        if (!res?.config) return;
        setApiBaseUrl(res.config.apiBaseUrl ?? '');
        setRequestTimeoutMs(String(res.config.requestTimeoutMs ?? 10000));
        if (res.placeholderApiBaseUrl) setPlaceholderUrl(res.placeholderApiBaseUrl);
        setConfigSource(res.configSource || 'unconfigured');
        setInheritedEnvKey(res.inheritedEnvKey || '');
        setInheritedApiBaseUrl(res.inheritedApiBaseUrl || '');
        setHasOverride(Boolean(res.hasOverride));
      };

      useEffect(() => {
        let alive = true;
        setLoadingCfg(true);
        workbenchApi.getConfig()
          .then((res) => {
            if (alive) syncFromRes(res);
          })
          .catch((e) => {
            if (alive) setErrMsg(e?.message || '读取连接配置失败');
          })
          .finally(() => {
            if (alive) setLoadingCfg(false);
          });
        return () => { alive = false; };
      }, []);

      const handleSave = async () => {
        setSavingCfg(true);
        setOkMsg('');
        setErrMsg('');
        try {
          const res = await workbenchApi.updateConfig({
            apiBaseUrl: apiBaseUrl.trim(),
            requestTimeoutMs: Number(requestTimeoutMs) || 10000,
          });
          syncFromRes(res);
          setOkMsg('连接配置已保存并立即生效');
          if (typeof onSaved === 'function') await onSaved(res);
        } catch (e) {
          setErrMsg(e?.message || '保存失败，请检查输入格式');
        } finally {
          setSavingCfg(false);
        }
      };

      const handleReset = async () => {
        setSavingCfg(true);
        setOkMsg('');
        setErrMsg('');
        try {
          const res = await workbenchApi.updateConfig({ resetToDefault: true });
          syncFromRes(res);
          setOkMsg(
            res?.inheritedApiBaseUrl
              ? `已清除本机覆写，恢复为继承地址 (${res.inheritedApiBaseUrl})`
              : '已清除本机覆写（如需切换内网，请填写地址或设置 HELUO_DOP_BASE_URL）',
          );
          if (typeof onSaved === 'function') await onSaved(res);
        } catch (e) {
          setErrMsg(e?.message || '恢复默认失败');
        } finally {
          setSavingCfg(false);
        }
      };

      const sourceLabel = (() => {
        if (configSource === 'local-override') return '本机覆写';
        if (configSource === 'plugin-config') return '企业包预置';
        if (configSource === 'env') return `环境变量 (${inheritedEnvKey || 'HELUO_DOP_BASE_URL'})`;
        return '未配置';
      })();

      return h(
        'div',
        { className: 'heluo-wb-cfg-wrap', 'data-testid': 'wb-connection-settings', style: compact ? { padding: '10px 12px' } : undefined },
        h(
          'div',
          { className: 'heluo-wb-cfg-head' },
          h(
            'div',
            null,
            h('h3', { className: 'heluo-wb-cfg-heading' }, '连接配置'),
            h(
              'p',
              { className: 'heluo-wb-cfg-sub', 'data-testid': 'wb-cfg-source' },
              `当前生效来源：${sourceLabel}${hasOverride && inheritedApiBaseUrl ? `（已覆写默认 ${inheritedApiBaseUrl}）` : ''}`,
            ),
          ),
        ),
        loadingCfg
          ? h('div', { className: 'heluo-wb-cfg-hint' }, '正在读取连接配置...')
          : h(
            React.Fragment,
            null,
            h(
              'div',
              { className: 'heluo-wb-cfg-field' },
              h('label', { className: 'heluo-wb-cfg-label' }, h('span', null, 'DOP 服务地址 (apiBaseUrl)')),
              h('input', {
                type: 'url',
                className: 'heluo-wb-cfg-input',
                'data-testid': 'wb-cfg-apiBaseUrl',
                placeholder: placeholderUrl,
                value: apiBaseUrl,
                onChange: (e) => setApiBaseUrl(e.target.value),
              }),
              h('span', { className: 'heluo-wb-cfg-hint' }, '公版默认不内置内网域名；内网可通过企业私版预置、环境变量 HELUO_DOP_BASE_URL（或 FORGE_DEVOPS_DOP_ENDPOINT）自动生效，也可在此保存热切换'),
            ),
            h(
              'div',
              { className: 'heluo-wb-cfg-field' },
              h('span', { className: 'heluo-wb-cfg-label' }, '认证方式'),
              h(
                'div',
                {
                  'data-testid': 'wb-cfg-auth-readonly',
                  style: {
                    padding: '7px 10px',
                    borderRadius: '8px',
                    background: '#F8FAFC',
                    border: '1px solid #E2E8F0',
                    fontSize: '12px',
                    color: '#334155',
                  },
                },
                '企业账号 (IAM) · 自动复用当前已登录的企业账号会话（与 @heluo/forge-iam 一致）',
              ),
            ),
            h(
              'div',
              { className: 'heluo-wb-cfg-field' },
              h('label', { className: 'heluo-wb-cfg-label' }, h('span', null, '请求超时（毫秒，1000–60000）')),
              h('input', {
                type: 'number',
                min: 1000,
                max: 60000,
                step: 500,
                className: 'heluo-wb-cfg-input',
                style: { maxWidth: '180px' },
                value: requestTimeoutMs,
                onChange: (e) => setRequestTimeoutMs(e.target.value),
              }),
            ),
            okMsg ? h('div', { className: 'heluo-wb-cfg-msg ok' }, okMsg) : null,
            errMsg ? h('div', { className: 'heluo-wb-cfg-msg err' }, errMsg) : null,
            h(
              'div',
              { className: 'heluo-wb-cfg-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'heluo-wb-cfg-btn',
                  disabled: savingCfg,
                  onClick: handleReset,
                },
                '恢复默认',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'heluo-wb-cfg-btn solid',
                  'data-testid': 'wb-cfg-save-btn',
                  disabled: savingCfg,
                  onClick: handleSave,
                },
                savingCfg ? '保存中...' : '保存并生效',
              ),
            ),
          ),
      );
    }

    function CustomPreferencesModal({ initialPrefs, onClose, onSave, onConfigUpdated, busy }) {
      const [modalTab, setModalTab] = useState('layout');
      const [prefs, setPrefs] = useState(() => ({
        rolePreset: initialPrefs.rolePreset,
        visibleBoards: [...initialPrefs.visibleBoards],
        boardOrder: [...initialPrefs.boardOrder],
        visibleDomains: [...initialPrefs.visibleDomains],
        domainOrder: [...initialPrefs.domainOrder],
      }));
      const [err, setErr] = useState('');

      const applyRole = async (role) => {
        if (role === 'custom') {
          setPrefs((prev) => ({ ...prev, rolePreset: 'custom' }));
          return;
        }
        try {
          const saved = await onSave({ rolePreset: role }, { closeAfter: false });
          if (saved) setPrefs(saved);
        } catch (e) {
          setErr(e.message);
        }
      };

      const toggleBoard = (key, checked) => {
        setPrefs((prev) => {
          const next = checked
            ? Array.from(new Set([...prev.visibleBoards, key]))
            : prev.visibleBoards.filter((k) => k !== key);
          return { ...prev, rolePreset: 'custom', visibleBoards: next };
        });
      };

      const toggleDomain = (key, checked) => {
        setPrefs((prev) => {
          const next = checked
            ? Array.from(new Set([...prev.visibleDomains, key]))
            : prev.visibleDomains.filter((k) => k !== key);
          if (next.length === 0) return prev;
          return { ...prev, rolePreset: 'custom', visibleDomains: next };
        });
      };

      const moveDomain = (idx, delta) => {
        setPrefs((prev) => {
          const target = idx + delta;
          if (target < 0 || target >= prev.domainOrder.length) return prev;
          const next = [...prev.domainOrder];
          [next[idx], next[target]] = [next[target], next[idx]];
          return { ...prev, rolePreset: 'custom', domainOrder: next };
        });
      };

      return h(
        'div',
        { className: 'heluo-wb-modal-backdrop', role: 'dialog', 'aria-modal': 'true', 'aria-label': '定制工作台' },
        h('style', { id: 'heluo-forge-devops-workbench-cfg-style' }, CFG_CSS),
        h(
          'div',
          { className: 'heluo-wb-modal' },
          h(
            'div',
            { className: 'heluo-wb-modal-head' },
            h('span', null, '工作台设置'),
            h('button', { type: 'button', className: 'heluo-wb-modal-close', onClick: onClose, 'aria-label': '关闭' }, '✕'),
          ),
          h(
            'div',
            { className: 'heluo-wb-modal-body' },
            h(
              'div',
              { className: 'heluo-wb-subtabs', role: 'tablist' },
              h(
                'button',
                { type: 'button', className: `heluo-wb-subtab${modalTab === 'layout' ? ' active' : ''}`, onClick: () => setModalTab('layout') },
                '布局定制',
              ),
              h(
                'button',
                { type: 'button', className: `heluo-wb-subtab${modalTab === 'connection' ? ' active' : ''}`, onClick: () => setModalTab('connection') },
                '连接设置',
              ),
            ),
            modalTab === 'connection'
              ? h(ConnectionSettingsForm, { compact: true, onSaved: onConfigUpdated })
              : h(
                React.Fragment,
                null,
                h(
                  'div',
                  null,
                  h('div', { className: 'heluo-wb-cfg-title' }, h('span', null, '角色预设')),
                  h(
                    'div',
                    { className: 'heluo-wb-role-grid' },
                    Object.entries(ROLE_LABELS).map(([k, lbl]) =>
                      h(
                        'button',
                        {
                          key: k,
                          type: 'button',
                          className: `heluo-wb-role-chip${prefs.rolePreset === k ? ' active' : ''}`,
                          onClick: () => applyRole(k),
                        },
                        lbl,
                      ),
                    ),
                  ),
                ),
                h(
                  'div',
                  null,
                  h('div', { className: 'heluo-wb-cfg-title' }, h('span', null, '显示进展板')),
                  h(
                    'div',
                    { style: { display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '6px' } },
                    Object.entries(BOARD_LABELS).map(([k, lbl]) =>
                      h(
                        'label',
                        {
                          key: k,
                          style: {
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '5px',
                            fontSize: '12px',
                            padding: '7px 6px',
                            borderRadius: '8px',
                            border: '1px solid var(--wb-border)',
                            background: prefs.visibleBoards.includes(k) ? '#EFF4FF' : '#FAFBFD',
                            cursor: 'pointer',
                          },
                        },
                        h('input', {
                          type: 'checkbox',
                          checked: prefs.visibleBoards.includes(k),
                          onChange: (e) => toggleBoard(k, e.target.checked),
                        }),
                        lbl,
                      ),
                    ),
                  ),
                ),
                h(
                  'div',
                  null,
                  h('div', { className: 'heluo-wb-cfg-title' }, h('span', null, '领域页签显示与排序（至少保留 1 项）')),
                  h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: '5px' } },
                    prefs.domainOrder.map((key, idx) => {
                      const meta = DOMAIN_TABS.find((d) => d.key === key);
                      return h(
                        'div',
                        {
                          key,
                          className: 'heluo-wb-card-hdr',
                          style: { padding: '6px 9px', borderRadius: '8px', background: '#F8FAFC', border: '1px solid var(--wb-border)' },
                        },
                        h(
                          'label',
                          { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12.5px', fontWeight: 500 } },
                          h('input', {
                            type: 'checkbox',
                            checked: prefs.visibleDomains.includes(key),
                            onChange: (e) => toggleDomain(key, e.target.checked),
                          }),
                          meta?.label || key,
                        ),
                        h(
                          'div',
                          { style: { display: 'flex', gap: '4px' } },
                          h('button', { type: 'button', className: 'heluo-wb-btn-sm', disabled: idx === 0, onClick: () => moveDomain(idx, -1) }, '↑'),
                          h('button', { type: 'button', className: 'heluo-wb-btn-sm', disabled: idx === prefs.domainOrder.length - 1, onClick: () => moveDomain(idx, 1) }, '↓'),
                        ),
                      );
                    }),
                  ),
                ),
                err ? h('div', { className: 'heluo-wb-banner heluo-wb-banner-err', style: { margin: 0 } }, err) : null,
              ),
          ),
          modalTab === 'layout'
            ? h(
              'div',
              { className: 'heluo-wb-modal-foot' },
              h('button', { type: 'button', className: 'heluo-wb-btn-sm', onClick: onClose }, '取消'),
              h(
                'button',
                {
                  type: 'button',
                  className: 'heluo-wb-btn-sm solid',
                  disabled: busy,
                  onClick: async () => {
                    try {
                      await onSave(prefs, { closeAfter: true });
                    } catch (e) {
                      setErr(e.message);
                    }
                  },
                },
                busy ? '保存中...' : '保存设置',
              ),
            )
            : h(
              'div',
              { className: 'heluo-wb-modal-foot' },
              h('button', { type: 'button', className: 'heluo-wb-btn-sm', onClick: onClose }, '关闭'),
            ),
        ),
      );
    }

    function PromptConfirmModal({ result, draftBridge, onClose, onDelivered }) {
      const [editedPrompt, setEditedPrompt] = useState(result.prompt);
      const [copyFeedback, setCopyFeedback] = useState('');
      const meta = result.meta || {};

      const handleDeliverDraft = (mode) => {
        const outcome = draftBridge.writeDraft(editedPrompt, mode);
        if (outcome.ok) {
          onDelivered('已写入当前会话草稿箱（未自动发送）');
        }
      };

      const handleCopy = async () => {
        const ok = await copyTextToClipboard(editedPrompt);
        setCopyFeedback(ok ? '已复制到剪贴板，请自行粘贴发送' : '剪贴板权限受限，请全选手动复制');
      };

      return h(
        'div',
        { className: 'heluo-wb-modal-backdrop', role: 'dialog', 'aria-modal': 'true', 'aria-label': '提示词二次确认' },
        h(
          'div',
          { className: 'heluo-wb-modal' },
          h(
            'div',
            { className: 'heluo-wb-modal-head' },
            h('span', null, `二次确认 · ${meta.title || '工程提示词'}`),
            h('button', { type: 'button', className: 'heluo-wb-modal-close', onClick: onClose, 'aria-label': '关闭' }, '✕'),
          ),
          h(
            'div',
            { className: 'heluo-wb-modal-body' },
            h(
              'div',
              { className: 'heluo-wb-item-meta' },
              h('span', { className: 'heluo-wb-tag heluo-wb-tag-blue' }, `来源：${meta.sourceSummary || '--'}`),
              h('span', { className: 'heluo-wb-tag heluo-wb-tag-gray' }, `长度：${editedPrompt.length} 字符`),
              meta.truncated ? h('span', { className: 'heluo-wb-tag heluo-wb-tag-amber' }, '已触发 16 KiB 截断') : null,
            ),
            meta.warnings?.length > 0
              ? h('div', { className: 'heluo-wb-banner heluo-wb-banner-warn', style: { margin: 0 } }, meta.warnings.join('；'))
              : null,
            h('textarea', {
              className: 'heluo-wb-textarea',
              style: { minHeight: '200px' },
              value: editedPrompt,
              onChange: (e) => setEditedPrompt(e.target.value),
            }),
            copyFeedback ? h('div', { className: 'heluo-wb-banner', style: { margin: 0 } }, copyFeedback) : null,
            !draftBridge.canWriteDraft
              ? h('div', { className: 'heluo-wb-banner', style: { margin: 0 } }, '当前宿主视图未暴露直写草稿接口，请使用「复制提示词」后粘贴至对话输入框。')
              : null,
          ),
          h(
            'div',
            { className: 'heluo-wb-modal-foot' },
            h('button', { type: 'button', className: 'heluo-wb-btn-sm', onClick: onClose }, '取消'),
            h('button', { type: 'button', className: 'heluo-wb-btn-sm', onClick: handleCopy, 'data-testid': 'wb-copy-prompt-btn' }, '复制提示词'),
            draftBridge.canWriteDraft
              ? h('button', { type: 'button', className: 'heluo-wb-btn-sm', onClick: () => handleDeliverDraft('append') }, '追加到草稿')
              : null,
            draftBridge.canWriteDraft
              ? h('button', { type: 'button', className: 'heluo-wb-btn-sm solid', onClick: () => handleDeliverDraft('replace') }, '写入草稿（不自动发送）')
              : null,
          ),
        ),
      );
    }

    // §6.1 Requirement Domain & Modals
    function RequirementDomain({
      reqData,
      subTab,
      onSubTabChange,
      reqListView,
      search,
      onSearchChange,
      onSearchSubmit,
      onReqListViewChange,
      onOpenOneSentence,
      onOpenDocModal,
      onTriggerReqAction,
      onTriggerStoryAction,
      loading,
    }) {
      const reqItems = Array.isArray(reqData?.requirements?.items) ? reqData.requirements.items : [];
      const storyItems = Array.isArray(reqData?.stories?.items) ? reqData.stories.items : [];
      const reqTotal = reqData?.requirements?.totalItems ?? reqItems.length;
      const storyTotal = reqData?.stories?.totalItems ?? storyItems.length;

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '9px' } },
        h(
          'div',
          { className: 'heluo-wb-quick-grid' },
          h(
            'button',
            {
              type: 'button',
              className: 'heluo-wb-quick-btn',
              onClick: onOpenOneSentence,
              'data-testid': 'wb-one-sentence-btn',
            },
            '+ 一句话新建需求',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'heluo-wb-quick-btn',
              onClick: onOpenDocModal,
              'data-testid': 'wb-doc-clarify-btn',
            },
            '已有文档澄清',
          ),
        ),
        h(
          'div',
          { className: 'heluo-wb-subtabs', role: 'tablist', 'aria-label': '需求子页签' },
          h(
            'button',
            {
              type: 'button',
              role: 'tab',
              'aria-selected': subTab === 'reqs',
              'data-testid': 'wb-subtab-reqs',
              className: `heluo-wb-subtab${subTab === 'reqs' ? ' active' : ''}`,
              onClick: () => onSubTabChange('reqs'),
            },
            `我的需求 (${reqTotal})`,
          ),
          h(
            'button',
            {
              type: 'button',
              role: 'tab',
              'aria-selected': subTab === 'stories',
              'data-testid': 'wb-subtab-stories',
              className: `heluo-wb-subtab${subTab === 'stories' ? ' active' : ''}`,
              onClick: () => onSubTabChange('stories'),
            },
            `我的用户故事 (${storyTotal})`,
          ),
        ),
        subTab === 'reqs'
          ? h(
            React.Fragment,
            null,
            h(
              'div',
              { className: 'heluo-wb-filter-bar' },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px', flexWrap: 'wrap' } },
                h(SegmentedSwitch, {
                  options: [
                    { key: 'managedByMe', label: '我负责' },
                    { key: 'acceptanceByMe', label: '待我验收' },
                    { key: 'appliedByMe', label: '我申请' },
                    { key: 'participantHasMe', label: '我参与' },
                  ],
                  value: reqListView,
                  onChange: onReqListViewChange,
                  testIdPrefix: 'wb-myreq-view',
                }),
              ),
              h(
                'div',
                { className: 'heluo-wb-search-row' },
                h('input', {
                  type: 'search',
                  className: 'heluo-wb-input',
                  placeholder: '按需求号或标题检索...',
                  value: search,
                  onChange: (e) => onSearchChange(e.target.value),
                  onKeyDown: (e) => {
                    if (e.key === 'Enter') onSearchSubmit();
                  },
                }),
                h('button', { type: 'button', className: 'heluo-wb-btn-sm', style: { height: '30px' }, onClick: onSearchSubmit, disabled: loading }, '搜索'),
              ),
            ),
            reqItems.length === 0
              ? h('div', { className: 'heluo-wb-empty' }, '当前视角暂无需求记录')
              : reqItems.map((req) => {
                const stateLabel = `${req.stage?.name ?? '--'} · ${req.state?.name ?? '--'}`;
                return h(
                  'div',
                  { key: req.requirementId || req.requirementNo, className: 'heluo-wb-item' },
                  h(
                    'div',
                    { className: 'heluo-wb-item-top' },
                    req.portalUrl
                      ? h(
                        'a',
                        {
                          href: sanitizePortalHref(req.portalUrl) || '#',
                          target: '_blank',
                          rel: 'noopener noreferrer',
                          className: 'heluo-wb-link heluo-wb-item-code',
                          onClick: (e) => {
                            e.preventDefault();
                            openExternalUrl(req.portalUrl);
                          },
                        },
                        req.requirementNo || req.requirementId,
                        ' ↗',
                      )
                      : h('span', { className: 'heluo-wb-item-code' }, req.requirementNo || req.requirementId),
                    h('span', { className: `heluo-wb-tag ${stateTagClass(req.state?.name || req.stage?.name)}` }, stateLabel),
                  ),
                  h('div', { className: 'heluo-wb-item-title' }, req.requirementName || '未命名需求'),
                  h(
                    'div',
                    { className: 'heluo-wb-item-meta' },
                    req.projectName ? h('span', { className: 'heluo-wb-tag heluo-wb-tag-gray' }, req.projectName) : null,
                    req.managerUser?.name ? h('span', { className: 'heluo-wb-tag heluo-wb-tag-blue' }, `经理: ${req.managerUser.name}`) : null,
                    req.businessOwnerUser?.name ? h('span', { className: 'heluo-wb-tag heluo-wb-tag-purple' }, `业务: ${req.businessOwnerUser.name}`) : null,
                  ),
                  h(
                    'div',
                    { className: 'heluo-wb-item-actions' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'heluo-wb-btn-sm primary',
                        onClick: () => onTriggerReqAction(req.requirementId, 'split'),
                      },
                      '拆解用户故事',
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'heluo-wb-btn-sm',
                        onClick: () => onTriggerReqAction(req.requirementId, 'qa'),
                      },
                      '需求问答',
                    ),
                    req.portalUrl
                      ? h(
                        'button',
                        {
                          type: 'button',
                          className: 'heluo-wb-sso-link',
                          'data-testid': 'wb-open-req-portal',
                          onClick: () => openExternalUrl(req.portalUrl),
                        },
                        'DOP ↗',
                      )
                      : null,
                  ),
                );
              }),
          )
          : (storyItems.length === 0
            ? h('div', { className: 'heluo-wb-empty' }, '暂无待处理用户故事')
            : storyItems.map((st) => {
              const delayed = Boolean(st.scheduleDelay || st.releaseDelay);
              const stateText = st.state?.name ?? '--';
              return h(
                'div',
                { key: st.id || st.code, className: 'heluo-wb-item' },
                h(
                  'div',
                  { className: 'heluo-wb-item-top' },
                  st.portalUrl
                    ? h(
                      'a',
                      {
                        href: sanitizePortalHref(st.portalUrl) || '#',
                        target: '_blank',
                        rel: 'noopener noreferrer',
                        className: 'heluo-wb-link heluo-wb-item-code',
                        onClick: (e) => {
                          e.preventDefault();
                          openExternalUrl(st.portalUrl);
                        },
                      },
                      st.code || st.id,
                      ' ↗',
                    )
                    : h('span', { className: 'heluo-wb-item-code' }, st.code || st.id),
                  h('span', { className: `heluo-wb-tag ${delayed ? 'heluo-wb-tag-red' : stateTagClass(stateText)}` }, stateText),
                ),
                h('div', { className: 'heluo-wb-item-title' }, st.summary || '未命名故事'),
                h(
                  'div',
                  { className: 'heluo-wb-item-meta' },
                  st.assignee?.name ? h('span', { className: 'heluo-wb-tag heluo-wb-tag-blue' }, `经办: ${st.assignee.name}`) : null,
                  st.planOnlineDate ? h('span', { className: 'heluo-wb-tag heluo-wb-tag-gray' }, `计划上线: ${String(st.planOnlineDate).slice(0, 10)}`) : null,
                  delayed ? h('span', { className: 'heluo-wb-tag heluo-wb-tag-red' }, st.scheduleDelay ? '排期延期' : '发布延期') : null,
                ),
                h(
                  'div',
                  { className: 'heluo-wb-item-actions' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'heluo-wb-btn-sm primary',
                      onClick: () => onTriggerStoryAction(st.id || st.code),
                    },
                    'AC / 设计澄清',
                  ),
                  st.portalUrl
                    ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'heluo-wb-sso-link',
                        'data-testid': 'wb-open-story-portal',
                        onClick: () => openExternalUrl(st.portalUrl),
                      },
                      'DOP ↗',
                    )
                    : null,
                ),
              );
            })),
      );
    }

    function OneSentenceModal({ onClose, onGenerate, busy }) {
      const [idea, setIdea] = useState('');
      const [err, setErr] = useState('');
      const handleSubmit = async () => {
        if (!idea.trim()) {
          setErr('请输入初步业务想法');
          return;
        }
        setErr('');
        await onGenerate(idea.trim());
      };
      return h(
        'div',
        { className: 'heluo-wb-modal-backdrop', role: 'dialog', 'aria-modal': 'true', 'aria-label': '一句话新建需求' },
        h(
          'div',
          { className: 'heluo-wb-modal' },
          h(
            'div',
            { className: 'heluo-wb-modal-head' },
            h('span', null, '一句话新建需求'),
            h('button', { type: 'button', className: 'heluo-wb-modal-close', onClick: onClose, 'aria-label': '关闭' }, '✕'),
          ),
          h(
            'div',
            { className: 'heluo-wb-modal-body' },
            h('p', { style: { margin: 0, fontSize: '12.5px', color: 'var(--wb-text-sub)' } }, '描述你想发起的业务诉求（不超过 2,000 字），系统将构造标准化澄清提示词交由你确认后填入对话。'),
            h('textarea', {
              className: 'heluo-wb-textarea',
              maxLength: 2000,
              placeholder: '例如：需要为企业协同平台新增日终报表导出与异常提醒功能...',
              value: idea,
              onChange: (e) => setIdea(e.target.value),
            }),
            h('div', { style: { fontSize: '11.5px', color: 'var(--wb-text-muted)' } }, `${idea.length} / 2000 字符`),
            err ? h('div', { className: 'heluo-wb-banner heluo-wb-banner-err', style: { margin: 0 } }, err) : null,
          ),
          h(
            'div',
            { className: 'heluo-wb-modal-foot' },
            h('button', { type: 'button', className: 'heluo-wb-btn-sm', onClick: onClose }, '取消'),
            h('button', { type: 'button', className: 'heluo-wb-btn-sm solid', onClick: handleSubmit, disabled: busy }, busy ? '生成中...' : '生成澄清提示词'),
          ),
        ),
      );
    }

    function DocClarifyModal({ onClose, onBuildPrompt, busy }) {
      const [mode, setMode] = useState('rmp');
      const [quickSearch, setQuickSearch] = useState('');
      const [latestOnly, setLatestOnly] = useState(true);
      const [docs, setDocs] = useState([]);
      const [selectedDoc, setSelectedDoc] = useState(null);
      const [outline, setOutline] = useState([]);
      const [selectedIids, setSelectedIids] = useState([]);
      const [localFileName, setLocalFileName] = useState('');
      const [localContent, setLocalContent] = useState('');
      const [statusErr, setStatusErr] = useState('');
      const [searching, setSearching] = useState(false);

      const doSearch = useCallback(async () => {
        setSearching(true);
        setStatusErr('');
        try {
          const res = await workbenchApi.searchRmpDocs({ quickSearch, latestOnly });
          setDocs(Array.isArray(res?.items) ? res.items : []);
        } catch (err) {
          setStatusErr(err.message);
        } finally {
          setSearching(false);
        }
      }, [quickSearch, latestOnly]);

      useEffect(() => {
        if (mode === 'rmp') void doSearch();
      }, [mode, doSearch]);

      const loadOutline = async (doc) => {
        setSelectedDoc(doc);
        setOutline([]);
        setSelectedIids([]);
        setStatusErr('');
        try {
          const res = await workbenchApi.getRmpOutline({ docId: doc.docid || doc.iid });
          setOutline(Array.isArray(res?.nodes) ? res.nodes : []);
        } catch (err) {
          setStatusErr(err.message);
        }
      };

      const toggleNode = (nodeId) => {
        setSelectedIids((prev) => {
          if (prev.includes(nodeId)) return prev.filter((x) => x !== nodeId);
          if (prev.length >= 12) return prev;
          return [...prev, nodeId];
        });
      };

      const handleLocalFile = (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setLocalFileName(file.name);
        const reader = new globalThis.FileReader();
        reader.onload = () => {
          const text = String(reader.result ?? '').slice(0, 32000);
          setLocalContent(text);
        };
        reader.onerror = () => setStatusErr('读取本地文件失败');
        reader.readAsText(file, 'utf-8');
      };

      const handleGenerate = async () => {
        setStatusErr('');
        if (mode === 'local') {
          if (!localFileName || !localContent.trim()) {
            setStatusErr('请先选择一个非空文本或 Markdown 文件');
            return;
          }
          await onBuildPrompt({
            actionKey: 'req.clarify.from_doc',
            source: 'local',
            fileName: localFileName,
            content: localContent,
          });
          return;
        }
        if (!selectedDoc || selectedIids.length === 0) {
          setStatusErr('请先在 RMP 列表选中文档并勾选至少 1 个章节节点');
          return;
        }
        const chosen = outline.filter((n) => selectedIids.includes(String(n.idoc_id || n.doc_outline_id)));
        await onBuildPrompt({
          actionKey: 'req.clarify.from_doc',
          source: 'rmp',
          docId: selectedDoc.docid || selectedDoc.iid,
          docName: selectedDoc.docname,
          docVer: selectedDoc.docver,
          sections: chosen.map((n) => ({
            iid: n.idoc_id || n.doc_outline_id,
            scode: n.scode,
            sname: n.sname,
          })),
        });
      };

      return h(
        'div',
        { className: 'heluo-wb-modal-backdrop', role: 'dialog', 'aria-modal': 'true', 'aria-label': '已有文档澄清' },
        h(
          'div',
          { className: 'heluo-wb-modal' },
          h(
            'div',
            { className: 'heluo-wb-modal-head' },
            h('span', null, '已有文档澄清'),
            h('button', { type: 'button', className: 'heluo-wb-modal-close', onClick: onClose, 'aria-label': '关闭' }, '✕'),
          ),
          h(
            'div',
            { className: 'heluo-wb-modal-body' },
            h(
              'div',
              { className: 'heluo-wb-subtabs' },
              h(
                'button',
                { type: 'button', className: `heluo-wb-subtab${mode === 'rmp' ? ' active' : ''}`, onClick: () => setMode('rmp') },
                '需求管理平台（RMP）',
              ),
              h(
                'button',
                { type: 'button', className: `heluo-wb-subtab${mode === 'local' ? ' active' : ''}`, onClick: () => setMode('local') },
                '本地文件上传',
              ),
            ),
            statusErr ? h('div', { className: 'heluo-wb-banner heluo-wb-banner-err', style: { margin: 0 } }, statusErr) : null,
            mode === 'rmp'
              ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
                h(
                  'div',
                  { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
                  h('input', {
                    type: 'search',
                    className: 'heluo-wb-input',
                    style: { flex: 1 },
                    placeholder: '搜索文档名称或编号...',
                    value: quickSearch,
                    onChange: (e) => setQuickSearch(e.target.value),
                  }),
                  h(
                    'label',
                    { style: { display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '12px' } },
                    h('input', { type: 'checkbox', checked: latestOnly, onChange: (e) => setLatestOnly(e.target.checked) }),
                    '仅最新版',
                  ),
                  h('button', { type: 'button', className: 'heluo-wb-btn-sm', style: { height: '30px' }, onClick: doSearch, disabled: searching }, searching ? '检索中...' : '检索'),
                ),
                h(
                  'div',
                  { style: { maxHeight: '140px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' } },
                  docs.map((doc) =>
                    h(
                      'button',
                      {
                        key: doc.docid || doc.code,
                        type: 'button',
                        className: 'heluo-wb-btn-sm',
                        style: {
                          justifyContent: 'space-between',
                          height: '30px',
                          borderColor: selectedDoc?.docid === doc.docid ? '#3B6CF5' : undefined,
                          background: selectedDoc?.docid === doc.docid ? '#EFF4FF' : '#FFFFFF',
                        },
                        onClick: () => loadOutline(doc),
                      },
                      h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, `${doc.docname} (v${doc.docver || '--'})`),
                      h(
                        'span',
                        { style: { display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '11px' } },
                        h('span', { style: { color: 'var(--wb-text-muted)' } }, doc.docstatus || ''),
                        doc.portalUrl
                          ? h(
                            'a',
                            {
                              href: sanitizePortalHref(doc.portalUrl) || '#',
                              target: '_blank',
                              rel: 'noopener noreferrer',
                              className: 'heluo-wb-link',
                              onClick: (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                openExternalUrl(doc.portalUrl);
                              },
                            },
                            '原文 ↗',
                          )
                          : null,
                      ),
                    ),
                  ),
                ),
                selectedDoc
                  ? h(
                    'div',
                    { className: 'heluo-wb-card', style: { background: '#F8FAFC' } },
                    h('strong', { style: { fontSize: '12px' } }, `已选《${selectedDoc.docname}》大纲（已勾选 ${selectedIids.length}/12）`),
                    outline.length === 0
                      ? h('div', { style: { fontSize: '12px', color: 'var(--wb-text-muted)' } }, '暂无章节节点')
                      : outline.map((node) => {
                        const nid = String(node.idoc_id || node.doc_outline_id);
                        return h(
                          'label',
                          { key: nid, style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' } },
                          h('input', {
                            type: 'checkbox',
                            checked: selectedIids.includes(nid),
                            onChange: () => toggleNode(nid),
                          }),
                          h('span', null, `${node.scode || ''} ${node.sname || ''}`),
                        );
                      }),
                  )
                  : null,
              )
              : h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
                h('input', { type: 'file', accept: '.txt,.md,.markdown,.json,.csv,.html,.xml', onChange: handleLocalFile }),
                localFileName ? h('div', { style: { fontSize: '12px', color: 'var(--wb-text-sub)' } }, `已读取《${localFileName}》（${localContent.length} 字符，注入上限 16 KiB）`) : null,
              ),
          ),
          h(
            'div',
            { className: 'heluo-wb-modal-foot' },
            h('button', { type: 'button', className: 'heluo-wb-btn-sm', onClick: onClose }, '取消'),
            h('button', { type: 'button', className: 'heluo-wb-btn-sm solid', onClick: handleGenerate, disabled: busy }, busy ? '读取正文中...' : '生成澄清提示词'),
          ),
        ),
      );
    }

    // §6.2 Project Domain (Phase 2 Reserved)
    // 二期「项目」域视图组件与专属弹窗占位：请仅在此区块编写并在 §6.6 注册 project。

    // §6.3 Dev Domain (Phase 2 Reserved)
    // 二期「研发」域视图组件与专属弹窗占位：请仅在此区块编写并在 §6.6 注册 dev。

    // §6.4 Efficiency Domain (Phase 2 Reserved)
    // 二期「效能」域视图组件与专属弹窗占位：请仅在此区块编写并在 §6.6 注册 efficiency。

    // §6.5 Testing Domain (Phase 2 Reserved)
    // 二期「测试」域视图组件与专属弹窗占位：请仅在此区块编写并在 §6.6 注册 test。

    // §6.6 Domain View Registry
    function renderPhase2Placeholder(t) {
      return h('div', { className: 'heluo-wb-card', 'data-testid': 'wb-phase2-placeholder' }, t('phase2Notice'));
    }

    const DOMAIN_VIEW_RENDERERS = {
      requirement(ctx) {
        return h(RequirementDomain, {
          reqData: ctx.reqData,
          subTab: ctx.reqSubTab,
          onSubTabChange: ctx.setReqSubTab,
          reqListView: ctx.reqListView,
          search: ctx.reqSearch,
          onSearchChange: ctx.setReqSearch,
          onSearchSubmit: () => ctx.loadAll(),
          onReqListViewChange: ctx.setReqListView,
          onOpenOneSentence: () => ctx.setShowOneSentence(true),
          onOpenDocModal: () => ctx.setShowDocModal(true),
          onTriggerReqAction: (requirementId, mode) =>
            ctx.handleBuildPrompt({ actionKey: 'req.card.clarify_and_split', requirementId, mode }),
          onTriggerStoryAction: (storyId) =>
            ctx.handleBuildPrompt({ actionKey: 'story.card.design_and_prep', storyId }),
          loading: ctx.loading,
        });
      },
    };

    // §7 Workbench Root & Fallback Drawer
    function WorkbenchRoot(props) {
      const {
        ctx,
        sessionId = null,
        getHostServices = null,
        fallbackMode = false,
        onCloseFallback,
      } = props;
      const t = useMemo(() => {
        if (typeof ctx?.locale?.bind === 'function') {
          return ctx.locale.bind(NS);
        }
        return (k) => zh[k] ?? k;
      }, [ctx]);

      const [bootstrap, setBootstrap] = useState(null);
      const [summary, setSummary] = useState(null);
      const [reqData, setReqData] = useState(null);
      const [loading, setLoading] = useState(true);
      const [busyAction, setBusyAction] = useState(false);
      const [globalError, setGlobalError] = useState('');
      const [notice, setNotice] = useState('');

      const [showTodos, setShowTodos] = useState(false);
      const [showCustomize, setShowCustomize] = useState(false);
      const [showOneSentence, setShowOneSentence] = useState(false);
      const [showDocModal, setShowDocModal] = useState(false);
      const [pendingPrompt, setPendingPrompt] = useState(null);

      const [activeBoardTab, setActiveBoardTab] = useState('requirement');
      const [progressCollapsed, setProgressCollapsed] = useState(false);
      const [reqView, setReqView] = useState('manager');
      const [implView, setImplView] = useState('responsible');
      const [projView, setProjView] = useState('responsible');
      const [activeDomain, setActiveDomain] = useState('requirement');
      const [reqSubTab, setReqSubTab] = useState('reqs');
      const [reqListView, setReqListView] = useState('managedByMe');
      const [reqSearch, setReqSearch] = useState('');

      const summarySeqRef = useRef(0);
      const summaryAbortRef = useRef(null);

      useEffect(() => {
        if (!showTodos || typeof document === 'undefined') return undefined;
        const onDocDown = (e) => {
          if (e.target && typeof e.target.closest === 'function' && !e.target.closest('.heluo-wb-todo-wrap')) {
            setShowTodos(false);
          }
        };
        document.addEventListener('mousedown', onDocDown);
        return () => document.removeEventListener('mousedown', onDocDown);
      }, [showTodos]);

      const loadAll = useCallback(async ({ refresh = false } = {}) => {
        setLoading(true);
        setGlobalError('');
        try {
          const boot = await workbenchApi.getBootstrap(refresh ? { query: { refresh: '1' } } : {});
          setBootstrap(boot);
          if (!boot?.ready) {
            setSummary(null);
            setReqData(null);
            setLoading(false);
            return;
          }
          const mySeq = ++summarySeqRef.current;
          if (summaryAbortRef.current) summaryAbortRef.current.abort();
          const ac = new AbortController();
          summaryAbortRef.current = ac;

          const [sumRes, reqRes] = await Promise.all([
            workbenchApi.getSummary(
              { reqView, implView, projView, ...(refresh ? { refresh: '1' } : {}) },
              { signal: ac.signal },
            ),
            workbenchApi.getRequirements(
              { view: reqListView, search: reqSearch },
              { signal: ac.signal },
            ),
          ]);
          if (mySeq === summarySeqRef.current) {
            setSummary(sumRes);
            setReqData(reqRes);
          }
        } catch (err) {
          if (err?.name !== 'AbortError') {
            setGlobalError(err?.message || '工作台加载失败');
          }
        } finally {
          setLoading(false);
        }
      }, [reqView, implView, projView, reqListView, reqSearch]);

      useEffect(() => {
        void loadAll();
        return () => {
          if (summaryAbortRef.current) summaryAbortRef.current.abort();
        };
      }, [reqView, implView, projView, reqListView]);

      const prefs = bootstrap?.preferences || {
        rolePreset: 'req_mgr',
        visibleBoards: ['requirement', 'implementation', 'project'],
        boardOrder: ['requirement', 'implementation', 'project'],
        visibleDomains: ['requirement', 'project', 'dev', 'efficiency', 'test'],
        domainOrder: ['requirement', 'project', 'dev', 'efficiency', 'test'],
      };

      const hostServices = typeof getHostServices === 'function' ? getHostServices() : {};
      const resolvedSessionId = sessionId ?? hostServices.activeSessionId ?? null;
      const draftBridge = useMemo(
        () => resolveDraftBridge({
          ctx,
          conversation: hostServices.conversation,
          sessions: hostServices.sessions,
          sessionId: resolvedSessionId,
        }),
        [ctx, hostServices.conversation, hostServices.sessions, resolvedSessionId],
      );

      const handleSavePreferences = async (patch, { closeAfter = true } = {}) => {
        setBusyAction(true);
        try {
          const res = await workbenchApi.savePreferences(patch);
          setBootstrap((prev) => (prev ? { ...prev, preferences: res.preferences } : prev));
          if (closeAfter) setShowCustomize(false);
          return res.preferences;
        } finally {
          setBusyAction(false);
        }
      };

      const handleBuildPrompt = async (payload) => {
        setBusyAction(true);
        setGlobalError('');
        try {
          const result = await workbenchApi.buildPrompt(payload);
          setShowOneSentence(false);
          setShowDocModal(false);
          setPendingPrompt(result);
        } catch (err) {
          setGlobalError(err?.message || '生成提示词失败');
        } finally {
          setBusyAction(false);
        }
      };

      const renderNotReady = () => {
        const isConfigMissing = bootstrap?.reason === 'CONFIG_MISSING';
        return h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
          h(
            'div',
            { className: 'heluo-wb-card', 'data-testid': 'wb-fail-closed-card' },
            h('strong', null, isConfigMissing ? t('configMissingTitle') : t('unauthorizedTitle')),
            h('p', { style: { margin: 0, fontSize: '12px', color: 'var(--wb-text-sub)' } },
              isConfigMissing ? t('configMissingDesc') : (bootstrap?.error?.message || t('unauthorizedDesc'))),
            h(
              'div',
              { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
              h('button', { type: 'button', className: 'heluo-wb-btn-sm solid', onClick: () => loadAll({ refresh: true }) }, t('retry')),
              h('button', { type: 'button', className: 'heluo-wb-btn-sm', onClick: () => setShowCustomize(true) }, '打开连接设置'),
            ),
          ),
          h('style', { id: 'heluo-forge-devops-workbench-cfg-style' }, CFG_CSS),
          h(ConnectionSettingsForm, { compact: true, onSaved: () => loadAll({ refresh: true }) }),
        );
      };

      const orderedVisibleBoards = prefs.boardOrder.filter((k) => prefs.visibleBoards.includes(k));
      const orderedVisibleDomains = prefs.domainOrder.filter((k) => prefs.visibleDomains.includes(k));
      const effectiveBoardTab = orderedVisibleBoards.includes(activeBoardTab)
        ? activeBoardTab
        : (orderedVisibleBoards[0] || null);
      const effectiveDomain = orderedVisibleDomains.includes(activeDomain)
        ? activeDomain
        : (orderedVisibleDomains[0] || 'requirement');

      const renderActiveBoard = () => {
        if (effectiveBoardTab === 'requirement') {
          return h(RequirementBoard, {
            data: summary?.boards?.requirement,
            view: reqView,
            onViewChange: setReqView,
          });
        }
        if (effectiveBoardTab === 'implementation') {
          return h(ImplementationBoard, {
            data: summary?.boards?.implementation,
            view: implView,
            onViewChange: setImplView,
          });
        }
        if (effectiveBoardTab === 'project') {
          return h(ProjectBoard, {
            data: summary?.boards?.project,
            view: projView,
            onViewChange: setProjView,
          });
        }
        return null;
      };

      return h(
        'div',
        { className: 'heluo-wb-root', 'data-plugin-id': PLUGIN_ID },
        h('style', { id: STYLE_ID }, CSS),
        fallbackMode
          ? h(
            'div',
            { className: 'heluo-wb-banner heluo-wb-banner-warn' },
            h('span', null, t('drawerNotice')),
            onCloseFallback ? h('button', { type: 'button', className: 'heluo-wb-btn-sm', onClick: onCloseFallback }, '关闭') : null,
          )
          : null,
        h(TopBar, {
          bootstrap,
          summary,
          showTodos,
          onToggleTodos: () => setShowTodos((v) => !v),
          onCloseTodos: () => setShowTodos(false),
          onOpenCustomize: () => setShowCustomize(true),
          onRefresh: () => loadAll({ refresh: true }),
          loading,
          t,
        }),
        notice
          ? h(
            'div',
            { className: 'heluo-wb-banner' },
            h('span', null, notice),
            h('button', { type: 'button', className: 'heluo-wb-btn-sm', onClick: () => setNotice('') }, '×'),
          )
          : null,
        globalError ? h('div', { className: 'heluo-wb-banner heluo-wb-banner-err' }, globalError) : null,
        loading && !bootstrap ? h('div', { className: 'heluo-wb-body' }, h('div', { className: 'heluo-wb-card' }, t('loading'))) : null,
        bootstrap && !bootstrap.ready
          ? h('div', { className: 'heluo-wb-body' }, renderNotReady())
          : (bootstrap?.ready
            ? h(
              React.Fragment,
              null,
              orderedVisibleBoards.length > 0
                ? h(
                  'div',
                  { className: 'heluo-wb-prog-sec' },
                  h(
                    'div',
                    { className: 'heluo-wb-prog-card' },
                    h(
                      'div',
                      { className: 'heluo-wb-prog-head' },
                      h(
                        'div',
                        { className: 'heluo-wb-prog-pills', role: 'tablist', 'aria-label': '进展看板切换' },
                        orderedVisibleBoards.map((boardKey) =>
                          h(
                            'button',
                            {
                              key: boardKey,
                              type: 'button',
                              role: 'tab',
                              'aria-selected': effectiveBoardTab === boardKey && !progressCollapsed,
                              'data-testid': `wb-prog-pill-${boardKey}`,
                              className: `heluo-wb-prog-pill${effectiveBoardTab === boardKey ? ' active' : ''}`,
                              onClick: () => {
                                setActiveBoardTab(boardKey);
                                setProgressCollapsed(false);
                              },
                            },
                            BOARD_LABELS[boardKey] || boardKey,
                          ),
                        ),
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'heluo-wb-prog-collapse',
                          'data-testid': 'wb-prog-collapse',
                          onClick: () => setProgressCollapsed((c) => !c),
                        },
                        progressCollapsed ? '展开 ▾' : '收起 ▴',
                      ),
                    ),
                    !progressCollapsed
                      ? h('div', { className: 'heluo-wb-prog-body' }, renderActiveBoard())
                      : null,
                  ),
                )
                : null,
              h(
                'div',
                { className: 'heluo-wb-tabs', role: 'tablist', 'aria-label': '工作台领域页签' },
                orderedVisibleDomains.map((key) => {
                  const meta = DOMAIN_TABS.find((d) => d.key === key) || { key, label: key, phase1: false };
                  return h(
                    'button',
                    {
                      key,
                      type: 'button',
                      role: 'tab',
                      'aria-selected': effectiveDomain === key,
                      title: meta.phase1 ? meta.label : `${meta.label}（二期待澄清）`,
                      className: `heluo-wb-tab${effectiveDomain === key ? ' active' : ''}`,
                      onClick: () => setActiveDomain(key),
                    },
                    meta.label,
                  );
                }),
              ),
              h(
                'div',
                { className: 'heluo-wb-body' },
                typeof DOMAIN_VIEW_RENDERERS[effectiveDomain] === 'function'
                  ? DOMAIN_VIEW_RENDERERS[effectiveDomain]({
                    reqData,
                    reqSubTab,
                    setReqSubTab,
                    reqListView,
                    reqSearch,
                    setReqSearch,
                    loadAll,
                    setReqListView,
                    setShowOneSentence,
                    setShowDocModal,
                    handleBuildPrompt,
                    loading,
                    t,
                  })
                  : renderPhase2Placeholder(t),
              ),
            )
            : null),
        showCustomize
          ? h(CustomPreferencesModal, {
            initialPrefs: prefs,
            onClose: () => setShowCustomize(false),
            onSave: handleSavePreferences,
            onConfigUpdated: () => loadAll({ refresh: true }),
            busy: busyAction,
          })
          : null,
        showOneSentence
          ? h(OneSentenceModal, {
            onClose: () => setShowOneSentence(false),
            onGenerate: (idea) => handleBuildPrompt({ actionKey: 'req.create.one_sentence', idea }),
            busy: busyAction,
          })
          : null,
        showDocModal
          ? h(DocClarifyModal, {
            onClose: () => setShowDocModal(false),
            onBuildPrompt: handleBuildPrompt,
            busy: busyAction,
          })
          : null,
        pendingPrompt
          ? h(PromptConfirmModal, {
            result: pendingPrompt,
            draftBridge,
            onClose: () => setPendingPrompt(null),
            onDelivered: (msg) => {
              setPendingPrompt(null);
              setNotice(msg);
            },
          })
          : null,
      );
    }

    function createDrawerStore() {
      let open = false;
      const listeners = new Set();
      return {
        isOpen: () => open,
        setOpen(next) {
          open = Boolean(next);
          for (const fn of listeners) fn();
        },
        toggle() {
          open = !open;
          for (const fn of listeners) fn();
        },
        subscribe(fn) {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
      };
    }

    function BundleConfigPanel() {
      return h(
        'div',
        null,
        h('style', { id: 'heluo-forge-devops-workbench-cfg-style' }, CFG_CSS),
        h(ConnectionSettingsForm, { compact: false }),
      );
    }

    // §8 Cordis Client Registration
    const inject = ['slots', 'locale'];

    function apply(ctx) {
      const drawerStore = createDrawerStore();
      let sidebarRightRef = null;
      let layoutRef = null;
      let conversationRef = null;
      let sessionsRef = null;
      let footerEntryDisposer = null;
      let hasTopSidebarSlot = false;
      let pendingOpenCleanup = null;

      const getHostServices = () => ({
        conversation: conversationRef,
        sessions: sessionsRef,
        activeSessionId: sidebarRightRef?.mounted?.getSnapshot?.() ?? null,
      });

      const t = typeof ctx?.locale?.bind === 'function'
        ? ctx.locale.bind(NS)
        : (k) => zh[k] ?? k;

      if (typeof ctx?.locale?.register === 'function') {
        ctx.effect(
          () => ctx.locale.register(NS, { zh, en }),
          'forge-devops-workbench: locale',
        );
      }

      const tryOpenRightTab = () => {
        if (!sidebarRightRef || typeof sidebarRightRef.openTab !== 'function') return false;
        try {
          sidebarRightRef.openTab(TAB_KIND);
          return true;
        } catch {
          return false;
        }
      };

      const openWorkbench = () => {
        if (pendingOpenCleanup) {
          pendingOpenCleanup();
          pendingOpenCleanup = null;
        }

        // 若当前停留在全屏面板（如「插件」「自动化任务」），先切回对话视图使右侧栏恢复挂载
        const currentPanelId = layoutRef?.panelInfo?.getSnapshot?.()?.activePanelId ?? null;
        const switchedFromPanel = currentPanelId !== null && typeof layoutRef?.selectPanel === 'function';
        if (switchedFromPanel) {
          layoutRef.selectPanel(null);
        }

        if (tryOpenRightTab()) {
          drawerStore.setOpen(false);
          return 'tab';
        }

        // 当宿主支持 sidebarRight（尤其从全屏页切回对话后 sidebarRight.mounted 正在重新挂载），等待短暂挂载再打开页签
        if (sidebarRightRef && typeof sidebarRightRef.openTab === 'function') {
          let settled = false;
          let unsubMounted = null;
          let fallbackTimer = null;
          const retryTimers = [];
          const cleanupWait = () => {
            if (typeof unsubMounted === 'function') unsubMounted();
            for (const tid of retryTimers) clearTimeout(tid);
            retryTimers.length = 0;
            if (fallbackTimer) clearTimeout(fallbackTimer);
            unsubMounted = null;
            fallbackTimer = null;
          };
          pendingOpenCleanup = cleanupWait;

          const attempt = () => {
            if (settled) return;
            if (tryOpenRightTab()) {
              settled = true;
              drawerStore.setOpen(false);
              cleanupWait();
              pendingOpenCleanup = null;
            }
          };

          if (typeof sidebarRightRef.mounted?.subscribe === 'function') {
            unsubMounted = sidebarRightRef.mounted.subscribe(attempt);
          }
          for (const delayMs of [30, 80, 160, 300, 500]) {
            retryTimers.push(setTimeout(attempt, delayMs));
          }
          fallbackTimer = setTimeout(() => {
            if (!settled) {
              settled = true;
              cleanupWait();
              pendingOpenCleanup = null;
              if (!tryOpenRightTab()) {
                drawerStore.setOpen(true);
              }
            }
          }, 800);
          return 'tab-pending';
        }

        drawerStore.setOpen(true);
        return 'drawer';
      };

      function MainPanelRedirect() {
        useEffect(() => {
          openWorkbench();
        }, []);
        return null;
      }

      function SidebarPanelIcon(props) {
        const size = Number.isFinite(props?.size) ? props.size : 16;
        return h(
          'span',
          {
            'data-testid': 'sidebar-workbench-entry',
            style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
          },
          h(WorkbenchIcon, { size }),
        );
      }

      function SidebarEntryButton(props) {
        const wide = props?.wide !== false;
        return h(
          'button',
          {
            type: 'button',
            className: 'heluo-wb-entry-btn',
            title: t('entryTooltip'),
            'aria-label': t('entryLabel'),
            'data-testid': 'sidebar-workbench-entry',
            onClick: openWorkbench,
          },
          h(WorkbenchIcon, { size: 16 }),
          wide ? h('span', null, t('entryLabel')) : null,
        );
      }

      function WorkbenchPaneBody(props) {
        return h(WorkbenchRoot, {
          ctx,
          sessionId: props?.sessionId ?? null,
          getHostServices,
          fallbackMode: false,
        });
      }

      function WorkbenchPaneTitle() {
        return h('span', null, t('tabTitle'));
      }

      function FallbackDrawer() {
        const [isOpen, setIsOpen] = useState(drawerStore.isOpen);
        useEffect(() => drawerStore.subscribe(() => setIsOpen(drawerStore.isOpen())), []);
        if (!isOpen) return null;
        return h(
          'div',
          { className: 'heluo-wb-drawer-backdrop', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('tabTitle') },
          h(
            'div',
            { className: 'heluo-wb-drawer' },
            h(WorkbenchRoot, {
              ctx,
              getHostServices,
              fallbackMode: true,
              onCloseFallback: () => drawerStore.setOpen(false),
            }),
          ),
        );
      }

      if (typeof ctx?.inject === 'function') {
        ctx.inject(['layout'], (scope) => {
          layoutRef = scope.layout;
          const onPanelChange = () => {
            const activeId = layoutRef?.panelInfo?.getSnapshot?.()?.activePanelId;
            if (activeId === TAB_KIND) {
              openWorkbench();
            }
          };
          const unsubPanel = typeof layoutRef?.panelInfo?.subscribe === 'function'
            ? layoutRef.panelInfo.subscribe(onPanelChange)
            : null;
          onPanelChange();

          let disposeMainSlot = null;
          if (typeof ctx?.slots?.inject === 'function') {
            disposeMainSlot = ctx.slots.inject('main', () => ctx.slots.register(
              {
                name: 'main',
                key: TAB_KIND,
              },
              MainPanelRedirect,
            ));
          }

          let disposeTopSlot = null;
          if (typeof ctx?.slots?.inject === 'function') {
            disposeTopSlot = ctx.slots.inject('sidebar.panellist', () => {
              hasTopSidebarSlot = true;
              if (typeof footerEntryDisposer === 'function') {
                footerEntryDisposer();
                footerEntryDisposer = null;
              }
              return ctx.slots.register(
                {
                  name: 'sidebar.panellist',
                  id: TAB_KIND,
                  order: 20,
                  label: () => t('entryLabel'),
                  locale: NS,
                },
                SidebarPanelIcon,
              );
            });
          }

          return () => {
            if (typeof disposeMainSlot === 'function') disposeMainSlot();
            if (typeof disposeTopSlot === 'function') disposeTopSlot();
            hasTopSidebarSlot = false;
            if (typeof unsubPanel === 'function') unsubPanel();
            if (layoutRef === scope.layout) layoutRef = null;
          };
        });
      }

      // 仅在基线宿主未提供 sidebar.panellist 或未注入 layout 时，回退注册底部入口，避免同一界面出现重复入口
      ctx.effect(
        () => ctx.slots.inject('sidebar.footer.action', () => {
          if (hasTopSidebarSlot) return () => {};
          const reg = ctx.slots.register(
            {
              name: 'sidebar.footer.action',
              id: TAB_KIND,
              order: 10,
              locale: NS,
            },
            SidebarEntryButton,
          );
          footerEntryDisposer = reg;
          return () => {
            if (footerEntryDisposer === reg) footerEntryDisposer = null;
            reg?.();
          };
        }),
        'forge-devops-workbench: sidebar-footer-fallback',
      );

      ctx.effect(
        () => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(
          {
            name: 'plugins.bundle.config',
            key: PLUGIN_ID,
            locale: NS,
          },
          BundleConfigPanel,
        )),
        'forge-devops-workbench: plugin-config-slot',
      );

      ctx.effect(
        () => ctx.slots.inject('shell.overlay', () => ctx.slots.register(
          {
            name: 'shell.overlay',
            id: `${TAB_KIND}-drawer`,
          },
          FallbackDrawer,
        )),
        'forge-devops-workbench: fallback-drawer',
      );

      if (typeof ctx?.inject === 'function') {
        ctx.inject(['conversation', 'sessions'], (scope) => {
          conversationRef = scope.conversation;
          sessionsRef = scope.sessions;
          return () => {
            if (conversationRef === scope.conversation) conversationRef = null;
            if (sessionsRef === scope.sessions) sessionsRef = null;
          };
        });

        ctx.inject(['sidebarRight', 'sidebarRightTabs'], (scope) => {
          sidebarRightRef = scope.sidebarRight;
          scope.effect(
            () => scope.sidebarRightTabs.register({
              id: PLUGIN_ID,
              kind: TAB_KIND,
              multiple: false,
              priority: 'extension',
              title: () => t('tabTitle'),
            }),
            'forge-devops-workbench: right-tab-def',
          );
          scope.effect(
            () => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register(
              {
                name: 'sidebar.right.pane.tab',
                key: PLUGIN_ID,
                locale: NS,
                inject: (sessionId) => ({ sessionId }),
              },
              WorkbenchPaneBody,
            )),
            'forge-devops-workbench: right-tab-body',
          );
          scope.effect(
            () => scope.slots.inject('sidebar.right.pane.tab.title', () => scope.slots.register(
              {
                name: 'sidebar.right.pane.tab.title',
                key: PLUGIN_ID,
              },
              WorkbenchPaneTitle,
            )),
            'forge-devops-workbench: right-tab-title',
          );
          return () => {
            if (sidebarRightRef === scope.sidebarRight) sidebarRightRef = null;
          };
        });
      }

      ctx.effect?.(() => () => {
        if (pendingOpenCleanup) {
          pendingOpenCleanup();
          pendingOpenCleanup = null;
        }
      });

      return { openWorkbench, drawerStore };
    }

    return {
      name: TAB_KIND,
      PLUGIN_ID,
      TAB_KIND,
      inject,
      apply,
      workbenchApi,
      resolveDraftBridge,
      sanitizePortalHref,
      openExternalUrl,
      copyTextToClipboard,
      WorkbenchRoot,
    };
  },
});
