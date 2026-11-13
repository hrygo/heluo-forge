window.__ModuleLoader__.load({ id: "@heluo/forge-skill-nacos", factory: (require) => {
var module = { exports: {} };
var exports = module.exports;
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client.mjs
var client_exports = {};
__export(client_exports, {
  DICT: () => DICT,
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(client_exports);
var React = __toESM(require("react"), 1);
var h = React.createElement;
var NS = "skillNacos";
var API = "/api/heluo/forge-skill-nacos";
var PANEL_ID = "skill-nacos";
var PANEL_ORDER = 3;
var STYLE_ID = "fsn-panel-style-v2";
var DICT = {
  zh: {
    "title": "\u4F01\u4E1A\u6280\u80FD\u5E02\u573A",
    "desc": "\u4ECE\u4F01\u4E1A Nacos \u53D1\u73B0\u5E76\u5B89\u88C5\u6280\u80FD\uFF1B\u542F\u7528\u540E\u8FDB\u5165\u4F1A\u8BDD\u6280\u80FD\u76EE\u5F55\u3002",
    "tab.browse": "\u6D4F\u89C8",
    "tab.installed": "\u5DF2\u5B89\u88C5",
    "tab.trash": "\u56DE\u6536\u7AD9",
    "tab.settings": "\u6E90\u8BBE\u7F6E",
    "settings.desc": "\u9009\u62E9\u8981\u8FDE\u63A5\u7684 Nacos \u73AF\u5883\uFF08\u5207\u6362\u540E\u7ACB\u5373\u751F\u6548\uFF0C\u4E0D\u9700\u8981\u91CD\u542F\uFF09\u3002",
    "settings.environment": "\u73AF\u5883",
    "settings.saved": "\u5DF2\u5207\u6362\uFF0C\u76EE\u5F55\u7F13\u5B58\u5DF2\u6E05\u7A7A",
    "settings.noEnvironments": "\u7BA1\u7406\u5458\u672A\u914D\u7F6E\u591A\u73AF\u5883\uFF08cordis.yml \u7684 environments \u5B57\u6BB5\uFF09\uFF0C\u5F53\u524D\u4F7F\u7528\u9ED8\u8BA4\u8FDE\u63A5\u3002",
    "settings.ns": "\u547D\u540D\u7A7A\u95F4",
    "search.placeholder": "\u641C\u7D22\u6280\u80FD\u540D\u79F0 / \u63CF\u8FF0\u2026",
    "refresh": "\u5237\u65B0",
    "install": "\u5B89\u88C5",
    "enable": "\u542F\u7528",
    "disable": "\u505C\u7528",
    "uninstall": "\u5378\u8F7D",
    "upgrade": "\u66F4\u7248",
    "restore": "\u6062\u590D",
    "purge": "\u6C38\u4E45\u5220\u9664",
    "toProject": "\u8F6C\u9879\u76EE",
    "toUser": "\u8F6C\u5168\u5C40",
    "detail": "\u8BE6\u60C5",
    "close": "\u5173\u95ED",
    "badge.none": "\u672A\u5B89\u88C5",
    "badge.on": "\u5DF2\u542F\u7528",
    "badge.off": "\u5DF2\u505C\u7528",
    "badge.update": "\u53EF\u66F4\u7248",
    "badge.delisted": "\u8FDC\u7A0B\u4E0B\u7EBF",
    "badge.stale": "\u76EE\u5F55\u8FC7\u671F",
    "scope.user": "\u5168\u5C40",
    "scope.project": "\u9879\u76EE",
    "label.source": "\u6E90",
    "label.ns": "\u547D\u540D\u7A7A\u95F4",
    "label.mode": "\u6A21\u5F0F",
    "label.cache": "\u7F13\u5B58",
    "label.version": "\u7248\u672C",
    "label.scope": "\u4F5C\u7528\u57DF",
    "label.status": "\u72B6\u6001",
    "label.remote": "\u8FDC\u7A0B",
    "label.time": "\u5378\u8F7D\u65F6\u95F4",
    "label.sha": "SHA",
    "state.loading": "\u52A0\u8F7D\u4E2D\u2026",
    "state.empty": "\u76EE\u5F55\u4E3A\u7A7A\uFF1A\u786E\u8BA4\u6E90\u914D\u7F6E\u4E0E\u51ED\u636E\uFF0C\u6216\u70B9\u51FB\u5237\u65B0\u3002",
    "state.emptyInstalled": "\u5C1A\u672A\u5B89\u88C5\u4EFB\u4F55\u4F01\u4E1A\u6280\u80FD\u3002",
    "state.emptyTrash": "\u56DE\u6536\u7AD9\u4E3A\u7A7A\u3002\u5378\u8F7D\u7684\u6280\u80FD\u5728\u6B64\u4FDD\u7559 30 \u5929\uFF0C\u53EF\u968F\u65F6\u6062\u590D\u3002",
    "msg.ok": "\u64CD\u4F5C\u5B8C\u6210",
    "msg.confirmUninstall": "\u5378\u8F7D\u540E\u6280\u80FD\u4ECE\u76EE\u5F55\u6D88\u5931\uFF0C\u6587\u4EF6\u4FDD\u7559\u5728\u56DE\u6536\u7AD9\u53EF\u6062\u590D\u3002\u786E\u8BA4\u5378\u8F7D\uFF1F",
    "msg.confirmPurge": "\u6C38\u4E45\u5220\u9664\u4E0D\u53EF\u6062\u590D\u3002\u786E\u8BA4\u5220\u9664\uFF1F",
    "detail.desc": "\u63CF\u8FF0",
    "detail.versions": "\u7248\u672C\uFF08\u5355\u9009 \xB7 \u5B89\u88C5\u56FA\u5B9A\u7CBE\u786E\u7248\u672C\uFF09",
    "detail.source": "\u6765\u6E90\u4E0E\u5B8C\u6574\u6027",
    "detail.security": "\u5B89\u5168\u8BF4\u660E",
    "detail.installConfirm": "\u5B89\u88C5\u786E\u8BA4",
    "detail.installBtn": "\u5B89\u88C5\u5E76\u542F\u7528",
    "err.network": "\u9762\u677F\u540E\u7AEF\u4E0D\u53EF\u8FBE"
  },
  en: {
    "title": "Enterprise Skills",
    "desc": "Discover and install skills from the enterprise Nacos registry.",
    "tab.browse": "Browse",
    "tab.installed": "Installed",
    "tab.trash": "Trash",
    "tab.settings": "Source",
    "settings.desc": "Select the Nacos environment to connect to (effective immediately, no restart needed).",
    "settings.environment": "Environment",
    "settings.saved": "Switched, catalog cache cleared",
    "settings.noEnvironments": "No multi-environment configured (cordis.yml environments field); using default connection.",
    "settings.ns": "Namespace",
    "search.placeholder": "Search skill name / description\u2026",
    "refresh": "Refresh",
    "install": "Install",
    "enable": "Enable",
    "disable": "Disable",
    "uninstall": "Uninstall",
    "upgrade": "Upgrade",
    "restore": "Restore",
    "purge": "Delete Permanently",
    "toProject": "To Project",
    "toUser": "To Global",
    "detail": "Details",
    "close": "Close",
    "badge.none": "Not Installed",
    "badge.on": "Enabled",
    "badge.off": "Disabled",
    "badge.update": "Update Available",
    "badge.delisted": "Delisted",
    "badge.stale": "Stale",
    "scope.user": "Global",
    "scope.project": "Project",
    "label.source": "Source",
    "label.ns": "Namespace",
    "label.mode": "Mode",
    "label.cache": "Cache",
    "label.version": "Version",
    "label.scope": "Scope",
    "label.status": "Status",
    "label.remote": "Remote",
    "label.time": "Uninstalled",
    "label.sha": "SHA",
    "state.loading": "Loading\u2026",
    "state.empty": "Catalog is empty. Check source config or refresh.",
    "state.emptyInstalled": "No enterprise skills installed yet.",
    "state.emptyTrash": "Trash is empty. Uninstalled skills are kept for 30 days.",
    "msg.ok": "Done",
    "msg.confirmUninstall": "Skill disappears from catalogs; files kept in trash for restore. Confirm?",
    "msg.confirmPurge": "Permanent deletion cannot be undone. Confirm?",
    "detail.desc": "Description",
    "detail.versions": "Versions (single \xB7 pinned to precise version)",
    "detail.source": "Source & Integrity",
    "detail.security": "Security Notes",
    "detail.installConfirm": "Install Confirmation",
    "detail.installBtn": "Install & Enable",
    "err.network": "Panel backend unreachable"
  }
};
function api(path, body) {
  const url = resolveUrl(path);
  const init = body === void 0 ? { headers: { Accept: "application/json" } } : { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) };
  return fetch(url, init).then(async (response) => {
    const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
    if (payload?.ok !== true) {
      const e = new Error(payload?.error ?? "unknown");
      e.code = payload?.code;
      throw e;
    }
    return payload.result;
  });
}
function resolveUrl(path) {
  if (typeof document === "undefined") return path;
  try {
    const base = new URL(document.baseURI);
    if (!base.pathname.endsWith("/")) base.pathname += "/";
    return new URL(path.slice(1), base).href;
  } catch {
    return path;
  }
}
function fmtDate(iso) {
  if (!iso) return "\u2014";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
var CSS = `
#${STYLE_ID}{all:initial}
.fsn-root{--fsn-gap:12px;--fsn-c1:#1a1a1a;--fsn-c2:#666;--fsn-c3:#999;--fsn-bd:#d0d0d0;--fsn-pri:#2563eb;--fsn-bg:#fff;display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;color:var(--dsw-alias-label-primary,var(--fsn-c1));font-family:inherit}
.fsn-header{padding:20px clamp(20px,4vw,48px) 0;display:flex;flex-direction:column;gap:4px}
.fsn-title{font-size:18px;font-weight:600}
.fsn-desc{font-size:12px;color:var(--dsw-alias-label-secondary,var(--fsn-c2))}
.fsn-status{display:flex;flex-wrap:wrap;gap:8px 14px;font-size:11px;color:var(--dsw-alias-label-tertiary,var(--fsn-c3))}
.fsn-status b{font-weight:500;color:var(--dsw-alias-label-primary,var(--fsn-c1))}
.fsn-tabs{display:flex;gap:0;padding:0 clamp(20px,4vw,48px);border-bottom:1px solid var(--dsw-alias-border-l2,var(--fsn-bd))}
.fsn-tab{padding:8px 16px;font-size:13px;border:none;background:none;cursor:pointer;color:var(--dsw-alias-label-secondary,var(--fsn-c2));border-bottom:2px solid transparent}
.fsn-tab[data-active="true"]{color:var(--dsw-alias-primary,var(--fsn-pri));border-bottom-color:var(--dsw-alias-primary,var(--fsn-pri));font-weight:500}
.fsn-tab-count{display:inline-flex;margin-left:4px;padding:1px 6px;font-size:10px;border-radius:8px;background:rgba(128,128,128,.15)}
.fsn-body{flex:1;min-height:0;overflow-y:auto;padding:16px clamp(20px,4vw,48px) 32px}
.fsn-body-inner{max-width:960px;margin:0 auto;display:flex;flex-direction:column;gap:var(--fsn-gap)}
.fsn-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.fsn-input{flex:1;min-width:200px;padding:7px 12px;font-size:13px;color:var(--dsw-alias-label-primary,var(--fsn-c1));background:var(--dsw-alias-fill-input,transparent);border:1px solid var(--dsw-alias-border-l2,var(--fsn-bd));border-radius:6px;outline:none}
.fsn-input:focus{border-color:var(--dsw-alias-primary,var(--fsn-pri))}
.fsn-chip{padding:4px 12px;font-size:12px;border-radius:14px;border:1px solid var(--dsw-alias-border-l2,var(--fsn-bd));background:transparent;color:var(--dsw-alias-label-secondary,var(--fsn-c2));cursor:pointer}
.fsn-chip[data-active="true"]{border-color:var(--dsw-alias-primary,var(--fsn-pri));color:var(--dsw-alias-primary,var(--fsn-pri));font-weight:500}
.fsn-btn{padding:5px 14px;font-size:12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,var(--fsn-bd));background:transparent;color:var(--dsw-alias-label-primary,var(--fsn-c1));cursor:pointer;white-space:nowrap}
.fsn-btn:hover{border-color:var(--dsw-alias-primary,var(--fsn-pri))}
.fsn-btn:disabled{opacity:.45;cursor:default}
.fsn-btn-primary{border-color:transparent;background:var(--dsw-alias-primary,#2563eb);color:#fff}
.fsn-btn-primary:hover{background:var(--dsw-alias-primary-hover,#1d4ed8)}
.fsn-btn-danger{border-color:transparent;background:var(--dsw-alias-danger,#e5484d);color:#fff}
.fsn-card{display:flex;gap:14px;align-items:flex-start;padding:14px;border:1px solid var(--dsw-alias-border-l2,var(--fsn-bd));border-radius:10px;cursor:pointer;transition:border-color .15s}
.fsn-card:hover{border-color:var(--dsw-alias-primary,var(--fsn-pri))}
.fsn-card-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.fsn-card-title{font-weight:600;font-size:14px}
.fsn-card-desc{font-size:12px;color:var(--dsw-alias-label-secondary,var(--fsn-c2));overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.fsn-card-meta{font-size:11px;color:var(--dsw-alias-label-tertiary,var(--fsn-c3))}
.fsn-card-actions{display:flex;gap:6px;flex:none;align-items:center}
.fsn-badge{display:inline-flex;padding:2px 10px;font-size:11px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,var(--fsn-bd));color:var(--dsw-alias-label-secondary,var(--fsn-c2));white-space:nowrap}
.fsn-badge[data-tone="on"]{border-color:transparent;background:rgba(63,177,90,.12);color:#3f9e56}
.fsn-badge[data-tone="off"]{background:rgba(128,128,128,.1);color:var(--dsw-alias-label-secondary,var(--fsn-c2))}
.fsn-badge[data-tone="warn"]{border-color:transparent;background:rgba(240,180,41,.14);color:#b8860b}
.fsn-badge[data-tone="danger"]{border-color:transparent;background:rgba(229,72,77,.1);color:#e5484d}
.fsn-badge[data-tone="info"]{border-color:transparent;background:rgba(59,130,246,.1);color:#3b82f6}
.fsn-table{width:100%;border-collapse:collapse;font-size:13px}
.fsn-table th{text-align:left;padding:8px 10px;font-weight:500;font-size:11px;color:var(--dsw-alias-label-secondary,var(--fsn-c2));border-bottom:1px solid var(--dsw-alias-border-l2,var(--fsn-bd))}
.fsn-table td{padding:10px;border-bottom:1px solid var(--dsw-alias-border-l1,var(--dsw-alias-border-l2,var(--fsn-bd)))}
.fsn-empty{padding:40px 20px;text-align:center;color:var(--dsw-alias-label-secondary,var(--fsn-c2));font-size:13px}
.fsn-msg{padding:10px 14px;border-radius:8px;font-size:12px}
.fsn-msg-ok{background:rgba(63,177,90,.1);color:#3f9e56}
.fsn-msg-err{background:rgba(229,72,77,.08);color:#e5484d}
.fsn-overlay{position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:200;display:flex;justify-content:flex-end}
.fsn-drawer{width:min(480px,90vw);height:100%;background:var(--dsw-alias-bg-primary,#fff);border-left:1px solid var(--dsw-alias-border-l2,var(--fsn-bd));display:flex;flex-direction:column;box-shadow:-4px 0 24px rgba(0,0,0,.1)}
.fsn-drawer-head{display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid var(--dsw-alias-border-l2,var(--fsn-bd))}
.fsn-drawer-title{font-size:16px;font-weight:600}
.fsn-drawer-body{flex:1;overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:16px}
.fsn-drawer-foot{padding:14px 20px;border-top:1px solid var(--dsw-alias-border-l2,var(--fsn-bd));display:flex;justify-content:flex-end;gap:10px}
.fsn-section-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.fsn-version{display:flex;gap:10px;align-items:center;padding:10px;border:1px solid var(--dsw-alias-border-l2,var(--fsn-bd));border-radius:8px;cursor:pointer}
.fsn-version[data-selected="true"]{border-color:var(--dsw-alias-primary,var(--fsn-pri));background:rgba(59,130,246,.04)}
.fsn-radio{width:16px;height:16px;border:2px solid var(--dsw-alias-border-l2,var(--fsn-bd));border-radius:50%;flex:none;position:relative}
.fsn-radio[data-checked="true"]{border-color:var(--dsw-alias-primary)}
.fsn-radio[data-checked="true"]::after{content:'';position:absolute;inset:2px;border-radius:50%;background:var(--dsw-alias-primary)}
.fsn-confirm{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:210;background:var(--dsw-alias-bg-primary,#fff);border:1px solid var(--dsw-alias-border-l2,var(--fsn-bd));border-radius:12px;padding:24px;min-width:320px;max-width:420px;box-shadow:0 8px 32px rgba(0,0,0,.15)}
.fsn-confirm h4{margin:0 0 12px;font-size:15px}
.fsn-confirm p{margin:0 0 16px;font-size:13px;color:var(--dsw-alias-label-secondary,var(--fsn-c2));line-height:1.5}
.fsn-confirm-actions{display:flex;justify-content:flex-end;gap:10px}
.fsn-icon{flex:none;display:flex;align-items:center;justify-content:center}
`;
function ensureStyle() {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID) !== null) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  (document.head ?? document.documentElement).appendChild(style);
}
function SidebarIcon({ size = 16 }) {
  return h(
    "svg",
    { width: size, height: size, viewBox: "0 0 16 16", fill: "currentColor", "aria-hidden": true },
    h("path", { d: "M2 3.5A1.5 1.5 0 0 1 3.5 2h4A1.5 1.5 0 0 1 9 3.5V5H7.5A2.5 2.5 0 0 0 5 7.5V9H3.5A1.5 1.5 0 0 1 2 7.5v-4Z" }),
    h("path", { d: "M6.5 7A1.5 1.5 0 0 1 8 5.5h4A1.5 1.5 0 0 1 13.5 7v5a1.5 1.5 0 0 1-1.5 1.5H8A1.5 1.5 0 0 1 6.5 12V7Z" })
  );
}
function Badge({ tone = "", children }) {
  return h("span", { className: "fsn-badge", ...tone ? { "data-tone": tone } : {} }, children);
}
function ConfirmDialog({ title, body, t, onConfirm, onCancel }) {
  if (!title) return null;
  return h(
    "div",
    { className: "fsn-confirm" },
    h("h4", null, title),
    h("p", null, body),
    h(
      "div",
      { className: "fsn-confirm-actions" },
      h("button", { className: "fsn-btn", onClick: onCancel }, t("close")),
      h("button", { className: "fsn-btn fsn-btn-primary", onClick: onConfirm }, title)
    )
  );
}
function DetailDrawer({ skill, local, t, onClose, onInstall }) {
  const [selectedVersion, setSelectedVersion] = React.useState(void 0);
  const [showConfirm, setShowConfirm] = React.useState(false);
  if (!skill) return null;
  const meta = skill.meta ?? skill;
  const versions = (meta.versions ?? []).filter((v) => v.status === "online" || v.status === "" || v.status === "published");
  const current = selectedVersion ?? (local?.version ?? (versions.length > 0 ? versions[versions.length - 1].version : void 0));
  const isInstalled = local !== null && local !== void 0;
  const isCurrent = isInstalled && local.version === current;
  const versionRows = versions.map((v) => {
    const selected = v.version === current;
    const statusLabel = v.version === local?.version ? ` \xB7 ${t("label.status")}: ${local.enabled ? t("badge.on") : t("badge.off")}` : "";
    return h(
      "div",
      {
        key: v.version,
        className: "fsn-version",
        "data-selected": selected,
        onClick: () => setSelectedVersion(v.version)
      },
      h("span", { className: "fsn-radio", "data-checked": selected }),
      h("span", { style: { flex: 1 } }, h("b", null, v.version), statusLabel),
      h("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-secondary,var(--fsn-c2))" } }, v.status || "online")
    );
  });
  const section = (title, ...children) => h("div", null, h("div", { className: "fsn-section-title" }, title), ...children);
  const head = h(
    "div",
    { className: "fsn-drawer-head", key: "head" },
    h("span", { className: "fsn-drawer-title" }, meta.name ?? t("detail")),
    h("button", { className: "fsn-btn", onClick: onClose, "aria-label": t("close") }, "\xD7")
  );
  const body = h(
    "div",
    { className: "fsn-drawer-body", key: "body" },
    section(
      t("detail.desc"),
      h("p", { style: { margin: "4px 0 0", fontSize: 13, lineHeight: 1.5 } }, meta.description ?? "")
    ),
    section(
      t("detail.versions"),
      h("div", { style: { display: "flex", flexDirection: "column", gap: 6, marginTop: 6 } }, ...versionRows)
    ),
    section(
      t("detail.source"),
      h(
        "div",
        { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary,var(--fsn-c2))", marginTop: 4, lineHeight: 1.6 } },
        `Namespace: ${meta.namespaceId ?? "public"}`,
        h("br"),
        `${t("label.version")}: ${current ?? "\u2014"}`,
        local?.contentSha256 ? h("span", null, h("br"), `${t("label.sha")}: ${local.contentSha256.slice(0, 8)}\u2026`) : null
      )
    ),
    section(
      t("detail.security"),
      h(
        "p",
        { style: { margin: "4px 0 0", fontSize: 11, color: "var(--dsw-alias-label-secondary,var(--fsn-c2))", lineHeight: 1.5 } },
        "\u5B89\u88C5\u4E0D\u6267\u884C\u5305\u5185\u811A\u672C\u3001\u4E0D\u6388\u5DE5\u5177\u6743\u9650\u3001\u4E0D\u5B89\u88C5\u4F9D\u8D56\uFF1B\u540C\u540D\u672C\u5730\u6280\u80FD\u51B2\u7A81\u65F6\u62D2\u7EDD\u3002"
      )
    )
  );
  const foot = h(
    "div",
    { className: "fsn-drawer-foot", key: "foot" },
    h("button", { className: "fsn-btn", onClick: onClose }, t("close")),
    !isCurrent ? h("button", {
      className: "fsn-btn fsn-btn-primary",
      onClick: () => setShowConfirm(true)
    }, isInstalled ? `${t("upgrade")} ${current}` : `${t("install")} ${current}`) : null
  );
  return h(
    React.Fragment,
    null,
    h(
      "div",
      { className: "fsn-overlay", onClick: onClose },
      h("div", { className: "fsn-drawer", onClick: (e) => e.stopPropagation() }, head, body, foot)
    ),
    showConfirm ? h(ConfirmDialog, {
      title: t("detail.installConfirm"),
      t,
      body: `${meta.name}@${current} \xB7 ${t("detail.installBtn")}`,
      onConfirm: () => {
        setShowConfirm(false);
        onInstall(meta.name, current);
      },
      onCancel: () => setShowConfirm(false)
    }) : null
  );
}
function BrowseView({ t, catalog, installed, loading, keyword, setKeyword, onRefresh, onDetail, onAction, busy }) {
  const [filter, setFilter] = React.useState("all");
  const allItems = catalog?.items ?? [];
  const items = allItems.filter((item) => {
    const local = installed.find((r) => r.name === item.name);
    if (filter === "installed") return local !== void 0;
    if (filter === "update") return local !== void 0 && item.latestVersion !== local.version;
    return true;
  });
  const countInstalled = allItems.filter((i) => installed.some((r) => r.name === i.name)).length;
  const countUpdate = allItems.filter((i) => {
    const l = installed.find((r) => r.name === i.name);
    return l && i.latestVersion && i.latestVersion !== l.version;
  }).length;
  const toolbar = h(
    "div",
    { className: "fsn-toolbar" },
    h("input", {
      className: "fsn-input",
      value: keyword,
      placeholder: t("search.placeholder"),
      onChange: (e) => setKeyword(e.target.value),
      onKeyDown: (e) => {
        if (e.key === "Enter") onRefresh();
      }
    }),
    h("button", { className: "fsn-chip", "data-active": filter === "all", onClick: () => setFilter("all") }, `${t("tab.browse")} ${catalog?.total ?? 0}`),
    h("button", { className: "fsn-chip", "data-active": filter === "installed", onClick: () => setFilter("installed") }, `${t("badge.on")} ${countInstalled}`),
    h("button", { className: "fsn-chip", "data-active": filter === "update", onClick: () => setFilter("update") }, `${t("badge.update")} ${countUpdate}`),
    h("button", { className: "fsn-btn", disabled: busy, onClick: onRefresh }, t("refresh"))
  );
  const staleMsg = catalog?.stale ? h("div", { className: "fsn-msg fsn-msg-err" }, t("badge.stale")) : null;
  const cards = items.map((item) => {
    const local = item.installed !== null && item.installed !== void 0 ? { name: item.name, ...item.installed } : void 0;
    const version = local?.version ?? item.latestVersion ?? "";
    const hasUpdate = local && item.latestVersion && item.latestVersion !== local.version;
    let badge;
    let actionBtn;
    if (!local) {
      badge = h("span", { key: "bdg", className: "fsn-badge", "data-tone": "off" }, t("badge.none"));
      actionBtn = h("button", {
        key: "act",
        className: "fsn-btn fsn-btn-primary",
        disabled: busy,
        onClick: () => onAction({ op: "install", name: item.name, ...version ? { version } : {} })
      }, t("install"));
    } else if (hasUpdate) {
      badge = h("span", { key: "bdg", className: "fsn-badge", "data-tone": "warn" }, `${t("badge.update")} ${item.latestVersion}`);
      actionBtn = h("button", {
        key: "act",
        className: "fsn-btn fsn-btn-primary",
        disabled: busy,
        onClick: () => onAction({ op: "upgrade", name: item.name, version: item.latestVersion })
      }, t("upgrade"));
    } else if (local.enabled) {
      badge = h("span", { key: "bdg", className: "fsn-badge", "data-tone": "on" }, t("badge.on"));
      actionBtn = h("button", {
        key: "act",
        className: "fsn-btn",
        disabled: busy,
        onClick: () => onAction({ op: "disable", name: item.name })
      }, t("disable"));
    } else {
      badge = h("span", { key: "bdg", className: "fsn-badge", "data-tone": "off" }, t("badge.off"));
      actionBtn = h("button", {
        key: "act",
        className: "fsn-btn fsn-btn-primary",
        disabled: busy,
        onClick: () => onAction({ op: "enable", name: item.name })
      }, t("enable"));
    }
    return h(
      "div",
      { key: item.name, className: "fsn-card", onClick: () => onDetail(item.name) },
      h(
        "div",
        { className: "fsn-card-main" },
        h("div", { className: "fsn-card-title" }, item.name),
        h("div", { className: "fsn-card-desc" }, item.description || ""),
        h("div", { className: "fsn-card-meta" }, `${t("label.version")}: ${version || "\u2014"}`)
      ),
      h("div", { className: "fsn-card-actions", onClick: (e) => e.stopPropagation() }, badge, actionBtn)
    );
  });
  return h(
    React.Fragment,
    null,
    toolbar,
    staleMsg,
    loading ? h("div", { className: "fsn-empty" }, t("state.loading")) : items.length === 0 ? h("div", { className: "fsn-empty" }, t("state.empty")) : h("div", { style: { display: "flex", flexDirection: "column", gap: 10 } }, ...cards)
  );
}
function InstalledView({ t, installed, catalog, onDetail, onAction, busy }) {
  const [confirm, setConfirm] = React.useState(void 0);
  if (installed.length === 0) return h("div", { className: "fsn-empty" }, t("state.emptyInstalled"));
  const rows = installed.map((r) => {
    const isProject = r.scope?.kind === "project";
    const scopeLabel = isProject ? `${t("scope.project")} \xB7 ${(r.scope.root ?? "").split("/").pop()}` : t("scope.user");
    const catalogItem = (catalog?.items ?? []).find((i) => i.name === r.name);
    const latestVersion = catalogItem?.latestVersion;
    const hasUpdate = latestVersion && latestVersion !== r.version;
    const actionBtn = (label, action) => h("button", {
      className: "fsn-btn",
      disabled: busy,
      onClick: () => onAction(action)
    }, label);
    const remoteCell = !catalogItem ? h("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-secondary,var(--fsn-c2))" } }, t("badge.delisted")) : hasUpdate ? Badge({ tone: "warn" }, `${t("badge.update")} ${latestVersion}`) : Badge({ tone: "off" }, t("label.version") + " \u2713");
    return h(
      "tr",
      { key: r.name },
      h(
        "td",
        null,
        h("div", { style: { fontWeight: 600, cursor: "pointer" }, onClick: () => onDetail(r.name) }, r.name)
      ),
      h("td", null, r.version),
      h("td", null, Badge({ tone: isProject ? "info" : "off" }, scopeLabel)),
      h("td", null, Badge({ tone: r.enabled ? "on" : "off" }, r.enabled ? t("badge.on") : t("badge.off"))),
      h("td", null, remoteCell),
      h(
        "td",
        { style: { textAlign: "right" } },
        h(
          "div",
          { style: { display: "flex", gap: 4, justifyContent: "flex-end" } },
          hasUpdate ? actionBtn(t("upgrade"), { op: "upgrade", name: r.name, version: latestVersion }) : null,
          actionBtn(r.enabled ? t("disable") : t("enable"), { op: r.enabled ? "disable" : "enable", name: r.name }),
          actionBtn(isProject ? t("toUser") : t("toProject"), { op: "scope", name: r.name, to: isProject ? "user" : "project" }),
          h("button", { className: "fsn-btn", disabled: busy, onClick: () => setConfirm(r.name) }, t("uninstall"))
        )
      )
    );
  });
  const table = h(
    "table",
    { className: "fsn-table" },
    h("thead", null, h(
      "tr",
      null,
      h("th", null, t("detail")),
      h("th", null, t("label.version")),
      h("th", null, t("label.scope")),
      h("th", null, t("label.status")),
      h("th", null, t("label.remote")),
      h("th", { style: { textAlign: "right" } }, "\u64CD\u4F5C")
    )),
    h("tbody", null, ...rows)
  );
  const dialog = confirm !== void 0 ? h(ConfirmDialog, {
    title: t("uninstall"),
    t,
    body: t("msg.confirmUninstall"),
    onConfirm: () => {
      const name = confirm;
      setConfirm(void 0);
      onAction({ op: "uninstall", name });
    },
    onCancel: () => setConfirm(void 0)
  }) : null;
  return h(React.Fragment, null, table, dialog);
}
function TrashView({ t, trash, onAction, busy }) {
  const [confirmPurge, setConfirmPurge] = React.useState(void 0);
  if (trash.length === 0) return h("div", { className: "fsn-empty" }, t("state.emptyTrash"));
  const rows = trash.map((entry) => h(
    "tr",
    { key: entry.id ?? entry.name },
    h("td", { style: { fontWeight: 600 } }, entry.name),
    h("td", null, entry.version),
    h("td", null, fmtDate(entry.trashedAt)),
    h("td", { style: { fontFamily: "monospace", fontSize: 11 } }, `${String(entry.skillMdSha256 ?? "").slice(0, 8)}\u2026`),
    h(
      "td",
      { style: { textAlign: "right" } },
      h(
        "div",
        { style: { display: "flex", gap: 4, justifyContent: "flex-end" } },
        h("button", {
          className: "fsn-btn fsn-btn-primary",
          disabled: busy,
          onClick: () => onAction({ op: "restore", name: entry.name })
        }, t("restore")),
        h("button", {
          className: "fsn-btn fsn-btn-danger",
          disabled: busy,
          onClick: () => setConfirmPurge(entry.name)
        }, t("purge"))
      )
    )
  ));
  const table = h(
    "table",
    { className: "fsn-table" },
    h("thead", null, h(
      "tr",
      null,
      h("th", null, t("detail")),
      h("th", null, t("label.version")),
      h("th", null, t("label.time")),
      h("th", null, t("label.sha")),
      h("th", { style: { textAlign: "right" } }, "\u64CD\u4F5C")
    )),
    h("tbody", null, ...rows)
  );
  const dialog = confirmPurge !== void 0 ? h(ConfirmDialog, {
    title: t("purge"),
    t,
    body: t("msg.confirmPurge"),
    onConfirm: () => {
      const name = confirmPurge;
      setConfirmPurge(void 0);
      onAction({ op: "purge", name });
    },
    onCancel: () => setConfirmPurge(void 0)
  }) : null;
  return h(React.Fragment, null, table, dialog);
}
function SettingsView({ t, onSaved, busy }) {
  const [settings, setSettings] = React.useState(void 0);
  const [activeEnv, setActiveEnv] = React.useState(void 0);
  const [msg, setMsg] = React.useState(void 0);
  const load = React.useCallback(() => {
    api(`${API}/settings`).then((r) => {
      setSettings(r);
      setActiveEnv(r.effective?.activeEnvironmentId ?? r.environments?.[0]?.id ?? "");
    }).catch((e) => setMsg({ kind: "err", text: e.message }));
  }, []);
  React.useEffect(() => {
    load();
  }, [load]);
  const switchEnv = async (envId) => {
    setActiveEnv(envId);
    setMsg(void 0);
    try {
      await api(`${API}/settings`, { method: "POST", body: JSON.stringify({ activeEnvironmentId: envId }) });
      setMsg({ kind: "ok", text: t("settings.saved") });
      onSaved();
    } catch (e) {
      setMsg({ kind: "err", text: `${e.code ?? ""} ${e.message}` });
    }
  };
  if (settings === void 0) return h("div", { className: "fsn-empty" }, t("state.loading"));
  const envs = settings.environments ?? [];
  const current = envs.find((e) => e.id === activeEnv);
  return h(
    "div",
    { style: { display: "flex", flexDirection: "column", gap: 16 } },
    h("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary,var(--fsn-c2))" } }, t("settings.desc")),
    envs.length > 0 ? h(
      React.Fragment,
      null,
      h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 4 } },
        h("label", { style: { fontSize: 11, color: "var(--dsw-alias-label-secondary,var(--fsn-c2))" } }, t("settings.environment")),
        h(
          "select",
          {
            className: "fsn-input",
            value: activeEnv,
            onChange: (e) => switchEnv(e.target.value)
          },
          ...envs.map((env) => h(
            "option",
            { key: env.id, value: env.id },
            `${env.label} (${env.namespaceId})`
          ))
        )
      ),
      current !== void 0 ? h(
        "div",
        { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary,var(--fsn-c3))" } },
        `ID: ${current.id} \xB7 ${t("settings.ns")}: ${current.namespaceId}`
      ) : null,
      msg ? h("div", { className: `fsn-msg ${msg.kind === "ok" ? "fsn-msg-ok" : "fsn-msg-err"}` }, msg.text) : null
    ) : h("div", { className: "fsn-empty" }, t("settings.noEnvironments"))
  );
}
function MainPanel({ t }) {
  ensureStyle();
  const [tab, setTab] = React.useState("browse");
  const [keyword, setKeyword] = React.useState("");
  const [status, setStatus] = React.useState(void 0);
  const [catalog, setCatalog] = React.useState(void 0);
  const [installed, setInstalled] = React.useState([]);
  const [trash, setTrash] = React.useState([]);
  const [detailName, setDetailName] = React.useState(void 0);
  const [detailSkill, setDetailSkill] = React.useState(void 0);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState(void 0);
  const loadAll = React.useCallback(async (kw) => {
    setBusy(true);
    try {
      const [s, c, i] = await Promise.all([
        api(`${API}/status`),
        api(`${API}/catalog?page=1&pageSize=50${kw ? `&keyword=${encodeURIComponent(kw)}` : ""}`),
        api(`${API}/installed`)
      ]);
      setStatus(s);
      setCatalog(c);
      setInstalled(i.items ?? []);
      api(`${API}/trash`).then((r) => setTrash(r.items ?? [])).catch(() => setTrash([]));
    } catch (error) {
      setMessage({ kind: "err", text: `${error.code ?? ""} ${error.message}` });
    } finally {
      setBusy(false);
    }
  }, []);
  React.useEffect(() => {
    void loadAll("");
  }, [loadAll]);
  React.useEffect(() => {
    void loadAll(keyword);
  }, [tab]);
  const openDetail = async (name) => {
    setDetailName(name);
    try {
      setDetailSkill(await api(`${API}/skill?name=${encodeURIComponent(name)}`));
    } catch {
      setDetailSkill(void 0);
    }
  };
  const act = async (body, note) => {
    setBusy(true);
    setMessage(void 0);
    try {
      await api(`${API}/action`, body);
      setMessage({ kind: "ok", text: `${note ?? body.op} \xB7 ${t("msg.ok")}` });
      await loadAll(keyword);
      if (detailName) {
        try {
          setDetailSkill(await api(`${API}/skill?name=${encodeURIComponent(detailName)}`));
        } catch {
        }
      }
    } catch (error) {
      setMessage({ kind: "err", text: `${error.code ?? ""} ${error.message}` });
    } finally {
      setBusy(false);
    }
  };
  return h(
    "div",
    { className: "fsn-root" },
    h(
      "div",
      { className: "fsn-header" },
      h("div", { className: "fsn-title" }, t("title")),
      h("div", { className: "fsn-desc" }, t("desc")),
      status !== void 0 ? h(
        "div",
        { className: "fsn-status" },
        h("span", null, `${t("label.source")}: `, h("b", null, status.endpoint ?? "")),
        h("span", null, `${t("label.ns")}: `, h("b", null, status.namespaceId ?? "")),
        h("span", null, `${t("label.mode")}: `, h("b", null, status.catalogMode ?? ""))
      ) : null
    ),
    h(
      "div",
      { className: "fsn-tabs" },
      h("button", { className: "fsn-tab", "data-active": tab === "browse", onClick: () => setTab("browse") }, t("tab.browse"), h("span", { className: "fsn-tab-count" }, String(catalog?.total ?? 0))),
      h("button", { className: "fsn-tab", "data-active": tab === "installed", onClick: () => setTab("installed") }, t("tab.installed"), h("span", { className: "fsn-tab-count" }, String(installed.length))),
      h("button", { className: "fsn-tab", "data-active": tab === "trash", onClick: () => setTab("trash") }, t("tab.trash"), h("span", { className: "fsn-tab-count" }, String(trash.length))),
      h("button", { className: "fsn-tab", "data-active": tab === "settings", onClick: () => setTab("settings") }, t("tab.settings"))
    ),
    h(
      "div",
      { className: "fsn-body" },
      h(
        "div",
        { className: "fsn-body-inner" },
        message !== void 0 ? h("div", { className: `fsn-msg ${message.kind === "ok" ? "fsn-msg-ok" : "fsn-msg-err"}` }, message.text) : null,
        tab === "browse" ? h(BrowseView, { t, catalog, installed, loading: busy && catalog === void 0, keyword, setKeyword, onRefresh: () => loadAll(keyword), onDetail: openDetail, onAction: act, busy }) : tab === "installed" ? h(InstalledView, { t, installed, catalog, onDetail: openDetail, onAction: act, busy }) : tab === "settings" ? h(SettingsView, { t, busy, onSaved: () => loadAll(keyword) }) : h(TrashView, { t, trash, onAction: act, busy })
      )
    ),
    detailName !== void 0 ? h(DetailDrawer, {
      skill: detailSkill,
      local: installed.find((r) => r.name === detailName) ?? null,
      t,
      onClose: () => {
        setDetailName(void 0);
        setDetailSkill(void 0);
      },
      onInstall: (name, version) => {
        const isUpgrade = installed.some((r) => r.name === name);
        act({ op: isUpgrade ? "upgrade" : "install", name, version });
        setDetailName(void 0);
      }
    }) : null
  );
}
function SettingsSection({ t }) {
  ensureStyle();
  return h("div", { style: { padding: "8px 0" } }, h(MainPanel, { t }));
}
var inject = ["slots", "locale"];
function apply(ctx) {
  const t = typeof ctx?.locale?.bind === "function" ? ctx.locale.bind(NS) : (key) => key;
  ctx.effect(() => ctx.locale.register(NS, DICT));
  ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register(
    { name: "settings.section", id: PANEL_ID, order: 30, label: () => t("title"), icon: "skill", locale: NS },
    (props) => h(SettingsSection, { t, ...props ?? {} })
  )));
  ctx.effect(() => ctx.slots.inject("main", () => ctx.slots.register(
    { name: "main", key: PANEL_ID, locale: NS, inject: () => ({ t }) },
    () => h(MainPanel, { t })
  )));
  ctx.effect(() => ctx.slots.inject("sidebar.panellist", () => ctx.slots.register(
    { name: "sidebar.panellist", id: PANEL_ID, order: PANEL_ORDER, label: () => t("title"), locale: NS },
    (ownerProps) => h(SidebarIcon, { size: ownerProps?.size ?? 16 })
  )));
}
return module.exports;
}});
