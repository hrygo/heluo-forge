window.__ModuleLoader__.load({ id: "@heluo/forge-skills-manager", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __export = (target, all2) => {
  for (var name2 in all2)
    __defProp(target, name2, { get: all2[name2], enumerable: true });
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

var require_extend = __commonJS({
  "node_modules/extend/index.js"(exports, module2) {
    "use strict";
    var hasOwn = Object.prototype.hasOwnProperty;
    var toStr = Object.prototype.toString;
    var defineProperty2 = Object.defineProperty;
    var gOPD = Object.getOwnPropertyDescriptor;
    var isArray = function isArray2(arr) {
      if (typeof Array.isArray === "function") {
        return Array.isArray(arr);
      }
      return toStr.call(arr) === "[object Array]";
    };
    var isPlainObject2 = function isPlainObject3(obj) {
      if (!obj || toStr.call(obj) !== "[object Object]") {
        return false;
      }
      var hasOwnConstructor = hasOwn.call(obj, "constructor");
      var hasIsPrototypeOf = obj.constructor && obj.constructor.prototype && hasOwn.call(obj.constructor.prototype, "isPrototypeOf");
      if (obj.constructor && !hasOwnConstructor && !hasIsPrototypeOf) {
        return false;
      }
      var key;
      for (key in obj) {
      }
      return typeof key === "undefined" || hasOwn.call(obj, key);
    };
    var setProperty = function setProperty2(target, options) {
      if (defineProperty2 && options.name === "__proto__") {
        defineProperty2(target, options.name, {
          enumerable: true,
          configurable: true,
          value: options.newValue,
          writable: true
        });
      } else {
        target[options.name] = options.newValue;
      }
    };
    var getProperty = function getProperty2(obj, name2) {
      if (name2 === "__proto__") {
        if (!hasOwn.call(obj, name2)) {
          return void 0;
        } else if (gOPD) {
          return gOPD(obj, name2).value;
        }
      }
      return obj[name2];
    };
    module2.exports = function extend2() {
      var options, name2, src, copy, copyIsArray, clone;
      var target = arguments[0];
      var i = 1;
      var length = arguments.length;
      var deep = false;
      if (typeof target === "boolean") {
        deep = target;
        target = arguments[1] || {};
        i = 2;
      }
      if (target == null || typeof target !== "object" && typeof target !== "function") {
        target = {};
      }
      for (; i < length; ++i) {
        options = arguments[i];
        if (options != null) {
          for (name2 in options) {
            src = getProperty(target, name2);
            copy = getProperty(options, name2);
            if (target !== copy) {
              if (deep && copy && (isPlainObject2(copy) || (copyIsArray = isArray(copy)))) {
                if (copyIsArray) {
                  copyIsArray = false;
                  clone = src && isArray(src) ? src : [];
                } else {
                  clone = src && isPlainObject2(src) ? src : {};
                }
                setProperty(target, { name: name2, newValue: extend2(deep, clone, copy) });
              } else if (typeof copy !== "undefined") {
                setProperty(target, { name: name2, newValue: copy });
              }
            }
          }
        }
      }
      return target;
    };
  }
});

// src/client.ts
var primitives = __toESM(require("@deepseek-ai/dsh-client-ui-primitives"), 1);
var import_dsh_client_ui_primitives4 = require("@deepseek-ai/dsh-client-ui-primitives");
var React5 = __toESM(require("react"), 1);

// src/api-base.ts
function pageBaseHref() {
  if (typeof document === "undefined") return void 0;
  const raw = document.baseURI;
  if (typeof raw !== "string" || raw === "") return void 0;
  try {
    const url = new URL(raw);
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    return url.href;
  } catch {
    return void 0;
  }
}
function resolveApiUrl(path2) {
  if (typeof path2 !== "string" || path2.charAt(0) !== "/" || path2.charAt(1) === "/") return path2;
  const base = pageBaseHref();
  if (base === void 0) return path2;
  try {
    return new URL(path2.slice(1), base).href;
  } catch {
    return path2;
  }
}

// src/destination-picker.ts
var defaultDestination = () => ({ scope: "user", location: "dsh", workspace: "", presetKey: "" });
function destinationPayload(value) {
  if (value.scope === "workspace") return { workspace: value.workspace };
  if (value.scope === "preset") return { root: value.presetKey };
  return { root: value.location === "agents" ? "agents" : "dsh" };
}
function destinationReady(value, workspaces, userDestinations, presetDestinations) {
  if (value.scope === "preset") {
    return !!presetDestinations && presetDestinations.length > 0 && presetDestinations.some((item) => item.key === value.presetKey && item.available !== false);
  }
  if (value.scope === "user") return !userDestinations || userDestinations.some((item) => item.key === value.location && item.available === true);
  return workspaces.some((row) => row.available && !!row.registeredPaths[0] && row.registeredPaths[0] === value.workspace);
}
function projectPreview(path2) {
  const separator = path2.includes("\\") ? "\\" : "/";
  return path2.replace(/[\\/]+$/, "") + separator + ".dsh" + separator + "skills";
}
var destinationLocales = {
  zh: {
    "dest.scope": "\u8303\u56F4",
    "dest.scope.user": "\u7528\u6237\u76EE\u5F55",
    "dest.scope.workspace": "\u6307\u5B9A\u5DE5\u4F5C\u533A",
    "dest.scope.preset": "\u9884\u8BBE\u6A21\u5F0F",
    "dest.workspace": "\u5DE5\u4F5C\u533A",
    "dest.workspace.placeholder": "\u8BF7\u9009\u62E9\u5DE5\u4F5C\u533A",
    "dest.workspace.unavailable": "{name}\uFF08\u76EE\u5F55\u4E0D\u53EF\u7528\uFF09",
    "dest.preset": "\u9884\u8BBE\u6A21\u5F0F",
    "dest.preset.placeholder": "\u8BF7\u9009\u62E9\u9884\u8BBE\u6A21\u5F0F",
    "dest.pickFirst": "\u5148\u9009\u62E9\u4E00\u4E2A\u5DF2\u767B\u8BB0\u5DE5\u4F5C\u533A\u3002\u786E\u8BA4\u524D\u4E0D\u4F1A\u521B\u5EFA\u76EE\u5F55\u3002",
    "dest.empty": "\u8FD8\u6CA1\u6709\u5DF2\u767B\u8BB0\u7684\u5DE5\u4F5C\u533A\u3002\u8BF7\u5148\u5728\u4FA7\u680F\u6DFB\u52A0\uFF0C\u518D\u56DE\u5230\u8FD9\u91CC\u9009\u62E9\u3002",
    "dest.location": "\u4F4D\u7F6E",
    "dest.location.dsh": "DSH skills",
    "dest.location.agents": "Shared Agent",
    "dest.location.agentsOff": "\u5DE5\u4F5C\u533A\u53EA\u652F\u6301 DSH skills\u3002",
    "dest.projectNote": "\u4F1A\u5199\u8FDB\u8FD9\u4E2A\u9879\u76EE\uFF0C\u53EF\u80FD\u88AB\u63D0\u4EA4\u5230\u4ED3\u5E93\u3002",
    "dest.presetNote": "\u4F1A\u5B89\u88C5\u5230\u8BE5\u9884\u8BBE\u6A21\u5F0F\u4E13\u5C5E\u7684\u6280\u80FD\u76EE\u5F55\uFF0C\u4EC5\u5728\u8BE5\u6A21\u5F0F\u4E0B\u53EF\u7528\u3002",
    "dest.createdInWorkspace": "\u5DF2\u521B\u5EFA\u5728\u6240\u9009\u5DE5\u4F5C\u533A\u3002\u8981\u5728\u8BE5\u5DE5\u4F5C\u533A\u7684\u4F1A\u8BDD\u91CC\u624D\u4F1A\u770B\u5230\u3002"
  },
  en: {
    "dest.scope": "Scope",
    "dest.scope.user": "User directory",
    "dest.scope.workspace": "Specific workspace",
    "dest.scope.preset": "Agent Preset",
    "dest.workspace": "Workspace",
    "dest.workspace.placeholder": "Select a workspace",
    "dest.workspace.unavailable": "{name} (directory unavailable)",
    "dest.preset": "Agent Preset",
    "dest.preset.placeholder": "Select a preset",
    "dest.pickFirst": "Select a registered workspace first. No directory is created before you confirm.",
    "dest.empty": "No registered workspaces yet. Add one in the sidebar, then come back.",
    "dest.location": "Location",
    "dest.location.dsh": "DSH skills",
    "dest.location.agents": "Shared Agent",
    "dest.location.agentsOff": "Workspaces support DSH skills only.",
    "dest.projectNote": "This is written into the project and may be committed to its repository.",
    "dest.presetNote": "Installed into this preset's dedicated directory and available only in this preset.",
    "dest.createdInWorkspace": "Created in the selected workspace. It appears in sessions of that workspace."
  }
};
var destinationCss = [
  ".dssm-destination{display:flex;flex-direction:column;gap:12px}",
  ".dssm-destination .dssm-field{display:flex;flex-direction:column;gap:6px;min-width:0}",
  // 两列等宽且控件铺满，避免筛选下拉按文字收缩留下大块空白；窄屏时上下排列。
  ".dssm-destination-pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}",
  ".dssm-destination-pair .dssm-menu-select-wrap{width:100%;min-width:0}",
  '.dssm-destination-pair .dssm-menu-select-wrap,.dssm-destination-pair span[class*="_root_"],.dssm-destination-pair .dssm-source-select-menu{display:flex!important;width:100%!important;min-width:0!important;height:auto!important;padding:0!important;margin:0!important;border:0!important;background:transparent!important}',
  ".dssm-destination-pair .dssm-menu-select-trigger{display:flex!important;width:100%!important;min-width:0!important;height:36px!important;border-radius:var(--dsw-radius-md,10px)!important;padding:0 12px!important;box-sizing:border-box!important}",
  "@media (max-width:420px){.dssm-destination-pair{grid-template-columns:minmax(0,1fr)}}",
  ".dssm-destination-path{display:block;box-sizing:border-box;width:100%;padding:8px 10px;border:0.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2));border-radius:var(--dsw-radius-lg,16px);background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));overflow-wrap:anywhere;font-size:12px;line-height:18px}",
  ".dssm-destination-unavailable{display:flex;flex-direction:column;gap:2px}"
].join("");
function createDestinationPicker({ react: react2, SourceSelect: SourceSelect2, translateError: translateError2 }) {
  const h4 = react2.createElement;
  return function DestinationPicker2({ t, value, onChange, workspaces, userDestinations, presetDestinations = [], allowAgents, disabled }) {
    const inWorkspace = value.scope === "workspace";
    const inPreset = value.scope === "preset";
    const chosen = workspaces.find((row) => !!row.registeredPaths[0] && row.registeredPaths[0] === value.workspace);
    const chosenPreset = (presetDestinations || []).find((row) => row.key === value.presetKey);
    const scopeOptions = [
      { value: "user", label: t("dest.scope.user") },
      { value: "workspace", label: t("dest.scope.workspace") },
      ...presetDestinations && presetDestinations.length > 0 ? [{ value: "preset", label: t("dest.scope.preset") }] : []
    ];
    const nameCount = /* @__PURE__ */ new Map();
    for (const row of workspaces) nameCount.set(row.name, (nameCount.get(row.name) ?? 0) + 1);
    const workspaceOptions = [{ value: "", label: t("dest.workspace.placeholder") }].concat(
      workspaces.map((row) => ({
        value: row.registeredPaths[0] || "",
        label: !row.available ? t("dest.workspace.unavailable", { name: row.name }) : (nameCount.get(row.name) ?? 0) > 1 ? row.name + " \xB7 " + row.path : row.name,
        disabled: !row.available || !row.registeredPaths[0]
      }))
    );
    const presetOptions = [{ value: "", label: t("dest.preset.placeholder") }].concat(
      (presetDestinations || []).map((row) => ({
        value: row.key,
        label: row.name,
        disabled: row.available === false
      }))
    );
    const offered = allowAgents ? ["dsh", "agents"] : ["dsh"];
    const locations = offered.filter((key) => userDestinations.some((item) => item.key === key));
    const target = (key) => userDestinations.find((item) => item.key === key);
    const usable = (key) => locations.some((item) => item === key) && target(key)?.available !== false;
    const locationOptions = locations.map((key) => ({ value: key, label: t("dest.location." + key), disabled: target(key)?.available === false }));
    const second = inWorkspace ? h4(
      "div",
      { className: "dssm-field", key: "workspace" },
      h4("span", { className: "dssm-label" }, t("dest.workspace")),
      h4(SourceSelect2, { label: t("dest.workspace"), value: value.workspace, disabled: disabled || workspaces.length === 0, options: workspaceOptions, onChange: (next) => {
        if (!disabled && workspaces.length > 0 && (next === "" || destinationReady({ ...value, scope: "workspace", workspace: next }, workspaces))) onChange({ workspace: next });
      } })
    ) : inPreset ? h4(
      "div",
      { className: "dssm-field", key: "preset" },
      h4("span", { className: "dssm-label" }, t("dest.preset")),
      h4(SourceSelect2, {
        label: t("dest.preset"),
        value: value.presetKey || "",
        disabled: disabled || (presetDestinations || []).length === 0,
        options: presetOptions,
        onChange: (next) => {
          if (!disabled) onChange({ presetKey: next });
        }
      })
    ) : h4(
      "div",
      { className: "dssm-field", key: "location" },
      h4("span", { className: "dssm-label" }, t("dest.location")),
      h4(SourceSelect2, {
        label: t("dest.location"),
        value: value.location,
        disabled: disabled || locations.length === 0,
        options: locationOptions,
        // 置灰项也可能被合成事件触发，所以选择器自己再拒绝一次，不靠 disabled 属性兜底。
        onChange: (next) => {
          if (!disabled && usable(next)) onChange({ location: next });
        }
      })
    );
    const path2 = inWorkspace ? chosen && chosen.available ? projectPreview(chosen.projectRoot || chosen.path) : "" : inPreset ? chosenPreset?.path ?? "" : target(value.location)?.path ?? "";
    const broken = inWorkspace || inPreset ? [] : locations.filter((key) => target(key)?.available === false);
    return h4(
      "div",
      { className: "dssm-destination" },
      h4(
        "div",
        { className: "dssm-destination-pair" },
        h4(
          "div",
          { className: "dssm-field", key: "scope" },
          h4("span", { className: "dssm-label" }, t("dest.scope")),
          h4(SourceSelect2, {
            label: t("dest.scope"),
            value: value.scope,
            disabled,
            options: scopeOptions,
            onChange: (next) => {
              if (!disabled && (next === "workspace" || next === "user" || next === "preset")) {
                if (next === "workspace") onChange({ scope: "workspace", location: "dsh", presetKey: "" });
                else if (next === "preset") onChange({ scope: "preset", presetKey: presetDestinations?.[0]?.key || "" });
                else onChange({ scope: "user", workspace: "", presetKey: "" });
              }
            }
          })
        ),
        second
      ),
      inWorkspace && workspaces.length === 0 ? h4("p", { className: "dssm-feedback dssm-warning", role: "status" }, t("dest.empty")) : null,
      inWorkspace && workspaces.length > 0 && !chosen ? h4("p", { className: "dssm-note" }, t("dest.pickFirst")) : null,
      path2 ? h4("code", { className: "dssm-destination-path" }, path2) : null,
      // 不可用的位置在下拉里置灰，原因与路径写在这里，用户才知道为什么选不了。
      broken.map((key) => h4(
        "div",
        { key, className: "dssm-note dssm-destination-unavailable" },
        h4("span", null, t("dest.location." + key)),
        h4("code", { className: "dssm-destination-path" }, target(key)?.path ?? ""),
        h4("span", null, target(key)?.error ? translateError2(t, target(key).error) : "")
      )),
      inWorkspace && chosen ? h4("p", { className: "dssm-note" }, t("dest.projectNote") + " " + t("dest.location.agentsOff")) : null,
      inPreset && chosenPreset ? h4("p", { className: "dssm-note" }, t("dest.presetNote")) : null
    );
  };
}
function createDestinationKit(dependencies) {
  return { DestinationPicker: createDestinationPicker(dependencies), defaultDestination, destinationPayload, destinationReady };
}

// src/management-locales.ts
var managementLocales = {
  "zh": {
    "mutation.pending": "\u64CD\u4F5C\u7ED3\u679C\u5C1A\u5F85\u786E\u8BA4\uFF0C\u8BF7\u5148\u6838\u5BF9\u7ED3\u679C\uFF0C\u4E0D\u8981\u91CD\u590D\u63D0\u4EA4\u3002",
    "mutation.check": "\u6838\u5BF9\u64CD\u4F5C\u7ED3\u679C",
    "mutation.confirmed": "\u64CD\u4F5C\u5DF2\u786E\u8BA4\uFF0C\u5DF2\u8BFB\u53D6\u5F53\u524D\u72B6\u6001\u3002",
    "mutation.refreshWarning": "\u64CD\u4F5C\u5DF2\u786E\u8BA4\uFF0C\u4F46\u5F53\u524D\u72B6\u6001\u5237\u65B0\u5931\u8D25\u3002\u8BF7\u5237\u65B0\u9875\u9762\u6838\u5BF9\uFF0C\u4E0D\u8981\u91CD\u590D\u63D0\u4EA4\u3002",
    "error.proto.pending": "\u64CD\u4F5C\u7ED3\u679C\u5C1A\u5F85\u786E\u8BA4\u3002",
    "error.proto.busy": "\u8BF7\u5148\u6838\u5BF9\u4E0A\u4E00\u64CD\u4F5C\u7684\u7ED3\u679C\u3002",
    "error.proto.response": "\u670D\u52A1\u7AEF\u54CD\u5E94\u65E0\u6548\uFF0C\u64CD\u4F5C\u7ED3\u679C\u5C1A\u5F85\u786E\u8BA4\u3002",
    "error.enterprise.reserved": "\u8BE5\u540D\u79F0\u7531\u4F01\u4E1A\u6D41\u7A0B\u6280\u80FD\u4FDD\u7559\uFF0C\u8BF7\u4F7F\u7528\u5176\u4ED6\u540D\u79F0\u3002",
    "error.repo.capacity": "\u5B89\u88C5\u6765\u6E90\u72B6\u6001\u8D85\u8FC7 16 MiB\u3002\u8BF7\u5148\u6E05\u7406\u4E0D\u9700\u8981\u7684\u56DE\u6536\u8BB0\u5F55\u6216\u65E7\u8EAB\u4EFD\uFF0C\u4ECD\u6709\u6548\u7684\u5B89\u88C5\u526F\u672C\u4F1A\u4FDD\u7559\u3002",
    "error.repo.conflict": "\u540C\u540D\u6280\u80FD\u5DF2\u5B58\u5728\u6216\u5B89\u88C5\u5931\u8D25\uFF0C\u672C\u5730\u6587\u4EF6\u672A\u88AB\u8986\u76D6\u3002",
    "error.repo.installState": "\u6280\u80FD\u6587\u4EF6\u5DF2\u4FDD\u7559\uFF0C\u4F46\u6765\u6E90\u72B6\u6001\u672A\u786E\u8BA4\u3002\u8BF7\u6062\u590D\u78C1\u76D8\u5199\u5165\u540E\u91CD\u65B0\u6253\u5F00\u6280\u80FD\u7BA1\u7406\u5668\uFF0C\u7CFB\u7EDF\u4F1A\u6821\u9A8C\u6587\u4EF6\u5E76\u6062\u590D\u8BB0\u5F55\u3002",
    "error.repo.invalid": "\u4ED3\u5E93\u5730\u5740\u3001\u8DEF\u5F84\u6216\u5185\u5BB9\u65E0\u6548\uFF0C\u8BF7\u68C0\u67E5\u8F93\u5165\u53CA\u4ED3\u5E93\u5927\u5C0F\u3002",
    "error.repo.state": "\u4ED3\u5E93\u72B6\u6001\u6587\u4EF6\u635F\u574F\u6216\u65E0\u6CD5\u8BFB\u53D6\uFF0C\u8BF7\u4FDD\u7559\u6587\u4EF6\u5E76\u4FEE\u590D\u540E\u91CD\u8BD5\u3002",
    "token.detailLine": "\u7B80\u4ECB \u2248{description} token \xB7 \u6B63\u6587 \u2248{body} token"
  },
  "en": {
    "mutation.pending": "The operation is awaiting confirmation. Check its result before submitting again.",
    "mutation.check": "Check operation result",
    "mutation.confirmed": "The operation is confirmed and current state has been loaded.",
    "mutation.refreshWarning": "The operation is confirmed, but current state could not refresh. Refresh to check it; do not submit again.",
    "error.proto.pending": "The operation is awaiting confirmation.",
    "error.proto.busy": "Confirm the previous operation first.",
    "error.proto.response": "Invalid server response. The operation is awaiting confirmation.",
    "error.enterprise.reserved": "This name is reserved for an enterprise workflow. Choose another name.",
    "error.repo.capacity": "Source tracking exceeds 16 MiB. Remove unneeded Trash records or legacy identities first. Active installation copies are kept.",
    "error.repo.conflict": "A skill with this name exists or installation failed. Local files were not overwritten.",
    "error.repo.installState": "Skill files were preserved but source tracking could not be saved. Restore disk write access and reopen the skills manager to verify files and recover the record.",
    "error.repo.invalid": "Invalid repository URL, path or contents. Check the input and repository size.",
    "error.repo.state": "Repository state is corrupt or unreadable. Preserve the file and repair it before retrying.",
    "token.detailLine": "Description \u2248{description} tokens \xB7 Body \u2248{body} tokens"
  }
};

// src/nacos-detail.ts
var React = __toESM(require("react"), 1);

function ok() {
}
function unreachable() {
}

function stringify(values, options) {
  const settings = options || {};
  const input = values[values.length - 1] === "" ? [...values, ""] : values;
  return input.join(
    (settings.padRight ? " " : "") + "," + (settings.padLeft === false ? "" : " ")
  ).trim();
}

var nameRe = /^[$_\p{ID_Start}][$_\u{200C}\u{200D}\p{ID_Continue}]*$/u;
var nameReJsx = /^[$_\p{ID_Start}][-$_\u{200C}\u{200D}\p{ID_Continue}]*$/u;
var emptyOptions = {};
function name(name2, options) {
  const settings = options || emptyOptions;
  const re2 = settings.jsx ? nameReJsx : nameRe;
  return re2.test(name2);
}

var re = /[ \t\n\f\r]/g;
function whitespace(thing) {
  return typeof thing === "object" ? thing.type === "text" ? empty(thing.value) : false : empty(thing);
}
function empty(value) {
  return value.replace(re, "") === "";
}

var Schema = class {
  /**
   * @param {SchemaType['property']} property
   *   Property.
   * @param {SchemaType['normal']} normal
   *   Normal.
   * @param {Space | undefined} [space]
   *   Space.
   * @returns
   *   Schema.
   */
  constructor(property, normal, space2) {
    this.normal = normal;
    this.property = property;
    if (space2) {
      this.space = space2;
    }
  }
};
Schema.prototype.normal = {};
Schema.prototype.property = {};
Schema.prototype.space = void 0;

function merge(definitions, space2) {
  const property = {};
  const normal = {};
  for (const definition3 of definitions) {
    Object.assign(property, definition3.property);
    Object.assign(normal, definition3.normal);
  }
  return new Schema(property, normal, space2);
}

function normalize(value) {
  return value.toLowerCase();
}

var Info = class {
  /**
   * @param {string} property
   *   Property.
   * @param {string} attribute
   *   Attribute.
   * @returns
   *   Info.
   */
  constructor(property, attribute) {
    this.attribute = attribute;
    this.property = property;
  }
};
Info.prototype.attribute = "";
Info.prototype.booleanish = false;
Info.prototype.boolean = false;
Info.prototype.commaOrSpaceSeparated = false;
Info.prototype.commaSeparated = false;
Info.prototype.defined = false;
Info.prototype.mustUseProperty = false;
Info.prototype.number = false;
Info.prototype.overloadedBoolean = false;
Info.prototype.property = "";
Info.prototype.spaceSeparated = false;
Info.prototype.space = void 0;

var types_exports = {};
__export(types_exports, {
  boolean: () => boolean,
  booleanish: () => booleanish,
  commaOrSpaceSeparated: () => commaOrSpaceSeparated,
  commaSeparated: () => commaSeparated,
  number: () => number,
  overloadedBoolean: () => overloadedBoolean,
  spaceSeparated: () => spaceSeparated
});
var powers = 0;
var boolean = increment();
var booleanish = increment();
var overloadedBoolean = increment();
var number = increment();
var spaceSeparated = increment();
var commaSeparated = increment();
var commaOrSpaceSeparated = increment();
function increment() {
  return 2 ** ++powers;
}

var checks = (
  /** @type {ReadonlyArray<keyof typeof types>} */
  Object.keys(types_exports)
);
var DefinedInfo = class extends Info {
  /**
   * @constructor
   * @param {string} property
   *   Property.
   * @param {string} attribute
   *   Attribute.
   * @param {number | null | undefined} [mask]
   *   Mask.
   * @param {Space | undefined} [space]
   *   Space.
   * @returns
   *   Info.
   */
  constructor(property, attribute, mask, space2) {
    let index3 = -1;
    super(property, attribute);
    mark(this, "space", space2);
    if (typeof mask === "number") {
      while (++index3 < checks.length) {
        const check2 = checks[index3];
        mark(this, checks[index3], (mask & types_exports[check2]) === types_exports[check2]);
      }
    }
  }
};
DefinedInfo.prototype.defined = true;
function mark(values, key, value) {
  if (value) {
    values[key] = value;
  }
}

function create(definition3) {
  const properties = {};
  const normals = {};
  for (const [property, value] of Object.entries(definition3.properties)) {
    const info = new DefinedInfo(
      property,
      definition3.transform(definition3.attributes || {}, property),
      value,
      definition3.space
    );
    if (definition3.mustUseProperty && definition3.mustUseProperty.includes(property)) {
      info.mustUseProperty = true;
    }
    properties[property] = info;
    normals[normalize(property)] = property;
    normals[normalize(info.attribute)] = property;
  }
  return new Schema(properties, normals, definition3.space);
}

var aria = create({
  properties: {
    ariaActiveDescendant: null,
    ariaAtomic: booleanish,
    ariaAutoComplete: null,
    ariaBusy: booleanish,
    ariaChecked: booleanish,
    ariaColCount: number,
    ariaColIndex: number,
    ariaColSpan: number,
    ariaControls: spaceSeparated,
    ariaCurrent: null,
    ariaDescribedBy: spaceSeparated,
    ariaDetails: null,
    ariaDisabled: booleanish,
    ariaDropEffect: spaceSeparated,
    ariaErrorMessage: null,
    ariaExpanded: booleanish,
    ariaFlowTo: spaceSeparated,
    ariaGrabbed: booleanish,
    ariaHasPopup: null,
    ariaHidden: booleanish,
    ariaInvalid: null,
    ariaKeyShortcuts: null,
    ariaLabel: null,
    ariaLabelledBy: spaceSeparated,
    ariaLevel: number,
    ariaLive: null,
    ariaModal: booleanish,
    ariaMultiLine: booleanish,
    ariaMultiSelectable: booleanish,
    ariaOrientation: null,
    ariaOwns: spaceSeparated,
    ariaPlaceholder: null,
    ariaPosInSet: number,
    ariaPressed: booleanish,
    ariaReadOnly: booleanish,
    ariaRelevant: null,
    ariaRequired: booleanish,
    ariaRoleDescription: spaceSeparated,
    ariaRowCount: number,
    ariaRowIndex: number,
    ariaRowSpan: number,
    ariaSelected: booleanish,
    ariaSetSize: number,
    ariaSort: null,
    ariaValueMax: number,
    ariaValueMin: number,
    ariaValueNow: number,
    ariaValueText: null,
    role: null
  },
  transform(_, property) {
    return property === "role" ? property : "aria-" + property.slice(4).toLowerCase();
  }
});

function caseSensitiveTransform(attributes, attribute) {
  return attribute in attributes ? attributes[attribute] : attribute;
}

function caseInsensitiveTransform(attributes, property) {
  return caseSensitiveTransform(attributes, property.toLowerCase());
}

var html = create({
  attributes: {
    acceptcharset: "accept-charset",
    classname: "class",
    htmlfor: "for",
    httpequiv: "http-equiv"
  },
  mustUseProperty: ["checked", "multiple", "muted", "selected"],
  properties: {
    // Standard Properties.
    abbr: null,
    accept: commaSeparated,
    acceptCharset: spaceSeparated,
    accessKey: spaceSeparated,
    action: null,
    allow: null,
    allowFullScreen: boolean,
    allowPaymentRequest: boolean,
    allowUserMedia: boolean,
    alpha: boolean,
    alt: null,
    as: null,
    async: boolean,
    autoCapitalize: null,
    autoComplete: spaceSeparated,
    autoFocus: boolean,
    autoPlay: boolean,
    blocking: spaceSeparated,
    capture: null,
    charSet: null,
    checked: boolean,
    cite: null,
    className: spaceSeparated,
    closedBy: null,
    colorSpace: null,
    cols: number,
    colSpan: number,
    command: null,
    commandFor: null,
    content: null,
    contentEditable: booleanish,
    controls: boolean,
    controlsList: spaceSeparated,
    coords: number | commaSeparated,
    crossOrigin: null,
    data: null,
    dateTime: null,
    decoding: null,
    default: boolean,
    defer: boolean,
    dir: null,
    dirName: null,
    disabled: boolean,
    download: overloadedBoolean,
    draggable: booleanish,
    encType: null,
    enterKeyHint: null,
    fetchPriority: null,
    form: null,
    formAction: null,
    formEncType: null,
    formMethod: null,
    formNoValidate: boolean,
    formTarget: null,
    headers: spaceSeparated,
    height: number,
    hidden: overloadedBoolean,
    high: number,
    href: null,
    hrefLang: null,
    htmlFor: spaceSeparated,
    httpEquiv: spaceSeparated,
    id: null,
    imageSizes: null,
    imageSrcSet: null,
    inert: boolean,
    inputMode: null,
    integrity: null,
    is: null,
    isMap: boolean,
    itemId: null,
    itemProp: spaceSeparated,
    itemRef: spaceSeparated,
    itemScope: boolean,
    itemType: spaceSeparated,
    kind: null,
    label: null,
    lang: null,
    language: null,
    list: null,
    loading: null,
    loop: boolean,
    low: number,
    manifest: null,
    max: null,
    maxLength: number,
    media: null,
    method: null,
    min: null,
    minLength: number,
    multiple: boolean,
    muted: boolean,
    name: null,
    nonce: null,
    noModule: boolean,
    noValidate: boolean,
    onAbort: null,
    onAfterPrint: null,
    onAuxClick: null,
    onBeforeMatch: null,
    onBeforePrint: null,
    onBeforeToggle: null,
    onBeforeUnload: null,
    onBlur: null,
    onCancel: null,
    onCanPlay: null,
    onCanPlayThrough: null,
    onChange: null,
    onClick: null,
    onClose: null,
    onContextLost: null,
    onContextMenu: null,
    onContextRestored: null,
    onCopy: null,
    onCueChange: null,
    onCut: null,
    onDblClick: null,
    onDrag: null,
    onDragEnd: null,
    onDragEnter: null,
    onDragExit: null,
    onDragLeave: null,
    onDragOver: null,
    onDragStart: null,
    onDrop: null,
    onDurationChange: null,
    onEmptied: null,
    onEnded: null,
    onError: null,
    onFocus: null,
    onFormData: null,
    onHashChange: null,
    onInput: null,
    onInvalid: null,
    onKeyDown: null,
    onKeyPress: null,
    onKeyUp: null,
    onLanguageChange: null,
    onLoad: null,
    onLoadedData: null,
    onLoadedMetadata: null,
    onLoadEnd: null,
    onLoadStart: null,
    onMessage: null,
    onMessageError: null,
    onMouseDown: null,
    onMouseEnter: null,
    onMouseLeave: null,
    onMouseMove: null,
    onMouseOut: null,
    onMouseOver: null,
    onMouseUp: null,
    onOffline: null,
    onOnline: null,
    onPageHide: null,
    onPageShow: null,
    onPaste: null,
    onPause: null,
    onPlay: null,
    onPlaying: null,
    onPopState: null,
    onProgress: null,
    onRateChange: null,
    onRejectionHandled: null,
    onReset: null,
    onResize: null,
    onScroll: null,
    onScrollEnd: null,
    onSecurityPolicyViolation: null,
    onSeeked: null,
    onSeeking: null,
    onSelect: null,
    onSlotChange: null,
    onStalled: null,
    onStorage: null,
    onSubmit: null,
    onSuspend: null,
    onTimeUpdate: null,
    onToggle: null,
    onUnhandledRejection: null,
    onUnload: null,
    onVolumeChange: null,
    onWaiting: null,
    onWheel: null,
    open: boolean,
    optimum: number,
    pattern: null,
    ping: spaceSeparated,
    placeholder: null,
    playsInline: boolean,
    popover: null,
    popoverTarget: null,
    popoverTargetAction: null,
    poster: null,
    preload: null,
    readOnly: boolean,
    referrerPolicy: null,
    rel: spaceSeparated,
    required: boolean,
    reversed: boolean,
    rows: number,
    rowSpan: number,
    sandbox: spaceSeparated,
    scope: null,
    scoped: boolean,
    seamless: boolean,
    selected: boolean,
    shadowRootClonable: boolean,
    shadowRootCustomElementRegistry: boolean,
    shadowRootDelegatesFocus: boolean,
    shadowRootMode: null,
    shadowRootSerializable: boolean,
    shape: null,
    size: number,
    sizes: null,
    slot: null,
    span: number,
    spellCheck: booleanish,
    src: null,
    srcDoc: null,
    srcLang: null,
    srcSet: null,
    start: number,
    step: null,
    style: null,
    tabIndex: number,
    target: null,
    title: null,
    translate: null,
    type: null,
    typeMustMatch: boolean,
    useMap: null,
    value: booleanish,
    width: number,
    wrap: null,
    writingSuggestions: null,
    // Legacy.
    // See: https://html.spec.whatwg.org/#other-elements,-attributes-and-apis
    align: null,
    // Several. Use CSS `text-align` instead,
    aLink: null,
    // `<body>`. Use CSS `a:active {color}` instead
    archive: spaceSeparated,
    // `<object>`. List of URIs to archives
    axis: null,
    // `<td>` and `<th>`. Use `scope` on `<th>`
    background: null,
    // `<body>`. Use CSS `background-image` instead
    bgColor: null,
    // `<body>` and table elements. Use CSS `background-color` instead
    border: number,
    // `<table>`. Use CSS `border-width` instead,
    borderColor: null,
    // `<table>`. Use CSS `border-color` instead,
    bottomMargin: number,
    // `<body>`
    cellPadding: null,
    // `<table>`
    cellSpacing: null,
    // `<table>`
    char: null,
    // Several table elements. When `align=char`, sets the character to align on
    charOff: null,
    // Several table elements. When `char`, offsets the alignment
    classId: null,
    // `<object>`
    clear: null,
    // `<br>`. Use CSS `clear` instead
    code: null,
    // `<object>`
    codeBase: null,
    // `<object>`
    codeType: null,
    // `<object>`
    color: null,
    // `<font>` and `<hr>`. Use CSS instead
    compact: boolean,
    // Lists. Use CSS to reduce space between items instead
    declare: boolean,
    // `<object>`
    event: null,
    // `<script>`
    face: null,
    // `<font>`. Use CSS instead
    frame: null,
    // `<table>`
    frameBorder: null,
    // `<iframe>`. Use CSS `border` instead
    hSpace: number,
    // `<img>` and `<object>`
    leftMargin: number,
    // `<body>`
    link: null,
    // `<body>`. Use CSS `a:link {color: *}` instead
    longDesc: null,
    // `<frame>`, `<iframe>`, and `<img>`. Use an `<a>`
    lowSrc: null,
    // `<img>`. Use a `<picture>`
    marginHeight: number,
    // `<body>`
    marginWidth: number,
    // `<body>`
    noResize: boolean,
    // `<frame>`
    noHref: boolean,
    // `<area>`. Use no href instead of an explicit `nohref`
    noShade: boolean,
    // `<hr>`. Use background-color and height instead of borders
    noWrap: boolean,
    // `<td>` and `<th>`
    object: null,
    // `<applet>`
    profile: null,
    // `<head>`
    prompt: null,
    // `<isindex>`
    rev: null,
    // `<link>`
    rightMargin: number,
    // `<body>`
    rules: null,
    // `<table>`
    scheme: null,
    // `<meta>`
    scrolling: booleanish,
    // `<frame>`. Use overflow in the child context
    standby: null,
    // `<object>`
    summary: null,
    // `<table>`
    text: null,
    // `<body>`. Use CSS `color` instead
    topMargin: number,
    // `<body>`
    valueType: null,
    // `<param>`
    version: null,
    // `<html>`. Use a doctype.
    vAlign: null,
    // Several. Use CSS `vertical-align` instead
    vLink: null,
    // `<body>`. Use CSS `a:visited {color}` instead
    vSpace: number,
    // `<img>` and `<object>`
    // Non-standard Properties.
    allowTransparency: null,
    autoCorrect: null,
    autoSave: null,
    credentialless: boolean,
    disablePictureInPicture: boolean,
    disableRemotePlayback: boolean,
    exportParts: commaSeparated,
    part: spaceSeparated,
    prefix: null,
    property: null,
    results: number,
    security: null,
    unselectable: null
  },
  space: "html",
  transform: caseInsensitiveTransform
});

var svg = create({
  attributes: {
    accentHeight: "accent-height",
    alignmentBaseline: "alignment-baseline",
    arabicForm: "arabic-form",
    baselineShift: "baseline-shift",
    capHeight: "cap-height",
    className: "class",
    clipPath: "clip-path",
    clipRule: "clip-rule",
    colorInterpolation: "color-interpolation",
    colorInterpolationFilters: "color-interpolation-filters",
    colorProfile: "color-profile",
    colorRendering: "color-rendering",
    crossOrigin: "crossorigin",
    dataType: "datatype",
    dominantBaseline: "dominant-baseline",
    enableBackground: "enable-background",
    fillOpacity: "fill-opacity",
    fillRule: "fill-rule",
    floodColor: "flood-color",
    floodOpacity: "flood-opacity",
    fontFamily: "font-family",
    fontSize: "font-size",
    fontSizeAdjust: "font-size-adjust",
    fontStretch: "font-stretch",
    fontStyle: "font-style",
    fontVariant: "font-variant",
    fontWeight: "font-weight",
    glyphName: "glyph-name",
    glyphOrientationHorizontal: "glyph-orientation-horizontal",
    glyphOrientationVertical: "glyph-orientation-vertical",
    hrefLang: "hreflang",
    horizAdvX: "horiz-adv-x",
    horizOriginX: "horiz-origin-x",
    horizOriginY: "horiz-origin-y",
    imageRendering: "image-rendering",
    letterSpacing: "letter-spacing",
    lightingColor: "lighting-color",
    markerEnd: "marker-end",
    markerMid: "marker-mid",
    markerStart: "marker-start",
    maskType: "mask-type",
    navDown: "nav-down",
    navDownLeft: "nav-down-left",
    navDownRight: "nav-down-right",
    navLeft: "nav-left",
    navNext: "nav-next",
    navPrev: "nav-prev",
    navRight: "nav-right",
    navUp: "nav-up",
    navUpLeft: "nav-up-left",
    navUpRight: "nav-up-right",
    onAbort: "onabort",
    onActivate: "onactivate",
    onAfterPrint: "onafterprint",
    onBeforePrint: "onbeforeprint",
    onBegin: "onbegin",
    onCancel: "oncancel",
    onCanPlay: "oncanplay",
    onCanPlayThrough: "oncanplaythrough",
    onChange: "onchange",
    onClick: "onclick",
    onClose: "onclose",
    onCopy: "oncopy",
    onCueChange: "oncuechange",
    onCut: "oncut",
    onDblClick: "ondblclick",
    onDrag: "ondrag",
    onDragEnd: "ondragend",
    onDragEnter: "ondragenter",
    onDragExit: "ondragexit",
    onDragLeave: "ondragleave",
    onDragOver: "ondragover",
    onDragStart: "ondragstart",
    onDrop: "ondrop",
    onDurationChange: "ondurationchange",
    onEmptied: "onemptied",
    onEnd: "onend",
    onEnded: "onended",
    onError: "onerror",
    onFocus: "onfocus",
    onFocusIn: "onfocusin",
    onFocusOut: "onfocusout",
    onHashChange: "onhashchange",
    onInput: "oninput",
    onInvalid: "oninvalid",
    onKeyDown: "onkeydown",
    onKeyPress: "onkeypress",
    onKeyUp: "onkeyup",
    onLoad: "onload",
    onLoadedData: "onloadeddata",
    onLoadedMetadata: "onloadedmetadata",
    onLoadStart: "onloadstart",
    onMessage: "onmessage",
    onMouseDown: "onmousedown",
    onMouseEnter: "onmouseenter",
    onMouseLeave: "onmouseleave",
    onMouseMove: "onmousemove",
    onMouseOut: "onmouseout",
    onMouseOver: "onmouseover",
    onMouseUp: "onmouseup",
    onMouseWheel: "onmousewheel",
    onOffline: "onoffline",
    onOnline: "ononline",
    onPageHide: "onpagehide",
    onPageShow: "onpageshow",
    onPaste: "onpaste",
    onPause: "onpause",
    onPlay: "onplay",
    onPlaying: "onplaying",
    onPopState: "onpopstate",
    onProgress: "onprogress",
    onRateChange: "onratechange",
    onRepeat: "onrepeat",
    onReset: "onreset",
    onResize: "onresize",
    onScroll: "onscroll",
    onSeeked: "onseeked",
    onSeeking: "onseeking",
    onSelect: "onselect",
    onShow: "onshow",
    onStalled: "onstalled",
    onStorage: "onstorage",
    onSubmit: "onsubmit",
    onSuspend: "onsuspend",
    onTimeUpdate: "ontimeupdate",
    onToggle: "ontoggle",
    onUnload: "onunload",
    onVolumeChange: "onvolumechange",
    onWaiting: "onwaiting",
    onZoom: "onzoom",
    overlinePosition: "overline-position",
    overlineThickness: "overline-thickness",
    paintOrder: "paint-order",
    panose1: "panose-1",
    pointerEvents: "pointer-events",
    referrerPolicy: "referrerpolicy",
    renderingIntent: "rendering-intent",
    shapeRendering: "shape-rendering",
    stopColor: "stop-color",
    stopOpacity: "stop-opacity",
    strikethroughPosition: "strikethrough-position",
    strikethroughThickness: "strikethrough-thickness",
    strokeDashArray: "stroke-dasharray",
    strokeDashOffset: "stroke-dashoffset",
    strokeLineCap: "stroke-linecap",
    strokeLineJoin: "stroke-linejoin",
    strokeMiterLimit: "stroke-miterlimit",
    strokeOpacity: "stroke-opacity",
    strokeWidth: "stroke-width",
    tabIndex: "tabindex",
    textAnchor: "text-anchor",
    textDecoration: "text-decoration",
    textRendering: "text-rendering",
    transformOrigin: "transform-origin",
    typeOf: "typeof",
    underlinePosition: "underline-position",
    underlineThickness: "underline-thickness",
    unicodeBidi: "unicode-bidi",
    unicodeRange: "unicode-range",
    unitsPerEm: "units-per-em",
    vAlphabetic: "v-alphabetic",
    vHanging: "v-hanging",
    vIdeographic: "v-ideographic",
    vMathematical: "v-mathematical",
    vectorEffect: "vector-effect",
    vertAdvY: "vert-adv-y",
    vertOriginX: "vert-origin-x",
    vertOriginY: "vert-origin-y",
    wordSpacing: "word-spacing",
    writingMode: "writing-mode",
    xHeight: "x-height",
    // These were camelcased in Tiny. Now lowercased in SVG 2
    playbackOrder: "playbackorder",
    timelineBegin: "timelinebegin"
  },
  properties: {
    about: commaOrSpaceSeparated,
    accentHeight: number,
    accumulate: null,
    additive: null,
    alignmentBaseline: null,
    alphabetic: number,
    amplitude: number,
    arabicForm: null,
    ascent: number,
    attributeName: null,
    attributeType: null,
    azimuth: number,
    bandwidth: null,
    baselineShift: null,
    baseFrequency: null,
    baseProfile: null,
    bbox: null,
    begin: null,
    bias: number,
    by: null,
    calcMode: null,
    capHeight: number,
    className: spaceSeparated,
    clip: null,
    clipPath: null,
    clipPathUnits: null,
    clipRule: null,
    color: null,
    colorInterpolation: null,
    colorInterpolationFilters: null,
    colorProfile: null,
    colorRendering: null,
    content: null,
    contentScriptType: null,
    contentStyleType: null,
    crossOrigin: null,
    cursor: null,
    cx: null,
    cy: null,
    d: null,
    dataType: null,
    defaultAction: null,
    descent: number,
    diffuseConstant: number,
    direction: null,
    display: null,
    dur: null,
    divisor: number,
    dominantBaseline: null,
    download: boolean,
    dx: null,
    dy: null,
    edgeMode: null,
    editable: null,
    elevation: number,
    enableBackground: null,
    end: null,
    event: null,
    exponent: number,
    externalResourcesRequired: null,
    fill: null,
    fillOpacity: number,
    fillRule: null,
    filter: null,
    filterRes: null,
    filterUnits: null,
    floodColor: null,
    floodOpacity: null,
    focusable: null,
    focusHighlight: null,
    fontFamily: null,
    fontSize: null,
    fontSizeAdjust: null,
    fontStretch: null,
    fontStyle: null,
    fontVariant: null,
    fontWeight: null,
    format: null,
    fr: null,
    from: null,
    fx: null,
    fy: null,
    g1: commaSeparated,
    g2: commaSeparated,
    glyphName: commaSeparated,
    glyphOrientationHorizontal: null,
    glyphOrientationVertical: null,
    glyphRef: null,
    gradientTransform: null,
    gradientUnits: null,
    handler: null,
    hanging: number,
    hatchContentUnits: null,
    hatchUnits: null,
    height: null,
    href: null,
    hrefLang: null,
    horizAdvX: number,
    horizOriginX: number,
    horizOriginY: number,
    id: null,
    ideographic: number,
    imageRendering: null,
    initialVisibility: null,
    in: null,
    in2: null,
    intercept: number,
    k: number,
    k1: number,
    k2: number,
    k3: number,
    k4: number,
    kernelMatrix: commaOrSpaceSeparated,
    kernelUnitLength: null,
    keyPoints: null,
    // SEMI_COLON_SEPARATED
    keySplines: null,
    // SEMI_COLON_SEPARATED
    keyTimes: null,
    // SEMI_COLON_SEPARATED
    kerning: null,
    lang: null,
    lengthAdjust: null,
    letterSpacing: null,
    lightingColor: null,
    limitingConeAngle: number,
    local: null,
    markerEnd: null,
    markerMid: null,
    markerStart: null,
    markerHeight: null,
    markerUnits: null,
    markerWidth: null,
    mask: null,
    maskContentUnits: null,
    maskType: null,
    maskUnits: null,
    mathematical: null,
    max: null,
    media: null,
    mediaCharacterEncoding: null,
    mediaContentEncodings: null,
    mediaSize: number,
    mediaTime: null,
    method: null,
    min: null,
    mode: null,
    name: null,
    navDown: null,
    navDownLeft: null,
    navDownRight: null,
    navLeft: null,
    navNext: null,
    navPrev: null,
    navRight: null,
    navUp: null,
    navUpLeft: null,
    navUpRight: null,
    numOctaves: null,
    observer: null,
    offset: null,
    onAbort: null,
    onActivate: null,
    onAfterPrint: null,
    onBeforePrint: null,
    onBegin: null,
    onCancel: null,
    onCanPlay: null,
    onCanPlayThrough: null,
    onChange: null,
    onClick: null,
    onClose: null,
    onCopy: null,
    onCueChange: null,
    onCut: null,
    onDblClick: null,
    onDrag: null,
    onDragEnd: null,
    onDragEnter: null,
    onDragExit: null,
    onDragLeave: null,
    onDragOver: null,
    onDragStart: null,
    onDrop: null,
    onDurationChange: null,
    onEmptied: null,
    onEnd: null,
    onEnded: null,
    onError: null,
    onFocus: null,
    onFocusIn: null,
    onFocusOut: null,
    onHashChange: null,
    onInput: null,
    onInvalid: null,
    onKeyDown: null,
    onKeyPress: null,
    onKeyUp: null,
    onLoad: null,
    onLoadedData: null,
    onLoadedMetadata: null,
    onLoadStart: null,
    onMessage: null,
    onMouseDown: null,
    onMouseEnter: null,
    onMouseLeave: null,
    onMouseMove: null,
    onMouseOut: null,
    onMouseOver: null,
    onMouseUp: null,
    onMouseWheel: null,
    onOffline: null,
    onOnline: null,
    onPageHide: null,
    onPageShow: null,
    onPaste: null,
    onPause: null,
    onPlay: null,
    onPlaying: null,
    onPopState: null,
    onProgress: null,
    onRateChange: null,
    onRepeat: null,
    onReset: null,
    onResize: null,
    onScroll: null,
    onSeeked: null,
    onSeeking: null,
    onSelect: null,
    onShow: null,
    onStalled: null,
    onStorage: null,
    onSubmit: null,
    onSuspend: null,
    onTimeUpdate: null,
    onToggle: null,
    onUnload: null,
    onVolumeChange: null,
    onWaiting: null,
    onZoom: null,
    opacity: null,
    operator: null,
    order: null,
    orient: null,
    orientation: null,
    origin: null,
    overflow: null,
    overlay: null,
    overlinePosition: number,
    overlineThickness: number,
    paintOrder: null,
    panose1: null,
    path: null,
    pathLength: number,
    patternContentUnits: null,
    patternTransform: null,
    patternUnits: null,
    phase: null,
    ping: spaceSeparated,
    pitch: null,
    playbackOrder: null,
    pointerEvents: null,
    points: null,
    pointsAtX: number,
    pointsAtY: number,
    pointsAtZ: number,
    preserveAlpha: null,
    preserveAspectRatio: null,
    primitiveUnits: null,
    propagate: null,
    property: commaOrSpaceSeparated,
    r: null,
    radius: null,
    referrerPolicy: null,
    refX: null,
    refY: null,
    rel: commaOrSpaceSeparated,
    rev: commaOrSpaceSeparated,
    renderingIntent: null,
    repeatCount: null,
    repeatDur: null,
    requiredExtensions: commaOrSpaceSeparated,
    requiredFeatures: commaOrSpaceSeparated,
    requiredFonts: commaOrSpaceSeparated,
    requiredFormats: commaOrSpaceSeparated,
    resource: null,
    restart: null,
    result: null,
    rotate: null,
    rx: null,
    ry: null,
    scale: null,
    seed: null,
    shapeRendering: null,
    side: null,
    slope: null,
    snapshotTime: null,
    specularConstant: number,
    specularExponent: number,
    spreadMethod: null,
    spacing: null,
    startOffset: null,
    stdDeviation: null,
    stemh: null,
    stemv: null,
    stitchTiles: null,
    stopColor: null,
    stopOpacity: null,
    strikethroughPosition: number,
    strikethroughThickness: number,
    string: null,
    stroke: null,
    strokeDashArray: commaOrSpaceSeparated,
    strokeDashOffset: null,
    strokeLineCap: null,
    strokeLineJoin: null,
    strokeMiterLimit: number,
    strokeOpacity: number,
    strokeWidth: null,
    style: null,
    surfaceScale: number,
    syncBehavior: null,
    syncBehaviorDefault: null,
    syncMaster: null,
    syncTolerance: null,
    syncToleranceDefault: null,
    systemLanguage: commaOrSpaceSeparated,
    tabIndex: number,
    tableValues: null,
    target: null,
    targetX: number,
    targetY: number,
    textAnchor: null,
    textDecoration: null,
    textRendering: null,
    textLength: null,
    timelineBegin: null,
    title: null,
    transformBehavior: null,
    type: null,
    typeOf: commaOrSpaceSeparated,
    to: null,
    transform: null,
    transformOrigin: null,
    u1: null,
    u2: null,
    underlinePosition: number,
    underlineThickness: number,
    unicode: null,
    unicodeBidi: null,
    unicodeRange: null,
    unitsPerEm: number,
    values: null,
    vAlphabetic: number,
    vMathematical: number,
    vectorEffect: null,
    vHanging: number,
    vIdeographic: number,
    version: null,
    vertAdvY: number,
    vertOriginX: number,
    vertOriginY: number,
    viewBox: null,
    viewTarget: null,
    visibility: null,
    width: null,
    widths: null,
    wordSpacing: null,
    writingMode: null,
    x: null,
    x1: null,
    x2: null,
    xChannelSelector: null,
    xHeight: number,
    y: null,
    y1: null,
    y2: null,
    yChannelSelector: null,
    z: null,
    zoomAndPan: null
  },
  space: "svg",
  transform: caseSensitiveTransform
});

var xlink = create({
  properties: {
    xLinkActuate: null,
    xLinkArcRole: null,
    xLinkHref: null,
    xLinkRole: null,
    xLinkShow: null,
    xLinkTitle: null,
    xLinkType: null
  },
  space: "xlink",
  transform(_, property) {
    return "xlink:" + property.slice(5).toLowerCase();
  }
});

var xmlns = create({
  attributes: { xmlnsxlink: "xmlns:xlink" },
  properties: { xmlnsXLink: null, xmlns: null },
  space: "xmlns",
  transform: caseInsensitiveTransform
});

var xml = create({
  properties: { xmlBase: null, xmlLang: null, xmlSpace: null },
  space: "xml",
  transform(_, property) {
    return "xml:" + property.slice(3).toLowerCase();
  }
});

var hastToReact = {
  classId: "classID",
  dataType: "datatype",
  itemId: "itemID",
  strokeDashArray: "strokeDasharray",
  strokeDashOffset: "strokeDashoffset",
  strokeLineCap: "strokeLinecap",
  strokeLineJoin: "strokeLinejoin",
  strokeMiterLimit: "strokeMiterlimit",
  typeOf: "typeof",
  xLinkActuate: "xlinkActuate",
  xLinkArcRole: "xlinkArcrole",
  xLinkHref: "xlinkHref",
  xLinkRole: "xlinkRole",
  xLinkShow: "xlinkShow",
  xLinkTitle: "xlinkTitle",
  xLinkType: "xlinkType",
  xmlnsXLink: "xmlnsXlink"
};

var cap = /[A-Z]/g;
var dash = /-[a-z]/g;
var valid = /^data[-\w.:]+$/i;
function find(schema, value) {
  const normal = normalize(value);
  let property = value;
  let Type = Info;
  if (normal in schema.normal) {
    return schema.property[schema.normal[normal]];
  }
  if (normal.length > 4 && normal.slice(0, 4) === "data" && valid.test(value)) {
    if (value.charAt(4) === "-") {
      const rest = value.slice(5).replace(dash, camelcase);
      property = "data" + rest.charAt(0).toUpperCase() + rest.slice(1);
    } else {
      const rest = value.slice(4);
      if (!dash.test(rest)) {
        let dashes = rest.replace(cap, kebab);
        if (dashes.charAt(0) !== "-") {
          dashes = "-" + dashes;
        }
        value = "data" + dashes;
      }
    }
    Type = DefinedInfo;
  }
  return new Type(property, value);
}
function kebab($0) {
  return "-" + $0.toLowerCase();
}
function camelcase($0) {
  return $0.charAt(1).toUpperCase();
}

var html2 = merge([aria, html, xlink, xmlns, xml], "html");
var svg2 = merge([aria, svg, xlink, xmlns, xml], "svg");

function stringify2(values) {
  return values.join(" ").trim();
}

var COMMENT_REGEX = /\/\*(?:[^*]|\*(?!\/))*\*\//g;
var NEWLINE_REGEX = /\n/g;
var WHITESPACE_REGEX = /^\s*/;
var PROPERTY_REGEX = /^(\*?[-#/*\\\w]+(\[[0-9a-z_-]+\])?)\s*/;
var COLON_REGEX = /^:\s*/;
var VALUE_REGEX = /^((?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|url\((?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|[^)]*)\)|[^};])+)/;
var SEMICOLON_REGEX = /^[;\s]*/;
var NEWLINE = "\n";
var FORWARD_SLASH = "/";
var ASTERISK = "*";
var EMPTY_STRING = "";
var TYPE_COMMENT = "comment";
var TYPE_DECLARATION = "declaration";
function index(style, options) {
  if (typeof style !== "string") {
    throw new TypeError("First argument must be a string");
  }
  if (!style) return [];
  options = options || {};
  var lineno = 1;
  var column = 1;
  function updatePosition(str) {
    var lines = str.match(NEWLINE_REGEX);
    if (lines) lineno += lines.length;
    var i = str.lastIndexOf(NEWLINE);
    column = ~i ? str.length - i : column + str.length;
  }
  function position3() {
    var start2 = { line: lineno, column };
    return function(node2) {
      node2.position = new Position(start2);
      whitespace2();
      return node2;
    };
  }
  function Position(start2) {
    this.start = start2;
    this.end = { line: lineno, column };
    this.source = options.source;
  }
  Position.prototype.content = style;
  function error(msg) {
    var err = new Error(
      options.source + ":" + lineno + ":" + column + ": " + msg
    );
    err.reason = msg;
    err.filename = options.source;
    err.line = lineno;
    err.column = column;
    err.source = style;
    if (options.silent) ;
    else {
      throw err;
    }
  }
  function match(re2) {
    var m = re2.exec(style);
    if (!m) return;
    var str = m[0];
    updatePosition(str);
    style = style.slice(str.length);
    return m;
  }
  function whitespace2() {
    match(WHITESPACE_REGEX);
  }
  function comments(rules) {
    var c;
    while (c = comment()) {
      rules.push(c);
    }
    return rules;
  }
  function comment() {
    var pos = position3();
    if (FORWARD_SLASH != style.charAt(0) || ASTERISK != style.charAt(1)) return;
    var i = 2;
    while (EMPTY_STRING != style.charAt(i) && (ASTERISK != style.charAt(i) || FORWARD_SLASH != style.charAt(i + 1))) {
      ++i;
    }
    i += 2;
    if (EMPTY_STRING === style.charAt(i - 1)) {
      return error("End of comment missing");
    }
    var str = style.slice(2, i - 2);
    column += 2;
    updatePosition(str);
    style = style.slice(i);
    column += 2;
    return pos({
      type: TYPE_COMMENT,
      comment: str
    });
  }
  function declaration() {
    var pos = position3();
    var prop = match(PROPERTY_REGEX);
    if (!prop) return;
    comment();
    if (!match(COLON_REGEX)) return error("property missing ':'");
    var val = match(VALUE_REGEX);
    var ret = pos({
      type: TYPE_DECLARATION,
      property: prop[0].replace(COMMENT_REGEX, EMPTY_STRING).trim(),
      value: val ? val[0].replace(COMMENT_REGEX, EMPTY_STRING).trim() : EMPTY_STRING
    });
    match(SEMICOLON_REGEX);
    return ret;
  }
  function declarations() {
    var decls = [];
    comments(decls);
    var decl;
    while (decl = declaration()) {
      decls.push(decl);
      comments(decls);
    }
    return decls;
  }
  whitespace2();
  return declarations();
}

function StyleToObject(style, iterator) {
  let styleObject = null;
  if (!style || typeof style !== "string") return styleObject;
  const declarations = index(style);
  const hasIterator = typeof iterator === "function";
  declarations.forEach((declaration) => {
    if (declaration.type !== "declaration") return;
    const { property, value } = declaration;
    if (hasIterator) iterator(property, value, declaration);
    else if (value) {
      styleObject = styleObject ?? {};
      styleObject[property] = value;
    }
  });
  return styleObject;
}

var pointEnd = point("end");
var pointStart = point("start");
function point(type) {
  return point4;
  function point4(node2) {
    const point5 = node2 && node2.position && node2.position[type] || {};
    if (typeof point5.line === "number" && point5.line > 0 && typeof point5.column === "number" && point5.column > 0) {
      return {
        line: point5.line,
        column: point5.column,
        offset: typeof point5.offset === "number" && point5.offset > -1 ? point5.offset : void 0
      };
    }
  }
}
function position(node2) {
  const start2 = pointStart(node2);
  const end = pointEnd(node2);
  if (start2 && end) {
    return { start: start2, end };
  }
}

function stringifyPosition(value) {
  if (!value || typeof value !== "object") {
    return "";
  }
  if ("position" in value || "type" in value) {
    return position2(value.position);
  }
  if ("start" in value || "end" in value) {
    return position2(value);
  }
  if ("line" in value || "column" in value) {
    return point2(value);
  }
  return "";
}
function point2(point4) {
  return index2(point4 && point4.line) + ":" + index2(point4 && point4.column);
}
function position2(pos) {
  return point2(pos && pos.start) + "-" + point2(pos && pos.end);
}
function index2(value) {
  return value && typeof value === "number" ? value : 1;
}

var VFileMessage = class extends Error {
  /**
   * Create a message for `reason`.
   *
   * > 🪦 **Note**: also has obsolete signatures.
   *
   * @overload
   * @param {string} reason
   *   Reason for message, should use markdown.
   * @param {Options | null | undefined} [options]
   *   Configuration (optional).
   * @returns
   *   Instance of `VFileMessage`.
   *
   * @overload
   * @param {string} reason
   *   Reason for message, should use markdown.
   * @param {Node | NodeLike | null | undefined} parent
   *   Node or node-like, used for `ancestors` and `place`.
   * @param {string | null | undefined} [origin]
   *   Place in code where the message originates (optional).
   * @returns
   *   Instance of `VFileMessage`.
   *
   * @overload
   * @param {string} reason
   *   Reason for message, should use markdown.
   * @param {Point | Position | null | undefined} place
   *   Place of message.
   * @param {string | null | undefined} [origin]
   *   Place in code where the message originates (optional).
   * @returns
   *   Instance of `VFileMessage`.
   *
   * @overload
   * @param {string} reason
   *   Reason for message, should use markdown.
   * @param {string | null | undefined} [origin]
   *   Place in code where the message originates (optional).
   * @returns
   *   Instance of `VFileMessage`.
   *
   * @overload
   * @param {Error | VFileMessage} cause
   *   Original error cause of the message.
   * @param {Node | NodeLike | null | undefined} parent
   *   Node or node-like, used for `ancestors` and `place`.
   * @param {string | null | undefined} [origin]
   *   Place in code where the message originates (optional).
   * @returns
   *   Instance of `VFileMessage`.
   *
   * @overload
   * @param {Error | VFileMessage} cause
   *   Original error cause of the message.
   * @param {Point | Position | null | undefined} place
   *   Place of message.
   * @param {string | null | undefined} [origin]
   *   Place in code where the message originates (optional).
   * @returns
   *   Instance of `VFileMessage`.
   *
   * @overload
   * @param {Error | VFileMessage} cause
   *   Original error cause of the message.
   * @param {string | null | undefined} [origin]
   *   Place in code where the message originates (optional).
   * @returns
   *   Instance of `VFileMessage`.
   *
   * @param {Error | VFileMessage | string} causeOrReason
   *   Reason for message, should use markdown.
   * @param {Node | NodeLike | Options | Point | Position | string | null | undefined} [optionsOrParentOrPlace]
   *   Configuration (optional).
   * @param {string | null | undefined} [origin]
   *   Place in code where the message originates (example:
   *   `'my-package:my-rule'` or `'my-rule'`).
   * @returns
   *   Instance of `VFileMessage`.
   */
  // eslint-disable-next-line complexity
  constructor(causeOrReason, optionsOrParentOrPlace, origin) {
    super();
    if (typeof optionsOrParentOrPlace === "string") {
      origin = optionsOrParentOrPlace;
      optionsOrParentOrPlace = void 0;
    }
    let reason = "";
    let options = {};
    let legacyCause = false;
    if (optionsOrParentOrPlace) {
      if ("line" in optionsOrParentOrPlace && "column" in optionsOrParentOrPlace) {
        options = { place: optionsOrParentOrPlace };
      } else if ("start" in optionsOrParentOrPlace && "end" in optionsOrParentOrPlace) {
        options = { place: optionsOrParentOrPlace };
      } else if ("type" in optionsOrParentOrPlace) {
        options = {
          ancestors: [optionsOrParentOrPlace],
          place: optionsOrParentOrPlace.position
        };
      } else {
        options = { ...optionsOrParentOrPlace };
      }
    }
    if (typeof causeOrReason === "string") {
      reason = causeOrReason;
    } else if (!options.cause && causeOrReason) {
      legacyCause = true;
      reason = causeOrReason.message;
      options.cause = causeOrReason;
    }
    if (!options.ruleId && !options.source && typeof origin === "string") {
      const index3 = origin.indexOf(":");
      if (index3 === -1) {
        options.ruleId = origin;
      } else {
        options.source = origin.slice(0, index3);
        options.ruleId = origin.slice(index3 + 1);
      }
    }
    if (!options.place && options.ancestors) {
      const parent = options.ancestors[options.ancestors.length - 1];
      if (parent) {
        options.place = parent.position;
      }
    }
    const start2 = options.place && "start" in options.place ? options.place.start : options.place;
    this.ancestors = options.ancestors || void 0;
    this.cause = options.cause || void 0;
    this.column = start2 ? start2.column : void 0;
    this.fatal = void 0;
    this.file = "";
    this.message = reason;
    this.line = start2 ? start2.line : void 0;
    this.name = stringifyPosition(options.place) || "1:1";
    this.place = options.place || void 0;
    this.reason = this.message;
    this.ruleId = options.ruleId || void 0;
    this.source = options.source || void 0;
    this.stack = legacyCause && options.cause && typeof options.cause.stack === "string" ? options.cause.stack : "";
    this.actual = void 0;
    this.expected = void 0;
    this.note = void 0;
    this.url = void 0;
  }
};
Object.defineProperties(VFileMessage.prototype, {
  file: { configurable: true, enumerable: true, value: "", writable: true },
  name: { configurable: true, enumerable: true, value: "", writable: true },
  reason: { configurable: true, enumerable: true, value: "", writable: true },
  message: { configurable: true, enumerable: true, value: "", writable: true },
  stack: { configurable: true, enumerable: true, value: "", writable: true },
  column: { configurable: true, enumerable: true, writable: true },
  line: { configurable: true, enumerable: true, writable: true },
  ancestors: { configurable: true, enumerable: true, writable: true },
  cause: { configurable: true, enumerable: true, writable: true },
  fatal: { configurable: true, enumerable: true, writable: true },
  place: { configurable: true, enumerable: true, writable: true },
  ruleId: { configurable: true, enumerable: true, writable: true },
  source: { configurable: true, enumerable: true, writable: true }
});

var own = {}.hasOwnProperty;
var emptyMap = /* @__PURE__ */ new Map();
var cap2 = /[A-Z]/g;
var dashLetter = /-([a-z])/g;
var tableElements = /* @__PURE__ */ new Set(["table", "tbody", "thead", "tfoot", "tr"]);
var tableCellElement = /* @__PURE__ */ new Set(["td", "th"]);
var docs = "https://github.com/syntax-tree/hast-util-to-jsx-runtime";
function toJsxRuntime(tree, options) {
  if (!options || options.Fragment === void 0) {
    throw new TypeError("Expected `Fragment` in options");
  }
  const filePath = options.filePath || void 0;
  let create2;
  if (options.development) {
    if (typeof options.jsxDEV !== "function") {
      throw new TypeError(
        "Expected `jsxDEV` in options when `development: true`"
      );
    }
    create2 = developmentCreate(filePath, options.jsxDEV);
  } else {
    if (typeof options.jsx !== "function") {
      throw new TypeError("Expected `jsx` in production options");
    }
    if (typeof options.jsxs !== "function") {
      throw new TypeError("Expected `jsxs` in production options");
    }
    create2 = productionCreate(filePath, options.jsx, options.jsxs);
  }
  const state = {
    Fragment: options.Fragment,
    ancestors: [],
    components: options.components || {},
    create: create2,
    elementAttributeNameCase: options.elementAttributeNameCase || "react",
    evaluater: options.createEvaluater ? options.createEvaluater() : void 0,
    filePath,
    ignoreInvalidStyle: options.ignoreInvalidStyle || false,
    passKeys: options.passKeys !== false,
    passNode: options.passNode || false,
    schema: options.space === "svg" ? svg2 : html2,
    stylePropertyNameCase: options.stylePropertyNameCase || "dom",
    tableCellAlignToStyle: options.tableCellAlignToStyle !== false
  };
  const result = one(state, tree, void 0);
  if (result && typeof result !== "string") {
    return result;
  }
  return state.create(
    tree,
    state.Fragment,
    { children: result || void 0 },
    void 0
  );
}
function one(state, node2, key) {
  if (node2.type === "element") {
    return element(state, node2, key);
  }
  if (node2.type === "mdxFlowExpression" || node2.type === "mdxTextExpression") {
    return mdxExpression(state, node2);
  }
  if (node2.type === "mdxJsxFlowElement" || node2.type === "mdxJsxTextElement") {
    return mdxJsxElement(state, node2, key);
  }
  if (node2.type === "mdxjsEsm") {
    return mdxEsm(state, node2);
  }
  if (node2.type === "root") {
    return root(state, node2, key);
  }
  if (node2.type === "text") {
    return text(state, node2);
  }
}
function element(state, node2, key) {
  const parentSchema = state.schema;
  let schema = parentSchema;
  if (node2.tagName.toLowerCase() === "svg" && parentSchema.space === "html") {
    schema = svg2;
    state.schema = schema;
  }
  state.ancestors.push(node2);
  const type = findComponentFromName(state, node2.tagName, false);
  const props = createElementProps(state, node2);
  let children = createChildren(state, node2);
  if (tableElements.has(node2.tagName)) {
    children = children.filter(function(child) {
      return typeof child === "string" ? !whitespace(child) : true;
    });
  }
  addNode(state, props, type, node2);
  addChildren(props, children);
  state.ancestors.pop();
  state.schema = parentSchema;
  return state.create(node2, type, props, key);
}
function mdxExpression(state, node2) {
  if (node2.data && node2.data.estree && state.evaluater) {
    const program = node2.data.estree;
    const expression = program.body[0];
    ok(expression.type === "ExpressionStatement");
    return (
      /** @type {Child | undefined} */
      state.evaluater.evaluateExpression(expression.expression)
    );
  }
  crashEstree(state, node2.position);
}
function mdxEsm(state, node2) {
  if (node2.data && node2.data.estree && state.evaluater) {
    return (
      /** @type {Child | undefined} */
      state.evaluater.evaluateProgram(node2.data.estree)
    );
  }
  crashEstree(state, node2.position);
}
function mdxJsxElement(state, node2, key) {
  const parentSchema = state.schema;
  let schema = parentSchema;
  if (node2.name === "svg" && parentSchema.space === "html") {
    schema = svg2;
    state.schema = schema;
  }
  state.ancestors.push(node2);
  const type = node2.name === null ? state.Fragment : findComponentFromName(state, node2.name, true);
  const props = createJsxElementProps(state, node2);
  const children = createChildren(state, node2);
  addNode(state, props, type, node2);
  addChildren(props, children);
  state.ancestors.pop();
  state.schema = parentSchema;
  return state.create(node2, type, props, key);
}
function root(state, node2, key) {
  const props = {};
  addChildren(props, createChildren(state, node2));
  return state.create(node2, state.Fragment, props, key);
}
function text(_, node2) {
  return node2.value;
}
function addNode(state, props, type, node2) {
  if (typeof type !== "string" && type !== state.Fragment && state.passNode) {
    props.node = node2;
  }
}
function addChildren(props, children) {
  if (children.length > 0) {
    const value = children.length > 1 ? children : children[0];
    if (value) {
      props.children = value;
    }
  }
}
function productionCreate(_, jsx2, jsxs2) {
  return create2;
  function create2(_2, type, props, key) {
    const isStaticChildren = Array.isArray(props.children);
    const fn = isStaticChildren ? jsxs2 : jsx2;
    return key ? fn(type, props, key) : fn(type, props);
  }
}
function developmentCreate(filePath, jsxDEV) {
  return create2;
  function create2(node2, type, props, key) {
    const isStaticChildren = Array.isArray(props.children);
    const point4 = pointStart(node2);
    return jsxDEV(
      type,
      props,
      key,
      isStaticChildren,
      {
        columnNumber: point4 ? point4.column - 1 : void 0,
        fileName: filePath,
        lineNumber: point4 ? point4.line : void 0
      },
      void 0
    );
  }
}
function createElementProps(state, node2) {
  const props = {};
  let alignValue;
  let prop;
  for (prop in node2.properties) {
    if (prop !== "children" && own.call(node2.properties, prop)) {
      const result = createProperty(state, prop, node2.properties[prop]);
      if (result) {
        const [key, value] = result;
        if (state.tableCellAlignToStyle && key === "align" && typeof value === "string" && tableCellElement.has(node2.tagName)) {
          alignValue = value;
        } else {
          props[key] = value;
        }
      }
    }
  }
  if (alignValue) {
    const style = (
      /** @type {Style} */
      props.style || (props.style = {})
    );
    style[state.stylePropertyNameCase === "css" ? "text-align" : "textAlign"] = alignValue;
  }
  return props;
}
function createJsxElementProps(state, node2) {
  const props = {};
  for (const attribute of node2.attributes) {
    if (attribute.type === "mdxJsxExpressionAttribute") {
      if (attribute.data && attribute.data.estree && state.evaluater) {
        const program = attribute.data.estree;
        const expression = program.body[0];
        ok(expression.type === "ExpressionStatement");
        const objectExpression = expression.expression;
        ok(objectExpression.type === "ObjectExpression");
        const property = objectExpression.properties[0];
        ok(property.type === "SpreadElement");
        Object.assign(
          props,
          state.evaluater.evaluateExpression(property.argument)
        );
      } else {
        crashEstree(state, node2.position);
      }
    } else {
      const { name: name2 } = attribute;
      let value;
      if (attribute.value && typeof attribute.value === "object") {
        if (attribute.value.data && attribute.value.data.estree && state.evaluater) {
          const program = attribute.value.data.estree;
          const expression = program.body[0];
          ok(expression.type === "ExpressionStatement");
          value = state.evaluater.evaluateExpression(expression.expression);
        } else {
          crashEstree(state, node2.position);
        }
      } else {
        value = attribute.value === null ? true : attribute.value;
      }
      props[name2] = /** @type {Props[keyof Props]} */
      value;
    }
  }
  return props;
}
function createChildren(state, node2) {
  const children = [];
  let index3 = -1;
  const countsByName = state.passKeys ? /* @__PURE__ */ new Map() : emptyMap;
  while (++index3 < node2.children.length) {
    const child = node2.children[index3];
    let key;
    if (state.passKeys) {
      const name2 = child.type === "element" ? child.tagName : child.type === "mdxJsxFlowElement" || child.type === "mdxJsxTextElement" ? child.name : void 0;
      if (name2) {
        const count = countsByName.get(name2) || 0;
        key = name2 + "-" + count;
        countsByName.set(name2, count + 1);
      }
    }
    const result = one(state, child, key);
    if (result !== void 0) children.push(result);
  }
  return children;
}
function createProperty(state, prop, value) {
  if (value === null || value === void 0 || typeof value === "number" && Number.isNaN(value)) {
    return;
  }
  const info = find(state.schema, prop);
  if (Array.isArray(value)) {
    value = info.commaSeparated ? stringify(value) : stringify2(value);
  }
  if (info.property === "style") {
    const styleObject = typeof value === "object" ? state.stylePropertyNameCase === "dom" ? value : transformStylesToCssCasing(value) : parseStyle(state, String(value));
    return ["style", styleObject];
  }
  return [
    state.elementAttributeNameCase === "react" && info.space ? hastToReact[info.property] || info.property : info.attribute,
    value
  ];
}
function parseStyle(state, value) {
  const result = {};
  try {
    StyleToObject(value, function(property, value2) {
      if (property && value2) {
        let name2 = property;
        if (name2.slice(0, 2) !== "--") {
          name2 = name2.toLowerCase();
          if (state.stylePropertyNameCase === "dom") {
            if (name2.slice(0, 4) === "-ms-") name2 = name2.slice(1);
            name2 = name2.replace(dashLetter, toCamel);
          }
        }
        result[name2] = value2;
      }
    });
  } catch (error) {
    if (state.ignoreInvalidStyle) {
      return {};
    }
    const cause = (
      /** @type {Error} */
      error
    );
    const message = new VFileMessage("Cannot parse `style` attribute", {
      ancestors: state.ancestors,
      cause,
      ruleId: "style",
      source: "hast-util-to-jsx-runtime"
    });
    message.file = state.filePath || void 0;
    message.url = docs + "#cannot-parse-style-attribute";
    throw message;
  }
  return result;
}
function findComponentFromName(state, name2, allowExpression) {
  let result;
  if (!allowExpression) {
    result = { type: "Literal", value: name2 };
  } else if (name2.includes(".")) {
    const identifiers = name2.split(".");
    let index3 = -1;
    let node2;
    while (++index3 < identifiers.length) {
      const prop = name(identifiers[index3]) ? { type: "Identifier", name: identifiers[index3] } : { type: "Literal", value: identifiers[index3] };
      node2 = node2 ? {
        type: "MemberExpression",
        object: node2,
        property: prop,
        computed: Boolean(index3 && prop.type === "Literal"),
        optional: false
      } : prop;
    }
    ok(node2, "always a result");
    result = node2;
  } else {
    result = name(name2) && !/^[a-z]/.test(name2) ? { type: "Identifier", name: name2 } : { type: "Literal", value: name2 };
  }
  if (result.type === "Literal") {
    const name3 = (
      /** @type {string | number} */
      result.value
    );
    return own.call(state.components, name3) ? state.components[name3] : name3;
  }
  if (state.evaluater) {
    return state.evaluater.evaluateExpression(result);
  }
  crashEstree(state);
}
function crashEstree(state, place) {
  const message = new VFileMessage(
    "Cannot handle MDX estrees without `createEvaluater`",
    {
      ancestors: state.ancestors,
      place,
      ruleId: "mdx-estree",
      source: "hast-util-to-jsx-runtime"
    }
  );
  message.file = state.filePath || void 0;
  message.url = docs + "#cannot-handle-mdx-estrees-without-createevaluater";
  throw message;
}
function transformStylesToCssCasing(domCasing) {
  const cssCasing = {};
  let from;
  for (from in domCasing) {
    if (own.call(domCasing, from)) {
      cssCasing[transformStyleToCssCasing(from)] = domCasing[from];
    }
  }
  return cssCasing;
}
function transformStyleToCssCasing(from) {
  if (from.slice(0, 2) === "--") return from;
  let to = from.replace(cap2, toDash);
  if (to.slice(0, 3) === "ms-") to = "-" + to;
  return to;
}
function toDash($0) {
  return "-" + $0.toLowerCase();
}
function toCamel(_, $1) {
  return $1.toUpperCase();
}

var urlAttributes = {
  action: ["form"],
  cite: ["blockquote", "del", "ins", "q"],
  data: ["object"],
  formAction: ["button", "input"],
  href: ["a", "area", "base", "link"],
  icon: ["menuitem"],
  itemId: null,
  manifest: ["html"],
  ping: ["a", "area"],
  poster: ["video"],
  src: [
    "audio",
    "embed",
    "iframe",
    "img",
    "input",
    "script",
    "source",
    "track",
    "video"
  ]
};

// src/client-jsx-runtime.ts
var import_react = require("react");
function jsx(type, props, key) {
  return (0, import_react.createElement)(type, key === void 0 ? props : { ...props, key });
}
var jsxs = jsx;

var import_react2 = require("react");

var emptyOptions2 = {};
function toString(value, options) {
  const settings = options || emptyOptions2;
  const includeImageAlt = typeof settings.includeImageAlt === "boolean" ? settings.includeImageAlt : true;
  const includeHtml = typeof settings.includeHtml === "boolean" ? settings.includeHtml : true;
  return one2(value, includeImageAlt, includeHtml);
}
function one2(value, includeImageAlt, includeHtml) {
  if (node(value)) {
    if ("value" in value) {
      return value.type === "html" && !includeHtml ? "" : value.value;
    }
    if (includeImageAlt && "alt" in value && value.alt) {
      return value.alt;
    }
    if ("children" in value) {
      return all(value.children, includeImageAlt, includeHtml);
    }
  }
  if (Array.isArray(value)) {
    return all(value, includeImageAlt, includeHtml);
  }
  return "";
}
function all(values, includeImageAlt, includeHtml) {
  const result = [];
  let index3 = -1;
  while (++index3 < values.length) {
    result[index3] = one2(values[index3], includeImageAlt, includeHtml);
  }
  return result.join("");
}
function node(value) {
  return Boolean(value && typeof value === "object");
}

var characterEntities = {
  AElig: "\xC6",
  AMP: "&",
  Aacute: "\xC1",
  Abreve: "\u0102",
  Acirc: "\xC2",
  Acy: "\u0410",
  Afr: "\u{1D504}",
  Agrave: "\xC0",
  Alpha: "\u0391",
  Amacr: "\u0100",
  And: "\u2A53",
  Aogon: "\u0104",
  Aopf: "\u{1D538}",
  ApplyFunction: "\u2061",
  Aring: "\xC5",
  Ascr: "\u{1D49C}",
  Assign: "\u2254",
  Atilde: "\xC3",
  Auml: "\xC4",
  Backslash: "\u2216",
  Barv: "\u2AE7",
  Barwed: "\u2306",
  Bcy: "\u0411",
  Because: "\u2235",
  Bernoullis: "\u212C",
  Beta: "\u0392",
  Bfr: "\u{1D505}",
  Bopf: "\u{1D539}",
  Breve: "\u02D8",
  Bscr: "\u212C",
  Bumpeq: "\u224E",
  CHcy: "\u0427",
  COPY: "\xA9",
  Cacute: "\u0106",
  Cap: "\u22D2",
  CapitalDifferentialD: "\u2145",
  Cayleys: "\u212D",
  Ccaron: "\u010C",
  Ccedil: "\xC7",
  Ccirc: "\u0108",
  Cconint: "\u2230",
  Cdot: "\u010A",
  Cedilla: "\xB8",
  CenterDot: "\xB7",
  Cfr: "\u212D",
  Chi: "\u03A7",
  CircleDot: "\u2299",
  CircleMinus: "\u2296",
  CirclePlus: "\u2295",
  CircleTimes: "\u2297",
  ClockwiseContourIntegral: "\u2232",
  CloseCurlyDoubleQuote: "\u201D",
  CloseCurlyQuote: "\u2019",
  Colon: "\u2237",
  Colone: "\u2A74",
  Congruent: "\u2261",
  Conint: "\u222F",
  ContourIntegral: "\u222E",
  Copf: "\u2102",
  Coproduct: "\u2210",
  CounterClockwiseContourIntegral: "\u2233",
  Cross: "\u2A2F",
  Cscr: "\u{1D49E}",
  Cup: "\u22D3",
  CupCap: "\u224D",
  DD: "\u2145",
  DDotrahd: "\u2911",
  DJcy: "\u0402",
  DScy: "\u0405",
  DZcy: "\u040F",
  Dagger: "\u2021",
  Darr: "\u21A1",
  Dashv: "\u2AE4",
  Dcaron: "\u010E",
  Dcy: "\u0414",
  Del: "\u2207",
  Delta: "\u0394",
  Dfr: "\u{1D507}",
  DiacriticalAcute: "\xB4",
  DiacriticalDot: "\u02D9",
  DiacriticalDoubleAcute: "\u02DD",
  DiacriticalGrave: "`",
  DiacriticalTilde: "\u02DC",
  Diamond: "\u22C4",
  DifferentialD: "\u2146",
  Dopf: "\u{1D53B}",
  Dot: "\xA8",
  DotDot: "\u20DC",
  DotEqual: "\u2250",
  DoubleContourIntegral: "\u222F",
  DoubleDot: "\xA8",
  DoubleDownArrow: "\u21D3",
  DoubleLeftArrow: "\u21D0",
  DoubleLeftRightArrow: "\u21D4",
  DoubleLeftTee: "\u2AE4",
  DoubleLongLeftArrow: "\u27F8",
  DoubleLongLeftRightArrow: "\u27FA",
  DoubleLongRightArrow: "\u27F9",
  DoubleRightArrow: "\u21D2",
  DoubleRightTee: "\u22A8",
  DoubleUpArrow: "\u21D1",
  DoubleUpDownArrow: "\u21D5",
  DoubleVerticalBar: "\u2225",
  DownArrow: "\u2193",
  DownArrowBar: "\u2913",
  DownArrowUpArrow: "\u21F5",
  DownBreve: "\u0311",
  DownLeftRightVector: "\u2950",
  DownLeftTeeVector: "\u295E",
  DownLeftVector: "\u21BD",
  DownLeftVectorBar: "\u2956",
  DownRightTeeVector: "\u295F",
  DownRightVector: "\u21C1",
  DownRightVectorBar: "\u2957",
  DownTee: "\u22A4",
  DownTeeArrow: "\u21A7",
  Downarrow: "\u21D3",
  Dscr: "\u{1D49F}",
  Dstrok: "\u0110",
  ENG: "\u014A",
  ETH: "\xD0",
  Eacute: "\xC9",
  Ecaron: "\u011A",
  Ecirc: "\xCA",
  Ecy: "\u042D",
  Edot: "\u0116",
  Efr: "\u{1D508}",
  Egrave: "\xC8",
  Element: "\u2208",
  Emacr: "\u0112",
  EmptySmallSquare: "\u25FB",
  EmptyVerySmallSquare: "\u25AB",
  Eogon: "\u0118",
  Eopf: "\u{1D53C}",
  Epsilon: "\u0395",
  Equal: "\u2A75",
  EqualTilde: "\u2242",
  Equilibrium: "\u21CC",
  Escr: "\u2130",
  Esim: "\u2A73",
  Eta: "\u0397",
  Euml: "\xCB",
  Exists: "\u2203",
  ExponentialE: "\u2147",
  Fcy: "\u0424",
  Ffr: "\u{1D509}",
  FilledSmallSquare: "\u25FC",
  FilledVerySmallSquare: "\u25AA",
  Fopf: "\u{1D53D}",
  ForAll: "\u2200",
  Fouriertrf: "\u2131",
  Fscr: "\u2131",
  GJcy: "\u0403",
  GT: ">",
  Gamma: "\u0393",
  Gammad: "\u03DC",
  Gbreve: "\u011E",
  Gcedil: "\u0122",
  Gcirc: "\u011C",
  Gcy: "\u0413",
  Gdot: "\u0120",
  Gfr: "\u{1D50A}",
  Gg: "\u22D9",
  Gopf: "\u{1D53E}",
  GreaterEqual: "\u2265",
  GreaterEqualLess: "\u22DB",
  GreaterFullEqual: "\u2267",
  GreaterGreater: "\u2AA2",
  GreaterLess: "\u2277",
  GreaterSlantEqual: "\u2A7E",
  GreaterTilde: "\u2273",
  Gscr: "\u{1D4A2}",
  Gt: "\u226B",
  HARDcy: "\u042A",
  Hacek: "\u02C7",
  Hat: "^",
  Hcirc: "\u0124",
  Hfr: "\u210C",
  HilbertSpace: "\u210B",
  Hopf: "\u210D",
  HorizontalLine: "\u2500",
  Hscr: "\u210B",
  Hstrok: "\u0126",
  HumpDownHump: "\u224E",
  HumpEqual: "\u224F",
  IEcy: "\u0415",
  IJlig: "\u0132",
  IOcy: "\u0401",
  Iacute: "\xCD",
  Icirc: "\xCE",
  Icy: "\u0418",
  Idot: "\u0130",
  Ifr: "\u2111",
  Igrave: "\xCC",
  Im: "\u2111",
  Imacr: "\u012A",
  ImaginaryI: "\u2148",
  Implies: "\u21D2",
  Int: "\u222C",
  Integral: "\u222B",
  Intersection: "\u22C2",
  InvisibleComma: "\u2063",
  InvisibleTimes: "\u2062",
  Iogon: "\u012E",
  Iopf: "\u{1D540}",
  Iota: "\u0399",
  Iscr: "\u2110",
  Itilde: "\u0128",
  Iukcy: "\u0406",
  Iuml: "\xCF",
  Jcirc: "\u0134",
  Jcy: "\u0419",
  Jfr: "\u{1D50D}",
  Jopf: "\u{1D541}",
  Jscr: "\u{1D4A5}",
  Jsercy: "\u0408",
  Jukcy: "\u0404",
  KHcy: "\u0425",
  KJcy: "\u040C",
  Kappa: "\u039A",
  Kcedil: "\u0136",
  Kcy: "\u041A",
  Kfr: "\u{1D50E}",
  Kopf: "\u{1D542}",
  Kscr: "\u{1D4A6}",
  LJcy: "\u0409",
  LT: "<",
  Lacute: "\u0139",
  Lambda: "\u039B",
  Lang: "\u27EA",
  Laplacetrf: "\u2112",
  Larr: "\u219E",
  Lcaron: "\u013D",
  Lcedil: "\u013B",
  Lcy: "\u041B",
  LeftAngleBracket: "\u27E8",
  LeftArrow: "\u2190",
  LeftArrowBar: "\u21E4",
  LeftArrowRightArrow: "\u21C6",
  LeftCeiling: "\u2308",
  LeftDoubleBracket: "\u27E6",
  LeftDownTeeVector: "\u2961",
  LeftDownVector: "\u21C3",
  LeftDownVectorBar: "\u2959",
  LeftFloor: "\u230A",
  LeftRightArrow: "\u2194",
  LeftRightVector: "\u294E",
  LeftTee: "\u22A3",
  LeftTeeArrow: "\u21A4",
  LeftTeeVector: "\u295A",
  LeftTriangle: "\u22B2",
  LeftTriangleBar: "\u29CF",
  LeftTriangleEqual: "\u22B4",
  LeftUpDownVector: "\u2951",
  LeftUpTeeVector: "\u2960",
  LeftUpVector: "\u21BF",
  LeftUpVectorBar: "\u2958",
  LeftVector: "\u21BC",
  LeftVectorBar: "\u2952",
  Leftarrow: "\u21D0",
  Leftrightarrow: "\u21D4",
  LessEqualGreater: "\u22DA",
  LessFullEqual: "\u2266",
  LessGreater: "\u2276",
  LessLess: "\u2AA1",
  LessSlantEqual: "\u2A7D",
  LessTilde: "\u2272",
  Lfr: "\u{1D50F}",
  Ll: "\u22D8",
  Lleftarrow: "\u21DA",
  Lmidot: "\u013F",
  LongLeftArrow: "\u27F5",
  LongLeftRightArrow: "\u27F7",
  LongRightArrow: "\u27F6",
  Longleftarrow: "\u27F8",
  Longleftrightarrow: "\u27FA",
  Longrightarrow: "\u27F9",
  Lopf: "\u{1D543}",
  LowerLeftArrow: "\u2199",
  LowerRightArrow: "\u2198",
  Lscr: "\u2112",
  Lsh: "\u21B0",
  Lstrok: "\u0141",
  Lt: "\u226A",
  Map: "\u2905",
  Mcy: "\u041C",
  MediumSpace: "\u205F",
  Mellintrf: "\u2133",
  Mfr: "\u{1D510}",
  MinusPlus: "\u2213",
  Mopf: "\u{1D544}",
  Mscr: "\u2133",
  Mu: "\u039C",
  NJcy: "\u040A",
  Nacute: "\u0143",
  Ncaron: "\u0147",
  Ncedil: "\u0145",
  Ncy: "\u041D",
  NegativeMediumSpace: "\u200B",
  NegativeThickSpace: "\u200B",
  NegativeThinSpace: "\u200B",
  NegativeVeryThinSpace: "\u200B",
  NestedGreaterGreater: "\u226B",
  NestedLessLess: "\u226A",
  NewLine: "\n",
  Nfr: "\u{1D511}",
  NoBreak: "\u2060",
  NonBreakingSpace: "\xA0",
  Nopf: "\u2115",
  Not: "\u2AEC",
  NotCongruent: "\u2262",
  NotCupCap: "\u226D",
  NotDoubleVerticalBar: "\u2226",
  NotElement: "\u2209",
  NotEqual: "\u2260",
  NotEqualTilde: "\u2242\u0338",
  NotExists: "\u2204",
  NotGreater: "\u226F",
  NotGreaterEqual: "\u2271",
  NotGreaterFullEqual: "\u2267\u0338",
  NotGreaterGreater: "\u226B\u0338",
  NotGreaterLess: "\u2279",
  NotGreaterSlantEqual: "\u2A7E\u0338",
  NotGreaterTilde: "\u2275",
  NotHumpDownHump: "\u224E\u0338",
  NotHumpEqual: "\u224F\u0338",
  NotLeftTriangle: "\u22EA",
  NotLeftTriangleBar: "\u29CF\u0338",
  NotLeftTriangleEqual: "\u22EC",
  NotLess: "\u226E",
  NotLessEqual: "\u2270",
  NotLessGreater: "\u2278",
  NotLessLess: "\u226A\u0338",
  NotLessSlantEqual: "\u2A7D\u0338",
  NotLessTilde: "\u2274",
  NotNestedGreaterGreater: "\u2AA2\u0338",
  NotNestedLessLess: "\u2AA1\u0338",
  NotPrecedes: "\u2280",
  NotPrecedesEqual: "\u2AAF\u0338",
  NotPrecedesSlantEqual: "\u22E0",
  NotReverseElement: "\u220C",
  NotRightTriangle: "\u22EB",
  NotRightTriangleBar: "\u29D0\u0338",
  NotRightTriangleEqual: "\u22ED",
  NotSquareSubset: "\u228F\u0338",
  NotSquareSubsetEqual: "\u22E2",
  NotSquareSuperset: "\u2290\u0338",
  NotSquareSupersetEqual: "\u22E3",
  NotSubset: "\u2282\u20D2",
  NotSubsetEqual: "\u2288",
  NotSucceeds: "\u2281",
  NotSucceedsEqual: "\u2AB0\u0338",
  NotSucceedsSlantEqual: "\u22E1",
  NotSucceedsTilde: "\u227F\u0338",
  NotSuperset: "\u2283\u20D2",
  NotSupersetEqual: "\u2289",
  NotTilde: "\u2241",
  NotTildeEqual: "\u2244",
  NotTildeFullEqual: "\u2247",
  NotTildeTilde: "\u2249",
  NotVerticalBar: "\u2224",
  Nscr: "\u{1D4A9}",
  Ntilde: "\xD1",
  Nu: "\u039D",
  OElig: "\u0152",
  Oacute: "\xD3",
  Ocirc: "\xD4",
  Ocy: "\u041E",
  Odblac: "\u0150",
  Ofr: "\u{1D512}",
  Ograve: "\xD2",
  Omacr: "\u014C",
  Omega: "\u03A9",
  Omicron: "\u039F",
  Oopf: "\u{1D546}",
  OpenCurlyDoubleQuote: "\u201C",
  OpenCurlyQuote: "\u2018",
  Or: "\u2A54",
  Oscr: "\u{1D4AA}",
  Oslash: "\xD8",
  Otilde: "\xD5",
  Otimes: "\u2A37",
  Ouml: "\xD6",
  OverBar: "\u203E",
  OverBrace: "\u23DE",
  OverBracket: "\u23B4",
  OverParenthesis: "\u23DC",
  PartialD: "\u2202",
  Pcy: "\u041F",
  Pfr: "\u{1D513}",
  Phi: "\u03A6",
  Pi: "\u03A0",
  PlusMinus: "\xB1",
  Poincareplane: "\u210C",
  Popf: "\u2119",
  Pr: "\u2ABB",
  Precedes: "\u227A",
  PrecedesEqual: "\u2AAF",
  PrecedesSlantEqual: "\u227C",
  PrecedesTilde: "\u227E",
  Prime: "\u2033",
  Product: "\u220F",
  Proportion: "\u2237",
  Proportional: "\u221D",
  Pscr: "\u{1D4AB}",
  Psi: "\u03A8",
  QUOT: '"',
  Qfr: "\u{1D514}",
  Qopf: "\u211A",
  Qscr: "\u{1D4AC}",
  RBarr: "\u2910",
  REG: "\xAE",
  Racute: "\u0154",
  Rang: "\u27EB",
  Rarr: "\u21A0",
  Rarrtl: "\u2916",
  Rcaron: "\u0158",
  Rcedil: "\u0156",
  Rcy: "\u0420",
  Re: "\u211C",
  ReverseElement: "\u220B",
  ReverseEquilibrium: "\u21CB",
  ReverseUpEquilibrium: "\u296F",
  Rfr: "\u211C",
  Rho: "\u03A1",
  RightAngleBracket: "\u27E9",
  RightArrow: "\u2192",
  RightArrowBar: "\u21E5",
  RightArrowLeftArrow: "\u21C4",
  RightCeiling: "\u2309",
  RightDoubleBracket: "\u27E7",
  RightDownTeeVector: "\u295D",
  RightDownVector: "\u21C2",
  RightDownVectorBar: "\u2955",
  RightFloor: "\u230B",
  RightTee: "\u22A2",
  RightTeeArrow: "\u21A6",
  RightTeeVector: "\u295B",
  RightTriangle: "\u22B3",
  RightTriangleBar: "\u29D0",
  RightTriangleEqual: "\u22B5",
  RightUpDownVector: "\u294F",
  RightUpTeeVector: "\u295C",
  RightUpVector: "\u21BE",
  RightUpVectorBar: "\u2954",
  RightVector: "\u21C0",
  RightVectorBar: "\u2953",
  Rightarrow: "\u21D2",
  Ropf: "\u211D",
  RoundImplies: "\u2970",
  Rrightarrow: "\u21DB",
  Rscr: "\u211B",
  Rsh: "\u21B1",
  RuleDelayed: "\u29F4",
  SHCHcy: "\u0429",
  SHcy: "\u0428",
  SOFTcy: "\u042C",
  Sacute: "\u015A",
  Sc: "\u2ABC",
  Scaron: "\u0160",
  Scedil: "\u015E",
  Scirc: "\u015C",
  Scy: "\u0421",
  Sfr: "\u{1D516}",
  ShortDownArrow: "\u2193",
  ShortLeftArrow: "\u2190",
  ShortRightArrow: "\u2192",
  ShortUpArrow: "\u2191",
  Sigma: "\u03A3",
  SmallCircle: "\u2218",
  Sopf: "\u{1D54A}",
  Sqrt: "\u221A",
  Square: "\u25A1",
  SquareIntersection: "\u2293",
  SquareSubset: "\u228F",
  SquareSubsetEqual: "\u2291",
  SquareSuperset: "\u2290",
  SquareSupersetEqual: "\u2292",
  SquareUnion: "\u2294",
  Sscr: "\u{1D4AE}",
  Star: "\u22C6",
  Sub: "\u22D0",
  Subset: "\u22D0",
  SubsetEqual: "\u2286",
  Succeeds: "\u227B",
  SucceedsEqual: "\u2AB0",
  SucceedsSlantEqual: "\u227D",
  SucceedsTilde: "\u227F",
  SuchThat: "\u220B",
  Sum: "\u2211",
  Sup: "\u22D1",
  Superset: "\u2283",
  SupersetEqual: "\u2287",
  Supset: "\u22D1",
  THORN: "\xDE",
  TRADE: "\u2122",
  TSHcy: "\u040B",
  TScy: "\u0426",
  Tab: "	",
  Tau: "\u03A4",
  Tcaron: "\u0164",
  Tcedil: "\u0162",
  Tcy: "\u0422",
  Tfr: "\u{1D517}",
  Therefore: "\u2234",
  Theta: "\u0398",
  ThickSpace: "\u205F\u200A",
  ThinSpace: "\u2009",
  Tilde: "\u223C",
  TildeEqual: "\u2243",
  TildeFullEqual: "\u2245",
  TildeTilde: "\u2248",
  Topf: "\u{1D54B}",
  TripleDot: "\u20DB",
  Tscr: "\u{1D4AF}",
  Tstrok: "\u0166",
  Uacute: "\xDA",
  Uarr: "\u219F",
  Uarrocir: "\u2949",
  Ubrcy: "\u040E",
  Ubreve: "\u016C",
  Ucirc: "\xDB",
  Ucy: "\u0423",
  Udblac: "\u0170",
  Ufr: "\u{1D518}",
  Ugrave: "\xD9",
  Umacr: "\u016A",
  UnderBar: "_",
  UnderBrace: "\u23DF",
  UnderBracket: "\u23B5",
  UnderParenthesis: "\u23DD",
  Union: "\u22C3",
  UnionPlus: "\u228E",
  Uogon: "\u0172",
  Uopf: "\u{1D54C}",
  UpArrow: "\u2191",
  UpArrowBar: "\u2912",
  UpArrowDownArrow: "\u21C5",
  UpDownArrow: "\u2195",
  UpEquilibrium: "\u296E",
  UpTee: "\u22A5",
  UpTeeArrow: "\u21A5",
  Uparrow: "\u21D1",
  Updownarrow: "\u21D5",
  UpperLeftArrow: "\u2196",
  UpperRightArrow: "\u2197",
  Upsi: "\u03D2",
  Upsilon: "\u03A5",
  Uring: "\u016E",
  Uscr: "\u{1D4B0}",
  Utilde: "\u0168",
  Uuml: "\xDC",
  VDash: "\u22AB",
  Vbar: "\u2AEB",
  Vcy: "\u0412",
  Vdash: "\u22A9",
  Vdashl: "\u2AE6",
  Vee: "\u22C1",
  Verbar: "\u2016",
  Vert: "\u2016",
  VerticalBar: "\u2223",
  VerticalLine: "|",
  VerticalSeparator: "\u2758",
  VerticalTilde: "\u2240",
  VeryThinSpace: "\u200A",
  Vfr: "\u{1D519}",
  Vopf: "\u{1D54D}",
  Vscr: "\u{1D4B1}",
  Vvdash: "\u22AA",
  Wcirc: "\u0174",
  Wedge: "\u22C0",
  Wfr: "\u{1D51A}",
  Wopf: "\u{1D54E}",
  Wscr: "\u{1D4B2}",
  Xfr: "\u{1D51B}",
  Xi: "\u039E",
  Xopf: "\u{1D54F}",
  Xscr: "\u{1D4B3}",
  YAcy: "\u042F",
  YIcy: "\u0407",
  YUcy: "\u042E",
  Yacute: "\xDD",
  Ycirc: "\u0176",
  Ycy: "\u042B",
  Yfr: "\u{1D51C}",
  Yopf: "\u{1D550}",
  Yscr: "\u{1D4B4}",
  Yuml: "\u0178",
  ZHcy: "\u0416",
  Zacute: "\u0179",
  Zcaron: "\u017D",
  Zcy: "\u0417",
  Zdot: "\u017B",
  ZeroWidthSpace: "\u200B",
  Zeta: "\u0396",
  Zfr: "\u2128",
  Zopf: "\u2124",
  Zscr: "\u{1D4B5}",
  aacute: "\xE1",
  abreve: "\u0103",
  ac: "\u223E",
  acE: "\u223E\u0333",
  acd: "\u223F",
  acirc: "\xE2",
  acute: "\xB4",
  acy: "\u0430",
  aelig: "\xE6",
  af: "\u2061",
  afr: "\u{1D51E}",
  agrave: "\xE0",
  alefsym: "\u2135",
  aleph: "\u2135",
  alpha: "\u03B1",
  amacr: "\u0101",
  amalg: "\u2A3F",
  amp: "&",
  and: "\u2227",
  andand: "\u2A55",
  andd: "\u2A5C",
  andslope: "\u2A58",
  andv: "\u2A5A",
  ang: "\u2220",
  ange: "\u29A4",
  angle: "\u2220",
  angmsd: "\u2221",
  angmsdaa: "\u29A8",
  angmsdab: "\u29A9",
  angmsdac: "\u29AA",
  angmsdad: "\u29AB",
  angmsdae: "\u29AC",
  angmsdaf: "\u29AD",
  angmsdag: "\u29AE",
  angmsdah: "\u29AF",
  angrt: "\u221F",
  angrtvb: "\u22BE",
  angrtvbd: "\u299D",
  angsph: "\u2222",
  angst: "\xC5",
  angzarr: "\u237C",
  aogon: "\u0105",
  aopf: "\u{1D552}",
  ap: "\u2248",
  apE: "\u2A70",
  apacir: "\u2A6F",
  ape: "\u224A",
  apid: "\u224B",
  apos: "'",
  approx: "\u2248",
  approxeq: "\u224A",
  aring: "\xE5",
  ascr: "\u{1D4B6}",
  ast: "*",
  asymp: "\u2248",
  asympeq: "\u224D",
  atilde: "\xE3",
  auml: "\xE4",
  awconint: "\u2233",
  awint: "\u2A11",
  bNot: "\u2AED",
  backcong: "\u224C",
  backepsilon: "\u03F6",
  backprime: "\u2035",
  backsim: "\u223D",
  backsimeq: "\u22CD",
  barvee: "\u22BD",
  barwed: "\u2305",
  barwedge: "\u2305",
  bbrk: "\u23B5",
  bbrktbrk: "\u23B6",
  bcong: "\u224C",
  bcy: "\u0431",
  bdquo: "\u201E",
  becaus: "\u2235",
  because: "\u2235",
  bemptyv: "\u29B0",
  bepsi: "\u03F6",
  bernou: "\u212C",
  beta: "\u03B2",
  beth: "\u2136",
  between: "\u226C",
  bfr: "\u{1D51F}",
  bigcap: "\u22C2",
  bigcirc: "\u25EF",
  bigcup: "\u22C3",
  bigodot: "\u2A00",
  bigoplus: "\u2A01",
  bigotimes: "\u2A02",
  bigsqcup: "\u2A06",
  bigstar: "\u2605",
  bigtriangledown: "\u25BD",
  bigtriangleup: "\u25B3",
  biguplus: "\u2A04",
  bigvee: "\u22C1",
  bigwedge: "\u22C0",
  bkarow: "\u290D",
  blacklozenge: "\u29EB",
  blacksquare: "\u25AA",
  blacktriangle: "\u25B4",
  blacktriangledown: "\u25BE",
  blacktriangleleft: "\u25C2",
  blacktriangleright: "\u25B8",
  blank: "\u2423",
  blk12: "\u2592",
  blk14: "\u2591",
  blk34: "\u2593",
  block: "\u2588",
  bne: "=\u20E5",
  bnequiv: "\u2261\u20E5",
  bnot: "\u2310",
  bopf: "\u{1D553}",
  bot: "\u22A5",
  bottom: "\u22A5",
  bowtie: "\u22C8",
  boxDL: "\u2557",
  boxDR: "\u2554",
  boxDl: "\u2556",
  boxDr: "\u2553",
  boxH: "\u2550",
  boxHD: "\u2566",
  boxHU: "\u2569",
  boxHd: "\u2564",
  boxHu: "\u2567",
  boxUL: "\u255D",
  boxUR: "\u255A",
  boxUl: "\u255C",
  boxUr: "\u2559",
  boxV: "\u2551",
  boxVH: "\u256C",
  boxVL: "\u2563",
  boxVR: "\u2560",
  boxVh: "\u256B",
  boxVl: "\u2562",
  boxVr: "\u255F",
  boxbox: "\u29C9",
  boxdL: "\u2555",
  boxdR: "\u2552",
  boxdl: "\u2510",
  boxdr: "\u250C",
  boxh: "\u2500",
  boxhD: "\u2565",
  boxhU: "\u2568",
  boxhd: "\u252C",
  boxhu: "\u2534",
  boxminus: "\u229F",
  boxplus: "\u229E",
  boxtimes: "\u22A0",
  boxuL: "\u255B",
  boxuR: "\u2558",
  boxul: "\u2518",
  boxur: "\u2514",
  boxv: "\u2502",
  boxvH: "\u256A",
  boxvL: "\u2561",
  boxvR: "\u255E",
  boxvh: "\u253C",
  boxvl: "\u2524",
  boxvr: "\u251C",
  bprime: "\u2035",
  breve: "\u02D8",
  brvbar: "\xA6",
  bscr: "\u{1D4B7}",
  bsemi: "\u204F",
  bsim: "\u223D",
  bsime: "\u22CD",
  bsol: "\\",
  bsolb: "\u29C5",
  bsolhsub: "\u27C8",
  bull: "\u2022",
  bullet: "\u2022",
  bump: "\u224E",
  bumpE: "\u2AAE",
  bumpe: "\u224F",
  bumpeq: "\u224F",
  cacute: "\u0107",
  cap: "\u2229",
  capand: "\u2A44",
  capbrcup: "\u2A49",
  capcap: "\u2A4B",
  capcup: "\u2A47",
  capdot: "\u2A40",
  caps: "\u2229\uFE00",
  caret: "\u2041",
  caron: "\u02C7",
  ccaps: "\u2A4D",
  ccaron: "\u010D",
  ccedil: "\xE7",
  ccirc: "\u0109",
  ccups: "\u2A4C",
  ccupssm: "\u2A50",
  cdot: "\u010B",
  cedil: "\xB8",
  cemptyv: "\u29B2",
  cent: "\xA2",
  centerdot: "\xB7",
  cfr: "\u{1D520}",
  chcy: "\u0447",
  check: "\u2713",
  checkmark: "\u2713",
  chi: "\u03C7",
  cir: "\u25CB",
  cirE: "\u29C3",
  circ: "\u02C6",
  circeq: "\u2257",
  circlearrowleft: "\u21BA",
  circlearrowright: "\u21BB",
  circledR: "\xAE",
  circledS: "\u24C8",
  circledast: "\u229B",
  circledcirc: "\u229A",
  circleddash: "\u229D",
  cire: "\u2257",
  cirfnint: "\u2A10",
  cirmid: "\u2AEF",
  cirscir: "\u29C2",
  clubs: "\u2663",
  clubsuit: "\u2663",
  colon: ":",
  colone: "\u2254",
  coloneq: "\u2254",
  comma: ",",
  commat: "@",
  comp: "\u2201",
  compfn: "\u2218",
  complement: "\u2201",
  complexes: "\u2102",
  cong: "\u2245",
  congdot: "\u2A6D",
  conint: "\u222E",
  copf: "\u{1D554}",
  coprod: "\u2210",
  copy: "\xA9",
  copysr: "\u2117",
  crarr: "\u21B5",
  cross: "\u2717",
  cscr: "\u{1D4B8}",
  csub: "\u2ACF",
  csube: "\u2AD1",
  csup: "\u2AD0",
  csupe: "\u2AD2",
  ctdot: "\u22EF",
  cudarrl: "\u2938",
  cudarrr: "\u2935",
  cuepr: "\u22DE",
  cuesc: "\u22DF",
  cularr: "\u21B6",
  cularrp: "\u293D",
  cup: "\u222A",
  cupbrcap: "\u2A48",
  cupcap: "\u2A46",
  cupcup: "\u2A4A",
  cupdot: "\u228D",
  cupor: "\u2A45",
  cups: "\u222A\uFE00",
  curarr: "\u21B7",
  curarrm: "\u293C",
  curlyeqprec: "\u22DE",
  curlyeqsucc: "\u22DF",
  curlyvee: "\u22CE",
  curlywedge: "\u22CF",
  curren: "\xA4",
  curvearrowleft: "\u21B6",
  curvearrowright: "\u21B7",
  cuvee: "\u22CE",
  cuwed: "\u22CF",
  cwconint: "\u2232",
  cwint: "\u2231",
  cylcty: "\u232D",
  dArr: "\u21D3",
  dHar: "\u2965",
  dagger: "\u2020",
  daleth: "\u2138",
  darr: "\u2193",
  dash: "\u2010",
  dashv: "\u22A3",
  dbkarow: "\u290F",
  dblac: "\u02DD",
  dcaron: "\u010F",
  dcy: "\u0434",
  dd: "\u2146",
  ddagger: "\u2021",
  ddarr: "\u21CA",
  ddotseq: "\u2A77",
  deg: "\xB0",
  delta: "\u03B4",
  demptyv: "\u29B1",
  dfisht: "\u297F",
  dfr: "\u{1D521}",
  dharl: "\u21C3",
  dharr: "\u21C2",
  diam: "\u22C4",
  diamond: "\u22C4",
  diamondsuit: "\u2666",
  diams: "\u2666",
  die: "\xA8",
  digamma: "\u03DD",
  disin: "\u22F2",
  div: "\xF7",
  divide: "\xF7",
  divideontimes: "\u22C7",
  divonx: "\u22C7",
  djcy: "\u0452",
  dlcorn: "\u231E",
  dlcrop: "\u230D",
  dollar: "$",
  dopf: "\u{1D555}",
  dot: "\u02D9",
  doteq: "\u2250",
  doteqdot: "\u2251",
  dotminus: "\u2238",
  dotplus: "\u2214",
  dotsquare: "\u22A1",
  doublebarwedge: "\u2306",
  downarrow: "\u2193",
  downdownarrows: "\u21CA",
  downharpoonleft: "\u21C3",
  downharpoonright: "\u21C2",
  drbkarow: "\u2910",
  drcorn: "\u231F",
  drcrop: "\u230C",
  dscr: "\u{1D4B9}",
  dscy: "\u0455",
  dsol: "\u29F6",
  dstrok: "\u0111",
  dtdot: "\u22F1",
  dtri: "\u25BF",
  dtrif: "\u25BE",
  duarr: "\u21F5",
  duhar: "\u296F",
  dwangle: "\u29A6",
  dzcy: "\u045F",
  dzigrarr: "\u27FF",
  eDDot: "\u2A77",
  eDot: "\u2251",
  eacute: "\xE9",
  easter: "\u2A6E",
  ecaron: "\u011B",
  ecir: "\u2256",
  ecirc: "\xEA",
  ecolon: "\u2255",
  ecy: "\u044D",
  edot: "\u0117",
  ee: "\u2147",
  efDot: "\u2252",
  efr: "\u{1D522}",
  eg: "\u2A9A",
  egrave: "\xE8",
  egs: "\u2A96",
  egsdot: "\u2A98",
  el: "\u2A99",
  elinters: "\u23E7",
  ell: "\u2113",
  els: "\u2A95",
  elsdot: "\u2A97",
  emacr: "\u0113",
  empty: "\u2205",
  emptyset: "\u2205",
  emptyv: "\u2205",
  emsp13: "\u2004",
  emsp14: "\u2005",
  emsp: "\u2003",
  eng: "\u014B",
  ensp: "\u2002",
  eogon: "\u0119",
  eopf: "\u{1D556}",
  epar: "\u22D5",
  eparsl: "\u29E3",
  eplus: "\u2A71",
  epsi: "\u03B5",
  epsilon: "\u03B5",
  epsiv: "\u03F5",
  eqcirc: "\u2256",
  eqcolon: "\u2255",
  eqsim: "\u2242",
  eqslantgtr: "\u2A96",
  eqslantless: "\u2A95",
  equals: "=",
  equest: "\u225F",
  equiv: "\u2261",
  equivDD: "\u2A78",
  eqvparsl: "\u29E5",
  erDot: "\u2253",
  erarr: "\u2971",
  escr: "\u212F",
  esdot: "\u2250",
  esim: "\u2242",
  eta: "\u03B7",
  eth: "\xF0",
  euml: "\xEB",
  euro: "\u20AC",
  excl: "!",
  exist: "\u2203",
  expectation: "\u2130",
  exponentiale: "\u2147",
  fallingdotseq: "\u2252",
  fcy: "\u0444",
  female: "\u2640",
  ffilig: "\uFB03",
  fflig: "\uFB00",
  ffllig: "\uFB04",
  ffr: "\u{1D523}",
  filig: "\uFB01",
  fjlig: "fj",
  flat: "\u266D",
  fllig: "\uFB02",
  fltns: "\u25B1",
  fnof: "\u0192",
  fopf: "\u{1D557}",
  forall: "\u2200",
  fork: "\u22D4",
  forkv: "\u2AD9",
  fpartint: "\u2A0D",
  frac12: "\xBD",
  frac13: "\u2153",
  frac14: "\xBC",
  frac15: "\u2155",
  frac16: "\u2159",
  frac18: "\u215B",
  frac23: "\u2154",
  frac25: "\u2156",
  frac34: "\xBE",
  frac35: "\u2157",
  frac38: "\u215C",
  frac45: "\u2158",
  frac56: "\u215A",
  frac58: "\u215D",
  frac78: "\u215E",
  frasl: "\u2044",
  frown: "\u2322",
  fscr: "\u{1D4BB}",
  gE: "\u2267",
  gEl: "\u2A8C",
  gacute: "\u01F5",
  gamma: "\u03B3",
  gammad: "\u03DD",
  gap: "\u2A86",
  gbreve: "\u011F",
  gcirc: "\u011D",
  gcy: "\u0433",
  gdot: "\u0121",
  ge: "\u2265",
  gel: "\u22DB",
  geq: "\u2265",
  geqq: "\u2267",
  geqslant: "\u2A7E",
  ges: "\u2A7E",
  gescc: "\u2AA9",
  gesdot: "\u2A80",
  gesdoto: "\u2A82",
  gesdotol: "\u2A84",
  gesl: "\u22DB\uFE00",
  gesles: "\u2A94",
  gfr: "\u{1D524}",
  gg: "\u226B",
  ggg: "\u22D9",
  gimel: "\u2137",
  gjcy: "\u0453",
  gl: "\u2277",
  glE: "\u2A92",
  gla: "\u2AA5",
  glj: "\u2AA4",
  gnE: "\u2269",
  gnap: "\u2A8A",
  gnapprox: "\u2A8A",
  gne: "\u2A88",
  gneq: "\u2A88",
  gneqq: "\u2269",
  gnsim: "\u22E7",
  gopf: "\u{1D558}",
  grave: "`",
  gscr: "\u210A",
  gsim: "\u2273",
  gsime: "\u2A8E",
  gsiml: "\u2A90",
  gt: ">",
  gtcc: "\u2AA7",
  gtcir: "\u2A7A",
  gtdot: "\u22D7",
  gtlPar: "\u2995",
  gtquest: "\u2A7C",
  gtrapprox: "\u2A86",
  gtrarr: "\u2978",
  gtrdot: "\u22D7",
  gtreqless: "\u22DB",
  gtreqqless: "\u2A8C",
  gtrless: "\u2277",
  gtrsim: "\u2273",
  gvertneqq: "\u2269\uFE00",
  gvnE: "\u2269\uFE00",
  hArr: "\u21D4",
  hairsp: "\u200A",
  half: "\xBD",
  hamilt: "\u210B",
  hardcy: "\u044A",
  harr: "\u2194",
  harrcir: "\u2948",
  harrw: "\u21AD",
  hbar: "\u210F",
  hcirc: "\u0125",
  hearts: "\u2665",
  heartsuit: "\u2665",
  hellip: "\u2026",
  hercon: "\u22B9",
  hfr: "\u{1D525}",
  hksearow: "\u2925",
  hkswarow: "\u2926",
  hoarr: "\u21FF",
  homtht: "\u223B",
  hookleftarrow: "\u21A9",
  hookrightarrow: "\u21AA",
  hopf: "\u{1D559}",
  horbar: "\u2015",
  hscr: "\u{1D4BD}",
  hslash: "\u210F",
  hstrok: "\u0127",
  hybull: "\u2043",
  hyphen: "\u2010",
  iacute: "\xED",
  ic: "\u2063",
  icirc: "\xEE",
  icy: "\u0438",
  iecy: "\u0435",
  iexcl: "\xA1",
  iff: "\u21D4",
  ifr: "\u{1D526}",
  igrave: "\xEC",
  ii: "\u2148",
  iiiint: "\u2A0C",
  iiint: "\u222D",
  iinfin: "\u29DC",
  iiota: "\u2129",
  ijlig: "\u0133",
  imacr: "\u012B",
  image: "\u2111",
  imagline: "\u2110",
  imagpart: "\u2111",
  imath: "\u0131",
  imof: "\u22B7",
  imped: "\u01B5",
  in: "\u2208",
  incare: "\u2105",
  infin: "\u221E",
  infintie: "\u29DD",
  inodot: "\u0131",
  int: "\u222B",
  intcal: "\u22BA",
  integers: "\u2124",
  intercal: "\u22BA",
  intlarhk: "\u2A17",
  intprod: "\u2A3C",
  iocy: "\u0451",
  iogon: "\u012F",
  iopf: "\u{1D55A}",
  iota: "\u03B9",
  iprod: "\u2A3C",
  iquest: "\xBF",
  iscr: "\u{1D4BE}",
  isin: "\u2208",
  isinE: "\u22F9",
  isindot: "\u22F5",
  isins: "\u22F4",
  isinsv: "\u22F3",
  isinv: "\u2208",
  it: "\u2062",
  itilde: "\u0129",
  iukcy: "\u0456",
  iuml: "\xEF",
  jcirc: "\u0135",
  jcy: "\u0439",
  jfr: "\u{1D527}",
  jmath: "\u0237",
  jopf: "\u{1D55B}",
  jscr: "\u{1D4BF}",
  jsercy: "\u0458",
  jukcy: "\u0454",
  kappa: "\u03BA",
  kappav: "\u03F0",
  kcedil: "\u0137",
  kcy: "\u043A",
  kfr: "\u{1D528}",
  kgreen: "\u0138",
  khcy: "\u0445",
  kjcy: "\u045C",
  kopf: "\u{1D55C}",
  kscr: "\u{1D4C0}",
  lAarr: "\u21DA",
  lArr: "\u21D0",
  lAtail: "\u291B",
  lBarr: "\u290E",
  lE: "\u2266",
  lEg: "\u2A8B",
  lHar: "\u2962",
  lacute: "\u013A",
  laemptyv: "\u29B4",
  lagran: "\u2112",
  lambda: "\u03BB",
  lang: "\u27E8",
  langd: "\u2991",
  langle: "\u27E8",
  lap: "\u2A85",
  laquo: "\xAB",
  larr: "\u2190",
  larrb: "\u21E4",
  larrbfs: "\u291F",
  larrfs: "\u291D",
  larrhk: "\u21A9",
  larrlp: "\u21AB",
  larrpl: "\u2939",
  larrsim: "\u2973",
  larrtl: "\u21A2",
  lat: "\u2AAB",
  latail: "\u2919",
  late: "\u2AAD",
  lates: "\u2AAD\uFE00",
  lbarr: "\u290C",
  lbbrk: "\u2772",
  lbrace: "{",
  lbrack: "[",
  lbrke: "\u298B",
  lbrksld: "\u298F",
  lbrkslu: "\u298D",
  lcaron: "\u013E",
  lcedil: "\u013C",
  lceil: "\u2308",
  lcub: "{",
  lcy: "\u043B",
  ldca: "\u2936",
  ldquo: "\u201C",
  ldquor: "\u201E",
  ldrdhar: "\u2967",
  ldrushar: "\u294B",
  ldsh: "\u21B2",
  le: "\u2264",
  leftarrow: "\u2190",
  leftarrowtail: "\u21A2",
  leftharpoondown: "\u21BD",
  leftharpoonup: "\u21BC",
  leftleftarrows: "\u21C7",
  leftrightarrow: "\u2194",
  leftrightarrows: "\u21C6",
  leftrightharpoons: "\u21CB",
  leftrightsquigarrow: "\u21AD",
  leftthreetimes: "\u22CB",
  leg: "\u22DA",
  leq: "\u2264",
  leqq: "\u2266",
  leqslant: "\u2A7D",
  les: "\u2A7D",
  lescc: "\u2AA8",
  lesdot: "\u2A7F",
  lesdoto: "\u2A81",
  lesdotor: "\u2A83",
  lesg: "\u22DA\uFE00",
  lesges: "\u2A93",
  lessapprox: "\u2A85",
  lessdot: "\u22D6",
  lesseqgtr: "\u22DA",
  lesseqqgtr: "\u2A8B",
  lessgtr: "\u2276",
  lesssim: "\u2272",
  lfisht: "\u297C",
  lfloor: "\u230A",
  lfr: "\u{1D529}",
  lg: "\u2276",
  lgE: "\u2A91",
  lhard: "\u21BD",
  lharu: "\u21BC",
  lharul: "\u296A",
  lhblk: "\u2584",
  ljcy: "\u0459",
  ll: "\u226A",
  llarr: "\u21C7",
  llcorner: "\u231E",
  llhard: "\u296B",
  lltri: "\u25FA",
  lmidot: "\u0140",
  lmoust: "\u23B0",
  lmoustache: "\u23B0",
  lnE: "\u2268",
  lnap: "\u2A89",
  lnapprox: "\u2A89",
  lne: "\u2A87",
  lneq: "\u2A87",
  lneqq: "\u2268",
  lnsim: "\u22E6",
  loang: "\u27EC",
  loarr: "\u21FD",
  lobrk: "\u27E6",
  longleftarrow: "\u27F5",
  longleftrightarrow: "\u27F7",
  longmapsto: "\u27FC",
  longrightarrow: "\u27F6",
  looparrowleft: "\u21AB",
  looparrowright: "\u21AC",
  lopar: "\u2985",
  lopf: "\u{1D55D}",
  loplus: "\u2A2D",
  lotimes: "\u2A34",
  lowast: "\u2217",
  lowbar: "_",
  loz: "\u25CA",
  lozenge: "\u25CA",
  lozf: "\u29EB",
  lpar: "(",
  lparlt: "\u2993",
  lrarr: "\u21C6",
  lrcorner: "\u231F",
  lrhar: "\u21CB",
  lrhard: "\u296D",
  lrm: "\u200E",
  lrtri: "\u22BF",
  lsaquo: "\u2039",
  lscr: "\u{1D4C1}",
  lsh: "\u21B0",
  lsim: "\u2272",
  lsime: "\u2A8D",
  lsimg: "\u2A8F",
  lsqb: "[",
  lsquo: "\u2018",
  lsquor: "\u201A",
  lstrok: "\u0142",
  lt: "<",
  ltcc: "\u2AA6",
  ltcir: "\u2A79",
  ltdot: "\u22D6",
  lthree: "\u22CB",
  ltimes: "\u22C9",
  ltlarr: "\u2976",
  ltquest: "\u2A7B",
  ltrPar: "\u2996",
  ltri: "\u25C3",
  ltrie: "\u22B4",
  ltrif: "\u25C2",
  lurdshar: "\u294A",
  luruhar: "\u2966",
  lvertneqq: "\u2268\uFE00",
  lvnE: "\u2268\uFE00",
  mDDot: "\u223A",
  macr: "\xAF",
  male: "\u2642",
  malt: "\u2720",
  maltese: "\u2720",
  map: "\u21A6",
  mapsto: "\u21A6",
  mapstodown: "\u21A7",
  mapstoleft: "\u21A4",
  mapstoup: "\u21A5",
  marker: "\u25AE",
  mcomma: "\u2A29",
  mcy: "\u043C",
  mdash: "\u2014",
  measuredangle: "\u2221",
  mfr: "\u{1D52A}",
  mho: "\u2127",
  micro: "\xB5",
  mid: "\u2223",
  midast: "*",
  midcir: "\u2AF0",
  middot: "\xB7",
  minus: "\u2212",
  minusb: "\u229F",
  minusd: "\u2238",
  minusdu: "\u2A2A",
  mlcp: "\u2ADB",
  mldr: "\u2026",
  mnplus: "\u2213",
  models: "\u22A7",
  mopf: "\u{1D55E}",
  mp: "\u2213",
  mscr: "\u{1D4C2}",
  mstpos: "\u223E",
  mu: "\u03BC",
  multimap: "\u22B8",
  mumap: "\u22B8",
  nGg: "\u22D9\u0338",
  nGt: "\u226B\u20D2",
  nGtv: "\u226B\u0338",
  nLeftarrow: "\u21CD",
  nLeftrightarrow: "\u21CE",
  nLl: "\u22D8\u0338",
  nLt: "\u226A\u20D2",
  nLtv: "\u226A\u0338",
  nRightarrow: "\u21CF",
  nVDash: "\u22AF",
  nVdash: "\u22AE",
  nabla: "\u2207",
  nacute: "\u0144",
  nang: "\u2220\u20D2",
  nap: "\u2249",
  napE: "\u2A70\u0338",
  napid: "\u224B\u0338",
  napos: "\u0149",
  napprox: "\u2249",
  natur: "\u266E",
  natural: "\u266E",
  naturals: "\u2115",
  nbsp: "\xA0",
  nbump: "\u224E\u0338",
  nbumpe: "\u224F\u0338",
  ncap: "\u2A43",
  ncaron: "\u0148",
  ncedil: "\u0146",
  ncong: "\u2247",
  ncongdot: "\u2A6D\u0338",
  ncup: "\u2A42",
  ncy: "\u043D",
  ndash: "\u2013",
  ne: "\u2260",
  neArr: "\u21D7",
  nearhk: "\u2924",
  nearr: "\u2197",
  nearrow: "\u2197",
  nedot: "\u2250\u0338",
  nequiv: "\u2262",
  nesear: "\u2928",
  nesim: "\u2242\u0338",
  nexist: "\u2204",
  nexists: "\u2204",
  nfr: "\u{1D52B}",
  ngE: "\u2267\u0338",
  nge: "\u2271",
  ngeq: "\u2271",
  ngeqq: "\u2267\u0338",
  ngeqslant: "\u2A7E\u0338",
  nges: "\u2A7E\u0338",
  ngsim: "\u2275",
  ngt: "\u226F",
  ngtr: "\u226F",
  nhArr: "\u21CE",
  nharr: "\u21AE",
  nhpar: "\u2AF2",
  ni: "\u220B",
  nis: "\u22FC",
  nisd: "\u22FA",
  niv: "\u220B",
  njcy: "\u045A",
  nlArr: "\u21CD",
  nlE: "\u2266\u0338",
  nlarr: "\u219A",
  nldr: "\u2025",
  nle: "\u2270",
  nleftarrow: "\u219A",
  nleftrightarrow: "\u21AE",
  nleq: "\u2270",
  nleqq: "\u2266\u0338",
  nleqslant: "\u2A7D\u0338",
  nles: "\u2A7D\u0338",
  nless: "\u226E",
  nlsim: "\u2274",
  nlt: "\u226E",
  nltri: "\u22EA",
  nltrie: "\u22EC",
  nmid: "\u2224",
  nopf: "\u{1D55F}",
  not: "\xAC",
  notin: "\u2209",
  notinE: "\u22F9\u0338",
  notindot: "\u22F5\u0338",
  notinva: "\u2209",
  notinvb: "\u22F7",
  notinvc: "\u22F6",
  notni: "\u220C",
  notniva: "\u220C",
  notnivb: "\u22FE",
  notnivc: "\u22FD",
  npar: "\u2226",
  nparallel: "\u2226",
  nparsl: "\u2AFD\u20E5",
  npart: "\u2202\u0338",
  npolint: "\u2A14",
  npr: "\u2280",
  nprcue: "\u22E0",
  npre: "\u2AAF\u0338",
  nprec: "\u2280",
  npreceq: "\u2AAF\u0338",
  nrArr: "\u21CF",
  nrarr: "\u219B",
  nrarrc: "\u2933\u0338",
  nrarrw: "\u219D\u0338",
  nrightarrow: "\u219B",
  nrtri: "\u22EB",
  nrtrie: "\u22ED",
  nsc: "\u2281",
  nsccue: "\u22E1",
  nsce: "\u2AB0\u0338",
  nscr: "\u{1D4C3}",
  nshortmid: "\u2224",
  nshortparallel: "\u2226",
  nsim: "\u2241",
  nsime: "\u2244",
  nsimeq: "\u2244",
  nsmid: "\u2224",
  nspar: "\u2226",
  nsqsube: "\u22E2",
  nsqsupe: "\u22E3",
  nsub: "\u2284",
  nsubE: "\u2AC5\u0338",
  nsube: "\u2288",
  nsubset: "\u2282\u20D2",
  nsubseteq: "\u2288",
  nsubseteqq: "\u2AC5\u0338",
  nsucc: "\u2281",
  nsucceq: "\u2AB0\u0338",
  nsup: "\u2285",
  nsupE: "\u2AC6\u0338",
  nsupe: "\u2289",
  nsupset: "\u2283\u20D2",
  nsupseteq: "\u2289",
  nsupseteqq: "\u2AC6\u0338",
  ntgl: "\u2279",
  ntilde: "\xF1",
  ntlg: "\u2278",
  ntriangleleft: "\u22EA",
  ntrianglelefteq: "\u22EC",
  ntriangleright: "\u22EB",
  ntrianglerighteq: "\u22ED",
  nu: "\u03BD",
  num: "#",
  numero: "\u2116",
  numsp: "\u2007",
  nvDash: "\u22AD",
  nvHarr: "\u2904",
  nvap: "\u224D\u20D2",
  nvdash: "\u22AC",
  nvge: "\u2265\u20D2",
  nvgt: ">\u20D2",
  nvinfin: "\u29DE",
  nvlArr: "\u2902",
  nvle: "\u2264\u20D2",
  nvlt: "<\u20D2",
  nvltrie: "\u22B4\u20D2",
  nvrArr: "\u2903",
  nvrtrie: "\u22B5\u20D2",
  nvsim: "\u223C\u20D2",
  nwArr: "\u21D6",
  nwarhk: "\u2923",
  nwarr: "\u2196",
  nwarrow: "\u2196",
  nwnear: "\u2927",
  oS: "\u24C8",
  oacute: "\xF3",
  oast: "\u229B",
  ocir: "\u229A",
  ocirc: "\xF4",
  ocy: "\u043E",
  odash: "\u229D",
  odblac: "\u0151",
  odiv: "\u2A38",
  odot: "\u2299",
  odsold: "\u29BC",
  oelig: "\u0153",
  ofcir: "\u29BF",
  ofr: "\u{1D52C}",
  ogon: "\u02DB",
  ograve: "\xF2",
  ogt: "\u29C1",
  ohbar: "\u29B5",
  ohm: "\u03A9",
  oint: "\u222E",
  olarr: "\u21BA",
  olcir: "\u29BE",
  olcross: "\u29BB",
  oline: "\u203E",
  olt: "\u29C0",
  omacr: "\u014D",
  omega: "\u03C9",
  omicron: "\u03BF",
  omid: "\u29B6",
  ominus: "\u2296",
  oopf: "\u{1D560}",
  opar: "\u29B7",
  operp: "\u29B9",
  oplus: "\u2295",
  or: "\u2228",
  orarr: "\u21BB",
  ord: "\u2A5D",
  order: "\u2134",
  orderof: "\u2134",
  ordf: "\xAA",
  ordm: "\xBA",
  origof: "\u22B6",
  oror: "\u2A56",
  orslope: "\u2A57",
  orv: "\u2A5B",
  oscr: "\u2134",
  oslash: "\xF8",
  osol: "\u2298",
  otilde: "\xF5",
  otimes: "\u2297",
  otimesas: "\u2A36",
  ouml: "\xF6",
  ovbar: "\u233D",
  par: "\u2225",
  para: "\xB6",
  parallel: "\u2225",
  parsim: "\u2AF3",
  parsl: "\u2AFD",
  part: "\u2202",
  pcy: "\u043F",
  percnt: "%",
  period: ".",
  permil: "\u2030",
  perp: "\u22A5",
  pertenk: "\u2031",
  pfr: "\u{1D52D}",
  phi: "\u03C6",
  phiv: "\u03D5",
  phmmat: "\u2133",
  phone: "\u260E",
  pi: "\u03C0",
  pitchfork: "\u22D4",
  piv: "\u03D6",
  planck: "\u210F",
  planckh: "\u210E",
  plankv: "\u210F",
  plus: "+",
  plusacir: "\u2A23",
  plusb: "\u229E",
  pluscir: "\u2A22",
  plusdo: "\u2214",
  plusdu: "\u2A25",
  pluse: "\u2A72",
  plusmn: "\xB1",
  plussim: "\u2A26",
  plustwo: "\u2A27",
  pm: "\xB1",
  pointint: "\u2A15",
  popf: "\u{1D561}",
  pound: "\xA3",
  pr: "\u227A",
  prE: "\u2AB3",
  prap: "\u2AB7",
  prcue: "\u227C",
  pre: "\u2AAF",
  prec: "\u227A",
  precapprox: "\u2AB7",
  preccurlyeq: "\u227C",
  preceq: "\u2AAF",
  precnapprox: "\u2AB9",
  precneqq: "\u2AB5",
  precnsim: "\u22E8",
  precsim: "\u227E",
  prime: "\u2032",
  primes: "\u2119",
  prnE: "\u2AB5",
  prnap: "\u2AB9",
  prnsim: "\u22E8",
  prod: "\u220F",
  profalar: "\u232E",
  profline: "\u2312",
  profsurf: "\u2313",
  prop: "\u221D",
  propto: "\u221D",
  prsim: "\u227E",
  prurel: "\u22B0",
  pscr: "\u{1D4C5}",
  psi: "\u03C8",
  puncsp: "\u2008",
  qfr: "\u{1D52E}",
  qint: "\u2A0C",
  qopf: "\u{1D562}",
  qprime: "\u2057",
  qscr: "\u{1D4C6}",
  quaternions: "\u210D",
  quatint: "\u2A16",
  quest: "?",
  questeq: "\u225F",
  quot: '"',
  rAarr: "\u21DB",
  rArr: "\u21D2",
  rAtail: "\u291C",
  rBarr: "\u290F",
  rHar: "\u2964",
  race: "\u223D\u0331",
  racute: "\u0155",
  radic: "\u221A",
  raemptyv: "\u29B3",
  rang: "\u27E9",
  rangd: "\u2992",
  range: "\u29A5",
  rangle: "\u27E9",
  raquo: "\xBB",
  rarr: "\u2192",
  rarrap: "\u2975",
  rarrb: "\u21E5",
  rarrbfs: "\u2920",
  rarrc: "\u2933",
  rarrfs: "\u291E",
  rarrhk: "\u21AA",
  rarrlp: "\u21AC",
  rarrpl: "\u2945",
  rarrsim: "\u2974",
  rarrtl: "\u21A3",
  rarrw: "\u219D",
  ratail: "\u291A",
  ratio: "\u2236",
  rationals: "\u211A",
  rbarr: "\u290D",
  rbbrk: "\u2773",
  rbrace: "}",
  rbrack: "]",
  rbrke: "\u298C",
  rbrksld: "\u298E",
  rbrkslu: "\u2990",
  rcaron: "\u0159",
  rcedil: "\u0157",
  rceil: "\u2309",
  rcub: "}",
  rcy: "\u0440",
  rdca: "\u2937",
  rdldhar: "\u2969",
  rdquo: "\u201D",
  rdquor: "\u201D",
  rdsh: "\u21B3",
  real: "\u211C",
  realine: "\u211B",
  realpart: "\u211C",
  reals: "\u211D",
  rect: "\u25AD",
  reg: "\xAE",
  rfisht: "\u297D",
  rfloor: "\u230B",
  rfr: "\u{1D52F}",
  rhard: "\u21C1",
  rharu: "\u21C0",
  rharul: "\u296C",
  rho: "\u03C1",
  rhov: "\u03F1",
  rightarrow: "\u2192",
  rightarrowtail: "\u21A3",
  rightharpoondown: "\u21C1",
  rightharpoonup: "\u21C0",
  rightleftarrows: "\u21C4",
  rightleftharpoons: "\u21CC",
  rightrightarrows: "\u21C9",
  rightsquigarrow: "\u219D",
  rightthreetimes: "\u22CC",
  ring: "\u02DA",
  risingdotseq: "\u2253",
  rlarr: "\u21C4",
  rlhar: "\u21CC",
  rlm: "\u200F",
  rmoust: "\u23B1",
  rmoustache: "\u23B1",
  rnmid: "\u2AEE",
  roang: "\u27ED",
  roarr: "\u21FE",
  robrk: "\u27E7",
  ropar: "\u2986",
  ropf: "\u{1D563}",
  roplus: "\u2A2E",
  rotimes: "\u2A35",
  rpar: ")",
  rpargt: "\u2994",
  rppolint: "\u2A12",
  rrarr: "\u21C9",
  rsaquo: "\u203A",
  rscr: "\u{1D4C7}",
  rsh: "\u21B1",
  rsqb: "]",
  rsquo: "\u2019",
  rsquor: "\u2019",
  rthree: "\u22CC",
  rtimes: "\u22CA",
  rtri: "\u25B9",
  rtrie: "\u22B5",
  rtrif: "\u25B8",
  rtriltri: "\u29CE",
  ruluhar: "\u2968",
  rx: "\u211E",
  sacute: "\u015B",
  sbquo: "\u201A",
  sc: "\u227B",
  scE: "\u2AB4",
  scap: "\u2AB8",
  scaron: "\u0161",
  sccue: "\u227D",
  sce: "\u2AB0",
  scedil: "\u015F",
  scirc: "\u015D",
  scnE: "\u2AB6",
  scnap: "\u2ABA",
  scnsim: "\u22E9",
  scpolint: "\u2A13",
  scsim: "\u227F",
  scy: "\u0441",
  sdot: "\u22C5",
  sdotb: "\u22A1",
  sdote: "\u2A66",
  seArr: "\u21D8",
  searhk: "\u2925",
  searr: "\u2198",
  searrow: "\u2198",
  sect: "\xA7",
  semi: ";",
  seswar: "\u2929",
  setminus: "\u2216",
  setmn: "\u2216",
  sext: "\u2736",
  sfr: "\u{1D530}",
  sfrown: "\u2322",
  sharp: "\u266F",
  shchcy: "\u0449",
  shcy: "\u0448",
  shortmid: "\u2223",
  shortparallel: "\u2225",
  shy: "\xAD",
  sigma: "\u03C3",
  sigmaf: "\u03C2",
  sigmav: "\u03C2",
  sim: "\u223C",
  simdot: "\u2A6A",
  sime: "\u2243",
  simeq: "\u2243",
  simg: "\u2A9E",
  simgE: "\u2AA0",
  siml: "\u2A9D",
  simlE: "\u2A9F",
  simne: "\u2246",
  simplus: "\u2A24",
  simrarr: "\u2972",
  slarr: "\u2190",
  smallsetminus: "\u2216",
  smashp: "\u2A33",
  smeparsl: "\u29E4",
  smid: "\u2223",
  smile: "\u2323",
  smt: "\u2AAA",
  smte: "\u2AAC",
  smtes: "\u2AAC\uFE00",
  softcy: "\u044C",
  sol: "/",
  solb: "\u29C4",
  solbar: "\u233F",
  sopf: "\u{1D564}",
  spades: "\u2660",
  spadesuit: "\u2660",
  spar: "\u2225",
  sqcap: "\u2293",
  sqcaps: "\u2293\uFE00",
  sqcup: "\u2294",
  sqcups: "\u2294\uFE00",
  sqsub: "\u228F",
  sqsube: "\u2291",
  sqsubset: "\u228F",
  sqsubseteq: "\u2291",
  sqsup: "\u2290",
  sqsupe: "\u2292",
  sqsupset: "\u2290",
  sqsupseteq: "\u2292",
  squ: "\u25A1",
  square: "\u25A1",
  squarf: "\u25AA",
  squf: "\u25AA",
  srarr: "\u2192",
  sscr: "\u{1D4C8}",
  ssetmn: "\u2216",
  ssmile: "\u2323",
  sstarf: "\u22C6",
  star: "\u2606",
  starf: "\u2605",
  straightepsilon: "\u03F5",
  straightphi: "\u03D5",
  strns: "\xAF",
  sub: "\u2282",
  subE: "\u2AC5",
  subdot: "\u2ABD",
  sube: "\u2286",
  subedot: "\u2AC3",
  submult: "\u2AC1",
  subnE: "\u2ACB",
  subne: "\u228A",
  subplus: "\u2ABF",
  subrarr: "\u2979",
  subset: "\u2282",
  subseteq: "\u2286",
  subseteqq: "\u2AC5",
  subsetneq: "\u228A",
  subsetneqq: "\u2ACB",
  subsim: "\u2AC7",
  subsub: "\u2AD5",
  subsup: "\u2AD3",
  succ: "\u227B",
  succapprox: "\u2AB8",
  succcurlyeq: "\u227D",
  succeq: "\u2AB0",
  succnapprox: "\u2ABA",
  succneqq: "\u2AB6",
  succnsim: "\u22E9",
  succsim: "\u227F",
  sum: "\u2211",
  sung: "\u266A",
  sup1: "\xB9",
  sup2: "\xB2",
  sup3: "\xB3",
  sup: "\u2283",
  supE: "\u2AC6",
  supdot: "\u2ABE",
  supdsub: "\u2AD8",
  supe: "\u2287",
  supedot: "\u2AC4",
  suphsol: "\u27C9",
  suphsub: "\u2AD7",
  suplarr: "\u297B",
  supmult: "\u2AC2",
  supnE: "\u2ACC",
  supne: "\u228B",
  supplus: "\u2AC0",
  supset: "\u2283",
  supseteq: "\u2287",
  supseteqq: "\u2AC6",
  supsetneq: "\u228B",
  supsetneqq: "\u2ACC",
  supsim: "\u2AC8",
  supsub: "\u2AD4",
  supsup: "\u2AD6",
  swArr: "\u21D9",
  swarhk: "\u2926",
  swarr: "\u2199",
  swarrow: "\u2199",
  swnwar: "\u292A",
  szlig: "\xDF",
  target: "\u2316",
  tau: "\u03C4",
  tbrk: "\u23B4",
  tcaron: "\u0165",
  tcedil: "\u0163",
  tcy: "\u0442",
  tdot: "\u20DB",
  telrec: "\u2315",
  tfr: "\u{1D531}",
  there4: "\u2234",
  therefore: "\u2234",
  theta: "\u03B8",
  thetasym: "\u03D1",
  thetav: "\u03D1",
  thickapprox: "\u2248",
  thicksim: "\u223C",
  thinsp: "\u2009",
  thkap: "\u2248",
  thksim: "\u223C",
  thorn: "\xFE",
  tilde: "\u02DC",
  times: "\xD7",
  timesb: "\u22A0",
  timesbar: "\u2A31",
  timesd: "\u2A30",
  tint: "\u222D",
  toea: "\u2928",
  top: "\u22A4",
  topbot: "\u2336",
  topcir: "\u2AF1",
  topf: "\u{1D565}",
  topfork: "\u2ADA",
  tosa: "\u2929",
  tprime: "\u2034",
  trade: "\u2122",
  triangle: "\u25B5",
  triangledown: "\u25BF",
  triangleleft: "\u25C3",
  trianglelefteq: "\u22B4",
  triangleq: "\u225C",
  triangleright: "\u25B9",
  trianglerighteq: "\u22B5",
  tridot: "\u25EC",
  trie: "\u225C",
  triminus: "\u2A3A",
  triplus: "\u2A39",
  trisb: "\u29CD",
  tritime: "\u2A3B",
  trpezium: "\u23E2",
  tscr: "\u{1D4C9}",
  tscy: "\u0446",
  tshcy: "\u045B",
  tstrok: "\u0167",
  twixt: "\u226C",
  twoheadleftarrow: "\u219E",
  twoheadrightarrow: "\u21A0",
  uArr: "\u21D1",
  uHar: "\u2963",
  uacute: "\xFA",
  uarr: "\u2191",
  ubrcy: "\u045E",
  ubreve: "\u016D",
  ucirc: "\xFB",
  ucy: "\u0443",
  udarr: "\u21C5",
  udblac: "\u0171",
  udhar: "\u296E",
  ufisht: "\u297E",
  ufr: "\u{1D532}",
  ugrave: "\xF9",
  uharl: "\u21BF",
  uharr: "\u21BE",
  uhblk: "\u2580",
  ulcorn: "\u231C",
  ulcorner: "\u231C",
  ulcrop: "\u230F",
  ultri: "\u25F8",
  umacr: "\u016B",
  uml: "\xA8",
  uogon: "\u0173",
  uopf: "\u{1D566}",
  uparrow: "\u2191",
  updownarrow: "\u2195",
  upharpoonleft: "\u21BF",
  upharpoonright: "\u21BE",
  uplus: "\u228E",
  upsi: "\u03C5",
  upsih: "\u03D2",
  upsilon: "\u03C5",
  upuparrows: "\u21C8",
  urcorn: "\u231D",
  urcorner: "\u231D",
  urcrop: "\u230E",
  uring: "\u016F",
  urtri: "\u25F9",
  uscr: "\u{1D4CA}",
  utdot: "\u22F0",
  utilde: "\u0169",
  utri: "\u25B5",
  utrif: "\u25B4",
  uuarr: "\u21C8",
  uuml: "\xFC",
  uwangle: "\u29A7",
  vArr: "\u21D5",
  vBar: "\u2AE8",
  vBarv: "\u2AE9",
  vDash: "\u22A8",
  vangrt: "\u299C",
  varepsilon: "\u03F5",
  varkappa: "\u03F0",
  varnothing: "\u2205",
  varphi: "\u03D5",
  varpi: "\u03D6",
  varpropto: "\u221D",
  varr: "\u2195",
  varrho: "\u03F1",
  varsigma: "\u03C2",
  varsubsetneq: "\u228A\uFE00",
  varsubsetneqq: "\u2ACB\uFE00",
  varsupsetneq: "\u228B\uFE00",
  varsupsetneqq: "\u2ACC\uFE00",
  vartheta: "\u03D1",
  vartriangleleft: "\u22B2",
  vartriangleright: "\u22B3",
  vcy: "\u0432",
  vdash: "\u22A2",
  vee: "\u2228",
  veebar: "\u22BB",
  veeeq: "\u225A",
  vellip: "\u22EE",
  verbar: "|",
  vert: "|",
  vfr: "\u{1D533}",
  vltri: "\u22B2",
  vnsub: "\u2282\u20D2",
  vnsup: "\u2283\u20D2",
  vopf: "\u{1D567}",
  vprop: "\u221D",
  vrtri: "\u22B3",
  vscr: "\u{1D4CB}",
  vsubnE: "\u2ACB\uFE00",
  vsubne: "\u228A\uFE00",
  vsupnE: "\u2ACC\uFE00",
  vsupne: "\u228B\uFE00",
  vzigzag: "\u299A",
  wcirc: "\u0175",
  wedbar: "\u2A5F",
  wedge: "\u2227",
  wedgeq: "\u2259",
  weierp: "\u2118",
  wfr: "\u{1D534}",
  wopf: "\u{1D568}",
  wp: "\u2118",
  wr: "\u2240",
  wreath: "\u2240",
  wscr: "\u{1D4CC}",
  xcap: "\u22C2",
  xcirc: "\u25EF",
  xcup: "\u22C3",
  xdtri: "\u25BD",
  xfr: "\u{1D535}",
  xhArr: "\u27FA",
  xharr: "\u27F7",
  xi: "\u03BE",
  xlArr: "\u27F8",
  xlarr: "\u27F5",
  xmap: "\u27FC",
  xnis: "\u22FB",
  xodot: "\u2A00",
  xopf: "\u{1D569}",
  xoplus: "\u2A01",
  xotime: "\u2A02",
  xrArr: "\u27F9",
  xrarr: "\u27F6",
  xscr: "\u{1D4CD}",
  xsqcup: "\u2A06",
  xuplus: "\u2A04",
  xutri: "\u25B3",
  xvee: "\u22C1",
  xwedge: "\u22C0",
  yacute: "\xFD",
  yacy: "\u044F",
  ycirc: "\u0177",
  ycy: "\u044B",
  yen: "\xA5",
  yfr: "\u{1D536}",
  yicy: "\u0457",
  yopf: "\u{1D56A}",
  yscr: "\u{1D4CE}",
  yucy: "\u044E",
  yuml: "\xFF",
  zacute: "\u017A",
  zcaron: "\u017E",
  zcy: "\u0437",
  zdot: "\u017C",
  zeetrf: "\u2128",
  zeta: "\u03B6",
  zfr: "\u{1D537}",
  zhcy: "\u0436",
  zigrarr: "\u21DD",
  zopf: "\u{1D56B}",
  zscr: "\u{1D4CF}",
  zwj: "\u200D",
  zwnj: "\u200C"
};

var own2 = {}.hasOwnProperty;
function decodeNamedCharacterReference(value) {
  return own2.call(characterEntities, value) ? characterEntities[value] : false;
}

function splice(list4, start2, remove, items) {
  const end = list4.length;
  let chunkStart = 0;
  let parameters;
  if (start2 < 0) {
    start2 = -start2 > end ? 0 : end + start2;
  } else {
    start2 = start2 > end ? end : start2;
  }
  remove = remove > 0 ? remove : 0;
  if (items.length < 1e4) {
    parameters = Array.from(items);
    parameters.unshift(start2, remove);
    list4.splice(...parameters);
  } else {
    if (remove) list4.splice(start2, remove);
    while (chunkStart < items.length) {
      parameters = items.slice(chunkStart, chunkStart + 1e4);
      parameters.unshift(start2, 0);
      list4.splice(...parameters);
      chunkStart += 1e4;
      start2 += 1e4;
    }
  }
}
function push(list4, items) {
  if (list4.length > 0) {
    splice(list4, list4.length, 0, items);
    return list4;
  }
  return items;
}

var hasOwnProperty = {}.hasOwnProperty;
function combineExtensions(extensions) {
  const all2 = {};
  let index3 = -1;
  while (++index3 < extensions.length) {
    syntaxExtension(all2, extensions[index3]);
  }
  return all2;
}
function syntaxExtension(all2, extension2) {
  let hook;
  for (hook in extension2) {
    const maybe = hasOwnProperty.call(all2, hook) ? all2[hook] : void 0;
    const left = maybe || (all2[hook] = {});
    const right = extension2[hook];
    let code4;
    if (right) {
      for (code4 in right) {
        if (!hasOwnProperty.call(left, code4)) left[code4] = [];
        const value = right[code4];
        constructs(
          // @ts-expect-error Looks like a list.
          left[code4],
          Array.isArray(value) ? value : value ? [value] : []
        );
      }
    }
  }
}
function constructs(existing, list4) {
  let index3 = -1;
  const before = [];
  while (++index3 < list4.length) {
    ;
    (list4[index3].add === "after" ? existing : before).push(list4[index3]);
  }
  splice(existing, 0, 0, before);
}

function decodeNumericCharacterReference(value, base) {
  const code4 = Number.parseInt(value, base);
  if (
    // C0 except for HT, LF, FF, CR, space.
    code4 < 9 || code4 === 11 || code4 > 13 && code4 < 32 || // Control character (DEL) of C0, and C1 controls.
    code4 > 126 && code4 < 160 || // Lone high surrogates and low surrogates.
    code4 > 55295 && code4 < 57344 || // Noncharacters.
    code4 > 64975 && code4 < 65008 || /* eslint-disable no-bitwise */
    (code4 & 65535) === 65535 || (code4 & 65535) === 65534 || /* eslint-enable no-bitwise */
    // Out of range
    code4 > 1114111
  ) {
    return "\uFFFD";
  }
  return String.fromCodePoint(code4);
}

function normalizeIdentifier(value) {
  return value.replace(/[\t\n\r ]+/g, " ").replace(/^ | $/g, "").toLowerCase().toUpperCase();
}

var asciiAlpha = regexCheck(/[A-Za-z]/);
var asciiAlphanumeric = regexCheck(/[\dA-Za-z]/);
var asciiAtext = regexCheck(/[#-'*+\--9=?A-Z^-~]/);
function asciiControl(code4) {
  return (
    // Special whitespace codes (which have negative values), C0 and Control
    // character DEL
    code4 !== null && (code4 < 32 || code4 === 127)
  );
}
var asciiDigit = regexCheck(/\d/);
var asciiHexDigit = regexCheck(/[\dA-Fa-f]/);
var asciiPunctuation = regexCheck(/[!-/:-@[-`{-~]/);
function markdownLineEnding(code4) {
  return code4 !== null && code4 < -2;
}
function markdownLineEndingOrSpace(code4) {
  return code4 !== null && (code4 < 0 || code4 === 32);
}
function markdownSpace(code4) {
  return code4 === -2 || code4 === -1 || code4 === 32;
}
var unicodePunctuation = regexCheck(/\p{P}|\p{S}/u);
var unicodeWhitespace = regexCheck(/\s/);
function regexCheck(regex) {
  return check2;
  function check2(code4) {
    return code4 !== null && code4 > -1 && regex.test(String.fromCharCode(code4));
  }
}

function normalizeUri(value) {
  const result = [];
  let index3 = -1;
  let start2 = 0;
  let skip = 0;
  while (++index3 < value.length) {
    const code4 = value.charCodeAt(index3);
    let replace2 = "";
    if (code4 === 37 && asciiAlphanumeric(value.charCodeAt(index3 + 1)) && asciiAlphanumeric(value.charCodeAt(index3 + 2))) {
      skip = 2;
    } else if (code4 < 128) {
      if (!/[!#$&-;=?-Z_a-z~]/.test(String.fromCharCode(code4))) {
        replace2 = String.fromCharCode(code4);
      }
    } else if (code4 > 55295 && code4 < 57344) {
      const next = value.charCodeAt(index3 + 1);
      if (code4 < 56320 && next > 56319 && next < 57344) {
        replace2 = String.fromCharCode(code4, next);
        skip = 1;
      } else {
        replace2 = "\uFFFD";
      }
    } else {
      replace2 = String.fromCharCode(code4);
    }
    if (replace2) {
      result.push(value.slice(start2, index3), encodeURIComponent(replace2));
      start2 = index3 + skip + 1;
      replace2 = "";
    }
    if (skip) {
      index3 += skip;
      skip = 0;
    }
  }
  return result.join("") + value.slice(start2);
}

function factorySpace(effects, ok3, type, max) {
  const limit = max ? max - 1 : Infinity;
  let size = 0;
  return start2;
  function start2(code4) {
    if (markdownSpace(code4)) {
      effects.enter(type);
      return prefix(code4);
    }
    return ok3(code4);
  }
  function prefix(code4) {
    if (markdownSpace(code4) && size++ < limit) {
      effects.consume(code4);
      return prefix;
    }
    effects.exit(type);
    return ok3(code4);
  }
}
function factorySpaceMinMax(effects, ok3, nok, type, min, max) {
  let size = 0;
  return start2;
  function start2(code4) {
    if (max > 0 && markdownSpace(code4)) {
      effects.enter(type);
      return prefix(code4);
    }
    return after(code4);
  }
  function prefix(code4) {
    if (markdownSpace(code4) && size < max) {
      effects.consume(code4);
      size++;
      return prefix;
    }
    effects.exit(type);
    return after(code4);
  }
  function after(code4) {
    return size >= min ? ok3(code4) : nok(code4);
  }
}

var content = {
  tokenize: initializeContent
};
function initializeContent(effects) {
  const contentStart = effects.attempt(this.parser.constructs.contentInitial, afterContentStartConstruct, paragraphInitial);
  let previous3;
  return contentStart;
  function afterContentStartConstruct(code4) {
    if (code4 === null) {
      effects.consume(code4);
      return;
    }
    effects.enter("lineEnding");
    effects.consume(code4);
    effects.exit("lineEnding");
    return factorySpace(effects, contentStart, "linePrefix");
  }
  function paragraphInitial(code4) {
    effects.enter("paragraph");
    return lineStart(code4);
  }
  function lineStart(code4) {
    const token = effects.enter("chunkText", {
      contentType: "text",
      previous: previous3
    });
    if (previous3) {
      previous3.next = token;
    }
    previous3 = token;
    return data(code4);
  }
  function data(code4) {
    if (code4 === null) {
      effects.exit("chunkText");
      effects.exit("paragraph");
      effects.consume(code4);
      return;
    }
    if (markdownLineEnding(code4)) {
      effects.consume(code4);
      effects.exit("chunkText");
      return lineStart;
    }
    effects.consume(code4);
    return data;
  }
}

var EditMap = class {
  /**
   * Create a new edit map.
   *
   * @returns
   *   New instance.
   */
  constructor() {
    this.index = /* @__PURE__ */ new Map();
    this.map = [];
  }
  /**
   * Create an edit: a remove and/or add at a certain place.
   *
   * @param {number} index
   *   Index at which to apply the edit.
   * @param {number} remove
   *   Count of items to remove at the index.
   * @param {Array<Event>} add
   *   Items to add at the index.
   * @returns {undefined}
   *   Nothing.
   */
  add(index3, remove, add) {
    addImplementation(this, index3, remove, add, false);
  }
  /**
   * Create an edit: but insert `add` before existing additions, instead of
   * after them.
   *
   * @param {number} index
   *   Index at which to apply the edit.
   * @param {number} remove
   *   Count of items to remove at the index.
   * @param {Array<Event>} add
   *   Items to add at the index.
   * @returns {undefined}
   *   Nothing.
   */
  addBefore(index3, remove, add) {
    addImplementation(this, index3, remove, add, true);
  }
  /**
   * Done, change the events.
   *
   * @param {Array<Event>} events
   *   List of events to apply the edits to.
   * @returns {undefined}
   *   Nothing.
   */
  consume(events) {
    this.map.sort(function(a, b) {
      return a[0] - b[0];
    });
    if (this.map.length === 0) {
      return;
    }
    let index3 = this.map.length;
    const vecs = [];
    while (index3 > 0) {
      index3 -= 1;
      vecs.push(events.slice(this.map[index3][0] + this.map[index3][1]), this.map[index3][2]);
      events.length = this.map[index3][0];
    }
    vecs.push(events.slice());
    events.length = 0;
    let slice = vecs.pop();
    while (slice) {
      for (const element2 of slice) {
        events.push(element2);
      }
      slice = vecs.pop();
    }
    this.map.length = 0;
    this.index.clear();
  }
};
function addImplementation(editMap, at, remove, add, before) {
  if (remove === 0 && add.length === 0) {
    return;
  }
  const existing = editMap.index.get(at);
  if (existing) {
    existing[1] += remove;
    if (before) {
      add.push(...existing[2]);
      existing[2] = add;
    } else {
      existing[2].push(...add);
    }
    return;
  }
  const change = [at, remove, add];
  editMap.map.push(change);
  editMap.index.set(at, change);
}

var document2 = {
  tokenize: initializeDocument
};
var containerConstruct = {
  tokenize: tokenizeContainer
};
function initializeDocument(effects) {
  const self2 = this;
  const stack = [];
  let continued = 0;
  let childFlow;
  let childToken;
  let lineStartOffset;
  return start2;
  function start2(code4) {
    if (continued < stack.length) {
      const item = stack[continued];
      self2.containerState = item[1];
      return effects.attempt(item[0].continuation, documentContinue, checkNewContainers)(code4);
    }
    return checkNewContainers(code4);
  }
  function documentContinue(code4) {
    continued++;
    if (self2.containerState._closeFlow) {
      self2.containerState._closeFlow = void 0;
      if (childFlow) {
        closeFlow();
      }
      const indexBeforeExits = self2.events.length;
      let indexBeforeFlow = indexBeforeExits;
      let point4;
      while (indexBeforeFlow--) {
        if (self2.events[indexBeforeFlow][0] === "exit" && self2.events[indexBeforeFlow][1].type === "chunkFlow") {
          point4 = self2.events[indexBeforeFlow][1].end;
          break;
        }
      }
      exitContainers(continued);
      let index3 = indexBeforeExits;
      while (index3 < self2.events.length) {
        self2.events[index3][1].end = {
          ...point4
        };
        index3++;
      }
      const editMap = new EditMap();
      editMap.add(indexBeforeFlow + 1, 0, self2.events.slice(indexBeforeExits));
      editMap.add(indexBeforeExits, index3 - indexBeforeExits, []);
      editMap.consume(self2.events);
      return checkNewContainers(code4);
    }
    return start2(code4);
  }
  function checkNewContainers(code4) {
    if (continued === stack.length) {
      if (!childFlow) {
        return documentContinued(code4);
      }
      if (childFlow.currentConstruct && childFlow.currentConstruct.concrete) {
        return flowStart(code4);
      }
      self2.interrupt = Boolean(childFlow.currentConstruct && !childFlow._gfmTableDynamicInterruptHack);
    }
    self2.containerState = {};
    return effects.check(containerConstruct, thereIsANewContainer, thereIsNoNewContainer)(code4);
  }
  function thereIsANewContainer(code4) {
    if (childFlow) {
      closeFlow();
    }
    exitContainers(continued);
    return documentContinued(code4);
  }
  function thereIsNoNewContainer(code4) {
    self2.parser.lazy[self2.now().line] = continued !== stack.length;
    lineStartOffset = self2.now().offset;
    return flowStart(code4);
  }
  function documentContinued(code4) {
    self2.containerState = {};
    return effects.attempt(containerConstruct, containerContinue, flowStart)(code4);
  }
  function containerContinue(code4) {
    continued++;
    stack.push([self2.currentConstruct, self2.containerState]);
    return documentContinued(code4);
  }
  function flowStart(code4) {
    if (code4 === null) {
      if (childFlow) {
        closeFlow();
      }
      exitContainers(0);
      effects.consume(code4);
      return;
    }
    childFlow = childFlow || self2.parser.flow(self2.now());
    effects.enter("chunkFlow", {
      _tokenizer: childFlow,
      contentType: "flow",
      previous: childToken
    });
    return flowContinue(code4);
  }
  function flowContinue(code4) {
    if (code4 === null) {
      writeToChild(effects.exit("chunkFlow"), true);
      exitContainers(0);
      effects.consume(code4);
      return;
    }
    if (markdownLineEnding(code4)) {
      effects.consume(code4);
      writeToChild(effects.exit("chunkFlow"));
      continued = 0;
      self2.interrupt = void 0;
      return start2;
    }
    effects.consume(code4);
    return flowContinue;
  }
  function writeToChild(token, endOfFile) {
    const stream = self2.sliceStream(token);
    if (endOfFile) {
      stream.push(null);
    }
    token.previous = childToken;
    if (childToken) {
      childToken.next = token;
    }
    childToken = token;
    childFlow.defineSkip(token.start);
    childFlow.write(stream);
    if (self2.parser.lazy[token.start.line]) {
      let index3 = childFlow.events.length;
      while (index3--) {
        if (
          // The token starts before the line ending…
          childFlow.events[index3][1].start.offset < lineStartOffset && // …and either is not ended yet…
          (!childFlow.events[index3][1].end || // …or ends after it.
          childFlow.events[index3][1].end.offset > lineStartOffset)
        ) {
          return;
        }
      }
      const indexBeforeExits = self2.events.length;
      let indexBeforeFlow = indexBeforeExits;
      let seen;
      let point4;
      while (indexBeforeFlow--) {
        if (self2.events[indexBeforeFlow][0] === "exit" && self2.events[indexBeforeFlow][1].type === "chunkFlow") {
          if (seen) {
            point4 = self2.events[indexBeforeFlow][1].end;
            break;
          }
          seen = true;
        }
      }
      exitContainers(continued);
      index3 = indexBeforeExits;
      while (index3 < self2.events.length) {
        self2.events[index3][1].end = {
          ...point4
        };
        index3++;
      }
      const editMap = new EditMap();
      editMap.add(indexBeforeFlow + 1, 0, self2.events.slice(indexBeforeExits));
      editMap.add(indexBeforeExits, index3 - indexBeforeExits, []);
      editMap.consume(self2.events);
    }
  }
  function exitContainers(size) {
    let index3 = stack.length;
    while (index3-- > size) {
      const entry = stack[index3];
      self2.containerState = entry[1];
      entry[0].exit.call(self2, effects);
    }
    stack.length = size;
  }
  function closeFlow() {
    childFlow.write([null]);
    childToken = void 0;
    childFlow = void 0;
    self2.containerState._closeFlow = void 0;
  }
}
function tokenizeContainer(effects, ok3, nok) {
  return factorySpace(effects, effects.attempt(this.parser.constructs.document, ok3, nok), "linePrefix", this.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4);
}

function classifyCharacter(code4) {
  if (code4 === null || markdownLineEndingOrSpace(code4) || unicodeWhitespace(code4)) {
    return 1;
  }
  if (unicodePunctuation(code4)) {
    return 2;
  }
}

function resolveAll(constructs2, events, context) {
  const called = [];
  let index3 = -1;
  while (++index3 < constructs2.length) {
    const resolve = constructs2[index3].resolveAll;
    if (resolve && !called.includes(resolve)) {
      events = resolve(events, context);
      called.push(resolve);
    }
  }
  return events;
}

var attention = {
  name: "attention",
  resolveAll: resolveAllAttention,
  tokenize: tokenizeAttention
};
function resolveAllAttention(events, context) {
  let index3 = -1;
  let nextEvents;
  while (++index3 < events.length) {
    if (events[index3][0] === "enter" && events[index3][1].type === "attentionSequence" && events[index3][1]._close) {
      let open = index3;
      while (open--) {
        if (events[open][0] === "exit" && events[open][1].type === "attentionSequence" && events[open][1]._open && // If the markers are the same:
        context.sliceSerialize(events[open][1]).charCodeAt(0) === context.sliceSerialize(events[index3][1]).charCodeAt(0)) {
          if ((events[open][1]._close || events[index3][1]._open) && (events[index3][1].end.offset - events[index3][1].start.offset) % 3 && !((events[open][1].end.offset - events[open][1].start.offset + events[index3][1].end.offset - events[index3][1].start.offset) % 3)) {
            continue;
          }
          const use = events[open][1].end.offset - events[open][1].start.offset > 1 && events[index3][1].end.offset - events[index3][1].start.offset > 1 ? 2 : 1;
          const start2 = {
            ...events[open][1].end
          };
          const end = {
            ...events[index3][1].start
          };
          movePoint(start2, -use);
          movePoint(end, use);
          const openingSequence = {
            type: use > 1 ? "strongSequence" : "emphasisSequence",
            start: start2,
            end: {
              ...events[open][1].end
            }
          };
          const closingSequence = {
            type: use > 1 ? "strongSequence" : "emphasisSequence",
            start: {
              ...events[index3][1].start
            },
            end
          };
          const text7 = {
            type: use > 1 ? "strongText" : "emphasisText",
            start: {
              ...events[open][1].end
            },
            end: {
              ...events[index3][1].start
            }
          };
          const group = {
            type: use > 1 ? "strong" : "emphasis",
            start: {
              ...openingSequence.start
            },
            end: {
              ...closingSequence.end
            }
          };
          events[open][1].end = {
            ...openingSequence.start
          };
          events[index3][1].start = {
            ...closingSequence.end
          };
          nextEvents = [];
          if (events[open][1].end.offset - events[open][1].start.offset) {
            nextEvents = push(nextEvents, [["enter", events[open][1], context], ["exit", events[open][1], context]]);
          }
          nextEvents = push(nextEvents, [["enter", group, context], ["enter", openingSequence, context], ["exit", openingSequence, context], ["enter", text7, context]]);
          nextEvents = push(nextEvents, resolveAll(context.parser.constructs.insideSpan.null, events.slice(open + 1, index3), context));
          nextEvents = push(nextEvents, [["exit", text7, context], ["enter", closingSequence, context], ["exit", closingSequence, context], ["exit", group, context]]);
          let offset = 0;
          if (events[index3][1].end.offset - events[index3][1].start.offset) {
            offset = 2;
            nextEvents = push(nextEvents, [["enter", events[index3][1], context], ["exit", events[index3][1], context]]);
          }
          splice(events, open - 1, index3 - open + 3, nextEvents);
          index3 = open + nextEvents.length - offset - 2;
          break;
        }
      }
    }
  }
  index3 = -1;
  while (++index3 < events.length) {
    if (events[index3][1].type === "attentionSequence") {
      events[index3][1].type = "data";
    }
  }
  return events;
}
function tokenizeAttention(effects, ok3) {
  const attentionMarkers2 = this.parser.constructs.attentionMarkers.null;
  const previous3 = this.previous;
  const before = classifyCharacter(previous3);
  let marker;
  return start2;
  function start2(code4) {
    marker = code4;
    effects.enter("attentionSequence");
    return inside(code4);
  }
  function inside(code4) {
    if (code4 === marker) {
      effects.consume(code4);
      return inside;
    }
    const token = effects.exit("attentionSequence");
    const after = classifyCharacter(code4);
    const open = !after || after === 2 && before || attentionMarkers2.includes(code4) && code4 !== 42 && code4 !== 95;
    const close = !before || before === 2 && after || attentionMarkers2.includes(previous3) && previous3 !== 42 && previous3 !== 95;
    token._open = Boolean(marker === 42 ? open : open && (before || !close));
    token._close = Boolean(marker === 42 ? close : close && (after || !open));
    return ok3(code4);
  }
}
function movePoint(point4, offset) {
  point4.column += offset;
  point4.offset += offset;
  point4._bufferIndex += offset;
}

var autolink = {
  name: "autolink",
  tokenize: tokenizeAutolink
};
function tokenizeAutolink(effects, ok3, nok) {
  let size = 0;
  return start2;
  function start2(code4) {
    effects.enter("autolink");
    effects.enter("autolinkMarker");
    effects.consume(code4);
    effects.exit("autolinkMarker");
    effects.enter("autolinkProtocol");
    return open;
  }
  function open(code4) {
    if (asciiAlpha(code4)) {
      effects.consume(code4);
      return schemeOrEmailAtext;
    }
    if (code4 === 64) {
      return nok(code4);
    }
    return emailAtext(code4);
  }
  function schemeOrEmailAtext(code4) {
    if (code4 === 43 || code4 === 45 || code4 === 46 || asciiAlphanumeric(code4)) {
      size = 1;
      return schemeInsideOrEmailAtext(code4);
    }
    return emailAtext(code4);
  }
  function schemeInsideOrEmailAtext(code4) {
    if (code4 === 58) {
      effects.consume(code4);
      size = 0;
      return urlInside;
    }
    if ((code4 === 43 || code4 === 45 || code4 === 46 || asciiAlphanumeric(code4)) && size++ < 32) {
      effects.consume(code4);
      return schemeInsideOrEmailAtext;
    }
    size = 0;
    return emailAtext(code4);
  }
  function urlInside(code4) {
    if (code4 === 62) {
      effects.exit("autolinkProtocol");
      effects.enter("autolinkMarker");
      effects.consume(code4);
      effects.exit("autolinkMarker");
      effects.exit("autolink");
      return ok3;
    }
    if (code4 === null || code4 === 32 || code4 === 60 || asciiControl(code4)) {
      return nok(code4);
    }
    effects.consume(code4);
    return urlInside;
  }
  function emailAtext(code4) {
    if (code4 === 64) {
      effects.consume(code4);
      return emailAtSignOrDot;
    }
    if (asciiAtext(code4)) {
      effects.consume(code4);
      return emailAtext;
    }
    return nok(code4);
  }
  function emailAtSignOrDot(code4) {
    return asciiAlphanumeric(code4) ? emailLabel(code4) : nok(code4);
  }
  function emailLabel(code4) {
    if (code4 === 46) {
      effects.consume(code4);
      size = 0;
      return emailAtSignOrDot;
    }
    if (code4 === 62) {
      effects.exit("autolinkProtocol").type = "autolinkEmail";
      effects.enter("autolinkMarker");
      effects.consume(code4);
      effects.exit("autolinkMarker");
      effects.exit("autolink");
      return ok3;
    }
    return emailValue(code4);
  }
  function emailValue(code4) {
    if ((code4 === 45 || asciiAlphanumeric(code4)) && size++ < 63) {
      const next = code4 === 45 ? emailValue : emailLabel;
      effects.consume(code4);
      return next;
    }
    return nok(code4);
  }
}

var blankLine = {
  partial: true,
  tokenize: tokenizeBlankLine
};
function tokenizeBlankLine(effects, ok3, nok) {
  return start2;
  function start2(code4) {
    return markdownSpace(code4) ? factorySpace(effects, after, "linePrefix")(code4) : after(code4);
  }
  function after(code4) {
    return code4 === null || markdownLineEnding(code4) ? ok3(code4) : nok(code4);
  }
}

var blockQuote = {
  continuation: {
    tokenize: tokenizeBlockQuoteContinuation
  },
  exit,
  name: "blockQuote",
  tokenize: tokenizeBlockQuoteStart
};
function tokenizeBlockQuoteStart(effects, ok3, nok) {
  const self2 = this;
  return start2;
  function start2(code4) {
    if (code4 === 62) {
      const state = self2.containerState;
      if (!state.open) {
        effects.enter("blockQuote", {
          _container: true
        });
        state.open = true;
      }
      effects.enter("blockQuotePrefix");
      effects.enter("blockQuoteMarker");
      effects.consume(code4);
      effects.exit("blockQuoteMarker");
      return after;
    }
    return nok(code4);
  }
  function after(code4) {
    if (markdownSpace(code4)) {
      effects.enter("blockQuotePrefixWhitespace");
      effects.consume(code4);
      effects.exit("blockQuotePrefixWhitespace");
      effects.exit("blockQuotePrefix");
      return ok3;
    }
    effects.exit("blockQuotePrefix");
    return ok3(code4);
  }
}
function tokenizeBlockQuoteContinuation(effects, ok3, nok) {
  const self2 = this;
  return contStart;
  function contStart(code4) {
    if (markdownSpace(code4)) {
      return factorySpace(effects, contBefore, "linePrefix", self2.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4)(code4);
    }
    return contBefore(code4);
  }
  function contBefore(code4) {
    return effects.attempt(blockQuote, ok3, nok)(code4);
  }
}
function exit(effects) {
  effects.exit("blockQuote");
}

var characterEscape = {
  name: "characterEscape",
  tokenize: tokenizeCharacterEscape
};
function tokenizeCharacterEscape(effects, ok3, nok) {
  return start2;
  function start2(code4) {
    effects.enter("characterEscape");
    effects.enter("escapeMarker");
    effects.consume(code4);
    effects.exit("escapeMarker");
    return inside;
  }
  function inside(code4) {
    if (asciiPunctuation(code4)) {
      effects.enter("characterEscapeValue");
      effects.consume(code4);
      effects.exit("characterEscapeValue");
      effects.exit("characterEscape");
      return ok3;
    }
    return nok(code4);
  }
}

var characterReference = {
  name: "characterReference",
  tokenize: tokenizeCharacterReference
};
function tokenizeCharacterReference(effects, ok3, nok) {
  const self2 = this;
  let size = 0;
  let max;
  let test;
  return start2;
  function start2(code4) {
    effects.enter("characterReference");
    effects.enter("characterReferenceMarker");
    effects.consume(code4);
    effects.exit("characterReferenceMarker");
    return open;
  }
  function open(code4) {
    if (code4 === 35) {
      effects.enter("characterReferenceMarkerNumeric");
      effects.consume(code4);
      effects.exit("characterReferenceMarkerNumeric");
      return numeric;
    }
    effects.enter("characterReferenceValue");
    max = 31;
    test = asciiAlphanumeric;
    return value(code4);
  }
  function numeric(code4) {
    if (code4 === 88 || code4 === 120) {
      effects.enter("characterReferenceMarkerHexadecimal");
      effects.consume(code4);
      effects.exit("characterReferenceMarkerHexadecimal");
      effects.enter("characterReferenceValue");
      max = 6;
      test = asciiHexDigit;
      return value;
    }
    effects.enter("characterReferenceValue");
    max = 7;
    test = asciiDigit;
    return value(code4);
  }
  function value(code4) {
    if (code4 === 59 && size) {
      const token = effects.exit("characterReferenceValue");
      if (test === asciiAlphanumeric && !decodeNamedCharacterReference(self2.sliceSerialize(token))) {
        return nok(code4);
      }
      effects.enter("characterReferenceMarker");
      effects.consume(code4);
      effects.exit("characterReferenceMarker");
      effects.exit("characterReference");
      return ok3;
    }
    if (test(code4) && size++ < max) {
      effects.consume(code4);
      return value;
    }
    return nok(code4);
  }
}

var nonLazyContinuation = {
  partial: true,
  tokenize: tokenizeNonLazyContinuation
};
function tokenizeNonLazyContinuation(effects, ok3, nok) {
  const self2 = this;
  return start2;
  function start2(code4) {
    if (code4 === null) {
      return nok(code4);
    }
    effects.enter("lineEnding");
    effects.consume(code4);
    effects.exit("lineEnding");
    return after;
  }
  function after(code4) {
    return self2.parser.lazy[self2.now().line] ? nok(code4) : ok3(code4);
  }
}

var codeFenced = {
  concrete: true,
  name: "codeFenced",
  tokenize: tokenizeCodeFenced
};
function tokenizeCodeFenced(effects, ok3, nok) {
  const self2 = this;
  const closeStart = {
    partial: true,
    tokenize: tokenizeCloseStart
  };
  let initialPrefix = 0;
  let sizeOpen = 0;
  let marker;
  return start2;
  function start2(code4) {
    return beforeSequenceOpen(code4);
  }
  function beforeSequenceOpen(code4) {
    const tail = self2.events[self2.events.length - 1];
    initialPrefix = tail && tail[1].type === "linePrefix" ? tail[2].sliceSerialize(tail[1], true).length : 0;
    marker = code4;
    effects.enter("codeFenced");
    effects.enter("codeFencedFence");
    effects.enter("codeFencedFenceSequence");
    return sequenceOpen(code4);
  }
  function sequenceOpen(code4) {
    if (code4 === marker) {
      sizeOpen++;
      effects.consume(code4);
      return sequenceOpen;
    }
    if (sizeOpen < 3) {
      return nok(code4);
    }
    effects.exit("codeFencedFenceSequence");
    return markdownSpace(code4) ? factorySpace(effects, infoBefore, "whitespace")(code4) : infoBefore(code4);
  }
  function infoBefore(code4) {
    if (code4 === null || markdownLineEnding(code4)) {
      effects.exit("codeFencedFence");
      return self2.interrupt ? ok3(code4) : effects.check(nonLazyContinuation, atNonLazyBreak, after)(code4);
    }
    effects.enter("codeFencedFenceInfo");
    effects.enter("chunkString", {
      contentType: "string"
    });
    return info(code4);
  }
  function info(code4) {
    if (code4 === null || markdownLineEnding(code4)) {
      effects.exit("chunkString");
      effects.exit("codeFencedFenceInfo");
      return infoBefore(code4);
    }
    if (markdownSpace(code4)) {
      effects.exit("chunkString");
      effects.exit("codeFencedFenceInfo");
      return factorySpace(effects, metaBefore, "whitespace")(code4);
    }
    if (code4 === 96 && code4 === marker) {
      return nok(code4);
    }
    effects.consume(code4);
    return info;
  }
  function metaBefore(code4) {
    if (code4 === null || markdownLineEnding(code4)) {
      return infoBefore(code4);
    }
    effects.enter("codeFencedFenceMeta");
    effects.enter("chunkString", {
      contentType: "string"
    });
    return meta(code4);
  }
  function meta(code4) {
    if (code4 === null || markdownLineEnding(code4)) {
      effects.exit("chunkString");
      effects.exit("codeFencedFenceMeta");
      return infoBefore(code4);
    }
    if (code4 === 96 && code4 === marker) {
      return nok(code4);
    }
    effects.consume(code4);
    return meta;
  }
  function atNonLazyBreak(code4) {
    return effects.attempt(closeStart, after, contentBefore)(code4);
  }
  function contentBefore(code4) {
    effects.enter("lineEnding");
    effects.consume(code4);
    effects.exit("lineEnding");
    return contentStart;
  }
  function contentStart(code4) {
    return initialPrefix > 0 && markdownSpace(code4) ? factorySpace(effects, beforeContentChunk, "linePrefix", initialPrefix + 1)(code4) : beforeContentChunk(code4);
  }
  function beforeContentChunk(code4) {
    if (code4 === null || markdownLineEnding(code4)) {
      return effects.check(nonLazyContinuation, atNonLazyBreak, after)(code4);
    }
    effects.enter("codeFlowValue");
    return contentChunk(code4);
  }
  function contentChunk(code4) {
    if (code4 === null || markdownLineEnding(code4)) {
      effects.exit("codeFlowValue");
      return beforeContentChunk(code4);
    }
    effects.consume(code4);
    return contentChunk;
  }
  function after(code4) {
    effects.exit("codeFenced");
    return ok3(code4);
  }
  function tokenizeCloseStart(effects2, ok4, nok2) {
    let size = 0;
    return startBefore;
    function startBefore(code4) {
      effects2.enter("lineEnding");
      effects2.consume(code4);
      effects2.exit("lineEnding");
      return start3;
    }
    function start3(code4) {
      effects2.enter("codeFencedFence");
      return markdownSpace(code4) ? factorySpace(effects2, beforeSequenceClose, "linePrefix", self2.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4)(code4) : beforeSequenceClose(code4);
    }
    function beforeSequenceClose(code4) {
      if (code4 === marker) {
        effects2.enter("codeFencedFenceSequence");
        return sequenceClose(code4);
      }
      return nok2(code4);
    }
    function sequenceClose(code4) {
      if (code4 === marker) {
        size++;
        effects2.consume(code4);
        return sequenceClose;
      }
      if (size >= sizeOpen) {
        effects2.exit("codeFencedFenceSequence");
        return markdownSpace(code4) ? factorySpace(effects2, sequenceCloseAfter, "whitespace")(code4) : sequenceCloseAfter(code4);
      }
      return nok2(code4);
    }
    function sequenceCloseAfter(code4) {
      if (code4 === null || markdownLineEnding(code4)) {
        effects2.exit("codeFencedFence");
        return ok4(code4);
      }
      return nok2(code4);
    }
  }
}

var codeIndented = {
  name: "codeIndented",
  tokenize: tokenizeCodeIndented
};
var furtherStart = {
  partial: true,
  tokenize: tokenizeFurtherStart
};
function tokenizeCodeIndented(effects, ok3, nok) {
  return start2;
  function start2(code4) {
    effects.enter("codeIndented");
    return factorySpaceMinMax(effects, atBreak, nok, "linePrefix", 4, 4)(code4);
  }
  function atBreak(code4) {
    if (code4 === null) {
      return after(code4);
    }
    if (markdownLineEnding(code4)) {
      return effects.attempt(furtherStart, atBreak, after)(code4);
    }
    effects.enter("codeFlowValue");
    return inside(code4);
  }
  function inside(code4) {
    if (code4 === null || markdownLineEnding(code4)) {
      effects.exit("codeFlowValue");
      return atBreak(code4);
    }
    effects.consume(code4);
    return inside;
  }
  function after(code4) {
    effects.exit("codeIndented");
    return ok3(code4);
  }
}
function tokenizeFurtherStart(effects, ok3, nok) {
  const self2 = this;
  return furtherStart2;
  function furtherStart2(code4) {
    if (self2.parser.lazy[self2.now().line]) {
      return nok(code4);
    }
    if (markdownLineEnding(code4)) {
      effects.enter("lineEnding");
      effects.consume(code4);
      effects.exit("lineEnding");
      return furtherStart2;
    }
    return factorySpaceMinMax(effects, ok3, onNotEnoughPrefix, "linePrefix", 4, 4)(code4);
  }
  function onNotEnoughPrefix(code4) {
    return markdownLineEnding(code4) ? furtherStart2(code4) : nok(code4);
  }
}

var codeText = {
  name: "codeText",
  previous,
  resolve: resolveCodeText,
  tokenize: tokenizeCodeText
};
function resolveCodeText(events) {
  let tailExitIndex = events.length - 4;
  let headEnterIndex = 3;
  let index3;
  let enter;
  if ((events[headEnterIndex][1].type === "lineEnding" || events[headEnterIndex][1].type === "space") && (events[tailExitIndex][1].type === "lineEnding" || events[tailExitIndex][1].type === "space")) {
    index3 = headEnterIndex;
    while (++index3 < tailExitIndex) {
      if (events[index3][1].type === "codeTextData") {
        events[headEnterIndex][1].type = "codeTextPadding";
        events[tailExitIndex][1].type = "codeTextPadding";
        headEnterIndex += 2;
        tailExitIndex -= 2;
        break;
      }
    }
  }
  index3 = headEnterIndex - 1;
  tailExitIndex++;
  while (++index3 <= tailExitIndex) {
    if (enter === void 0) {
      if (index3 !== tailExitIndex && events[index3][1].type !== "lineEnding") {
        enter = index3;
      }
    } else if (index3 === tailExitIndex || events[index3][1].type === "lineEnding") {
      events[enter][1].type = "codeTextData";
      if (index3 !== enter + 2) {
        events[enter][1].end = events[index3 - 1][1].end;
        events.splice(enter + 2, index3 - enter - 2);
        tailExitIndex -= index3 - enter - 2;
        index3 = enter + 2;
      }
      enter = void 0;
    }
  }
  return events;
}
function previous(code4) {
  return code4 !== 96 || this.events[this.events.length - 1][1].type === "characterEscape";
}
function tokenizeCodeText(effects, ok3, nok) {
  const self2 = this;
  let sizeOpen = 0;
  let size;
  let token;
  return start2;
  function start2(code4) {
    effects.enter("codeText");
    effects.enter("codeTextSequence");
    return sequenceOpen(code4);
  }
  function sequenceOpen(code4) {
    if (code4 === 96) {
      effects.consume(code4);
      sizeOpen++;
      return sequenceOpen;
    }
    effects.exit("codeTextSequence");
    return between(code4);
  }
  function between(code4) {
    if (code4 === null) {
      return nok(code4);
    }
    if (code4 === 32) {
      effects.enter("space");
      effects.consume(code4);
      effects.exit("space");
      return between;
    }
    if (code4 === 96) {
      token = effects.enter("codeTextSequence");
      size = 0;
      return sequenceClose(code4);
    }
    if (markdownLineEnding(code4)) {
      effects.enter("lineEnding");
      effects.consume(code4);
      effects.exit("lineEnding");
      return between;
    }
    effects.enter("codeTextData");
    return data(code4);
  }
  function data(code4) {
    if (code4 === null || code4 === 32 || code4 === 96 || markdownLineEnding(code4)) {
      effects.exit("codeTextData");
      return between(code4);
    }
    effects.consume(code4);
    return data;
  }
  function sequenceClose(code4) {
    if (code4 === 96) {
      effects.consume(code4);
      size++;
      return sequenceClose;
    }
    if (size === sizeOpen) {
      effects.exit("codeTextSequence");
      effects.exit("codeText");
      return ok3(code4);
    }
    token.type = "codeTextData";
    return data(code4);
  }
}

var SpliceBuffer = class {
  /**
   * @param {ReadonlyArray<T> | null | undefined} [initial]
   *   Initial items (optional).
   * @returns
   *   Splice buffer.
   */
  constructor(initial) {
    this.left = initial ? [...initial] : [];
    this.right = [];
  }
  /**
   * Array access;
   * does not move the cursor.
   *
   * @param {number} index
   *   Index.
   * @return {T}
   *   Item.
   */
  get(index3) {
    if (index3 < 0 || index3 >= this.left.length + this.right.length) {
      throw new RangeError("Cannot access index `" + index3 + "` in a splice buffer of size `" + (this.left.length + this.right.length) + "`");
    }
    if (index3 < this.left.length) return this.left[index3];
    return this.right[this.right.length - index3 + this.left.length - 1];
  }
  /**
   * The length of the splice buffer, one greater than the largest index in the
   * array.
   */
  get length() {
    return this.left.length + this.right.length;
  }
  /**
   * Remove and return `list[0]`;
   * moves the cursor to `0`.
   *
   * @returns {T | undefined}
   *   Item, optional.
   */
  shift() {
    this.setCursor(0);
    return this.right.pop();
  }
  /**
   * Slice the buffer to get an array;
   * does not move the cursor.
   *
   * @param {number} start
   *   Start.
   * @param {number | null | undefined} [end]
   *   End (optional).
   * @returns {Array<T>}
   *   Array of items.
   */
  slice(start2, end) {
    const stop = end === null || end === void 0 ? Number.POSITIVE_INFINITY : end;
    if (stop < this.left.length) {
      return this.left.slice(start2, stop);
    }
    if (start2 > this.left.length) {
      return this.right.slice(this.right.length - stop + this.left.length, this.right.length - start2 + this.left.length).reverse();
    }
    return this.left.slice(start2).concat(this.right.slice(this.right.length - stop + this.left.length).reverse());
  }
  /**
   * Mimics the behavior of Array.prototype.splice() except for the change of
   * interface necessary to avoid segfaults when patching in very large arrays.
   *
   * This operation moves cursor is moved to `start` and results in the cursor
   * placed after any inserted items.
   *
   * @param {number} start
   *   Start;
   *   zero-based index at which to start changing the array;
   *   negative numbers count backwards from the end of the array and values
   *   that are out-of bounds are clamped to the appropriate end of the array.
   * @param {number | null | undefined} [deleteCount=0]
   *   Delete count (default: `0`);
   *   maximum number of elements to delete, starting from start.
   * @param {Array<T> | null | undefined} [items=[]]
   *   Items to include in place of the deleted items (default: `[]`).
   * @return {Array<T>}
   *   Any removed items.
   */
  splice(start2, deleteCount, items) {
    const count = deleteCount || 0;
    this.setCursor(Math.trunc(start2));
    const removed = this.right.splice(this.right.length - count, Number.POSITIVE_INFINITY);
    if (items) chunkedPush(this.left, items);
    return removed.reverse();
  }
  /**
   * Remove and return the highest-numbered item in the array, so
   * `list[list.length - 1]`;
   * Moves the cursor to `length`.
   *
   * @returns {T | undefined}
   *   Item, optional.
   */
  pop() {
    this.setCursor(Number.POSITIVE_INFINITY);
    return this.left.pop();
  }
  /**
   * Inserts a single item to the high-numbered side of the array;
   * moves the cursor to `length`.
   *
   * @param {T} item
   *   Item.
   * @returns {undefined}
   *   Nothing.
   */
  push(item) {
    this.setCursor(Number.POSITIVE_INFINITY);
    this.left.push(item);
  }
  /**
   * Inserts many items to the high-numbered side of the array.
   * Moves the cursor to `length`.
   *
   * @param {Array<T>} items
   *   Items.
   * @returns {undefined}
   *   Nothing.
   */
  pushMany(items) {
    this.setCursor(Number.POSITIVE_INFINITY);
    chunkedPush(this.left, items);
  }
  /**
   * Inserts a single item to the low-numbered side of the array;
   * Moves the cursor to `0`.
   *
   * @param {T} item
   *   Item.
   * @returns {undefined}
   *   Nothing.
   */
  unshift(item) {
    this.setCursor(0);
    this.right.push(item);
  }
  /**
   * Inserts many items to the low-numbered side of the array;
   * moves the cursor to `0`.
   *
   * @param {Array<T>} items
   *   Items.
   * @returns {undefined}
   *   Nothing.
   */
  unshiftMany(items) {
    this.setCursor(0);
    chunkedPush(this.right, items.reverse());
  }
  /**
   * Move the cursor to a specific position in the array. Requires
   * time proportional to the distance moved.
   *
   * If `n < 0`, the cursor will end up at the beginning.
   * If `n > length`, the cursor will end up at the end.
   *
   * @param {number} n
   *   Position.
   * @return {undefined}
   *   Nothing.
   */
  setCursor(n) {
    if (n === this.left.length || n > this.left.length && this.right.length === 0 || n < 0 && this.left.length === 0) return;
    if (n < this.left.length) {
      const removed = this.left.splice(n, Number.POSITIVE_INFINITY);
      chunkedPush(this.right, removed.reverse());
    } else {
      const removed = this.right.splice(this.left.length + this.right.length - n, Number.POSITIVE_INFINITY);
      chunkedPush(this.left, removed.reverse());
    }
  }
};
function chunkedPush(list4, right) {
  let chunkStart = 0;
  if (right.length < 1e4) {
    list4.push(...right);
  } else {
    while (chunkStart < right.length) {
      list4.push(...right.slice(chunkStart, chunkStart + 1e4));
      chunkStart += 1e4;
    }
  }
}

function subtokenize(eventsArray) {
  const jumps = {};
  let index3 = -1;
  let event;
  let lineIndex;
  let otherIndex;
  let otherEvent;
  let parameters;
  let subevents;
  let more;
  const events = new SpliceBuffer(eventsArray);
  while (++index3 < events.length) {
    while (index3 in jumps) {
      index3 = jumps[index3];
    }
    event = events.get(index3);
    if (index3 && event[1].type === "chunkFlow" && events.get(index3 - 1)[1].type === "listItemPrefix") {
      subevents = event[1]._tokenizer.events;
      otherIndex = 0;
      if (otherIndex < subevents.length && subevents[otherIndex][1].type === "lineEndingBlank") {
        otherIndex += 2;
      }
      if (otherIndex < subevents.length && subevents[otherIndex][1].type === "content") {
        while (++otherIndex < subevents.length) {
          if (subevents[otherIndex][1].type === "content") {
            break;
          }
          if (subevents[otherIndex][1].type === "chunkText") {
            subevents[otherIndex][1]._isInFirstContentOfListItem = true;
            otherIndex++;
          }
        }
      }
    }
    if (event[0] === "enter") {
      if (event[1].contentType) {
        Object.assign(jumps, subcontent(events, index3));
        index3 = jumps[index3];
        more = true;
      }
    } else if (event[1]._container) {
      otherIndex = index3;
      lineIndex = void 0;
      while (otherIndex--) {
        otherEvent = events.get(otherIndex);
        if (otherEvent[1].type === "lineEnding" || otherEvent[1].type === "lineEndingBlank") {
          if (otherEvent[0] === "enter") {
            if (lineIndex) {
              events.get(lineIndex)[1].type = "lineEndingBlank";
            }
            otherEvent[1].type = "lineEnding";
            lineIndex = otherIndex;
          }
        } else if (otherEvent[1].type === "linePrefix" || otherEvent[1].type === "listItemIndent") {
        } else {
          break;
        }
      }
      if (lineIndex) {
        event[1].end = {
          ...events.get(lineIndex)[1].start
        };
        parameters = events.slice(lineIndex, index3);
        parameters.unshift(event);
        events.splice(lineIndex, index3 - lineIndex + 1, parameters);
      }
    }
  }
  splice(eventsArray, 0, Number.POSITIVE_INFINITY, events.slice(0));
  return !more;
}
function subcontent(events, eventIndex) {
  const token = events.get(eventIndex)[1];
  const context = events.get(eventIndex)[2];
  let startPosition = eventIndex - 1;
  const startPositions = [];
  let tokenizer = token._tokenizer;
  if (!tokenizer) {
    tokenizer = context.parser[token.contentType](token.start);
    if (token._contentTypeTextTrailing) {
      tokenizer._contentTypeTextTrailing = true;
    }
  }
  const childEvents = tokenizer.events;
  const jumps = [];
  const gaps = {};
  let stream;
  let previous3;
  let index3 = -1;
  let current = token;
  let adjust = 0;
  let start2 = 0;
  const breaks = [start2];
  while (current) {
    while (events.get(++startPosition)[1] !== current) {
    }
    startPositions.push(startPosition);
    if (!current._tokenizer) {
      stream = context.sliceStream(current);
      if (!current.next) {
        stream.push(null);
      }
      if (previous3) {
        tokenizer.defineSkip(current.start);
      }
      if (current._isInFirstContentOfListItem) {
        tokenizer._gfmTasklistFirstContentOfListItem = true;
      }
      tokenizer.write(stream);
      if (current._isInFirstContentOfListItem) {
        tokenizer._gfmTasklistFirstContentOfListItem = void 0;
      }
    }
    previous3 = current;
    current = current.next;
  }
  current = token;
  while (++index3 < childEvents.length) {
    if (
      // Find a void token that includes a break.
      childEvents[index3][0] === "exit" && childEvents[index3 - 1][0] === "enter" && childEvents[index3][1].type === childEvents[index3 - 1][1].type && childEvents[index3][1].start.line !== childEvents[index3][1].end.line
    ) {
      start2 = index3 + 1;
      breaks.push(start2);
      current._tokenizer = void 0;
      current.previous = void 0;
      current = current.next;
    }
  }
  tokenizer.events = [];
  if (current) {
    current._tokenizer = void 0;
    current.previous = void 0;
  } else {
    breaks.pop();
  }
  index3 = breaks.length;
  while (index3--) {
    const slice = childEvents.slice(breaks[index3], breaks[index3 + 1]);
    const start3 = startPositions.pop();
    jumps.push([start3, start3 + slice.length - 1]);
    events.splice(start3, 2, slice);
  }
  jumps.reverse();
  index3 = -1;
  while (++index3 < jumps.length) {
    gaps[adjust + jumps[index3][0]] = adjust + jumps[index3][1];
    adjust += jumps[index3][1] - jumps[index3][0] - 1;
  }
  return gaps;
}

var content2 = {
  resolve: resolveContent,
  tokenize: tokenizeContent
};
var continuationConstruct = {
  partial: true,
  tokenize: tokenizeContinuation
};
function resolveContent(events) {
  subtokenize(events);
  return events;
}
function tokenizeContent(effects, ok3) {
  let previous3;
  return chunkStart;
  function chunkStart(code4) {
    effects.enter("content");
    previous3 = effects.enter("chunkContent", {
      contentType: "content"
    });
    return chunkInside(code4);
  }
  function chunkInside(code4) {
    if (code4 === null) {
      return contentEnd(code4);
    }
    if (markdownLineEnding(code4)) {
      return effects.check(continuationConstruct, contentContinue, contentEnd)(code4);
    }
    effects.consume(code4);
    return chunkInside;
  }
  function contentEnd(code4) {
    effects.exit("chunkContent");
    effects.exit("content");
    return ok3(code4);
  }
  function contentContinue(code4) {
    effects.consume(code4);
    effects.exit("chunkContent");
    previous3.next = effects.enter("chunkContent", {
      contentType: "content",
      previous: previous3
    });
    previous3 = previous3.next;
    return chunkInside;
  }
}
function tokenizeContinuation(effects, ok3, nok) {
  const self2 = this;
  return startLookahead;
  function startLookahead(code4) {
    effects.exit("chunkContent");
    effects.enter("lineEnding");
    effects.consume(code4);
    effects.exit("lineEnding");
    return factorySpace(effects, prefixed, "linePrefix");
  }
  function prefixed(code4) {
    if (code4 === null || markdownLineEnding(code4)) {
      return nok(code4);
    }
    const tail = self2.events[self2.events.length - 1];
    if (!self2.parser.constructs.disable.null.includes("codeIndented") && tail && tail[1].type === "linePrefix" && tail[2].sliceSerialize(tail[1], true).length >= 4) {
      return ok3(code4);
    }
    return effects.interrupt(self2.parser.constructs.flow, nok, ok3)(code4);
  }
}

function factoryDestination(effects, ok3, nok, type, literalType, literalMarkerType, rawType, stringType, max) {
  const limit = max || Number.POSITIVE_INFINITY;
  let balance = 0;
  return start2;
  function start2(code4) {
    if (code4 === 60) {
      effects.enter(type);
      effects.enter(literalType);
      effects.enter(literalMarkerType);
      effects.consume(code4);
      effects.exit(literalMarkerType);
      return enclosedBefore;
    }
    if (code4 === null || code4 === 32 || code4 === 41 || asciiControl(code4)) {
      return nok(code4);
    }
    effects.enter(type);
    effects.enter(rawType);
    effects.enter(stringType);
    effects.enter("chunkString", {
      contentType: "string"
    });
    return raw(code4);
  }
  function enclosedBefore(code4) {
    if (code4 === 62) {
      effects.enter(literalMarkerType);
      effects.consume(code4);
      effects.exit(literalMarkerType);
      effects.exit(literalType);
      effects.exit(type);
      return ok3;
    }
    effects.enter(stringType);
    effects.enter("chunkString", {
      contentType: "string"
    });
    return enclosed(code4);
  }
  function enclosed(code4) {
    if (code4 === 62) {
      effects.exit("chunkString");
      effects.exit(stringType);
      return enclosedBefore(code4);
    }
    if (code4 === null || code4 === 60 || markdownLineEnding(code4)) {
      return nok(code4);
    }
    effects.consume(code4);
    return code4 === 92 ? enclosedEscape : enclosed;
  }
  function enclosedEscape(code4) {
    if (code4 === 60 || code4 === 62 || code4 === 92) {
      effects.consume(code4);
      return enclosed;
    }
    return enclosed(code4);
  }
  function raw(code4) {
    if (!balance && (code4 === null || code4 === 41 || markdownLineEndingOrSpace(code4))) {
      effects.exit("chunkString");
      effects.exit(stringType);
      effects.exit(rawType);
      effects.exit(type);
      return ok3(code4);
    }
    if (balance < limit && code4 === 40) {
      effects.consume(code4);
      balance++;
      return raw;
    }
    if (code4 === 41) {
      effects.consume(code4);
      balance--;
      return raw;
    }
    if (code4 === null || code4 === 32 || code4 === 40 || asciiControl(code4)) {
      return nok(code4);
    }
    effects.consume(code4);
    return code4 === 92 ? rawEscape : raw;
  }
  function rawEscape(code4) {
    if (code4 === 40 || code4 === 41 || code4 === 92) {
      effects.consume(code4);
      return raw;
    }
    return raw(code4);
  }
}

function factoryLabel(effects, ok3, nok, type, markerType, stringType) {
  const self2 = this;
  let size = 0;
  let seen;
  return start2;
  function start2(code4) {
    effects.enter(type);
    effects.enter(markerType);
    effects.consume(code4);
    effects.exit(markerType);
    effects.enter(stringType);
    return atBreak;
  }
  function atBreak(code4) {
    if (size > 999 || code4 === null || code4 === 91 || code4 === 93 && !seen || // To do: remove in the future once we’ve switched from
    // `micromark-extension-footnote` to `micromark-extension-gfm-footnote`,
    // which doesn’t need this.
    // Hidden footnotes hook.
    /* c8 ignore next 3 */
    code4 === 94 && !size && "_hiddenFootnoteSupport" in self2.parser.constructs) {
      return nok(code4);
    }
    if (code4 === 93) {
      effects.exit(stringType);
      effects.enter(markerType);
      effects.consume(code4);
      effects.exit(markerType);
      effects.exit(type);
      return ok3;
    }
    if (markdownLineEnding(code4)) {
      effects.enter("lineEnding");
      effects.consume(code4);
      effects.exit("lineEnding");
      return atBreak;
    }
    effects.enter("chunkString", {
      contentType: "string"
    });
    return labelInside(code4);
  }
  function labelInside(code4) {
    if (code4 === null || code4 === 91 || code4 === 93 || markdownLineEnding(code4) || size++ > 999) {
      effects.exit("chunkString");
      return atBreak(code4);
    }
    effects.consume(code4);
    if (!seen) seen = !markdownSpace(code4);
    return code4 === 92 ? labelEscape : labelInside;
  }
  function labelEscape(code4) {
    if (code4 === 91 || code4 === 92 || code4 === 93) {
      effects.consume(code4);
      size++;
      return labelInside;
    }
    return labelInside(code4);
  }
}

function factoryTitle(effects, ok3, nok, type, markerType, stringType) {
  let marker;
  return start2;
  function start2(code4) {
    if (code4 === 34 || code4 === 39 || code4 === 40) {
      effects.enter(type);
      effects.enter(markerType);
      effects.consume(code4);
      effects.exit(markerType);
      marker = code4 === 40 ? 41 : code4;
      return begin;
    }
    return nok(code4);
  }
  function begin(code4) {
    if (code4 === marker) {
      effects.enter(markerType);
      effects.consume(code4);
      effects.exit(markerType);
      effects.exit(type);
      return ok3;
    }
    effects.enter(stringType);
    return atBreak(code4);
  }
  function atBreak(code4) {
    if (code4 === marker) {
      effects.exit(stringType);
      return begin(marker);
    }
    if (code4 === null) {
      return nok(code4);
    }
    if (markdownLineEnding(code4)) {
      effects.enter("lineEnding");
      effects.consume(code4);
      effects.exit("lineEnding");
      return factorySpace(effects, atBreak, "linePrefix");
    }
    effects.enter("chunkString", {
      contentType: "string"
    });
    return inside(code4);
  }
  function inside(code4) {
    if (code4 === marker || code4 === null || markdownLineEnding(code4)) {
      effects.exit("chunkString");
      return atBreak(code4);
    }
    effects.consume(code4);
    return code4 === 92 ? escape : inside;
  }
  function escape(code4) {
    if (code4 === marker || code4 === 92) {
      effects.consume(code4);
      return inside;
    }
    return inside(code4);
  }
}

function factoryWhitespace(effects, ok3) {
  let seen;
  return start2;
  function start2(code4) {
    if (markdownLineEnding(code4)) {
      effects.enter("lineEnding");
      effects.consume(code4);
      effects.exit("lineEnding");
      seen = true;
      return start2;
    }
    if (markdownSpace(code4)) {
      return factorySpace(effects, start2, seen ? "linePrefix" : "lineSuffix")(code4);
    }
    return ok3(code4);
  }
}

var definition = {
  name: "definition",
  tokenize: tokenizeDefinition
};
var titleBefore = {
  partial: true,
  tokenize: tokenizeTitleBefore
};
function tokenizeDefinition(effects, ok3, nok) {
  const self2 = this;
  let identifier;
  return start2;
  function start2(code4) {
    effects.enter("definition");
    return before(code4);
  }
  function before(code4) {
    return factoryLabel.call(
      self2,
      effects,
      labelAfter,
      // Note: we don’t need to reset the way `markdown-rs` does.
      nok,
      "definitionLabel",
      "definitionLabelMarker",
      "definitionLabelString"
    )(code4);
  }
  function labelAfter(code4) {
    identifier = normalizeIdentifier(self2.sliceSerialize(self2.events[self2.events.length - 1][1]).slice(1, -1));
    if (code4 === 58) {
      effects.enter("definitionMarker");
      effects.consume(code4);
      effects.exit("definitionMarker");
      return markerAfter;
    }
    return nok(code4);
  }
  function markerAfter(code4) {
    return markdownLineEndingOrSpace(code4) ? factoryWhitespace(effects, destinationBefore)(code4) : destinationBefore(code4);
  }
  function destinationBefore(code4) {
    return factoryDestination(
      effects,
      destinationAfter,
      // Note: we don’t need to reset the way `markdown-rs` does.
      nok,
      "definitionDestination",
      "definitionDestinationLiteral",
      "definitionDestinationLiteralMarker",
      "definitionDestinationRaw",
      "definitionDestinationString"
    )(code4);
  }
  function destinationAfter(code4) {
    return effects.attempt(titleBefore, after, after)(code4);
  }
  function after(code4) {
    return markdownSpace(code4) ? factorySpace(effects, afterWhitespace, "whitespace")(code4) : afterWhitespace(code4);
  }
  function afterWhitespace(code4) {
    if (code4 === null || markdownLineEnding(code4)) {
      effects.exit("definition");
      self2.parser.defined.push(identifier);
      return ok3(code4);
    }
    return nok(code4);
  }
}
function tokenizeTitleBefore(effects, ok3, nok) {
  return titleBefore2;
  function titleBefore2(code4) {
    return markdownLineEndingOrSpace(code4) ? factoryWhitespace(effects, beforeMarker)(code4) : nok(code4);
  }
  function beforeMarker(code4) {
    return factoryTitle(effects, titleAfter, nok, "definitionTitle", "definitionTitleMarker", "definitionTitleString")(code4);
  }
  function titleAfter(code4) {
    return markdownSpace(code4) ? factorySpace(effects, titleAfterOptionalWhitespace, "whitespace")(code4) : titleAfterOptionalWhitespace(code4);
  }
  function titleAfterOptionalWhitespace(code4) {
    return code4 === null || markdownLineEnding(code4) ? ok3(code4) : nok(code4);
  }
}

var hardBreakEscape = {
  name: "hardBreakEscape",
  tokenize: tokenizeHardBreakEscape
};
function tokenizeHardBreakEscape(effects, ok3, nok) {
  return start2;
  function start2(code4) {
    effects.enter("hardBreakEscape");
    effects.consume(code4);
    return after;
  }
  function after(code4) {
    if (markdownLineEnding(code4)) {
      effects.exit("hardBreakEscape");
      return ok3(code4);
    }
    return nok(code4);
  }
}

var headingAtx = {
  name: "headingAtx",
  resolve: resolveHeadingAtx,
  tokenize: tokenizeHeadingAtx
};
function resolveHeadingAtx(events, context) {
  let contentEnd = events.length - 2;
  let contentStart = 3;
  if (events[contentStart][1].type === "whitespace") {
    contentStart += 2;
  }
  if (contentEnd - 2 > contentStart && events[contentEnd][1].type === "whitespace") {
    contentEnd -= 2;
  }
  if (events[contentEnd][1].type === "atxHeadingSequence" && (contentStart === contentEnd - 1 || contentEnd - 4 > contentStart && events[contentEnd - 2][1].type === "whitespace")) {
    contentEnd -= contentStart + 1 === contentEnd ? 2 : 4;
  }
  if (contentEnd > contentStart) {
    const content3 = {
      type: "atxHeadingText",
      start: events[contentStart][1].start,
      end: events[contentEnd][1].end
    };
    const text7 = {
      type: "chunkText",
      start: events[contentStart][1].start,
      end: events[contentEnd][1].end,
      contentType: "text"
    };
    splice(events, contentStart, contentEnd - contentStart + 1, [["enter", content3, context], ["enter", text7, context], ["exit", text7, context], ["exit", content3, context]]);
  }
  return events;
}
function tokenizeHeadingAtx(effects, ok3, nok) {
  let size = 0;
  return start2;
  function start2(code4) {
    effects.enter("atxHeading");
    return before(code4);
  }
  function before(code4) {
    effects.enter("atxHeadingSequence");
    return sequenceOpen(code4);
  }
  function sequenceOpen(code4) {
    if (code4 === 35 && size++ < 6) {
      effects.consume(code4);
      return sequenceOpen;
    }
    if (code4 === null || markdownLineEndingOrSpace(code4)) {
      effects.exit("atxHeadingSequence");
      return atBreak(code4);
    }
    return nok(code4);
  }
  function atBreak(code4) {
    if (code4 === 35) {
      effects.enter("atxHeadingSequence");
      return sequenceFurther(code4);
    }
    if (code4 === null || markdownLineEnding(code4)) {
      effects.exit("atxHeading");
      return ok3(code4);
    }
    if (markdownSpace(code4)) {
      return factorySpace(effects, atBreak, "whitespace")(code4);
    }
    effects.enter("atxHeadingText");
    return data(code4);
  }
  function sequenceFurther(code4) {
    if (code4 === 35) {
      effects.consume(code4);
      return sequenceFurther;
    }
    effects.exit("atxHeadingSequence");
    return atBreak(code4);
  }
  function data(code4) {
    if (code4 === null || code4 === 35 || markdownLineEndingOrSpace(code4)) {
      effects.exit("atxHeadingText");
      return atBreak(code4);
    }
    effects.consume(code4);
    return data;
  }
}

var htmlBlockNames = [
  "address",
  "article",
  "aside",
  "base",
  "basefont",
  "blockquote",
  "body",
  "caption",
  "center",
  "col",
  "colgroup",
  "dd",
  "details",
  "dialog",
  "dir",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "frame",
  "frameset",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "header",
  "hr",
  "html",
  "iframe",
  "legend",
  "li",
  "link",
  "main",
  "menu",
  "menuitem",
  "nav",
  "noframes",
  "ol",
  "optgroup",
  "option",
  "p",
  "param",
  "search",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "title",
  "tr",
  "track",
  "ul"
];
var htmlRawNames = ["pre", "script", "style", "textarea"];

var htmlFlow = {
  concrete: true,
  name: "htmlFlow",
  resolveTo: resolveToHtmlFlow,
  tokenize: tokenizeHtmlFlow
};
var blankLineBefore = {
  partial: true,
  tokenize: tokenizeBlankLineBefore
};
function resolveToHtmlFlow(events) {
  let index3 = events.length;
  while (index3--) {
    if (events[index3][0] === "enter" && events[index3][1].type === "htmlFlow") {
      break;
    }
  }
  if (index3 > 1 && events[index3 - 2][1].type === "linePrefix") {
    events[index3][1].start = events[index3 - 2][1].start;
    events[index3 + 1][1].start = events[index3 - 2][1].start;
    events.splice(index3 - 2, 2);
  }
  return events;
}
function tokenizeHtmlFlow(effects, ok3, nok) {
  const self2 = this;
  let marker;
  let closingTag;
  let buffer;
  let index3;
  let markerB;
  return start2;
  function start2(code4) {
    return before(code4);
  }
  function before(code4) {
    effects.enter("htmlFlow");
    effects.enter("htmlFlowData");
    effects.consume(code4);
    return open;
  }
  function open(code4) {
    if (code4 === 33) {
      effects.consume(code4);
      return declarationOpen;
    }
    if (code4 === 47) {
      effects.consume(code4);
      closingTag = true;
      return tagCloseStart;
    }
    if (code4 === 63) {
      effects.consume(code4);
      marker = 3;
      return self2.interrupt ? ok3 : continuationDeclarationInside;
    }
    if (asciiAlpha(code4)) {
      effects.consume(code4);
      buffer = String.fromCharCode(code4);
      return tagName;
    }
    return nok(code4);
  }
  function declarationOpen(code4) {
    if (code4 === 45) {
      effects.consume(code4);
      marker = 2;
      return commentOpenInside;
    }
    if (code4 === 91) {
      effects.consume(code4);
      marker = 5;
      index3 = 0;
      return cdataOpenInside;
    }
    if (asciiAlpha(code4)) {
      effects.consume(code4);
      marker = 4;
      return self2.interrupt ? ok3 : continuationDeclarationInside;
    }
    return nok(code4);
  }
  function commentOpenInside(code4) {
    if (code4 === 45) {
      effects.consume(code4);
      return self2.interrupt ? ok3 : continuationDeclarationInside;
    }
    return nok(code4);
  }
  function cdataOpenInside(code4) {
    const value = "CDATA[";
    if (code4 === value.charCodeAt(index3++)) {
      effects.consume(code4);
      if (index3 === value.length) {
        return self2.interrupt ? ok3 : continuation;
      }
      return cdataOpenInside;
    }
    return nok(code4);
  }
  function tagCloseStart(code4) {
    if (asciiAlpha(code4)) {
      effects.consume(code4);
      buffer = String.fromCharCode(code4);
      return tagName;
    }
    return nok(code4);
  }
  function tagName(code4) {
    if (code4 === null || code4 === 47 || code4 === 62 || markdownLineEndingOrSpace(code4)) {
      const slash = code4 === 47;
      const name2 = buffer.toLowerCase();
      if (!slash && !closingTag && htmlRawNames.includes(name2)) {
        marker = 1;
        return self2.interrupt ? ok3(code4) : continuation(code4);
      }
      if (htmlBlockNames.includes(buffer.toLowerCase())) {
        marker = 6;
        if (slash) {
          effects.consume(code4);
          return basicSelfClosing;
        }
        return self2.interrupt ? ok3(code4) : continuation(code4);
      }
      marker = 7;
      return self2.interrupt && !self2.parser.lazy[self2.now().line] ? nok(code4) : closingTag ? completeClosingTagAfter(code4) : completeAttributeNameBefore(code4);
    }
    if (code4 === 45 || asciiAlphanumeric(code4)) {
      effects.consume(code4);
      buffer += String.fromCharCode(code4);
      return tagName;
    }
    return nok(code4);
  }
  function basicSelfClosing(code4) {
    if (code4 === 62) {
      effects.consume(code4);
      return self2.interrupt ? ok3 : continuation;
    }
    return nok(code4);
  }
  function completeClosingTagAfter(code4) {
    if (markdownSpace(code4)) {
      effects.consume(code4);
      return completeClosingTagAfter;
    }
    return completeEnd(code4);
  }
  function completeAttributeNameBefore(code4) {
    if (code4 === 47) {
      effects.consume(code4);
      return completeEnd;
    }
    if (code4 === 58 || code4 === 95 || asciiAlpha(code4)) {
      effects.consume(code4);
      return completeAttributeName;
    }
    if (markdownSpace(code4)) {
      effects.consume(code4);
      return completeAttributeNameBefore;
    }
    return completeEnd(code4);
  }
  function completeAttributeName(code4) {
    if (code4 === 45 || code4 === 46 || code4 === 58 || code4 === 95 || asciiAlphanumeric(code4)) {
      effects.consume(code4);
      return completeAttributeName;
    }
    return completeAttributeNameAfter(code4);
  }
  function completeAttributeNameAfter(code4) {
    if (code4 === 61) {
      effects.consume(code4);
      return completeAttributeValueBefore;
    }
    if (markdownSpace(code4)) {
      effects.consume(code4);
      return completeAttributeNameAfter;
    }
    return completeAttributeNameBefore(code4);
  }
  function completeAttributeValueBefore(code4) {
    if (code4 === null || code4 === 60 || code4 === 61 || code4 === 62 || code4 === 96) {
      return nok(code4);
    }
    if (code4 === 34 || code4 === 39) {
      effects.consume(code4);
      markerB = code4;
      return completeAttributeValueQuoted;
    }
    if (markdownSpace(code4)) {
      effects.consume(code4);
      return completeAttributeValueBefore;
    }
    return completeAttributeValueUnquoted(code4);
  }
  function completeAttributeValueQuoted(code4) {
    if (code4 === markerB) {
      effects.consume(code4);
      markerB = null;
      return completeAttributeValueQuotedAfter;
    }
    if (code4 === null || markdownLineEnding(code4)) {
      return nok(code4);
    }
    effects.consume(code4);
    return completeAttributeValueQuoted;
  }
  function completeAttributeValueUnquoted(code4) {
    if (code4 === null || code4 === 34 || code4 === 39 || code4 === 47 || code4 === 60 || code4 === 61 || code4 === 62 || code4 === 96 || markdownLineEndingOrSpace(code4)) {
      return completeAttributeNameAfter(code4);
    }
    effects.consume(code4);
    return completeAttributeValueUnquoted;
  }
  function completeAttributeValueQuotedAfter(code4) {
    if (code4 === 47 || code4 === 62 || markdownSpace(code4)) {
      return completeAttributeNameBefore(code4);
    }
    return nok(code4);
  }
  function completeEnd(code4) {
    if (code4 === 62) {
      effects.consume(code4);
      return completeAfter;
    }
    return nok(code4);
  }
  function completeAfter(code4) {
    if (code4 === null || markdownLineEnding(code4)) {
      return continuation(code4);
    }
    if (markdownSpace(code4)) {
      effects.consume(code4);
      return completeAfter;
    }
    return nok(code4);
  }
  function continuation(code4) {
    if (code4 === 45 && marker === 2) {
      effects.consume(code4);
      return continuationCommentInside;
    }
    if (code4 === 60 && marker === 1) {
      effects.consume(code4);
      return continuationRawTagOpen;
    }
    if (code4 === 62 && marker === 4) {
      effects.consume(code4);
      return continuationClose;
    }
    if (code4 === 63 && marker === 3) {
      effects.consume(code4);
      return continuationDeclarationInside;
    }
    if (code4 === 93 && marker === 5) {
      effects.consume(code4);
      return continuationCdataInside;
    }
    if (markdownLineEnding(code4) && (marker === 6 || marker === 7)) {
      effects.exit("htmlFlowData");
      return effects.check(blankLineBefore, continuationAfter, continuationStart)(code4);
    }
    if (code4 === null || markdownLineEnding(code4)) {
      effects.exit("htmlFlowData");
      return continuationStart(code4);
    }
    effects.consume(code4);
    return continuation;
  }
  function continuationStart(code4) {
    return effects.check(nonLazyContinuation, continuationStartNonLazy, continuationAfter)(code4);
  }
  function continuationStartNonLazy(code4) {
    effects.enter("lineEnding");
    effects.consume(code4);
    effects.exit("lineEnding");
    return continuationBefore;
  }
  function continuationBefore(code4) {
    if (code4 === null || markdownLineEnding(code4)) {
      return continuationStart(code4);
    }
    effects.enter("htmlFlowData");
    return continuation(code4);
  }
  function continuationCommentInside(code4) {
    if (code4 === 45) {
      effects.consume(code4);
      return continuationDeclarationInside;
    }
    return continuation(code4);
  }
  function continuationRawTagOpen(code4) {
    if (code4 === 47) {
      effects.consume(code4);
      buffer = "";
      return continuationRawEndTag;
    }
    return continuation(code4);
  }
  function continuationRawEndTag(code4) {
    if (code4 === 62) {
      const name2 = buffer.toLowerCase();
      if (htmlRawNames.includes(name2)) {
        effects.consume(code4);
        return continuationClose;
      }
      return continuation(code4);
    }
    if (asciiAlpha(code4) && buffer.length < 8) {
      effects.consume(code4);
      buffer += String.fromCharCode(code4);
      return continuationRawEndTag;
    }
    return continuation(code4);
  }
  function continuationCdataInside(code4) {
    if (code4 === 93) {
      effects.consume(code4);
      return continuationDeclarationInside;
    }
    return continuation(code4);
  }
  function continuationDeclarationInside(code4) {
    if (code4 === 62) {
      effects.consume(code4);
      return continuationClose;
    }
    if (code4 === 45 && marker === 2) {
      effects.consume(code4);
      return continuationDeclarationInside;
    }
    return continuation(code4);
  }
  function continuationClose(code4) {
    if (code4 === null || markdownLineEnding(code4)) {
      effects.exit("htmlFlowData");
      return continuationAfter(code4);
    }
    effects.consume(code4);
    return continuationClose;
  }
  function continuationAfter(code4) {
    effects.exit("htmlFlow");
    return ok3(code4);
  }
}
function tokenizeBlankLineBefore(effects, ok3, nok) {
  return start2;
  function start2(code4) {
    effects.enter("lineEnding");
    effects.consume(code4);
    effects.exit("lineEnding");
    return effects.attempt(blankLine, ok3, nok);
  }
}

var htmlText = {
  name: "htmlText",
  tokenize: tokenizeHtmlText
};
function tokenizeHtmlText(effects, ok3, nok) {
  const self2 = this;
  let marker;
  let index3;
  let returnState;
  return start2;
  function start2(code4) {
    effects.enter("htmlText");
    effects.enter("htmlTextData");
    effects.consume(code4);
    return open;
  }
  function open(code4) {
    if (code4 === 33) {
      effects.consume(code4);
      return declarationOpen;
    }
    if (code4 === 47) {
      effects.consume(code4);
      return tagCloseStart;
    }
    if (code4 === 63) {
      effects.consume(code4);
      return instruction;
    }
    if (asciiAlpha(code4)) {
      effects.consume(code4);
      return tagOpen;
    }
    return nok(code4);
  }
  function declarationOpen(code4) {
    if (code4 === 45) {
      effects.consume(code4);
      return commentOpenInside;
    }
    if (code4 === 91) {
      effects.consume(code4);
      index3 = 0;
      return cdataOpenInside;
    }
    if (asciiAlpha(code4)) {
      effects.consume(code4);
      return declaration;
    }
    return nok(code4);
  }
  function commentOpenInside(code4) {
    if (code4 === 45) {
      effects.consume(code4);
      return commentEnd;
    }
    return nok(code4);
  }
  function comment(code4) {
    if (code4 === null) {
      return nok(code4);
    }
    if (code4 === 45) {
      effects.consume(code4);
      return commentClose;
    }
    if (markdownLineEnding(code4)) {
      returnState = comment;
      return lineEndingBefore(code4);
    }
    effects.consume(code4);
    return comment;
  }
  function commentClose(code4) {
    if (code4 === 45) {
      effects.consume(code4);
      return commentEnd;
    }
    return comment(code4);
  }
  function commentEnd(code4) {
    return code4 === 62 ? end(code4) : code4 === 45 ? commentClose(code4) : comment(code4);
  }
  function cdataOpenInside(code4) {
    const value = "CDATA[";
    if (code4 === value.charCodeAt(index3++)) {
      effects.consume(code4);
      return index3 === value.length ? cdata : cdataOpenInside;
    }
    return nok(code4);
  }
  function cdata(code4) {
    if (code4 === null) {
      return nok(code4);
    }
    if (code4 === 93) {
      effects.consume(code4);
      return cdataClose;
    }
    if (markdownLineEnding(code4)) {
      returnState = cdata;
      return lineEndingBefore(code4);
    }
    effects.consume(code4);
    return cdata;
  }
  function cdataClose(code4) {
    if (code4 === 93) {
      effects.consume(code4);
      return cdataEnd;
    }
    return cdata(code4);
  }
  function cdataEnd(code4) {
    if (code4 === 62) {
      return end(code4);
    }
    if (code4 === 93) {
      effects.consume(code4);
      return cdataEnd;
    }
    return cdata(code4);
  }
  function declaration(code4) {
    if (code4 === null || code4 === 62) {
      return end(code4);
    }
    if (markdownLineEnding(code4)) {
      returnState = declaration;
      return lineEndingBefore(code4);
    }
    effects.consume(code4);
    return declaration;
  }
  function instruction(code4) {
    if (code4 === null) {
      return nok(code4);
    }
    if (code4 === 63) {
      effects.consume(code4);
      return instructionClose;
    }
    if (markdownLineEnding(code4)) {
      returnState = instruction;
      return lineEndingBefore(code4);
    }
    effects.consume(code4);
    return instruction;
  }
  function instructionClose(code4) {
    return code4 === 62 ? end(code4) : instruction(code4);
  }
  function tagCloseStart(code4) {
    if (asciiAlpha(code4)) {
      effects.consume(code4);
      return tagClose;
    }
    return nok(code4);
  }
  function tagClose(code4) {
    if (code4 === 45 || asciiAlphanumeric(code4)) {
      effects.consume(code4);
      return tagClose;
    }
    return tagCloseBetween(code4);
  }
  function tagCloseBetween(code4) {
    if (markdownLineEnding(code4)) {
      returnState = tagCloseBetween;
      return lineEndingBefore(code4);
    }
    if (markdownSpace(code4)) {
      effects.consume(code4);
      return tagCloseBetween;
    }
    return end(code4);
  }
  function tagOpen(code4) {
    if (code4 === 45 || asciiAlphanumeric(code4)) {
      effects.consume(code4);
      return tagOpen;
    }
    if (code4 === 47 || code4 === 62 || markdownLineEndingOrSpace(code4)) {
      return tagOpenBetween(code4);
    }
    return nok(code4);
  }
  function tagOpenBetween(code4) {
    if (code4 === 47) {
      effects.consume(code4);
      return end;
    }
    if (code4 === 58 || code4 === 95 || asciiAlpha(code4)) {
      effects.consume(code4);
      return tagOpenAttributeName;
    }
    if (markdownLineEnding(code4)) {
      returnState = tagOpenBetween;
      return lineEndingBefore(code4);
    }
    if (markdownSpace(code4)) {
      effects.consume(code4);
      return tagOpenBetween;
    }
    return end(code4);
  }
  function tagOpenAttributeName(code4) {
    if (code4 === 45 || code4 === 46 || code4 === 58 || code4 === 95 || asciiAlphanumeric(code4)) {
      effects.consume(code4);
      return tagOpenAttributeName;
    }
    return tagOpenAttributeNameAfter(code4);
  }
  function tagOpenAttributeNameAfter(code4) {
    if (code4 === 61) {
      effects.consume(code4);
      return tagOpenAttributeValueBefore;
    }
    if (markdownLineEnding(code4)) {
      returnState = tagOpenAttributeNameAfter;
      return lineEndingBefore(code4);
    }
    if (markdownSpace(code4)) {
      effects.consume(code4);
      return tagOpenAttributeNameAfter;
    }
    return tagOpenBetween(code4);
  }
  function tagOpenAttributeValueBefore(code4) {
    if (code4 === null || code4 === 60 || code4 === 61 || code4 === 62 || code4 === 96) {
      return nok(code4);
    }
    if (code4 === 34 || code4 === 39) {
      effects.consume(code4);
      marker = code4;
      return tagOpenAttributeValueQuoted;
    }
    if (markdownLineEnding(code4)) {
      returnState = tagOpenAttributeValueBefore;
      return lineEndingBefore(code4);
    }
    if (markdownSpace(code4)) {
      effects.consume(code4);
      return tagOpenAttributeValueBefore;
    }
    effects.consume(code4);
    return tagOpenAttributeValueUnquoted;
  }
  function tagOpenAttributeValueQuoted(code4) {
    if (code4 === marker) {
      effects.consume(code4);
      marker = void 0;
      return tagOpenAttributeValueQuotedAfter;
    }
    if (code4 === null) {
      return nok(code4);
    }
    if (markdownLineEnding(code4)) {
      returnState = tagOpenAttributeValueQuoted;
      return lineEndingBefore(code4);
    }
    effects.consume(code4);
    return tagOpenAttributeValueQuoted;
  }
  function tagOpenAttributeValueUnquoted(code4) {
    if (code4 === null || code4 === 34 || code4 === 39 || code4 === 60 || code4 === 61 || code4 === 96) {
      return nok(code4);
    }
    if (code4 === 47 || code4 === 62 || markdownLineEndingOrSpace(code4)) {
      return tagOpenBetween(code4);
    }
    effects.consume(code4);
    return tagOpenAttributeValueUnquoted;
  }
  function tagOpenAttributeValueQuotedAfter(code4) {
    if (code4 === 47 || code4 === 62 || markdownLineEndingOrSpace(code4)) {
      return tagOpenBetween(code4);
    }
    return nok(code4);
  }
  function end(code4) {
    if (code4 === 62) {
      effects.consume(code4);
      effects.exit("htmlTextData");
      effects.exit("htmlText");
      return ok3;
    }
    return nok(code4);
  }
  function lineEndingBefore(code4) {
    effects.exit("htmlTextData");
    effects.enter("lineEnding");
    effects.consume(code4);
    effects.exit("lineEnding");
    return lineEndingAfter;
  }
  function lineEndingAfter(code4) {
    return markdownSpace(code4) ? factorySpace(effects, lineEndingAfterPrefix, "linePrefix", self2.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4)(code4) : lineEndingAfterPrefix(code4);
  }
  function lineEndingAfterPrefix(code4) {
    effects.enter("htmlTextData");
    return returnState(code4);
  }
}

var labelEnd = {
  name: "labelEnd",
  resolveAll: resolveAllLabelEnd,
  resolveTo: resolveToLabelEnd,
  tokenize: tokenizeLabelEnd
};
var resourceConstruct = {
  tokenize: tokenizeResource
};
var referenceFullConstruct = {
  tokenize: tokenizeReferenceFull
};
var referenceCollapsedConstruct = {
  tokenize: tokenizeReferenceCollapsed
};
function resolveAllLabelEnd(events) {
  let index3 = -1;
  const newEvents = [];
  while (++index3 < events.length) {
    const token = events[index3][1];
    newEvents.push(events[index3]);
    if (token.type === "labelImage" || token.type === "labelLink" || token.type === "labelEnd") {
      const offset = token.type === "labelImage" ? 4 : 2;
      token.type = "data";
      index3 += offset;
    }
  }
  if (events.length !== newEvents.length) {
    splice(events, 0, events.length, newEvents);
  }
  return events;
}
function resolveToLabelEnd(events, context) {
  let index3 = events.length;
  let offset = 0;
  let open;
  let close;
  let media;
  while (index3--) {
    const token = events[index3][1];
    if (open) {
      if (token.type === "link" || token.type === "labelLink" && token._inactive) {
        break;
      }
      if (events[index3][0] === "enter" && token.type === "labelLink") {
        token._inactive = true;
      }
    } else if (close) {
      if (events[index3][0] === "enter" && (token.type === "labelImage" || token.type === "labelLink") && !token._balanced) {
        open = index3;
        if (token.type !== "labelLink") {
          offset = 2;
          break;
        }
      }
    } else if (token.type === "labelEnd") {
      close = index3;
    }
  }
  const group = {
    type: events[open][1].type === "labelLink" ? "link" : "image",
    start: {
      ...events[open][1].start
    },
    end: {
      ...events[events.length - 1][1].end
    }
  };
  const label = {
    type: "label",
    start: {
      ...events[open][1].start
    },
    end: {
      ...events[close][1].end
    }
  };
  const text7 = {
    type: "labelText",
    start: {
      ...events[open + offset + 2][1].end
    },
    end: {
      ...events[close - 2][1].start
    }
  };
  media = [["enter", group, context], ["enter", label, context]];
  media = push(media, events.slice(open + 1, open + offset + 3));
  media = push(media, [["enter", text7, context]]);
  media = push(media, resolveAll(context.parser.constructs.insideSpan.null, events.slice(open + offset + 4, close - 3), context));
  media = push(media, [["exit", text7, context], events[close - 2], events[close - 1], ["exit", label, context]]);
  media = push(media, events.slice(close + 1));
  media = push(media, [["exit", group, context]]);
  splice(events, open, events.length, media);
  return events;
}
function tokenizeLabelEnd(effects, ok3, nok) {
  const self2 = this;
  const labelStarts = self2._labelStarts;
  let labelStart;
  let defined;
  if (labelStarts) {
    while (labelStarts.length > 0 && labelStarts[labelStarts.length - 1]._balanced) {
      labelStarts.pop();
    }
    labelStart = labelStarts[labelStarts.length - 1];
  }
  return start2;
  function start2(code4) {
    if (!labelStart) {
      return nok(code4);
    }
    if (labelStart._inactive) {
      return labelEndNok(code4);
    }
    defined = self2.parser.defined.includes(normalizeIdentifier(self2.sliceSerialize({
      start: labelStart.end,
      end: self2.now()
    })));
    effects.enter("labelEnd");
    effects.enter("labelMarker");
    effects.consume(code4);
    effects.exit("labelMarker");
    effects.exit("labelEnd");
    return after;
  }
  function after(code4) {
    if (code4 === 40) {
      return effects.attempt(resourceConstruct, labelEndOk, defined ? labelEndOk : labelEndNok)(code4);
    }
    if (code4 === 91) {
      return effects.attempt(referenceFullConstruct, labelEndOk, defined ? referenceNotFull : labelEndNok)(code4);
    }
    return defined ? labelEndOk(code4) : labelEndNok(code4);
  }
  function referenceNotFull(code4) {
    return effects.attempt(referenceCollapsedConstruct, labelEndOk, labelEndNok)(code4);
  }
  function labelEndOk(code4) {
    labelStarts.pop();
    return ok3(code4);
  }
  function labelEndNok(code4) {
    labelStart._balanced = true;
    return nok(code4);
  }
}
function tokenizeResource(effects, ok3, nok) {
  return resourceStart;
  function resourceStart(code4) {
    effects.enter("resource");
    effects.enter("resourceMarker");
    effects.consume(code4);
    effects.exit("resourceMarker");
    return resourceBefore;
  }
  function resourceBefore(code4) {
    return markdownLineEndingOrSpace(code4) ? factoryWhitespace(effects, resourceOpen)(code4) : resourceOpen(code4);
  }
  function resourceOpen(code4) {
    if (code4 === 41) {
      return resourceEnd(code4);
    }
    return factoryDestination(effects, resourceDestinationAfter, resourceDestinationMissing, "resourceDestination", "resourceDestinationLiteral", "resourceDestinationLiteralMarker", "resourceDestinationRaw", "resourceDestinationString", 32)(code4);
  }
  function resourceDestinationAfter(code4) {
    return markdownLineEndingOrSpace(code4) ? factoryWhitespace(effects, resourceBetween)(code4) : resourceEnd(code4);
  }
  function resourceDestinationMissing(code4) {
    return nok(code4);
  }
  function resourceBetween(code4) {
    if (code4 === 34 || code4 === 39 || code4 === 40) {
      return factoryTitle(effects, resourceTitleAfter, nok, "resourceTitle", "resourceTitleMarker", "resourceTitleString")(code4);
    }
    return resourceEnd(code4);
  }
  function resourceTitleAfter(code4) {
    return markdownLineEndingOrSpace(code4) ? factoryWhitespace(effects, resourceEnd)(code4) : resourceEnd(code4);
  }
  function resourceEnd(code4) {
    if (code4 === 41) {
      effects.enter("resourceMarker");
      effects.consume(code4);
      effects.exit("resourceMarker");
      effects.exit("resource");
      return ok3;
    }
    return nok(code4);
  }
}
function tokenizeReferenceFull(effects, ok3, nok) {
  const self2 = this;
  return referenceFull;
  function referenceFull(code4) {
    return factoryLabel.call(self2, effects, referenceFullAfter, referenceFullMissing, "reference", "referenceMarker", "referenceString")(code4);
  }
  function referenceFullAfter(code4) {
    return self2.parser.defined.includes(normalizeIdentifier(self2.sliceSerialize(self2.events[self2.events.length - 1][1]).slice(1, -1))) ? ok3(code4) : nok(code4);
  }
  function referenceFullMissing(code4) {
    return nok(code4);
  }
}
function tokenizeReferenceCollapsed(effects, ok3, nok) {
  return referenceCollapsedStart;
  function referenceCollapsedStart(code4) {
    effects.enter("reference");
    effects.enter("referenceMarker");
    effects.consume(code4);
    effects.exit("referenceMarker");
    return referenceCollapsedOpen;
  }
  function referenceCollapsedOpen(code4) {
    if (code4 === 93) {
      effects.enter("referenceMarker");
      effects.consume(code4);
      effects.exit("referenceMarker");
      effects.exit("reference");
      return ok3;
    }
    return nok(code4);
  }
}

var labelStartImage = {
  name: "labelStartImage",
  resolveAll: labelEnd.resolveAll,
  tokenize: tokenizeLabelStartImage
};
function tokenizeLabelStartImage(effects, ok3, nok) {
  const self2 = this;
  let labelImage;
  return start2;
  function start2(code4) {
    effects.enter("labelImage");
    effects.enter("labelImageMarker");
    effects.consume(code4);
    effects.exit("labelImageMarker");
    return open;
  }
  function open(code4) {
    if (code4 === 91) {
      effects.enter("labelMarker");
      effects.consume(code4);
      effects.exit("labelMarker");
      labelImage = effects.exit("labelImage");
      return after;
    }
    return nok(code4);
  }
  function after(code4) {
    if (code4 === 94 && "_hiddenFootnoteSupport" in self2.parser.constructs) {
      return nok(code4);
    }
    self2._labelStarts = self2._labelStarts || [];
    self2._labelStarts.push(labelImage);
    return ok3(code4);
  }
}

var labelStartLink = {
  name: "labelStartLink",
  resolveAll: labelEnd.resolveAll,
  tokenize: tokenizeLabelStartLink
};
function tokenizeLabelStartLink(effects, ok3, nok) {
  const self2 = this;
  let labelLink;
  return start2;
  function start2(code4) {
    effects.enter("labelLink");
    effects.enter("labelMarker");
    effects.consume(code4);
    effects.exit("labelMarker");
    labelLink = effects.exit("labelLink");
    return after;
  }
  function after(code4) {
    if (code4 === 94 && "_hiddenFootnoteSupport" in self2.parser.constructs) {
      return nok(code4);
    }
    self2._labelStarts = self2._labelStarts || [];
    self2._labelStarts.push(labelLink);
    return ok3(code4);
  }
}

var lineEnding = {
  name: "lineEnding",
  tokenize: tokenizeLineEnding
};
function tokenizeLineEnding(effects, ok3) {
  return start2;
  function start2(code4) {
    effects.enter("lineEnding");
    effects.consume(code4);
    effects.exit("lineEnding");
    return factorySpace(effects, ok3, "linePrefix");
  }
}

var thematicBreak = {
  name: "thematicBreak",
  tokenize: tokenizeThematicBreak
};
function tokenizeThematicBreak(effects, ok3, nok) {
  let size = 0;
  let marker;
  return start2;
  function start2(code4) {
    effects.enter("thematicBreak");
    return before(code4);
  }
  function before(code4) {
    marker = code4;
    return atBreak(code4);
  }
  function atBreak(code4) {
    if (code4 === marker) {
      effects.enter("thematicBreakSequence");
      return sequence(code4);
    }
    if (size >= 3 && (code4 === null || markdownLineEnding(code4))) {
      effects.exit("thematicBreak");
      return ok3(code4);
    }
    return nok(code4);
  }
  function sequence(code4) {
    if (code4 === marker) {
      effects.consume(code4);
      size++;
      return sequence;
    }
    effects.exit("thematicBreakSequence");
    return markdownSpace(code4) ? factorySpace(effects, atBreak, "whitespace")(code4) : atBreak(code4);
  }
}

var list = {
  continuation: {
    tokenize: tokenizeListContinuation
  },
  exit: tokenizeListEnd,
  name: "list",
  tokenize: tokenizeListStart
};
var listItemPrefixWhitespaceConstruct = {
  partial: true,
  tokenize: tokenizeListItemPrefixWhitespace
};
var indentConstruct = {
  partial: true,
  tokenize: tokenizeIndent
};
function tokenizeListStart(effects, ok3, nok) {
  const self2 = this;
  const tail = self2.events[self2.events.length - 1];
  let initialSize = tail && tail[1].type === "linePrefix" ? tail[2].sliceSerialize(tail[1], true).length : 0;
  let size = 0;
  return start2;
  function start2(code4) {
    const kind = self2.containerState.type || (code4 === 42 || code4 === 43 || code4 === 45 ? "listUnordered" : "listOrdered");
    if (kind === "listUnordered" ? !self2.containerState.marker || code4 === self2.containerState.marker : asciiDigit(code4)) {
      if (!self2.containerState.type) {
        self2.containerState.type = kind;
        effects.enter(kind, {
          _container: true
        });
      }
      if (kind === "listUnordered") {
        effects.enter("listItemPrefix");
        return code4 === 42 || code4 === 45 ? effects.check(thematicBreak, nok, atMarker)(code4) : atMarker(code4);
      }
      if (!self2.interrupt || code4 === 49) {
        effects.enter("listItemPrefix");
        effects.enter("listItemValue");
        return inside(code4);
      }
    }
    return nok(code4);
  }
  function inside(code4) {
    if (asciiDigit(code4) && ++size < 10) {
      effects.consume(code4);
      return inside;
    }
    if ((!self2.interrupt || size < 2) && (self2.containerState.marker ? code4 === self2.containerState.marker : code4 === 41 || code4 === 46)) {
      effects.exit("listItemValue");
      return atMarker(code4);
    }
    return nok(code4);
  }
  function atMarker(code4) {
    effects.enter("listItemMarker");
    effects.consume(code4);
    effects.exit("listItemMarker");
    self2.containerState.marker = self2.containerState.marker || code4;
    return effects.check(
      blankLine,
      // Can’t be empty when interrupting.
      self2.interrupt ? nok : onBlank,
      effects.attempt(listItemPrefixWhitespaceConstruct, endOfPrefix, otherPrefix)
    );
  }
  function onBlank(code4) {
    self2.containerState.initialBlankLine = true;
    initialSize++;
    return endOfPrefix(code4);
  }
  function otherPrefix(code4) {
    if (markdownSpace(code4)) {
      effects.enter("listItemPrefixWhitespace");
      effects.consume(code4);
      effects.exit("listItemPrefixWhitespace");
      return endOfPrefix;
    }
    return nok(code4);
  }
  function endOfPrefix(code4) {
    self2.containerState.size = initialSize + self2.sliceSerialize(effects.exit("listItemPrefix"), true).length;
    return ok3(code4);
  }
}
function tokenizeListContinuation(effects, ok3, nok) {
  const self2 = this;
  self2.containerState._closeFlow = void 0;
  return effects.check(blankLine, onBlank, notBlank);
  function onBlank(code4) {
    self2.containerState.furtherBlankLines = self2.containerState.furtherBlankLines || self2.containerState.initialBlankLine;
    return factorySpace(effects, ok3, "listItemIndent", self2.containerState.size + 1)(code4);
  }
  function notBlank(code4) {
    if (self2.containerState.furtherBlankLines || !markdownSpace(code4)) {
      self2.containerState.furtherBlankLines = void 0;
      self2.containerState.initialBlankLine = void 0;
      return notInCurrentItem(code4);
    }
    self2.containerState.furtherBlankLines = void 0;
    self2.containerState.initialBlankLine = void 0;
    return effects.attempt(indentConstruct, ok3, notInCurrentItem)(code4);
  }
  function notInCurrentItem(code4) {
    self2.containerState._closeFlow = true;
    self2.interrupt = void 0;
    return factorySpace(effects, effects.attempt(list, ok3, nok), "linePrefix", self2.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4)(code4);
  }
}
function tokenizeIndent(effects, ok3, nok) {
  const self2 = this;
  return factorySpace(effects, afterPrefix, "listItemIndent", self2.containerState.size + 1);
  function afterPrefix(code4) {
    const tail = self2.events[self2.events.length - 1];
    return tail && tail[1].type === "listItemIndent" && tail[2].sliceSerialize(tail[1], true).length === self2.containerState.size ? ok3(code4) : nok(code4);
  }
}
function tokenizeListEnd(effects) {
  effects.exit(this.containerState.type);
}
function tokenizeListItemPrefixWhitespace(effects, ok3, nok) {
  const self2 = this;
  return factorySpace(effects, afterPrefix, "listItemPrefixWhitespace", self2.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4 + 1);
  function afterPrefix(code4) {
    const tail = self2.events[self2.events.length - 1];
    return !markdownSpace(code4) && tail && tail[1].type === "listItemPrefixWhitespace" ? ok3(code4) : nok(code4);
  }
}

var setextUnderline = {
  name: "setextUnderline",
  resolveTo: resolveToSetextUnderline,
  tokenize: tokenizeSetextUnderline
};
function resolveToSetextUnderline(events, context) {
  const editMap = new EditMap();
  let index3 = events.length;
  let content3;
  let text7;
  let definition3;
  while (index3--) {
    if (events[index3][0] === "enter") {
      if (events[index3][1].type === "content") {
        content3 = index3;
        break;
      }
      if (events[index3][1].type === "paragraph") {
        text7 = index3;
      }
    } else {
      if (events[index3][1].type === "content") {
        editMap.add(index3, 1, []);
      }
      if (!definition3 && events[index3][1].type === "definition") {
        definition3 = index3;
      }
    }
  }
  const heading3 = {
    type: "setextHeading",
    start: {
      ...events[content3][1].start
    },
    end: {
      ...events[events.length - 1][1].end
    }
  };
  events[text7][1].type = "setextHeadingText";
  if (definition3) {
    editMap.add(text7, 0, [["enter", heading3, context]]);
    editMap.add(definition3 + 1, 0, [["exit", events[content3][1], context]]);
    events[content3][1].end = {
      ...events[definition3][1].end
    };
  } else {
    events[content3][1] = heading3;
  }
  editMap.add(events.length, 0, [["exit", heading3, context]]);
  editMap.consume(events);
  return events;
}
function tokenizeSetextUnderline(effects, ok3, nok) {
  const self2 = this;
  let marker;
  return start2;
  function start2(code4) {
    let index3 = self2.events.length;
    let paragraph3;
    while (index3--) {
      if (self2.events[index3][1].type !== "lineEnding" && self2.events[index3][1].type !== "linePrefix" && self2.events[index3][1].type !== "content") {
        paragraph3 = self2.events[index3][1].type === "paragraph";
        break;
      }
    }
    if (!self2.parser.lazy[self2.now().line] && (self2.interrupt || paragraph3)) {
      effects.enter("setextHeadingLine");
      marker = code4;
      return before(code4);
    }
    return nok(code4);
  }
  function before(code4) {
    effects.enter("setextHeadingLineSequence");
    return inside(code4);
  }
  function inside(code4) {
    if (code4 === marker) {
      effects.consume(code4);
      return inside;
    }
    effects.exit("setextHeadingLineSequence");
    return markdownSpace(code4) ? factorySpace(effects, after, "lineSuffix")(code4) : after(code4);
  }
  function after(code4) {
    if (code4 === null || markdownLineEnding(code4)) {
      effects.exit("setextHeadingLine");
      return ok3(code4);
    }
    return nok(code4);
  }
}

var flow = {
  tokenize: initializeFlow
};
function initializeFlow(effects) {
  const self2 = this;
  const initial = effects.attempt(
    // Try to parse a blank line.
    blankLine,
    atBlankEnding,
    // Try to parse initial flow (essentially, only code).
    effects.attempt(this.parser.constructs.flowInitial, afterConstruct, factorySpace(effects, effects.attempt(this.parser.constructs.flow, afterConstruct, effects.attempt(content2, afterConstruct)), "linePrefix"))
  );
  return initial;
  function atBlankEnding(code4) {
    if (code4 === null) {
      effects.consume(code4);
      return;
    }
    effects.enter("lineEndingBlank");
    effects.consume(code4);
    effects.exit("lineEndingBlank");
    self2.currentConstruct = void 0;
    return initial;
  }
  function afterConstruct(code4) {
    if (code4 === null) {
      effects.consume(code4);
      return;
    }
    effects.enter("lineEnding");
    effects.consume(code4);
    effects.exit("lineEnding");
    self2.currentConstruct = void 0;
    return initial;
  }
}

var resolver = {
  resolveAll: createResolver()
};
var string = initializeFactory("string");
var text2 = initializeFactory("text");
function initializeFactory(field) {
  return {
    resolveAll: createResolver(field === "text" ? resolveAllLineSuffixes : void 0),
    tokenize: initializeText
  };
  function initializeText(effects) {
    const self2 = this;
    const constructs2 = this.parser.constructs[field];
    const text7 = effects.attempt(constructs2, start2, notText);
    return start2;
    function start2(code4) {
      return atBreak(code4) ? text7(code4) : notText(code4);
    }
    function notText(code4) {
      if (code4 === null) {
        effects.consume(code4);
        return;
      }
      effects.enter("data");
      effects.consume(code4);
      return data;
    }
    function data(code4) {
      if (atBreak(code4)) {
        effects.exit("data");
        return text7(code4);
      }
      effects.consume(code4);
      return data;
    }
    function atBreak(code4) {
      if (code4 === null) {
        return true;
      }
      const list4 = constructs2[code4];
      let index3 = -1;
      if (list4) {
        while (++index3 < list4.length) {
          const item = list4[index3];
          if (!item.previous || item.previous.call(self2, self2.previous)) {
            return true;
          }
        }
      }
      return false;
    }
  }
}
function createResolver(extraResolver) {
  return resolveAllText;
  function resolveAllText(events, context) {
    let index3 = -1;
    let enter;
    while (++index3 <= events.length) {
      if (enter === void 0) {
        if (events[index3] && events[index3][1].type === "data") {
          enter = index3;
          index3++;
        }
      } else if (!events[index3] || events[index3][1].type !== "data") {
        if (index3 !== enter + 2) {
          events[enter][1].end = events[index3 - 1][1].end;
          events.splice(enter + 2, index3 - enter - 2);
          index3 = enter + 2;
        }
        enter = void 0;
      }
    }
    return extraResolver ? extraResolver(events, context) : events;
  }
}
function resolveAllLineSuffixes(events, context) {
  const editMap = new EditMap();
  let eventIndex = 0;
  while (++eventIndex <= events.length) {
    if ((eventIndex === events.length || events[eventIndex][1].type === "lineEnding") && events[eventIndex - 1][1].type === "data") {
      const data = events[eventIndex - 1][1];
      const chunks = context.sliceStream(data);
      let index3 = chunks.length;
      let bufferIndex = -1;
      let size = 0;
      let tabs;
      while (index3--) {
        const chunk = chunks[index3];
        if (typeof chunk === "string") {
          bufferIndex = chunk.length;
          while (chunk.charCodeAt(bufferIndex - 1) === 32) {
            size++;
            bufferIndex--;
          }
          if (bufferIndex) {
            break;
          }
          bufferIndex = -1;
        } else if (chunk === -2) {
          tabs = true;
          size++;
        } else if (chunk === -1) {
        } else {
          index3++;
          break;
        }
      }
      if (context._contentTypeTextTrailing && eventIndex === events.length) {
        size = 0;
      }
      if (size) {
        const token = {
          type: eventIndex === events.length || tabs || size < 2 ? "lineSuffix" : "hardBreakTrailing",
          start: {
            _bufferIndex: index3 ? bufferIndex : data.start._bufferIndex + bufferIndex,
            _index: data.start._index + index3,
            line: data.end.line,
            column: data.end.column - size,
            offset: data.end.offset - size
          },
          end: {
            ...data.end
          }
        };
        data.end = {
          ...token.start
        };
        if (data.start.offset === data.end.offset) {
          Object.assign(data, token);
        } else {
          editMap.add(eventIndex, 0, [["enter", token, context], ["exit", token, context]]);
        }
      }
      eventIndex++;
    }
  }
  editMap.consume(events);
  return events;
}

var constructs_exports = {};
__export(constructs_exports, {
  attentionMarkers: () => attentionMarkers,
  contentInitial: () => contentInitial,
  disable: () => disable,
  document: () => document3,
  flow: () => flow2,
  flowInitial: () => flowInitial,
  insideSpan: () => insideSpan,
  string: () => string2,
  text: () => text3
});
var document3 = {
  [42]: list,
  [43]: list,
  [45]: list,
  [48]: list,
  [49]: list,
  [50]: list,
  [51]: list,
  [52]: list,
  [53]: list,
  [54]: list,
  [55]: list,
  [56]: list,
  [57]: list,
  [62]: blockQuote
};
var contentInitial = {
  [91]: definition
};
var flowInitial = {
  [-2]: codeIndented,
  [-1]: codeIndented,
  [32]: codeIndented
};
var flow2 = {
  [35]: headingAtx,
  [42]: thematicBreak,
  [45]: [setextUnderline, thematicBreak],
  [60]: htmlFlow,
  [61]: setextUnderline,
  [95]: thematicBreak,
  [96]: codeFenced,
  [126]: codeFenced
};
var string2 = {
  [38]: characterReference,
  [92]: characterEscape
};
var text3 = {
  [-5]: lineEnding,
  [-4]: lineEnding,
  [-3]: lineEnding,
  [33]: labelStartImage,
  [38]: characterReference,
  [42]: attention,
  [60]: [autolink, htmlText],
  [91]: labelStartLink,
  [92]: [hardBreakEscape, characterEscape],
  [93]: labelEnd,
  [95]: attention,
  [96]: codeText
};
var insideSpan = {
  null: [attention, resolver]
};
var attentionMarkers = {
  null: [42, 95]
};
var disable = {
  null: []
};

function createTokenizer(parser, initialize, from) {
  let point4 = {
    _bufferIndex: -1,
    _index: 0,
    line: from && from.line || 1,
    column: from && from.column || 1,
    offset: from && from.offset || 0
  };
  const columnStart = {};
  const resolveAllConstructs = [];
  let chunks = [];
  let stack = [];
  let consumed = true;
  const effects = {
    attempt: constructFactory(onsuccessfulconstruct),
    check: constructFactory(onsuccessfulcheck),
    consume,
    enter,
    exit: exit3,
    interrupt: constructFactory(onsuccessfulcheck, {
      interrupt: true
    })
  };
  const context = {
    code: null,
    containerState: {},
    defineSkip,
    events: [],
    now,
    parser,
    previous: null,
    sliceSerialize,
    sliceStream,
    write
  };
  let state = initialize.tokenize.call(context, effects);
  let expectedCode;
  if (initialize.resolveAll) {
    resolveAllConstructs.push(initialize);
  }
  return context;
  function write(slice) {
    chunks = push(chunks, slice);
    main();
    if (chunks[chunks.length - 1] !== null) {
      return [];
    }
    addResult(initialize, 0);
    context.events = resolveAll(resolveAllConstructs, context.events, context);
    return context.events;
  }
  function sliceSerialize(token, expandTabs) {
    return serializeChunks(sliceStream(token), expandTabs);
  }
  function sliceStream(token) {
    return sliceChunks(chunks, token);
  }
  function now() {
    const {
      _bufferIndex,
      _index,
      line,
      column,
      offset
    } = point4;
    return {
      _bufferIndex,
      _index,
      line,
      column,
      offset
    };
  }
  function defineSkip(value) {
    columnStart[value.line] = value.column;
    accountForPotentialSkip();
  }
  function main() {
    while (point4._index < chunks.length) {
      const chunk = chunks[point4._index];
      if (typeof chunk === "string") {
        const chunkIndex = point4._index;
        if (point4._bufferIndex < 0) {
          point4._bufferIndex = 0;
        }
        while (point4._index === chunkIndex && point4._bufferIndex < chunk.length) {
          go(chunk.charCodeAt(point4._bufferIndex));
        }
      } else {
        go(chunk);
      }
    }
  }
  function go(code4) {
    consumed = void 0;
    expectedCode = code4;
    state = state(code4);
  }
  function consume(code4) {
    if (markdownLineEnding(code4)) {
      point4.line++;
      point4.column = 1;
      point4.offset += code4 === -3 ? 2 : 1;
      accountForPotentialSkip();
    } else if (code4 !== -1) {
      point4.column++;
      point4.offset++;
    }
    if (point4._bufferIndex < 0) {
      point4._index++;
    } else {
      point4._bufferIndex++;
      if (point4._bufferIndex === // Points w/ non-negative `_bufferIndex` reference
      // strings.
      /** @type {string} */
      chunks[point4._index].length) {
        point4._bufferIndex = -1;
        point4._index++;
      }
    }
    context.previous = code4;
    consumed = true;
  }
  function enter(type, fields) {
    const token = fields || {};
    token.type = type;
    token.start = now();
    context.events.push(["enter", token, context]);
    stack.push(token);
    return token;
  }
  function exit3(type) {
    const token = stack.pop();
    token.end = now();
    context.events.push(["exit", token, context]);
    return token;
  }
  function onsuccessfulconstruct(construct, info) {
    addResult(construct, info.from);
  }
  function onsuccessfulcheck(_, info) {
    info.restore();
  }
  function constructFactory(onreturn, fields) {
    return hook;
    function hook(constructs2, returnState, bogusState) {
      let listOfConstructs;
      let constructIndex;
      let currentConstruct;
      let info;
      return Array.isArray(constructs2) ? (
        /* c8 ignore next 1 */
        handleListOfConstructs(constructs2)
      ) : "tokenize" in constructs2 ? (
        // Looks like a construct.
        handleListOfConstructs([
          /** @type {Construct} */
          constructs2
        ])
      ) : handleMapOfConstructs(constructs2);
      function handleMapOfConstructs(map3) {
        return start2;
        function start2(code4) {
          const left = code4 !== null && map3[code4];
          const all2 = code4 !== null && map3.null;
          const list4 = [
            // To do: add more extension tests.
            /* c8 ignore next 2 */
            ...Array.isArray(left) ? left : left ? [left] : [],
            ...Array.isArray(all2) ? all2 : all2 ? [all2] : []
          ];
          return handleListOfConstructs(list4)(code4);
        }
      }
      function handleListOfConstructs(list4) {
        listOfConstructs = list4;
        constructIndex = 0;
        if (list4.length === 0) {
          return bogusState;
        }
        return handleConstruct(list4[constructIndex]);
      }
      function handleConstruct(construct) {
        return start2;
        function start2(code4) {
          info = store();
          currentConstruct = construct;
          if (!construct.partial) {
            context.currentConstruct = construct;
          }
          if (construct.name && context.parser.constructs.disable.null.includes(construct.name)) {
            return nok(code4);
          }
          return construct.tokenize.call(
            // If we do have fields, create an object w/ `context` as its
            // prototype.
            // This allows a “live binding”, which is needed for `interrupt`.
            fields ? Object.assign(Object.create(context), fields) : context,
            effects,
            ok3,
            nok
          )(code4);
        }
      }
      function ok3(code4) {
        consumed = true;
        onreturn(currentConstruct, info);
        return returnState;
      }
      function nok(code4) {
        consumed = true;
        info.restore();
        if (++constructIndex < listOfConstructs.length) {
          return handleConstruct(listOfConstructs[constructIndex]);
        }
        return bogusState;
      }
    }
  }
  function addResult(construct, from2) {
    if (construct.resolveAll && !resolveAllConstructs.includes(construct)) {
      resolveAllConstructs.push(construct);
    }
    if (construct.resolve) {
      splice(context.events, from2, context.events.length - from2, construct.resolve(context.events.slice(from2), context));
    }
    if (construct.resolveTo) {
      context.events = construct.resolveTo(context.events, context);
    }
  }
  function store() {
    const startPoint = now();
    const startPrevious = context.previous;
    const startCurrentConstruct = context.currentConstruct;
    const startEventsIndex = context.events.length;
    const startStack = Array.from(stack);
    return {
      from: startEventsIndex,
      restore
    };
    function restore() {
      point4 = startPoint;
      context.previous = startPrevious;
      context.currentConstruct = startCurrentConstruct;
      context.events.length = startEventsIndex;
      stack = startStack;
      accountForPotentialSkip();
    }
  }
  function accountForPotentialSkip() {
    if (point4.line in columnStart && point4.column < 2) {
      point4.column = columnStart[point4.line];
      point4.offset += columnStart[point4.line] - 1;
    }
  }
}
function sliceChunks(chunks, token) {
  const startIndex = token.start._index;
  const startBufferIndex = token.start._bufferIndex;
  const endIndex = token.end._index;
  const endBufferIndex = token.end._bufferIndex;
  let view;
  if (startIndex === endIndex) {
    view = [chunks[startIndex].slice(startBufferIndex, endBufferIndex)];
  } else {
    view = chunks.slice(startIndex, endIndex);
    if (startBufferIndex > -1) {
      const head = view[0];
      if (typeof head === "string") {
        view[0] = head.slice(startBufferIndex);
      } else {
        view.shift();
      }
    }
    if (endBufferIndex > 0) {
      view.push(chunks[endIndex].slice(0, endBufferIndex));
    }
  }
  return view;
}
function serializeChunks(chunks, expandTabs) {
  let index3 = -1;
  const result = [];
  let atTab;
  while (++index3 < chunks.length) {
    const chunk = chunks[index3];
    let value;
    if (typeof chunk === "string") {
      value = chunk;
    } else {
      switch (chunk) {
        case -5: {
          value = "\r";
          break;
        }
        case -4: {
          value = "\n";
          break;
        }
        case -3: {
          value = "\r\n";
          break;
        }
        case -2: {
          value = expandTabs ? " " : "	";
          break;
        }
        case -1: {
          if (!expandTabs && atTab) {
            continue;
          }
          value = " ";
          break;
        }
        default: {
          value = String.fromCharCode(chunk);
        }
      }
    }
    atTab = chunk === -2;
    result.push(value);
  }
  return result.join("");
}

function parse(options) {
  const settings = options || {};
  const constructs2 = (
    /** @type {FullNormalizedExtension} */
    combineExtensions([constructs_exports, ...settings.extensions || []])
  );
  const parser = {
    constructs: constructs2,
    content: create2(content),
    defined: [],
    document: create2(document2),
    flow: create2(flow),
    lazy: {},
    string: create2(string),
    text: create2(text2)
  };
  return parser;
  function create2(initial) {
    return creator;
    function creator(from) {
      return createTokenizer(parser, initial, from);
    }
  }
}

function postprocess(events) {
  while (!subtokenize(events)) {
  }
  return events;
}

var search = /[\0\t\n\r]/g;
function preprocess() {
  let column = 1;
  let buffer = "";
  let start2 = true;
  let atCarriageReturn;
  return preprocessor;
  function preprocessor(value, encoding, end) {
    value = buffer + (typeof value === "string" ? value.toString() : new TextDecoder(encoding || void 0).decode(value));
    const chunks = [];
    let startPosition = 0;
    buffer = "";
    if (start2) {
      if (value.charCodeAt(0) === 65279) {
        startPosition++;
      }
      start2 = void 0;
    }
    while (startPosition < value.length) {
      search.lastIndex = startPosition;
      const match = search.exec(value);
      const endPosition = match && match.index !== void 0 ? match.index : value.length;
      const code4 = value.charCodeAt(endPosition);
      if (!match) {
        buffer = value.slice(startPosition);
        break;
      }
      if (code4 === 10 && startPosition === endPosition && atCarriageReturn) {
        chunks.push(-3);
        atCarriageReturn = void 0;
      } else {
        if (atCarriageReturn) {
          chunks.push(-5);
          atCarriageReturn = void 0;
        }
        if (startPosition < endPosition) {
          chunks.push(value.slice(startPosition, endPosition));
          column += endPosition - startPosition;
        }
        switch (code4) {
          case 0: {
            chunks.push(65533);
            column++;
            break;
          }
          case 9: {
            const next = Math.ceil(column / 4) * 4;
            chunks.push(-2);
            while (column++ < next) {
              chunks.push(-1);
            }
            break;
          }
          case 10: {
            chunks.push(-4);
            column = 1;
            break;
          }
          default: {
            atCarriageReturn = true;
            column = 1;
          }
        }
      }
      startPosition = endPosition + 1;
    }
    if (end) {
      if (atCarriageReturn) {
        chunks.push(-5);
      }
      if (buffer) {
        chunks.push(buffer);
      }
      chunks.push(null);
    }
    return chunks;
  }
}

var characterEscapeOrReference = /\\([!-/:-@[-`{-~])|&(#(?:\d{1,7}|x[\da-f]{1,6})|[\da-z]{1,31});/gi;
function decodeString(value) {
  return value.replace(characterEscapeOrReference, decode);
}
function decode($0, $1, $2) {
  if ($1) {
    return $1;
  }
  const head = $2.charCodeAt(0);
  if (head === 35) {
    const head2 = $2.charCodeAt(1);
    const hex = head2 === 120 || head2 === 88;
    return decodeNumericCharacterReference($2.slice(hex ? 2 : 1), hex ? 16 : 10);
  }
  return decodeNamedCharacterReference($2) || $0;
}

var own3 = {}.hasOwnProperty;
function fromMarkdown(value, encoding, options) {
  if (encoding && typeof encoding === "object") {
    options = encoding;
    encoding = void 0;
  }
  return compiler(options)(postprocess(parse(options).document().write(preprocess()(value, encoding, true))));
}
function compiler(options) {
  const config = {
    afterExit: [],
    beforeEnter: [],
    transforms: [],
    canContainEols: ["emphasis", "fragment", "heading", "paragraph", "strong"],
    enter: {
      autolink: opener(link3),
      autolinkProtocol: onenterdata,
      autolinkEmail: onenterdata,
      atxHeading: opener(heading3),
      blockQuote: opener(blockQuote2),
      characterEscape: onenterdata,
      characterReference: onenterdata,
      codeFenced: opener(codeFlow),
      codeFencedFenceInfo: buffer,
      codeFencedFenceMeta: buffer,
      codeIndented: opener(codeFlow, buffer),
      codeText: opener(codeText2, buffer),
      codeTextData: onenterdata,
      data: onenterdata,
      codeFlowValue: onenterdata,
      definition: opener(definition3),
      definitionDestinationString: buffer,
      definitionLabelString: buffer,
      definitionTitleString: buffer,
      emphasis: opener(emphasis3),
      hardBreakEscape: opener(hardBreak3),
      hardBreakTrailing: opener(hardBreak3),
      htmlFlow: opener(html5, buffer),
      htmlFlowData: onenterdata,
      htmlText: opener(html5, buffer),
      htmlTextData: onenterdata,
      image: opener(image3),
      label: buffer,
      link: opener(link3),
      listItem: opener(listItem3),
      listItemValue: onenterlistitemvalue,
      listOrdered: opener(list4, onenterlistordered),
      listUnordered: opener(list4),
      paragraph: opener(paragraph3),
      reference: onenterreference,
      referenceString: buffer,
      resourceDestinationString: buffer,
      resourceTitleString: buffer,
      setextHeading: opener(heading3),
      strong: opener(strong3),
      thematicBreak: opener(thematicBreak4)
    },
    exit: {
      atxHeading: closer(),
      atxHeadingSequence: onexitatxheadingsequence,
      autolink: closer(),
      autolinkEmail: onexitautolinkemail,
      autolinkProtocol: onexitautolinkprotocol,
      blockQuote: closer(),
      characterEscapeValue: onexitdata,
      characterReferenceMarkerHexadecimal: onexitcharacterreferencemarker,
      characterReferenceMarkerNumeric: onexitcharacterreferencemarker,
      characterReferenceValue: onexitcharacterreferencevalue,
      characterReference: onexitcharacterreference,
      codeFenced: closer(onexitcodefenced),
      codeFencedFence: onexitcodefencedfence,
      codeFencedFenceInfo: onexitcodefencedfenceinfo,
      codeFencedFenceMeta: onexitcodefencedfencemeta,
      codeFlowValue: onexitdata,
      codeIndented: closer(onexitcodeindented),
      codeText: closer(onexitcodetext),
      codeTextData: onexitdata,
      data: onexitdata,
      definition: closer(),
      definitionDestinationString: onexitdefinitiondestinationstring,
      definitionLabelString: onexitdefinitionlabelstring,
      definitionTitleString: onexitdefinitiontitlestring,
      emphasis: closer(),
      hardBreakEscape: closer(onexithardbreak),
      hardBreakTrailing: closer(onexithardbreak),
      htmlFlow: closer(onexithtmlflow),
      htmlFlowData: onexitdata,
      htmlText: closer(onexithtmltext),
      htmlTextData: onexitdata,
      image: closer(onexitimage),
      label: onexitlabel,
      labelText: onexitlabeltext,
      lineEnding: onexitlineending,
      link: closer(onexitlink),
      listItem: closer(),
      listOrdered: closer(),
      listUnordered: closer(),
      paragraph: closer(),
      referenceString: onexitreferencestring,
      resourceDestinationString: onexitresourcedestinationstring,
      resourceTitleString: onexitresourcetitlestring,
      resource: onexitresource,
      setextHeading: closer(onexitsetextheading),
      setextHeadingLineSequence: onexitsetextheadinglinesequence,
      setextHeadingText: onexitsetextheadingtext,
      strong: closer(),
      thematicBreak: closer()
    }
  };
  configure(config, (options || {}).mdastExtensions || []);
  const data = {};
  return compile;
  function compile(events) {
    let tree = {
      type: "root",
      children: [],
      position: void 0
    };
    const context = {
      stack: [tree],
      tokenStack: [],
      config,
      enter,
      exit: exit3,
      buffer,
      resume,
      data
    };
    const listStack = [];
    const prepared = [];
    let index3 = -1;
    while (++index3 < events.length) {
      prepared.push(events[index3]);
      if (events[index3][1].type === "listOrdered" || events[index3][1].type === "listUnordered") {
        if (events[index3][0] === "enter") {
          listStack.push(prepared.length - 1);
        } else {
          const tail = listStack.pop();
          prepareList(prepared, tail);
        }
      }
    }
    events = prepared;
    index3 = -1;
    while (++index3 < events.length) {
      const handler = config[events[index3][0]];
      if (events[index3][0] === "enter" && config.beforeEnter.length > 0) {
        callListeners(config.beforeEnter, {
          ...context,
          sliceSerialize: events[index3][2].sliceSerialize
        }, events[index3][1]);
      }
      if (own3.call(handler, events[index3][1].type)) {
        handler[events[index3][1].type].call({
          ...context,
          sliceSerialize: events[index3][2].sliceSerialize
        }, events[index3][1]);
      }
      if (events[index3][0] === "exit" && config.afterExit.length > 0) {
        callListeners(config.afterExit, {
          ...context,
          sliceSerialize: events[index3][2].sliceSerialize
        }, events[index3][1]);
      }
    }
    if (context.tokenStack.length > 0) {
      const tail = context.tokenStack[context.tokenStack.length - 1];
      const handler = tail[1] || defaultOnError;
      handler.call(context, void 0, tail[0]);
    }
    tree.position = {
      start: point3(events.length > 0 ? events[0][1].start : {
        line: 1,
        column: 1,
        offset: 0
      }),
      end: point3(events.length > 0 ? events[events.length - 2][1].end : {
        line: 1,
        column: 1,
        offset: 0
      })
    };
    index3 = -1;
    while (++index3 < config.transforms.length) {
      tree = config.transforms[index3](tree) || tree;
    }
    return tree;
  }
  function callListeners(listeners, context, token) {
    let index3 = -1;
    while (++index3 < listeners.length) {
      listeners[index3].call(context, token);
    }
  }
  function prepareList(events, start2) {
    const end = events.length - 1;
    let index3 = start2 - 1;
    let containerBalance = -1;
    let listSpread = false;
    let listItem4;
    let lineIndex;
    let firstBlankLineIndex;
    let atMarker;
    const insertions = [];
    while (++index3 <= end) {
      const event = events[index3];
      switch (event[1].type) {
        case "listUnordered":
        case "listOrdered":
        case "blockQuote": {
          if (event[0] === "enter") {
            containerBalance++;
          } else {
            containerBalance--;
          }
          atMarker = void 0;
          break;
        }
        case "lineEndingBlank": {
          if (event[0] === "enter") {
            if (listItem4 && !atMarker && !containerBalance && !firstBlankLineIndex) {
              firstBlankLineIndex = index3;
            }
            atMarker = void 0;
          }
          break;
        }
        case "linePrefix":
        case "listItemValue":
        case "listItemMarker":
        case "listItemPrefix":
        case "listItemPrefixWhitespace": {
          break;
        }
        default: {
          atMarker = void 0;
        }
      }
      if (!containerBalance && event[0] === "enter" && event[1].type === "listItemPrefix" || containerBalance === -1 && event[0] === "exit" && (event[1].type === "listUnordered" || event[1].type === "listOrdered")) {
        if (listItem4) {
          let tailIndex = index3;
          lineIndex = void 0;
          while (tailIndex--) {
            const tailEvent = events[tailIndex];
            if (tailEvent[1].type === "lineEnding" || tailEvent[1].type === "lineEndingBlank") {
              if (tailEvent[0] === "exit") continue;
              if (lineIndex) {
                events[lineIndex][1].type = "lineEndingBlank";
                listSpread = true;
              }
              tailEvent[1].type = "lineEnding";
              lineIndex = tailIndex;
            } else if (tailEvent[1].type === "linePrefix" || tailEvent[1].type === "blockQuotePrefix" || tailEvent[1].type === "blockQuotePrefixWhitespace" || tailEvent[1].type === "blockQuoteMarker" || tailEvent[1].type === "listItemIndent") {
            } else {
              break;
            }
          }
          if (firstBlankLineIndex && (!lineIndex || firstBlankLineIndex < lineIndex)) {
            listItem4._spread = true;
          }
          listItem4.end = Object.assign({}, lineIndex ? events[lineIndex][1].start : event[1].end);
          insertions.push({
            at: lineIndex || index3,
            event: ["exit", listItem4, event[2]]
          });
        }
        if (event[1].type === "listItemPrefix") {
          const item = {
            type: "listItem",
            _spread: false,
            start: Object.assign({}, event[1].start),
            // @ts-expect-error: we’ll add `end` in a second.
            end: void 0
          };
          listItem4 = item;
          insertions.push({
            at: index3,
            event: ["enter", item, event[2]]
          });
          firstBlankLineIndex = void 0;
          atMarker = true;
        }
      }
    }
    const listEvents = events.splice(start2);
    let insertion = 0;
    index3 = -1;
    while (++index3 < listEvents.length) {
      while (insertion < insertions.length && insertions[insertion].at === start2 + index3) {
        events.push(insertions[insertion++].event);
      }
      events.push(listEvents[index3]);
    }
    events[start2][1]._spread = listSpread;
  }
  function opener(create2, and) {
    return open;
    function open(token) {
      enter.call(this, create2(token), token);
      if (and) and.call(this, token);
    }
  }
  function buffer() {
    this.stack.push({
      type: "fragment",
      children: []
    });
  }
  function enter(node2, token, errorHandler) {
    const parent = this.stack[this.stack.length - 1];
    const siblings = parent.children;
    siblings.push(node2);
    this.stack.push(node2);
    this.tokenStack.push([token, errorHandler || void 0]);
    node2.position = {
      start: point3(token.start),
      // @ts-expect-error: `end` will be patched later.
      end: void 0
    };
  }
  function closer(and) {
    return close;
    function close(token) {
      if (and) and.call(this, token);
      exit3.call(this, token);
    }
  }
  function exit3(token, onExitError) {
    const node2 = this.stack.pop();
    const open = this.tokenStack.pop();
    if (!open) {
      throw new Error("Cannot close `" + token.type + "` (" + stringifyPosition({
        start: token.start,
        end: token.end
      }) + "): it\u2019s not open");
    }
    if (open[0].type !== token.type) {
      if (onExitError) {
        onExitError.call(this, token, open[0]);
      } else {
        const handler = open[1] || defaultOnError;
        handler.call(this, token, open[0]);
      }
    }
    node2.position.end = point3(token.end);
  }
  function resume() {
    return toString(this.stack.pop());
  }
  function onenterlistordered() {
    this.data.expectingFirstListItemValue = true;
  }
  function onenterlistitemvalue(token) {
    if (this.data.expectingFirstListItemValue) {
      const ancestor = this.stack[this.stack.length - 2];
      ancestor.start = Number.parseInt(this.sliceSerialize(token), 10);
      this.data.expectingFirstListItemValue = void 0;
    }
  }
  function onexitcodefencedfenceinfo() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.lang = data2;
  }
  function onexitcodefencedfencemeta() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.meta = data2;
  }
  function onexitcodefencedfence() {
    if (this.data.flowCodeInside) return;
    this.buffer();
    this.data.flowCodeInside = true;
  }
  function onexitcodefenced() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.value = data2.replace(/^(\r?\n|\r)|(\r?\n|\r)$/g, "");
    this.data.flowCodeInside = void 0;
  }
  function onexitcodeindented() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.value = data2.replace(/(\r?\n|\r)$/g, "");
  }
  function onexitdefinitionlabelstring(token) {
    const label = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.label = label;
    node2.identifier = normalizeIdentifier(this.sliceSerialize(token)).toLowerCase();
  }
  function onexitdefinitiontitlestring() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.title = data2;
  }
  function onexitdefinitiondestinationstring() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.url = data2;
  }
  function onexitatxheadingsequence(token) {
    const node2 = this.stack[this.stack.length - 1];
    if (!node2.depth) {
      const depth = this.sliceSerialize(token).length;
      node2.depth = depth;
    }
  }
  function onexitsetextheadingtext() {
    this.data.setextHeadingSlurpLineEnding = true;
  }
  function onexitsetextheadinglinesequence(token) {
    const node2 = this.stack[this.stack.length - 1];
    node2.depth = this.sliceSerialize(token).codePointAt(0) === 61 ? 1 : 2;
  }
  function onexitsetextheading() {
    this.data.setextHeadingSlurpLineEnding = void 0;
  }
  function onenterdata(token) {
    const node2 = this.stack[this.stack.length - 1];
    const siblings = node2.children;
    let tail = siblings[siblings.length - 1];
    if (!tail || tail.type !== "text") {
      tail = text7();
      tail.position = {
        start: point3(token.start),
        // @ts-expect-error: we’ll add `end` later.
        end: void 0
      };
      siblings.push(tail);
    }
    this.stack.push(tail);
  }
  function onexitdata(token) {
    const tail = this.stack.pop();
    tail.value += this.sliceSerialize(token);
    tail.position.end = point3(token.end);
  }
  function onexitlineending(token) {
    const context = this.stack[this.stack.length - 1];
    if (this.data.atHardBreak) {
      const tail = context.children[context.children.length - 1];
      tail.position.end = point3(token.end);
      this.data.atHardBreak = void 0;
      return;
    }
    if (!this.data.setextHeadingSlurpLineEnding && config.canContainEols.includes(context.type)) {
      onenterdata.call(this, token);
      onexitdata.call(this, token);
    }
  }
  function onexithardbreak() {
    this.data.atHardBreak = true;
  }
  function onexithtmlflow() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.value = data2;
  }
  function onexithtmltext() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.value = data2;
  }
  function onexitcodetext() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.value = data2;
  }
  function onexitlink() {
    const node2 = this.stack[this.stack.length - 1];
    if (this.data.inReference) {
      const referenceType = this.data.referenceType || "shortcut";
      node2.type += "Reference";
      node2.referenceType = referenceType;
      delete node2.url;
      delete node2.title;
    } else {
      delete node2.identifier;
      delete node2.label;
    }
    this.data.referenceType = void 0;
  }
  function onexitimage() {
    const node2 = this.stack[this.stack.length - 1];
    if (this.data.inReference) {
      const referenceType = this.data.referenceType || "shortcut";
      node2.type += "Reference";
      node2.referenceType = referenceType;
      delete node2.url;
      delete node2.title;
    } else {
      delete node2.identifier;
      delete node2.label;
    }
    this.data.referenceType = void 0;
  }
  function onexitlabeltext(token) {
    const string3 = this.sliceSerialize(token);
    const ancestor = this.stack[this.stack.length - 2];
    ancestor.label = decodeString(string3);
    ancestor.identifier = normalizeIdentifier(string3).toLowerCase();
  }
  function onexitlabel() {
    const fragment = this.stack[this.stack.length - 1];
    const value = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    this.data.inReference = true;
    if (node2.type === "link") {
      const children = fragment.children;
      node2.children = children;
    } else {
      node2.alt = value;
    }
  }
  function onexitresourcedestinationstring() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.url = data2;
  }
  function onexitresourcetitlestring() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.title = data2;
  }
  function onexitresource() {
    this.data.inReference = void 0;
  }
  function onenterreference() {
    this.data.referenceType = "collapsed";
  }
  function onexitreferencestring(token) {
    const label = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.label = label;
    node2.identifier = normalizeIdentifier(this.sliceSerialize(token)).toLowerCase();
    this.data.referenceType = "full";
  }
  function onexitcharacterreferencemarker(token) {
    this.data.characterReferenceType = token.type;
  }
  function onexitcharacterreferencevalue(token) {
    const data2 = this.sliceSerialize(token);
    const type = this.data.characterReferenceType;
    let value;
    if (type) {
      value = decodeNumericCharacterReference(data2, type === "characterReferenceMarkerNumeric" ? 10 : 16);
      this.data.characterReferenceType = void 0;
    } else {
      const result = decodeNamedCharacterReference(data2);
      value = result;
    }
    const tail = this.stack[this.stack.length - 1];
    tail.value += value;
  }
  function onexitcharacterreference(token) {
    const tail = this.stack.pop();
    tail.position.end = point3(token.end);
  }
  function onexitautolinkprotocol(token) {
    onexitdata.call(this, token);
    const node2 = this.stack[this.stack.length - 1];
    node2.url = this.sliceSerialize(token);
  }
  function onexitautolinkemail(token) {
    onexitdata.call(this, token);
    const node2 = this.stack[this.stack.length - 1];
    node2.url = "mailto:" + this.sliceSerialize(token);
  }
  function blockQuote2() {
    return {
      type: "blockquote",
      children: [],
      position: void 0
    };
  }
  function codeFlow() {
    return {
      type: "code",
      lang: null,
      meta: null,
      value: "",
      position: void 0
    };
  }
  function codeText2() {
    return {
      type: "inlineCode",
      value: "",
      position: void 0
    };
  }
  function definition3() {
    return {
      type: "definition",
      identifier: "",
      label: null,
      title: null,
      url: "",
      position: void 0
    };
  }
  function emphasis3() {
    return {
      type: "emphasis",
      children: [],
      position: void 0
    };
  }
  function heading3() {
    return {
      type: "heading",
      // @ts-expect-error `depth` will be set later.
      depth: 0,
      children: [],
      position: void 0
    };
  }
  function hardBreak3() {
    return {
      type: "break",
      position: void 0
    };
  }
  function html5() {
    return {
      type: "html",
      value: "",
      position: void 0
    };
  }
  function image3() {
    return {
      type: "image",
      title: null,
      url: "",
      alt: null,
      position: void 0
    };
  }
  function link3() {
    return {
      type: "link",
      title: null,
      url: "",
      children: [],
      position: void 0
    };
  }
  function list4(token) {
    return {
      type: "list",
      ordered: token.type === "listOrdered",
      start: null,
      spread: token._spread,
      children: [],
      position: void 0
    };
  }
  function listItem3(token) {
    return {
      type: "listItem",
      spread: token._spread,
      checked: null,
      children: [],
      position: void 0
    };
  }
  function paragraph3() {
    return {
      type: "paragraph",
      children: [],
      position: void 0
    };
  }
  function strong3() {
    return {
      type: "strong",
      children: [],
      position: void 0
    };
  }
  function text7() {
    return {
      type: "text",
      value: "",
      position: void 0
    };
  }
  function thematicBreak4() {
    return {
      type: "thematicBreak",
      position: void 0
    };
  }
}
function point3(d) {
  return {
    line: d.line,
    column: d.column,
    offset: d.offset
  };
}
function configure(combined, extensions) {
  let index3 = -1;
  while (++index3 < extensions.length) {
    const value = extensions[index3];
    if (Array.isArray(value)) {
      configure(combined, value);
    } else {
      extension(combined, value);
    }
  }
}
function extension(combined, extension2) {
  let key;
  for (key in extension2) {
    if (own3.call(extension2, key)) {
      switch (key) {
        case "canContainEols": {
          const right = extension2[key];
          if (right) {
            combined[key].push(...right);
          }
          break;
        }
        case "transforms": {
          const right = extension2[key];
          if (right) {
            combined[key].push(...right);
          }
          break;
        }
        case "afterExit":
        case "beforeEnter": {
          const right = extension2[key];
          if (right) {
            combined[key].push(right);
          }
          break;
        }
        case "enter":
        case "exit": {
          const right = extension2[key];
          if (right) {
            Object.assign(combined[key], right);
          }
          break;
        }
      }
    }
  }
}
function defaultOnError(left, right) {
  if (left) {
    throw new Error("Cannot close `" + left.type + "` (" + stringifyPosition({
      start: left.start,
      end: left.end
    }) + "): a different token (`" + right.type + "`, " + stringifyPosition({
      start: right.start,
      end: right.end
    }) + ") is open");
  }
  throw new Error("Cannot close document, a token (`" + right.type + "`, " + stringifyPosition({
    start: right.start,
    end: right.end
  }) + ") is still open");
}

function remarkParse(options) {
  const self2 = this;
  self2.parser = parser;
  function parser(doc) {
    return fromMarkdown(doc, {
      ...self2.data("settings"),
      ...options,
      // Note: these options are not in the readme.
      // The goal is for them to be set by plugins on `data` instead of being
      // passed by users.
      extensions: self2.data("micromarkExtensions") || [],
      mdastExtensions: self2.data("fromMarkdownExtensions") || []
    });
  }
}

function blockquote(state, node2) {
  const result = {
    type: "element",
    tagName: "blockquote",
    properties: {},
    children: state.wrap(state.all(node2), true)
  };
  state.patch(node2, result);
  return state.applyData(node2, result);
}

function hardBreak(state, node2) {
  const result = { type: "element", tagName: "br", properties: {}, children: [] };
  state.patch(node2, result);
  return [state.applyData(node2, result), { type: "text", value: "\n" }];
}

function code(state, node2) {
  const value = node2.value ? node2.value + "\n" : "";
  const properties = {};
  const language = node2.lang ? node2.lang.split(/\s+/) : [];
  if (language.length > 0) {
    properties.className = ["language-" + language[0]];
  }
  let result = {
    type: "element",
    tagName: "code",
    properties,
    children: [{ type: "text", value }]
  };
  if (node2.meta) {
    result.data = { meta: node2.meta };
  }
  state.patch(node2, result);
  result = state.applyData(node2, result);
  result = { type: "element", tagName: "pre", properties: {}, children: [result] };
  state.patch(node2, result);
  return result;
}

function strikethrough(state, node2) {
  const result = {
    type: "element",
    tagName: "del",
    properties: {},
    children: state.all(node2)
  };
  state.patch(node2, result);
  return state.applyData(node2, result);
}

function emphasis(state, node2) {
  const result = {
    type: "element",
    tagName: "em",
    properties: {},
    children: state.all(node2)
  };
  state.patch(node2, result);
  return state.applyData(node2, result);
}

function footnoteReference(state, node2) {
  const clobberPrefix = typeof state.options.clobberPrefix === "string" ? state.options.clobberPrefix : "user-content-";
  const id = String(node2.identifier).toUpperCase();
  const safeId = normalizeUri(id.toLowerCase());
  const index3 = state.footnoteOrder.indexOf(id);
  let counter;
  let reuseCounter = state.footnoteCounts.get(id);
  if (reuseCounter === void 0) {
    reuseCounter = 0;
    state.footnoteOrder.push(id);
    counter = state.footnoteOrder.length;
  } else {
    counter = index3 + 1;
  }
  reuseCounter += 1;
  state.footnoteCounts.set(id, reuseCounter);
  const link3 = {
    type: "element",
    tagName: "a",
    properties: {
      href: "#" + clobberPrefix + "fn-" + safeId,
      id: clobberPrefix + "fnref-" + safeId + (reuseCounter > 1 ? "-" + reuseCounter : ""),
      dataFootnoteRef: true,
      ariaDescribedBy: ["footnote-label"]
    },
    children: [{ type: "text", value: String(counter) }]
  };
  state.patch(node2, link3);
  const sup = {
    type: "element",
    tagName: "sup",
    properties: {},
    children: [link3]
  };
  state.patch(node2, sup);
  return state.applyData(node2, sup);
}

function heading(state, node2) {
  const result = {
    type: "element",
    tagName: "h" + node2.depth,
    properties: {},
    children: state.all(node2)
  };
  state.patch(node2, result);
  return state.applyData(node2, result);
}

function html3(state, node2) {
  if (state.options.allowDangerousHtml) {
    const result = { type: "raw", value: node2.value };
    state.patch(node2, result);
    return state.applyData(node2, result);
  }
  return void 0;
}

function revert(state, node2) {
  const subtype = node2.referenceType;
  let suffix = "]";
  if (subtype === "collapsed") {
    suffix += "[]";
  } else if (subtype === "full") {
    suffix += "[" + (node2.label || node2.identifier) + "]";
  }
  if (node2.type === "imageReference") {
    return [{ type: "text", value: "![" + node2.alt + suffix }];
  }
  const contents = state.all(node2);
  const head = contents[0];
  if (head && head.type === "text") {
    head.value = "[" + head.value;
  } else {
    contents.unshift({ type: "text", value: "[" });
  }
  const tail = contents[contents.length - 1];
  if (tail && tail.type === "text") {
    tail.value += suffix;
  } else {
    contents.push({ type: "text", value: suffix });
  }
  return contents;
}

function imageReference(state, node2) {
  const id = String(node2.identifier).toUpperCase();
  const definition3 = state.definitionById.get(id);
  if (!definition3) {
    return revert(state, node2);
  }
  const properties = { src: normalizeUri(definition3.url || "") };
  if (node2.alt !== null && node2.alt !== void 0) {
    properties.alt = node2.alt;
  }
  if (definition3.title !== null && definition3.title !== void 0) {
    properties.title = definition3.title;
  }
  const result = { type: "element", tagName: "img", properties, children: [] };
  state.patch(node2, result);
  return state.applyData(node2, result);
}

function image(state, node2) {
  const properties = { src: normalizeUri(node2.url) };
  if (node2.alt !== null && node2.alt !== void 0) {
    properties.alt = node2.alt;
  }
  if (node2.title !== null && node2.title !== void 0) {
    properties.title = node2.title;
  }
  const result = { type: "element", tagName: "img", properties, children: [] };
  state.patch(node2, result);
  return state.applyData(node2, result);
}

function inlineCode(state, node2) {
  const text7 = { type: "text", value: node2.value.replace(/\r?\n|\r/g, " ") };
  state.patch(node2, text7);
  const result = {
    type: "element",
    tagName: "code",
    properties: {},
    children: [text7]
  };
  state.patch(node2, result);
  return state.applyData(node2, result);
}

function linkReference(state, node2) {
  const id = String(node2.identifier).toUpperCase();
  const definition3 = state.definitionById.get(id);
  if (!definition3) {
    return revert(state, node2);
  }
  const properties = { href: normalizeUri(definition3.url || "") };
  if (definition3.title !== null && definition3.title !== void 0) {
    properties.title = definition3.title;
  }
  const result = {
    type: "element",
    tagName: "a",
    properties,
    children: state.all(node2)
  };
  state.patch(node2, result);
  return state.applyData(node2, result);
}

function link(state, node2) {
  const properties = { href: normalizeUri(node2.url) };
  if (node2.title !== null && node2.title !== void 0) {
    properties.title = node2.title;
  }
  const result = {
    type: "element",
    tagName: "a",
    properties,
    children: state.all(node2)
  };
  state.patch(node2, result);
  return state.applyData(node2, result);
}

function listItem(state, node2, parent) {
  const results = state.all(node2);
  const loose = parent ? listLoose(parent) : listItemLoose(node2);
  const properties = {};
  const children = [];
  if (typeof node2.checked === "boolean") {
    const head = results[0];
    let paragraph3;
    if (head && head.type === "element" && head.tagName === "p") {
      paragraph3 = head;
    } else {
      paragraph3 = { type: "element", tagName: "p", properties: {}, children: [] };
      results.unshift(paragraph3);
    }
    if (paragraph3.children.length > 0) {
      paragraph3.children.unshift({ type: "text", value: " " });
    }
    paragraph3.children.unshift({
      type: "element",
      tagName: "input",
      properties: { type: "checkbox", checked: node2.checked, disabled: true },
      children: []
    });
    properties.className = ["task-list-item"];
  }
  let index3 = -1;
  while (++index3 < results.length) {
    const child = results[index3];
    if (loose || index3 !== 0 || child.type !== "element" || child.tagName !== "p") {
      children.push({ type: "text", value: "\n" });
    }
    if (child.type === "element" && child.tagName === "p" && !loose) {
      children.push(...child.children);
    } else {
      children.push(child);
    }
  }
  const tail = results[results.length - 1];
  if (tail && (loose || tail.type !== "element" || tail.tagName !== "p")) {
    children.push({ type: "text", value: "\n" });
  }
  const result = { type: "element", tagName: "li", properties, children };
  state.patch(node2, result);
  return state.applyData(node2, result);
}
function listLoose(node2) {
  let loose = false;
  if (node2.type === "list") {
    loose = node2.spread || false;
    const { children } = node2;
    let index3 = -1;
    while (!loose && ++index3 < children.length) {
      loose = listItemLoose(children[index3]);
    }
  }
  return loose;
}
function listItemLoose(node2) {
  const { spread } = node2;
  return spread === null || spread === void 0 ? node2.children.length > 1 : spread;
}

function list2(state, node2) {
  const properties = {};
  const results = state.all(node2);
  let index3 = -1;
  if (typeof node2.start === "number" && node2.start !== 1) {
    properties.start = node2.start;
  }
  while (++index3 < results.length) {
    const child = results[index3];
    if (child.type === "element" && child.tagName === "li" && child.properties && Array.isArray(child.properties.className) && child.properties.className.includes("task-list-item")) {
      properties.className = ["contains-task-list"];
      break;
    }
  }
  const result = {
    type: "element",
    tagName: node2.ordered ? "ol" : "ul",
    properties,
    children: state.wrap(results, true)
  };
  state.patch(node2, result);
  return state.applyData(node2, result);
}

function paragraph(state, node2) {
  const result = {
    type: "element",
    tagName: "p",
    properties: {},
    children: state.all(node2)
  };
  state.patch(node2, result);
  return state.applyData(node2, result);
}

function root2(state, node2) {
  const result = { type: "root", children: state.wrap(state.all(node2)) };
  state.patch(node2, result);
  return state.applyData(node2, result);
}

function strong(state, node2) {
  const result = {
    type: "element",
    tagName: "strong",
    properties: {},
    children: state.all(node2)
  };
  state.patch(node2, result);
  return state.applyData(node2, result);
}

function table(state, node2) {
  const rows = state.all(node2);
  const firstRow = rows.shift();
  const tableContent = [];
  if (firstRow) {
    const head = {
      type: "element",
      tagName: "thead",
      properties: {},
      children: state.wrap([firstRow], true)
    };
    state.patch(node2.children[0], head);
    tableContent.push(head);
  }
  if (rows.length > 0) {
    const body = {
      type: "element",
      tagName: "tbody",
      properties: {},
      children: state.wrap(rows, true)
    };
    const start2 = pointStart(node2.children[1]);
    const end = pointEnd(node2.children[node2.children.length - 1]);
    if (start2 && end) body.position = { start: start2, end };
    tableContent.push(body);
  }
  const result = {
    type: "element",
    tagName: "table",
    properties: {},
    children: state.wrap(tableContent, true)
  };
  state.patch(node2, result);
  return state.applyData(node2, result);
}

function tableRow(state, node2, parent) {
  const siblings = parent ? parent.children : void 0;
  const rowIndex = siblings ? siblings.indexOf(node2) : 1;
  const tagName = rowIndex === 0 ? "th" : "td";
  const align = parent && parent.type === "table" ? parent.align : void 0;
  const length = align ? align.length : node2.children.length;
  let cellIndex = -1;
  const cells = [];
  while (++cellIndex < length) {
    const cell = node2.children[cellIndex];
    const properties = {};
    const alignValue = align ? align[cellIndex] : void 0;
    if (alignValue) {
      properties.align = alignValue;
    }
    let result2 = { type: "element", tagName, properties, children: [] };
    if (cell) {
      result2.children = state.all(cell);
      state.patch(cell, result2);
      result2 = state.applyData(cell, result2);
    }
    cells.push(result2);
  }
  const result = {
    type: "element",
    tagName: "tr",
    properties: {},
    children: state.wrap(cells, true)
  };
  state.patch(node2, result);
  return state.applyData(node2, result);
}

function tableCell(state, node2) {
  const result = {
    type: "element",
    tagName: "td",
    // Assume body cell.
    properties: {},
    children: state.all(node2)
  };
  state.patch(node2, result);
  return state.applyData(node2, result);
}

var tab = 9;
var space = 32;
function trimLines(value) {
  const source = String(value);
  const search2 = /\r?\n|\r/g;
  let match = search2.exec(source);
  let last = 0;
  const lines = [];
  while (match) {
    lines.push(
      trimLine(source.slice(last, match.index), last > 0, true),
      match[0]
    );
    last = match.index + match[0].length;
    match = search2.exec(source);
  }
  lines.push(trimLine(source.slice(last), last > 0, false));
  return lines.join("");
}
function trimLine(value, start2, end) {
  let startIndex = 0;
  let endIndex = value.length;
  if (start2) {
    let code4 = value.codePointAt(startIndex);
    while (code4 === tab || code4 === space) {
      startIndex++;
      code4 = value.codePointAt(startIndex);
    }
  }
  if (end) {
    let code4 = value.codePointAt(endIndex - 1);
    while (code4 === tab || code4 === space) {
      endIndex--;
      code4 = value.codePointAt(endIndex - 1);
    }
  }
  return endIndex > startIndex ? value.slice(startIndex, endIndex) : "";
}

function text4(state, node2) {
  const result = { type: "text", value: trimLines(String(node2.value)) };
  state.patch(node2, result);
  return state.applyData(node2, result);
}

function thematicBreak2(state, node2) {
  const result = {
    type: "element",
    tagName: "hr",
    properties: {},
    children: []
  };
  state.patch(node2, result);
  return state.applyData(node2, result);
}

var handlers = {
  blockquote,
  break: hardBreak,
  code,
  delete: strikethrough,
  emphasis,
  footnoteReference,
  heading,
  html: html3,
  imageReference,
  image,
  inlineCode,
  linkReference,
  link,
  listItem,
  list: list2,
  paragraph,
  // @ts-expect-error: root is different, but hard to type.
  root: root2,
  strong,
  table,
  tableCell,
  tableRow,
  text: text4,
  thematicBreak: thematicBreak2,
  toml: ignore,
  yaml: ignore,
  definition: ignore,
  footnoteDefinition: ignore
};
function ignore() {
  return void 0;
}

var VOID = -1;
var PRIMITIVE = 0;
var ARRAY = 1;
var OBJECT = 2;
var DATE = 3;
var REGEXP = 4;
var MAP = 5;
var SET = 6;
var ERROR = 7;
var BIGINT = 8;

var { defineProperty } = Object;
var env = typeof self === "object" ? self : globalThis;
var guard = (name2, init) => {
  switch (name2) {
    case "Function":
    case "SharedWorker":
    case "Worker":
    case "eval":
    case "setInterval":
    case "setTimeout":
      throw new TypeError("unable to deserialize " + name2);
  }
  return new env[name2](init);
};
var deserializer = ($, _) => {
  const as = (out, index3) => {
    $.set(index3, out);
    return out;
  };
  const unpair = (index3) => {
    if ($.has(index3))
      return $.get(index3);
    const [type, value] = _[index3];
    switch (type) {
      case PRIMITIVE:
      case VOID:
        return as(value, index3);
      case ARRAY: {
        const arr = as([], index3);
        for (const index4 of value)
          arr.push(unpair(index4));
        return arr;
      }
      case OBJECT: {
        const object = as({}, index3);
        for (const [key, index4] of value) {
          const k = unpair(key), value2 = unpair(index4);
          if (k === "__proto__") defineProperty(object, k, {
            value: value2,
            configurable: true,
            enumerable: true,
            writable: true
          });
          else object[k] = value2;
        }
        return object;
      }
      case DATE:
        return as(new Date(value), index3);
      case REGEXP: {
        const { source, flags } = value;
        return as(new RegExp(source, flags), index3);
      }
      case MAP: {
        const map3 = as(/* @__PURE__ */ new Map(), index3);
        for (const [key, index4] of value)
          map3.set(unpair(key), unpair(index4));
        return map3;
      }
      case SET: {
        const set = as(/* @__PURE__ */ new Set(), index3);
        for (const index4 of value)
          set.add(unpair(index4));
        return set;
      }
      case ERROR: {
        const { name: name2, message } = value;
        return as(
          typeof env[name2] === "function" ? guard(name2, message) : new Error(message),
          index3
        );
      }
      case BIGINT:
        return as(BigInt(value), index3);
      case "BigInt":
        return as(Object(BigInt(value)), index3);
      case "ArrayBuffer":
        return as(new Uint8Array(value).buffer, value);
      case "DataView": {
        const { buffer } = new Uint8Array(value);
        return as(new DataView(buffer), value);
      }
      case "-0":
        return -0;
    }
    return as(guard(type, value), index3);
  };
  return unpair;
};
var deserialize = (serialized) => deserializer(/* @__PURE__ */ new Map(), serialized)(0);

var EMPTY = "";
var { toString: toString2 } = {};
var { keys, is } = Object;
var typeOf = (value) => {
  const type = typeof value;
  if (type !== "object" || !value)
    return [PRIMITIVE, type];
  const asString = toString2.call(value).slice(8, -1);
  switch (asString) {
    case "Array":
      return [ARRAY, EMPTY];
    case "Object":
      return [OBJECT, EMPTY];
    case "Date":
      return [DATE, EMPTY];
    case "RegExp":
      return [REGEXP, EMPTY];
    case "Map":
      return [MAP, EMPTY];
    case "Set":
      return [SET, EMPTY];
    case "DataView":
      return [ARRAY, asString];
  }
  if (asString.includes("Array"))
    return [ARRAY, asString];
  if (value instanceof Error)
    return [ERROR, value.name || "Error"];
  return [OBJECT, asString];
};
var shouldSkip = ([TYPE, type]) => TYPE === PRIMITIVE && (type === "function" || type === "symbol");
var serializer = (strict, json, $, _) => {
  const as = (out, value) => {
    const index3 = _.push(out) - 1;
    $.set(value, index3);
    return index3;
  };
  const pair2 = (value) => {
    if ($.has(value))
      return $.get(value);
    let [TYPE, type] = typeOf(value);
    switch (TYPE) {
      case PRIMITIVE: {
        let entry = value;
        switch (type) {
          case "bigint":
            TYPE = BIGINT;
            entry = value.toString();
            break;
          case "number":
            if (!value && is(value, -0))
              return _.push(["-0"]) - 1;
            break;
          case "function":
          case "symbol":
            if (strict)
              throw new TypeError("unable to serialize " + type);
            entry = null;
            break;
          case "undefined":
            return as([VOID], value);
        }
        return as([TYPE, entry], value);
      }
      case ARRAY: {
        if (type) {
          let spread = value;
          if (type === "DataView") {
            spread = new Uint8Array(value.buffer);
          } else if (type === "ArrayBuffer") {
            spread = new Uint8Array(value);
          }
          return as([type, [...spread]], value);
        }
        const arr = [];
        const index3 = as([TYPE, arr], value);
        for (const entry of value)
          arr.push(pair2(entry));
        return index3;
      }
      case OBJECT: {
        if (type) {
          switch (type) {
            case "BigInt":
              return as([type, value.toString()], value);
            case "Boolean":
            case "Number":
            case "String":
              return as([type, value.valueOf()], value);
          }
        }
        if (json && "toJSON" in value)
          return pair2(value.toJSON());
        const entries = [];
        const index3 = as([TYPE, entries], value);
        for (const key of keys(value)) {
          if (strict || !shouldSkip(typeOf(value[key])))
            entries.push([pair2(key), pair2(value[key])]);
        }
        return index3;
      }
      case DATE:
        return as([TYPE, isNaN(value.getTime()) ? EMPTY : value.toISOString()], value);
      case REGEXP: {
        const { source, flags } = value;
        return as([TYPE, { source, flags }], value);
      }
      case MAP: {
        const entries = [];
        const index3 = as([TYPE, entries], value);
        for (const [key, entry] of value) {
          if (strict || !(shouldSkip(typeOf(key)) || shouldSkip(typeOf(entry))))
            entries.push([pair2(key), pair2(entry)]);
        }
        return index3;
      }
      case SET: {
        const entries = [];
        const index3 = as([TYPE, entries], value);
        for (const entry of value) {
          if (strict || !shouldSkip(typeOf(entry)))
            entries.push(pair2(entry));
        }
        return index3;
      }
    }
    const { message } = value;
    return as([TYPE, { name: type, message }], value);
  };
  return pair2;
};
var serialize = (value, { json, lossy } = {}) => {
  const _ = [];
  return serializer(!(json || lossy), !!json, /* @__PURE__ */ new Map(), _)(value), _;
};

var esm_default = typeof structuredClone === "function" ? (
  /* c8 ignore start */
  (any, options) => options && ("json" in options || "lossy" in options) ? deserialize(serialize(any, options)) : structuredClone(any)
) : (any, options) => deserialize(serialize(any, options));

function defaultFootnoteBackContent(_, rereferenceIndex) {
  const result = [{ type: "text", value: "\u21A9" }];
  if (rereferenceIndex > 1) {
    result.push({
      type: "element",
      tagName: "sup",
      properties: {},
      children: [{ type: "text", value: String(rereferenceIndex) }]
    });
  }
  return result;
}
function defaultFootnoteBackLabel(referenceIndex, rereferenceIndex) {
  return "Back to reference " + (referenceIndex + 1) + (rereferenceIndex > 1 ? "-" + rereferenceIndex : "");
}
function footer(state) {
  const clobberPrefix = typeof state.options.clobberPrefix === "string" ? state.options.clobberPrefix : "user-content-";
  const footnoteBackContent = state.options.footnoteBackContent || defaultFootnoteBackContent;
  const footnoteBackLabel = state.options.footnoteBackLabel || defaultFootnoteBackLabel;
  const footnoteLabel = state.options.footnoteLabel || "Footnotes";
  const footnoteLabelTagName = state.options.footnoteLabelTagName || "h2";
  const footnoteLabelProperties = state.options.footnoteLabelProperties || {
    className: ["sr-only"]
  };
  const contents = [];
  const listItems = [];
  let referenceIndex = -1;
  while (++referenceIndex < state.footnoteOrder.length) {
    const definition3 = state.footnoteById.get(
      state.footnoteOrder[referenceIndex]
    );
    if (definition3) {
      contents[referenceIndex] = state.all(definition3);
    }
  }
  referenceIndex = -1;
  while (++referenceIndex < state.footnoteOrder.length) {
    const definition3 = state.footnoteById.get(
      state.footnoteOrder[referenceIndex]
    );
    if (!definition3) {
      continue;
    }
    const content3 = contents[referenceIndex];
    const id = String(definition3.identifier).toUpperCase();
    const safeId = normalizeUri(id.toLowerCase());
    let rereferenceIndex = 0;
    const backReferences = [];
    const counts = state.footnoteCounts.get(id);
    while (counts !== void 0 && ++rereferenceIndex <= counts) {
      if (backReferences.length > 0) {
        backReferences.push({ type: "text", value: " " });
      }
      let children = typeof footnoteBackContent === "string" ? footnoteBackContent : footnoteBackContent(referenceIndex, rereferenceIndex);
      if (typeof children === "string") {
        children = { type: "text", value: children };
      }
      backReferences.push({
        type: "element",
        tagName: "a",
        properties: {
          href: "#" + clobberPrefix + "fnref-" + safeId + (rereferenceIndex > 1 ? "-" + rereferenceIndex : ""),
          dataFootnoteBackref: "",
          ariaLabel: typeof footnoteBackLabel === "string" ? footnoteBackLabel : footnoteBackLabel(referenceIndex, rereferenceIndex),
          className: ["data-footnote-backref"]
        },
        children: Array.isArray(children) ? children : [children]
      });
    }
    const tail = content3[content3.length - 1];
    if (tail && tail.type === "element" && tail.tagName === "p") {
      const tailTail = tail.children[tail.children.length - 1];
      if (tailTail && tailTail.type === "text") {
        tailTail.value += " ";
      } else {
        tail.children.push({ type: "text", value: " " });
      }
      tail.children.push(...backReferences);
    } else {
      content3.push(...backReferences);
    }
    const listItem3 = {
      type: "element",
      tagName: "li",
      properties: { id: clobberPrefix + "fn-" + safeId },
      children: state.wrap(content3, true)
    };
    state.patch(definition3, listItem3);
    listItems.push(listItem3);
  }
  if (listItems.length === 0) {
    return;
  }
  return {
    type: "element",
    tagName: "section",
    properties: { dataFootnotes: true, className: ["footnotes"] },
    children: [
      {
        type: "element",
        tagName: footnoteLabelTagName,
        properties: {
          ...esm_default(footnoteLabelProperties),
          id: "footnote-label"
        },
        children: [{ type: "text", value: footnoteLabel }]
      },
      { type: "text", value: "\n" },
      {
        type: "element",
        tagName: "ol",
        properties: {},
        children: state.wrap(listItems, true)
      },
      { type: "text", value: "\n" }
    ]
  };
}

var convert = (
  // Note: overloads in JSDoc can’t yet use different `@template`s.
  /**
   * @type {(
   *   (<Condition extends string>(test: Condition) => (node: unknown, index?: number | null | undefined, parent?: Parent | null | undefined, context?: unknown) => node is Node & {type: Condition}) &
   *   (<Condition extends Props>(test: Condition) => (node: unknown, index?: number | null | undefined, parent?: Parent | null | undefined, context?: unknown) => node is Node & Condition) &
   *   (<Condition extends TestFunction>(test: Condition) => (node: unknown, index?: number | null | undefined, parent?: Parent | null | undefined, context?: unknown) => node is Node & Predicate<Condition, Node>) &
   *   ((test?: null | undefined) => (node?: unknown, index?: number | null | undefined, parent?: Parent | null | undefined, context?: unknown) => node is Node) &
   *   ((test?: Test) => Check)
   * )}
   */
  /**
   * @param {Test} [test]
   * @returns {Check}
   */
  function(test) {
    if (test === null || test === void 0) {
      return ok2;
    }
    if (typeof test === "function") {
      return castFactory(test);
    }
    if (typeof test === "object") {
      return Array.isArray(test) ? anyFactory(test) : (
        // Cast because `ReadonlyArray` goes into the above but `isArray`
        // narrows to `Array`.
        propertiesFactory(
          /** @type {Props} */
          test
        )
      );
    }
    if (typeof test === "string") {
      return typeFactory(test);
    }
    throw new Error("Expected function, string, or object as test");
  }
);
function anyFactory(tests) {
  const checks2 = [];
  let index3 = -1;
  while (++index3 < tests.length) {
    checks2[index3] = convert(tests[index3]);
  }
  return castFactory(any);
  function any(...parameters) {
    let index4 = -1;
    while (++index4 < checks2.length) {
      if (checks2[index4].apply(this, parameters)) return true;
    }
    return false;
  }
}
function propertiesFactory(check2) {
  const checkAsRecord = (
    /** @type {Record<string, unknown>} */
    check2
  );
  return castFactory(all2);
  function all2(node2) {
    const nodeAsRecord = (
      /** @type {Record<string, unknown>} */
      /** @type {unknown} */
      node2
    );
    let key;
    for (key in check2) {
      if (nodeAsRecord[key] !== checkAsRecord[key]) return false;
    }
    return true;
  }
}
function typeFactory(check2) {
  return castFactory(type);
  function type(node2) {
    return node2 && node2.type === check2;
  }
}
function castFactory(testFunction) {
  return check2;
  function check2(value, index3, parent) {
    return Boolean(
      looksLikeANode(value) && testFunction.call(
        this,
        value,
        typeof index3 === "number" ? index3 : void 0,
        parent || void 0
      )
    );
  }
}
function ok2() {
  return true;
}
function looksLikeANode(value) {
  return value !== null && typeof value === "object" && "type" in value;
}

function color(d) {
  return d;
}

var empty2 = [];
var CONTINUE = true;
var EXIT = false;
var SKIP = "skip";
function visitParents(tree, testOrEnterOrVisitors, enterOrVisitorsOrReverse, reverse) {
  if (!tree || typeof tree !== "object") {
    throw new Error("Unexpected value `" + tree + "` for `tree`, expected node");
  }
  let preorder = true;
  let check2;
  let visitors;
  let enter;
  let exit3;
  if (typeof enterOrVisitorsOrReverse === "function" || enterOrVisitorsOrReverse && typeof enterOrVisitorsOrReverse === "object") {
    check2 = /** @type {Test} */
    testOrEnterOrVisitors;
    visitors = enterOrVisitorsOrReverse;
    if (reverse) preorder = false;
  } else {
    visitors = /** @type {Visitors | Visitor} */
    testOrEnterOrVisitors;
    if (enterOrVisitorsOrReverse) preorder = false;
  }
  if (typeof visitors === "function") {
    enter = visitors;
  } else if (visitors && typeof visitors === "object") {
    if (visitors.enter === null || visitors.enter === void 0) {
    } else if (typeof visitors.enter === "function") {
      enter = visitors.enter;
    } else {
      throw new Error(
        "Unexpected value `" + visitors.enter + "` for `visitors.enter`, expected optional visitor"
      );
    }
    if (typeof visitors.exit === "function") {
      exit3 = visitors.exit;
    } else {
      throw new Error(
        "Unexpected value `" + visitors.exit + "` for `visitors.exit`, expected visitor (pass a visitor directly if you only want an enter visitor)"
      );
    }
  } else {
    throw new Error(
      "Unexpected value `" + visitors + "` for `enter` or `visitors`, expected visitor or object with visitors"
    );
  }
  const is3 = convert(check2);
  const step = preorder ? 1 : -1;
  factory(tree, void 0, [])();
  function factory(node2, index3, parents) {
    const value = (
      /** @type {Record<string, unknown>} */
      node2 && typeof node2 === "object" ? node2 : {}
    );
    if (typeof value.type === "string") {
      const name2 = (
        // `hast`
        typeof value.tagName === "string" ? value.tagName : (
          // `xast`
          typeof value.name === "string" ? value.name : void 0
        )
      );
      Object.defineProperty(visit2, "name", {
        value: "node (" + color(node2.type + (name2 ? "<" + name2 + ">" : "")) + ")"
      });
    }
    return visit2;
    function visit2() {
      const matches = !check2 || is3(node2, index3, parents[parents.length - 1] || void 0);
      let result = empty2;
      if (enter && matches) {
        result = toResult(enter(node2, parents, index3));
        if (result[0] === EXIT) {
          return result;
        }
      }
      if ("children" in node2 && node2.children) {
        const nodeAsParent = (
          /** @type {UnistParent} */
          node2
        );
        if (nodeAsParent.children && result[0] !== SKIP) {
          let offset = (preorder ? -1 : nodeAsParent.children.length) + step;
          const grandparents = [...parents, nodeAsParent];
          while (offset > -1 && offset < nodeAsParent.children.length) {
            const child = nodeAsParent.children[offset];
            const subresult = factory(child, offset, grandparents)();
            if (subresult[0] === EXIT) {
              return subresult;
            }
            offset = typeof subresult[1] === "number" ? subresult[1] : offset + step;
          }
        }
      }
      if (exit3 && matches) {
        const exitResult = toResult(exit3(node2, parents, index3));
        if (exitResult[0] === SKIP) {
          throw new Error(
            "Unexpected value `" + exitResult[0] + "` from `exit`, expected `CONTINUE`, `EXIT`, index, or nothing"
          );
        }
        if (exitResult[0] === EXIT || typeof exitResult[1] === "number") {
          return exitResult;
        }
      }
      return result;
    }
  }
}
function toResult(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "number") {
    return [CONTINUE, value];
  }
  return value === null || value === void 0 ? empty2 : [value];
}

function visit(tree, testOrEnterOrVisitors, enterOrVisitorsOrReverse, maybeReverse) {
  let check2;
  let visitors;
  let reverse;
  if (typeof enterOrVisitorsOrReverse === "function" || enterOrVisitorsOrReverse && typeof enterOrVisitorsOrReverse === "object") {
    check2 = /** @type {Test} */
    testOrEnterOrVisitors;
    visitors = enterOrVisitorsOrReverse;
    reverse = maybeReverse;
  } else {
    visitors = /** @type {Visitor | Visitors} */
    testOrEnterOrVisitors;
    reverse = enterOrVisitorsOrReverse;
  }
  if (typeof visitors === "function") {
    visitParents(tree, check2, wrap(visitors), reverse);
  } else {
    visitParents(tree, check2, wrapVisitors(visitors), reverse);
  }
}
function wrapVisitors(visitors) {
  if (!visitors || typeof visitors !== "object") return visitors;
  return {
    enter: typeof visitors.enter === "function" ? wrap(visitors.enter) : visitors.enter,
    exit: typeof visitors.exit === "function" ? wrap(visitors.exit) : visitors.exit
  };
}
function wrap(visitor) {
  return overload;
  function overload(node2, parents, index3) {
    return visitor(node2, index3, parents[parents.length - 1]);
  }
}

var own4 = {}.hasOwnProperty;
var emptyOptions3 = {};
function createState(tree, options) {
  const settings = options || emptyOptions3;
  const definitionById = /* @__PURE__ */ new Map();
  const footnoteById = /* @__PURE__ */ new Map();
  const footnoteCounts = /* @__PURE__ */ new Map();
  const handlers2 = { ...handlers, ...settings.handlers };
  const state = {
    all: all2,
    applyData,
    definitionById,
    footnoteById,
    footnoteCounts,
    footnoteOrder: [],
    handlers: handlers2,
    one: one3,
    options: settings,
    patch,
    wrap: wrap2
  };
  visit(tree, function(node2) {
    if (node2.type === "definition" || node2.type === "footnoteDefinition") {
      const id = String(node2.identifier).toUpperCase();
      if (node2.type === "definition") {
        if (!definitionById.has(id)) {
          definitionById.set(id, node2);
        }
      } else if (!footnoteById.has(id)) {
        footnoteById.set(id, node2);
      }
    }
  });
  return state;
  function one3(node2, parent) {
    const { type } = node2;
    const handle2 = state.handlers[type];
    if (own4.call(state.handlers, type) && handle2) {
      return handle2(state, node2, parent);
    }
    if (state.options.passThrough && state.options.passThrough.includes(type)) {
      if ("children" in node2) {
        const { children, ...shallow } = node2;
        return { ...esm_default(shallow), children: state.all(node2) };
      }
      return esm_default(node2);
    }
    const unknown = state.options.unknownHandler || defaultUnknownHandler;
    return unknown(state, node2, parent);
  }
  function all2(parent) {
    const values = [];
    if ("children" in parent) {
      const nodes = parent.children;
      let index3 = -1;
      while (++index3 < nodes.length) {
        const result = state.one(nodes[index3], parent);
        if (result) {
          if (index3 && nodes[index3 - 1].type === "break") {
            if (!Array.isArray(result) && result.type === "text") {
              result.value = trimMarkdownSpaceStart(result.value);
            }
            if (!Array.isArray(result) && result.type === "element") {
              const head = result.children[0];
              if (head && head.type === "text") {
                head.value = trimMarkdownSpaceStart(head.value);
              }
            }
          }
          if (Array.isArray(result)) {
            values.push(...result);
          } else {
            values.push(result);
          }
        }
      }
    }
    return values;
  }
}
function patch(from, to) {
  if (from.position) to.position = position(from);
}
function applyData(from, to) {
  let result = to;
  if (from && from.data) {
    const { hChildren, hName, hProperties } = from.data;
    if (typeof hName === "string") {
      if (result.type === "element") {
        result.tagName = hName;
      } else {
        const children = "children" in result ? result.children : [result];
        result = { type: "element", tagName: hName, properties: {}, children };
      }
    }
    if (result.type === "element" && hProperties) {
      Object.assign(result.properties, esm_default(hProperties));
    }
    if ("children" in result && result.children && hChildren !== null && hChildren !== void 0) {
      result.children = hChildren;
    }
  }
  return result;
}
function defaultUnknownHandler(state, node2) {
  const data = node2.data || {};
  const result = "value" in node2 && !(own4.call(data, "hProperties") || own4.call(data, "hChildren")) ? { type: "text", value: node2.value } : {
    type: "element",
    tagName: "div",
    properties: {},
    children: state.all(node2)
  };
  state.patch(node2, result);
  return state.applyData(node2, result);
}
function wrap2(nodes, loose) {
  const result = [];
  let index3 = -1;
  if (loose) {
    result.push({ type: "text", value: "\n" });
  }
  while (++index3 < nodes.length) {
    if (index3) result.push({ type: "text", value: "\n" });
    result.push(nodes[index3]);
  }
  if (loose && nodes.length > 0) {
    result.push({ type: "text", value: "\n" });
  }
  return result;
}
function trimMarkdownSpaceStart(value) {
  let index3 = 0;
  let code4 = value.charCodeAt(index3);
  while (code4 === 9 || code4 === 32) {
    index3++;
    code4 = value.charCodeAt(index3);
  }
  return value.slice(index3);
}

function toHast(tree, options) {
  const state = createState(tree, options);
  const node2 = state.one(tree, void 0);
  const foot = footer(state);
  const result = Array.isArray(node2) ? { type: "root", children: node2 } : node2 || { type: "root", children: [] };
  if (foot) {
    ok("children" in result);
    result.children.push({ type: "text", value: "\n" }, foot);
  }
  return result;
}

function remarkRehype(destination, options) {
  if (destination && "run" in destination) {
    return async function(tree, file) {
      const hastTree = (
        /** @type {HastRoot} */
        toHast(tree, { file, ...options })
      );
      await destination.run(hastTree, file);
    };
  }
  return function(tree, file) {
    return (
      /** @type {HastRoot} */
      toHast(tree, { file, ...destination || options })
    );
  };
}

function bail(error) {
  if (error) {
    throw error;
  }
}

var import_extend = __toESM(require_extend(), 1);

function isPlainObject(value) {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return (prototype === null || prototype === Object.prototype || Object.getPrototypeOf(prototype) === null) && !(Symbol.toStringTag in value) && !(Symbol.iterator in value);
}

function trough() {
  const fns = [];
  const pipeline = { run, use };
  return pipeline;
  function run(...values) {
    let middlewareIndex = -1;
    const callback = values.pop();
    if (typeof callback !== "function") {
      throw new TypeError("Expected function as last argument, not " + callback);
    }
    next(null, ...values);
    function next(error, ...output) {
      const fn = fns[++middlewareIndex];
      let index3 = -1;
      if (error) {
        callback(error);
        return;
      }
      while (++index3 < values.length) {
        if (output[index3] === null || output[index3] === void 0) {
          output[index3] = values[index3];
        }
      }
      values = output;
      if (fn) {
        wrap3(fn, next)(...output);
      } else {
        callback(null, ...output);
      }
    }
  }
  function use(middelware) {
    if (typeof middelware !== "function") {
      throw new TypeError(
        "Expected `middelware` to be a function, not " + middelware
      );
    }
    fns.push(middelware);
    return pipeline;
  }
}
function wrap3(middleware, callback) {
  let called;
  return wrapped;
  function wrapped(...parameters) {
    const fnExpectsCallback = middleware.length > parameters.length;
    let result;
    if (fnExpectsCallback) {
      parameters.push(done);
    }
    try {
      result = middleware.apply(this, parameters);
    } catch (error) {
      const exception = (
        /** @type {Error} */
        error
      );
      if (fnExpectsCallback && called) {
        throw exception;
      }
      return done(exception);
    }
    if (!fnExpectsCallback) {
      if (result && result.then && typeof result.then === "function") {
        result.then(then, done);
      } else if (result instanceof Error) {
        done(result);
      } else {
        then(result);
      }
    }
  }
  function done(error, ...output) {
    if (!called) {
      called = true;
      callback(error, ...output);
    }
  }
  function then(value) {
    done(null, value);
  }
}

var minpath = { basename, dirname, extname, join, sep: "/" };
function basename(path2, extname2) {
  if (extname2 !== void 0 && typeof extname2 !== "string") {
    throw new TypeError('"ext" argument must be a string');
  }
  assertPath(path2);
  let start2 = 0;
  let end = -1;
  let index3 = path2.length;
  let seenNonSlash;
  if (extname2 === void 0 || extname2.length === 0 || extname2.length > path2.length) {
    while (index3--) {
      if (path2.codePointAt(index3) === 47) {
        if (seenNonSlash) {
          start2 = index3 + 1;
          break;
        }
      } else if (end < 0) {
        seenNonSlash = true;
        end = index3 + 1;
      }
    }
    return end < 0 ? "" : path2.slice(start2, end);
  }
  if (extname2 === path2) {
    return "";
  }
  let firstNonSlashEnd = -1;
  let extnameIndex = extname2.length - 1;
  while (index3--) {
    if (path2.codePointAt(index3) === 47) {
      if (seenNonSlash) {
        start2 = index3 + 1;
        break;
      }
    } else {
      if (firstNonSlashEnd < 0) {
        seenNonSlash = true;
        firstNonSlashEnd = index3 + 1;
      }
      if (extnameIndex > -1) {
        if (path2.codePointAt(index3) === extname2.codePointAt(extnameIndex--)) {
          if (extnameIndex < 0) {
            end = index3;
          }
        } else {
          extnameIndex = -1;
          end = firstNonSlashEnd;
        }
      }
    }
  }
  if (start2 === end) {
    end = firstNonSlashEnd;
  } else if (end < 0) {
    end = path2.length;
  }
  return path2.slice(start2, end);
}
function dirname(path2) {
  assertPath(path2);
  if (path2.length === 0) {
    return ".";
  }
  let end = -1;
  let index3 = path2.length;
  let unmatchedSlash;
  while (--index3) {
    if (path2.codePointAt(index3) === 47) {
      if (unmatchedSlash) {
        end = index3;
        break;
      }
    } else if (!unmatchedSlash) {
      unmatchedSlash = true;
    }
  }
  return end < 0 ? path2.codePointAt(0) === 47 ? "/" : "." : end === 1 && path2.codePointAt(0) === 47 ? "//" : path2.slice(0, end);
}
function extname(path2) {
  assertPath(path2);
  let index3 = path2.length;
  let end = -1;
  let startPart = 0;
  let startDot = -1;
  let preDotState = 0;
  let unmatchedSlash;
  while (index3--) {
    const code4 = path2.codePointAt(index3);
    if (code4 === 47) {
      if (unmatchedSlash) {
        startPart = index3 + 1;
        break;
      }
      continue;
    }
    if (end < 0) {
      unmatchedSlash = true;
      end = index3 + 1;
    }
    if (code4 === 46) {
      if (startDot < 0) {
        startDot = index3;
      } else if (preDotState !== 1) {
        preDotState = 1;
      }
    } else if (startDot > -1) {
      preDotState = -1;
    }
  }
  if (startDot < 0 || end < 0 || // We saw a non-dot character immediately before the dot.
  preDotState === 0 || // The (right-most) trimmed path component is exactly `..`.
  preDotState === 1 && startDot === end - 1 && startDot === startPart + 1) {
    return "";
  }
  return path2.slice(startDot, end);
}
function join(...segments) {
  let index3 = -1;
  let joined;
  while (++index3 < segments.length) {
    assertPath(segments[index3]);
    if (segments[index3]) {
      joined = joined === void 0 ? segments[index3] : joined + "/" + segments[index3];
    }
  }
  return joined === void 0 ? "." : normalize2(joined);
}
function normalize2(path2) {
  assertPath(path2);
  const absolute = path2.codePointAt(0) === 47;
  let value = normalizeString(path2, !absolute);
  if (value.length === 0 && !absolute) {
    value = ".";
  }
  if (value.length > 0 && path2.codePointAt(path2.length - 1) === 47) {
    value += "/";
  }
  return absolute ? "/" + value : value;
}
function normalizeString(path2, allowAboveRoot) {
  let result = "";
  let lastSegmentLength = 0;
  let lastSlash = -1;
  let dots = 0;
  let index3 = -1;
  let code4;
  let lastSlashIndex;
  while (++index3 <= path2.length) {
    if (index3 < path2.length) {
      code4 = path2.codePointAt(index3);
    } else if (code4 === 47) {
      break;
    } else {
      code4 = 47;
    }
    if (code4 === 47) {
      if (lastSlash === index3 - 1 || dots === 1) {
      } else if (lastSlash !== index3 - 1 && dots === 2) {
        if (result.length < 2 || lastSegmentLength !== 2 || result.codePointAt(result.length - 1) !== 46 || result.codePointAt(result.length - 2) !== 46) {
          if (result.length > 2) {
            lastSlashIndex = result.lastIndexOf("/");
            if (lastSlashIndex !== result.length - 1) {
              if (lastSlashIndex < 0) {
                result = "";
                lastSegmentLength = 0;
              } else {
                result = result.slice(0, lastSlashIndex);
                lastSegmentLength = result.length - 1 - result.lastIndexOf("/");
              }
              lastSlash = index3;
              dots = 0;
              continue;
            }
          } else if (result.length > 0) {
            result = "";
            lastSegmentLength = 0;
            lastSlash = index3;
            dots = 0;
            continue;
          }
        }
        if (allowAboveRoot) {
          result = result.length > 0 ? result + "/.." : "..";
          lastSegmentLength = 2;
        }
      } else {
        if (result.length > 0) {
          result += "/" + path2.slice(lastSlash + 1, index3);
        } else {
          result = path2.slice(lastSlash + 1, index3);
        }
        lastSegmentLength = index3 - lastSlash - 1;
      }
      lastSlash = index3;
      dots = 0;
    } else if (code4 === 46 && dots > -1) {
      dots++;
    } else {
      dots = -1;
    }
  }
  return result;
}
function assertPath(path2) {
  if (typeof path2 !== "string") {
    throw new TypeError(
      "Path must be a string. Received " + JSON.stringify(path2)
    );
  }
}

var minproc = { cwd };
function cwd() {
  return "/";
}

function isUrl(fileUrlOrPath) {
  return Boolean(
    fileUrlOrPath !== null && typeof fileUrlOrPath === "object" && "href" in fileUrlOrPath && fileUrlOrPath.href && "protocol" in fileUrlOrPath && fileUrlOrPath.protocol && // @ts-expect-error: indexing is fine.
    fileUrlOrPath.auth === void 0
  );
}

function urlToPath(path2) {
  if (typeof path2 === "string") {
    path2 = new URL(path2);
  } else if (!isUrl(path2)) {
    const error = new TypeError(
      'The "path" argument must be of type string or an instance of URL. Received `' + path2 + "`"
    );
    error.code = "ERR_INVALID_ARG_TYPE";
    throw error;
  }
  if (path2.protocol !== "file:") {
    const error = new TypeError("The URL must be of scheme file");
    error.code = "ERR_INVALID_URL_SCHEME";
    throw error;
  }
  return getPathFromURLPosix(path2);
}
function getPathFromURLPosix(url) {
  if (url.hostname !== "") {
    const error = new TypeError(
      'File URL host must be "localhost" or empty on darwin'
    );
    error.code = "ERR_INVALID_FILE_URL_HOST";
    throw error;
  }
  const pathname = url.pathname;
  let index3 = -1;
  while (++index3 < pathname.length) {
    if (pathname.codePointAt(index3) === 37 && pathname.codePointAt(index3 + 1) === 50) {
      const third = pathname.codePointAt(index3 + 2);
      if (third === 70 || third === 102) {
        const error = new TypeError(
          "File URL path must not include encoded / characters"
        );
        error.code = "ERR_INVALID_FILE_URL_PATH";
        throw error;
      }
    }
  }
  return decodeURIComponent(pathname);
}

var order = (
  /** @type {const} */
  [
    "history",
    "path",
    "basename",
    "stem",
    "extname",
    "dirname"
  ]
);
var VFile = class {
  /**
   * Create a new virtual file.
   *
   * `options` is treated as:
   *
   * *   `string` or `Uint8Array` — `{value: options}`
   * *   `URL` — `{path: options}`
   * *   `VFile` — shallow copies its data over to the new file
   * *   `object` — all fields are shallow copied over to the new file
   *
   * Path related fields are set in the following order (least specific to
   * most specific): `history`, `path`, `basename`, `stem`, `extname`,
   * `dirname`.
   *
   * You cannot set `dirname` or `extname` without setting either `history`,
   * `path`, `basename`, or `stem` too.
   *
   * @param {Compatible | null | undefined} [value]
   *   File value.
   * @returns
   *   New instance.
   */
  constructor(value) {
    let options;
    if (!value) {
      options = {};
    } else if (isUrl(value)) {
      options = { path: value };
    } else if (typeof value === "string" || isUint8Array(value)) {
      options = { value };
    } else {
      options = value;
    }
    this.cwd = "cwd" in options ? "" : minproc.cwd();
    this.data = {};
    this.history = [];
    this.messages = [];
    this.value;
    this.map;
    this.result;
    this.stored;
    let index3 = -1;
    while (++index3 < order.length) {
      const field2 = order[index3];
      if (field2 in options && options[field2] !== void 0 && options[field2] !== null) {
        this[field2] = field2 === "history" ? [...options[field2]] : options[field2];
      }
    }
    let field;
    for (field in options) {
      if (!order.includes(field)) {
        this[field] = options[field];
      }
    }
  }
  /**
   * Get the basename (including extname) (example: `'index.min.js'`).
   *
   * @returns {string | undefined}
   *   Basename.
   */
  get basename() {
    return typeof this.path === "string" ? minpath.basename(this.path) : void 0;
  }
  /**
   * Set basename (including extname) (`'index.min.js'`).
   *
   * Cannot contain path separators (`'/'` on unix, macOS, and browsers, `'\'`
   * on windows).
   * Cannot be nullified (use `file.path = file.dirname` instead).
   *
   * @param {string} basename
   *   Basename.
   * @returns {undefined}
   *   Nothing.
   */
  set basename(basename2) {
    assertNonEmpty(basename2, "basename");
    assertPart(basename2, "basename");
    this.path = minpath.join(this.dirname || "", basename2);
  }
  /**
   * Get the parent path (example: `'~'`).
   *
   * @returns {string | undefined}
   *   Dirname.
   */
  get dirname() {
    return typeof this.path === "string" ? minpath.dirname(this.path) : void 0;
  }
  /**
   * Set the parent path (example: `'~'`).
   *
   * Cannot be set if there’s no `path` yet.
   *
   * @param {string | undefined} dirname
   *   Dirname.
   * @returns {undefined}
   *   Nothing.
   */
  set dirname(dirname2) {
    assertPath2(this.basename, "dirname");
    this.path = minpath.join(dirname2 || "", this.basename);
  }
  /**
   * Get the extname (including dot) (example: `'.js'`).
   *
   * @returns {string | undefined}
   *   Extname.
   */
  get extname() {
    return typeof this.path === "string" ? minpath.extname(this.path) : void 0;
  }
  /**
   * Set the extname (including dot) (example: `'.js'`).
   *
   * Cannot contain path separators (`'/'` on unix, macOS, and browsers, `'\'`
   * on windows).
   * Cannot be set if there’s no `path` yet.
   *
   * @param {string | undefined} extname
   *   Extname.
   * @returns {undefined}
   *   Nothing.
   */
  set extname(extname2) {
    assertPart(extname2, "extname");
    assertPath2(this.dirname, "extname");
    if (extname2) {
      if (extname2.codePointAt(0) !== 46) {
        throw new Error("`extname` must start with `.`");
      }
      if (extname2.includes(".", 1)) {
        throw new Error("`extname` cannot contain multiple dots");
      }
    }
    this.path = minpath.join(this.dirname, this.stem + (extname2 || ""));
  }
  /**
   * Get the full path (example: `'~/index.min.js'`).
   *
   * @returns {string}
   *   Path.
   */
  get path() {
    return this.history[this.history.length - 1];
  }
  /**
   * Set the full path (example: `'~/index.min.js'`).
   *
   * Cannot be nullified.
   * You can set a file URL (a `URL` object with a `file:` protocol) which will
   * be turned into a path with `url.fileURLToPath`.
   *
   * @param {URL | string} path
   *   Path.
   * @returns {undefined}
   *   Nothing.
   */
  set path(path2) {
    if (isUrl(path2)) {
      path2 = urlToPath(path2);
    }
    assertNonEmpty(path2, "path");
    if (this.path !== path2) {
      this.history.push(path2);
    }
  }
  /**
   * Get the stem (basename w/o extname) (example: `'index.min'`).
   *
   * @returns {string | undefined}
   *   Stem.
   */
  get stem() {
    return typeof this.path === "string" ? minpath.basename(this.path, this.extname) : void 0;
  }
  /**
   * Set the stem (basename w/o extname) (example: `'index.min'`).
   *
   * Cannot contain path separators (`'/'` on unix, macOS, and browsers, `'\'`
   * on windows).
   * Cannot be nullified (use `file.path = file.dirname` instead).
   *
   * @param {string} stem
   *   Stem.
   * @returns {undefined}
   *   Nothing.
   */
  set stem(stem) {
    assertNonEmpty(stem, "stem");
    assertPart(stem, "stem");
    this.path = minpath.join(this.dirname || "", stem + (this.extname || ""));
  }
  // Normal prototypal methods.
  /**
   * Create a fatal message for `reason` associated with the file.
   *
   * The `fatal` field of the message is set to `true` (error; file not usable)
   * and the `file` field is set to the current file path.
   * The message is added to the `messages` field on `file`.
   *
   * > 🪦 **Note**: also has obsolete signatures.
   *
   * @overload
   * @param {string} reason
   * @param {MessageOptions | null | undefined} [options]
   * @returns {never}
   *
   * @overload
   * @param {string} reason
   * @param {Node | NodeLike | null | undefined} parent
   * @param {string | null | undefined} [origin]
   * @returns {never}
   *
   * @overload
   * @param {string} reason
   * @param {Point | Position | null | undefined} place
   * @param {string | null | undefined} [origin]
   * @returns {never}
   *
   * @overload
   * @param {string} reason
   * @param {string | null | undefined} [origin]
   * @returns {never}
   *
   * @overload
   * @param {Error | VFileMessage} cause
   * @param {Node | NodeLike | null | undefined} parent
   * @param {string | null | undefined} [origin]
   * @returns {never}
   *
   * @overload
   * @param {Error | VFileMessage} cause
   * @param {Point | Position | null | undefined} place
   * @param {string | null | undefined} [origin]
   * @returns {never}
   *
   * @overload
   * @param {Error | VFileMessage} cause
   * @param {string | null | undefined} [origin]
   * @returns {never}
   *
   * @param {Error | VFileMessage | string} causeOrReason
   *   Reason for message, should use markdown.
   * @param {Node | NodeLike | MessageOptions | Point | Position | string | null | undefined} [optionsOrParentOrPlace]
   *   Configuration (optional).
   * @param {string | null | undefined} [origin]
   *   Place in code where the message originates (example:
   *   `'my-package:my-rule'` or `'my-rule'`).
   * @returns {never}
   *   Never.
   * @throws {VFileMessage}
   *   Message.
   */
  fail(causeOrReason, optionsOrParentOrPlace, origin) {
    const message = this.message(causeOrReason, optionsOrParentOrPlace, origin);
    message.fatal = true;
    throw message;
  }
  /**
   * Create an info message for `reason` associated with the file.
   *
   * The `fatal` field of the message is set to `undefined` (info; change
   * likely not needed) and the `file` field is set to the current file path.
   * The message is added to the `messages` field on `file`.
   *
   * > 🪦 **Note**: also has obsolete signatures.
   *
   * @overload
   * @param {string} reason
   * @param {MessageOptions | null | undefined} [options]
   * @returns {VFileMessage}
   *
   * @overload
   * @param {string} reason
   * @param {Node | NodeLike | null | undefined} parent
   * @param {string | null | undefined} [origin]
   * @returns {VFileMessage}
   *
   * @overload
   * @param {string} reason
   * @param {Point | Position | null | undefined} place
   * @param {string | null | undefined} [origin]
   * @returns {VFileMessage}
   *
   * @overload
   * @param {string} reason
   * @param {string | null | undefined} [origin]
   * @returns {VFileMessage}
   *
   * @overload
   * @param {Error | VFileMessage} cause
   * @param {Node | NodeLike | null | undefined} parent
   * @param {string | null | undefined} [origin]
   * @returns {VFileMessage}
   *
   * @overload
   * @param {Error | VFileMessage} cause
   * @param {Point | Position | null | undefined} place
   * @param {string | null | undefined} [origin]
   * @returns {VFileMessage}
   *
   * @overload
   * @param {Error | VFileMessage} cause
   * @param {string | null | undefined} [origin]
   * @returns {VFileMessage}
   *
   * @param {Error | VFileMessage | string} causeOrReason
   *   Reason for message, should use markdown.
   * @param {Node | NodeLike | MessageOptions | Point | Position | string | null | undefined} [optionsOrParentOrPlace]
   *   Configuration (optional).
   * @param {string | null | undefined} [origin]
   *   Place in code where the message originates (example:
   *   `'my-package:my-rule'` or `'my-rule'`).
   * @returns {VFileMessage}
   *   Message.
   */
  info(causeOrReason, optionsOrParentOrPlace, origin) {
    const message = this.message(causeOrReason, optionsOrParentOrPlace, origin);
    message.fatal = void 0;
    return message;
  }
  /**
   * Create a message for `reason` associated with the file.
   *
   * The `fatal` field of the message is set to `false` (warning; change may be
   * needed) and the `file` field is set to the current file path.
   * The message is added to the `messages` field on `file`.
   *
   * > 🪦 **Note**: also has obsolete signatures.
   *
   * @overload
   * @param {string} reason
   * @param {MessageOptions | null | undefined} [options]
   * @returns {VFileMessage}
   *
   * @overload
   * @param {string} reason
   * @param {Node | NodeLike | null | undefined} parent
   * @param {string | null | undefined} [origin]
   * @returns {VFileMessage}
   *
   * @overload
   * @param {string} reason
   * @param {Point | Position | null | undefined} place
   * @param {string | null | undefined} [origin]
   * @returns {VFileMessage}
   *
   * @overload
   * @param {string} reason
   * @param {string | null | undefined} [origin]
   * @returns {VFileMessage}
   *
   * @overload
   * @param {Error | VFileMessage} cause
   * @param {Node | NodeLike | null | undefined} parent
   * @param {string | null | undefined} [origin]
   * @returns {VFileMessage}
   *
   * @overload
   * @param {Error | VFileMessage} cause
   * @param {Point | Position | null | undefined} place
   * @param {string | null | undefined} [origin]
   * @returns {VFileMessage}
   *
   * @overload
   * @param {Error | VFileMessage} cause
   * @param {string | null | undefined} [origin]
   * @returns {VFileMessage}
   *
   * @param {Error | VFileMessage | string} causeOrReason
   *   Reason for message, should use markdown.
   * @param {Node | NodeLike | MessageOptions | Point | Position | string | null | undefined} [optionsOrParentOrPlace]
   *   Configuration (optional).
   * @param {string | null | undefined} [origin]
   *   Place in code where the message originates (example:
   *   `'my-package:my-rule'` or `'my-rule'`).
   * @returns {VFileMessage}
   *   Message.
   */
  message(causeOrReason, optionsOrParentOrPlace, origin) {
    const message = new VFileMessage(
      // @ts-expect-error: the overloads are fine.
      causeOrReason,
      optionsOrParentOrPlace,
      origin
    );
    if (this.path) {
      message.name = this.path + ":" + message.name;
      message.file = this.path;
    }
    message.fatal = false;
    this.messages.push(message);
    return message;
  }
  /**
   * Serialize the file.
   *
   * > **Note**: which encodings are supported depends on the engine.
   * > For info on Node.js, see:
   * > <https://nodejs.org/api/util.html#whatwg-supported-encodings>.
   *
   * @param {string | null | undefined} [encoding='utf8']
   *   Character encoding to understand `value` as when it’s a `Uint8Array`
   *   (default: `'utf-8'`).
   * @returns {string}
   *   Serialized file.
   */
  toString(encoding) {
    if (this.value === void 0) {
      return "";
    }
    if (typeof this.value === "string") {
      return this.value;
    }
    const decoder = new TextDecoder(encoding || void 0);
    return decoder.decode(this.value);
  }
};
function assertPart(part, name2) {
  if (part && part.includes(minpath.sep)) {
    throw new Error(
      "`" + name2 + "` cannot be a path: did not expect `" + minpath.sep + "`"
    );
  }
}
function assertNonEmpty(part, name2) {
  if (!part) {
    throw new Error("`" + name2 + "` cannot be empty");
  }
}
function assertPath2(path2, name2) {
  if (!path2) {
    throw new Error("Setting `" + name2 + "` requires `path` to be set too");
  }
}
function isUint8Array(value) {
  return Boolean(
    value && typeof value === "object" && "byteLength" in value && "byteOffset" in value
  );
}

var CallableInstance = (
  /**
   * @type {new <Parameters extends Array<unknown>, Result>(property: string | symbol) => (...parameters: Parameters) => Result}
   */
  /** @type {unknown} */
  /**
   * @this {Function}
   * @param {string | symbol} property
   * @returns {(...parameters: Array<unknown>) => unknown}
   */
  function(property) {
    const self2 = this;
    const constr = self2.constructor;
    const proto = (
      /** @type {Record<string | symbol, Function>} */
      // Prototypes do exist.
      // type-coverage:ignore-next-line
      constr.prototype
    );
    const value = proto[property];
    const apply2 = function() {
      return value.apply(apply2, arguments);
    };
    Object.setPrototypeOf(apply2, proto);
    return apply2;
  }
);

var own5 = {}.hasOwnProperty;
var Processor = class _Processor extends CallableInstance {
  /**
   * Create a processor.
   */
  constructor() {
    super("copy");
    this.Compiler = void 0;
    this.Parser = void 0;
    this.attachers = [];
    this.compiler = void 0;
    this.freezeIndex = -1;
    this.frozen = void 0;
    this.namespace = {};
    this.parser = void 0;
    this.transformers = trough();
  }
  /**
   * Copy a processor.
   *
   * @deprecated
   *   This is a private internal method and should not be used.
   * @returns {Processor<ParseTree, HeadTree, TailTree, CompileTree, CompileResult>}
   *   New *unfrozen* processor ({@linkcode Processor}) that is
   *   configured to work the same as its ancestor.
   *   When the descendant processor is configured in the future it does not
   *   affect the ancestral processor.
   */
  copy() {
    const destination = (
      /** @type {Processor<ParseTree, HeadTree, TailTree, CompileTree, CompileResult>} */
      new _Processor()
    );
    let index3 = -1;
    while (++index3 < this.attachers.length) {
      const attacher = this.attachers[index3];
      destination.use(...attacher);
    }
    destination.data((0, import_extend.default)(true, {}, this.namespace));
    return destination;
  }
  /**
   * Configure the processor with info available to all plugins.
   * Information is stored in an object.
   *
   * Typically, options can be given to a specific plugin, but sometimes it
   * makes sense to have information shared with several plugins.
   * For example, a list of HTML elements that are self-closing, which is
   * needed during all phases.
   *
   * > **Note**: setting information cannot occur on *frozen* processors.
   * > Call the processor first to create a new unfrozen processor.
   *
   * > **Note**: to register custom data in TypeScript, augment the
   * > {@linkcode Data} interface.
   *
   * @example
   *   This example show how to get and set info:
   *
   *   ```js
   *   import {unified} from 'unified'
   *
   *   const processor = unified().data('alpha', 'bravo')
   *
   *   processor.data('alpha') // => 'bravo'
   *
   *   processor.data() // => {alpha: 'bravo'}
   *
   *   processor.data({charlie: 'delta'})
   *
   *   processor.data() // => {charlie: 'delta'}
   *   ```
   *
   * @template {keyof Data} Key
   *
   * @overload
   * @returns {Data}
   *
   * @overload
   * @param {Data} dataset
   * @returns {Processor<ParseTree, HeadTree, TailTree, CompileTree, CompileResult>}
   *
   * @overload
   * @param {Key} key
   * @returns {Data[Key]}
   *
   * @overload
   * @param {Key} key
   * @param {Data[Key]} value
   * @returns {Processor<ParseTree, HeadTree, TailTree, CompileTree, CompileResult>}
   *
   * @param {Data | Key} [key]
   *   Key to get or set, or entire dataset to set, or nothing to get the
   *   entire dataset (optional).
   * @param {Data[Key]} [value]
   *   Value to set (optional).
   * @returns {unknown}
   *   The current processor when setting, the value at `key` when getting, or
   *   the entire dataset when getting without key.
   */
  data(key, value) {
    if (typeof key === "string") {
      if (arguments.length === 2) {
        assertUnfrozen("data", this.frozen);
        this.namespace[key] = value;
        return this;
      }
      return own5.call(this.namespace, key) && this.namespace[key] || void 0;
    }
    if (key) {
      assertUnfrozen("data", this.frozen);
      this.namespace = key;
      return this;
    }
    return this.namespace;
  }
  /**
   * Freeze a processor.
   *
   * Frozen processors are meant to be extended and not to be configured
   * directly.
   *
   * When a processor is frozen it cannot be unfrozen.
   * New processors working the same way can be created by calling the
   * processor.
   *
   * It’s possible to freeze processors explicitly by calling `.freeze()`.
   * Processors freeze automatically when `.parse()`, `.run()`, `.runSync()`,
   * `.stringify()`, `.process()`, or `.processSync()` are called.
   *
   * @returns {Processor<ParseTree, HeadTree, TailTree, CompileTree, CompileResult>}
   *   The current processor.
   */
  freeze() {
    if (this.frozen) {
      return this;
    }
    const self2 = (
      /** @type {Processor} */
      /** @type {unknown} */
      this
    );
    while (++this.freezeIndex < this.attachers.length) {
      const [attacher, ...options] = this.attachers[this.freezeIndex];
      if (options[0] === false) {
        continue;
      }
      if (options[0] === true) {
        options[0] = void 0;
      }
      const transformer = attacher.call(self2, ...options);
      if (typeof transformer === "function") {
        this.transformers.use(transformer);
      }
    }
    this.frozen = true;
    this.freezeIndex = Number.POSITIVE_INFINITY;
    return this;
  }
  /**
   * Parse text to a syntax tree.
   *
   * > **Note**: `parse` freezes the processor if not already *frozen*.
   *
   * > **Note**: `parse` performs the parse phase, not the run phase or other
   * > phases.
   *
   * @param {Compatible | undefined} [file]
   *   file to parse (optional); typically `string` or `VFile`; any value
   *   accepted as `x` in `new VFile(x)`.
   * @returns {ParseTree extends undefined ? Node : ParseTree}
   *   Syntax tree representing `file`.
   */
  parse(file) {
    this.freeze();
    const realFile = vfile(file);
    const parser = this.parser || this.Parser;
    assertParser("parse", parser);
    return parser(String(realFile), realFile);
  }
  /**
   * Process the given file as configured on the processor.
   *
   * > **Note**: `process` freezes the processor if not already *frozen*.
   *
   * > **Note**: `process` performs the parse, run, and stringify phases.
   *
   * @overload
   * @param {Compatible | undefined} file
   * @param {ProcessCallback<VFileWithOutput<CompileResult>>} done
   * @returns {undefined}
   *
   * @overload
   * @param {Compatible | undefined} [file]
   * @returns {Promise<VFileWithOutput<CompileResult>>}
   *
   * @param {Compatible | undefined} [file]
   *   File (optional); typically `string` or `VFile`]; any value accepted as
   *   `x` in `new VFile(x)`.
   * @param {ProcessCallback<VFileWithOutput<CompileResult>> | undefined} [done]
   *   Callback (optional).
   * @returns {Promise<VFile> | undefined}
   *   Nothing if `done` is given.
   *   Otherwise a promise, rejected with a fatal error or resolved with the
   *   processed file.
   *
   *   The parsed, transformed, and compiled value is available at
   *   `file.value` (see note).
   *
   *   > **Note**: unified typically compiles by serializing: most
   *   > compilers return `string` (or `Uint8Array`).
   *   > Some compilers, such as the one configured with
   *   > [`rehype-react`][rehype-react], return other values (in this case, a
   *   > React tree).
   *   > If you’re using a compiler that doesn’t serialize, expect different
   *   > result values.
   *   >
   *   > To register custom results in TypeScript, add them to
   *   > {@linkcode CompileResultMap}.
   *
   *   [rehype-react]: https://github.com/rehypejs/rehype-react
   */
  process(file, done) {
    const self2 = this;
    this.freeze();
    assertParser("process", this.parser || this.Parser);
    assertCompiler("process", this.compiler || this.Compiler);
    return done ? executor(void 0, done) : new Promise(executor);
    function executor(resolve, reject) {
      const realFile = vfile(file);
      const parseTree = (
        /** @type {HeadTree extends undefined ? Node : HeadTree} */
        /** @type {unknown} */
        self2.parse(realFile)
      );
      self2.run(parseTree, realFile, function(error, tree, file2) {
        if (error || !tree || !file2) {
          return realDone(error);
        }
        const compileTree = (
          /** @type {CompileTree extends undefined ? Node : CompileTree} */
          /** @type {unknown} */
          tree
        );
        const compileResult = self2.stringify(compileTree, file2);
        if (looksLikeAValue(compileResult)) {
          file2.value = compileResult;
        } else {
          file2.result = compileResult;
        }
        realDone(
          error,
          /** @type {VFileWithOutput<CompileResult>} */
          file2
        );
      });
      function realDone(error, file2) {
        if (error || !file2) {
          reject(error);
        } else if (resolve) {
          resolve(file2);
        } else {
          ok(done, "`done` is defined if `resolve` is not");
          done(void 0, file2);
        }
      }
    }
  }
  /**
   * Process the given file as configured on the processor.
   *
   * An error is thrown if asynchronous transforms are configured.
   *
   * > **Note**: `processSync` freezes the processor if not already *frozen*.
   *
   * > **Note**: `processSync` performs the parse, run, and stringify phases.
   *
   * @param {Compatible | undefined} [file]
   *   File (optional); typically `string` or `VFile`; any value accepted as
   *   `x` in `new VFile(x)`.
   * @returns {VFileWithOutput<CompileResult>}
   *   The processed file.
   *
   *   The parsed, transformed, and compiled value is available at
   *   `file.value` (see note).
   *
   *   > **Note**: unified typically compiles by serializing: most
   *   > compilers return `string` (or `Uint8Array`).
   *   > Some compilers, such as the one configured with
   *   > [`rehype-react`][rehype-react], return other values (in this case, a
   *   > React tree).
   *   > If you’re using a compiler that doesn’t serialize, expect different
   *   > result values.
   *   >
   *   > To register custom results in TypeScript, add them to
   *   > {@linkcode CompileResultMap}.
   *
   *   [rehype-react]: https://github.com/rehypejs/rehype-react
   */
  processSync(file) {
    let complete = false;
    let result;
    this.freeze();
    assertParser("processSync", this.parser || this.Parser);
    assertCompiler("processSync", this.compiler || this.Compiler);
    this.process(file, realDone);
    assertDone("processSync", "process", complete);
    ok(result, "we either bailed on an error or have a tree");
    return result;
    function realDone(error, file2) {
      complete = true;
      bail(error);
      result = file2;
    }
  }
  /**
   * Run *transformers* on a syntax tree.
   *
   * > **Note**: `run` freezes the processor if not already *frozen*.
   *
   * > **Note**: `run` performs the run phase, not other phases.
   *
   * @overload
   * @param {HeadTree extends undefined ? Node : HeadTree} tree
   * @param {RunCallback<TailTree extends undefined ? Node : TailTree>} done
   * @returns {undefined}
   *
   * @overload
   * @param {HeadTree extends undefined ? Node : HeadTree} tree
   * @param {Compatible | undefined} file
   * @param {RunCallback<TailTree extends undefined ? Node : TailTree>} done
   * @returns {undefined}
   *
   * @overload
   * @param {HeadTree extends undefined ? Node : HeadTree} tree
   * @param {Compatible | undefined} [file]
   * @returns {Promise<TailTree extends undefined ? Node : TailTree>}
   *
   * @param {HeadTree extends undefined ? Node : HeadTree} tree
   *   Tree to transform and inspect.
   * @param {(
   *   RunCallback<TailTree extends undefined ? Node : TailTree> |
   *   Compatible
   * )} [file]
   *   File associated with `node` (optional); any value accepted as `x` in
   *   `new VFile(x)`.
   * @param {RunCallback<TailTree extends undefined ? Node : TailTree>} [done]
   *   Callback (optional).
   * @returns {Promise<TailTree extends undefined ? Node : TailTree> | undefined}
   *   Nothing if `done` is given.
   *   Otherwise, a promise rejected with a fatal error or resolved with the
   *   transformed tree.
   */
  run(tree, file, done) {
    assertNode(tree);
    this.freeze();
    const transformers = this.transformers;
    if (!done && typeof file === "function") {
      done = file;
      file = void 0;
    }
    return done ? executor(void 0, done) : new Promise(executor);
    function executor(resolve, reject) {
      ok(
        typeof file !== "function",
        "`file` can\u2019t be a `done` anymore, we checked"
      );
      const realFile = vfile(file);
      transformers.run(tree, realFile, realDone);
      function realDone(error, outputTree, file2) {
        const resultingTree = (
          /** @type {TailTree extends undefined ? Node : TailTree} */
          outputTree || tree
        );
        if (error) {
          reject(error);
        } else if (resolve) {
          resolve(resultingTree);
        } else {
          ok(done, "`done` is defined if `resolve` is not");
          done(void 0, resultingTree, file2);
        }
      }
    }
  }
  /**
   * Run *transformers* on a syntax tree.
   *
   * An error is thrown if asynchronous transforms are configured.
   *
   * > **Note**: `runSync` freezes the processor if not already *frozen*.
   *
   * > **Note**: `runSync` performs the run phase, not other phases.
   *
   * @param {HeadTree extends undefined ? Node : HeadTree} tree
   *   Tree to transform and inspect.
   * @param {Compatible | undefined} [file]
   *   File associated with `node` (optional); any value accepted as `x` in
   *   `new VFile(x)`.
   * @returns {TailTree extends undefined ? Node : TailTree}
   *   Transformed tree.
   */
  runSync(tree, file) {
    let complete = false;
    let result;
    this.run(tree, file, realDone);
    assertDone("runSync", "run", complete);
    ok(result, "we either bailed on an error or have a tree");
    return result;
    function realDone(error, tree2) {
      bail(error);
      result = tree2;
      complete = true;
    }
  }
  /**
   * Compile a syntax tree.
   *
   * > **Note**: `stringify` freezes the processor if not already *frozen*.
   *
   * > **Note**: `stringify` performs the stringify phase, not the run phase
   * > or other phases.
   *
   * @param {CompileTree extends undefined ? Node : CompileTree} tree
   *   Tree to compile.
   * @param {Compatible | undefined} [file]
   *   File associated with `node` (optional); any value accepted as `x` in
   *   `new VFile(x)`.
   * @returns {CompileResult extends undefined ? Value : CompileResult}
   *   Textual representation of the tree (see note).
   *
   *   > **Note**: unified typically compiles by serializing: most compilers
   *   > return `string` (or `Uint8Array`).
   *   > Some compilers, such as the one configured with
   *   > [`rehype-react`][rehype-react], return other values (in this case, a
   *   > React tree).
   *   > If you’re using a compiler that doesn’t serialize, expect different
   *   > result values.
   *   >
   *   > To register custom results in TypeScript, add them to
   *   > {@linkcode CompileResultMap}.
   *
   *   [rehype-react]: https://github.com/rehypejs/rehype-react
   */
  stringify(tree, file) {
    this.freeze();
    const realFile = vfile(file);
    const compiler2 = this.compiler || this.Compiler;
    assertCompiler("stringify", compiler2);
    assertNode(tree);
    return compiler2(tree, realFile);
  }
  /**
   * Configure the processor to use a plugin, a list of usable values, or a
   * preset.
   *
   * If the processor is already using a plugin, the previous plugin
   * configuration is changed based on the options that are passed in.
   * In other words, the plugin is not added a second time.
   *
   * > **Note**: `use` cannot be called on *frozen* processors.
   * > Call the processor first to create a new unfrozen processor.
   *
   * @example
   *   There are many ways to pass plugins to `.use()`.
   *   This example gives an overview:
   *
   *   ```js
   *   import {unified} from 'unified'
   *
   *   unified()
   *     // Plugin with options:
   *     .use(pluginA, {x: true, y: true})
   *     // Passing the same plugin again merges configuration (to `{x: true, y: false, z: true}`):
   *     .use(pluginA, {y: false, z: true})
   *     // Plugins:
   *     .use([pluginB, pluginC])
   *     // Two plugins, the second with options:
   *     .use([pluginD, [pluginE, {}]])
   *     // Preset with plugins and settings:
   *     .use({plugins: [pluginF, [pluginG, {}]], settings: {position: false}})
   *     // Settings only:
   *     .use({settings: {position: false}})
   *   ```
   *
   * @template {Array<unknown>} [Parameters=[]]
   * @template {Node | string | undefined} [Input=undefined]
   * @template [Output=Input]
   *
   * @overload
   * @param {Preset | null | undefined} [preset]
   * @returns {Processor<ParseTree, HeadTree, TailTree, CompileTree, CompileResult>}
   *
   * @overload
   * @param {PluggableList} list
   * @returns {Processor<ParseTree, HeadTree, TailTree, CompileTree, CompileResult>}
   *
   * @overload
   * @param {Plugin<Parameters, Input, Output>} plugin
   * @param {...(Parameters | [boolean])} parameters
   * @returns {UsePlugin<ParseTree, HeadTree, TailTree, CompileTree, CompileResult, Input, Output>}
   *
   * @param {PluggableList | Plugin | Preset | null | undefined} value
   *   Usable value.
   * @param {...unknown} parameters
   *   Parameters, when a plugin is given as a usable value.
   * @returns {Processor<ParseTree, HeadTree, TailTree, CompileTree, CompileResult>}
   *   Current processor.
   */
  use(value, ...parameters) {
    const attachers = this.attachers;
    const namespace = this.namespace;
    assertUnfrozen("use", this.frozen);
    if (value === null || value === void 0) {
    } else if (typeof value === "function") {
      addPlugin(value, parameters);
    } else if (typeof value === "object") {
      if (Array.isArray(value)) {
        addList(value);
      } else {
        addPreset(value);
      }
    } else {
      throw new TypeError("Expected usable value, not `" + value + "`");
    }
    return this;
    function add(value2) {
      if (typeof value2 === "function") {
        addPlugin(value2, []);
      } else if (typeof value2 === "object") {
        if (Array.isArray(value2)) {
          const [plugin, ...parameters2] = (
            /** @type {PluginTuple<Array<unknown>>} */
            value2
          );
          addPlugin(plugin, parameters2);
        } else {
          addPreset(value2);
        }
      } else {
        throw new TypeError("Expected usable value, not `" + value2 + "`");
      }
    }
    function addPreset(result) {
      if (!("plugins" in result) && !("settings" in result)) {
        throw new Error(
          "Expected usable value but received an empty preset, which is probably a mistake: presets typically come with `plugins` and sometimes with `settings`, but this has neither"
        );
      }
      addList(result.plugins);
      if (result.settings) {
        namespace.settings = (0, import_extend.default)(true, namespace.settings, result.settings);
      }
    }
    function addList(plugins) {
      let index3 = -1;
      if (plugins === null || plugins === void 0) {
      } else if (Array.isArray(plugins)) {
        while (++index3 < plugins.length) {
          const thing = plugins[index3];
          add(thing);
        }
      } else {
        throw new TypeError("Expected a list of plugins, not `" + plugins + "`");
      }
    }
    function addPlugin(plugin, parameters2) {
      let index3 = -1;
      let entryIndex = -1;
      while (++index3 < attachers.length) {
        if (attachers[index3][0] === plugin) {
          entryIndex = index3;
          break;
        }
      }
      if (entryIndex === -1) {
        attachers.push([plugin, ...parameters2]);
      } else if (parameters2.length > 0) {
        let [primary, ...rest] = parameters2;
        const currentPrimary = attachers[entryIndex][1];
        if (isPlainObject(currentPrimary) && isPlainObject(primary)) {
          primary = (0, import_extend.default)(true, currentPrimary, primary);
        }
        attachers[entryIndex] = [plugin, primary, ...rest];
      }
    }
  }
};
var unified = new Processor().freeze();
function assertParser(name2, value) {
  if (typeof value !== "function") {
    throw new TypeError("Cannot `" + name2 + "` without `parser`");
  }
}
function assertCompiler(name2, value) {
  if (typeof value !== "function") {
    throw new TypeError("Cannot `" + name2 + "` without `compiler`");
  }
}
function assertUnfrozen(name2, frozen) {
  if (frozen) {
    throw new Error(
      "Cannot call `" + name2 + "` on a frozen processor.\nCreate a new processor first, by calling it: use `processor()` instead of `processor`."
    );
  }
}
function assertNode(node2) {
  if (!isPlainObject(node2) || typeof node2.type !== "string") {
    throw new TypeError("Expected node, got `" + node2 + "`");
  }
}
function assertDone(name2, asyncName, complete) {
  if (!complete) {
    throw new Error(
      "`" + name2 + "` finished async. Use `" + asyncName + "` instead"
    );
  }
}
function vfile(value) {
  return looksLikeAVFile(value) ? value : new VFile(value);
}
function looksLikeAVFile(value) {
  return Boolean(
    value && typeof value === "object" && "message" in value && "messages" in value
  );
}
function looksLikeAValue(value) {
  return typeof value === "string" || isUint8Array2(value);
}
function isUint8Array2(value) {
  return Boolean(
    value && typeof value === "object" && "byteLength" in value && "byteOffset" in value
  );
}

var changelog = "https://github.com/remarkjs/react-markdown/blob/main/changelog.md";
var emptyPlugins = [];
var emptyRemarkRehypeOptions = { allowDangerousHtml: true };
var safeProtocol = /^(https?|ircs?|mailto|xmpp)$/i;
var deprecations = [
  { from: "astPlugins", id: "remove-buggy-html-in-markdown-parser" },
  { from: "allowDangerousHtml", id: "remove-buggy-html-in-markdown-parser" },
  {
    from: "allowNode",
    id: "replace-allownode-allowedtypes-and-disallowedtypes",
    to: "allowElement"
  },
  {
    from: "allowedTypes",
    id: "replace-allownode-allowedtypes-and-disallowedtypes",
    to: "allowedElements"
  },
  { from: "className", id: "remove-classname" },
  {
    from: "disallowedTypes",
    id: "replace-allownode-allowedtypes-and-disallowedtypes",
    to: "disallowedElements"
  },
  { from: "escapeHtml", id: "remove-buggy-html-in-markdown-parser" },
  { from: "includeElementIndex", id: "#remove-includeelementindex" },
  {
    from: "includeNodeIndex",
    id: "change-includenodeindex-to-includeelementindex"
  },
  { from: "linkTarget", id: "remove-linktarget" },
  { from: "plugins", id: "change-plugins-to-remarkplugins", to: "remarkPlugins" },
  { from: "rawSourcePos", id: "#remove-rawsourcepos" },
  { from: "renderers", id: "change-renderers-to-components", to: "components" },
  { from: "source", id: "change-source-to-children", to: "children" },
  { from: "sourcePos", id: "#remove-sourcepos" },
  { from: "transformImageUri", id: "#add-urltransform", to: "urlTransform" },
  { from: "transformLinkUri", id: "#add-urltransform", to: "urlTransform" }
];
function Markdown(options) {
  const processor = createProcessor(options);
  const file = createFile(options);
  return post(processor.runSync(processor.parse(file), file), options);
}
function createProcessor(options) {
  const rehypePlugins = options.rehypePlugins || emptyPlugins;
  const remarkPlugins = options.remarkPlugins || emptyPlugins;
  const remarkRehypeOptions = options.remarkRehypeOptions ? { ...options.remarkRehypeOptions, ...emptyRemarkRehypeOptions } : emptyRemarkRehypeOptions;
  const processor = unified().use(remarkParse).use(remarkPlugins).use(remarkRehype, remarkRehypeOptions).use(rehypePlugins);
  return processor;
}
function createFile(options) {
  const children = options.children || "";
  const file = new VFile();
  if (typeof children === "string") {
    file.value = children;
  } else {
    unreachable(
      "Unexpected value `" + children + "` for `children` prop, expected `string`"
    );
  }
  return file;
}
function post(tree, options) {
  const allowedElements = options.allowedElements;
  const allowElement = options.allowElement;
  const components = options.components;
  const disallowedElements = options.disallowedElements;
  const skipHtml = options.skipHtml;
  const unwrapDisallowed = options.unwrapDisallowed;
  const urlTransform = options.urlTransform || defaultUrlTransform;
  for (const deprecation of deprecations) {
    if (Object.hasOwn(options, deprecation.from)) {
      unreachable(
        "Unexpected `" + deprecation.from + "` prop, " + (deprecation.to ? "use `" + deprecation.to + "` instead" : "remove it") + " (see <" + changelog + "#" + deprecation.id + "> for more info)"
      );
    }
  }
  if (allowedElements && disallowedElements) {
    unreachable(
      "Unexpected combined `allowedElements` and `disallowedElements`, expected one or the other"
    );
  }
  visit(tree, transform);
  return toJsxRuntime(tree, {
    Fragment: import_react.Fragment,
    components,
    ignoreInvalidStyle: true,
    jsx,
    jsxs,
    passKeys: true,
    passNode: true
  });
  function transform(node2, index3, parent) {
    if (node2.type === "raw" && parent && typeof index3 === "number") {
      if (skipHtml) {
        parent.children.splice(index3, 1);
      } else {
        parent.children[index3] = { type: "text", value: node2.value };
      }
      return index3;
    }
    if (node2.type === "element") {
      let key;
      for (key in urlAttributes) {
        if (Object.hasOwn(urlAttributes, key) && Object.hasOwn(node2.properties, key)) {
          const value = node2.properties[key];
          const test = urlAttributes[key];
          if (test === null || test.includes(node2.tagName)) {
            node2.properties[key] = urlTransform(String(value || ""), key, node2);
          }
        }
      }
    }
    if (node2.type === "element") {
      let remove = allowedElements ? !allowedElements.includes(node2.tagName) : disallowedElements ? disallowedElements.includes(node2.tagName) : false;
      if (!remove && allowElement && typeof index3 === "number") {
        remove = !allowElement(node2, index3, parent);
      }
      if (remove && parent && typeof index3 === "number") {
        if (unwrapDisallowed && node2.children) {
          parent.children.splice(index3, 1, ...node2.children);
        } else {
          parent.children.splice(index3, 1);
        }
        return index3;
      }
    }
  }
}
function defaultUrlTransform(value) {
  const colon = value.indexOf(":");
  const questionMark = value.indexOf("?");
  const numberSign = value.indexOf("#");
  const slash = value.indexOf("/");
  if (
    // If there is no protocol, it’s relative.
    colon === -1 || // If the first colon is after a `?`, `#`, or `/`, it’s not a protocol.
    slash !== -1 && colon > slash || questionMark !== -1 && colon > questionMark || numberSign !== -1 && colon > numberSign || // It is a protocol, it should be allowed.
    safeProtocol.test(value.slice(0, colon))
  ) {
    return value;
  }
  return "";
}

function ccount(value, character) {
  const source = String(value);
  if (typeof character !== "string") {
    throw new TypeError("Expected character");
  }
  let count = 0;
  let index3 = source.indexOf(character);
  while (index3 !== -1) {
    count++;
    index3 = source.indexOf(character, index3 + character.length);
  }
  return count;
}

function escapeStringRegexp(string3) {
  if (typeof string3 !== "string") {
    throw new TypeError("Expected a string");
  }
  return string3.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&").replace(/-/g, "\\x2d");
}

function findAndReplace(tree, list4, options) {
  const settings = options || {};
  const ignored = convert(settings.ignore || []);
  const pairs = toPairs(list4);
  let pairIndex = -1;
  while (++pairIndex < pairs.length) {
    visitParents(tree, visitor);
  }
  function visitor(node2, parents, index3) {
    if (node2.type === "text" && typeof index3 === "number") {
      return handler(node2, parents, index3);
    }
    if (ignored(node2, index3, parents[parents.length - 1])) return SKIP;
  }
  function handler(node2, parents, index3) {
    const parent = parents[parents.length - 1];
    const find2 = pairs[pairIndex][0];
    const replace2 = pairs[pairIndex][1];
    let start2 = 0;
    let change = false;
    let nodes = [];
    find2.lastIndex = 0;
    let match = find2.exec(node2.value);
    while (match) {
      const position3 = match.index;
      const matchObject = {
        index: match.index,
        input: match.input,
        stack: [...parents, node2]
      };
      let value = replace2(...match, matchObject);
      if (typeof value === "string") {
        value = value.length > 0 ? { type: "text", value } : void 0;
      }
      if (value === false) {
        find2.lastIndex = position3 + 1;
      } else {
        if (start2 !== position3) {
          add({ type: "text", value: node2.value.slice(start2, position3) });
        }
        if (Array.isArray(value)) {
          for (const child of value) add(child);
        } else if (value) {
          add(value);
        }
        start2 = position3 + match[0].length;
        change = true;
      }
      if (!find2.global) {
        break;
      }
      match = find2.exec(node2.value);
    }
    if (change) {
      if (start2 < node2.value.length) {
        add({ type: "text", value: node2.value.slice(start2) });
      }
      parent.children.splice(index3, 1, ...nodes);
    } else {
      nodes = [node2];
    }
    return index3 + nodes.length;
    function add(child) {
      const previous3 = nodes[nodes.length - 1];
      if (previous3 && previous3.type === "text" && child.type === "text") {
        previous3.value += child.value;
      } else {
        nodes.push(child);
      }
    }
  }
}
function toPairs(tupleOrList) {
  if (!Array.isArray(tupleOrList)) {
    throw new TypeError("Expected find and replace tuple or list of tuples");
  }
  const result = [];
  const list4 = !tupleOrList[0] || Array.isArray(tupleOrList[0]) ? (
    /** @type {FindAndReplaceList} */
    tupleOrList
  ) : [
    /** @type {FindAndReplaceTuple} */
    tupleOrList
  ];
  let index3 = -1;
  while (++index3 < list4.length) {
    const tuple = list4[index3];
    result.push([toExpression(tuple[0]), toFunction(tuple[1])]);
  }
  return result;
}
function toExpression(find2) {
  return typeof find2 === "string" ? new RegExp(escapeStringRegexp(find2), "g") : find2;
}
function toFunction(replace2) {
  return typeof replace2 === "function" ? replace2 : function() {
    return replace2;
  };
}

var inConstruct = "phrasing";
var notInConstruct = ["autolink", "link", "image", "label"];
function gfmAutolinkLiteralFromMarkdown() {
  return {
    transforms: [transformGfmAutolinkLiterals],
    enter: {
      literalAutolink: enterLiteralAutolink,
      literalAutolinkEmail: enterLiteralAutolinkValue,
      literalAutolinkHttp: enterLiteralAutolinkValue,
      literalAutolinkWww: enterLiteralAutolinkValue
    },
    exit: {
      literalAutolink: exitLiteralAutolink,
      literalAutolinkEmail: exitLiteralAutolinkEmail,
      literalAutolinkHttp: exitLiteralAutolinkHttp,
      literalAutolinkWww: exitLiteralAutolinkWww
    }
  };
}
function gfmAutolinkLiteralToMarkdown() {
  return {
    unsafe: [
      {
        character: "@",
        before: "[+\\-.\\w]",
        after: "[\\-.\\w]",
        inConstruct,
        notInConstruct
      },
      {
        character: ".",
        before: "[Ww]",
        after: "[\\-.\\w]",
        inConstruct,
        notInConstruct
      },
      {
        character: ":",
        before: "[ps]",
        after: "\\/",
        inConstruct,
        notInConstruct
      }
    ]
  };
}
function enterLiteralAutolink(token) {
  this.enter(
    { type: "link", title: null, url: "", children: [], position: void 0 },
    token
  );
}
function enterLiteralAutolinkValue(token) {
  this.config.enter.autolinkProtocol.call(this, token);
}
function exitLiteralAutolinkHttp(token) {
  this.config.exit.autolinkProtocol.call(this, token);
}
function exitLiteralAutolinkWww(token) {
  this.config.exit.data.call(this, token);
  const node2 = this.stack[this.stack.length - 1];
  ok(node2.type === "link");
  node2.url = "http://" + this.sliceSerialize(token);
}
function exitLiteralAutolinkEmail(token) {
  this.config.exit.autolinkEmail.call(this, token);
}
function exitLiteralAutolink(token) {
  this.exit(token);
}
function transformGfmAutolinkLiterals(tree) {
  findAndReplace(
    tree,
    [
      [
        /(?<![\da-z])(https?:\/\/|www(?=\.))([\w-]*\.[\w\-.]*)([^\t\n\r ]*)/gi,
        findUrl
      ],
      [
        /(?<![\w+\-.@])xmpp:([\w+\-.]+)@([\w-]+(?:\.[\w-]+)+)(\/(?:[\w\-/]|\.(?=[\dA-Za-z]))*)?/g,
        findXmpp
      ],
      [/(?<![\w+\-.@])mailto:([\w+\-.]+)@([\w-]+(?:\.[\w-]+)+)/g, findMailto],
      [
        /(?<![\w+\-.]|(?:^|[^\d@A-Za-z])(?:mailto|xmpp):)([\w+\-.]+)@([\w-]+(?:\.[\w-]+)+)/g,
        findEmail
      ]
    ],
    { ignore: ["link", "linkReference"] }
  );
}
function findUrl(_, protocol, domain2, path2, match) {
  if (!previous2(match)) {
    return false;
  }
  let prefix = "";
  if (/^w/i.test(protocol)) {
    domain2 = protocol + domain2;
    protocol = "";
    prefix = "http://";
  }
  if (unicodePunctuation(domain2.charCodeAt(0)) || !isCorrectDomain(domain2)) {
    return false;
  }
  const parts = splitUrl(domain2 + path2);
  const result = {
    type: "link",
    title: null,
    url: prefix + protocol + parts[0],
    children: [{ type: "text", value: protocol + parts[0], position: void 0 }],
    position: void 0
  };
  if (parts[1]) {
    return [result, { type: "text", value: parts[1], position: void 0 }];
  }
  return result;
}
function findEmail(_, atext, label) {
  if (/[\d\-_]$/.test(label)) {
    return false;
  }
  return {
    type: "link",
    title: null,
    url: "mailto:" + atext + "@" + label,
    children: [{ type: "text", value: atext + "@" + label, position: void 0 }],
    position: void 0
  };
}
function findMailto(_, atext, label) {
  if (/[\d\-_]$/.test(label)) {
    return false;
  }
  const value = "mailto:" + atext + "@" + label;
  return {
    type: "link",
    title: null,
    url: value,
    children: [{ type: "text", value, position: void 0 }],
    position: void 0
  };
}
function findXmpp(matchValue, atext, label, resource, match) {
  if (/[\d\-_]$/.test(label) || resource && (!/[A-Za-z]$/.test(resource) || match.input.charAt(match.index + matchValue.length) === "@")) {
    return false;
  }
  const value = "xmpp:" + atext + "@" + label + (resource || "");
  return {
    type: "link",
    title: null,
    url: value,
    children: [{ type: "text", value, position: void 0 }],
    position: void 0
  };
}
function isCorrectDomain(domain2) {
  const parts = domain2.split(".");
  if (parts.length < 2 || parts[parts.length - 1] && (/_/.test(parts[parts.length - 1]) || !/[\dA-Za-z]/.test(parts[parts.length - 1])) || parts[parts.length - 2] && (/_/.test(parts[parts.length - 2]) || !/[\dA-Za-z]/.test(parts[parts.length - 2]))) {
    return false;
  }
  return true;
}
function splitUrl(url) {
  let index3 = url.length;
  while (index3 > 0) {
    const code4 = url.charCodeAt(index3 - 1);
    if (code4 === 33 || code4 === 34 || code4 === 38 || code4 === 39 || code4 === 41 || code4 === 44 || code4 === 46 || code4 === 58 || code4 === 59 || code4 === 60 || code4 === 62 || code4 === 63 || code4 === 93 || code4 === 125) {
      index3--;
    } else {
      break;
    }
  }
  if (index3 === url.length) {
    return [url, void 0];
  }
  let trail2 = url.slice(index3);
  url = url.slice(0, index3);
  let closingParenIndex = trail2.indexOf(")");
  const openingParens = ccount(url, "(");
  let closingParens = ccount(url, ")");
  while (closingParenIndex !== -1 && openingParens > closingParens) {
    url += trail2.slice(0, closingParenIndex + 1);
    trail2 = trail2.slice(closingParenIndex + 1);
    closingParenIndex = trail2.indexOf(")");
    closingParens++;
  }
  return [url, trail2];
}
function previous2(match) {
  const code4 = match.input.charCodeAt(match.index - 1);
  return match.index === 0 || unicodeWhitespace(code4) || unicodePunctuation(code4);
}

footnoteReference2.peek = footnoteReferencePeek;
function enterFootnoteCallString() {
  this.buffer();
}
function enterFootnoteCall(token) {
  this.enter({ type: "footnoteReference", identifier: "", label: "" }, token);
}
function enterFootnoteDefinitionLabelString() {
  this.buffer();
}
function enterFootnoteDefinition(token) {
  this.enter(
    { type: "footnoteDefinition", identifier: "", label: "", children: [] },
    token
  );
}
function exitFootnoteCallString(token) {
  const label = this.resume();
  const node2 = this.stack[this.stack.length - 1];
  ok(node2.type === "footnoteReference");
  node2.identifier = normalizeIdentifier(
    this.sliceSerialize(token)
  ).toLowerCase();
  node2.label = label;
}
function exitFootnoteCall(token) {
  this.exit(token);
}
function exitFootnoteDefinitionLabelString(token) {
  const label = this.resume();
  const node2 = this.stack[this.stack.length - 1];
  ok(node2.type === "footnoteDefinition");
  node2.identifier = normalizeIdentifier(
    this.sliceSerialize(token)
  ).toLowerCase();
  node2.label = label;
}
function exitFootnoteDefinition(token) {
  this.exit(token);
}
function footnoteReferencePeek() {
  return "[";
}
function footnoteReference2(node2, _, state, info) {
  const tracker = state.createTracker(info);
  let value = tracker.move("[^");
  const exit3 = state.enter("footnoteReference");
  const subexit = state.enter("reference");
  value += tracker.move(
    state.safe(state.associationId(node2), { after: "]", before: value })
  );
  subexit();
  exit3();
  value += tracker.move("]");
  return value;
}
function gfmFootnoteFromMarkdown() {
  return {
    enter: {
      gfmFootnoteCallString: enterFootnoteCallString,
      gfmFootnoteCall: enterFootnoteCall,
      gfmFootnoteDefinitionLabelString: enterFootnoteDefinitionLabelString,
      gfmFootnoteDefinition: enterFootnoteDefinition
    },
    exit: {
      gfmFootnoteCallString: exitFootnoteCallString,
      gfmFootnoteCall: exitFootnoteCall,
      gfmFootnoteDefinitionLabelString: exitFootnoteDefinitionLabelString,
      gfmFootnoteDefinition: exitFootnoteDefinition
    }
  };
}
function gfmFootnoteToMarkdown(options) {
  let firstLineBlank = false;
  if (options && options.firstLineBlank) {
    firstLineBlank = true;
  }
  return {
    handlers: { footnoteDefinition, footnoteReference: footnoteReference2 },
    // This is on by default already.
    unsafe: [{ character: "[", inConstruct: ["label", "phrasing", "reference"] }]
  };
  function footnoteDefinition(node2, _, state, info) {
    const tracker = state.createTracker(info);
    let value = tracker.move("[^");
    const exit3 = state.enter("footnoteDefinition");
    const subexit = state.enter("label");
    value += tracker.move(
      state.safe(state.associationId(node2), { before: value, after: "]" })
    );
    subexit();
    value += tracker.move("]:");
    if (node2.children && node2.children.length > 0) {
      tracker.shift(4);
      value += tracker.move(
        (firstLineBlank ? "\n" : " ") + state.indentLines(
          state.containerFlow(node2, tracker.current()),
          firstLineBlank ? mapAll : mapExceptFirst
        )
      );
    }
    exit3();
    return value;
  }
}
function mapExceptFirst(line, index3, blank) {
  return index3 === 0 ? line : mapAll(line, index3, blank);
}
function mapAll(line, index3, blank) {
  return (blank ? "" : "    ") + line;
}

var constructsWithoutStrikethrough = [
  "autolink",
  "destinationLiteral",
  "destinationRaw",
  "reference",
  "titleQuote",
  "titleApostrophe"
];
handleDelete.attention = attentionDelete;
handleDelete.peek = peekDelete;
function gfmStrikethroughFromMarkdown() {
  return {
    canContainEols: ["delete"],
    enter: { strikethrough: enterStrikethrough },
    exit: { strikethrough: exitStrikethrough }
  };
}
function gfmStrikethroughToMarkdown() {
  return {
    handlers: { delete: handleDelete },
    unsafe: [
      {
        character: "~",
        inConstruct: "phrasing",
        notInConstruct: constructsWithoutStrikethrough
      }
    ]
  };
}
function enterStrikethrough(token) {
  this.enter({ type: "delete", children: [], position: void 0 }, token);
}
function exitStrikethrough(token) {
  this.exit(token);
}
function handleDelete(node2, _, state, info) {
  const tracker = state.createTracker(info);
  const sequence = state.stack.includes("strikethrough") ? "~" : "~~";
  const exit3 = state.enter("strikethrough");
  let value = tracker.move(sequence);
  value += state.containerPhrasing(node2, {
    ...tracker.current(),
    before: value,
    after: "~"
  });
  value += tracker.move(sequence);
  exit3();
  return value;
}
function attentionDelete() {
  return { construct: "strikethrough", markers: ["~"], sizes: [2, 1] };
}
function peekDelete() {
  return "~";
}

function defaultStringLength(value) {
  return value.length;
}
function markdownTable(table2, options) {
  const settings = options || {};
  const align = (settings.align || []).concat();
  const stringLength = settings.stringLength || defaultStringLength;
  const alignments = [];
  const cellMatrix = [];
  const sizeMatrix = [];
  const longestCellByColumn = [];
  let mostCellsPerRow = 0;
  let rowIndex = -1;
  while (++rowIndex < table2.length) {
    const row2 = [];
    const sizes2 = [];
    let columnIndex2 = -1;
    if (table2[rowIndex].length > mostCellsPerRow) {
      mostCellsPerRow = table2[rowIndex].length;
    }
    while (++columnIndex2 < table2[rowIndex].length) {
      const cell = serialize2(table2[rowIndex][columnIndex2]);
      if (settings.alignDelimiters !== false) {
        const size = stringLength(cell);
        sizes2[columnIndex2] = size;
        if (longestCellByColumn[columnIndex2] === void 0 || size > longestCellByColumn[columnIndex2]) {
          longestCellByColumn[columnIndex2] = size;
        }
      }
      row2.push(cell);
    }
    cellMatrix[rowIndex] = row2;
    sizeMatrix[rowIndex] = sizes2;
  }
  let columnIndex = -1;
  if (typeof align === "object" && "length" in align) {
    while (++columnIndex < mostCellsPerRow) {
      alignments[columnIndex] = toAlignment(align[columnIndex]);
    }
  } else {
    const code4 = toAlignment(align);
    while (++columnIndex < mostCellsPerRow) {
      alignments[columnIndex] = code4;
    }
  }
  columnIndex = -1;
  const row = [];
  const sizes = [];
  while (++columnIndex < mostCellsPerRow) {
    const code4 = alignments[columnIndex];
    let before = "";
    let after = "";
    if (code4 === 99) {
      before = ":";
      after = ":";
    } else if (code4 === 108) {
      before = ":";
    } else if (code4 === 114) {
      after = ":";
    }
    let size = settings.alignDelimiters === false ? 1 : Math.max(
      1,
      longestCellByColumn[columnIndex] - before.length - after.length
    );
    const cell = before + "-".repeat(size) + after;
    if (settings.alignDelimiters !== false) {
      size = before.length + size + after.length;
      if (size > longestCellByColumn[columnIndex]) {
        longestCellByColumn[columnIndex] = size;
      }
      sizes[columnIndex] = size;
    }
    row[columnIndex] = cell;
  }
  cellMatrix.splice(1, 0, row);
  sizeMatrix.splice(1, 0, sizes);
  rowIndex = -1;
  const lines = [];
  while (++rowIndex < cellMatrix.length) {
    const row2 = cellMatrix[rowIndex];
    const sizes2 = sizeMatrix[rowIndex];
    const cellsInRow = settings.fillRows === false ? Math.max(1, cellMatrix[rowIndex === 1 ? 0 : rowIndex].length) : mostCellsPerRow;
    columnIndex = -1;
    const line = [];
    while (++columnIndex < cellsInRow) {
      const cell = row2[columnIndex] || "";
      let before = "";
      let after = "";
      if (settings.alignDelimiters !== false) {
        const size = longestCellByColumn[columnIndex] - (sizes2[columnIndex] || 0);
        const code4 = alignments[columnIndex];
        if (code4 === 114) {
          before = " ".repeat(size);
        } else if (code4 === 99) {
          const half = size / 2;
          if (size % 2) {
            before = " ".repeat(half + 0.5);
            after = " ".repeat(half - 0.5);
          } else {
            before = " ".repeat(half);
            after = before;
          }
        } else {
          after = " ".repeat(size);
        }
      }
      if (settings.delimiterStart !== false && !columnIndex) {
        line.push("|");
      }
      if (settings.padding !== false && // Don’t add the opening space if we’re not aligning and the cell is
      // empty: there will be a closing space.
      !(settings.alignDelimiters === false && cell === "") && (settings.delimiterStart !== false || columnIndex)) {
        line.push(" ");
      }
      if (settings.alignDelimiters !== false) {
        line.push(before);
      }
      line.push(cell);
      if (settings.alignDelimiters !== false) {
        line.push(after);
      }
      if (settings.padding !== false) {
        line.push(" ");
      }
      if (settings.delimiterEnd !== false || columnIndex !== cellsInRow - 1) {
        line.push("|");
      }
    }
    lines.push(
      settings.delimiterEnd === false ? line.join("").replace(/ +$/, "") : line.join("")
    );
  }
  return lines.join("\n");
}
function serialize2(value) {
  return value === null || value === void 0 ? "" : String(value);
}
function toAlignment(value) {
  const code4 = typeof value === "string" ? value.codePointAt(0) : 0;
  return code4 === 67 || code4 === 99 ? 99 : code4 === 76 || code4 === 108 ? 108 : code4 === 82 || code4 === 114 ? 114 : 0;
}

var phrasing = (
  /** @type {(node?: unknown) => node is Exclude<PhrasingContent, Html>} */
  convert([
    "break",
    "delete",
    "emphasis",
    // To do: next major: removed since footnotes were added to GFM.
    "footnote",
    "footnoteReference",
    "image",
    "imageReference",
    "inlineCode",
    // Enabled by `mdast-util-math`:
    "inlineMath",
    "link",
    "linkReference",
    // Enabled by `mdast-util-mdx`:
    "mdxJsxTextElement",
    // Enabled by `mdast-util-mdx`:
    "mdxTextExpression",
    "strong",
    "text",
    // Enabled by `mdast-util-directive`:
    "textDirective"
  ])
);

function blockquote2(node2, _, state, info) {
  const exit3 = state.enter("blockquote");
  const tracker = state.createTracker(info);
  tracker.move("> ");
  tracker.shift(2);
  const value = state.indentLines(
    state.containerFlow(node2, tracker.current()),
    map
  );
  exit3();
  return value;
}
function map(line, _, blank) {
  return ">" + (blank ? "" : " ") + line;
}

function patternInScope(stack, pattern) {
  return listInScope(stack, pattern.inConstruct, true) && !listInScope(stack, pattern.notInConstruct, false);
}
function listInScope(stack, list4, none) {
  if (typeof list4 === "string") {
    list4 = [list4];
  }
  if (!list4 || list4.length === 0) {
    return none;
  }
  let index3 = -1;
  while (++index3 < list4.length) {
    if (stack.includes(list4[index3])) {
      return true;
    }
  }
  return false;
}

function hardBreak2(_, _1, state, info) {
  let index3 = -1;
  while (++index3 < state.unsafe.length) {
    const pattern = state.unsafe[index3];
    if (pattern.character === "\n" && !pattern.before && !pattern.after && patternInScope(state.stack, pattern)) {
      return /[\t ]/.test(info.before) ? "" : " ";
    }
  }
  return "\\\n";
}

function longestStreak(value, substring) {
  const source = String(value);
  let index3 = source.indexOf(substring);
  let expected = index3;
  let count = 0;
  let max = 0;
  if (typeof substring !== "string") {
    throw new TypeError("Expected substring");
  }
  while (index3 !== -1) {
    if (index3 === expected) {
      if (++count > max) {
        max = count;
      }
    } else {
      count = 1;
    }
    expected = index3 + substring.length;
    index3 = source.indexOf(substring, expected);
  }
  return max;
}

function formatCodeAsIndented(node2, state) {
  return Boolean(
    state.options.fences === false && node2.value && // If there’s no info…
    !node2.lang && // And there’s a non-whitespace character…
    /[^\n\r ]/.test(node2.value) && // And the value doesn’t start or end in a blank…
    !/^[\t ]*(?:[\n\r]|$)|(?:^|[\n\r])[\t ]*$/.test(node2.value)
  );
}

function checkFence(state) {
  const marker = state.options.fence || "`";
  if (marker !== "`" && marker !== "~") {
    throw new Error(
      "Cannot serialize code with `" + marker + "` for `options.fence`, expected `` ` `` or `~`"
    );
  }
  return marker;
}

function code2(node2, _, state, info) {
  const marker = checkFence(state);
  const raw = node2.value || "";
  if (formatCodeAsIndented(node2, state)) {
    const exit4 = state.enter("codeIndented");
    const value2 = state.indentLines(raw, map2);
    exit4();
    return value2;
  }
  const tracker = state.createTracker(info);
  const sequence = marker.repeat(Math.max(longestStreak(raw, marker) + 1, 3));
  const exit3 = state.enter("codeFenced");
  const suffix = marker === "`" ? "GraveAccent" : "Tilde";
  let value = tracker.move(sequence);
  if (node2.lang) {
    const subexit = state.enter(`codeFencedLang${suffix}`);
    value += tracker.move(
      state.safe(node2.lang, {
        before: value,
        after: " ",
        encode: ["`"],
        ...tracker.current()
      })
    );
    subexit();
  }
  if (node2.lang && node2.meta) {
    const subexit = state.enter(`codeFencedMeta${suffix}`);
    value += tracker.move(" ");
    value += tracker.move(
      state.safe(node2.meta, {
        before: value,
        after: "\n",
        encode: ["`"],
        ...tracker.current()
      })
    );
    subexit();
  }
  value += tracker.move("\n");
  if (raw) {
    value += tracker.move(raw + "\n");
  }
  value += tracker.move(sequence);
  exit3();
  return value;
}
function map2(line, _, blank) {
  return (blank ? "" : "    ") + line;
}

function checkQuote(state) {
  const marker = state.options.quote || '"';
  if (marker !== '"' && marker !== "'") {
    throw new Error(
      "Cannot serialize title with `" + marker + "` for `options.quote`, expected `\"`, or `'`"
    );
  }
  return marker;
}

function definition2(node2, _, state, info) {
  const quote = checkQuote(state);
  const suffix = quote === '"' ? "Quote" : "Apostrophe";
  const exit3 = state.enter("definition");
  let subexit = state.enter("label");
  const tracker = state.createTracker(info);
  let value = tracker.move("[");
  value += tracker.move(
    state.safe(state.associationId(node2), {
      before: value,
      after: "]",
      ...tracker.current()
    })
  );
  value += tracker.move("]: ");
  subexit();
  if (
    // If there’s no url, or…
    !node2.url || // If there are control characters or whitespace.
    /[\0- \u007F]/.test(node2.url)
  ) {
    subexit = state.enter("destinationLiteral");
    value += tracker.move("<");
    value += tracker.move(
      state.safe(node2.url, { before: value, after: ">", ...tracker.current() })
    );
    value += tracker.move(">");
  } else {
    subexit = state.enter("destinationRaw");
    value += tracker.move(
      state.safe(node2.url, {
        before: value,
        after: node2.title ? " " : "\n",
        ...tracker.current()
      })
    );
  }
  subexit();
  if (node2.title) {
    subexit = state.enter(`title${suffix}`);
    value += tracker.move(" " + quote);
    value += tracker.move(
      state.safe(node2.title, {
        before: value,
        after: quote,
        ...tracker.current()
      })
    );
    value += tracker.move(quote);
    subexit();
  }
  exit3();
  return value;
}

function checkEmphasis(state) {
  const marker = state.options.emphasis || "*";
  if (marker !== "*" && marker !== "_") {
    throw new Error(
      "Cannot serialize emphasis with `" + marker + "` for `options.emphasis`, expected `*`, or `_`"
    );
  }
  return marker;
}

function firstCharacter(value) {
  const code4 = value.codePointAt(0);
  return code4 === void 0 ? "" : String.fromCodePoint(code4);
}
function lastCharacter(value) {
  const code4 = value.codePointAt(value.length - 2);
  return code4 !== void 0 && code4 > 65535 ? value.slice(-2) : value.slice(-1);
}

function encodeCharacterReference(code4) {
  return "&#x" + code4.toString(16).toUpperCase() + ";";
}

function encodeInfo(outside, inside, marker) {
  const outsideKind = classifyCharacter(outside);
  const insideKind = classifyCharacter(inside);
  if (outsideKind === void 0) {
    return insideKind === void 0 ? (
      // Letter inside:
      // we have to encode *both* letters for `_` as it is looser.
      // it already forms for `*` (and GFMs `~`).
      marker === "_" ? { inside: true, outside: true } : { inside: false, outside: false }
    ) : insideKind === 1 ? (
      // Whitespace inside: encode both (letter, whitespace).
      { inside: true, outside: true }
    ) : (
      // Punctuation inside: encode outer (letter)
      { inside: false, outside: true }
    );
  }
  if (outsideKind === 1) {
    return insideKind === void 0 ? (
      // Letter inside: already forms.
      { inside: false, outside: false }
    ) : insideKind === 1 ? (
      // Whitespace inside: encode both (whitespace).
      { inside: true, outside: true }
    ) : (
      // Punctuation inside: already forms.
      { inside: false, outside: false }
    );
  }
  return insideKind === void 0 ? (
    // Letter inside: already forms.
    { inside: false, outside: false }
  ) : insideKind === 1 ? (
    // Whitespace inside: encode inner (whitespace).
    { inside: true, outside: false }
  ) : (
    // Punctuation inside: already forms.
    { inside: false, outside: false }
  );
}

function htmlKind(value) {
  if (value.charCodeAt(0) !== 60) return;
  const next = value.charCodeAt(1);
  if (next === 33) {
    const code5 = value.charCodeAt(2);
    if (code5 === 45) return 2;
    if (code5 === 91) return 5;
    if (asciiAlpha(code5)) return 4;
    return;
  }
  if (next === 63) return 3;
  const closing = next === 47;
  const start2 = closing ? 2 : 1;
  let end = start2;
  let code4 = value.charCodeAt(end);
  if (!asciiAlpha(code4)) return;
  while (code4 === 45 || asciiAlphanumeric(code4)) {
    code4 = value.charCodeAt(++end);
  }
  const name2 = value.slice(start2, end).toLowerCase();
  if (!closing && code4 !== 47 && htmlRawNames.includes(name2)) {
    return 1;
  }
  return htmlBlockNames.includes(name2) ? 6 : 7;
}

var builtins = /* @__PURE__ */ new Map([
  ["*", false],
  ["_", true]
]);
function candidates(tokens, involved, runOf) {
  const related = /* @__PURE__ */ new Set();
  for (const token of tokens) {
    const siblings = runOf.get(token);
    if (siblings && token.attention && involved.some((d) => d.attention === token.attention)) {
      for (const sibling of siblings.tokens) {
        related.add(sibling.attention);
      }
    }
  }
  const ordered = [];
  for (const token of tokens) {
    if (token.attention && related.delete(token.attention)) {
      ordered.push(token.attention);
    }
  }
  ordered.reverse();
  return ordered;
}
function check(tokens, before, after) {
  const runs = [];
  const wrong = /* @__PURE__ */ new Map();
  const runOf = /* @__PURE__ */ new Map();
  let index3 = 0;
  while (index3 < tokens.length) {
    if (!tokens[index3].attention) {
      index3++;
      continue;
    }
    const marker = tokens[index3].value.charAt(0);
    const strict = builtins.get(marker);
    let end = index3 + 1;
    while (end < tokens.length && tokens[end].attention && tokens[end].value.charAt(0) === marker) {
      end++;
    }
    const head = index3 ? tokens[index3 - 1].value : before;
    const previous3 = classifyCharacter(head.charCodeAt(head.length - 1));
    const next = classifyCharacter(
      (end < tokens.length ? tokens[end].value : after).charCodeAt(0)
    );
    const open = !next || next === 2 && Boolean(previous3);
    const close = !previous3 || previous3 === 2 && Boolean(next);
    const run = {
      tokens: tokens.slice(index3, end),
      markers: [],
      start: 0,
      end: 0,
      // Underscores are strict, they cannot open or close inside words.
      open: strict ? open && (Boolean(previous3) || !close) : open,
      close: strict ? close && (Boolean(next) || !open) : close,
      // All builtins can split runs.
      split: strict !== void 0
    };
    for (const token of run.tokens) {
      wrong.set(token, [...run.tokens]);
      runOf.set(token, run);
      let size = token.value.length;
      while (size--) run.markers.push(token);
    }
    run.end = run.markers.length;
    runs.push(run);
    index3 = end;
  }
  pair(runs, wrong);
  index3 = -1;
  while (++index3 < tokens.length) {
    const involved = wrong.get(tokens[index3]);
    if (involved) return { attention: candidates(tokens, involved, runOf), index: index3 };
  }
}
function encode(tokens, start2) {
  const token = tokens[start2 ? 0 : tokens.length - 1];
  if (!token || token.attention) return;
  const character = start2 ? firstCharacter(token.value) : lastCharacter(token.value);
  const reference = encodeCharacterReference(
    /** @type {number} */
    character.codePointAt(0)
  );
  if (start2) {
    token.value = reference + token.value.slice(character.length);
  } else {
    let value = token.value.slice(0, token.value.length - character.length);
    let escapes = 0;
    while (value.charCodeAt(value.length - 1 - escapes) === 92) {
      escapes++;
    }
    if (escapes % 2) value += "\\";
    token.value = value + reference;
  }
}
function improve(items, chosen, mistake, before, after) {
  for (const attention4 of mistake.attention) {
    const current = chosen.get(attention4) || attention4.sequences[0];
    for (const sequence of attention4.sequences) {
      if (sequence === current) continue;
      const trial = new Map(chosen);
      trial.set(attention4, sequence);
      const tokens = render(items, trial, before, after);
      const next = check(tokens, before, after);
      if (!next || next.index > mistake.index) {
        return { chosen: trial, mistake: next, tokens };
      }
    }
  }
}
function pair(runs, wrong) {
  const openersByMarker = /* @__PURE__ */ new Map();
  for (const closer of runs) {
    const marker = closer.tokens[0].value.charAt(0);
    let openers = openersByMarker.get(marker);
    if (!openers) {
      openers = [];
      openersByMarker.set(marker, openers);
    }
    let open = closer.close ? openers.length : 0;
    while (open-- && closer.start < closer.end) {
      const opener = openers[open];
      const openerSize = opener.end - opener.start;
      const closerSize = closer.end - closer.start;
      if (closer.split ? (
        // The rule of 3, on the sizes that are left.
        (opener.close || closer.open) && closerSize % 3 && !((openerSize + closerSize) % 3)
      ) : (
        // Others pair whole runs of the same size.
        openerSize !== opener.markers.length || openerSize !== closerSize
      )) {
        continue;
      }
      const size = closer.split ? openerSize > 1 && closerSize > 1 ? 2 : 1 : closerSize;
      const opening = opener.markers.slice(opener.end - size, opener.end);
      const closing = closer.markers.slice(closer.start, closer.start + size);
      const openToken = opening[0];
      const closeToken = closing[0];
      if (
        // Whole sequences:
        // the markers of a sequence are next to each other,
        // so if the first and last marker are of one sequence of that size,
        // all markers are exactly that sequence.
        openToken === opening[size - 1] && openToken.value.length === size && closeToken === closing[size - 1] && closeToken.value.length === size && // Of the same attention, so its opening and closing sequence.
        openToken.attention === closeToken.attention
      ) {
        wrong.delete(openToken);
        wrong.delete(closeToken);
      } else {
        const involved = [.../* @__PURE__ */ new Set([...opening, ...closing])];
        for (const token of involved) {
          const list4 = wrong.get(token);
          if (list4) list4.push(...involved);
        }
      }
      opener.end -= size;
      closer.start += size;
      if (opener.start === opener.end) openers.splice(open, 1);
      open = openers.length;
    }
    if (closer.open && closer.start < closer.end) openers.push(closer);
  }
}
function attentionSequences(type, markers, sizes) {
  if (markers.length === 0) {
    throw new Error(
      "Cannot serialize `" + type + "` as attention without markers, expected one or more markers"
    );
  }
  if (sizes.length === 0) {
    throw new Error(
      "Cannot serialize `" + type + "` as attention without sizes, expected one or more sizes"
    );
  }
  for (const size of sizes) {
    if (!Number.isSafeInteger(size) || size < 1) {
      throw new Error(
        "Cannot serialize `" + type + "` as attention with `" + size + "` as size, expected positive integer"
      );
    }
  }
  const sequences = [];
  for (const marker of markers) {
    if (marker.length !== 1) {
      throw new Error(
        "Cannot serialize `" + type + "` as attention with `" + marker + "` as marker, expected a single ascii character"
      );
    }
    if (!asciiPunctuation(marker.charCodeAt(0))) {
      throw new Error(
        "Cannot serialize `" + type + "` as attention with `" + marker + "` as marker, expected ascii punctuation"
      );
    }
    for (const size of sizes) {
      sequences.push(marker.repeat(size));
    }
  }
  return sequences;
}
function phrasing2(parent, state, info) {
  const indexStack = state.indexStack;
  const children = parent.children || [];
  const results = [];
  let index3 = -1;
  let before = info.before;
  indexStack.push(-1);
  let tracker = state.createTracker(info);
  while (++index3 < children.length) {
    const child = children[index3];
    let after;
    indexStack[indexStack.length - 1] = index3;
    if (index3 + 1 < children.length) {
      let handle3 = state.handle.handlers[children[index3 + 1].type];
      if (handle3 && handle3.peek) handle3 = handle3.peek;
      after = handle3 ? firstCharacter(
        handle3(children[index3 + 1], parent, state, {
          before: "",
          after: "",
          ...tracker.current()
        })
      ) : "";
    } else {
      after = info.after;
    }
    const previous3 = results[results.length - 1];
    if (typeof previous3 === "string" && (before === "\r" || before === "\n") && child.type === "html" && htmlKind(child.value) !== 7) {
      results[results.length - 1] = previous3.replace(/(\r?\n|\r)$/, " ");
      before = " ";
      tracker = state.createTracker(info);
      tracker.move(serialize3(results, info.before, info.after));
    }
    const handle2 = state.handle.handlers[child.type];
    if (handle2 && handle2.attention) {
      const item = attentionItem(
        /** @type {PhrasingParents} */
        child,
        handle2.attention,
        state,
        tracker
      );
      if (!item) continue;
      results.push(item);
      before = lastCharacter(item.sequences[0]);
    } else {
      const value = state.handle(child, parent, state, {
        ...tracker.current(),
        after,
        before
      });
      if (!value) continue;
      tracker.move(value);
      results.push(value);
      before = lastCharacter(value);
    }
  }
  indexStack.pop();
  return results;
}
function attentionItem(node2, attention4, state, tracker) {
  const { construct, markers, sizes } = attention4(node2, state);
  const sequences = attentionSequences(node2.type, markers, sizes);
  const sequence = sequences[0];
  const exit3 = state.enter(construct);
  const inside = state.createTracker(tracker.current());
  inside.move(sequence);
  const children = phrasing2(node2, state, {
    ...inside.current(),
    before: sequence,
    after: sequence
  });
  exit3();
  if (children.length === 0) return;
  tracker.move(sequence);
  tracker.move(serialize3(children, sequence, sequence));
  tracker.move(sequence);
  return { children, sequences };
}
function fix(items, chosen, before, after) {
  let tokens = render(items, chosen, before, after);
  let mistake = check(tokens, before, after);
  while (mistake) {
    const next = improve(items, chosen, mistake, before, after);
    if (!next) return;
    chosen = next.chosen;
    tokens = next.tokens;
    mistake = next.mistake;
  }
  return tokens;
}
function guess(items, chosen, before, after) {
  let previous3 = before;
  let index3 = -1;
  while (++index3 < items.length) {
    const item = items[index3];
    if (typeof item === "string") {
      previous3 = "";
      continue;
    }
    const next = index3 === items.length - 1 ? after : "";
    const sequence = item.sequences.find(function(value) {
      const marker = value.charAt(0);
      return marker !== previous3.charAt(0) && marker !== next.charAt(0) || items.length === 1 && builtins.has(marker) && value.length > before.length;
    }) || item.sequences[0];
    if (sequence !== item.sequences[0]) chosen.set(item, sequence);
    guess(item.children, chosen, sequence, sequence);
    previous3 = sequence;
  }
}
function render(items, chosen, before, after) {
  const tokens = [];
  let encodeAfter;
  let previous3 = lastCharacter(before);
  let index3 = -1;
  while (++index3 < items.length) {
    const item = items[index3];
    if (typeof item === "string") {
      const token = { value: item, attention: void 0 };
      if (encodeAfter && encodeAfter === firstCharacter(item)) {
        encode([token], true);
      }
      encodeAfter = void 0;
      tokens.push(token);
      if (token.value) previous3 = lastCharacter(token.value);
      continue;
    }
    const sequence = chosen.get(item) || item.sequences[0];
    const marker = sequence.charAt(0);
    const next = items[index3 + 1];
    const outsideBefore = previous3;
    const outsideAfter = firstCharacter(
      next === void 0 ? after : typeof next === "string" ? next : chosen.get(next) || next.sequences[0]
    );
    const inside = render(item.children, chosen, sequence, sequence);
    const head = inside[0].value;
    const open = encodeInfo(
      outsideBefore.charCodeAt(outsideBefore.length - 1),
      head.charCodeAt(0),
      marker
    );
    if (open.inside) encode(inside, true);
    const tail = lastCharacter(inside[inside.length - 1].value);
    const close = encodeInfo(
      outsideAfter.charCodeAt(0),
      tail.charCodeAt(tail.length - 1),
      marker
    );
    if (close.inside) encode(inside, false);
    if (open.outside && outsideBefore !== "\n" && outsideBefore !== "\r") {
      encode(tokens, false);
    }
    if (close.outside) encodeAfter = outsideAfter;
    tokens.push({ value: sequence, attention: item }, ...inside, {
      value: sequence,
      attention: item
    });
    previous3 = sequence.charAt(sequence.length - 1);
  }
  return tokens;
}
function serialize3(items, before, after) {
  const guessed = /* @__PURE__ */ new Map();
  guess(items, guessed, before, after);
  const tokens = (
    // Start from guesses (based on the preferred sequences).
    (guessed.size > 0 ? fix(items, guessed, before, after) : void 0) || // If stuck, start from the preferred sequences instead.
    fix(items, /* @__PURE__ */ new Map(), before, after) || // If stuck again, use the preferred sequences as they are.
    render(items, /* @__PURE__ */ new Map(), before, after)
  );
  let result = "";
  for (const token of tokens) result += token.value;
  return result;
}

emphasis2.attention = attention2;
emphasis2.peek = peek;
function emphasis2(node2, _, state, info) {
  const exit3 = state.enter("phrasing");
  const item = attentionItem(node2, attention2, state, state.createTracker(info));
  const value = item ? serialize3([item], info.before, info.after) : "";
  exit3();
  return value;
}
function attention2(_, state) {
  const marker = checkEmphasis(state);
  return {
    construct: "emphasis",
    markers: marker === "*" ? ["*", "_"] : ["_", "*"],
    sizes: [1]
  };
}
function peek(_, _1, state) {
  return state.options.emphasis || "*";
}

function formatHeadingAsSetext(node2, state) {
  let literalWithBreak = false;
  visit(node2, function(node3) {
    if ("value" in node3 && /\r?\n|\r/.test(node3.value) || node3.type === "break") {
      literalWithBreak = true;
      return EXIT;
    }
  });
  return Boolean(
    (!node2.depth || node2.depth < 3) && toString(node2) && (state.options.setext || literalWithBreak)
  );
}

function heading2(node2, _, state, info) {
  const rank = Math.max(Math.min(6, node2.depth || 1), 1);
  const tracker = state.createTracker(info);
  if (formatHeadingAsSetext(node2, state)) {
    const exit4 = state.enter("headingSetext");
    const subexit2 = state.enter("phrasing");
    const value2 = state.containerPhrasing(node2, {
      ...tracker.current(),
      before: "\n",
      after: "\n"
    });
    subexit2();
    exit4();
    return value2 + "\n" + (rank === 1 ? "=" : "-").repeat(
      // The whole size…
      value2.length - // Minus the position of the character after the last EOL (or
      // 0 if there is none)…
      (Math.max(value2.lastIndexOf("\r"), value2.lastIndexOf("\n")) + 1)
    );
  }
  const sequence = "#".repeat(rank);
  const exit3 = state.enter("headingAtx");
  const subexit = state.enter("phrasing");
  tracker.move(sequence + " ");
  let value = state.containerPhrasing(node2, {
    before: "# ",
    after: "\n",
    ...tracker.current()
  });
  const head = value.charCodeAt(0);
  if (head === 9 || head === 32) {
    value = encodeCharacterReference(head) + value.slice(1);
  }
  value = value ? sequence + " " + value : sequence;
  if (state.options.closeAtx) {
    value += " " + sequence;
  }
  subexit();
  exit3();
  return value;
}

html4.peek = htmlPeek;
function html4(node2) {
  return node2.value || "";
}
function htmlPeek() {
  return "<";
}

image2.peek = imagePeek;
function image2(node2, _, state, info) {
  const quote = checkQuote(state);
  const suffix = quote === '"' ? "Quote" : "Apostrophe";
  const exit3 = state.enter("image");
  let subexit = state.enter("label");
  const tracker = state.createTracker(info);
  let value = tracker.move("![");
  value += tracker.move(
    state.safe(node2.alt, { before: value, after: "]", ...tracker.current() })
  );
  value += tracker.move("](");
  subexit();
  if (
    // If there’s no url but there is a title…
    !node2.url && node2.title || // If there are control characters or whitespace.
    /[\0- \u007F]/.test(node2.url)
  ) {
    subexit = state.enter("destinationLiteral");
    value += tracker.move("<");
    value += tracker.move(
      state.safe(node2.url, { before: value, after: ">", ...tracker.current() })
    );
    value += tracker.move(">");
  } else {
    subexit = state.enter("destinationRaw");
    value += tracker.move(
      state.safe(node2.url, {
        before: value,
        after: node2.title ? " " : ")",
        ...tracker.current()
      })
    );
  }
  subexit();
  if (node2.title) {
    subexit = state.enter(`title${suffix}`);
    value += tracker.move(" " + quote);
    value += tracker.move(
      state.safe(node2.title, {
        before: value,
        after: quote,
        ...tracker.current()
      })
    );
    value += tracker.move(quote);
    subexit();
  }
  value += tracker.move(")");
  exit3();
  return value;
}
function imagePeek() {
  return "!";
}

imageReference2.peek = imageReferencePeek;
function imageReference2(node2, _, state, info) {
  const type = node2.referenceType;
  const exit3 = state.enter("imageReference");
  let subexit = state.enter("label");
  const tracker = state.createTracker(info);
  let value = tracker.move("![");
  const alt = state.safe(node2.alt, {
    before: value,
    after: "]",
    ...tracker.current()
  });
  value += tracker.move(alt + "][");
  subexit();
  const stack = state.stack;
  state.stack = stack.filter(function(d) {
    return d !== "phrasing";
  });
  subexit = state.enter("reference");
  const reference = state.safe(state.associationId(node2), {
    before: value,
    after: "]",
    ...tracker.current()
  });
  subexit();
  state.stack = stack;
  exit3();
  if (type === "full" || !alt || alt !== reference) {
    value += tracker.move(reference + "]");
  } else if (type === "shortcut") {
    value = value.slice(0, -1);
  } else {
    value += tracker.move("]");
  }
  return value;
}
function imageReferencePeek() {
  return "!";
}

inlineCode2.peek = inlineCodePeek;
function inlineCode2(node2, _, state) {
  let value = node2.value || "";
  let sequence = "`";
  let index3 = -1;
  while (new RegExp("(^|[^`])" + sequence + "([^`]|$)").test(value)) {
    sequence += "`";
  }
  if (/[^\n\r ]/.test(value) && (/^[\n\r ]/.test(value) && /[\n\r ]$/.test(value) || /^`|`$/.test(value))) {
    value = " " + value + " ";
  }
  while (++index3 < state.unsafe.length) {
    const pattern = state.unsafe[index3];
    const expression = state.compilePattern(pattern);
    if (!pattern.atBreak) continue;
    let match;
    while (match = expression.exec(value)) {
      let position3 = match.index;
      if (value.charCodeAt(position3) === 10 && value.charCodeAt(position3 - 1) === 13) {
        position3--;
      }
      value = value.slice(0, position3) + " " + value.slice(match.index + 1);
    }
  }
  return sequence + value + sequence;
}
function inlineCodePeek() {
  return "`";
}

function formatLinkAsAutolink(node2, state) {
  const raw = toString(node2);
  return Boolean(
    !state.options.resourceLink && // If there’s a url…
    node2.url && // And there’s no title…
    !node2.title && // And the content of `node` is a single text node…
    node2.children && node2.children.length === 1 && node2.children[0].type === "text" && // And if the url is the same as the content…
    (raw === node2.url || "mailto:" + raw === node2.url) && // And that starts w/ a protocol…
    /^[a-z][+\-.a-z]+:/i.test(node2.url) && // And that doesn’t contain ASCII control codes (character escapes and
    // references don’t work), space, or angle brackets…
    !/[\0- <>\u007F]/.test(node2.url)
  );
}

link2.peek = linkPeek;
function link2(node2, _, state, info) {
  const quote = checkQuote(state);
  const suffix = quote === '"' ? "Quote" : "Apostrophe";
  const tracker = state.createTracker(info);
  if (formatLinkAsAutolink(node2, state)) {
    const stack = state.stack;
    state.stack = stack.filter(function(d) {
      return d !== "phrasing";
    });
    const exit4 = state.enter("autolink");
    let value2 = tracker.move("<");
    value2 += tracker.move(
      state.containerPhrasing(node2, {
        before: value2,
        after: ">",
        ...tracker.current()
      })
    );
    value2 += tracker.move(">");
    exit4();
    state.stack = stack;
    return value2;
  }
  const exit3 = state.enter("link");
  let subexit = state.enter("label");
  let value = tracker.move("[");
  const text7 = state.containerPhrasing(node2, {
    before: value,
    after: "](",
    ...tracker.current()
  });
  value += tracker.move(text7);
  subexit();
  value += tracker.move("](");
  const enclose = /[\0- \u007F]/.test(node2.url);
  const last = info.before.charAt(info.before.length - 1);
  let title = node2.title || void 0;
  if (!title && !enclose && (last === "\n" || last === "\r")) {
    let index3 = 0;
    while (index3 < text7.length && text7.charCodeAt(index3) !== 93) {
      index3 += text7.charCodeAt(index3) === 92 ? 2 : 1;
    }
    if (text7.charCodeAt(index3 + 1) === 58) title = "";
  }
  if (
    // If there’s no url but there is a title…
    !node2.url && typeof title === "string" || // If there are control characters or whitespace.
    enclose
  ) {
    subexit = state.enter("destinationLiteral");
    value += tracker.move("<");
    value += tracker.move(
      state.safe(node2.url, { before: value, after: ">", ...tracker.current() })
    );
    value += tracker.move(">");
  } else {
    subexit = state.enter("destinationRaw");
    value += tracker.move(
      state.safe(node2.url, {
        before: value,
        after: typeof title === "string" ? " " : ")",
        ...tracker.current()
      })
    );
  }
  subexit();
  if (typeof title === "string") {
    subexit = state.enter(`title${suffix}`);
    value += tracker.move(" " + quote);
    value += tracker.move(
      state.safe(title, {
        before: value,
        after: quote,
        ...tracker.current()
      })
    );
    value += tracker.move(quote);
    subexit();
  }
  value += tracker.move(")");
  exit3();
  return value;
}
function linkPeek(node2, _, state) {
  return formatLinkAsAutolink(node2, state) ? "<" : "[";
}

linkReference2.peek = linkReferencePeek;
function linkReference2(node2, _, state, info) {
  const type = node2.referenceType;
  const exit3 = state.enter("linkReference");
  let subexit = state.enter("label");
  const tracker = state.createTracker(info);
  let value = tracker.move("[");
  const text7 = state.containerPhrasing(node2, {
    before: value,
    after: "]",
    ...tracker.current()
  });
  value += tracker.move(text7 + "][");
  subexit();
  const stack = state.stack;
  state.stack = stack.filter(function(d) {
    return d !== "phrasing";
  });
  subexit = state.enter("reference");
  const reference = state.safe(state.associationId(node2), {
    before: value,
    after: "]",
    ...tracker.current()
  });
  subexit();
  state.stack = stack;
  exit3();
  if (type === "full" || !text7 || text7 !== reference) {
    value += tracker.move(reference + "]");
  } else if (type === "shortcut") {
    value = value.slice(0, -1);
  } else {
    value += tracker.move("]");
  }
  return value;
}
function linkReferencePeek() {
  return "[";
}

function checkBullet(state) {
  const marker = state.options.bullet || "*";
  if (marker !== "*" && marker !== "+" && marker !== "-") {
    throw new Error(
      "Cannot serialize items with `" + marker + "` for `options.bullet`, expected `*`, `+`, or `-`"
    );
  }
  return marker;
}

function checkBulletOther(state) {
  const bullet = checkBullet(state);
  const bulletOther = state.options.bulletOther;
  if (!bulletOther) {
    return bullet === "*" ? "-" : "*";
  }
  if (bulletOther !== "*" && bulletOther !== "+" && bulletOther !== "-") {
    throw new Error(
      "Cannot serialize items with `" + bulletOther + "` for `options.bulletOther`, expected `*`, `+`, or `-`"
    );
  }
  if (bulletOther === bullet) {
    throw new Error(
      "Expected `bullet` (`" + bullet + "`) and `bulletOther` (`" + bulletOther + "`) to be different"
    );
  }
  return bulletOther;
}

function checkBulletOrdered(state) {
  const marker = state.options.bulletOrdered || ".";
  if (marker !== "." && marker !== ")") {
    throw new Error(
      "Cannot serialize items with `" + marker + "` for `options.bulletOrdered`, expected `.` or `)`"
    );
  }
  return marker;
}

function checkRule(state) {
  const marker = state.options.rule || "*";
  if (marker !== "*" && marker !== "-" && marker !== "_") {
    throw new Error(
      "Cannot serialize rules with `" + marker + "` for `options.rule`, expected `*`, `-`, or `_`"
    );
  }
  return marker;
}

function list3(node2, parent, state, info) {
  const exit3 = state.enter("list");
  const bulletCurrent = state.bulletCurrent;
  let bullet = node2.ordered ? checkBulletOrdered(state) : checkBullet(state);
  const bulletOther = node2.ordered ? bullet === "." ? ")" : "." : checkBulletOther(state);
  let useDifferentMarker = parent && state.bulletLastUsed ? bullet === state.bulletLastUsed : false;
  if (!node2.ordered) {
    const firstListItem = node2.children ? node2.children[0] : void 0;
    if (
      // Bullet could be used as a thematic break marker:
      (bullet === "*" || bullet === "-") && // Empty first list item:
      firstListItem && (!firstListItem.children || !firstListItem.children[0]) && // Directly in two other list items:
      state.stack[state.stack.length - 1] === "list" && state.stack[state.stack.length - 2] === "listItem" && state.stack[state.stack.length - 3] === "list" && state.stack[state.stack.length - 4] === "listItem" && // That are each the first child.
      state.indexStack[state.indexStack.length - 1] === 0 && state.indexStack[state.indexStack.length - 2] === 0 && state.indexStack[state.indexStack.length - 3] === 0
    ) {
      useDifferentMarker = true;
    }
    if (checkRule(state) === bullet && firstListItem) {
      let index3 = -1;
      while (++index3 < node2.children.length) {
        const item = node2.children[index3];
        if (item && item.type === "listItem" && item.children && item.children[0] && item.children[0].type === "thematicBreak") {
          useDifferentMarker = true;
          break;
        }
      }
    }
  }
  if (useDifferentMarker) {
    bullet = bulletOther;
  }
  state.bulletCurrent = bullet;
  const value = state.containerFlow(node2, info);
  state.bulletLastUsed = bullet;
  state.bulletCurrent = bulletCurrent;
  exit3();
  return value;
}

function checkListItemIndent(state) {
  const style = state.options.listItemIndent || "one";
  if (style !== "tab" && style !== "one" && style !== "mixed") {
    throw new Error(
      "Cannot serialize items with `" + style + "` for `options.listItemIndent`, expected `tab`, `one`, or `mixed`"
    );
  }
  return style;
}

function listItem2(node2, parent, state, info) {
  const listItemIndent = checkListItemIndent(state);
  let bullet = state.bulletCurrent || checkBullet(state);
  if (parent && parent.type === "list" && parent.ordered) {
    bullet = (typeof parent.start === "number" && parent.start > -1 ? parent.start : 1) + (state.options.incrementListMarker === false ? 0 : parent.children.indexOf(node2)) + bullet;
  }
  let size = bullet.length + 1;
  if (listItemIndent === "tab" || listItemIndent === "mixed" && (parent && parent.type === "list" && parent.spread || node2.spread)) {
    size = Math.ceil(size / 4) * 4;
  }
  const tracker = state.createTracker(info);
  tracker.move(bullet + " ".repeat(size - bullet.length));
  tracker.shift(size);
  const exit3 = state.enter("listItem");
  const value = state.indentLines(
    state.containerFlow(node2, tracker.current()),
    map3
  );
  exit3();
  return value;
  function map3(line, index3, blank) {
    if (index3) {
      return (blank ? "" : " ".repeat(size)) + line;
    }
    return (blank ? bullet : bullet + " ".repeat(size - bullet.length)) + line;
  }
}

function paragraph2(node2, _, state, info) {
  const exit3 = state.enter("paragraph");
  const subexit = state.enter("phrasing");
  const value = state.containerPhrasing(node2, info);
  subexit();
  exit3();
  return value;
}

function root3(node2, _, state, info) {
  const hasPhrasing = node2.children.some(function(d) {
    return phrasing(d);
  });
  if (!hasPhrasing) return state.containerFlow(node2, info);
  const exit3 = state.enter("phrasing");
  const value = state.containerPhrasing(node2, info);
  exit3();
  return value;
}

function checkStrong(state) {
  const marker = state.options.strong || "*";
  if (marker !== "*" && marker !== "_") {
    throw new Error(
      "Cannot serialize strong with `" + marker + "` for `options.strong`, expected `*`, or `_`"
    );
  }
  return marker;
}

strong2.attention = attention3;
strong2.peek = peek2;
function strong2(node2, _, state, info) {
  const exit3 = state.enter("phrasing");
  const item = attentionItem(node2, attention3, state, state.createTracker(info));
  const value = item ? serialize3([item], info.before, info.after) : "";
  exit3();
  return value;
}
function attention3(_, state) {
  const marker = checkStrong(state);
  return {
    construct: "strong",
    markers: marker === "*" ? ["*", "_"] : ["_", "*"],
    sizes: [2]
  };
}
function peek2(_, _1, state) {
  return state.options.strong || "*";
}

function text5(node2, parent, state, info) {
  const siblings = parent ? parent.children : [];
  const index3 = state.indexStack[state.indexStack.length - 1];
  return state.safe(node2.value, {
    ...info,
    afterNode: siblings[index3 + 1],
    beforeNode: siblings[index3 - 1]
  });
}

function checkRuleRepetition(state) {
  const repetition = state.options.ruleRepetition || 3;
  if (repetition < 3) {
    throw new Error(
      "Cannot serialize rules with repetition `" + repetition + "` for `options.ruleRepetition`, expected `3` or more"
    );
  }
  return repetition;
}

function thematicBreak3(_, _1, state) {
  const value = (checkRule(state) + (state.options.ruleSpaces ? " " : "")).repeat(checkRuleRepetition(state));
  return state.options.ruleSpaces ? value.slice(0, -1) : value;
}

var handle = {
  blockquote: blockquote2,
  break: hardBreak2,
  code: code2,
  definition: definition2,
  emphasis: emphasis2,
  hardBreak: hardBreak2,
  heading: heading2,
  html: html4,
  image: image2,
  imageReference: imageReference2,
  inlineCode: inlineCode2,
  link: link2,
  linkReference: linkReference2,
  list: list3,
  listItem: listItem2,
  paragraph: paragraph2,
  root: root3,
  strong: strong2,
  text: text5,
  thematicBreak: thematicBreak3
};

function gfmTableFromMarkdown() {
  return {
    enter: {
      table: enterTable,
      tableData: enterCell,
      tableHeader: enterCell,
      tableRow: enterRow
    },
    exit: {
      codeText: exitCodeText,
      table: exitTable,
      tableData: exit2,
      tableHeader: exit2,
      tableRow: exit2
    }
  };
}
function enterTable(token) {
  const align = token._align;
  ok(align, "expected `_align` on table");
  this.enter(
    {
      type: "table",
      align: align.map(function(d) {
        return d === "none" ? null : d;
      }),
      children: [],
      position: void 0
    },
    token
  );
  this.data.inTable = true;
}
function exitTable(token) {
  this.exit(token);
  this.data.inTable = void 0;
}
function enterRow(token) {
  this.enter({ type: "tableRow", children: [], position: void 0 }, token);
}
function exit2(token) {
  this.exit(token);
}
function enterCell(token) {
  this.enter({ type: "tableCell", children: [], position: void 0 }, token);
}
function exitCodeText(token) {
  let value = this.resume();
  if (this.data.inTable) {
    value = value.replace(/\\([\\|])/g, replace);
  }
  const node2 = this.stack[this.stack.length - 1];
  ok(node2.type === "inlineCode");
  node2.value = value;
  this.exit(token);
}
function replace($0, $1) {
  return $1 === "|" ? $1 : $0;
}
function gfmTableToMarkdown(options) {
  const settings = options || {};
  const {
    tableCellPadding: padding,
    tablePipeAlign: alignDelimiters,
    stringLength
  } = settings;
  const around = padding ? " " : "|";
  return {
    handlers: {
      inlineCode: inlineCodeWithTable,
      table: handleTable,
      tableCell: handleTableCell,
      tableRow: handleTableRow
    },
    join: [joinTable],
    unsafe: [
      { character: "\r", inConstruct: "tableCell" },
      { character: "\n", inConstruct: "tableCell" },
      // A pipe, when followed by a tab or space (padding), or a dash or colon
      // (unpadded delimiter row), could result in a table.
      { atBreak: true, character: "|", after: "[	 :-]" },
      // A pipe in a cell must be encoded.
      { character: "|", inConstruct: "tableCell" },
      // A colon must be followed by a dash, in which case it could start a
      // delimiter row.
      { atBreak: true, character: ":", after: "-" },
      // A delimiter row can also start with a dash, when followed by more
      // dashes, a colon, or a pipe.
      // This is a stricter version than the built in check for lists, thematic
      // breaks, and setex heading underlines though:
      // <https://github.com/syntax-tree/mdast-util-to-markdown/blob/51a2038/lib/unsafe.js#L57>
      { atBreak: true, character: "-", after: "[:|-]" }
    ]
  };
  function handleTable(node2, _, state, info) {
    const matrix = handleTableAsData(node2, state, info);
    const head = matrix[0];
    if (head) {
      let columns = node2.align ? node2.align.length : 0;
      let index3 = -1;
      if (!columns) {
        while (++index3 < matrix.length) {
          if (matrix[index3].length > columns) columns = matrix[index3].length;
        }
      }
      while (head.length < columns) head.push("");
    }
    return serializeData(matrix, node2.align);
  }
  function handleTableRow(node2, _, state, info) {
    const row = handleTableRowAsData(node2, state, info);
    const value = serializeData([row]);
    return value.slice(0, value.indexOf("\n"));
  }
  function handleTableCell(node2, _, state, info) {
    const exit3 = state.enter("tableCell");
    const subexit = state.enter("phrasing");
    const value = state.containerPhrasing(node2, {
      ...info,
      before: around,
      after: around
    });
    subexit();
    exit3();
    return value;
  }
  function serializeData(matrix, align) {
    return markdownTable(matrix, {
      align,
      alignDelimiters,
      fillRows: false,
      padding,
      stringLength
    });
  }
  function handleTableAsData(node2, state, info) {
    const { children } = node2;
    let index3 = -1;
    const result = [];
    const subexit = state.enter("table");
    while (++index3 < children.length) {
      result[index3] = handleTableRowAsData(children[index3], state, info);
    }
    subexit();
    return result;
  }
  function handleTableRowAsData(node2, state, info) {
    const { children } = node2;
    let index3 = -1;
    const result = [];
    const subexit = state.enter("tableRow");
    while (++index3 < children.length) {
      result[index3] = handleTableCell(children[index3], node2, state, info);
    }
    subexit();
    return result;
  }
  function inlineCodeWithTable(node2, parent, state) {
    const value = handle.inlineCode(node2, parent, state);
    if (!state.stack.includes("tableCell")) return value;
    const result = [];
    let start2 = 0;
    let index3 = value.indexOf("|");
    while (index3 !== -1) {
      let before = index3;
      while (before > start2 && value.charCodeAt(before - 1) === 92) {
        before--;
      }
      result.push(value.slice(start2, index3));
      if ((index3 - before) % 2 === 0) result.push("\\");
      start2 = index3;
      index3 = value.indexOf("|", index3 + 1);
    }
    result.push(value.slice(start2));
    return result.join("");
  }
}
function joinTable(left, right, parent, state) {
  if (left.type === "table" && parent.type === "listItem" && parent.spread === false && (right.type === "definition" || right.type === "heading" && formatHeadingAsSetext2(right, state) || right.type === "paragraph" || right.type === "table")) {
    return 1;
  }
}
function formatHeadingAsSetext2(node2, state) {
  let literalWithBreak = false;
  visit(node2, function(node3) {
    if (node3.type === "break" || "value" in node3 && /\r?\n|\r/.test(node3.value)) {
      literalWithBreak = true;
      return EXIT;
    }
  });
  return Boolean(
    (!node2.depth || node2.depth < 3) && toString(node2) && (state.options.setext || literalWithBreak)
  );
}

function gfmTaskListItemFromMarkdown() {
  return {
    exit: {
      taskListCheckValueChecked: exitCheck,
      taskListCheckValueUnchecked: exitCheck,
      paragraph: exitParagraphWithTaskListItem
    }
  };
}
function gfmTaskListItemToMarkdown() {
  return {
    handlers: { paragraph: paragraphWithTaskListItem },
    join: [joinDefinitionsBeforeTaskListItemParagraph]
  };
}
function exitCheck(token) {
  const node2 = this.stack[this.stack.length - 2];
  ok(node2.type === "listItem");
  node2.checked = token.type === "taskListCheckValueChecked";
}
function exitParagraphWithTaskListItem(token) {
  const parent = this.stack[this.stack.length - 2];
  if (parent && parent.type === "listItem" && typeof parent.checked === "boolean") {
    const node2 = this.stack[this.stack.length - 1];
    ok(node2.type === "paragraph");
    const head = node2.children[0];
    if (head && head.type === "text") {
      const siblings = parent.children;
      let index3 = -1;
      let firstParagraph;
      while (++index3 < siblings.length) {
        const sibling = siblings[index3];
        if (sibling.type === "paragraph") {
          firstParagraph = sibling;
          break;
        }
      }
      if (firstParagraph === node2) {
        head.value = head.value.slice(1);
        if (head.value.length === 0) {
          node2.children.shift();
        } else if (node2.position && head.position && typeof head.position.start.offset === "number") {
          head.position.start.column++;
          head.position.start.offset++;
          node2.position.start = { ...head.position.start };
        }
      }
    }
  }
  this.exit(token);
}
function paragraphWithTaskListItem(node2, parent, state, info) {
  if (!parent || parent.type !== "listItem" || taskListItemParagraph(parent) !== node2) {
    return handle.paragraph(node2, parent, state, info);
  }
  const checkbox = "[" + (parent.checked ? "x" : " ") + "] ";
  const tracker = state.createTracker(info);
  tracker.move(checkbox);
  const value = handle.paragraph(
    node2.children.length > 0 ? node2 : { type: "paragraph", children: [{ type: "text", value: " " }] },
    parent,
    state,
    { ...info, ...tracker.current() }
  );
  return checkbox + value;
}
function joinDefinitionsBeforeTaskListItemParagraph(left, _, parent) {
  if (!(left.type === "definition" && parent.type === "listItem")) {
    return;
  }
  const paragraph3 = taskListItemParagraph(parent);
  if (paragraph3 && parent.children.indexOf(left) < parent.children.indexOf(paragraph3)) {
    return 0;
  }
}
function taskListItemParagraph(node2) {
  if (typeof node2.checked !== "boolean") {
    return;
  }
  for (const child of node2.children) {
    if (child.type === "paragraph") {
      return child;
    }
    if (child.type !== "definition") {
      return;
    }
  }
}

function gfmFromMarkdown() {
  return [
    gfmAutolinkLiteralFromMarkdown(),
    gfmFootnoteFromMarkdown(),
    gfmStrikethroughFromMarkdown(),
    gfmTableFromMarkdown(),
    gfmTaskListItemFromMarkdown()
  ];
}
function gfmToMarkdown(options) {
  return {
    extensions: [
      gfmAutolinkLiteralToMarkdown(),
      gfmFootnoteToMarkdown(options),
      gfmStrikethroughToMarkdown(),
      gfmTableToMarkdown(options),
      gfmTaskListItemToMarkdown()
    ]
  };
}

var wwwPrefix = {
  tokenize: tokenizeWwwPrefix,
  partial: true
};
var domain = {
  tokenize: tokenizeDomain,
  partial: true
};
var path = {
  tokenize: tokenizePath,
  partial: true
};
var trail = {
  tokenize: tokenizeTrail,
  partial: true
};
var emailDomainDotTrail = {
  tokenize: tokenizeEmailDomainDotTrail,
  partial: true
};
var wwwAutolink = {
  name: "wwwAutolink",
  tokenize: tokenizeWwwAutolink,
  previous: previousWww
};
var protocolAutolink = {
  name: "protocolAutolink",
  tokenize: tokenizeProtocolAutolink,
  previous: previousProtocol
};
var emailAutolink = {
  name: "emailAutolink",
  tokenize: tokenizeEmailAutolink,
  previous: previousEmail
};
var text6 = {};
function gfmAutolinkLiteral() {
  return {
    text: text6
  };
}
var code3 = 48;
while (code3 < 123) {
  text6[code3] = emailAutolink;
  code3++;
  if (code3 === 58) code3 = 65;
  else if (code3 === 91) code3 = 97;
}
text6[43] = emailAutolink;
text6[45] = emailAutolink;
text6[46] = emailAutolink;
text6[95] = emailAutolink;
text6[72] = [emailAutolink, protocolAutolink];
text6[104] = [emailAutolink, protocolAutolink];
text6[87] = [emailAutolink, wwwAutolink];
text6[119] = [emailAutolink, wwwAutolink];
function tokenizeEmailAutolink(effects, ok3, nok) {
  const self2 = this;
  let dot;
  let data;
  return start2;
  function start2(code4) {
    if (!gfmAtext(code4) || !previousEmail.call(self2, self2.previous) || previousUnbalanced(self2.events)) {
      return nok(code4);
    }
    effects.enter("literalAutolink");
    effects.enter("literalAutolinkEmail");
    return atext(code4);
  }
  function atext(code4) {
    if (gfmAtext(code4)) {
      effects.consume(code4);
      return atext;
    }
    if (code4 === 64) {
      effects.consume(code4);
      return emailDomain;
    }
    return nok(code4);
  }
  function emailDomain(code4) {
    if (code4 === 46) {
      return effects.check(emailDomainDotTrail, emailDomainAfter, emailDomainDot)(code4);
    }
    if (code4 === 45 || code4 === 95 || asciiAlphanumeric(code4)) {
      data = true;
      effects.consume(code4);
      return emailDomain;
    }
    return emailDomainAfter(code4);
  }
  function emailDomainDot(code4) {
    effects.consume(code4);
    dot = true;
    return emailDomain;
  }
  function emailDomainAfter(code4) {
    if (data && dot && asciiAlpha(self2.previous)) {
      effects.exit("literalAutolinkEmail");
      effects.exit("literalAutolink");
      return ok3(code4);
    }
    return nok(code4);
  }
}
function tokenizeWwwAutolink(effects, ok3, nok) {
  const self2 = this;
  return wwwStart;
  function wwwStart(code4) {
    if (code4 !== 87 && code4 !== 119 || !previousWww.call(self2, self2.previous) || previousUnbalanced(self2.events)) {
      return nok(code4);
    }
    effects.enter("literalAutolink");
    effects.enter("literalAutolinkWww");
    return effects.check(wwwPrefix, effects.attempt(domain, effects.attempt(path, wwwAfter), nok), nok)(code4);
  }
  function wwwAfter(code4) {
    effects.exit("literalAutolinkWww");
    effects.exit("literalAutolink");
    return ok3(code4);
  }
}
function tokenizeProtocolAutolink(effects, ok3, nok) {
  const self2 = this;
  let buffer = "";
  let seen = false;
  return protocolStart;
  function protocolStart(code4) {
    if ((code4 === 72 || code4 === 104) && previousProtocol.call(self2, self2.previous) && !previousUnbalanced(self2.events)) {
      effects.enter("literalAutolink");
      effects.enter("literalAutolinkHttp");
      buffer += String.fromCodePoint(code4);
      effects.consume(code4);
      return protocolPrefixInside;
    }
    return nok(code4);
  }
  function protocolPrefixInside(code4) {
    if (asciiAlpha(code4) && buffer.length < 5) {
      buffer += String.fromCodePoint(code4);
      effects.consume(code4);
      return protocolPrefixInside;
    }
    if (code4 === 58) {
      const protocol = buffer.toLowerCase();
      if (protocol === "http" || protocol === "https") {
        effects.consume(code4);
        return protocolSlashesInside;
      }
    }
    return nok(code4);
  }
  function protocolSlashesInside(code4) {
    if (code4 === 47) {
      effects.consume(code4);
      if (seen) {
        return afterProtocol;
      }
      seen = true;
      return protocolSlashesInside;
    }
    return nok(code4);
  }
  function afterProtocol(code4) {
    return code4 === null || asciiControl(code4) || markdownLineEndingOrSpace(code4) || unicodeWhitespace(code4) || unicodePunctuation(code4) ? nok(code4) : effects.attempt(domain, effects.attempt(path, protocolAfter), nok)(code4);
  }
  function protocolAfter(code4) {
    effects.exit("literalAutolinkHttp");
    effects.exit("literalAutolink");
    return ok3(code4);
  }
}
function tokenizeWwwPrefix(effects, ok3, nok) {
  let size = 0;
  return wwwPrefixInside;
  function wwwPrefixInside(code4) {
    if ((code4 === 87 || code4 === 119) && size < 3) {
      size++;
      effects.consume(code4);
      return wwwPrefixInside;
    }
    if (code4 === 46 && size === 3) {
      effects.consume(code4);
      return wwwPrefixAfter;
    }
    return nok(code4);
  }
  function wwwPrefixAfter(code4) {
    return code4 === null ? nok(code4) : ok3(code4);
  }
}
function tokenizeDomain(effects, ok3, nok) {
  let underscoreInLastSegment;
  let underscoreInLastLastSegment;
  let seen;
  return domainInside;
  function domainInside(code4) {
    if (code4 === 46 || code4 === 95) {
      return effects.check(trail, domainAfter, domainAtPunctuation)(code4);
    }
    if (code4 === null || markdownLineEndingOrSpace(code4) || unicodeWhitespace(code4) || code4 !== 45 && unicodePunctuation(code4)) {
      return domainAfter(code4);
    }
    seen = true;
    effects.consume(code4);
    return domainInside;
  }
  function domainAtPunctuation(code4) {
    if (code4 === 95) {
      underscoreInLastSegment = true;
    } else {
      underscoreInLastLastSegment = underscoreInLastSegment;
      underscoreInLastSegment = void 0;
    }
    effects.consume(code4);
    return domainInside;
  }
  function domainAfter(code4) {
    if (underscoreInLastLastSegment || underscoreInLastSegment || !seen) {
      return nok(code4);
    }
    return ok3(code4);
  }
}
function tokenizePath(effects, ok3) {
  let sizeOpen = 0;
  let sizeClose = 0;
  return pathInside;
  function pathInside(code4) {
    if (code4 === 40) {
      sizeOpen++;
      effects.consume(code4);
      return pathInside;
    }
    if (code4 === 41 && sizeClose < sizeOpen) {
      return pathAtPunctuation(code4);
    }
    if (code4 === 33 || code4 === 34 || code4 === 38 || code4 === 39 || code4 === 41 || code4 === 42 || code4 === 44 || code4 === 46 || code4 === 58 || code4 === 59 || code4 === 60 || code4 === 63 || code4 === 93 || code4 === 95 || code4 === 126) {
      return effects.check(trail, ok3, pathAtPunctuation)(code4);
    }
    if (code4 === null || markdownLineEndingOrSpace(code4) || unicodeWhitespace(code4)) {
      return ok3(code4);
    }
    effects.consume(code4);
    return pathInside;
  }
  function pathAtPunctuation(code4) {
    if (code4 === 41) {
      sizeClose++;
    }
    effects.consume(code4);
    return pathInside;
  }
}
function tokenizeTrail(effects, ok3, nok) {
  return trail2;
  function trail2(code4) {
    if (code4 === 33 || code4 === 34 || code4 === 39 || code4 === 41 || code4 === 42 || code4 === 44 || code4 === 46 || code4 === 58 || code4 === 59 || code4 === 63 || code4 === 95 || code4 === 126) {
      effects.consume(code4);
      return trail2;
    }
    if (code4 === 38) {
      effects.consume(code4);
      return trailCharacterReferenceStart;
    }
    if (code4 === 93) {
      effects.consume(code4);
      return trailBracketAfter;
    }
    if (
      // `<` is an end.
      code4 === 60 || // So is whitespace.
      code4 === null || markdownLineEndingOrSpace(code4) || unicodeWhitespace(code4)
    ) {
      return ok3(code4);
    }
    return nok(code4);
  }
  function trailBracketAfter(code4) {
    if (code4 === null || code4 === 40 || code4 === 91 || markdownLineEndingOrSpace(code4) || unicodeWhitespace(code4)) {
      return ok3(code4);
    }
    return trail2(code4);
  }
  function trailCharacterReferenceStart(code4) {
    return asciiAlpha(code4) ? trailCharacterReferenceInside(code4) : nok(code4);
  }
  function trailCharacterReferenceInside(code4) {
    if (code4 === 59) {
      effects.consume(code4);
      return trail2;
    }
    if (asciiAlpha(code4)) {
      effects.consume(code4);
      return trailCharacterReferenceInside;
    }
    return nok(code4);
  }
}
function tokenizeEmailDomainDotTrail(effects, ok3, nok) {
  return start2;
  function start2(code4) {
    effects.consume(code4);
    return after;
  }
  function after(code4) {
    return asciiAlphanumeric(code4) ? nok(code4) : ok3(code4);
  }
}
function previousWww(code4) {
  return code4 === null || code4 === 40 || code4 === 42 || code4 === 95 || code4 === 91 || code4 === 93 || code4 === 126 || markdownLineEndingOrSpace(code4);
}
function previousProtocol(code4) {
  return !asciiAlpha(code4);
}
function previousEmail(code4) {
  return !(code4 === 47 || gfmAtext(code4));
}
function gfmAtext(code4) {
  return code4 === 43 || code4 === 45 || code4 === 46 || code4 === 95 || asciiAlphanumeric(code4);
}
function previousUnbalanced(events) {
  let index3 = events.length;
  let result = false;
  while (index3--) {
    const token = events[index3][1];
    if ((token.type === "labelLink" || token.type === "labelImage") && !token._balanced) {
      result = true;
      break;
    }
    if (token._gfmAutolinkLiteralWalkedInto) {
      result = false;
      break;
    }
  }
  if (events.length > 0 && !result) {
    events[events.length - 1][1]._gfmAutolinkLiteralWalkedInto = true;
  }
  return result;
}

var indent = {
  tokenize: tokenizeIndent2,
  partial: true
};
function gfmFootnote() {
  return {
    document: {
      [91]: {
        name: "gfmFootnoteDefinition",
        tokenize: tokenizeDefinitionStart,
        continuation: {
          tokenize: tokenizeDefinitionContinuation
        },
        exit: gfmFootnoteDefinitionEnd
      }
    },
    text: {
      [91]: {
        name: "gfmFootnoteCall",
        tokenize: tokenizeGfmFootnoteCall
      },
      [93]: {
        name: "gfmPotentialFootnoteCall",
        add: "after",
        tokenize: tokenizePotentialGfmFootnoteCall,
        resolveTo: resolveToPotentialGfmFootnoteCall
      }
    }
  };
}
function tokenizePotentialGfmFootnoteCall(effects, ok3, nok) {
  const self2 = this;
  let index3 = self2.events.length;
  const defined = self2.parser.gfmFootnotes || (self2.parser.gfmFootnotes = []);
  let labelStart;
  while (index3--) {
    const token = self2.events[index3][1];
    if (token.type === "labelImage") {
      labelStart = token;
      break;
    }
    if (token.type === "gfmFootnoteCall" || token.type === "labelLink" || token.type === "label" || token.type === "image" || token.type === "link") {
      break;
    }
  }
  return start2;
  function start2(code4) {
    if (!labelStart || !labelStart._balanced) {
      return nok(code4);
    }
    const id = normalizeIdentifier(self2.sliceSerialize({
      start: labelStart.end,
      end: self2.now()
    }));
    if (id.codePointAt(0) !== 94 || !defined.includes(id.slice(1))) {
      return nok(code4);
    }
    effects.enter("gfmFootnoteCallLabelMarker");
    effects.consume(code4);
    effects.exit("gfmFootnoteCallLabelMarker");
    return ok3(code4);
  }
}
function resolveToPotentialGfmFootnoteCall(events, context) {
  let index3 = events.length;
  let labelStart;
  while (index3--) {
    if (events[index3][1].type === "labelImage" && events[index3][0] === "enter") {
      labelStart = events[index3][1];
      break;
    }
  }
  events[index3 + 1][1].type = "data";
  events[index3 + 3][1].type = "gfmFootnoteCallLabelMarker";
  const call = {
    type: "gfmFootnoteCall",
    start: Object.assign({}, events[index3 + 3][1].start),
    end: Object.assign({}, events[events.length - 1][1].end)
  };
  const marker = {
    type: "gfmFootnoteCallMarker",
    start: Object.assign({}, events[index3 + 3][1].end),
    end: Object.assign({}, events[index3 + 3][1].end)
  };
  marker.end.column++;
  marker.end.offset++;
  marker.end._bufferIndex++;
  const string3 = {
    type: "gfmFootnoteCallString",
    start: Object.assign({}, marker.end),
    end: Object.assign({}, events[events.length - 1][1].start)
  };
  const chunk = {
    type: "chunkString",
    contentType: "string",
    start: Object.assign({}, string3.start),
    end: Object.assign({}, string3.end)
  };
  const replacement = [
    // Take the `labelImageMarker` (now `data`, the `!`)
    events[index3 + 1],
    events[index3 + 2],
    ["enter", call, context],
    // The `[`
    events[index3 + 3],
    events[index3 + 4],
    // The `^`.
    ["enter", marker, context],
    ["exit", marker, context],
    // Everything in between.
    ["enter", string3, context],
    ["enter", chunk, context],
    ["exit", chunk, context],
    ["exit", string3, context],
    // The ending (`]`, properly parsed and labelled).
    events[events.length - 2],
    events[events.length - 1],
    ["exit", call, context]
  ];
  events.splice(index3, events.length - index3 + 1, ...replacement);
  return events;
}
function tokenizeGfmFootnoteCall(effects, ok3, nok) {
  const self2 = this;
  const defined = self2.parser.gfmFootnotes || (self2.parser.gfmFootnotes = []);
  let size = 0;
  let data;
  return start2;
  function start2(code4) {
    effects.enter("gfmFootnoteCall");
    effects.enter("gfmFootnoteCallLabelMarker");
    effects.consume(code4);
    effects.exit("gfmFootnoteCallLabelMarker");
    return callStart;
  }
  function callStart(code4) {
    if (code4 !== 94) return nok(code4);
    effects.enter("gfmFootnoteCallMarker");
    effects.consume(code4);
    effects.exit("gfmFootnoteCallMarker");
    effects.enter("gfmFootnoteCallString");
    effects.enter("chunkString").contentType = "string";
    return callData;
  }
  function callData(code4) {
    if (
      // Too long.
      size > 999 || // Closing brace with nothing.
      code4 === 93 && !data || // Space or tab is not supported by GFM for some reason.
      // `\n` and `[` not being supported makes sense.
      code4 === null || code4 === 91 || markdownLineEndingOrSpace(code4)
    ) {
      return nok(code4);
    }
    if (code4 === 93) {
      effects.exit("chunkString");
      const token = effects.exit("gfmFootnoteCallString");
      if (!defined.includes(normalizeIdentifier(self2.sliceSerialize(token)))) {
        return nok(code4);
      }
      effects.enter("gfmFootnoteCallLabelMarker");
      effects.consume(code4);
      effects.exit("gfmFootnoteCallLabelMarker");
      effects.exit("gfmFootnoteCall");
      return ok3;
    }
    if (!markdownLineEndingOrSpace(code4)) {
      data = true;
    }
    size++;
    effects.consume(code4);
    return code4 === 92 ? callEscape : callData;
  }
  function callEscape(code4) {
    if (code4 === 91 || code4 === 92 || code4 === 93) {
      effects.consume(code4);
      size++;
      return callData;
    }
    return callData(code4);
  }
}
function tokenizeDefinitionStart(effects, ok3, nok) {
  const self2 = this;
  const defined = self2.parser.gfmFootnotes || (self2.parser.gfmFootnotes = []);
  let identifier;
  let size = 0;
  let data;
  return start2;
  function start2(code4) {
    effects.enter("gfmFootnoteDefinition")._container = true;
    effects.enter("gfmFootnoteDefinitionLabel");
    effects.enter("gfmFootnoteDefinitionLabelMarker");
    effects.consume(code4);
    effects.exit("gfmFootnoteDefinitionLabelMarker");
    return labelAtMarker;
  }
  function labelAtMarker(code4) {
    if (code4 === 94) {
      effects.enter("gfmFootnoteDefinitionMarker");
      effects.consume(code4);
      effects.exit("gfmFootnoteDefinitionMarker");
      effects.enter("gfmFootnoteDefinitionLabelString");
      effects.enter("chunkString").contentType = "string";
      return labelInside;
    }
    return nok(code4);
  }
  function labelInside(code4) {
    if (
      // Too long.
      size > 999 || // Closing brace with nothing.
      code4 === 93 && !data || // Space or tab is not supported by GFM for some reason.
      // `\n` and `[` not being supported makes sense.
      code4 === null || code4 === 91 || markdownLineEndingOrSpace(code4)
    ) {
      return nok(code4);
    }
    if (code4 === 93) {
      effects.exit("chunkString");
      const token = effects.exit("gfmFootnoteDefinitionLabelString");
      identifier = normalizeIdentifier(self2.sliceSerialize(token));
      effects.enter("gfmFootnoteDefinitionLabelMarker");
      effects.consume(code4);
      effects.exit("gfmFootnoteDefinitionLabelMarker");
      effects.exit("gfmFootnoteDefinitionLabel");
      return labelAfter;
    }
    if (!markdownLineEndingOrSpace(code4)) {
      data = true;
    }
    size++;
    effects.consume(code4);
    return code4 === 92 ? labelEscape : labelInside;
  }
  function labelEscape(code4) {
    if (code4 === 91 || code4 === 92 || code4 === 93) {
      effects.consume(code4);
      size++;
      return labelInside;
    }
    return labelInside(code4);
  }
  function labelAfter(code4) {
    if (code4 === 58) {
      effects.enter("definitionMarker");
      effects.consume(code4);
      effects.exit("definitionMarker");
      if (!defined.includes(identifier)) {
        defined.push(identifier);
      }
      return factorySpace(effects, whitespaceAfter, "gfmFootnoteDefinitionWhitespace");
    }
    return nok(code4);
  }
  function whitespaceAfter(code4) {
    return ok3(code4);
  }
}
function tokenizeDefinitionContinuation(effects, ok3, nok) {
  return effects.check(blankLine, ok3, effects.attempt(indent, ok3, nok));
}
function gfmFootnoteDefinitionEnd(effects) {
  effects.exit("gfmFootnoteDefinition");
}
function tokenizeIndent2(effects, ok3, nok) {
  const self2 = this;
  return factorySpace(effects, afterPrefix, "gfmFootnoteDefinitionIndent", 4 + 1);
  function afterPrefix(code4) {
    const tail = self2.events[self2.events.length - 1];
    return tail && tail[1].type === "gfmFootnoteDefinitionIndent" && tail[2].sliceSerialize(tail[1], true).length === 4 ? ok3(code4) : nok(code4);
  }
}

function gfmStrikethrough(options) {
  const options_ = options || {};
  let single = options_.singleTilde;
  const tokenizer = {
    name: "strikethrough",
    tokenize: tokenizeStrikethrough,
    resolveAll: resolveAllStrikethrough
  };
  if (single === null || single === void 0) {
    single = true;
  }
  return {
    text: {
      [126]: tokenizer
    },
    insideSpan: {
      null: [tokenizer]
    },
    attentionMarkers: {
      null: [126]
    }
  };
  function resolveAllStrikethrough(events, context) {
    let index3 = -1;
    while (++index3 < events.length) {
      if (events[index3][0] === "enter" && events[index3][1].type === "strikethroughSequenceTemporary" && events[index3][1]._close) {
        let open = index3;
        while (open--) {
          if (events[open][0] === "exit" && events[open][1].type === "strikethroughSequenceTemporary" && events[open][1]._open && // If the sizes are the same:
          events[index3][1].end.offset - events[index3][1].start.offset === events[open][1].end.offset - events[open][1].start.offset) {
            events[index3][1].type = "strikethroughSequence";
            events[open][1].type = "strikethroughSequence";
            const strikethrough2 = {
              type: "strikethrough",
              start: Object.assign({}, events[open][1].start),
              end: Object.assign({}, events[index3][1].end)
            };
            const text7 = {
              type: "strikethroughText",
              start: Object.assign({}, events[open][1].end),
              end: Object.assign({}, events[index3][1].start)
            };
            const nextEvents = [["enter", strikethrough2, context], ["enter", events[open][1], context], ["exit", events[open][1], context], ["enter", text7, context]];
            const insideSpan2 = context.parser.constructs.insideSpan.null;
            if (insideSpan2) {
              splice(nextEvents, nextEvents.length, 0, resolveAll(insideSpan2, events.slice(open + 1, index3), context));
            }
            splice(nextEvents, nextEvents.length, 0, [["exit", text7, context], ["enter", events[index3][1], context], ["exit", events[index3][1], context], ["exit", strikethrough2, context]]);
            splice(events, open - 1, index3 - open + 3, nextEvents);
            index3 = open + nextEvents.length - 2;
            break;
          }
        }
      }
    }
    index3 = -1;
    while (++index3 < events.length) {
      if (events[index3][1].type === "strikethroughSequenceTemporary") {
        events[index3][1].type = "data";
      }
    }
    return events;
  }
  function tokenizeStrikethrough(effects, ok3, nok) {
    const previous3 = this.previous;
    const events = this.events;
    let size = 0;
    return start2;
    function start2(code4) {
      if (previous3 === 126 && events[events.length - 1][1].type !== "characterEscape") {
        return nok(code4);
      }
      effects.enter("strikethroughSequenceTemporary");
      return more(code4);
    }
    function more(code4) {
      const before = classifyCharacter(previous3);
      if (code4 === 126) {
        if (size > 1) return nok(code4);
        effects.consume(code4);
        size++;
        return more;
      }
      if (size < 2 && !single) return nok(code4);
      const token = effects.exit("strikethroughSequenceTemporary");
      const after = classifyCharacter(code4);
      token._open = !after || after === 2 && Boolean(before);
      token._close = !before || before === 2 && Boolean(after);
      return ok3(code4);
    }
  }
}

var EditMap2 = class {
  /**
   * Create a new edit map.
   */
  constructor() {
    this.map = [];
    this.index = /* @__PURE__ */ new Map();
  }
  /**
   * Create an edit: a remove and/or add at a certain place.
   *
   * @param {number} index
   *   Index at which to apply the edit.
   * @param {number} remove
   *   Count of items to remove at the index.
   * @param {Array<Event>} add
   *   Items to add at the index.
   * @returns {undefined}
   *   Nothing.
   */
  add(index3, remove, add) {
    addImplementation2(this, index3, remove, add);
  }
  // To do: add this when moving to `micromark`.
  // /**
  //  * Create an edit: but insert `add` before existing additions.
  //  *
  //  * @param {number} index
  //  * @param {number} remove
  //  * @param {Array<Event>} add
  //  * @returns {undefined}
  //  */
  // addBefore(index, remove, add) {
  //   addImplementation(this, index, remove, add, true)
  // }
  /**
   * Done, change the events.
   *
   * @param {Array<Event>} events
   *   List of events to apply the edits to.
   * @returns {undefined}
   *   Nothing.
   */
  consume(events) {
    this.map.sort(function(a, b) {
      return a[0] - b[0];
    });
    if (this.map.length === 0) {
      return;
    }
    let index3 = this.map.length;
    const vecs = [];
    while (index3 > 0) {
      index3 -= 1;
      vecs.push(events.slice(this.map[index3][0] + this.map[index3][1]), this.map[index3][2]);
      events.length = this.map[index3][0];
    }
    vecs.push(events.slice());
    events.length = 0;
    let slice = vecs.pop();
    while (slice) {
      for (const element2 of slice) {
        events.push(element2);
      }
      slice = vecs.pop();
    }
    this.map.length = 0;
    this.index.clear();
  }
};
function addImplementation2(editMap, at, remove, add) {
  if (remove === 0 && add.length === 0) {
    return;
  }
  const existing = editMap.index.get(at);
  if (existing) {
    existing[1] += remove;
    existing[2].push(...add);
    return;
  }
  const change = [at, remove, add];
  editMap.map.push(change);
  editMap.index.set(at, change);
}

function gfmTableAlign(events, index3) {
  let inDelimiterRow = false;
  const align = [];
  while (index3 < events.length) {
    const event = events[index3];
    if (inDelimiterRow) {
      if (event[0] === "enter") {
        if (event[1].type === "tableContent") {
          align.push(events[index3 + 1][1].type === "tableDelimiterMarker" ? "left" : "none");
        }
      } else if (event[1].type === "tableContent") {
        if (events[index3 - 1][1].type === "tableDelimiterMarker") {
          const alignIndex = align.length - 1;
          align[alignIndex] = align[alignIndex] === "left" ? "center" : "right";
        }
      } else if (event[1].type === "tableDelimiterRow") {
        break;
      }
    } else if (event[0] === "enter" && event[1].type === "tableDelimiterRow") {
      inDelimiterRow = true;
    }
    index3 += 1;
  }
  return align;
}

function gfmTable() {
  return {
    flow: {
      null: {
        name: "table",
        tokenize: tokenizeTable,
        resolveAll: resolveTable
      }
    }
  };
}
function tokenizeTable(effects, ok3, nok) {
  const self2 = this;
  let size = 0;
  let sizeB = 0;
  let seen;
  return start2;
  function start2(code4) {
    let index3 = self2.events.length - 1;
    while (index3 > -1) {
      const {
        type
      } = self2.events[index3][1];
      if (type === "lineEnding" || // Note: markdown-rs uses `whitespace` instead of `linePrefix`
      type === "linePrefix") {
        index3--;
      } else {
        break;
      }
    }
    const tail = index3 > -1 ? self2.events[index3][1].type : null;
    const next = tail === "tableHead" || tail === "tableRow" ? bodyRowStart : headRowBefore;
    if (next === bodyRowStart && self2.parser.lazy[self2.now().line]) {
      return nok(code4);
    }
    return next(code4);
  }
  function headRowBefore(code4) {
    effects.enter("tableHead");
    effects.enter("tableRow");
    return headRowStart(code4);
  }
  function headRowStart(code4) {
    if (code4 === 124) {
      return headRowBreak(code4);
    }
    seen = true;
    sizeB += 1;
    return headRowBreak(code4);
  }
  function headRowBreak(code4) {
    if (code4 === null) {
      return nok(code4);
    }
    if (markdownLineEnding(code4)) {
      if (sizeB > 1) {
        sizeB = 0;
        self2.interrupt = true;
        effects.exit("tableRow");
        effects.enter("lineEnding");
        effects.consume(code4);
        effects.exit("lineEnding");
        return headDelimiterStart;
      }
      return nok(code4);
    }
    if (markdownSpace(code4)) {
      return factorySpace(effects, headRowBreak, "whitespace")(code4);
    }
    sizeB += 1;
    if (seen) {
      seen = false;
      size += 1;
    }
    if (code4 === 124) {
      effects.enter("tableCellDivider");
      effects.consume(code4);
      effects.exit("tableCellDivider");
      seen = true;
      return headRowBreak;
    }
    effects.enter("data");
    return headRowData(code4);
  }
  function headRowData(code4) {
    if (code4 === null || code4 === 124 || markdownLineEndingOrSpace(code4)) {
      effects.exit("data");
      return headRowBreak(code4);
    }
    effects.consume(code4);
    return code4 === 92 ? headRowEscape : headRowData;
  }
  function headRowEscape(code4) {
    if (code4 === 92 || code4 === 124) {
      effects.consume(code4);
      return headRowData;
    }
    return headRowData(code4);
  }
  function headDelimiterStart(code4) {
    self2.interrupt = false;
    if (self2.parser.lazy[self2.now().line]) {
      return nok(code4);
    }
    effects.enter("tableDelimiterRow");
    seen = false;
    if (markdownSpace(code4)) {
      return factorySpace(effects, headDelimiterBefore, "linePrefix", self2.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4)(code4);
    }
    return headDelimiterBefore(code4);
  }
  function headDelimiterBefore(code4) {
    if (code4 === 45 || code4 === 58) {
      return headDelimiterValueBefore(code4);
    }
    if (code4 === 124) {
      seen = true;
      effects.enter("tableCellDivider");
      effects.consume(code4);
      effects.exit("tableCellDivider");
      return headDelimiterCellBefore;
    }
    return headDelimiterNok(code4);
  }
  function headDelimiterCellBefore(code4) {
    if (markdownSpace(code4)) {
      return factorySpace(effects, headDelimiterValueBefore, "whitespace")(code4);
    }
    return headDelimiterValueBefore(code4);
  }
  function headDelimiterValueBefore(code4) {
    if (code4 === 58) {
      sizeB += 1;
      seen = true;
      effects.enter("tableDelimiterMarker");
      effects.consume(code4);
      effects.exit("tableDelimiterMarker");
      return headDelimiterLeftAlignmentAfter;
    }
    if (code4 === 45) {
      sizeB += 1;
      return headDelimiterLeftAlignmentAfter(code4);
    }
    if (code4 === null || markdownLineEnding(code4)) {
      return headDelimiterCellAfter(code4);
    }
    return headDelimiterNok(code4);
  }
  function headDelimiterLeftAlignmentAfter(code4) {
    if (code4 === 45) {
      effects.enter("tableDelimiterFiller");
      return headDelimiterFiller(code4);
    }
    return headDelimiterNok(code4);
  }
  function headDelimiterFiller(code4) {
    if (code4 === 45) {
      effects.consume(code4);
      return headDelimiterFiller;
    }
    if (code4 === 58) {
      seen = true;
      effects.exit("tableDelimiterFiller");
      effects.enter("tableDelimiterMarker");
      effects.consume(code4);
      effects.exit("tableDelimiterMarker");
      return headDelimiterRightAlignmentAfter;
    }
    effects.exit("tableDelimiterFiller");
    return headDelimiterRightAlignmentAfter(code4);
  }
  function headDelimiterRightAlignmentAfter(code4) {
    if (markdownSpace(code4)) {
      return factorySpace(effects, headDelimiterCellAfter, "whitespace")(code4);
    }
    return headDelimiterCellAfter(code4);
  }
  function headDelimiterCellAfter(code4) {
    if (code4 === 124) {
      return headDelimiterBefore(code4);
    }
    if (code4 === null || markdownLineEnding(code4)) {
      if (!seen || size !== sizeB) {
        return headDelimiterNok(code4);
      }
      effects.exit("tableDelimiterRow");
      effects.exit("tableHead");
      return ok3(code4);
    }
    return headDelimiterNok(code4);
  }
  function headDelimiterNok(code4) {
    return nok(code4);
  }
  function bodyRowStart(code4) {
    effects.enter("tableRow");
    return bodyRowBreak(code4);
  }
  function bodyRowBreak(code4) {
    if (code4 === 124) {
      effects.enter("tableCellDivider");
      effects.consume(code4);
      effects.exit("tableCellDivider");
      return bodyRowBreak;
    }
    if (code4 === null || markdownLineEnding(code4)) {
      effects.exit("tableRow");
      return ok3(code4);
    }
    if (markdownSpace(code4)) {
      return factorySpace(effects, bodyRowBreak, "whitespace")(code4);
    }
    effects.enter("data");
    return bodyRowData(code4);
  }
  function bodyRowData(code4) {
    if (code4 === null || code4 === 124 || markdownLineEndingOrSpace(code4)) {
      effects.exit("data");
      return bodyRowBreak(code4);
    }
    effects.consume(code4);
    return code4 === 92 ? bodyRowEscape : bodyRowData;
  }
  function bodyRowEscape(code4) {
    if (code4 === 92 || code4 === 124) {
      effects.consume(code4);
      return bodyRowData;
    }
    return bodyRowData(code4);
  }
}
function resolveTable(events, context) {
  let index3 = -1;
  let inFirstCellAwaitingPipe = true;
  let rowKind = 0;
  let lastCell = [0, 0, 0, 0];
  let cell = [0, 0, 0, 0];
  let afterHeadAwaitingFirstBodyRow = false;
  let lastTableEnd = 0;
  let currentTable;
  let currentBody;
  let currentCell;
  const map3 = new EditMap2();
  while (++index3 < events.length) {
    const event = events[index3];
    const token = event[1];
    if (event[0] === "enter") {
      if (token.type === "tableHead") {
        afterHeadAwaitingFirstBodyRow = false;
        if (lastTableEnd !== 0) {
          flushTableEnd(map3, context, lastTableEnd, currentTable, currentBody);
          currentBody = void 0;
          lastTableEnd = 0;
        }
        currentTable = {
          type: "table",
          start: Object.assign({}, token.start),
          // Note: correct end is set later.
          end: Object.assign({}, token.end)
        };
        map3.add(index3, 0, [["enter", currentTable, context]]);
      } else if (token.type === "tableRow" || token.type === "tableDelimiterRow") {
        inFirstCellAwaitingPipe = true;
        currentCell = void 0;
        lastCell = [0, 0, 0, 0];
        cell = [0, index3 + 1, 0, 0];
        if (afterHeadAwaitingFirstBodyRow) {
          afterHeadAwaitingFirstBodyRow = false;
          currentBody = {
            type: "tableBody",
            start: Object.assign({}, token.start),
            // Note: correct end is set later.
            end: Object.assign({}, token.end)
          };
          map3.add(index3, 0, [["enter", currentBody, context]]);
        }
        rowKind = token.type === "tableDelimiterRow" ? 2 : currentBody ? 3 : 1;
      } else if (rowKind && (token.type === "data" || token.type === "tableDelimiterMarker" || token.type === "tableDelimiterFiller")) {
        inFirstCellAwaitingPipe = false;
        if (cell[2] === 0) {
          if (lastCell[1] !== 0) {
            cell[0] = cell[1];
            currentCell = flushCell(map3, context, lastCell, rowKind, void 0, currentCell);
            lastCell = [0, 0, 0, 0];
          }
          cell[2] = index3;
        }
      } else if (token.type === "tableCellDivider") {
        if (inFirstCellAwaitingPipe) {
          inFirstCellAwaitingPipe = false;
        } else {
          if (lastCell[1] !== 0) {
            cell[0] = cell[1];
            currentCell = flushCell(map3, context, lastCell, rowKind, void 0, currentCell);
          }
          lastCell = cell;
          cell = [lastCell[1], index3, 0, 0];
        }
      }
    } else if (token.type === "tableHead") {
      afterHeadAwaitingFirstBodyRow = true;
      lastTableEnd = index3;
    } else if (token.type === "tableRow" || token.type === "tableDelimiterRow") {
      lastTableEnd = index3;
      if (lastCell[1] !== 0) {
        cell[0] = cell[1];
        currentCell = flushCell(map3, context, lastCell, rowKind, index3, currentCell);
      } else if (cell[1] !== 0) {
        currentCell = flushCell(map3, context, cell, rowKind, index3, currentCell);
      }
      rowKind = 0;
    } else if (rowKind && (token.type === "data" || token.type === "tableDelimiterMarker" || token.type === "tableDelimiterFiller")) {
      cell[3] = index3;
    }
  }
  if (lastTableEnd !== 0) {
    flushTableEnd(map3, context, lastTableEnd, currentTable, currentBody);
  }
  map3.consume(context.events);
  index3 = -1;
  while (++index3 < context.events.length) {
    const event = context.events[index3];
    if (event[0] === "enter" && event[1].type === "table") {
      event[1]._align = gfmTableAlign(context.events, index3);
    }
  }
  return events;
}
function flushCell(map3, context, range, rowKind, rowEnd, previousCell) {
  const groupName = rowKind === 1 ? "tableHeader" : rowKind === 2 ? "tableDelimiter" : "tableData";
  const valueName = "tableContent";
  if (range[0] !== 0) {
    previousCell.end = Object.assign({}, getPoint(context.events, range[0]));
    map3.add(range[0], 0, [["exit", previousCell, context]]);
  }
  const now = getPoint(context.events, range[1]);
  previousCell = {
    type: groupName,
    start: Object.assign({}, now),
    // Note: correct end is set later.
    end: Object.assign({}, now)
  };
  map3.add(range[1], 0, [["enter", previousCell, context]]);
  if (range[2] !== 0) {
    const relatedStart = getPoint(context.events, range[2]);
    const relatedEnd = getPoint(context.events, range[3]);
    const valueToken = {
      type: valueName,
      start: Object.assign({}, relatedStart),
      end: Object.assign({}, relatedEnd)
    };
    map3.add(range[2], 0, [["enter", valueToken, context]]);
    if (rowKind !== 2) {
      const start2 = context.events[range[2]];
      const end = context.events[range[3]];
      start2[1].end = Object.assign({}, end[1].end);
      start2[1].type = "chunkText";
      start2[1].contentType = "text";
      if (range[3] > range[2] + 1) {
        const a = range[2] + 1;
        const b = range[3] - range[2] - 1;
        map3.add(a, b, []);
      }
    }
    map3.add(range[3] + 1, 0, [["exit", valueToken, context]]);
  }
  if (rowEnd !== void 0) {
    previousCell.end = Object.assign({}, getPoint(context.events, rowEnd));
    map3.add(rowEnd, 0, [["exit", previousCell, context]]);
    previousCell = void 0;
  }
  return previousCell;
}
function flushTableEnd(map3, context, index3, table2, tableBody) {
  const exits = [];
  const related = getPoint(context.events, index3);
  if (tableBody) {
    tableBody.end = Object.assign({}, related);
    exits.push(["exit", tableBody, context]);
  }
  table2.end = Object.assign({}, related);
  exits.push(["exit", table2, context]);
  map3.add(index3 + 1, 0, exits);
}
function getPoint(events, index3) {
  const event = events[index3];
  const side = event[0] === "enter" ? "start" : "end";
  return event[1][side];
}

var tasklistCheck = {
  name: "tasklistCheck",
  tokenize: tokenizeTasklistCheck
};
function gfmTaskListItem() {
  return {
    text: {
      [91]: tasklistCheck
    }
  };
}
function tokenizeTasklistCheck(effects, ok3, nok) {
  const self2 = this;
  return open;
  function open(code4) {
    if (
      // Exit if there’s stuff before.
      self2.previous !== null || // Exit if not in the first content that is the first child of a list
      // item.
      !self2._gfmTasklistFirstContentOfListItem
    ) {
      return nok(code4);
    }
    effects.enter("taskListCheck");
    effects.enter("taskListCheckMarker");
    effects.consume(code4);
    effects.exit("taskListCheckMarker");
    return inside;
  }
  function inside(code4) {
    if (markdownLineEndingOrSpace(code4)) {
      effects.enter("taskListCheckValueUnchecked");
      effects.consume(code4);
      effects.exit("taskListCheckValueUnchecked");
      return close;
    }
    if (code4 === 88 || code4 === 120) {
      effects.enter("taskListCheckValueChecked");
      effects.consume(code4);
      effects.exit("taskListCheckValueChecked");
      return close;
    }
    return nok(code4);
  }
  function close(code4) {
    if (code4 === 93) {
      effects.enter("taskListCheckMarker");
      effects.consume(code4);
      effects.exit("taskListCheckMarker");
      effects.exit("taskListCheck");
      return after;
    }
    return nok(code4);
  }
  function after(code4) {
    if (markdownLineEnding(code4)) {
      return ok3(code4);
    }
    if (markdownSpace(code4)) {
      return effects.check({
        tokenize: spaceThenNonSpace
      }, ok3, nok)(code4);
    }
    return nok(code4);
  }
}
function spaceThenNonSpace(effects, ok3, nok) {
  return factorySpace(effects, after, "whitespace");
  function after(code4) {
    return code4 === null ? nok(code4) : ok3(code4);
  }
}

function gfm(options) {
  return combineExtensions([
    gfmAutolinkLiteral(),
    gfmFootnote(),
    gfmStrikethrough(options),
    gfmTable(),
    gfmTaskListItem()
  ]);
}

var emptyOptions4 = {};
function remarkGfm(options) {
  const self2 = (
    /** @type {Processor<Root>} */
    this
  );
  const settings = options || emptyOptions4;
  const data = self2.data();
  const micromarkExtensions = data.micromarkExtensions || (data.micromarkExtensions = []);
  const fromMarkdownExtensions = data.fromMarkdownExtensions || (data.fromMarkdownExtensions = []);
  const toMarkdownExtensions = data.toMarkdownExtensions || (data.toMarkdownExtensions = []);
  micromarkExtensions.push(gfm(settings));
  fromMarkdownExtensions.push(gfmFromMarkdown());
  toMarkdownExtensions.push(gfmToMarkdown(settings));
}

// src/nacos-detail.ts
var h = React.createElement;
var markdownPlugins = [remarkGfm];
function skillDocumentUrl(url) {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : void 0;
  } catch {
    return void 0;
  }
}
function SkillDocument({ body }) {
  return h("div", { className: "dssm-nacos-markdown" }, h(Markdown, {
    remarkPlugins: markdownPlugins,
    skipHtml: true,
    disallowedElements: ["img"],
    urlTransform: skillDocumentUrl,
    components: {
      a: ({ href, children }) => href ? h("a", { href, target: "_blank", rel: "noopener noreferrer" }, children) : h("span", null, children),
      table: ({ children }) => h("div", { className: "dssm-nacos-table" }, h("table", null, children))
    },
    children: body
  }));
}
function NacosDetailDialog(props) {
  const { Modal: Modal2, Button: Button2, SourceSelect: SourceSelect2, t, selected, detail, loading, error, installing, uncertain, target, workspaces, roots } = props;
  const project = target.scope === "workspace";
  const chosen = workspaces.find((row) => row.registeredPaths[0] === target.workspace);
  const projectPath = chosen?.projectRoot || chosen?.path;
  const path2 = project ? chosen?.available && projectPath ? projectPath.replace(/[\\/]+$/, "") + (projectPath.includes("\\") ? "\\.dsh\\skills" : "/.dsh/skills") : "" : roots.find((root4) => root4.key === "dsh")?.path || "";
  return h(
    Modal2,
    {
      title: selected.name,
      className: "dssm-nacos-dialog",
      contentClassName: "dssm-nacos-dialog-content",
      closeLabel: t("btn.close"),
      onClose: props.onClose,
      footer: h(
        "div",
        { className: "dssm-nacos-footer" },
        h("span", { className: "dssm-nacos-note" }, t("nacos.enableHint")),
        h(
          "div",
          { className: "dssm-nacos-actions" },
          uncertain ? h(Button2, { variant: "outline", size: "sm", disabled: props.checking, onClick: props.onCheck }, t("nacos.checkResult")) : null,
          props.onNavigate ? h(Button2, { variant: "outline", size: "sm", onClick: props.onNavigate }, t(project ? "nacos.openProject" : "nacos.openGlobal")) : null,
          h(Button2, { variant: "outline", size: "sm", onClick: installing ? props.onCancel : props.onClose }, t(installing ? "btn.cancel" : "btn.close")),
          h(Button2, { variant: "primary", size: "sm", disabled: !detail || loading || installing || uncertain || !props.ready, onClick: props.onInstall }, t(installing ? "nacos.downloading" : props.installed ? "nacos.downloaded" : "nacos.download"))
        )
      )
    },
    h(
      "div",
      { className: "dssm-nacos-detail" },
      uncertain ? h("p", { className: "dssm-nacos-note", role: "status" }, t("nacos.pending")) : null,
      h(
        "div",
        { className: "dssm-nacos-overview" },
        h("span", { className: "dssm-nacos-version" }, t("nacos.version", { version: selected.version })),
        h("p", null, selected.description || t("nacos.noDescription"))
      ),
      loading ? h("div", { className: "dssm-nacos-state", role: "status" }, t("nacos.detailLoading")) : null,
      error ? h(
        "div",
        { className: "dssm-nacos-notice is-error", role: "alert" },
        h("span", null, error),
        !detail && !loading ? h(Button2, { variant: "outline", size: "sm", onClick: props.onRetry }, t("nacos.retry")) : null
      ) : null,
      detail ? h(
        React.Fragment,
        null,
        h(SkillDocument, { body: detail.body }),
        h(
          "details",
          { className: "dssm-nacos-resources" },
          h("summary", null, t("nacos.files", { count: detail.files.length })),
          h("ul", null, detail.files.map((file) => h("li", { key: file }, h("code", null, file))))
        ),
        h(
          "section",
          { className: "dssm-nacos-destination", "aria-label": t("nacos.choose") },
          h("h3", null, t("nacos.choose")),
          props.installationStatus ? h("p", { className: "dssm-nacos-installation", role: "status" }, props.installationStatus) : null,
          h(
            "div",
            { className: "dssm-nacos-scope", role: "group", "aria-label": t("nacos.choose") },
            ["user", "workspace"].map((scope) => h(Button2, {
              key: scope,
              size: "sm",
              variant: target.scope === scope ? "primary" : "outline",
              "aria-pressed": target.scope === scope,
              disabled: installing,
              onClick: () => props.onTarget({ ...target, scope, location: "dsh", workspace: "", presetKey: "" })
            }, t(scope === "user" ? "nacos.global" : "nacos.project")))
          ),
          project ? h(
            "div",
            { className: "dssm-nacos-project" },
            h("span", { className: "dssm-label" }, t("nacos.chooseProject")),
            h(SourceSelect2, {
              label: t("nacos.chooseProject"),
              value: target.workspace,
              disabled: installing || !workspaces.length,
              options: workspaces.map((row) => ({ value: row.registeredPaths[0] || "", label: row.name + (!row.available ? " \xB7 " + t("nacos.projectUnavailable") : ""), disabled: !row.available || !row.registeredPaths[0] })),
              onChange: (value) => {
                if (!installing && workspaces.some((row) => row.available && row.registeredPaths[0] === value)) props.onTarget({ ...target, workspace: value });
              }
            }),
            h("p", { className: "dssm-nacos-note" }, t(workspaces.length ? "nacos.projectHint" : "nacos.noProjects"))
          ) : h("p", { className: "dssm-nacos-note" }, t(roots.some((root4) => root4.key === "dsh" && root4.available) ? "nacos.globalHint" : "nacos.globalUnavailable")),
          path2 ? h("details", { className: "dssm-nacos-path" }, h("summary", null, t("nacos.path")), h("code", null, path2)) : null,
          h("p", { className: "dssm-nacos-note" }, t("nacos.localOnly"))
        ),
        installing ? h("p", { className: "dssm-nacos-note", role: "status" }, t("nacos.cancelHint")) : null
      ) : null
    )
  );
}

// src/nacos-styles.ts
var nacosCss = `
.dssm-nacos{display:flex;flex-direction:column;gap:14px;min-width:0;container-type:inline-size}
.dssm-nacos-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}
.dssm-nacos-heading h3{margin:0;font-size:16px;line-height:24px;font-weight:600}
.dssm-nacos-subtitle{margin:3px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dssm-nacos-tools{display:flex;align-items:center;gap:8px;min-width:0}
.dssm-nacos-search{flex:1;min-width:0;display:flex;align-items:center;gap:6px}
.dssm-nacos-search>span,.dssm-nacos-search>div{flex:1;min-width:0}
.dssm-nacos-search input{box-sizing:border-box;width:100%;min-width:0;font-size:13px}
.dssm-nacos-tools button{flex:none}
.dssm-nacos-count,.dssm-nacos-note{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dssm-nacos-count{margin:0;min-height:18px}
.dssm-nacos-summary{display:flex;align-items:baseline;justify-content:space-between;gap:6px 12px;flex-wrap:wrap}
.dssm-nacos-sort{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dssm-nacos-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:10px;min-width:0}
.dssm-nacos-card{box-sizing:border-box;display:flex;flex-direction:column;gap:9px;min-width:0;padding:14px 16px;background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-2));border:0.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2));border-radius:var(--dsw-radius-xl,16px);transition:border-color .15s ease}
.dssm-nacos-card:hover{border-color:var(--dsw-alias-border-l3)}
.dssm-nacos-card-head{display:flex;align-items:flex-start;gap:10px;min-width:0}
.dssm-nacos-icon{display:inline-flex;align-items:center;justify-content:center;flex:none;width:30px;height:30px;border-radius:var(--dsw-radius-sm,8px);color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-bg-layer-1)}
.dssm-nacos-card h4{flex:1;min-width:0;margin:3px 0 0;font-size:14px;line-height:21px;font-weight:600;overflow-wrap:anywhere}
.dssm-nacos-version{display:inline-flex;align-items:center;flex:none;max-width:100%;padding:1px 6px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-xs,4px);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px;overflow-wrap:anywhere}
.dssm-nacos-card-head .dssm-nacos-version{max-width:35%;margin-top:4px}
.dssm-nacos-description{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.dssm-nacos-installations{display:flex;flex-wrap:wrap;gap:4px 8px;min-width:0}
.dssm-nacos-installation{margin:0;padding:2px 7px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-xs,4px);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);overflow-wrap:anywhere}
.dssm-nacos-card-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px 12px;flex-wrap:wrap;margin-top:auto}
.dssm-nacos-card-actions>button{flex:none;margin-left:auto}
.dssm-nacos-meta{display:flex;align-items:center;gap:12px;flex:1 1 180px;min-width:0;min-height:18px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dssm-nacos-namespace,.dssm-nacos-downloads{display:inline-flex;align-items:center;gap:4px;min-width:0}
.dssm-nacos-namespace{max-width:160px;flex:0 1 auto}
.dssm-nacos-namespace>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dssm-nacos-downloads,.dssm-nacos-meta svg{flex:none}
.dssm-nacos-pagination{display:flex;justify-content:center;align-items:center;gap:12px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dssm-nacos-state{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:28px 16px;text-align:center;border:0.5px dashed var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-xl,16px);color:var(--dsw-alias-label-secondary);font-size:13px;line-height:21px;overflow-wrap:anywhere}
.dssm-nacos-state strong{font-size:14px;color:var(--dsw-alias-label-primary)}
.dssm-nacos-state p{margin:0}
.dssm-nacos-notice{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1);border:0.5px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:19px;overflow-wrap:anywhere}
.dssm-nacos-notice.is-error{color:var(--dsw-alias-state-error-primary)}
.dssm-nacos-notice.is-warning{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary))}
.dssm-nacos-notice button{flex:none}
.dssm-nacos-skeleton{pointer-events:none;min-height:120px}
.dssm-nacos-skeleton span{display:block;height:12px;border-radius:4px;background:var(--dsw-alias-border-l1)}
.dssm-nacos-skeleton span:first-child{width:58%;height:16px;margin-bottom:8px}
.dssm-nacos-skeleton span:last-child{width:72%}
.dssm-modal.dssm-nacos-dialog{width:640px!important;max-width:calc(100vw - 32px)!important;max-height:calc(100dvh - 32px)!important;min-width:0;box-sizing:border-box;display:flex;flex-direction:column}
.dssm-nacos-dialog-content{display:flex;flex-direction:column;min-height:0;overflow:hidden!important;flex:1}
.dssm-nacos-dialog-content>div{min-width:0}
.dssm-nacos-dialog-content>[class*="header"]{min-width:0;flex:none}
.dssm-nacos-dialog-content>[class*="body"]{min-height:0;overflow:auto;overscroll-behavior:contain;flex:1}
.dssm-nacos-dialog>[class*="footer"]{flex:none}
.dssm-nacos-dialog [class*="title"]{overflow-wrap:anywhere;white-space:normal}
.dssm-nacos-detail{display:flex;flex-direction:column;gap:18px;min-width:0;color:var(--dsw-alias-label-primary)}
.dssm-nacos-overview{display:flex;flex-direction:column;align-items:flex-start;gap:8px}
.dssm-nacos-overview p{margin:0;font-size:13px;line-height:21px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dssm-nacos-markdown{font-size:13px;line-height:1.7;overflow-wrap:anywhere;min-width:0}
.dssm-nacos-markdown>:first-child{margin-top:0}.dssm-nacos-markdown>:last-child{margin-bottom:0}
.dssm-nacos-markdown :is(h1,h2,h3,h4,h5,h6){font-weight:600;line-height:1.45;margin:20px 0 8px}
.dssm-nacos-markdown h1{font-size:20px}.dssm-nacos-markdown h2{font-size:17px}.dssm-nacos-markdown h3{font-size:15px}
.dssm-nacos-markdown :is(p,ul,ol,pre,blockquote){margin:8px 0}
.dssm-nacos-markdown :is(ul,ol){padding-left:22px}.dssm-nacos-markdown li+li{margin-top:4px}
.dssm-nacos-markdown code,.dssm-nacos-resources code,.dssm-nacos-path code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}
.dssm-nacos-markdown :not(pre)>code{padding:2px 4px;border-radius:4px;background:var(--dsw-alias-bg-layer-1)}
.dssm-nacos-markdown pre{overflow:auto;max-width:100%;padding:12px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1);white-space:pre;box-sizing:border-box}
.dssm-nacos-markdown blockquote{margin-left:0;padding-left:12px;border-left:2px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.dssm-nacos-markdown a{color:var(--dsw-alias-state-business-primary);text-decoration:underline}
.dssm-nacos-table{max-width:100%;overflow:auto}.dssm-nacos-table table{border-collapse:collapse;font-size:12px}
.dssm-nacos-table :is(th,td){padding:6px 10px;border:0.5px solid var(--dsw-alias-border-l2);text-align:left}
.dssm-nacos-resources,.dssm-nacos-path{font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dssm-nacos-resources summary,.dssm-nacos-path summary{cursor:pointer;width:fit-content}
.dssm-nacos-resources ul{margin:8px 0 0;padding-left:20px;max-height:160px;overflow:auto}
.dssm-nacos-resources code,.dssm-nacos-path code{overflow-wrap:anywhere;white-space:pre-wrap}
.dssm-nacos-path code{display:block;margin-top:6px}
.dssm-nacos-destination{display:flex;flex-direction:column;gap:10px;border-top:0.5px solid var(--dsw-alias-border-l1);padding-top:16px}
.dssm-nacos-destination h3{margin:0;font-size:14px;font-weight:600}
.dssm-nacos-scope,.dssm-nacos-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dssm-nacos-project{display:flex;flex-direction:column;gap:6px}.dssm-nacos-project>span{align-self:flex-start}
.dssm-nacos-project>span:has(button){align-self:stretch;max-width:100%}
.dssm-nacos-project .dssm-menu-select-trigger{width:100%;max-width:100%;box-sizing:border-box}
.dssm-nacos-note{margin:0}
.dssm-nacos-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;width:100%}
.dssm-nacos-footer .dssm-nacos-actions{margin-left:auto}
.dssm-nacos :is(button,summary):focus-visible,.dssm-nacos-dialog :is(a,button,summary):focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:3px}
@container (min-width:640px){.dssm-nacos-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.dssm-nacos-card{min-height:154px}}
@media(max-width:480px){.dssm-nacos-notice{align-items:flex-start;flex-direction:column}.dssm-nacos-tools{gap:6px}.dssm-nacos-card{padding:12px}.dssm-nacos-card-head{flex-wrap:wrap}.dssm-nacos-card-head h4{flex-basis:calc(100% - 42px)}.dssm-nacos-card-head .dssm-nacos-version{margin:0 0 0 40px;max-width:calc(100% - 40px)}}
@media(prefers-reduced-motion:reduce){.dssm-nacos-card{transition:none}}
`;

// src/api-errors.ts
var API_ERROR_CODES = {
  nonJson: "error.proto.nonJson",
  response: "error.proto.response",
  pending: "error.proto.pending",
  busy: "error.proto.busy"
};
function readApiFailure(payload) {
  if (!payload || typeof payload !== "object") return { message: String(payload ?? ""), outcome: "unknown" };
  const item = payload;
  const nested = item.error !== void 0 ? readApiFailure(item.error) : void 0;
  return {
    ...typeof item.code === "string" ? { code: item.code } : nested?.code ? { code: nested.code } : {},
    ...item.params && typeof item.params === "object" && !Array.isArray(item.params) ? { params: item.params } : nested?.params ? { params: nested.params } : {},
    message: nested?.message ?? (typeof item.message === "string" ? item.message : "Unexpected response"),
    outcome: item.outcome === "rejected" ? "rejected" : item.outcome === "pending" ? "pending" : "unknown"
  };
}
var ApiFailure = class extends Error {
  details;
  constructor(details) {
    super(details.message);
    this.name = "ApiFailure";
    this.details = details;
  }
};
function normalizeApiFailure(payload) {
  return payload instanceof ApiFailure ? payload : new ApiFailure(readApiFailure(payload));
}
function failureDetails(payload) {
  return payload instanceof ApiFailure ? payload.details : readApiFailure(payload);
}
function isConfirmedRejection(payload) {
  return payload instanceof ApiFailure && payload.details.outcome === "rejected";
}
function decodeOperationOutcome(payload, validResult) {
  if (!payload || typeof payload !== "object") return { state: "pending" };
  const value = payload;
  if (value.state === "succeeded" && Object.hasOwn(value, "result") && validResult(value.result)) return { state: "succeeded", result: value.result };
  if (value.state === "rejected") {
    const details = readApiFailure(payload);
    if (details.code?.startsWith("error.") && details.message && details.message !== "Unexpected response") return { state: "rejected", failure: new ApiFailure({ ...details, outcome: "rejected" }) };
  }
  return { state: "pending" };
}
function isInstallReceipt(value) {
  return !!value && typeof value === "object" && "name" in value && typeof value.name === "string" && "root" in value && typeof value.root === "string";
}

// src/nacos-ui.ts
var nacosLocales = {
  zh: {
    "scope.repositories": "\u53D1\u73B0\u6280\u80FD",
    "nacos.title": "\u4F01\u4E1A\u6280\u80FD\u5E93",
    "nacos.subtitle": "\u53D1\u73B0\u9002\u5408\u5DE5\u4F5C\u7684\u6280\u80FD",
    "nacos.search": "\u6309\u6280\u80FD\u540D\u79F0\u641C\u7D22",
    "nacos.searchAction": "\u641C\u7D22",
    "nacos.clear": "\u6E05\u7A7A\u641C\u7D22",
    "nacos.retry": "\u91CD\u8BD5",
    "nacos.enableHint": "\u4E0B\u8F7D\u540E\u9700\u624B\u52A8\u542F\u7528",
    "nacos.localOnly": "\u672C\u5730\u4FEE\u6539\u4E0D\u4F1A\u4E0A\u4F20\u5230\u4F01\u4E1A\u6280\u80FD\u5E93\u3002",
    "nacos.unconfigured": "\u4F01\u4E1A\u6280\u80FD\u5E93\u5C1A\u672A\u914D\u7F6E\uFF0C\u8BF7\u8054\u7CFB\u7EF4\u62A4\u4EBA\u5458\u3002\u5168\u5C40\u3001\u9879\u76EE\u548C\u672C\u5730 Agent \u6280\u80FD\u4ECD\u53EF\u6B63\u5E38\u7BA1\u7406\u3002",
    "nacos.unconfiguredTitle": "\u4F01\u4E1A\u6280\u80FD\u5E93\u5C1A\u672A\u914D\u7F6E",
    "nacos.failedTitle": "\u6682\u65F6\u65E0\u6CD5\u8BFB\u53D6\u4F01\u4E1A\u6280\u80FD\u5E93",
    "nacos.emptyTitle": "\u672C\u9875\u6682\u65E0\u53EF\u4E0B\u8F7D\u6280\u80FD",
    "nacos.empty": "\u672C\u9875\u6CA1\u6709\u5DF2\u4E0A\u7EBF\u6280\u80FD\uFF0C\u53EF\u7A0D\u540E\u5237\u65B0\u6216\u6D4F\u89C8\u5176\u4ED6\u9875\u9762\u3002",
    "nacos.noResults": "\u6CA1\u6709\u627E\u5230\u5339\u914D\u7684\u6280\u80FD",
    "nacos.noResultsHint": "\u8BF7\u5C1D\u8BD5\u5176\u4ED6\u6280\u80FD\u540D\u79F0\uFF0C\u6216\u6E05\u7A7A\u641C\u7D22\u3002",
    "nacos.noDescription": "\u6682\u65E0\u7528\u9014\u8BF4\u660E",
    "nacos.count": "\u672C\u9875 {count} \u9879",
    "nacos.resultsFor": "\u540D\u79F0\u5305\u542B\u201C{query}\u201D \xB7 \u672C\u9875 {count} \u9879",
    "nacos.sortDownloads": "\u6309\u4E0B\u8F7D\u6B21\u6570\u6392\u5E8F",
    "nacos.namespace": "\u547D\u540D\u7A7A\u95F4\uFF1A{namespace}",
    "nacos.downloadCount": "{count} \u6B21\u4E0B\u8F7D",
    "nacos.downloadCountHint": "Nacos \u8D44\u6E90\u4E0B\u8F7D\u7EDF\u8BA1\uFF0C\u5305\u542B\u8BE6\u60C5\u8BFB\u53D6\uFF0C\u4E0D\u4EE3\u8868\u5B89\u88C5\u4EBA\u6570\u3002",
    "nacos.loading": "\u6B63\u5728\u8BFB\u53D6\u4F01\u4E1A\u6280\u80FD\u5E93\u2026",
    "nacos.refreshing": "\u6B63\u5728\u5237\u65B0\uFF0C\u6682\u65F6\u663E\u793A\u4E0A\u6B21\u7ED3\u679C\u2026",
    "nacos.detailLoading": "\u6B63\u5728\u8BFB\u53D6\u6280\u80FD\u8BF4\u660E\u4E0E\u5B8C\u6574\u8D44\u6E90\u2026",
    "nacos.download": "\u4E0B\u8F7D\u5230\u672C\u5730",
    "nacos.downloading": "\u6B63\u5728\u4E0B\u8F7D\u2026",
    "nacos.downloaded": "\u5DF2\u4E0B\u8F7D",
    "nacos.modified": "\u5DF2\u4E0B\u8F7D \xB7 \u672C\u5730\u5DF2\u4FEE\u6539",
    "nacos.installPending": "\u4E0B\u8F7D\u5F85\u786E\u8BA4",
    "nacos.installUnavailable": "\u4E0B\u8F7D\u72B6\u6001\u6682\u4E0D\u53EF\u6838\u9A8C\uFF0C\u8BF7\u68C0\u67E5\u672C\u5730\u6280\u80FD\u540E\u5237\u65B0\u3002",
    "nacos.projectCopies": "\u9879\u76EE\u6280\u80FD\uFF08{count}\uFF09",
    "nacos.checkResult": "\u6838\u5BF9\u4E0B\u8F7D\u7ED3\u679C",
    "nacos.pending": "\u4E0B\u8F7D\u7ED3\u679C\u5C1A\u5F85\u786E\u8BA4\uFF0C\u8BF7\u6838\u5BF9\u7ED3\u679C\u6216\u5230\u672C\u5730\u6280\u80FD\u9875\u67E5\u770B\uFF0C\u52FF\u91CD\u590D\u4E0B\u8F7D\u3002",
    "nacos.confirmed": "\u5DF2\u786E\u8BA4 {name} \u5DF2\u4E0B\u8F7D\uFF0C\u8BF7\u5728\u672C\u5730\u6280\u80FD\u9875\u67E5\u770B\u5F53\u524D\u542F\u7528\u72B6\u6001\u3002",
    "nacos.confirmedRefreshWarning": "\u5DF2\u786E\u8BA4\u6280\u80FD\u5DF2\u4E0B\u8F7D\uFF0C\u4F46\u672C\u5730\u5217\u8868\u5237\u65B0\u5931\u8D25\u3002\u8BF7\u5237\u65B0\u6280\u80FD\u9875\u67E5\u770B\u5F53\u524D\u542F\u7528\u72B6\u6001\uFF0C\u52FF\u91CD\u590D\u4E0B\u8F7D\u3002",
    "nacos.done": "\u5DF2\u4E0B\u8F7D {name}\uFF0C\u5F53\u524D\u4E3A\u7981\u7528\u72B6\u6001\u3002",
    "nacos.refreshWarning": "\u6280\u80FD\u5DF2\u4E0B\u8F7D\u4E14\u4FDD\u6301\u7981\u7528\uFF0C\u4F46\u672C\u5730\u5217\u8868\u5237\u65B0\u5931\u8D25\u3002\u8BF7\u5237\u65B0\u6280\u80FD\u9875\uFF0C\u52FF\u91CD\u590D\u4E0B\u8F7D\u3002",
    "nacos.openGlobal": "\u524D\u5F80\u5168\u5C40\u6280\u80FD",
    "nacos.openProject": "\u524D\u5F80\u9879\u76EE\u6280\u80FD",
    "nacos.version": "\u7248\u672C {version}",
    "nacos.previous": "\u4E0A\u4E00\u9875",
    "nacos.next": "\u4E0B\u4E00\u9875",
    "nacos.page": "\u7B2C {page} \u9875",
    "nacos.files": "\u5B8C\u6574\u8D44\u6E90\uFF08{count} \u4E2A\u6587\u4EF6\uFF09",
    "nacos.choose": "\u4E0B\u8F7D\u4F4D\u7F6E",
    "nacos.path": "\u67E5\u770B\u672C\u5730\u4FDD\u5B58\u8DEF\u5F84",
    "nacos.global": "\u5168\u5C40\u6280\u80FD",
    "nacos.project": "\u9879\u76EE\u6280\u80FD",
    "nacos.chooseProject": "\u9009\u62E9\u9879\u76EE",
    "nacos.globalHint": "\u4FDD\u5B58\u5230\u5F53\u524D\u7528\u6237\u7684 DSH \u5168\u5C40\u6280\u80FD\uFF0C\u4F9B\u5404\u4E2A\u9879\u76EE\u6309\u9700\u4F7F\u7528\u3002",
    "nacos.globalUnavailable": "\u5168\u5C40\u6280\u80FD\u76EE\u5F55\u6682\u4E0D\u53EF\u7528\uFF0C\u8BF7\u5237\u65B0\u8BE6\u60C5\u6216\u9009\u62E9\u9879\u76EE\u3002",
    "nacos.projectHint": "\u53EA\u5728\u6240\u9009\u9879\u76EE\u4E2D\u4F7F\u7528\uFF0C\u6587\u4EF6\u53EF\u80FD\u968F\u9879\u76EE\u63D0\u4EA4\u5230\u4ED3\u5E93\u3002",
    "nacos.noProjects": "\u6682\u65E0\u5DF2\u767B\u8BB0\u9879\u76EE\u3002\u8BF7\u5148\u5728\u4FA7\u680F\u6DFB\u52A0\u5DE5\u4F5C\u533A\uFF0C\u6216\u9009\u62E9\u5168\u5C40\u6280\u80FD\u3002",
    "nacos.projectUnavailable": "\u76EE\u5F55\u4E0D\u53EF\u7528",
    "nacos.cancelHint": "\u53D6\u6D88\u53EA\u4E2D\u6B62\u5C1A\u672A\u63D0\u4EA4\u7684\u4E0B\u8F7D\uFF1B\u82E5\u672C\u5730\u5199\u5165\u5DF2\u5F00\u59CB\uFF0C\u8BF7\u5230\u6280\u80FD\u9875\u786E\u8BA4\u7ED3\u679C\u3002",
    "error.nacos.query": "\u641C\u7D22\u6761\u4EF6\u3001\u6280\u80FD\u540D\u79F0\u6216\u7248\u672C\u65E0\u6548\u3002",
    "error.nacos.config": "\u4F01\u4E1A\u6280\u80FD\u5E93\u914D\u7F6E\u4E0D\u5B8C\u6574\u6216\u4E0D\u5B89\u5168\uFF0C\u8BF7\u8054\u7CFB\u7EF4\u62A4\u4EBA\u5458\u3002",
    "error.nacos.unconfigured": "\u4F01\u4E1A\u6280\u80FD\u5E93\u5C1A\u672A\u914D\u7F6E\uFF0C\u8BF7\u8054\u7CFB\u7EF4\u62A4\u4EBA\u5458\u3002",
    "error.nacos.auth": "\u4F01\u4E1A\u6280\u80FD\u5E93\u6682\u65F6\u65E0\u6CD5\u8BBF\u95EE\uFF0C\u8BF7\u8054\u7CFB\u7EF4\u62A4\u4EBA\u5458\u68C0\u67E5\u8BBF\u95EE\u6743\u9650\u3002",
    "error.nacos.timeout": "\u4F01\u4E1A\u6280\u80FD\u5E93\u8BF7\u6C42\u8D85\u65F6\uFF0C\u8BF7\u91CD\u8BD5\u3002",
    "error.nacos.cancelled": "\u4E0B\u8F7D\u8BF7\u6C42\u5DF2\u53D6\u6D88\uFF1B\u8BF7\u5230\u6280\u80FD\u9875\u786E\u8BA4\u662F\u5426\u5DF2\u5B8C\u6210\u672C\u5730\u5199\u5165\u3002",
    "error.nacos.notFound": "\u8BE5\u6280\u80FD\u7248\u672C\u5DF2\u4E0D\u53EF\u7528\uFF0C\u8BF7\u5237\u65B0\u4F01\u4E1A\u6280\u80FD\u5E93\u3002",
    "error.nacos.response": "\u4F01\u4E1A\u6280\u80FD\u5E93\u54CD\u5E94\u683C\u5F0F\u4E0D\u517C\u5BB9\uFF0C\u8BF7\u8054\u7CFB\u7EF4\u62A4\u4EBA\u5458\u3002",
    "error.nacos.package": "\u6280\u80FD ZIP \u5305\u65E0\u6548\u3001\u5185\u5BB9\u4E0D\u5339\u914D\u6216\u5927\u5C0F\u8D85\u9650\u3002",
    "error.nacos.size": "\u4F01\u4E1A\u6280\u80FD\u5E93\u54CD\u5E94\u8D85\u51FA\u5927\u5C0F\u9650\u5236\u3002",
    "error.nacos.unavailable": "\u4F01\u4E1A\u6280\u80FD\u5E93\u8FDE\u63A5\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u7F51\u7EDC\u6216\u7A0D\u540E\u91CD\u8BD5\u3002"
  },
  en: {
    "scope.repositories": "Discover skills",
    "nacos.title": "Enterprise skills",
    "nacos.subtitle": "Discover skills for your work",
    "nacos.search": "Search by skill name",
    "nacos.searchAction": "Search",
    "nacos.clear": "Clear search",
    "nacos.retry": "Retry",
    "nacos.enableHint": "Enable manually after downloading",
    "nacos.localOnly": "Local changes are never uploaded to the enterprise library.",
    "nacos.unconfigured": "The enterprise library is not configured. Contact your administrator. Global, project and local Agent skills remain available.",
    "nacos.unconfiguredTitle": "Enterprise library not configured",
    "nacos.failedTitle": "Could not load enterprise skills",
    "nacos.emptyTitle": "No downloads on this page",
    "nacos.empty": "No published skills on this page. Refresh later or try another page.",
    "nacos.noResults": "No matching skills",
    "nacos.noResultsHint": "Try another skill name or clear your search.",
    "nacos.noDescription": "No description available",
    "nacos.count": "{count} on this page",
    "nacos.resultsFor": "Names containing \u201C{query}\u201D \xB7 {count} on this page",
    "nacos.sortDownloads": "Most downloaded first",
    "nacos.namespace": "Namespace: {namespace}",
    "nacos.downloadCount": "{count} downloads",
    "nacos.downloadCountHint": "Nacos resource downloads, including detail views; not the number of people who installed this skill.",
    "nacos.loading": "Loading enterprise skills\u2026",
    "nacos.refreshing": "Refreshing; showing previous results\u2026",
    "nacos.detailLoading": "Loading skill instructions and complete resources\u2026",
    "nacos.download": "Download locally",
    "nacos.downloading": "Downloading\u2026",
    "nacos.downloaded": "Downloaded",
    "nacos.modified": "Downloaded \xB7 Modified locally",
    "nacos.installPending": "Download awaiting confirmation",
    "nacos.installUnavailable": "Download status unavailable. Check local skills and refresh.",
    "nacos.projectCopies": "Projects ({count})",
    "nacos.checkResult": "Check download result",
    "nacos.pending": "The download result is unconfirmed. Check its status or local skills; do not download again.",
    "nacos.confirmed": "Confirmed that {name} was downloaded. Check its current enabled state in local skills.",
    "nacos.confirmedRefreshWarning": "The download is confirmed, but local skills could not refresh. Refresh to check the current enabled state; do not download again.",
    "nacos.done": "Downloaded {name}, disabled.",
    "nacos.refreshWarning": "Downloaded and disabled, but the local list could not refresh. Refresh the skills page; do not download again.",
    "nacos.openGlobal": "Go to global skills",
    "nacos.openProject": "Go to project skills",
    "nacos.version": "Version {version}",
    "nacos.previous": "Previous",
    "nacos.next": "Next",
    "nacos.page": "Page {page}",
    "nacos.files": "Complete resources ({count} files)",
    "nacos.choose": "Download destination",
    "nacos.path": "Show local save path",
    "nacos.global": "Global skills",
    "nacos.project": "Project skills",
    "nacos.chooseProject": "Select a project",
    "nacos.globalHint": "Save to your DSH global skills for use across projects.",
    "nacos.globalUnavailable": "Global skills are unavailable. Reload the details or choose a project.",
    "nacos.projectHint": "Available in this project only. Files may be committed with the project.",
    "nacos.noProjects": "No registered projects. Add a workspace in the sidebar or choose global skills.",
    "nacos.projectUnavailable": "Directory unavailable",
    "nacos.cancelHint": "Cancellation stops uncommitted downloads. If a local write has started, check the skills page for its result.",
    "error.nacos.query": "Invalid query, skill name or version.",
    "error.nacos.config": "The enterprise library configuration is incomplete or unsafe.",
    "error.nacos.unconfigured": "The enterprise library is not configured.",
    "error.nacos.auth": "The enterprise library is unavailable. Ask your administrator to check access permissions.",
    "error.nacos.timeout": "Enterprise library request timed out.",
    "error.nacos.cancelled": "Request cancelled. Check local skills in case the download was committed.",
    "error.nacos.notFound": "This skill version is unavailable. Refresh the enterprise library.",
    "error.nacos.response": "Incompatible enterprise library response.",
    "error.nacos.package": "Invalid, mismatched, unsafe or oversized skill archive.",
    "error.nacos.size": "Enterprise library response exceeds the size limit.",
    "error.nacos.unavailable": "Could not connect to the enterprise library. Try again later."
  }
};
function createNacosUI({ react: react2, Modal: Modal2, Input: Input2, Button: Button2, SourceSelect: SourceSelect2, destination, api, headers, translateError: translateError2 }) {
  const h4 = react2.createElement;
  const pendingDownloads = /* @__PURE__ */ new Map();
  const { defaultDestination: defaultDestination2, destinationPayload: destinationPayload2, destinationReady: destinationReady2 } = destination;
  const icon = (path2, size = 16) => h4("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, h4("path", { d: path2 }));
  return function useNacosUI({ active, t, onInstalled, onNavigate }) {
    const [query, setQuery] = react2.useState("");
    const [requested, setRequested] = react2.useState({ query: "", page: 1, revision: 0 });
    const [listing, setListing] = react2.useState(null);
    const [listLoading, setListLoading] = react2.useState(true);
    const [listError, setListError] = react2.useState(null);
    const [notice, setNotice] = react2.useState(null);
    const [selected, setSelected] = react2.useState(null);
    const [detail, setDetail] = react2.useState(null);
    const [detailLoading, setDetailLoading] = react2.useState(false);
    const [detailError, setDetailError] = react2.useState(null);
    const [detailRevision, setDetailRevision] = react2.useState(0);
    const [target, setTarget] = react2.useState(defaultDestination2);
    const [workspaces, setWorkspaces] = react2.useState([]);
    const [roots, setRoots] = react2.useState([]);
    const [installing, setInstalling] = react2.useState(false);
    const [, setOperationRevision] = react2.useState(0);
    const [checking, setChecking] = react2.useState(false);
    const listEpoch = react2.useRef(0);
    const detailEpoch = react2.useRef(0);
    const operation = react2.useRef(null);
    const mounted = react2.useRef(true);
    const page = listing?.data;
    const downloadKey = JSON.stringify([selected?.name, selected?.version, target.scope, target.workspace]);
    const pendingDownload = pendingDownloads.get(downloadKey);
    const uncertain = !!pendingDownload && !installing;
    const chosenWorkspace = workspaces.find((row) => row.registeredPaths[0] === target.workspace);
    const workspacePath = chosenWorkspace?.projectRoot || chosenWorkspace?.path;
    const samePath = (left, right) => /^[A-Za-z]:|^\\\\/.test(left) ? left.replace(/\\/g, "/").toLowerCase() === right.replace(/\\/g, "/").toLowerCase() : left === right;
    const installation = detail?.installations?.find((item) => target.scope === "workspace" ? !!item.workspace && !!workspacePath && samePath(item.workspace, workspacePath) : item.workspace === void 0);
    const installed = installation?.state === "downloaded" || installation?.state === "modified";
    const statusKey = (value) => value === "downloaded" ? "nacos.downloaded" : value === "modified" ? "nacos.modified" : value === "pending" ? "nacos.installPending" : "nacos.installUnavailable";
    function downloadBadges(item) {
      const groups = /* @__PURE__ */ new Map();
      for (const entry of item.installations || []) {
        const project = entry.workspace !== void 0;
        const key = JSON.stringify([entry.state, project]);
        const group = groups.get(key);
        if (group) group.count++;
        else groups.set(key, { state: entry.state, project, count: 1 });
      }
      return groups.size ? h4("div", { className: "dssm-nacos-installations", role: "status" }, [...groups].map(([key, group]) => h4("span", { key, className: "dssm-nacos-installation" }, t(statusKey(group.state)) + " \xB7 " + t(group.project ? "nacos.projectCopies" : "nacos.global", { count: group.count })))) : null;
    }
    async function complete(result, installedTarget, reconciled = false) {
      setSelected(null);
      setDetail(null);
      const completed = { ...installedTarget, name: result.name };
      setNotice({ text: t(reconciled ? "nacos.confirmed" : "nacos.done", { name: result.name }), target: completed });
      setRequested((previous3) => ({ ...previous3, revision: previous3.revision + 1 }));
      try {
        await onInstalled?.(completed);
      } catch {
        if (mounted.current) setNotice({ text: t(reconciled ? "nacos.confirmedRefreshWarning" : "nacos.refreshWarning"), target: completed, warning: true });
      }
    }
    async function checkResult() {
      if (!pendingDownload || checking) return;
      const epoch = detailEpoch.current;
      setChecking(true);
      try {
        const outcome = decodeOperationOutcome(await api(`/nacos/install-status?operationId=${encodeURIComponent(pendingDownload.id)}`), isInstallReceipt);
        if (outcome.state === "pending") {
          if (mounted.current && detailEpoch.current === epoch) setDetailError(t("nacos.pending"));
          return;
        }
        pendingDownloads.delete(downloadKey);
        if (!mounted.current || detailEpoch.current !== epoch) return;
        setOperationRevision((previous3) => previous3 + 1);
        if (outcome.state === "succeeded") await complete(outcome.result, pendingDownload.target, true);
        else setDetailError(translateError2(t, outcome.failure));
      } catch {
        if (mounted.current && detailEpoch.current === epoch) setDetailError(t("nacos.pending"));
      } finally {
        if (mounted.current) setChecking(false);
      }
    }
    react2.useEffect(() => {
      if (!active) return;
      const controller = new AbortController();
      const epoch = ++listEpoch.current;
      setListLoading(true);
      setListError(null);
      api(`/nacos/list?q=${encodeURIComponent(requested.query)}&page=${requested.page}`, { signal: controller.signal }).then((data) => {
        if (epoch === listEpoch.current && !controller.signal.aborted) setListing({ data, query: requested.query });
      }).catch((error) => {
        if (epoch === listEpoch.current && !controller.signal.aborted) setListError(translateError2(t, error));
      }).finally(() => {
        if (epoch === listEpoch.current && !controller.signal.aborted) setListLoading(false);
      });
      return () => {
        listEpoch.current++;
        controller.abort();
      };
    }, [active, requested]);
    react2.useEffect(() => {
      if (!selected || !active) return;
      const controller = new AbortController();
      const epoch = ++detailEpoch.current;
      setDetail(null);
      setRoots([]);
      setWorkspaces([]);
      setDetailLoading(true);
      setDetailError(null);
      Promise.all([
        api("/nacos/detail", { method: "POST", headers, body: JSON.stringify({ skillName: selected.name, version: selected.version }), signal: controller.signal }),
        api("/workspaces", { signal: controller.signal }),
        api("/state", { signal: controller.signal })
      ]).then(([value, projects, local]) => {
        if (epoch !== detailEpoch.current || controller.signal.aborted) return;
        setDetail(value);
        setWorkspaces(projects.items);
        setRoots(local.roots.filter((root4) => root4.key === "dsh").map((root4) => ({ key: "dsh", path: root4.path, label: "DSH", available: root4.mutable !== false })));
      }).catch((error) => {
        if (epoch === detailEpoch.current && !controller.signal.aborted) setDetailError(translateError2(t, error));
      }).finally(() => {
        if (epoch === detailEpoch.current && !controller.signal.aborted) setDetailLoading(false);
      });
      return () => {
        detailEpoch.current++;
        controller.abort();
      };
    }, [selected, active, detailRevision]);
    react2.useEffect(() => {
      if (!active) operation.current?.abort();
    }, [active]);
    react2.useEffect(() => {
      mounted.current = true;
      return () => {
        mounted.current = false;
        operation.current?.abort();
      };
    }, []);
    async function install() {
      if (!selected || !detail || operation.current || uncertain || installation || !destinationReady2(target, workspaces, roots)) return;
      const controller = new AbortController();
      const installedTarget = { name: selected.name, scope: target.scope === "workspace" ? "workspace" : "user", workspace: target.workspace };
      const operationId = crypto.randomUUID();
      pendingDownloads.set(downloadKey, { id: operationId, target: installedTarget });
      operation.current = controller;
      setInstalling(true);
      setDetailError(null);
      try {
        const result = await api("/nacos/install", { method: "POST", headers, body: JSON.stringify({ skillName: selected.name, version: selected.version, ...destinationPayload2(target), operationId }), signal: controller.signal });
        if (!controller.signal.aborted) pendingDownloads.delete(downloadKey);
        if (!mounted.current) return;
        if (controller.signal.aborted) {
          setDetailError(t("error.nacos.cancelled"));
          return;
        }
        await complete(result, installedTarget);
      } catch (error) {
        if (isConfirmedRejection(error)) pendingDownloads.delete(downloadKey);
        if (mounted.current) {
          setDetailError(controller.signal.aborted ? t("error.nacos.cancelled") : translateError2(t, error));
        }
      } finally {
        operation.current = null;
        if (mounted.current) setInstalling(false);
      }
    }
    function close() {
      if (!operation.current) {
        detailEpoch.current++;
        setSelected(null);
        setDetail(null);
      }
    }
    function open(item) {
      if (operation.current) return;
      setDetail(null);
      setDetailError(null);
      setDetailLoading(true);
      setTarget(defaultDestination2());
      setSelected(item);
    }
    function search2(value = query) {
      setQuery(value);
      setRequested((previous3) => ({ query: value.trim(), page: 1, revision: previous3.revision + 1 }));
    }
    function refresh() {
      setRequested((previous3) => ({ ...previous3, revision: previous3.revision + 1 }));
    }
    const button = (key, onClick, disabled = false) => h4(Button2, { variant: "outline", size: "sm", onClick, disabled }, t(key));
    const state = (title, text7, action) => h4(
      "div",
      { className: "dssm-nacos-state", role: "status" },
      h4("span", { className: "dssm-nacos-icon" }, icon("M4 5h6l2 2h8v12H4z")),
      h4("strong", null, t(title)),
      h4("p", null, text7),
      action
    );
    const content3 = h4(
      "div",
      { key: "nacos", id: "dssm-scope-panel", role: "tabpanel", "aria-labelledby": "dssm-tab-repositories", className: "dssm-nacos" },
      h4("style", null, nacosCss),
      h4("div", { className: "dssm-nacos-heading" }, h4("div", null, h4("h3", null, t("nacos.title")), h4("p", { className: "dssm-nacos-subtitle" }, t("nacos.subtitle")))),
      h4(
        "form",
        { className: "dssm-nacos-tools", onSubmit: (event) => {
          event.preventDefault();
          if (!operation.current) search2();
        } },
        h4(
          "div",
          { className: "dssm-nacos-search" },
          h4(Input2, { value: query, maxLength: 100, placeholder: t("nacos.search"), "aria-label": t("nacos.search"), disabled: installing, onChange: (event) => setQuery(event.target.value) }),
          query || requested.query ? h4(Button2, { variant: "ghost", size: "sm", type: "button", "aria-label": t("nacos.clear"), disabled: installing, onClick: () => search2("") }, icon("M6 6l12 12M18 6 6 18")) : null
        ),
        h4(Button2, { variant: "outline", size: "sm", type: "submit", disabled: installing }, t("nacos.searchAction")),
        h4(Button2, { variant: "ghost", size: "sm", type: "button", "aria-label": t("btn.refresh"), title: t("btn.refresh"), disabled: listLoading || installing, onClick: refresh }, icon("M20 7v5h-5M4 17v-5h5M5.5 7a7 7 0 0 1 12-1L20 9M4 15l2.5 3a7 7 0 0 0 12-1"))
      ),
      notice ? h4(
        "div",
        { className: "dssm-nacos-notice" + (notice.warning ? " is-warning" : ""), role: "status" },
        h4("span", null, notice.text),
        onNavigate ? button(notice.target.scope === "workspace" ? "nacos.openProject" : "nacos.openGlobal", () => onNavigate(notice.target), installing) : null
      ) : null,
      listError ? page ? h4("div", { className: "dssm-nacos-notice is-error", role: "alert" }, h4("span", null, listError), button("nacos.retry", refresh, listLoading)) : state("nacos.failedTitle", listError, button("nacos.retry", refresh, listLoading)) : null,
      listLoading && !page ? h4(
        "div",
        { role: "status", "aria-label": t("nacos.loading"), className: "dssm-nacos-grid" },
        [0, 1, 2].map((key) => h4("div", { key, className: "dssm-nacos-card dssm-nacos-skeleton", "aria-hidden": true }, h4("span"), h4("span"), h4("span")))
      ) : null,
      page?.configured === false ? state("nacos.unconfiguredTitle", t("nacos.unconfigured"), button("nacos.retry", refresh, listLoading)) : null,
      page?.configured ? h4(
        react2.Fragment,
        null,
        h4(
          "div",
          { className: "dssm-nacos-summary" },
          h4(
            "p",
            { className: "dssm-nacos-count", role: "status", "aria-live": "polite" },
            t(listing?.query ? "nacos.resultsFor" : "nacos.count", { count: page.items.length, query: listing?.query }),
            listLoading ? " \xB7 " + t("nacos.refreshing") : ""
          ),
          h4("span", { className: "dssm-nacos-sort" }, t("nacos.sortDownloads"))
        ),
        !page.items.length && !listLoading ? state(
          listing?.query && !page.total ? "nacos.noResults" : "nacos.emptyTitle",
          t(listing?.query && !page.total ? "nacos.noResultsHint" : "nacos.empty"),
          listing?.query ? button("nacos.clear", () => search2(""), installing) : button("btn.refresh", refresh, installing)
        ) : null,
        h4("div", { className: "dssm-nacos-grid", "aria-busy": listLoading }, page.items.map((item) => h4(
          "article",
          { className: "dssm-nacos-card", key: item.name + ":" + item.version },
          h4(
            "div",
            { className: "dssm-nacos-card-head" },
            h4("span", { className: "dssm-nacos-icon" }, icon("M14 3H6v18h12V7zM14 3v5h5M9 12h6M9 16h4")),
            h4("h4", null, item.name),
            h4("span", { className: "dssm-nacos-version" }, t("nacos.version", { version: item.version }))
          ),
          h4("p", { className: "dssm-nacos-description" }, item.description || t("nacos.noDescription")),
          downloadBadges(item),
          h4(
            "div",
            { className: "dssm-nacos-card-actions" },
            h4(
              "div",
              { className: "dssm-nacos-meta" },
              item.namespaceId ? h4(
                "span",
                { className: "dssm-nacos-namespace", title: t("nacos.namespace", { namespace: item.namespaceId }), "aria-label": t("nacos.namespace", { namespace: item.namespaceId }) },
                icon("M4 5h6l2 2h8v12H4z", 14),
                h4("span", null, item.namespaceId)
              ) : null,
              item.downloadCount !== void 0 ? h4(
                "span",
                { className: "dssm-nacos-downloads", title: t("nacos.downloadCountHint"), "aria-label": t("nacos.downloadCount", { count: item.downloadCount }) + ". " + t("nacos.downloadCountHint") },
                icon("M12 3v12m-5-5 5 5 5-5M5 16v5h14v-5", 14),
                t("nacos.downloadCount", { count: item.downloadCount.toLocaleString() })
              ) : null
            ),
            h4(Button2, { variant: "outline", size: "sm", disabled: installing, onClick: () => open(item) }, t("btn.detail"))
          )
        ))),
        page.page > 1 || page.total > page.pageSize ? h4(
          "nav",
          { className: "dssm-nacos-pagination", "aria-label": t("nacos.page", { page: page.page }) },
          button("nacos.previous", () => setRequested((previous3) => ({ ...previous3, query: listing.query, page: page.page - 1 })), listLoading || installing || page.page <= 1),
          h4("span", null, t("nacos.page", { page: page.page })),
          button("nacos.next", () => setRequested((previous3) => ({ ...previous3, query: listing.query, page: page.page + 1 })), listLoading || installing || page.page * page.pageSize >= page.total)
        ) : null
      ) : null,
      selected && active ? h4(NacosDetailDialog, {
        Modal: Modal2,
        Button: Button2,
        SourceSelect: SourceSelect2,
        t,
        selected,
        detail,
        loading: detailLoading,
        error: detailError,
        installing,
        uncertain,
        checking,
        target,
        workspaces,
        roots,
        ready: destinationReady2(target, workspaces, roots) && !installation,
        onTarget: setTarget,
        installed,
        installationStatus: installation ? t(statusKey(installation.state)) : null,
        onNavigate: installed && onNavigate ? () => onNavigate({ name: selected.name, scope: target.scope === "workspace" ? "workspace" : "user", workspace: target.workspace }) : void 0,
        onInstall: install,
        onClose: close,
        onCancel: () => operation.current?.abort(),
        onRetry: () => setDetailRevision((previous3) => previous3 + 1),
        onCheck: checkResult
      }) : null
    );
    return { content: content3, actions: null };
  };
}

// src/plugin-ui.ts
var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
var import_react3 = __toESM(require("react"), 1);
function TextArea(props) {
  const { autoSize, className, rows, ...rest } = props;
  return import_react3.default.createElement("textarea", {
    ...rest,
    className: ["dssm-textarea", className].filter(Boolean).join(" "),
    rows: autoSize?.minRows || rows || 4
  });
}
var Input = Object.assign(import_dsh_client_ui_primitives.Input, { TextArea });
function foldChevron(h4, open) {
  return h4("svg", {
    className: "dssm-fold-chevron" + (open ? " is-open" : ""),
    viewBox: "0 0 16 16",
    width: 12,
    height: 12,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    "aria-hidden": true
  }, h4("path", { d: "M4 6l4 4 4-4", strokeLinecap: "round", strokeLinejoin: "round" }));
}

// src/settings-nav-icon.ts
var import_react4 = __toESM(require("react"), 1);
var NAV_ICON_MARKER = "data-dssm-nav-icon";
var NAV_ROW_SELECTOR = '[role="dialog"] nav button, .dcu-settings-page .dcu-settings-link';
var SKILL_PATHS = '<path fill="currentColor" d="M12.5113 15.4067C12.4395 15.6249 12.1308 15.6249 12.059 15.4067L11.643 14.1416C11.454 13.567 11.0033 13.1164 10.4288 12.9274L9.16369 12.5113C8.94544 12.4395 8.94544 12.1308 9.16369 12.059L10.4288 11.643C11.0033 11.454 11.454 11.0033 11.643 10.4288L12.059 9.16369C12.1308 8.94544 12.4395 8.94544 12.5113 9.16369L12.9274 10.4288C13.1164 11.0033 13.567 11.454 14.1416 11.643L15.4067 12.059C15.6249 12.1308 15.6249 12.4395 15.4067 12.5113L14.1416 12.9274C13.567 13.1164 13.1164 13.567 12.9274 14.1416L12.5113 15.4067Z"/><path fill="currentColor" d="M9.02246 0.546878C9.9822 0.546878 10.7564 0.545403 11.374 0.612307C12.0042 0.680586 12.5515 0.826244 13.0273 1.17188C13.3052 1.37376 13.5501 1.61868 13.752 1.89649C14.0975 2.37225 14.2432 2.91984 14.3115 3.54981C14.3784 4.16727 14.377 4.94206 14.377 5.90137V8.51367C13.9611 8.29533 13.5071 8.13985 13.0273 8.06055V5.90137C13.0273 4.9121 13.0259 4.22322 12.9688 3.69532C12.9129 3.18044 12.8098 2.89782 12.6592 2.69043C12.5406 2.52724 12.3966 2.38326 12.2334 2.26465C12.026 2.11404 11.7437 2.0109 11.2285 1.95508C10.7005 1.89789 10.0122 1.89649 9.02246 1.89649H6.55371C5.56395 1.89649 4.87569 1.89787 4.34766 1.95508C3.83242 2.01092 3.55022 2.11398 3.34278 2.26465C3.17953 2.38329 3.03564 2.52719 2.91699 2.69043C2.76642 2.89782 2.66325 3.18042 2.60742 3.69532C2.55027 4.22322 2.54883 4.9121 2.54883 5.90137V10.0986C2.54883 11.0878 2.55031 11.7768 2.60742 12.3047C2.66326 12.8196 2.76642 13.1032 2.91699 13.3105C3.03558 13.4736 3.17966 13.6178 3.34278 13.7363C3.5502 13.8869 3.83265 13.9901 4.34766 14.0459C4.87568 14.1031 5.56398 14.1035 6.55371 14.1035H8.08399C8.27443 14.6025 8.55077 15.0585 8.89551 15.4541H6.55371C5.59402 15.4541 4.81976 15.4546 4.20215 15.3877C3.57204 15.3194 3.02468 15.1738 2.54883 14.8281C2.27111 14.6263 2.02606 14.3813 1.82422 14.1035C1.47883 13.6278 1.33293 13.08 1.26465 12.4502C1.19783 11.8327 1.19922 11.0579 1.19922 10.0986V5.90137C1.19922 4.94206 1.1978 4.16727 1.26465 3.54981C1.33293 2.91984 1.47883 2.37225 1.82422 1.89649C2.02606 1.61868 2.27111 1.37376 2.54883 1.17188C3.02468 0.826244 3.57204 0.680586 4.20215 0.612307C4.81976 0.545403 5.59402 0.546878 6.55371 0.546878H9.02246Z"/>';
function SkillsNavIcon({ size = 16 }) {
  return import_react4.default.createElement(
    "svg",
    {
      xmlns: "http://www.w3.org/2000/svg",
      viewBox: "0 0 16 16",
      width: size,
      height: size,
      fill: "currentColor"
    },
    import_react4.default.createElement("path", {
      d: "M12.5113 15.4067C12.4395 15.6249 12.1308 15.6249 12.059 15.4067L11.643 14.1416C11.454 13.567 11.0033 13.1164 10.4288 12.9274L9.16369 12.5113C8.94544 12.4395 8.94544 12.1308 9.16369 12.059L10.4288 11.643C11.0033 11.454 11.454 11.0033 11.643 10.4288L12.059 9.16369C12.1308 8.94544 12.4395 8.94544 12.5113 9.16369L12.9274 10.4288C13.1164 11.0033 13.567 11.454 14.1416 11.643L15.4067 12.059C15.6249 12.1308 15.6249 12.4395 15.4067 12.5113L14.1416 12.9274C13.567 13.1164 13.1164 13.567 12.9274 14.1416L12.5113 15.4067Z"
    }),
    import_react4.default.createElement("path", {
      d: "M9.02246 0.546878C9.9822 0.546878 10.7564 0.545403 11.374 0.612307C12.0042 0.680586 12.5515 0.826244 13.0273 1.17188C13.3052 1.37376 13.5501 1.61868 13.752 1.89649C14.0975 2.37225 14.2432 2.91984 14.3115 3.54981C14.3784 4.16727 14.377 4.94206 14.377 5.90137V8.51367C13.9611 8.29533 13.5071 8.13985 13.0273 8.06055V5.90137C13.0273 4.9121 13.0259 4.22322 12.9688 3.69532C12.9129 3.18044 12.8098 2.89782 12.6592 2.69043C12.5406 2.52724 12.3966 2.38326 12.2334 2.26465C12.026 2.11404 11.7437 2.0109 11.2285 1.95508C10.7005 1.89789 10.0122 1.89649 9.02246 1.89649H6.55371C5.56395 1.89649 4.87569 1.89787 4.34766 1.95508C3.83242 2.01092 3.55022 2.11398 3.34278 2.26465C3.17953 2.38329 3.03564 2.52719 2.91699 2.69043C2.76642 2.89782 2.66325 3.18042 2.60742 3.69532C2.55027 4.22322 2.54883 4.9121 2.54883 5.90137V10.0986C2.54883 11.0878 2.55031 11.7768 2.60742 12.3047C2.66326 12.8196 2.76642 13.1032 2.91699 13.3105C3.03558 13.4736 3.17966 13.6178 3.34278 13.7363C3.5502 13.8869 3.83265 13.9901 4.34766 14.0459C4.87568 14.1031 5.56398 14.1035 6.55371 14.1035H8.08399C8.27443 14.6025 8.55077 15.0585 8.89551 15.4541H6.55371C5.59402 15.4541 4.81976 15.4546 4.20215 15.3877C3.57204 15.3194 3.02468 15.1738 2.54883 14.8281C2.27111 14.6263 2.02606 14.3813 1.82422 14.1035C1.47883 13.6278 1.33293 13.08 1.26465 12.4502C1.19783 11.8327 1.19922 11.0579 1.19922 10.0986V5.90137C1.19922 4.94206 1.1978 4.16727 1.26465 3.54981C1.33293 2.91984 1.47883 2.37225 1.82422 1.89649C2.02606 1.61868 2.27111 1.37376 2.54883 1.17188C3.02468 0.826244 3.57204 0.680586 4.20215 0.612307C4.81976 0.545403 5.59402 0.546878 6.55371 0.546878H9.02246Z"
    })
  );
}
var SKILL_ICON_MASK = `url("data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${SKILL_PATHS.replace(/fill=\"currentColor\"/g, 'fill="black"')}</svg>`
)}")`;
var NAV_ICON_STYLE_ID = "dssm-settings-nav-icon-style";
var NAV_ICON_CSS = [
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
  `.dcu-sb-row[${NAV_ICON_MARKER}]::before, .dcu-sb-row::before { content: none !important; }`
].join("\n");
function isOwnNavRow(rowText, wantedLabel) {
  const wanted = String(wantedLabel ?? "").trim();
  if (wanted.length === 0) return false;
  const current = String(rowText ?? "").trim();
  return current === wanted;
}
function isSidebarNavButton(button) {
  if (!button) return false;
  const anyBtn = button;
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
function ensureNavIconStyle() {
  if (typeof document === "undefined") return;
  if (document.getElementById(NAV_ICON_STYLE_ID) !== null) return;
  const style = document.createElement("style");
  style.id = NAV_ICON_STYLE_ID;
  style.textContent = NAV_ICON_CSS;
  (document.head ?? document.documentElement).appendChild(style);
}
function applySettingsNavIcon(button, wantedLabel) {
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
      const cls = String(child.className || "");
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
function restoreSettingsNavIcon(button) {
  if (!button.hasAttribute(NAV_ICON_MARKER)) return false;
  button.removeAttribute(NAV_ICON_MARKER);
  return true;
}
function installSettingsNavIcon(ctx, resolveLabel) {
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

// src/sidebar-entry.ts
var import_dsh_client_ui_primitives2 = require("@deepseek-ai/dsh-client-ui-primitives");
var React4 = __toESM(require("react"), 1);
var h2 = React4.createElement;
var BUNDLE_KEY = "@heluo/forge-skills-manager";
var SIDEBAR_PANEL_ID = "skills-manager";
var SIDEBAR_PANEL_ORDER = 2;
var sidebarLocales = {
  zh: {
    "entry.location.title": "\u5165\u53E3\u5C55\u793A\u4F4D\u7F6E",
    "entry.location.desc": "\u9009\u62E9\u6280\u80FD\u7BA1\u7406\u5165\u53E3\u7684\u5C55\u793A\u4F4D\u7F6E\uFF08\u81F3\u5C11\u4FDD\u7559\u4E00\u5904\uFF0C\u9632\u6B62\u65E0\u6CD5\u6253\u5F00\u9762\u677F\uFF09\u3002",
    "entry.location.both": "\u4E24\u8FB9\u663E\u793A",
    "entry.location.sidebar": "\u4EC5\u4FA7\u8FB9\u680F",
    "entry.location.settings": "\u4EC5\u8BBE\u7F6E",
    "sidebar.entry.title": "\u4FA7\u8FB9\u680F\u5165\u53E3",
    "sidebar.entry.desc": "\u5728\u4FA7\u680F\u300C\u63D2\u4EF6\u300D\u4E0B\u65B9\u663E\u793A\u6280\u80FD\u3002\u8BBE\u7F6E\u91CC\u7684\u5165\u53E3\u4E0D\u53D8\u3002"
  },
  en: {
    "entry.location.title": "Entry placement",
    "entry.location.desc": "Choose where to show the entry (at least one is retained to avoid losing access).",
    "entry.location.both": "Both",
    "entry.location.sidebar": "Sidebar only",
    "entry.location.settings": "Settings only",
    "sidebar.entry.title": "Sidebar entry",
    "sidebar.entry.desc": "Show Skills below Plugins in the sidebar. The Settings entry stays either way."
  }
};
var SIDEBAR_ENTRY_STYLE_ID = "dssm-sidebar-entry-style";
var sidebarEntryCss = `
.dssm-main-panel{box-sizing:border-box;height:100%;min-height:0;overflow-y:auto;display:flex;flex-direction:column;align-items:center;padding:28px clamp(24px,4vw,48px) 48px}
.dssm-main-panel>*{width:100%;max-width:960px}
.dssm-bundle-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:0.5px solid var(--dsw-alias-border-l2)}
.dssm-bundle-label-box{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1;text-align:left}
.dssm-bundle-title{font-size:13px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary)}
.dssm-bundle-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
`;
function ensureSidebarEntryStyle() {
  if (typeof document === "undefined") return;
  if (document.getElementById(SIDEBAR_ENTRY_STYLE_ID) !== null) return;
  const style = document.createElement("style");
  style.id = SIDEBAR_ENTRY_STYLE_ID;
  style.textContent = sidebarEntryCss;
  (document.head ?? document.documentElement).appendChild(style);
}
function SkillSidebarIcon(props) {
  const size = props && typeof props.size === "number" ? props.size : 16;
  return h2("svg", {
    viewBox: "0 0 16 16",
    width: size,
    height: size,
    fill: "currentColor",
    "aria-hidden": "true",
    focusable: "false",
    dangerouslySetInnerHTML: { __html: SKILL_PATHS }
  });
}
function SkillBundleConfigCard(props) {
  ensureSidebarEntryStyle();
  const {
    t,
    location: propLocation,
    onLocationChange,
    enabled = false,
    onToggle,
    disabled
  } = props;
  const effectiveLocation = propLocation ?? (enabled ? "both" : "settings");
  const handleLocationChange = (next) => {
    if (next === "both" || next === "sidebar" || next === "settings") {
      if (typeof onLocationChange === "function") {
        onLocationChange(next);
      } else if (typeof onToggle === "function") {
        onToggle(next !== "settings");
      }
    }
  };
  const rows = [
    h2(
      "div",
      { key: "entry-location", className: "dssm-bundle-row" },
      h2(
        "div",
        { className: "dssm-bundle-label-box" },
        h2("span", { className: "dssm-bundle-title" }, t("entry.location.title") || t("sidebar.entry.title")),
        h2("span", { className: "dssm-bundle-desc" }, t("entry.location.desc") || t("sidebar.entry.desc"))
      ),
      h2(import_dsh_client_ui_primitives2.SegmentedControl, {
        id: "dssm-bundle-entry-location",
        value: effectiveLocation,
        onChange: handleLocationChange,
        label: t("entry.location.title") || t("sidebar.entry.title"),
        disabled,
        options: [
          { value: "both", label: t("entry.location.both") || "\u4E24\u8FB9\u663E\u793A" },
          { value: "sidebar", label: t("entry.location.sidebar") || "\u4EC5\u4FA7\u8FB9\u680F" },
          { value: "settings", label: t("entry.location.settings") || "\u4EC5\u8BBE\u7F6E" }
        ]
      })
    )
  ];
  return h2(React4.Fragment, null, rows);
}
function SkillBundleConfigCardWrapper(props) {
  const [location, setLocation] = React4.useState(props.getLocation);
  const [savingLocation, setSavingLocation] = React4.useState(false);
  const [pending, setPending] = React4.useState(props.operations?.getSnapshot());
  const [error, setError] = React4.useState("");
  React4.useEffect(() => props.operations?.subscribe(() => setPending(props.operations?.getSnapshot())), [props.operations]);
  React4.useEffect(() => {
    const syncState = () => {
      setLocation(props.getLocation());
    };
    syncState();
    return props.subscribe(syncState);
  }, [props]);
  const onLocationChange = (next) => {
    setSavingLocation(true);
    setError("");
    props.setLocation(next).catch((reason) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => {
      setSavingLocation(false);
    });
  };
  const card = h2(SkillBundleConfigCard, {
    t: props.t,
    location,
    disabled: savingLocation || !!pending,
    onLocationChange
  });
  if (!pending && !error) return card;
  return h2(React4.Fragment, null, card, h2("div", { role: "alert" }, pending ? props.t("mutation.pending") : error), pending?.phase === "pending" ? h2("button", { type: "button", disabled: savingLocation, onClick: () => {
    setSavingLocation(true);
    setError("");
    props.confirm().catch((reason) => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setSavingLocation(false));
  } }, props.t("mutation.check")) : null);
}
function setupSidebarEntry(ctx, options) {
  ensureSidebarEntryStyle();
  if (!ctx.locale) {
    return {
      getLocation: () => "settings",
      setLocation: async () => "settings",
      isSettingsSectionEnabled: () => true,
      isEnabled: () => false,
      isSupported: () => false,
      setEnabled: async () => false,
      destroy: () => {
      }
    };
  }
  const { callApi: callApi2, headers, renderPanel, ns } = options;
  let entryLocation = "settings";
  let sidebarSupported = false;
  let offPanel = null;
  let offRow = null;
  let epoch = 0;
  let destroyed = false;
  let layoutService;
  const listeners = /* @__PURE__ */ new Set();
  const isSidebarEnabled = () => entryLocation === "both" || entryLocation === "sidebar";
  const isSettingsSectionEnabled = () => entryLocation === "both" || entryLocation === "settings";
  const notify = () => {
    if (destroyed) return;
    for (const listener of listeners) {
      try {
        listener();
      } catch {
      }
    }
  };
  const sync = () => {
    if (destroyed) return;
    if (sidebarSupported && isSidebarEnabled()) {
      if (!offPanel) {
        const res = ctx.slots.register({
          name: "main",
          key: SIDEBAR_PANEL_ID,
          locale: ns,
          inject: () => ({ t: ctx.locale?.bind ? ctx.locale.bind(ns) : void 0 })
        }, (ownerProps) => h2("div", { className: "dssm-main-panel" }, renderPanel(ownerProps)));
        offPanel = typeof res === "function" ? res : () => {
        };
      }
      if (!offRow) {
        const res = ctx.slots.register({
          name: "sidebar.panellist",
          id: SIDEBAR_PANEL_ID,
          order: SIDEBAR_PANEL_ORDER,
          label: () => ctx.locale.bind(ns)("title"),
          locale: ns
        }, (ownerProps) => h2(SkillSidebarIcon, ownerProps));
        offRow = typeof res === "function" ? res : () => {
        };
      }
    } else {
      if (layoutService?.panelInfo && typeof layoutService.selectPanel === "function") {
        try {
          if (layoutService.panelInfo.getSnapshot().activePanelId === SIDEBAR_PANEL_ID) {
            layoutService.selectPanel(null);
          }
        } catch {
        }
      }
      if (offRow) {
        try {
          offRow();
        } catch {
        }
        offRow = null;
      }
      if (offPanel) {
        try {
          offPanel();
        } catch {
        }
        offPanel = null;
      }
    }
  };
  const setLocation = async (next) => {
    if (destroyed) return entryLocation;
    const currentEpoch = ++epoch;
    const saved = await callApi2("/sidebar-entry", {
      method: "POST",
      headers,
      body: JSON.stringify({ location: next })
    });
    const confirmed = saved.location;
    if (confirmed !== "both" && confirmed !== "sidebar" && confirmed !== "settings") throw new Error("Invalid saved entry location");
    if (!destroyed && currentEpoch === epoch) {
      entryLocation = confirmed;
      sync();
      notify();
      options.onLocationChange?.(entryLocation);
    }
    return confirmed;
  };
  const confirmLocation = async () => {
    const outcome = await options.operations?.confirm();
    if (outcome?.state === "rejected") throw outcome.failure;
    if (outcome?.state !== "succeeded") return;
    const saved = await callApi2("/sidebar-entry");
    if (destroyed) return;
    if (saved.location !== "both" && saved.location !== "sidebar" && saved.location !== "settings") throw new Error("Invalid saved entry location");
    entryLocation = saved.location;
    sync();
    notify();
    options.onLocationChange?.(entryLocation);
  };
  const setEnabled = async (next) => {
    await setLocation(next ? "both" : "settings");
    return isSidebarEnabled();
  };
  const loadEpoch = epoch;
  callApi2("/sidebar-entry").then((res) => {
    if (!destroyed && epoch === loadEpoch && res) {
      if (res.location === "both" || res.location === "sidebar" || res.location === "settings") {
        entryLocation = res.location;
      } else if (typeof res.enabled === "boolean") {
        entryLocation = res.enabled ? "both" : "settings";
      }
      sync();
      notify();
      if (typeof options.onLocationChange === "function") {
        try {
          options.onLocationChange(entryLocation);
        } catch {
        }
      }
    }
  }).catch(() => {
  });
  if (typeof ctx.inject === "function") {
    ctx.inject(["layout"], (scoped) => {
      if (!destroyed) layoutService = scoped.layout;
    });
  }
  ctx.slots.inject("sidebar.panellist", () => {
    if (destroyed) return;
    sidebarSupported = true;
    sync();
  });
  ctx.slots.inject("plugins.bundle.config", () => {
    if (destroyed) return;
    return ctx.slots.register({
      name: "plugins.bundle.config",
      key: BUNDLE_KEY,
      locale: ns
    }, (ownerProps) => {
      if (ownerProps && ownerProps.view === "summary") return null;
      return h2(SkillBundleConfigCardWrapper, {
        t: ctx.locale.bind(ns),
        getLocation: () => entryLocation,
        setLocation,
        operations: options.operations,
        confirm: confirmLocation,
        getEnabled: () => isSidebarEnabled(),
        setSidebar: setEnabled,
        subscribe: (fn) => {
          listeners.add(fn);
          return () => {
            listeners.delete(fn);
          };
        }
      });
    });
  });
  return {
    getLocation: () => entryLocation,
    setLocation,
    isSettingsSectionEnabled,
    isEnabled: () => isSidebarEnabled(),
    isSupported: () => sidebarSupported,
    setEnabled,
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      epoch++;
      layoutService = void 0;
      listeners.clear();
      if (offRow) {
        try {
          offRow();
        } catch {
        }
        offRow = null;
      }
      if (offPanel) {
        try {
          offPanel();
        } catch {
        }
        offPanel = null;
      }
    }
  };
}

// src/source-select.ts
var import_dsh_client_ui_primitives3 = require("@deepseek-ai/dsh-client-ui-primitives");

// src/source-select-model.ts
function handleSourceMenuEscape(event, close) {
  if (event.key !== "Escape") return false;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  close();
  return true;
}

// src/source-select.ts
function createSourceSelect(react2) {
  const h4 = react2.createElement;
  return function SourceSelect2(props) {
    const openState = react2.useState(false);
    const open = openState[0];
    const setOpen = openState[1];
    react2.useEffect(function() {
      if (!open || typeof window === "undefined") return void 0;
      function onKey(event) {
        handleSourceMenuEscape(event, function() {
          setOpen(false);
        });
      }
      window.addEventListener("keydown", onKey, true);
      return function() {
        window.removeEventListener("keydown", onKey, true);
      };
    }, [open]);
    const items = react2.useMemo(function() {
      return props.options.map(function(opt, idx) {
        if (opt.type === "separator") {
          return {
            type: "separator",
            id: opt.value || "sep-" + idx
          };
        }
        if (opt.type === "label") {
          return {
            type: "label",
            id: opt.value || "lbl-" + idx,
            text: typeof opt.label === "string" ? opt.label : ""
          };
        }
        return {
          id: opt.value || "",
          label: opt.label,
          disabled: opt.disabled,
          danger: opt.danger
        };
      });
    }, [props.options]);
    if (props.action) {
      return h4(
        "div",
        { className: "dssm-action-menu-wrap", style: { display: "inline-block" } },
        h4(import_dsh_client_ui_primitives3.Menu, {
          open,
          onClose: function() {
            setOpen(false);
          },
          onSelect: function(id) {
            props.onChange(id);
            setOpen(false);
          },
          align: "end",
          portal: true,
          anchor: h4(import_dsh_client_ui_primitives3.Button, {
            variant: "outline",
            size: "sm",
            disabled: props.disabled,
            className: props.icon ? "dssm-icon-action" : void 0,
            style: props.icon ? { width: 22, minWidth: 22, height: 22, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: "var(--dsw-radius-sm, 8px)" } : void 0,
            "aria-label": props.ariaLabel || props.label,
            "aria-haspopup": "menu",
            "aria-expanded": open,
            title: props.label,
            onClick: function() {
              if (!props.disabled) setOpen(function(prev) {
                return !prev;
              });
            },
            icon: props.icon
          }, props.icon ? null : props.label),
          items
        })
      );
    }
    const selectedOption = props.options.find(function(opt) {
      return !opt.type && opt.value === props.value;
    });
    const currentText = props.text !== void 0 ? props.text : selectedOption ? selectedOption.label : props.label;
    return h4(
      "div",
      { className: "dssm-menu-select-wrap" },
      h4(import_dsh_client_ui_primitives3.Menu, {
        open,
        onClose: function() {
          setOpen(false);
        },
        onSelect: function(id) {
          props.onChange(id);
          setOpen(false);
        },
        selectedId: props.value,
        selectedIds: props.values,
        align: "start",
        portal: true,
        dense: true,
        listClassName: "dssm-source-select-menu",
        anchor: h4(
          import_dsh_client_ui_primitives3.Button,
          {
            variant: "outline",
            size: "sm",
            role: "combobox",
            "aria-label": props.label,
            "aria-expanded": open,
            disabled: props.disabled,
            className: "dssm-menu-select-trigger" + (open ? " is-open" : ""),
            onClick: function() {
              if (!props.disabled) setOpen(function(prev) {
                return !prev;
              });
            }
          },
          h4("span", { className: "dssm-menu-select-label" }, currentText),
          h4("svg", {
            className: "dssm-menu-select-arrow",
            viewBox: "0 0 16 16",
            width: 12,
            height: 12,
            fill: "none",
            stroke: "currentColor",
            strokeWidth: 1.8,
            strokeLinecap: "round",
            strokeLinejoin: "round",
            style: { marginLeft: 4, transition: "transform 150ms ease", transform: open ? "rotate(180deg)" : "none" }
          }, h4("path", { d: "m4 6 4 4 4-4" }))
        ),
        items
      })
    );
  };
}

// src/client-operations.ts
var readOnlyPosts = /* @__PURE__ */ new Set(["/detail", "/browse", "/workspace-skills", "/custom-source-scan", "/nacos/detail", "/nacos/install"]);
function createClientOperations(send) {
  let current = null;
  let checking = false;
  const listeners = /* @__PURE__ */ new Set();
  function update(next) {
    current = next;
    for (const listener of listeners) listener();
  }
  async function request(path2, options) {
    if (options?.method?.toUpperCase() !== "POST" || readOnlyPosts.has(path2)) return send(path2, options);
    if (current) throw new ApiFailure({ code: API_ERROR_CODES.busy, message: "A previous operation must be confirmed first", outcome: "pending" });
    const operation = { id: crypto.randomUUID(), path: path2, phase: "submitting" };
    update(operation);
    const headers = Object.fromEntries(new Headers(options.headers).entries());
    headers["x-dsh-skills-operation"] = operation.id;
    try {
      const result = await send(path2, { ...options, headers });
      update(null);
      return result;
    } catch (error) {
      update(isConfirmedRejection(error) ? null : { ...operation, phase: "pending" });
      throw error;
    }
  }
  async function confirm() {
    if (!current || current.phase !== "pending" || checking) return { state: "pending" };
    const operation = current;
    checking = true;
    try {
      const outcome = decodeOperationOutcome(await send(`/operation-status?operationId=${encodeURIComponent(operation.id)}`), (result) => result !== void 0);
      if (outcome.state !== "pending" && current === operation) update(null);
      return outcome;
    } finally {
      checking = false;
    }
  }
  return { request, confirm, getSnapshot: () => current, subscribe(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  } };
}

// src/client.ts
/*! §1 Pure projections, constants and stateless primitives */
var react = React5;
var h3 = react.createElement;
var FallbackCheckbox = function FallbackCheckbox2(props) {
  return h3("label", { className: props.className }, h3("input", { type: "checkbox", checked: props.checked, disabled: props.disabled, onChange: function(event) {
    props.onChange(event.target.checked);
  } }), h3("span", null, props.label));
};
var DisplayCheckbox = primitives.Checkbox || FallbackCheckbox;
var HostTag = primitives.Tag || function HostTag2(props) {
  return h3("span", { className: props.className, title: props.title }, props.children);
};
var MUTATION_HEADERS = { "content-type": "application/json", "x-dsh-skills-manager": "1" };
var NS = "skills-manager";
var DICT = {
  zh: {
    "summary.group.one": "{count} \u4E2A\u6280\u80FD",
    "summary.group.other": "{count} \u4E2A\u6280\u80FD",
    "format.locale": "zh-CN",
    "format.warningSeparator": "\uFF1B",
    "title": "\u6280\u80FD\u7BA1\u7406",
    "desc": "\u7EDF\u4E00\u52A0\u8F7D\u548C\u7BA1\u7406\u672C\u673A Agent Skills\u3002",
    "btn.create": "\u521B\u5EFA\u6280\u80FD",
    "btn.refresh": "\u5237\u65B0",
    "btn.cancel": "\u53D6\u6D88",
    "btn.close": "\u5173\u95ED",
    "btn.detail": "\u67E5\u770B\u8BE6\u60C5",
    "btn.more": "\u66F4\u591A",
    "btn.trash": "\u79FB\u5230\u56DE\u6536\u7AD9",
    "btn.restore": "\u6062\u590D",
    "btn.delete.forever": "\u6C38\u4E45\u5220\u9664",
    "btn.file.pick": "\u9009\u62E9\u6587\u4EF6",
    "btn.folder.pick": "\u9009\u62E9\u6587\u4EF6\u5939",
    "btn.import.now": "\u5B89\u88C5",
    "btn.create.now": "\u521B\u5EFA\u6280\u80FD",
    "btn.confirm": "\u786E\u5B9A",
    "status.enabled": "\u5DF2\u542F\u7528",
    "status.disabled": "\u5DF2\u505C\u7528",
    "status.invalid": "\u8BCA\u65AD\u5F02\u5E38",
    "status.shadowed": "\u88AB\u8986\u76D6",
    "summary.total.one": "{count} \u4E2A\u6280\u80FD",
    "summary.total.other": "{count} \u4E2A\u6280\u80FD",
    "summary.enabled.one": "{count} \u4E2A\u5DF2\u542F\u7528",
    "summary.enabled.other": "{count} \u4E2A\u5DF2\u542F\u7528",
    "summary.disabled.one": "{count} \u4E2A\u5DF2\u505C\u7528",
    "summary.disabled.other": "{count} \u4E2A\u5DF2\u505C\u7528",
    "summary.invalid.one": "{count} \u4E2A\u8BCA\u65AD\u5F02\u5E38",
    "summary.invalid.other": "{count} \u4E2A\u8BCA\u65AD\u5F02\u5E38",
    "filter.workspace": "\u5DE5\u4F5C\u533A",
    "filter.source": "\u6765\u6E90",
    "filter.all": "\u5168\u90E8\u6765\u6E90",
    "filter.option": "{name}\uFF08{count}\uFF09",
    "search": "\u641C\u7D22",
    "search.placeholder": "\u641C\u7D22\u6280\u80FD\u540D\u79F0\u3001\u63CF\u8FF0\u6216\u5907\u6CE8",
    "empty.search": "\u6CA1\u6709\u5339\u914D\u7684\u6280\u80FD\u3002",
    "empty.source": "\u8BE5\u6765\u6E90\u76EE\u5F55\u4E0D\u5B58\u5728\u6216\u6682\u65F6\u6CA1\u6709\u6280\u80FD\u3002",
    "loading": "\u6B63\u5728\u52A0\u8F7D\u6280\u80FD\u2026",
    "note.missing": "\u672A\u63D0\u4F9B\u7B80\u4ECB",
    "skill.linked": "\u5916\u90E8\u76EE\u5F55\u94FE\u63A5\uFF0C\u53EA\u8BFB",
    "source.toggle": "\u542F\u505C\u6765\u6E90",
    "skill.toggle": "\u542F\u505C\u6280\u80FD",
    "category.toggle": "\u542F\u505C\u5206\u7C7B",
    "category.create": "\u65B0\u5EFA\u5206\u7C7B",
    "category.uncategorized": "\u672A\u5206\u7C7B",
    "category.assign": "\u5F52\u5165{name}",
    "category.rename": "\u91CD\u547D\u540D",
    "category.delete": "\u5220\u9664\u5206\u7C7B",
    "category.note": "\u5206\u7C7B\u53EA\u8BB0\u5728\u8FD9\u4E2A\u6765\u6E90\u91CC\uFF0C\u4E0D\u79FB\u52A8\u6587\u4EF6\u3002",
    "category.name": "\u5206\u7C7B\u540D\u79F0",
    "category.empty": "\u8FD8\u6CA1\u6709\u6280\u80FD\u3002\u4ECE\u6761\u76EE\u7684\u300C\u66F4\u591A\u300D\u5F52\u5165\u3002",
    "category.progress": "{count} \u9879 \xB7 {enabled}/{usable} \u542F\u7528",
    "category.created": "\u5DF2\u6DFB\u52A0\u5206\u7C7B\u300C{name}\u300D\u3002\u6587\u4EF6\u6CA1\u6709\u65B0\u5EFA\u76EE\u5F55\u3002",
    "category.renamed": "\u5DF2\u91CD\u547D\u540D\u3002\u6280\u80FD\u6587\u4EF6\u540D\u6CA1\u6709\u53D8\u5316\u3002",
    "category.deleted": "\u5DF2\u5220\u9664\u5206\u7C7B\u300C{name}\u300D\u3002\u6280\u80FD\u56DE\u5230\u672A\u5206\u7C7B\uFF0C\u6CA1\u6709\u8FDB\u56DE\u6536\u7AD9\u3002",
    "category.assigned": "\u5DF2\u5C06 {name} \u5F52\u5165\u300C{category}\u300D\u3002\u6587\u4EF6\u6CA1\u6709\u79FB\u52A8\u3002",
    "category.dragTip": "\u62D6\u62FD\u8C03\u6574\u987A\u5E8F\u6216\u79FB\u52A8\u5230\u5176\u4ED6\u5206\u7C7B",
    "category.moved": "\u5DF2\u8C03\u6574\u6280\u80FD {name} \u7684\u5206\u7C7B\u6216\u987A\u5E8F\u3002",
    "confirm.category.title": "\u5220\u9664\u5206\u7C7B\uFF1F",
    "confirm.category.desc": "\u300C{name}\u300D\u4F1A\u6D88\u5931\uFF0C\u91CC\u9762\u7684\u6280\u80FD\u56DE\u5230\u672A\u5206\u7C7B\u3002\u6587\u4EF6\u4E0D\u4F1A\u79FB\u52A8\u3002",
    "error.category.duplicate": "\u5DF2\u6709\u540C\u540D\u5206\u7C7B: {name}",
    "error.category.name": "\u5206\u7C7B\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A\uFF0C\u4E14\u4E0D\u80FD\u8D85\u8FC7 24 \u4E2A\u5B57\u7B26",
    "error.category.notFound": "\u5206\u7C7B\u4E0D\u5B58\u5728",
    "error.category.root": "\u6280\u80FD\u6765\u6E90\u4E0D\u5B58\u5728: {root}",
    "error.category.position": "\u6280\u80FD\u6392\u5E8F\u4F4D\u7F6E\u65E0\u6548",
    "error.category.target": "\u6392\u5E8F\u76EE\u6807\u4E0D\u5C5E\u4E8E\u76EE\u6807\u5206\u7C7B",
    "detail.title": "\u6280\u80FD\u8BE6\u60C5",
    "detail.description": "\u7B80\u4ECB",
    "detail.customNote": "\u81EA\u5B9A\u4E49\u7B80\u4ECB",
    "detail.copyBody": "\u590D\u5236\u6B63\u6587",
    "detail.copied": "\u5DF2\u590D\u5236",
    "detail.copyFailed": "\u590D\u5236\u5931\u8D25",
    "token.badgeTip": "\u7B80\u4ECB \u2248{description} token\uFF08\u5E38\u9A7B\u7CFB\u7EDF\u63D0\u793A\u8BCD\uFF09\uFF1B\u6B63\u6587 \u2248{body} token\uFF08\u8C03\u7528\u65F6\u52A0\u8F7D\uFF09\u3002\u6570\u5B57\u4E3A\u4F30\u7B97\u503C\u3002",
    "token.badgeTip.manualOnly": "\u7B80\u4ECB \u2248{description} token\uFF1B\u6B63\u6587 \u2248{body} token\uFF08\u4EC5\u624B\u52A8\u8C03\u7528\uFF0C\u4E0D\u5E38\u9A7B\u7CFB\u7EDF\u63D0\u793A\u8BCD\uFF09\u3002\u6570\u5B57\u4E3A\u4F30\u7B97\u503C\u3002",
    "token.badgeTip.blocked": "\u7B80\u4ECB \u2248{description} token\uFF1B\u6B63\u6587 \u2248{body} token\uFF08\u4E0D\u53EF\u8C03\u7528\uFF09\u3002\u6570\u5B57\u4E3A\u4F30\u7B97\u503C\u3002",
    "token.badgeTip.disabled": "\u7B80\u4ECB \u2248{description} token\uFF1B\u6B63\u6587 \u2248{body} token\uFF08\u672A\u542F\u7528\uFF0C\u4E0D\u5E38\u9A7B\u7CFB\u7EDF\u63D0\u793A\u8BCD\uFF09\u3002\u6570\u5B57\u4E3A\u4F30\u7B97\u503C\u3002",
    "token.badgeTip.shadowed": "\u7B80\u4ECB \u2248{description} token\uFF1B\u6B63\u6587 \u2248{body} token\uFF08\u88AB\u540C\u540D\u6280\u80FD\u8986\u76D6\uFF0C\u4E0D\u5E38\u9A7B\u7CFB\u7EDF\u63D0\u793A\u8BCD\uFF09\u3002\u6570\u5B57\u4E3A\u4F30\u7B97\u503C\u3002",
    "token.detailLine": "\u7B80\u4ECB \u2248{description} token \xB7 \u6B63\u6587 \u2248{body} token",
    "token.note": "token \u6570\u6309\u63D2\u4EF6\u89C4\u5219\u4F30\u7B97\uFF08CJK \u6BCF\u5B57\u7EA6 1 \u4E2A\uFF0C\u5176\u4F59\u6309\u8BCD\u5757\u6298\u7B97\uFF09\u3002\u7B80\u4ECB\u968F\u6280\u80FD\u76EE\u5F55\u5E38\u9A7B\u7CFB\u7EDF\u63D0\u793A\u8BCD\uFF08\u4EC5\u6A21\u578B\u53EF\u89C1\u6280\u80FD\u8BA1\u5165\uFF0C\u8D85\u8FC7 500 \u5B57\u7B26\u6309\u5BBF\u4E3B\u622A\u65AD\u4F30\u7B97\uFF09\uFF0C\u6B63\u6587\u4EC5\u5728\u8C03\u7528\u65F6\u52A0\u8F7D\u3002",
    "token.note.manualOnly": "token \u6570\u6309\u63D2\u4EF6\u89C4\u5219\u4F30\u7B97\uFF08CJK \u6BCF\u5B57\u7EA6 1 \u4E2A\uFF0C\u5176\u4F59\u6309\u8BCD\u5757\u6298\u7B97\uFF09\u3002\u5F53\u524D\u6280\u80FD\u4EC5\u624B\u52A8\u8C03\u7528\uFF0C\u4E0D\u968F\u6280\u80FD\u76EE\u5F55\u5E38\u9A7B\u7CFB\u7EDF\u63D0\u793A\u8BCD\uFF0C\u6B63\u6587\u4EC5\u5728\u8C03\u7528\u65F6\u52A0\u8F7D\u3002",
    "token.note.blocked": "token \u6570\u6309\u63D2\u4EF6\u89C4\u5219\u4F30\u7B97\uFF08CJK \u6BCF\u5B57\u7EA6 1 \u4E2A\uFF0C\u5176\u4F59\u6309\u8BCD\u5757\u6298\u7B97\uFF09\u3002\u5F53\u524D\u6280\u80FD\u4E0D\u53EF\u8C03\u7528\u6216\u8C03\u7528\u7B56\u7565\u65E0\u6548\uFF0C\u4E0D\u968F\u6280\u80FD\u76EE\u5F55\u5E38\u9A7B\u7CFB\u7EDF\u63D0\u793A\u8BCD\uFF0C\u6B63\u6587\u4EC5\u5728\u8C03\u7528\u65F6\u52A0\u8F7D\u3002",
    "token.note.disabled": "token \u6570\u6309\u63D2\u4EF6\u89C4\u5219\u4F30\u7B97\uFF08CJK \u6BCF\u5B57\u7EA6 1 \u4E2A\uFF0C\u5176\u4F59\u6309\u8BCD\u5757\u6298\u7B97\uFF09\u3002\u5F53\u524D\u6280\u80FD\u672A\u542F\u7528\uFF0C\u4E0D\u968F\u6280\u80FD\u76EE\u5F55\u5E38\u9A7B\u7CFB\u7EDF\u63D0\u793A\u8BCD\uFF0C\u6B63\u6587\u4EC5\u5728\u8C03\u7528\u65F6\u52A0\u8F7D\u3002",
    "token.note.shadowed": "token \u6570\u6309\u63D2\u4EF6\u89C4\u5219\u4F30\u7B97\uFF08CJK \u6BCF\u5B57\u7EA6 1 \u4E2A\uFF0C\u5176\u4F59\u6309\u8BCD\u5757\u6298\u7B97\uFF09\u3002\u5F53\u524D\u6280\u80FD\u5DF2\u88AB\u66F4\u9AD8\u4F18\u5148\u7EA7\u7684\u540C\u540D\u6280\u80FD\u8986\u76D6\uFF0C\u4E0D\u968F\u6280\u80FD\u76EE\u5F55\u5E38\u9A7B\u7CFB\u7EDF\u63D0\u793A\u8BCD\uFF0C\u6B63\u6587\u4EC5\u5728\u8C03\u7528\u65F6\u52A0\u8F7D\u3002",
    "token.summaryLabel": "\u6A21\u578B\u53EF\u89C1\u6280\u80FD\u7684\u7B80\u4ECB token \u5408\u8BA1 \xB7 \u968F\u6280\u80FD\u76EE\u5F55\u5E38\u9A7B\u7CFB\u7EDF\u63D0\u793A\u8BCD \xB7 \u4F30\u7B97\u503C",
    "invocation.manualOnly": "\u4EC5\u624B\u52A8",
    "invocation.manualOnlyTip": "\u6A21\u578B\u4E0D\u53EF\u81EA\u52A8\u611F\u77E5\uFF1B\u804A\u5929\u6846\u8F93\u5165 / \u53EF\u624B\u52A8\u8C03\u7528",
    "detail.invocation": "\u8C03\u7528\u65B9\u5F0F",
    "detail.policy.all": "\u6A21\u578B + \u624B\u52A8",
    "detail.policy.manualOnly": "\u4EC5\u624B\u52A8\u8C03\u7528\uFF08disable-model-invocation: true\uFF09",
    "detail.policy.blocked": "\u4E0D\u53EF\u8C03\u7528",
    "skill.editNote": "\u7F16\u8F91\u5907\u6CE8",
    "note.title": "\u81EA\u5B9A\u4E49\u7B80\u4ECB / \u5907\u6CE8",
    "note.label": "\u5907\u6CE8\u5185\u5BB9",
    "note.placeholder": "\u8BB0\u5F55\u8FD9\u4E2A\u6280\u80FD\u662F\u5E72\u561B\u7684\u3001\u4EC0\u4E48\u65F6\u5019\u7528\u2026",
    "note.help": "\u4FDD\u5B58\u5728\u63D2\u4EF6\u5185\u90E8\u663E\u793A\u5C42\uFF0C\u4E0D\u4FEE\u6539\u539F SKILL.md\u3002\u6E05\u7A7A\u53EF\u8FD8\u539F\u4E3A\u539F\u7B80\u4ECB\u3002",
    "note.clear": "\u6E05\u7A7A",
    "note.updated": "\u5DF2\u66F4\u65B0\u300C{name}\u300D\u7684\u81EA\u5B9A\u4E49\u7B80\u4ECB\u3002",
    "note.cleared": "\u5DF2\u6E05\u9664\u300C{name}\u300D\u7684\u81EA\u5B9A\u4E49\u7B80\u4ECB\u3002",
    "error.note.root": "\u6280\u80FD\u6765\u6E90\u4E0D\u5B58\u5728: {root}",
    "error.note.tooLarge": "\u81EA\u5B9A\u4E49\u7B80\u4ECB\u8FC7\u957F\uFF08\u6700\u591A {max} \u4E2A\u5B57\u7B26\uFF09",
    "create.title": "\u521B\u5EFA\u6280\u80FD",
    "create.name": "\u540D\u79F0",
    "create.name.placeholder": "\u4F8B\u5982 code-review-helper",
    "create.description": "\u7B80\u4ECB",
    "create.description.placeholder": "\u4E00\u53E5\u8BDD\u8BF4\u660E\u4EC0\u4E48\u65F6\u5019\u4F7F\u7528",
    "create.body": "\u6B63\u6587\uFF08Markdown\uFF09",
    "create.body.placeholder": "\u5199\u4E0B\u6280\u80FD\u8981\u9075\u5FAA\u7684\u6307\u4EE4\u3001\u6B65\u9AA4\u548C\u8FB9\u754C\u2026",
    "create.chat.note": "\u521B\u5EFA\u7684\u6280\u80FD\u4E0D\u4F1A\u6302\u4ED3\u5E93\u66F4\u65B0\uFF0C\u4E5F\u4E0D\u4F1A\u4FEE\u6539\u539F\u6587\u4EF6\u3002",
    "import.title": "\u5BFC\u5165\u6280\u80FD",
    "upload.drop.title": "\u62D6\u62FD\u6280\u80FD\u5230\u6B64\u5904",
    "upload.drop.copy": "\u652F\u6301 .zip\u3001\u6280\u80FD\u6587\u4EF6\u5939\u6216\u5355\u4E2A SKILL.md",
    "upload.selected.one": "{count} \u4E2A\u6587\u4EF6 \xB7 {size}",
    "upload.selected.other": "{count} \u4E2A\u6587\u4EF6 \xB7 {size}",
    "upload.remove": "\u79FB\u9664\u6240\u9009\u5185\u5BB9",
    "upload.requirements": "\u6587\u4EF6\u8981\u6C42",
    "upload.requirement.skill": "\u538B\u7F29\u5305\u6216\u6587\u4EF6\u5939\u9700\u5305\u542B SKILL.md",
    "upload.requirement.frontmatter": "SKILL.md \u9700\u5305\u542B YAML \u683C\u5F0F\u7684\u6280\u80FD\u540D\u79F0\u548C\u63CF\u8FF0",
    "upload.requirement.copy": "\u5BFC\u5165\u65F6\u590D\u5236\u5B8C\u6574\u5185\u5BB9\uFF0C\u4E0D\u4FEE\u6539\u539F\u59CB\u6765\u6E90",
    "upload.importing": "\u6B63\u5728\u5B89\u88C5\u2026",
    "status.selected": "\u5DF2\u9009\u62E9",
    "select.file.invalid": "\u8BF7\u9009\u62E9 .zip \u6216\u5355\u4E2A SKILL.md\u3002",
    "select.folder.invalid": "\u6240\u9009\u6587\u4EF6\u5939\u4E2D\u6CA1\u6709\u627E\u5230 SKILL.md\u3002",
    "error.browse.absolute": "\u76EE\u5F55\u8DEF\u5F84\u5FC5\u987B\u662F\u7EDD\u5BF9\u8DEF\u5F84\uFF1A{path}",
    "error.browse.unreadable": "\u65E0\u6CD5\u8BFB\u53D6\u76EE\u5F55\uFF1A{path}",
    "error.browse.notDirectory": "\u4E0D\u662F\u76EE\u5F55\uFF1A{path}",
    "trash.empty": "\u56DE\u6536\u7AD9\u4E3A\u7A7A\u3002",
    "trash.deletedAt": "\u5220\u9664\u4E8E {time}",
    "trash.source": "\u6765\u6E90\uFF1A{source}",
    "confirm.trash.title": "\u79FB\u5230\u56DE\u6536\u7AD9\uFF1F",
    "confirm.trash.desc": "\u201C{name}\u201D\u5C06\u4ECE\u5F53\u524D\u6280\u80FD\u6765\u6E90\u79FB\u5165\u56DE\u6536\u7AD9\uFF0C\u4E4B\u540E\u53EF\u4EE5\u6062\u590D\u5230\u539F\u4F4D\u7F6E\u3002",
    "confirm.delete.title": "\u6C38\u4E45\u5220\u9664\uFF1F",
    "confirm.delete.desc": "\u201C{name}\u201D\u5C06\u4ECE\u56DE\u6536\u7AD9\u6C38\u4E45\u5220\u9664\uFF0C\u65E0\u6CD5\u6062\u590D\u3002",
    "result.created": "\u5DF2\u521B\u5EFA\u6280\u80FD\uFF1A{name}",
    "result.imported": "\u5BFC\u5165\u5B8C\u6210\uFF1A{names}",
    "result.importPartial": "\u5DF2\u5BFC\u5165\uFF1A{imported}\uFF1B\u5DF2\u8DF3\u8FC7\u540C\u540D\u6280\u80FD\uFF1A{skipped}",
    "result.importSkipped": "\u672A\u5BFC\u5165\u4EFB\u4F55\u6280\u80FD\uFF1B\u5DF2\u8DF3\u8FC7\u540C\u540D\u6280\u80FD\uFF1A{names}",
    "result.importEmpty": "\u672A\u5BFC\u5165\u4EFB\u4F55\u6280\u80FD\u3002",
    "result.importWarnings": "{result}\uFF1B\u8B66\u544A\uFF1A{warnings}",
    "result.restored": "\u5DF2\u6062\u590D\u6280\u80FD\uFF1A{name}",
    "result.trashed": "\u5DF2\u79FB\u5230\u56DE\u6536\u7AD9\uFF1A{name}",
    "result.deleted": "\u5DF2\u6C38\u4E45\u5220\u9664\uFF1A{name}",
    "result.updated": "\u72B6\u6001\u5DF2\u66F4\u65B0\u3002",
    "error.action": "\u64CD\u4F5C\u5931\u8D25\uFF1A{error}",
    "warning.scan.truncated": "\u6280\u80FD\u76EE\u5F55\u8F83\u5927\u6216\u5D4C\u5957\u8FC7\u6DF1\uFF0C\u90E8\u5206\u6280\u80FD\u672A\u663E\u793A\uFF1A{path}",
    "warning.state.invalid": "\u6280\u80FD\u7BA1\u7406\u5668\u72B6\u6001\u6587\u4EF6\u4E0D\u53EF\u8BFB\uFF1B\u6240\u6709\u6280\u80FD\u5DF2\u5B89\u5168\u505C\u7528\uFF0C\u4FEE\u590D\u6587\u4EF6\u524D\u4E0D\u4F1A\u8986\u76D6\u72B6\u6001\uFF1A{path}",
    "warning.backupUncleaned": "\u65E7\u7248\u672C\u5907\u4EFD\u672A\u6E05\u7406\uFF1A{path}\uFF08{error}\uFF09",
    "warning.project.missing": "\u5DE5\u4F5C\u533A\u76EE\u5F55\u4E0D\u5B58\u5728\uFF0C\u53EF\u80FD\u5DF2\u88AB\u79FB\u52A8\u6216\u5220\u9664\uFF1A{path}",
    "warning.project.unreadable": "\u65E0\u6743\u9650\u8BFB\u53D6\u5DE5\u4F5C\u533A\u76EE\u5F55\uFF1A{path}\uFF08{code}\uFF09",
    "warning.project.unavailable": "\u65E0\u6CD5\u4ECE\u5BBF\u4E3B\u8BFB\u53D6\u6D3B\u52A8\u5DE5\u4F5C\u533A\uFF0C\u9879\u76EE\u6280\u80FD\u672A\u663E\u793A\uFF1A{path}",
    "error.root.readonly": "\u8BE5\u6765\u6E90\u4E0D\u5141\u8BB8{action}",
    "error.root.unknown": "\u672A\u77E5\u6280\u80FD\u6765\u6E90\uFF1A{root}",
    "error.workspace.unregistered": "\u8BF7\u9009\u62E9\u5DF2\u767B\u8BB0\u7684\u5DE5\u4F5C\u533A\u3002",
    "error.workspace.unavailable": "\u5DE5\u4F5C\u533A\u76EE\u5F55\u4E0D\u53EF\u7528\uFF1A{path}",
    "error.root.unsafe": "\u9879\u76EE\u6280\u80FD\u76EE\u5F55\u4E0D\u5B89\u5168\uFF0C\u62D2\u7EDD\u5199\u5165\uFF1A{path}",
    "error.skill.notFound": "\u6280\u80FD\u4E0D\u5B58\u5728: {name}",
    "error.skill.linked": "\u76EE\u5F55\u94FE\u63A5\u4E0D\u80FD\u5220\u9664\u6216\u8986\u76D6\uFF1A{path}",
    "error.skill.noFrontmatter": "\u6280\u80FD\u7F3A\u5C11\u5B8C\u6574 frontmatter\uFF0C\u65E0\u6CD5{action}: {name}",
    "error.skill.notLoadable": "\u6280\u80FD\u7ED3\u6784\u4E0D\u5B8C\u6574\uFF0C\u65E0\u6CD5{action}: {name}",
    "error.source.notFound": "\u8DEF\u5F84\u4E0D\u5B58\u5728: {path}",
    "error.source.symlink": "\u4E0D\u652F\u6301\u5305\u542B\u7B26\u53F7\u94FE\u63A5\u7684 skill \u6765\u6E90: {path}",
    "error.source.unrecognized": "\u65E0\u6CD5\u8BC6\u522B\u7684 skill \u6765\u6E90: {path}",
    "error.source.tooDeep": "skill \u6765\u6E90\u76EE\u5F55\u5C42\u7EA7\u8D85\u8FC7 {depth} \u5C42: {path}",
    "error.import.overlap": "\u5BFC\u5165\u6765\u6E90\u4E0D\u80FD\u4E0E DSH \u6280\u80FD\u76EE\u5F55\u76F8\u540C\u3001\u5305\u542B\u6216\u4F4D\u4E8E\u5176\u4E2D",
    "error.import.emptySource": "\u76EE\u5F55\u4E0B\u672A\u627E\u5230\u4EFB\u4F55 skill \u6761\u76EE: {path}",
    "error.import.invalidName": "\u65E0\u6CD5\u751F\u6210\u5408\u6CD5 kebab-case \u540D\u79F0\uFF08\u539F\u59CB\u540D: {name}\uFF09",
    "error.import.duplicateName": "\u6279\u91CF\u6765\u6E90\u4E2D\u5B58\u5728\u591A\u4E2A\u540C\u540D\u6280\u80FD: {name}",
    "error.import.failed": "\u5BFC\u5165\u5931\u8D25",
    "error.import.rollbackFailed": "\u8986\u76D6\u5BFC\u5165\u56DE\u6EDA\u5931\u8D25\uFF0C\u5907\u4EFD\u4FDD\u7559\u5728: {path}\uFF08{error}\uFF09",
    "error.upload.path": "\u4E0A\u4F20\u5185\u5BB9\u5305\u542B\u975E\u6CD5\u8DEF\u5F84\uFF1A{path}",
    "error.upload.encoding": "\u4E0A\u4F20\u5185\u5BB9\u7F16\u7801\u65E0\u6548",
    "error.upload.empty": "\u4E0A\u4F20\u5185\u5BB9\u4E3A\u7A7A",
    "error.upload.tooMany": "\u4E0A\u4F20\u6587\u4EF6\u8FC7\u591A\uFF0C\u6700\u591A {limit} \u4E2A",
    "error.upload.tooLarge": "\u4E0A\u4F20\u5185\u5BB9\u8FC7\u5927\uFF0C\u9650\u5236\u4E3A {limit} \u5B57\u8282",
    "error.upload.archiveTooLarge": "ZIP \u538B\u7F29\u5305\u8FC7\u5927\uFF0C\u9650\u5236\u4E3A {limit} \u5B57\u8282",
    "error.upload.duplicate": "\u4E0A\u4F20\u5185\u5BB9\u5305\u542B\u91CD\u590D\u8DEF\u5F84\uFF1A{path}",
    "error.upload.zipInvalid": "ZIP \u538B\u7F29\u5305\u65E0\u6CD5\u89E3\u538B",
    "error.trash.notFound": "\u56DE\u6536\u7AD9\u6761\u76EE\u4E0D\u5B58\u5728: {id}",
    "error.trash.conflict": "\u65E0\u6CD5\u6062\u590D\uFF0C\u540C\u540D\u6280\u80FD\u5DF2\u5B58\u5728: {name}",
    "error.trash.invalid": "\u56DE\u6536\u7AD9\u6761\u76EE\u8DEF\u5F84\u975E\u6CD5: {id}",
    "error.trash.projectUnavailable": "\u539F\u9879\u76EE\u5F53\u524D\u4E0D\u5728\u6D3B\u52A8\u5DE5\u4F5C\u533A\u4E2D\uFF0C\u65E0\u6CD5\u6062\u590D\uFF1A{path}",
    "error.trash.rollbackFailed": "\u79FB\u5165\u56DE\u6536\u7AD9\u56DE\u6EDA\u5931\u8D25\uFF0C\u672A\u6062\u590D\u5185\u5BB9\u4FDD\u7559\u5728: {path}\uFF08{error}\uFF09",
    "error.state.invalid": "\u6280\u80FD\u7BA1\u7406\u5668\u72B6\u6001\u6587\u4EF6\u4E0D\u53EF\u8BFB\uFF0C\u5DF2\u62D2\u7EDD\u8986\u76D6\uFF1A{path}",
    "error.create.descriptionRequired": "\u6280\u80FD\u7B80\u4ECB\u4E0D\u80FD\u4E3A\u7A7A",
    "error.create.bodyRequired": "\u6280\u80FD\u6B63\u6587\u4E0D\u80FD\u4E3A\u7A7A",
    "error.create.tooLarge": "\u6280\u80FD\u5185\u5BB9\u8FC7\u957F",
    "error.create.conflict": "\u540C\u540D\u6280\u80FD\u5DF2\u5B58\u5728: {name}",
    "error.proto.forbidden": "\u7981\u6B62\u7684\u4FEE\u6539\u8BF7\u6C42\uFF08\u7F3A\u5C11\u5BA2\u6237\u7AEF\u6807\u8BB0\uFF09",
    "error.proto.contentType": "\u8BF7\u6C42\u4F53\u5FC5\u987B\u662F application/json",
    "error.proto.invalidParams": "\u8BF7\u6C42\u53C2\u6570\u65E0\u6548",
    "error.proto.bodyTooLarge": "\u8BF7\u6C42\u4F53\u8FC7\u5927",
    "error.proto.invalidJson": "\u8BF7\u6C42\u4F53\u4E0D\u662F\u5408\u6CD5 JSON",
    "error.proto.nonJson": "\u670D\u52A1\u7AEF\u8FD4\u56DE\u975E JSON \u54CD\u5E94\uFF08HTTP {status}\uFF09",
    "error.catalog.response": "\u76EE\u5F55\u8FD4\u56DE\u7684\u6570\u636E\u65E0\u6548\u6216\u8FC7\u5927\u3002",
    "diagnostic.frontmatter.missing": "\u7F3A\u5C11\u5B8C\u6574 YAML frontmatter",
    "diagnostic.name.missing": "frontmatter \u7F3A\u5C11 name",
    "diagnostic.name.invalid": "\u5BBF\u4E3B\u4E0D\u652F\u6301\u6B64\u6280\u80FD\u540D\u79F0\u683C\u5F0F\uFF08\u4EC5\u652F\u6301\u82F1\u6587\u5C0F\u5199\u5B57\u6BCD\u3001\u6570\u5B57\u4E0E\u8FDE\u5B57\u7B26\uFF09\uFF0C\u65E0\u6CD5\u542F\u7528\u3002\u5982\u9700\u8C03\u7528\uFF0C\u8BF7\u5728 SKILL.md frontmatter \u4E2D\u6307\u5B9A\u82F1\u6587 name\uFF08\u76EE\u5F55\u540D\u53EF\u4FDD\u7559\u4E2D\u6587\uFF09\uFF1A{name}",
    "diagnostic.description.missing": "frontmatter \u7F3A\u5C11 description",
    "diagnostic.invocation.invalid": "\u8C03\u7528\u7B56\u7565\u5B57\u6BB5\u503C\u65E0\u6548",
    "diagnostic.shadowed": "\u88AB\u66F4\u9AD8\u4F18\u5148\u7EA7\u6765\u6E90 {root} \u8986\u76D6",
    "action.enable": "\u542F\u7528",
    "action.disable": "\u505C\u7528",
    "action.create": "\u521B\u5EFA",
    "action.delete": "\u5220\u9664",
    "action.restore": "\u6062\u590D",
    "action.toggle": "\u542F\u7528\u6216\u505C\u7528",
    "btn.add": "\u6DFB\u52A0",
    "scope.user": "\u5168\u5C40\u6280\u80FD",
    "scope.project": "\u9879\u76EE\u6280\u80FD",
    "scope.trash": "\u56DE\u6536\u7AD9",
    "scope.label": "\u6280\u80FD\u7BA1\u7406\u89C6\u56FE",
    "scope.userHint": "\u8DE8\u9879\u76EE\u53EF\u7528\u3002\u542F\u505C\u4EC5\u5F71\u54CD DSH \u4E2D\u7684\u8C03\u7528\u3002",
    "scope.projectHint": "\u6309\u5DE5\u4F5C\u533A\u67E5\u770B\u9879\u76EE\u6280\u80FD\u3002\u542F\u505C\u4E0D\u4FEE\u6539\u5176\u4ED6 Agent \u7684\u6E90\u6587\u4EF6\u3002",
    "project.empty": "\u8FD8\u6CA1\u6709\u5DF2\u767B\u8BB0\u7684\u5DE5\u4F5C\u533A\u3002\u8BF7\u5148\u5728\u4FA7\u680F\u6DFB\u52A0\u5DE5\u4F5C\u533A\u3002",
    "workspace.unavailable": "\u76EE\u5F55\u4E0D\u53EF\u7528",
    "workspace.missing": "\u76EE\u5F55\u4E0D\u5B58\u5728",
    "workspace.unreadable": "\u65E0\u8BFB\u53D6\u6743\u9650",
    "workspace.noSkills": "\u8FD9\u4E2A\u5DE5\u4F5C\u533A\u8FD8\u6CA1\u6709\u6280\u80FD\u3002",
    "workspace.loading": "\u6B63\u5728\u8BFB\u53D6\u2026",
    "workspace.loadFailed": "\u8BFB\u53D6\u5931\u8D25\uFF1A{error}",
    "workspace.listFailed": "\u65E0\u6CD5\u8BFB\u53D6\u5DE5\u4F5C\u533A\u5217\u8868\uFF1A{error}",
    "filter.status": "\u8C03\u7528\u72B6\u6001",
    "filter.statusAll": "\u5168\u90E8\u72B6\u6001",
    "status.shadowedBy": "\u88AB {source} \u4E2D\u7684\u540C\u540D\u6280\u80FD\u8986\u76D6",
    "status.fallback.user": "\u5F53\u524D\u4F7F\u7528\u5168\u5C40 {source} \u526F\u672C\u3002",
    "status.fallback.project": "\u5F53\u524D\u4F7F\u7528\u9879\u76EE {source} \u526F\u672C\u3002",
    "root.copilot": "GitHub Copilot",
    "import.global": "\u5BFC\u5165\u6280\u80FD",
    "category.batchAssigned": "\u5DF2\u5C06 {count} \u4E2A\u6280\u80FD\u6DFB\u52A0\u5230\u201C{category}\u201D\u3002\u6587\u4EF6\u672A\u79FB\u52A8\u3002",
    "category.selectSkills": "\u6DFB\u52A0\u6280\u80FD\u5230\u201C{name}\u201D",
    "category.noAvailableSkills": "\u6CA1\u6709\u53EF\u6DFB\u52A0\u7684\u6280\u80FD",
    "category.addSkills": "\u6DFB\u52A0\u6280\u80FD",
    "root.dsh": "DSH",
    "root.agents": "\u516C\u5171 Agent",
    "root.ccswitch": "CC Switch",
    "root.projectDsh": "DSH",
    "root.projectAgents": "\u9879\u76EE Agent",
    "root.codex": "Codex",
    "root.claude": "Claude Code",
    "root.gemini": "Gemini",
    "root.opencode": "OpenCode",
    "root.cursor": "Cursor",
    "root.windsurf": "Windsurf",
    "root.windsurfUser": "Windsurf (\u7528\u6237\u76EE\u5F55)",
    "root.trae": "Trae",
    "root.traeCn": "Trae (\u56FD\u5185\u7248)",
    "root.openclaw": "OpenClaw",
    "root.clawdbot": "OpenClaw (\u65E7\u76EE\u5F55)",
    "root.roo": "Roo",
    "root.codebuddy": "CodeBuddy",
    "root.workbuddy": "WorkBuddy",
    "root.qoder": "Qoder",
    "root.qoderCn": "Qoder CN CLI",
    "root.lingma": "Qoder CN",
    "root.antigravity": "Google Antigravity",
    "preset.prefix": "\u9884\u8BBE: {name}",
    "root.preset": "\u9884\u8BBE\u6A21\u5F0F",
    "preset.cordis": "\u521B\u9020\u6A21\u5F0F",
    "preset.standard": "\u6807\u51C6\u6A21\u5F0F",
    "preset.ptc": "PTC \u6A21\u5F0F",
    "preset.minimal": "\u6781\u7B80\u6A21\u5F0F",
    "preset.readonlyRelative": "\u53EA\u8BFB\uFF08\u76F8\u5BF9\u8DEF\u5F84\uFF09",
    "preset.readonlyRelativeTitle": "\u9884\u8BBE\u76EE\u5F55\u914D\u7F6E\u4E3A\u76F8\u5BF9\u8DEF\u5F84\uFF0C\u4E3A\u9632\u5199\u504F\u6682\u4EC5\u63D0\u4F9B\u53EA\u8BFB\u6D4F\u89C8\uFF1B\u6539\u4E3A\u7EDD\u5BF9\u8DEF\u5F84\u540E\u53EF\u5F00\u653E\u5B8C\u6574\u7BA1\u7406",
    "group.label": "\u5206\u7EC4\u65B9\u5F0F",
    "group.bySource": "\u6309\u6765\u6E90\u76EE\u5F55",
    "group.byRepo": "\u6309\u6765\u6E90\u4ED3\u5E93",
    "group.hint": "\u5728\u6765\u6E90\u76EE\u5F55\u4E0B\u6309\u53EF\u6838\u67E5\u7684\u8BB0\u5F55\u518D\u5206\u300C\u4ED3\u5E93 \u2192 \u4ED3\u5E93\u5185\u76EE\u5F55\u300D\uFF1A\u5B89\u88C5\u8BB0\u5F55 \u2192 \u76EE\u5F55\u9501\u6587\u4EF6 \u2192 \u6280\u80FD\u5143\u6570\u636E\uFF1B\u6CA1\u6709\u8BB0\u5F55\u7684\u6807\u4E3A\u300C\u6765\u6E90\u672A\u77E5\u300D\uFF0C\u4E0D\u6309\u76EE\u5F55\u540D\u79F0\u731C\u6D4B\u3002",
    "group.provenanceCount": "{repos} \u4E2A\u6765\u6E90\u4ED3\u5E93 \xB7 {unknown} \u4E2A\u6280\u80FD\u6765\u6E90\u672A\u77E5",
    "group.unknownSource": "\u6765\u6E90\u672A\u77E5",
    "group.repoRoot": "\u4ED3\u5E93\u6839\u76EE\u5F55\uFF08\u672A\u5206\u76EE\u5F55\uFF09",
    "group.evidence.install": "\u5B89\u88C5\u8BB0\u5F55",
    "group.evidence.lock": "\u76EE\u5F55\u9501\u6587\u4EF6",
    "group.evidence.meta": "\u6280\u80FD\u5143\u6570\u636E",
    "group.evidence.root": "\u76EE\u5F55\u843D\u70B9",
    "group.openRepo": "\u6253\u5F00 {repo}",
    "group.noRepo": "\u6CA1\u6709\u53EF\u6838\u67E5\u7684\u4ED3\u5E93\u8BB0\u5F55\uFF0C\u6309\u6765\u6E90\u76EE\u5F55\u5F52\u7C7B\u3002"
  },
  en: {
    "summary.group.one": "{count} skill",
    "summary.group.other": "{count} skills",
    "format.locale": "en-US",
    "format.warningSeparator": "; ",
    "title": "Skills Manager",
    "desc": "Load and manage Agent Skills on this computer in one place.",
    "btn.create": "Create skill",
    "btn.add": "Add",
    "btn.refresh": "Refresh",
    "btn.cancel": "Cancel",
    "btn.close": "Close",
    "btn.detail": "View details",
    "btn.more": "More",
    "btn.trash": "Move to trash",
    "btn.restore": "Restore",
    "btn.delete.forever": "Delete forever",
    "btn.file.pick": "Choose file",
    "btn.folder.pick": "Choose folder",
    "btn.import.now": "Install",
    "btn.create.now": "Create skill",
    "btn.confirm": "Confirm",
    "status.enabled": "Enabled",
    "status.disabled": "Disabled",
    "status.invalid": "Needs attention",
    "status.shadowed": "Shadowed",
    "summary.total.one": "{count} skill",
    "summary.total.other": "{count} skills",
    "summary.enabled.one": "{count} enabled",
    "summary.enabled.other": "{count} enabled",
    "summary.disabled.one": "{count} disabled",
    "summary.disabled.other": "{count} disabled",
    "summary.invalid.one": "{count} diagnostic",
    "summary.invalid.other": "{count} diagnostics",
    "filter.workspace": "Workspace",
    "filter.source": "Source",
    "filter.all": "All sources",
    "filter.option": "{name} ({count})",
    "search": "Search",
    "search.placeholder": "Search skill names, descriptions or notes",
    "empty.search": "No matching skills.",
    "empty.source": "This source does not exist or has no skills yet.",
    "loading": "Loading skills\u2026",
    "note.missing": "No description provided",
    "skill.linked": "External directory link, read-only",
    "source.toggle": "Toggle source",
    "skill.toggle": "Toggle skill",
    "category.toggle": "Toggle category",
    "category.create": "New category",
    "category.uncategorized": "Uncategorized",
    "category.assign": "Move to {name}",
    "category.rename": "Rename",
    "category.delete": "Delete category",
    "category.note": "Categories stay in this source and do not move files.",
    "category.name": "Category name",
    "category.empty": "No skills yet. Use More on a skill to place it here.",
    "category.progress": "{count} \xB7 {enabled}/{usable} enabled",
    "category.created": "Added category \u201C{name}\u201D. No directory was created.",
    "category.renamed": "Renamed. Skill file names are unchanged.",
    "category.deleted": "Deleted category \u201C{name}\u201D. Skills returned to Uncategorized and were not trashed.",
    "category.assigned": "Moved {name} to \u201C{category}\u201D. The file was not moved.",
    "category.dragTip": "Drag to reorder or move to another category",
    "category.moved": "Updated the category or order for {name}.",
    "confirm.category.title": "Delete category?",
    "confirm.category.desc": "\u201C{name}\u201D will be removed. Its skills return to Uncategorized. Files are not moved.",
    "error.category.duplicate": "A category with this name already exists: {name}",
    "error.category.name": "Category name is required and must be at most 24 characters",
    "error.category.notFound": "Category not found",
    "error.category.root": "Skill source not found: {root}",
    "error.category.position": "Invalid skill ordering position",
    "error.category.target": "The target skill is not in the destination category",
    "detail.title": "Skill details",
    "detail.description": "Description",
    "detail.customNote": "Custom note",
    "detail.copyBody": "Copy body",
    "detail.copied": "Copied",
    "detail.copyFailed": "Copy failed",
    "token.badgeTip": "Description \u2248{description} tokens (always in the system prompt); body \u2248{body} tokens (loaded on invocation). Counts are estimates.",
    "token.badgeTip.manualOnly": "Description \u2248{description} tokens; body \u2248{body} tokens (manual only, not in system prompt). Counts are estimates.",
    "token.badgeTip.blocked": "Description \u2248{description} tokens; body \u2248{body} tokens (blocked). Counts are estimates.",
    "token.badgeTip.disabled": "Description \u2248{description} tokens; body \u2248{body} tokens (disabled, not in system prompt). Counts are estimates.",
    "token.badgeTip.shadowed": "Description \u2248{description} tokens; body \u2248{body} tokens (overridden by another copy, not in system prompt). Counts are estimates.",
    "token.detailLine": "Description \u2248{description} tokens \xB7 Body \u2248{body} tokens",
    "token.note": "Token counts are plugin estimates (about one per CJK character, word chunks elsewhere). The description stays in the system prompt catalog (only for model-invocable skills, capped at 500 characters per host limit); the body loads only when the skill is invoked.",
    "token.note.manualOnly": "Token counts are plugin estimates (about one per CJK character, word chunks elsewhere). This skill is manual only and is not loaded into the system prompt catalog; the body loads only when invoked.",
    "token.note.blocked": "Token counts are plugin estimates (about one per CJK character, word chunks elsewhere). This skill is blocked or has invalid invocation policy and does not stay in the system prompt catalog; the body loads only when invoked.",
    "token.note.disabled": "Token counts are plugin estimates (about one per CJK character, word chunks elsewhere). This skill is disabled and is not loaded into the system prompt catalog; the body loads only when invoked.",
    "token.note.shadowed": "Token counts are plugin estimates (about one per CJK character, word chunks elsewhere). This skill is overridden by a higher-priority copy and does not stay in the system prompt catalog; the body loads only when invoked.",
    "token.summaryLabel": "description tokens across model-invocable skills \xB7 always in the system prompt \xB7 estimate",
    "invocation.manualOnly": "Manual only",
    "invocation.manualOnlyTip": "Model cannot invoke automatically; manual invocation via / remains available",
    "detail.invocation": "Invocation",
    "detail.policy.all": "Model + Manual",
    "detail.policy.manualOnly": "Manual only (disable-model-invocation: true)",
    "detail.policy.blocked": "Blocked",
    "skill.editNote": "Edit note",
    "note.title": "Custom description / Note",
    "note.label": "Note",
    "note.placeholder": "Record what this skill does and when to use it\u2026",
    "note.help": "Saved in the plugin display layer without modifying SKILL.md. Clear to revert to original description.",
    "note.clear": "Clear",
    "note.updated": "Updated custom note for \u201C{name}\u201D.",
    "note.cleared": "Cleared custom note for \u201C{name}\u201D.",
    "error.note.root": "Skill source not found: {root}",
    "error.note.tooLarge": "Custom note is too long (maximum {max} characters)",
    "create.title": "Create skill",
    "create.name": "Name",
    "create.name.placeholder": "e.g. code-review-helper",
    "create.description": "Description",
    "create.description.placeholder": "One sentence describing when to use it",
    "create.body": "Body (Markdown)",
    "create.body.placeholder": "Write the instructions, steps, and boundaries\u2026",
    "create.chat.note": "Created skills are not linked to repository updates, and no source file is modified.",
    "import.title": "Import skill",
    "upload.drop.title": "Drop a skill here",
    "upload.drop.copy": "Supports .zip, a skill folder, or one SKILL.md",
    "upload.selected.one": "{count} file \xB7 {size}",
    "upload.selected.other": "{count} files \xB7 {size}",
    "upload.remove": "Remove selection",
    "upload.requirements": "File requirements",
    "upload.requirement.skill": "Archives and folders must contain SKILL.md",
    "upload.requirement.frontmatter": "SKILL.md must include a YAML name and description",
    "upload.requirement.copy": "Import copies all content and never modifies the source",
    "upload.importing": "Installing\u2026",
    "status.selected": "Selected",
    "select.file.invalid": "Choose a .zip archive or one SKILL.md.",
    "select.folder.invalid": "No SKILL.md was found in the selected folder.",
    "error.browse.absolute": "Folder path must be absolute: {path}",
    "error.browse.unreadable": "Could not read folder: {path}",
    "error.browse.notDirectory": "Not a folder: {path}",
    "trash.empty": "Trash is empty.",
    "trash.deletedAt": "Deleted {time}",
    "trash.source": "Source: {source}",
    "confirm.trash.title": "Move to trash?",
    "confirm.trash.desc": "\u201C{name}\u201D will move out of its current skill source and can be restored to the same location later.",
    "confirm.delete.title": "Delete forever?",
    "confirm.delete.desc": "\u201C{name}\u201D will be permanently deleted from trash and cannot be recovered.",
    "result.created": "Created skill: {name}",
    "result.imported": "Import complete: {names}",
    "result.importPartial": "Imported: {imported}; skipped existing skills: {skipped}",
    "result.importSkipped": "No skills were imported; existing skills were skipped: {names}",
    "result.importEmpty": "No skills were imported.",
    "result.importWarnings": "{result}; warnings: {warnings}",
    "result.restored": "Restored skill: {name}",
    "result.trashed": "Moved to trash: {name}",
    "result.deleted": "Permanently deleted: {name}",
    "result.updated": "Status updated.",
    "error.action": "Action failed: {error}",
    "warning.scan.truncated": "Some skills were not shown because the directory is too large or deeply nested: {path}",
    "warning.state.invalid": "The manager state file could not be read; all skills are disabled and state writes are blocked until it is repaired: {path}",
    "warning.backupUncleaned": "Old version backup was not cleaned up: {path} ({error})",
    "warning.project.missing": "The workspace directory does not exist and may have been moved or deleted: {path}",
    "warning.project.unreadable": "No permission to read the workspace directory: {path} ({code})",
    "warning.project.unavailable": "The active workspace could not be read from the host, so its project skills are hidden: {path}",
    "error.root.readonly": "This source does not allow {action}",
    "error.root.unknown": "Unknown skill source: {root}",
    "error.workspace.unregistered": "Select a registered workspace.",
    "error.workspace.unavailable": "Workspace directory is unavailable: {path}",
    "error.root.unsafe": "The project skill directory is unsafe, so the write was refused: {path}",
    "error.skill.notFound": "Skill not found: {name}",
    "error.skill.linked": "This directory link cannot be deleted or overwritten: {path}",
    "error.skill.noFrontmatter": "Skill lacks complete frontmatter, cannot {action}: {name}",
    "error.skill.notLoadable": "Skill structure is incomplete, cannot {action}: {name}",
    "error.source.notFound": "Path does not exist: {path}",
    "error.source.symlink": "Skill sources containing symbolic links are not supported: {path}",
    "error.source.unrecognized": "Unrecognized skill source: {path}",
    "error.source.tooDeep": "Skill source directory depth exceeds {depth} levels: {path}",
    "error.import.overlap": "Import source cannot be the same as, contain, or be inside the DSH skills directory",
    "error.import.emptySource": "No skill entries found in the directory: {path}",
    "error.import.invalidName": "Cannot generate a valid kebab-case name (original: {name})",
    "error.import.duplicateName": "Batch source contains duplicate skill names: {name}",
    "error.import.failed": "Import failed",
    "error.import.rollbackFailed": "Overwrite import rollback failed; backups kept at: {path} ({error})",
    "error.upload.path": "Upload contains an invalid path: {path}",
    "error.upload.encoding": "Upload encoding is invalid",
    "error.upload.empty": "Upload is empty",
    "error.upload.tooMany": "Too many uploaded files; maximum {limit}",
    "error.upload.tooLarge": "Upload is too large; limit {limit} bytes",
    "error.upload.archiveTooLarge": "ZIP archive is too large; limit {limit} bytes",
    "error.upload.duplicate": "Upload contains a duplicate path: {path}",
    "error.upload.zipInvalid": "ZIP archive could not be extracted",
    "error.trash.notFound": "Trash item not found: {id}",
    "error.trash.conflict": "Cannot restore because a skill with the same name exists: {name}",
    "error.trash.invalid": "Invalid trash item path: {id}",
    "error.trash.projectUnavailable": "The original project is not an active workspace, so this skill cannot be restored: {path}",
    "error.trash.rollbackFailed": "Move-to-trash rollback failed; unrecovered content was kept at: {path} ({error})",
    "error.state.invalid": "The manager state file could not be read, so overwriting it was refused: {path}",
    "error.create.descriptionRequired": "Skill description is required",
    "error.create.bodyRequired": "Skill body is required",
    "error.create.tooLarge": "Skill content is too large",
    "error.create.conflict": "A skill with the same name already exists: {name}",
    "error.proto.forbidden": "Forbidden mutation request (missing client marker)",
    "error.proto.contentType": "Content type must be application/json",
    "error.proto.invalidParams": "Invalid request parameters",
    "error.proto.bodyTooLarge": "Request body too large",
    "error.proto.invalidJson": "Invalid JSON request body",
    "error.proto.nonJson": "Server returned a non-JSON response (HTTP {status})",
    "error.catalog.response": "The catalog response is invalid or too large.",
    "diagnostic.frontmatter.missing": "Missing complete YAML frontmatter",
    "diagnostic.name.missing": "Frontmatter is missing name",
    "diagnostic.name.invalid": "Skill name format is not supported by host (lowercase letters, numbers and hyphens only), cannot be enabled. To invoke it, specify an English name in the SKILL.md frontmatter (directory name can remain unchanged): {name}",
    "diagnostic.description.missing": "Frontmatter is missing description",
    "diagnostic.invocation.invalid": "Invocation policy value is invalid",
    "diagnostic.shadowed": "Shadowed by higher-priority source {root}",
    "action.enable": "enable",
    "action.disable": "disable",
    "action.create": "create",
    "action.delete": "delete",
    "action.restore": "restore",
    "action.toggle": "enabling or disabling",
    "scope.user": "Global skills",
    "scope.project": "Project skills",
    "scope.trash": "Trash",
    "scope.label": "Skill manager views",
    "scope.userHint": "Available across projects. Toggles only affect invocation in DSH.",
    "scope.projectHint": "View project skills by workspace. Toggles do not modify other agents\u2019 source files.",
    "project.empty": "No registered workspaces yet. Add one in the sidebar first.",
    "workspace.unavailable": "Directory unavailable",
    "workspace.missing": "Directory missing",
    "workspace.unreadable": "No read permission",
    "workspace.noSkills": "No skills in this workspace yet.",
    "workspace.loading": "Loading\u2026",
    "workspace.loadFailed": "Failed to load: {error}",
    "workspace.listFailed": "Cannot read the workspace list: {error}",
    "filter.status": "Invocation status",
    "filter.statusAll": "All statuses",
    "status.shadowedBy": "Overridden by the same skill in {source}",
    "status.fallback.user": "Currently using the global {source} copy.",
    "status.fallback.project": "Currently using the project {source} copy.",
    "import.global": "Import skill",
    "category.batchAssigned": "Added {count} skills to \u201C{category}\u201D. Files were not moved.",
    "category.selectSkills": "Add skills to \u201C{name}\u201D",
    "category.noAvailableSkills": "No skills available to add",
    "category.addSkills": "Add skills",
    "root.dsh": "DSH skills",
    "root.agents": "Shared Agent",
    "root.ccswitch": "CC Switch",
    "root.projectDsh": "DSH skills",
    "root.projectAgents": "Project Agent",
    "root.codex": "Codex",
    "root.claude": "Claude Code",
    "root.gemini": "Gemini",
    "root.opencode": "OpenCode",
    "root.cursor": "Cursor",
    "root.copilot": "GitHub Copilot",
    "root.windsurf": "Windsurf",
    "root.windsurfUser": "Windsurf (User Home)",
    "root.trae": "Trae",
    "root.traeCn": "Trae CN",
    "root.openclaw": "OpenClaw",
    "root.clawdbot": "OpenClaw (Legacy)",
    "root.roo": "Roo",
    "root.codebuddy": "CodeBuddy",
    "root.workbuddy": "WorkBuddy",
    "root.qoder": "Qoder",
    "root.qoderCn": "Qoder CN CLI",
    "root.lingma": "Qoder CN",
    "root.antigravity": "Google Antigravity",
    "preset.prefix": "Preset: {name}",
    "root.preset": "Preset",
    "preset.cordis": "Creator Mode",
    "preset.standard": "Standard Mode",
    "preset.ptc": "PTC Mode",
    "preset.minimal": "Minimal Mode",
    "preset.readonlyRelative": "Read-only (relative path)",
    "preset.readonlyRelativeTitle": "Preset folder uses a relative path and stays read-only to prevent writing to the wrong directory; configure an absolute path to enable full management",
    "group.label": "Group by",
    "group.bySource": "Source directory",
    "group.byRepo": "Source repository",
    "group.hint": "Inside each source directory, verifiable records add a repository \u2192 directory hierarchy: install record \u2192 directory lock file \u2192 skill metadata; other sources are marked Unknown source. Directory names are not guessed.",
    "group.provenanceCount": "{repos} repositories \xB7 {unknown} skills with unknown source",
    "group.unknownSource": "Unknown source",
    "group.repoRoot": "Repository root (no category)",
    "group.evidence.install": "Install record",
    "group.evidence.lock": "Directory lock file",
    "group.evidence.meta": "Skill metadata",
    "group.evidence.root": "Directory fallback",
    "group.openRepo": "Open {repo}",
    "group.noRepo": "No verifiable repository record; grouped by source directory."
  }
};
var ROOT_PATH_LOCALES = {
  zh: {
    "rootPath.edit": "\u4FEE\u6539\u6280\u80FD\u76EE\u5F55",
    "rootPath.title": "\u4FEE\u6539\u300C{name}\u300D\u7684\u6280\u80FD\u76EE\u5F55",
    "rootPath.manage": "\u6765\u6E90\u76EE\u5F55",
    "rootPath.source": "\u6280\u80FD\u6765\u6E90",
    "rootPath.desc": "\u53EA\u6539\u672C\u63D2\u4EF6\u8BFB\u53D6\u7684\u4F4D\u7F6E\uFF0C\u4E0D\u79FB\u52A8\u4EFB\u4F55\u6587\u4EF6\u3002\u5916\u90E8\u6765\u6E90\u4ECD\u7136\u53EA\u8BFB\uFF1B\u8981\u8BA9\u8BE5 Agent \u81EA\u5DF1\u6362\u76EE\u5F55\uFF0C\u8BF7\u6539\u5B83\u81EA\u5DF1\u7684\u914D\u7F6E\u3002",
    "rootPath.label": "\u6280\u80FD\u76EE\u5F55\uFF08\u542B SKILL.md \u7684\u4E0A\u4E00\u7EA7\uFF09",
    "rootPath.placeholder": "\u4F8B\u5982 D:\\skills\\codex",
    "rootPath.browse": "\u6D4F\u89C8\u2026",
    "rootPath.pickUnavailable": "\u5F53\u524D\u73AF\u5883\u6CA1\u6709\u53EF\u7528\u7684\u76EE\u5F55\u9009\u62E9\u5668\uFF0C\u8BF7\u76F4\u63A5\u8F93\u5165\u8DEF\u5F84\u3002",
    "rootPath.reset": "\u6062\u590D\u9ED8\u8BA4",
    "rootPath.save": "\u4FDD\u5B58",
    "rootPath.custom": "\u81EA\u5B9A\u4E49",
    "rootPath.overrideTitle": "\u81EA\u5B9A\u4E49\u76EE\u5F55\uFF0C\u9ED8\u8BA4\uFF1A{path}",
    "rootPath.defaultHint": "\u9ED8\u8BA4\u76EE\u5F55\uFF1A{path}",
    "rootPath.saved": "\u5DF2\u66F4\u65B0\u300C{name}\u300D\u7684\u6280\u80FD\u76EE\u5F55\u3002",
    "rootPath.resetDone": "\u5DF2\u6062\u590D\u300C{name}\u300D\u7684\u9ED8\u8BA4\u76EE\u5F55\u3002",
    "error.rootPath.unsupported": "\u8BE5\u6280\u80FD\u6765\u6E90\u4E0D\u652F\u6301\u4FEE\u6539\u76EE\u5F55\uFF1A{root}",
    "error.rootPath.invalid": "\u6280\u80FD\u76EE\u5F55\u65E0\u6548\uFF1A{path}",
    "error.rootPath.absolute": "\u6280\u80FD\u76EE\u5F55\u5FC5\u987B\u662F\u7EDD\u5BF9\u8DEF\u5F84\uFF1A{path}",
    "error.rootPath.tooLong": "\u6280\u80FD\u76EE\u5F55\u8DEF\u5F84\u8FC7\u957F\uFF1A{path}",
    "error.rootPath.notFound": "\u6280\u80FD\u76EE\u5F55\u4E0D\u5B58\u5728\uFF1A{path}",
    "error.rootPath.notDirectory": "\u6280\u80FD\u76EE\u5F55\u4E0D\u662F\u6587\u4EF6\u5939\uFF1A{path}",
    "error.rootPath.overlap": "\u6280\u80FD\u76EE\u5F55\u4E0D\u80FD\u4E0E\u5176\u5B83\u6280\u80FD\u6765\u6E90\u91CD\u53E0\uFF1A{path}",
    "error.rootPath.reserved": "\u6280\u80FD\u76EE\u5F55\u4E0D\u80FD\u4E0E\u6280\u80FD\u7BA1\u7406\u5668\u7684\u72B6\u6001\u76EE\u5F55\u91CD\u53E0\uFF1A{path}",
    "warning.rootPath.invalid": "\u6280\u80FD\u76EE\u5F55\u914D\u7F6E\u9879\u65E0\u6548\uFF0C\u5DF2\u5FFD\u7565\uFF1A{path}",
    "warning.rootPath.corrupt": "\u6280\u80FD\u76EE\u5F55\u914D\u7F6E\u4E0D\u53EF\u8BFB\uFF0C\u5DF2\u4F7F\u7528\u9ED8\u8BA4\u76EE\u5F55\uFF1A{path}",
    "warning.rootPath.missing": "\u81EA\u5B9A\u4E49\u6280\u80FD\u76EE\u5F55\u4E0D\u5B58\u5728\uFF1A{path}",
    "customSource.title": "\u81EA\u5B9A\u4E49\u6765\u6E90",
    "customSource.add": "\u6DFB\u52A0\u6765\u6E90",
    "customSource.desc": "\u767B\u8BB0\u6E05\u5355\u5916\u7684 Agent \u6280\u80FD\u76EE\u5F55\uFF1A\u53EA\u8BFB\u53D6\uFF0C\u4E0D\u79FB\u52A8\u4E5F\u4E0D\u6539\u52A8\u7B2C\u4E09\u65B9\u6587\u4EF6\u3002\u4E5F\u53EF\u4EE5\u586B\u4EA7\u54C1\u603B\u76EE\u5F55\u70B9\u300C\u626B\u63CF\u5B50\u76EE\u5F55\u300D\uFF0C\u81EA\u52A8\u627E\u51FA\u5404\u5B50\u76EE\u5F55\u4E0B\u7684 skills\u3002",
    "customSource.path": "\u6280\u80FD\u76EE\u5F55\uFF08\u542B SKILL.md \u7684\u4E0A\u4E00\u7EA7\uFF09",
    "customSource.path.placeholder": "\u4F8B\u5982 D:\\tools\\my-agent\\skills",
    "customSource.label": "\u663E\u793A\u540D\uFF08\u7559\u7A7A\u5219\u7528\u76EE\u5F55\u540D\uFF09",
    "customSource.label.placeholder": "\u4F8B\u5982 My Agent",
    "customSource.scan": "\u626B\u63CF\u5B50\u76EE\u5F55",
    "customSource.scanning": "\u626B\u63CF\u4E2D\u2026",
    "customSource.scanResult": "\u5728 {path} \u4E0B\u627E\u5230 {count} \u4E2A\u6280\u80FD\u76EE\u5F55",
    "customSource.skillCount.one": "{count} \u4E2A\u6280\u80FD",
    "customSource.skillCount.other": "{count} \u4E2A\u6280\u80FD",
    "customSource.addOne": "\u6DFB\u52A0",
    "customSource.addAll": "\u5168\u90E8\u6DFB\u52A0",
    "customSource.added": "\u5DF2\u6DFB\u52A0 {count} \u4E2A\u81EA\u5B9A\u4E49\u6765\u6E90\u3002",
    "customSource.removed": "\u5DF2\u79FB\u9664\u8BE5\u81EA\u5B9A\u4E49\u6765\u6E90\u7684\u767B\u8BB0\u3002",
    "customSource.remove": "\u79FB\u9664\u767B\u8BB0",
    "customSource.registered": "\u5DF2\u767B\u8BB0",
    "customSource.conflict": "\u4E0E\u5DF2\u6709\u6765\u6E90\u91CD\u53E0",
    "error.customSource.unknown": "\u672A\u767B\u8BB0\u7684\u81EA\u5B9A\u4E49\u6765\u6E90\uFF1A{root}",
    "error.customSource.limit": "\u81EA\u5B9A\u4E49\u6765\u6E90\u6570\u91CF\u5DF2\u8FBE\u4E0A\u9650\uFF1A{limit}",
    "error.customSource.label": "\u81EA\u5B9A\u4E49\u6765\u6E90\u5FC5\u987B\u6709\u663E\u793A\u540D\uFF1A{path}",
    "error.customSource.empty": "\u6CA1\u6709\u8981\u6DFB\u52A0\u7684\u6280\u80FD\u6765\u6E90"
  },
  en: {
    "rootPath.edit": "Change skills folder",
    "rootPath.title": "Change the skills folder for {name}",
    "rootPath.manage": "Source folders",
    "rootPath.source": "Skill source",
    "rootPath.desc": "Only changes where this plugin reads skills. No files are moved. External sources stay read-only; to change the agent's own folder, update that agent's configuration.",
    "rootPath.label": "Skills folder (the parent of SKILL.md files)",
    "rootPath.placeholder": "e.g. D:\\skills\\codex",
    "rootPath.browse": "Browse\u2026",
    "rootPath.pickUnavailable": "No directory picker is available here; type the path instead.",
    "rootPath.reset": "Restore default",
    "rootPath.save": "Save",
    "rootPath.custom": "Custom",
    "rootPath.overrideTitle": "Custom folder; default: {path}",
    "rootPath.defaultHint": "Default folder: {path}",
    "rootPath.saved": "Updated the skills folder for {name}.",
    "rootPath.resetDone": "Restored the default folder for {name}.",
    "error.rootPath.unsupported": "This skill source does not support changing its folder: {root}",
    "error.rootPath.invalid": "Invalid skills folder: {path}",
    "error.rootPath.absolute": "The skills folder must be an absolute path: {path}",
    "error.rootPath.tooLong": "The skills folder path is too long: {path}",
    "error.rootPath.notFound": "The skills folder does not exist: {path}",
    "error.rootPath.notDirectory": "The skills folder is not a directory: {path}",
    "error.rootPath.overlap": "The skills folder must not overlap another skill source: {path}",
    "error.rootPath.reserved": "The skills folder must not overlap the manager's state folder: {path}",
    "warning.rootPath.invalid": "Ignored an invalid skills folder setting: {path}",
    "warning.rootPath.corrupt": "The skills folder settings could not be read; defaults are in use: {path}",
    "warning.rootPath.missing": "The custom skills folder does not exist: {path}",
    "customSource.title": "Custom sources",
    "customSource.add": "Add source",
    "customSource.desc": "Register skill folders for agents that are not in the built-in list. Read-only: nothing is moved or modified. You can also point at a product folder and scan for the skills folders inside it.",
    "customSource.path": "Skills folder (the parent of SKILL.md files)",
    "customSource.path.placeholder": "e.g. D:\\tools\\my-agent\\skills",
    "customSource.label": "Display name (empty uses the folder name)",
    "customSource.label.placeholder": "e.g. My Agent",
    "customSource.scan": "Scan subfolders",
    "customSource.scanning": "Scanning\u2026",
    "customSource.scanResult": "Found {count} skills folders under {path}",
    "customSource.skillCount.one": "{count} skill",
    "customSource.skillCount.other": "{count} skills",
    "customSource.addOne": "Add",
    "customSource.addAll": "Add all",
    "customSource.added": "Added {count} custom sources.",
    "customSource.removed": "Removed the custom source registration.",
    "customSource.remove": "Remove",
    "customSource.registered": "Registered",
    "customSource.conflict": "Overlaps an existing source",
    "error.customSource.unknown": "Unknown custom source: {root}",
    "error.customSource.limit": "Custom sources reached the limit: {limit}",
    "error.customSource.label": "A custom source needs a display name: {path}",
    "error.customSource.empty": "No skill sources to add"
  }
};
Object.assign(DICT.zh, ROOT_PATH_LOCALES.zh, managementLocales.zh, nacosLocales.zh, destinationLocales.zh, sidebarLocales.zh);
Object.assign(DICT.en, ROOT_PATH_LOCALES.en, managementLocales.en, nacosLocales.en, destinationLocales.en, sidebarLocales.en);
var CSS = destinationCss + sidebarEntryCss + `.dssm-section-card{box-sizing:border-box;display:flex;flex-direction:column;gap:12px;padding:18px 20px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg,16px);margin-bottom:16px}.dssm-sources{display:flex;flex-direction:column;gap:9px}.dssm-scope-tabs{display:grid!important;box-sizing:border-box!important;width:100%;height:32px!important;min-height:32px!important;max-height:32px!important;padding:2px!important;border-radius:var(--dsw-radius-sm,8px)!important;border:0.5px solid var(--dsw-alias-border-l2)!important;background:var(--dsw-alias-bg-layer-1)!important}.dssm-scope-tabs>span[aria-hidden="true"],.dssm-scope-tabs>[class*="indicator"]{width:calc((100% - 4px)/4)!important;inset:2px auto 2px 2px!important;border-radius:6px!important;border:0.5px solid var(--dsw-alias-border-l3,rgba(255,255,255,.12))!important;background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.08))!important;box-shadow:none!important}.dssm-scope-tabs [role=tab]{display:inline-flex!important;align-items:center!important;justify-content:center!important;gap:4px!important;height:28px!important;padding:0 6px!important;border-radius:6px!important;font-size:13px!important;line-height:20px!important;white-space:nowrap!important;color:var(--dsw-alias-label-secondary)!important;text-align:center!important;box-sizing:border-box!important;transition:color 150ms ease!important}.dssm-scope-tabs [role=tab]:hover{color:var(--dsw-alias-label-primary)!important}.dssm-scope-tabs [role=tab][aria-selected="true"]{color:var(--dsw-alias-label-primary)!important;font-weight:600!important}.dssm-scope-tabs [role=tab] svg{flex:none;display:block}.dssm-source-head{display:flex;align-items:center;gap:8px;min-width:0;padding:8px 12px}.dssm-source-toggle{display:flex;align-items:center;gap:8px;flex:1;min-width:0;overflow:hidden;padding:0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}.dssm-source-toggle:focus-visible{outline:var(--dsw-focus-ring-width,1px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px}.dssm-fold-chevron{flex:none;color:var(--dsw-alias-label-tertiary);transform:rotate(-90deg);transition:transform 160ms ease}.dssm-fold-chevron.is-open{transform:rotate(0deg)}@media (prefers-reduced-motion:reduce){.dssm-fold-chevron{transition:none}}.dssm-source-label{display:flex;align-items:center;gap:10px;min-width:0;flex:1}.dssm-drag-handle{cursor:grab;color:var(--dsw-alias-label-tertiary,#888);font-size:13px;line-height:1;display:inline-flex;align-items:center;justify-content:center;width:16px;height:22px;border-radius:var(--dsw-radius-sm,8px);flex-shrink:0;user-select:none;transition:color 0.15s}.dssm-skill-row:hover .dssm-drag-handle{color:var(--dsw-alias-label-secondary,#b9b9b9)}.dssm-drag-handle:active{cursor:grabbing}.dssm-cat.drag-over{border-color:var(--dsw-alias-brand-primary,#3b82f6);box-shadow:0 0 0 1px var(--dsw-alias-brand-primary,#3b82f6)}.dssm-skill-row.dragging{opacity:0.4;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-interactive-bg-hover,transparent))}.dssm-skill-row.drop-before{box-shadow:inset 0 2px 0 var(--dsw-alias-brand-primary,#3b82f6)}.dssm-skill-row.drop-after{box-shadow:inset 0 -2px 0 var(--dsw-alias-brand-primary,#3b82f6)}.dssm-skill-row{display:flex;align-items:center;gap:8px;margin:0;padding:11px 13px;border:0;border-top:0.5px solid var(--dsw-alias-border-l1,#3a3a3a);border-radius:0;background:transparent}.dssm-skill-copy{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}.dssm-skill-actions{display:flex;align-items:center;gap:8px;flex:none;flex-wrap:nowrap}.dssm-skill-desc{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary,#a0a0a0);font-size:12px;line-height:18px}.dssm-icon-danger{color:var(--dsw-alias-state-error-primary,#ef7272)}.dssm-skill-row .dssm-name{font-size:14px;font-weight:650;color:var(--dsw-alias-label-primary,#eeeeee)}.dssm-skill-actions{display:flex;align-items:center;gap:8px;flex:none}.dssm-source{overflow:hidden;border:0.5px solid var(--dsw-alias-border-l2,#494949);border-radius:var(--dsw-radius-xl,20px);background:transparent}.dssm-textarea{box-sizing:border-box;display:block;width:100%;min-height:160px;margin:0;padding:8px 12px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;resize:vertical}.dssm-textarea:focus,.dssm-textarea:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}.dssm-textarea[readonly]{resize:none}.dssm-source-title{font-size:14px;font-weight:650;white-space:nowrap;flex:none}.dssm-source-path{min-width:0;max-width:50%;margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary,#a0a0a0);font-size:11px}.dssm-source-actions{display:flex;flex:none;align-items:center;gap:8px;margin-left:12px}.dssm-cat{margin:0 10px 8px;border:0.5px solid var(--dsw-alias-border-l1,#3a3a3a);border-radius:var(--dsw-radius-lg,16px)}.dssm-cat-head{display:flex;align-items:center;gap:8px;min-height:40px;padding:0 8px 0 6px}.dssm-cat-main{display:flex;align-items:center;gap:8px;flex:1;min-width:0;min-height:36px;padding:4px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}.dssm-cat-title{font-size:14px;font-weight:700;display:inline-flex;align-items:center}.dssm-cat-note{margin:2px 16px 8px}.dssm-fallback{margin-top:4px;color:var(--dsw-alias-label-secondary,#b9b9b9)}.dssm-section{box-sizing:border-box;display:flex;width:100%;min-width:0;padding:2px 0 36px;container-type:inline-size;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary,#eeeeee);font-family:inherit}.dssm-head{display:flex;flex-direction:column;align-items:stretch;gap:16px}.dssm-title-block{min-width:0}.dssm-title-row{display:flex;align-items:center;gap:8px 12px;min-width:0;flex-wrap:wrap}.dssm-title{margin:0;font-size:24px;line-height:32px;font-weight:600;letter-spacing:-.4px;white-space:nowrap}.dssm-desc{margin:12px 0 0;color:var(--dsw-alias-label-tertiary,#a0a0a0);font-size:14px;line-height:22px}.dssm-upload-link:focus-visible,.dssm-file-remove:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,var(--dsw-alias-label-primary,#f2f2f2));outline-offset:2px}.dssm-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));overflow:hidden;border:0.5px solid var(--dsw-alias-border-l2,#494949);border-radius:var(--dsw-radius-lg,16px);background:var(--dsw-alias-bg-layer-1)}.dssm-stat{padding:4px 10px;border-right:0.5px solid var(--dsw-alias-border-l1,#3a3a3a);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#b9b9b9)}.dssm-stat:last-child{border-right:0}.dssm-stat strong{margin-right:4px;color:var(--dsw-alias-label-primary,#eeeeee);font-size:14px;font-weight:650}.dssm-filters{display:flex;align-items:center;gap:8px;flex-wrap:nowrap;width:100%!important;min-width:0;box-sizing:border-box}.dssm-filter-actions{display:flex;align-items:center;gap:8px;flex:none;margin-left:auto}.dssm-filters .dssm-search{flex:1 1 0;min-width:160px;max-width:none}.dssm-filters .dssm-source-filter,.dssm-filters .dssm-status-filter,.dssm-filters .dssm-project-filter,.dssm-filters .dssm-menu-select-wrap,.dssm-filters span[class*="_root_"],.dssm-filters .dssm-source-select-menu,.dssm-filters .dssm-menu-select-trigger{width:auto!important;min-width:0!important;display:inline-flex!important;flex:none}.dssm-field .dssm-menu-select-wrap,.dssm-destination-pair .dssm-menu-select-wrap,.dssm-destination-pair span[class*="_root_"]{display:flex!important;width:100%!important;min-width:0!important;height:auto!important;padding:0!important;margin:0!important;border:0!important;background:transparent!important}.dssm-destination-pair .dssm-menu-select-trigger,.dssm-form .dssm-menu-select-trigger{display:flex!important;width:100%!important;height:36px!important;border-radius:var(--dsw-radius-md,10px)!important;padding:0 12px!important;box-sizing:border-box!important}.dssm-source-select-menu{min-width:130px;max-width:280px}.dssm-menu-select-trigger{display:inline-flex;align-items:center;justify-content:space-between;gap:6px;height:32px;padding:0 10px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer;user-select:none;width:max-content;min-width:8em;transition:border-color 120ms ease,background 120ms ease}.dssm-menu-select-trigger:hover:not(:disabled){border-color:var(--dsw-alias-border-l3,#555)}.dssm-menu-select-trigger.is-open,.dssm-menu-select-trigger:focus-visible{border-color:var(--dsw-alias-brand-primary)!important;outline:var(--dsw-focus-ring-width,1px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary))!important;outline-offset:0!important}.dssm-menu-select-trigger:disabled{opacity:.5;cursor:default}.dssm-menu-select-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;text-align:left}.dssm-menu-select-arrow{color:var(--dsw-alias-label-secondary);flex-shrink:0}.dssm-count{color:var(--dsw-alias-label-tertiary,#a0a0a0);font-size:12px;white-space:nowrap;flex:none}.dssm-name{overflow-wrap:anywhere;font-size:13px;font-weight:570}.dssm-note{overflow-wrap:anywhere;margin-top:2px;color:var(--dsw-alias-label-secondary,#b9b9b9);font-size:11px;line-height:17px}.dssm-enabled{color:var(--dsw-alias-state-success-primary,#51b976);font-size:12px;white-space:nowrap}.dssm-disabled{color:var(--dsw-alias-state-warn-primary,#d49245);font-size:12px;white-space:nowrap}.dssm-shadowed{color:var(--dsw-alias-label-tertiary,#a0a0a0);font-size:12px;white-space:nowrap}.dssm-trash-count{padding:2px 7px;border-radius:999px;corner-shape:round;background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));color:var(--dsw-alias-label-secondary,#b9b9b9);font-size:11px}.dssm-empty{padding:25px 14px;color:var(--dsw-alias-label-tertiary,#a0a0a0);font-size:12px;text-align:center}.dssm-feedback{padding:9px 11px;border:0.5px solid var(--dsw-alias-border-l2,#494949);border-radius:var(--dsw-radius-lg,16px);color:var(--dsw-alias-label-secondary,#b9b9b9);font-size:12px}.dssm-warning{border-color:var(--dsw-alias-state-warn-primary,#d49245);color:var(--dsw-alias-state-warn-primary,#d49245)}.dssm-error{border-color:var(--dsw-alias-state-error-primary,#ef7272);color:var(--dsw-alias-state-error-primary,#ef7272)}.dssm-form,.dssm-field{display:flex;flex-direction:column}.dssm-form{gap:12px}.dssm-detail{display:flex;flex-direction:column;gap:12px;min-width:0}.dssm-detail .dssm-desc{margin:0}.dssm-field{gap:6px}.dssm-label{font-size:12px;color:var(--dsw-alias-label-secondary,#b9b9b9)}.dssm-help{margin:0;color:var(--dsw-alias-label-tertiary,#a0a0a0);font-size:11px;line-height:18px}.dssm-batch-list{display:flex;flex-direction:column;gap:6px;max-height:360px;overflow-y:auto;margin:12px 0;padding:2px}.dssm-batch-item{display:flex;align-items:center;gap:10px;padding:8px 12px;border:0.5px solid var(--dsw-alias-border-l1,#3a3a3a);border-radius:var(--dsw-radius-lg,16px);background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-interactive-bg-hover,transparent));cursor:pointer;user-select:none;transition:background 0.15s,border-color 0.15s}.dssm-batch-item:hover{background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-interactive-bg-hover,transparent));border-color:var(--dsw-alias-border-l2,#494949)}.dssm-batch-item.selected{border-color:var(--dsw-alias-brand-primary,#3b82f6);background:var(--dsw-alias-state-business-tertiary)}.dssm-batch-check{flex:none;gap:0!important;font-size:0;line-height:0}.dssm-batch-check>span,.dssm-batch-check>span *{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.dssm-batch-info{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}.dssm-batch-name-row{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}.dssm-batch-name{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#eee);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dssm-batch-cat-tag{font-size:10px;padding:1px 6px;border-radius:var(--dsw-radius-xs,4px);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary,#b9b9b9);white-space:nowrap;flex-shrink:0}.dssm-batch-desc{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary,#a0a0a0);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px}.dssm-modal-actions{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:8px}.dssm-form+.dssm-modal-actions{margin-top:18px;padding-top:14px;border-top:1px solid var(--dsw-alias-border-l2)}.dssm-hidden-input{display:none}.dssm-dropzone{box-sizing:border-box;display:flex;width:100%;min-height:170px;flex-direction:column;align-items:center;justify-content:center;gap:7px;padding:22px;border:1px dashed var(--dsw-alias-border-l3,#555555);border-radius:var(--dsw-radius-lg,16px);background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-interactive-bg-hover,transparent));color:var(--dsw-alias-label-secondary,#b9b9b9);transition:border-color 180ms ease,background 180ms ease}.dssm-dropzone:hover,.dssm-dropzone-active{border-color:var(--dsw-alias-brand-primary,var(--dsw-alias-label-primary,#f2f2f2));background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}.dssm-dropzone-title{color:var(--dsw-alias-label-primary,#eeeeee);font-size:14px;font-weight:620}.dssm-dropzone-copy{font-size:12px;line-height:18px;text-align:center}.dssm-upload-choices{display:flex;align-items:center;gap:7px}.dssm-upload-link,.dssm-file-remove{padding:0;border:0;background:transparent;font:inherit;font-size:12px;cursor:pointer}.dssm-upload-link{color:var(--dsw-alias-label-secondary,#b9b9b9)}.dssm-upload-link:hover{color:var(--dsw-alias-label-primary,#eeeeee);text-decoration:underline}.dssm-upload-link:disabled{opacity:.45;cursor:default}.dssm-upload-divider{color:var(--dsw-alias-label-tertiary,#a0a0a0);font-size:11px}.dssm-file{display:flex;align-items:center;gap:9px;padding:10px 11px;border:0.5px solid var(--dsw-alias-border-l2,#494949);border-radius:var(--dsw-radius-lg,16px);background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-interactive-bg-hover,transparent));color:var(--dsw-alias-label-primary,#eeeeee);font-size:12px}.dssm-file-kind{display:inline-flex;min-width:30px;height:24px;align-items:center;justify-content:center;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));color:var(--dsw-alias-label-secondary,#b9b9b9);font-size:9px;font-weight:700}.dssm-file-name{min-width:0;overflow:hidden;flex:1;text-overflow:ellipsis;white-space:nowrap}.dssm-file-meta{color:var(--dsw-alias-label-tertiary,#a0a0a0);font-size:11px;white-space:nowrap}.dssm-file-remove{width:24px;height:24px;color:var(--dsw-alias-label-secondary,#b9b9b9);font-size:18px}.dssm-upload-requirements{padding:1px 1px 0}.dssm-upload-requirements ul{display:flex;margin:7px 0 0;padding-left:18px;flex-direction:column;gap:5px;color:var(--dsw-alias-label-tertiary,#a0a0a0);font-size:11px;line-height:17px}.dssm-detail-path{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:14px;line-height:22px}.dssm-diag{font-size:14px;line-height:22px}.dssm-detail-path{padding:8px 10px;border-radius:var(--dsw-radius-lg,16px);background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-interactive-bg-hover,transparent));color:var(--dsw-alias-label-secondary,#b9b9b9);word-break:break-all}.dssm-diag{padding:8px 10px;border-left:2px solid var(--dsw-alias-state-warn-primary,#d49245);background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-interactive-bg-hover,transparent));color:var(--dsw-alias-label-secondary,#b9b9b9)}.dssm-trash-panel{display:flex;flex-direction:column;gap:10px}.dssm-trash-item{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:8px;padding:11px 13px;border:0.5px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));border-radius:var(--dsw-radius-xl,20px);background:transparent}.dssm-trash-main{min-width:0;display:flex;flex-direction:column;gap:6px}.dssm-trash-item .dssm-name{font-size:14px;line-height:20px;color:var(--dsw-alias-label-primary,inherit)}.dssm-trash-meta{display:flex;align-items:center;flex-wrap:wrap;gap:6px 12px;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary,#909090);overflow-wrap:anywhere}.dssm-trash-source{min-width:0;background:transparent;color:var(--dsw-alias-label-tertiary,#a0a0a0)}.dssm-trash-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
@container(max-width:400px){.dssm-source-path{display:none}}@media(max-width:760px){.dssm-summary{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:720px){.dssm-title-row{flex-wrap:wrap}}@container(max-width:520px){.dssm-trash-item{grid-template-columns:minmax(0,1fr)}.dssm-skill-row{flex-wrap:wrap}.dssm-skill-actions{width:100%;margin-inline-start:0;justify-content:flex-end}.dssm-trash-actions{justify-content:flex-end}.dssm-head{flex-direction:column}.dssm-summary{grid-template-columns:repeat(2,minmax(0,1fr))}.dssm-stat:nth-child(2){border-right:0}.dssm-stat:nth-child(n+3){border-top:0.5px solid var(--dsw-alias-border-l1,#3a3a3a)}.dssm-filters{flex-wrap:wrap}.dssm-filters .dssm-search{flex:1 1 100%;min-width:0;order:2}.dssm-filters .dssm-filter-actions{order:3;margin-left:auto}.dssm-filters .dssm-source-filter,.dssm-filters .dssm-status-filter,.dssm-filters .dssm-project-filter{flex:1 1 calc(50% - 4px);min-width:0;order:1}.dssm-filters .dssm-source-filter .dssm-menu-select-wrap,.dssm-filters .dssm-status-filter .dssm-menu-select-wrap,.dssm-filters .dssm-project-filter .dssm-menu-select-wrap{width:100%!important;display:flex!important}.dssm-filters .dssm-source-filter .dssm-menu-select-trigger,.dssm-filters .dssm-status-filter .dssm-menu-select-trigger,.dssm-filters .dssm-project-filter .dssm-menu-select-trigger{width:100%!important;min-width:0!important}}.dssm-row-state{display:flex;align-items:center;justify-content:flex-end;gap:8px}
.dssm-enable-switch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:999px;corner-shape:round;background:var(--dsw-alias-border-l3,#555);cursor:pointer}.dssm-enable-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary)}.dssm-enable-switch:disabled{cursor:default;opacity:.5}.dssm-enable-switch:focus-visible{outline:var(--dsw-focus-ring-width,1px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}.dssm-enable-switch-thumb{display:block;width:16px;height:16px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-label-primary-foreground,#fff);transition:transform 120ms ease;pointer-events:none}.dssm-enable-switch[aria-checked=false] .dssm-enable-switch-thumb{background:var(--dsw-alias-switch-thumb,#fff)}.dssm-enable-switch[aria-checked=true] .dssm-enable-switch-thumb{transform:translateX(16px)}
.dssm-icon-action{box-sizing:border-box;width:22px;min-width:22px;height:22px;padding:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-secondary,#b9b9b9);border-color:var(--dsw-alias-border-l2,#494949);border-style:solid;border-width:0.5px}.dssm-icon-action:not(:disabled):not(.dssm-icon-danger):hover{color:var(--dsw-alias-link,#4176e6)!important;border-color:var(--dsw-alias-link,#4176e6)!important}.dssm-icon-action.dssm-icon-danger{color:var(--dsw-alias-state-error-primary,#ef7272);border-color:var(--dsw-alias-state-error-primary,#ef7272)}.dssm-btn-danger:not(:disabled){color:var(--dsw-alias-state-error-primary,#ef7272)}
.dssm-root-path-actions{display:flex;flex-wrap:wrap;gap:8px}

.dssm-custom-sources{display:flex;flex-direction:column;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2)}
.dssm-custom-source-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dssm-custom-scan{display:flex;flex-direction:column;gap:6px}
.dssm-custom-candidate{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-1)}
.dssm-custom-candidate-text{display:flex;flex-direction:column;min-width:0}
.dssm-custom-candidate-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dssm-custom-candidate-meta,.dssm-custom-candidate-state{font-size:12px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dssm-custom-candidate-state{white-space:nowrap}
.dssm-source-custom{color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap}
.dssm-modal{max-height:100%}
.dssm-modal.dssm-modal-wide{width:min(760px,100%)!important;max-height:100%!important}
.dssm-modal-content{flex:1;min-height:0;overflow:hidden}
.dssm-modal-content>div:last-child{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable}
.dssm-detail-head{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}
.dssm-detail-head .dssm-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dssm-detail-head button{flex:none}
.dssm-detail-body{box-sizing:border-box;width:100%;font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",Menlo,monospace!important;font-size:13px!important;line-height:20px!important;resize:vertical!important}
.dssm-skill-desc.dssm-custom-note{color:var(--dsw-alias-label-primary,#fff);font-style:normal}
.dssm-desc.dssm-desc-secondary{color:var(--dsw-alias-label-tertiary);font-size:12px;margin-top:2px}
.dssm-prov-note{display:block;margin:0 0 6px 0}
.dssm-prov-badge{flex:none;border:1px solid var(--dsw-alias-border-secondary,#e2e2e2);border-radius:999px;padding:0 6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#666);white-space:nowrap}
.dssm-prov-repo-link{border:0.5px solid var(--dsw-alias-border-l2,#494949);text-decoration:none}
.dssm-invocation-badge{display:inline-flex;margin-left:6px;vertical-align:middle;flex:none}
.dssm-token-badge{display:inline-flex;align-items:center;margin-left:6px;vertical-align:middle;flex:none;padding:0 6px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));color:var(--dsw-alias-label-tertiary,#a0a0a0);font-family:ui-monospace,SFMono-Regular,Consolas,Menlo,monospace;font-size:11px;line-height:16px;white-space:nowrap}.dssm-token-badge:focus-visible{outline:var(--dsw-focus-ring-width,1px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px}
.dssm-detail-tokens{display:flex;flex-direction:column;gap:4px}
.dssm-token-line{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#b9b9b9);white-space:nowrap}
.dssm-token-note{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary,#a0a0a0)}
.dssm-token-summary{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}
.dssm-token-summary-badge{margin-left:0}
.dssm-token-summary-text{color:var(--dsw-alias-label-tertiary,#a0a0a0);font-size:11px;line-height:17px}
.dssm-detail-policy{display:flex;align-items:center;padding:6px 10px;border-radius:6px;background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.03));border:0.5px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08));font-size:12px;line-height:18px}
.dssm-detail-policy-item{display:flex;align-items:center;gap:6px}
.dssm-detail-policy-label{color:var(--dsw-alias-label-tertiary,#8c8c8c);flex:none}
.dssm-detail-policy-val{color:var(--dsw-alias-label-secondary,#ccc)}

`;
CSS += `.dssm-section-card:has(>.dssm-head){padding:0;margin-bottom:0;border:0;border-radius:0;background:transparent}.dssm-head{gap:6px}.dssm-title{font-size:18px;line-height:26px;letter-spacing:0}.dssm-desc{margin:4px 0 0;font-size:12px;line-height:18px}.dssm-title-row{gap:8px}.dssm-scope-tabs{flex:none}`;
function translateOrFallback(t, key, fallback, params) {
  var value = t(key, params);
  return typeof value === "string" && value !== key ? value : fallback;
}
function skillDeclaredInvocationKind(skill) {
  if (!skill) return "all";
  if (skill.invocationPolicyValid === false) return "none";
  if (skill.modelInvocable === false && skill.userInvocable !== false) return "manual";
  if (skill.modelInvocable === false && skill.userInvocable === false) return "none";
  return "all";
}
function isSkillEnabled(skill) {
  if (skill.enabled !== void 0) return skill.enabled === true;
  return !!(skill.invocationPolicyValid && skill.modelInvocable && skill.userInvocable && skill.managerEnabled !== false);
}
function countKey(key, count) {
  return key + (Number(count) === 1 ? ".one" : ".other");
}
function rootDisplayName(t, root4) {
  if (root4.kind === "preset" || root4.scope === "preset") {
    var rawName = root4.group || (root4.label || "").replace(/^预设:\s*/, "");
    var suffixMatch = rawName.match(/(\s+\(\d+\))$/);
    var suffix = suffixMatch ? suffixMatch[1] : "";
    var baseRaw = suffix ? rawName.slice(0, -suffix.length) : rawName;
    var presetKey = root4.presetId || (root4.key ? root4.key.replace(/^preset-/, "").replace(/-\d+$/, "") : "");
    var localizedName = translateOrFallback(t, "preset." + presetKey, baseRaw) + suffix;
    var formatted = t("preset.prefix", { name: localizedName });
    return typeof formatted === "string" && formatted !== "preset.prefix" ? formatted : "\u9884\u8BBE: " + localizedName;
  }
  var base = translateOrFallback(t, "root." + (root4.localeKey || root4.kind || root4.key), root4.label);
  return root4.projectName ? base + " \xB7 " + root4.projectName : base;
}
function normalizeSkillQuery(query) {
  return String(query == null ? "" : query).trim().toLowerCase();
}
function matchSkillQuery(skill, query) {
  var q = normalizeSkillQuery(query);
  if (!q) return true;
  var prov = skill.provenance;
  var kind = skillDeclaredInvocationKind(skill);
  var invocationLabels = kind === "manual" ? [DICT.zh["invocation.manualOnly"], DICT.en["invocation.manualOnly"], "manual only", "manual", "\u624B\u52A8", "\u4EC5\u624B\u52A8"] : [];
  return [
    skill.name,
    skill.declaredName,
    skill.description,
    skill.customNote,
    skill.kind,
    skill.kindLabel,
    skill.statusLabel,
    skill.rootKey,
    skill.rootLabel,
    prov ? prov.repo : null,
    prov ? prov.category : null,
    prov ? prov.path : null
  ].concat(invocationLabels).some(function(value) {
    return String(value == null ? "" : value).toLowerCase().includes(q);
  });
}
function filterSkills(list4, options) {
  var rootKey = options && options.rootKey != null ? options.rootKey : "";
  return list4.filter(function(skill) {
    return (!rootKey || skill.rootKey === rootKey) && matchSkillQuery(skill, options && options.query);
  });
}
function visibleSkillRoots(roots) {
  return (roots || []).filter(function(root4) {
    return root4.mutable || root4.overridden === true || root4.exists !== false;
  });
}
function skillStatus(skill) {
  return skill.shadowedBy ? "shadowed" : skill.loadable === false ? "invalid" : isSkillEnabled(skill) ? "enabled" : "disabled";
}
function countSkillStatuses(list4) {
  var summary = { total: list4.length, enabled: 0, disabled: 0, shadowed: 0, invalid: 0 };
  list4.forEach(function(row) {
    summary[skillStatus(row.skill)]++;
  });
  return summary;
}
function sumEnabledDescriptionTokens(list4) {
  return list4.reduce(function(total, row) {
    return skillStatus(row.skill) === "enabled" && row.skill.invocationPolicyValid !== false && row.skill.effectiveModelInvocable !== false && row.skill.modelInvocable !== false && typeof row.skill.descriptionTokens === "number" ? total + row.skill.descriptionTokens : total;
  }, 0);
}
function canToggleSource(root4) {
  return !!(root4 && root4.toggleable !== false && root4.kind !== "project-dsh");
}
function scopeSkillRoots(roots) {
  return visibleSkillRoots(roots).filter(function(root4) {
    if (root4.scope === "project") return false;
    return root4.mutable || root4.overridden === true || (root4.skills || []).length > 0;
  });
}
var MAX_UPLOAD_ARCHIVE_BYTES = 32 << 20;
var MAX_UPLOAD_ENTRY_BYTES = 32 << 20;
var MAX_UPLOAD_TOTAL_BYTES = 64 << 20;
var MAX_UPLOAD_ENTRIES = 1e3;
function uploadFilePath(file) {
  return String(file && (file._dssmPath || file.webkitRelativePath || file.name) || "").replace(/\\/g, "/");
}
function inspectUploadSelection(files) {
  var list4 = Array.from(files || []);
  if (!list4.length) return null;
  if (list4.length > MAX_UPLOAD_ENTRIES) return { error: { code: "error.upload.tooMany", params: { limit: MAX_UPLOAD_ENTRIES } } };
  var relative = list4.some(function(file) {
    return uploadFilePath(file).includes("/");
  });
  if (relative) {
    if (!list4.some(function(file) {
      return /(^|\/)skill\.md$/i.test(uploadFilePath(file));
    })) return { error: { code: "select.folder.invalid" } };
    var oversized = list4.find(function(file) {
      return Number(file.size || 0) > MAX_UPLOAD_ENTRY_BYTES;
    });
    if (oversized) return { error: { code: "error.upload.tooLarge", params: { limit: MAX_UPLOAD_ENTRY_BYTES } } };
    var total = list4.reduce(function(sum, file) {
      return sum + Number(file.size || 0);
    }, 0);
    if (total > MAX_UPLOAD_TOTAL_BYTES) return { error: { code: "error.upload.tooLarge", params: { limit: MAX_UPLOAD_TOTAL_BYTES } } };
    return { kind: "folder", name: uploadFilePath(list4[0]).split("/")[0], files: list4, count: list4.length, size: total };
  }
  if (list4.length !== 1) return { error: { code: "select.file.invalid" } };
  var name2 = String(list4[0].name || ""), lower = name2.toLowerCase();
  var size = Number(list4[0].size || 0);
  if (lower === "skill.md") return size > MAX_UPLOAD_ENTRY_BYTES ? { error: { code: "error.upload.tooLarge", params: { limit: MAX_UPLOAD_ENTRY_BYTES } } } : { kind: "skill", name: name2, files: list4, count: 1, size };
  if (lower.endsWith(".zip")) return size > MAX_UPLOAD_ARCHIVE_BYTES ? { error: { code: "error.upload.archiveTooLarge", params: { limit: MAX_UPLOAD_ARCHIVE_BYTES } } } : { kind: "zip", name: name2, files: list4, count: 1, size };
  return { error: { code: "select.file.invalid" } };
}
function bytesToBase64(buffer) {
  var bytes = new Uint8Array(buffer), binary = "", chunk = 32768;
  for (var i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  return btoa(binary);
}
function SkillSwitch(props) {
  return enableSwitch(props.on, props.label, props.disabled, props.onClick);
}
function hostButton(label, onClick, kind = "primary", disabled) {
  const variant = kind === "primary" ? "primary" : "outline";
  const className = kind === "danger" ? "dssm-btn-danger" : void 0;
  return h3(import_dsh_client_ui_primitives4.Button, { variant, className, disabled, onClick }, label);
}
function strokeIcon(d) {
  return h3("svg", { viewBox: "0 0 16 16", width: 16, height: 16, "aria-hidden": true, focusable: "false" }, h3("path", { d, fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" }));
}
function moreIcon() {
  return h3("svg", { viewBox: "0 0 16 16", width: 16, height: 16, "aria-hidden": true, focusable: "false" }, [3.5, 8, 12.5].map(function(cx) {
    return h3("circle", { key: cx, cx, cy: 8, r: 1.15, fill: "none", stroke: "currentColor", strokeWidth: 1.5 });
  }));
}
function iconButton(label, icon, onClick, danger, disabled) {
  return h3(import_dsh_client_ui_primitives4.Button, { variant: "outline", size: "sm", className: "dssm-icon-action" + (danger ? " dssm-icon-danger" : ""), disabled, "aria-label": label, title: label, icon, style: { width: 22, minWidth: 22, height: 22, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: "var(--dsw-radius-sm, 8px)" }, onClick });
}
function filterActionButton(label, icon, onClick, disabled) {
  return h3(import_dsh_client_ui_primitives4.Button, {
    className: "dssm-icon-action",
    variant: "outline",
    size: "sm",
    disabled,
    "aria-label": label,
    title: label,
    icon,
    style: {
      width: 22,
      minWidth: 22,
      height: 22,
      padding: 0,
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      borderRadius: "var(--dsw-radius-sm, 8px)"
    },
    onClick
  });
}
function enableSwitch(on, label, disabled, onToggle) {
  return h3("button", {
    type: "button",
    role: "switch",
    "aria-checked": on,
    "aria-label": label,
    disabled,
    className: "dssm-enable-switch",
    onClick: function(event) {
      if (event && typeof event.stopPropagation === "function") event.stopPropagation();
      onToggle();
    }
  }, h3("span", { className: "dssm-enable-switch-thumb", "aria-hidden": "true" }));
}
var DSH_ICON_B64 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAhKSURBVFhHrZd5bBTXHcdR/6iav5r2zx4q2NjG9q69u/b6Wts4xkaEcCotzQUhhZJSEM1BAkmEqrQEQRCKUm4IRCRgikOgCbRFSlSaQBraSEVKQ8CAMYcMe87xZmfmzZvZ+Va/t15jw+K2Un/SVzN7zPt93vsd8964cUMG4Bsj7r/Z39//7bNnz97//xCNRWMW8zXqC03TSjnnW4QQF4UQuuMIxh3BHC4Y3RfEHee2+GjZxaXbtnPR4nxLQtNKR0EUbmzb7nJdN4O8+UNXeeP7xeQjV1ButLwiyg2N6TgiYxh21ygIXdfLPM9L0B9E3vxickjOnXJ8PlJ8tOzREtKH6yaSyWTZcAgcx9lccO66LsaSIIliEnAKckaL/BZk23kIzp3N0vnJkye/JYQ4PwSQu9PhvXQ3wNgQBRCbOzkZCuF+Tb7HUZYKIbQhAP9OR/eScAXNArbN5eAFCHLOHacoyBCATznBHaFSdRQA9HsBCOGA87yT298J5HJyItJyXm4YwHU9KYLgYgikAMAdWDaXAFQZ5LsAwIoBOI4js71gnucNO9Z0Hac/O4MDBw/jUv+ArAyyS5cH8M7+Xnmfn7UDm3NYtg3PyxGcT1cq2TEBaJZk16/fwFt79mHlqjVYsvRXWL7iBax+5TeYOfdRVNY04YmFv0AqlZYzJTt85BjqW6bio48/kQ5JhUn0X7mGC32X5Qfb5vcGKDg/1Ps+mtu6MaGsBiXlIUysimBiZQQlFWFUh5pRWduMp5c9B8uyJTTZwUNHUFkbQyDSjnUb3kQ6reCDYyewb/8hzJn3FHp6j0oA07SKA9Cyk/Uc7EVJeQ0qg1HU1sVGqBWh+jZ5DUcnS5DHFizB5f4B+dzfznyBSNMUhBs7UdfchYfmPI7qcJsEauucha/OXZAAlm3fDUBNha7nL/Qh2tSOYLgRkWgrQnUxBCPNCISbEQy35BUhxRCKtmNSoAEPzpyHC32XJMQzK19BeaBRAtTUTUZj6zREmrqwfuPvKCQ+dUvOi4SAcy4B1q57HeNLKxGqb0F1TRTlVREEahuHQFoQCBEIKYYaWomGdlTVNmH6rDwEhWPp8udRHYphctcszP7xfGzZvgeMGTIJCYDeKcMADncYJYrneb5pmnhwxlws+vkvcfxPJ9Bz8D2sfe11zJr7UwkTCDXKUARCTaiJtCAcbcfkKQ+hIdYlV6KjayY+PH4CL770a5RURPDiy69C0zRZPfnyFDInRwFYNmeuJ8vLv3UrjmAoih0735LLSaVHDyiKgoOHDqN72mxMCtQhVB+ToaDrzl1v46+fnsaMOY+gIhCVIKEGyo8Y3nhzmxyH27zQKWVNjAIwLc6E68HL5fyr166jJtyA1S+vke9C27ZlPyAQsqtXr+PJp55GRXWdXIlItB2PzV+E0599jr6+S2hspbi3oq7xAYQbOvD+0Q/zAJwXyjv/VhQjAAzTZpzaqOP6yVQaLa0PYPqMudB1hpznSXISDUKmKCqeeHIxKqoiiDS0oaomivUb35C/vbp2A0oqQqhv7kRH90z0XcwnJj0/EoDybhiAGRazuYusafumxbFg4WKUTKzERx//RT5MnazQoAoQ/VcG0DFlunROeUGhWLhoKbqmzZaJSmW64tlVcuVGdteiABozmWkLqHpW/rh9x2587wcTsPBnS6hnyxDQi4R6fT6Z8k3n6B+OYVJ1BLWRFlTXNqC0olb2jfqmDjS0dOKTT0/L/9HzYwKoepZlrTyAZQtcGbiGjs5uTCitwNZtu+Qg5lC36++/goGr1+R3ZKtWr0FpeVCWbDDcJENCML9dt1G24MLSjwmQUQ3GTAeKnvUVLQvXA/Yf+D3KyqsQCIaxZ+8+WUJk7x0+imhTG955t0euhqKqeHje4xhfWoVIfQyVwXosXf7s8IvsvwJIKozpBkdGzfqKbhIIKCTrN2xCaVklyiqqsfKFl/Dlv77Gmb9/Icv0RyWTsGzFc0gmU0in01i8ZBkqqyOoCtZh3qMLsL/nEOLxhIQcCXEXwMmzZ++PpxlTmI2UwvyMlgVJ1U0YJsfW7btRF23C9384HsHaCOoamlETjiIUacTEigA6u6dL0LWvbcCSpSvwk0fmo61jKmLt3Tj+xz//5xyQACmmZzQLyQzz04qBtJoXhcNyPJz+/B9Y8czzaI61oyoQQvmkACoqg6gNR1EXbUb3tJnY+/a79IaDpumgZkahGem4CEB+Q0IAt5K6llRNxFO6n8wwJDMGCiAphcG0XbAsx5dfXcDhIx9g5+692LFrDw709MoGpKpyQ5WvFJc6py91p/ORAK7r5rdktDGMZ4zzac3CzaSWu5XSkUgTRF4pxZBXgjFMAccFPB+0z5dX4fmwbAdG1qLtltwjkmgnJEZs40YAyJ7vukObUrJ4hm22BDAYV8XNpEYgiKfZbRCFViK/GqS0wpBRGRTVgMpMMMOCkbWRtWxYFm2/aLNKvYN6iIAr94rDAHK3Q0eB4XPBucs3ylKqmVANB4MJVQwmtdzNhObfTGp+PKn78bTuJ9KMwuOnFMNPq4afUQ0qWZ96h6abvm6YPjMs38haPnXUrGX7lsV92+byUMIdJ+fQkuRnn6DDkHReOB5dvDI4NZ7SM7YLZHTbTyhZkJJSJtKqCUpURbeg6jY0wwaVrp7lMLIODMsBNTMqX4u7oNbOhQdHeBBuDrlc/mgmhMhomjZ1pO/hm3+eO1d2bTC9dTCuXByMq2y0NHYzSdJZPK2zRFpn1D/SCmPUyBSNlGWanmXU2nWSYTKWtZghZV7Sjey2G5dvyJnf84RMtmnTpvt6T5z47vFTp74zlk79D9rU23tfMV//Btfumph3iobTAAAAAElFTkSuQmCC";
var WB_ICON_B64 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAf9SURBVFhHrVdrUJTXGd7RVNgb4BUvqKg1qTUx1WobTczFmmj8007bmU4nPzrtjG3TSWc6bWf6h/udZW9cNYpREYGxYpJJrWljEzKt2XO+2wJyUURAEASBXdjL9+0uuzyd8wErC5lJL7wzz+zZc973fd73Oec7365GM8+SbtVuTXDU2xJIQ2cCqZcTSAOWBmqujgRHg3WlcGXLfM6oGWjdr42kLmAk9VgKbBEasUv6cNG8kdQrBlL/yxhyI6n7hZHUYamwVWjEJ+4hSL5x/OhO06J1BgO5/CuVPNFRn2oktQEjuYylgnWwHW1+NzrkCbTLbpzouLnIx0guK2zLNQZHrc1AarFU2N/ykUraKU/grjyJe8okWvwuPOv8YJGvgdRaNHpS02kgl7BUsA21RYnvKx70Brx4EPDiumsAiZSRPvHVO2raNXpyUdaTGiwFUsUravfdigc9s+T9QR8eBv0YCsp4p8cRG+Oo8bMCsFT4Ux8fJX4Q8GEg6MNg0I9HIRkjIUWd2+W8GhOj0ZMLWAok0osQfKPoC3gXEMsYDSkYnwrAPRXE1bFerKRMgZk4jY6cx/+DVLEBv+t1oGlyaFZuH4aCfgyHZDwOKRibUuCaCmAiHIQnHII3HEK77MKbHR+r8RodeQ//C55vvoqzI53oVibVQ8a6/ipif2QKSiSM4HQEoekIPnYPQKMl1fhvsEG4BPNgSwzxjNz+BXLPkHfIbvQGPJBniaemI4hgGnOm0ZKz+E9xouM6eO9j9AU86A96o3IvJHb6RvFW102s4y9EY9n4tz3/UgufbxotOQOGBFqNdfx5dbwQOnIGv++7pXYyn3g45MfjkByV+64ygZPdTTBSptbiPAzJ/AX83d3/pICd0mX8xdWHFv8YbvvH1QPyT88Qrox1wzbUgj/2fYFTw22zcnsxGPRF5Z4jZuP8hwLW8uegJae/Egn0DFr9YzMFHLrdqH5pk8fRIbtwR3bjnjKB+8qk2vGDgGcR8Yzciip3w1gXdjlroSOno9CTU9DTLwE5FfU5fLsR4elpaJK4sxB9j1XiLmUC3coEegKTC/bZFyM3I6beYRxr/wBaNWkVdLQKelIFPa2CgVTCwD4XglSqPsyXxVQ+aoUmjlSh/FGL2nUssXcRMTtkzOc3PZ/BSFknldDRSugpI6yEkVYggVYgkZYjRXgXb3X9FdvFaiSpczPzbJ35spiNYjU0K0gljnd+iN4Ae6wWyj2v63AA1SNt2MhXI55UQksroKMV0NMKGNXE5UiiZVhJy7GKK4PDM6ju8X3FjRS+EqtpqTrPfJgvi9GTClZAhZrw5kT/lxKzQ9Yf8OBYx/uIdzDfCmjVYJakDAlq0lKspnaspXYkc3as5+wYDHqiJ900cAvr+Zk15rOKK0USKVXjNStIORi+f+ejqNyjqtwzXbMCjnVcQxwpRzwph46UQU/LYFSTsGQsqQ3rORs2cVakcFZs4SzIevBptAAlMoWDLWewmbNgI2dFMmfDGmpDErVD8zVSCoYVpBSfTz6MEk+Gg+r1WTXcrK7FkVJoiR06YoeBsyORWrGKs2ItZ8EGzoLNXAm28iXYwRdjp1CM3WIJuuXRaBEXRwTsEIpVn028GcnUgtXUygqwYw5HO65iIhyAJxyM3tv7Wi8hjtgRT23QERsM1IpEasFPu97HuREnDt8+hy28CTv4IjwjFGE3X4g9QgH2CgV4u6sueunWjFDsFgrxNF+EVN6EFM6EdZwZmqeIDfPBDqEcmUIgElaLWUGsiCNWxFMrdNQKI7Vgu1SpvkyY9QZc2CWU4BtCAZ4T87FPzMcBKQ8HxVwcknLwh+46lPTfwGFnobq2WyzATr4QW/libOBMrAAr5qM/6FGTs0uiW3FjhcOKOGqBllig5yxIJGZs5u2qSnNmfvgp9gh52C/m4qCUg8NSNl6VsnCEwZmljtncC2IO9oq52CUUYAdfiBSumBVglp8iFsyBPTZzbyumhJZaEU/M0BEzjLQESZwJazkT8gY+ixbgCwfxRosVB6VsvKySZuINKQPHnBk41pyhjtncYWcWDkjZeE7Iw04uH1kPPglplpOSzuXEDIbN0mn4IqFoYmb7W2sQR83Q0hIYONNsAUXYxpvQF3BF/WwDf8OLEus2E69L6TjuTMcJZxrebJ4ZH3Vm4BUpE9+RsrBXzId9sAn3lfGAZrnDZF1OSsBgGqIx5MwaxjoRR0ugo8UwUhNW0iKs45h8+fhZVx3Cs+/4k13v4SUpA685M/C6Mw3HnWk40TwDNj7qTMcrUgbe7jqPu/KwmvuG646k0Xxh2bSMFMvLiAnXxu8u5Fe3Y9/t84inxdDTIiTSIqzhCrCBL8BWPg8vt9pxpNWOvWI2vitmqkW8KqXhNWcaviel4YgzXR3/pM2Cf7jbonnZ3WAe+fyQ+u9omaPo58tIMaqGpRjyObvh7kY8KYKOK0ICLcQqmo9kPh8pfB62CTl4RsjGswKTNgsHxEy8IGXgRTEdL0npONqci/OPmhCYt7XsgF98LFyK+X+4zFF08gdd154c7QX2w7t/hpYrhIEWIokWYA2Xh/V8LjbzudjO5+BpIRvfFLOwh8/Et8QMfFvMRHpvI0ZCsb+ARkPeadPDpvIY8jlLdNpSr453cvcUV4A9AfNtKORFqlQGLS2AgeYjieZhNZeLZC4Hm/gcbOFzsE3IxteFTPy48wyc3ie/epRICL3KWPC6q118p6fx+fmc/wYNNEiugm3b7wAAAABJRU5ErkJggg==";
var CCSWITCH_ICON_B64 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAflSURBVFhH7Vd7UFNXGicPwiMSWsiCiCwiLM+UQkEeIYhS5JkQEoJJQCCIdKW7uLCjYot1akFueAZ5BJUBpLxBQKpjrUWrLq517bYznXG1aylV3gjyUJRX8u2cG0IRYXHc7R87s7/JnXPPd07O7zu/833nnKuh8X/8L4FAIBBVBV4usaOfBgG9Epe1/WpAXuClinhZ28u2/wrc4iR5ESfk3Ua2Nh6oTiQSSaikkInkpvdY5259EHjHzcLQDW8jEIhEogaRTCKQl4/zSsB1JpHIhAUSPWNj87jWZth76SIEHD3SgWxkEomCSh9rI58ZeRRAeSwUCF3kyKalSdR+YbgVlFoVL60xkYjPIjjzWOfuthaIrq+d1d9oaq1uPxhgnzZVLIYnRSIQuv5WrLY7bta12xNkFLs4zqssjZpcW1+fbhMYEK+po0NVt9mFBL8f/9lZQI+zcOfHantL4taLz0oioT+HP21nomeDbO62696ePOs+Cbd94FTKZlwVIkFjjQBdCCwShaLFyZbeTuy4BLzCgnuGlpZOyK5Lp2+IrKl6EtfWAvxC2T+RqvraZL27n4QOIgX+9qH/PdTPyZLKmGr3nJq74AnwlRd8Xci4oRp+DQXUs6fS6aaSM00Q29wIqJQ0N4E9OyQJtbH2JVXjKrQ2g749g+myXpcxdlwIs3IxHOM65pkbUTY8afKanj/HBLjkBV1Vzl10GvkN9F8S8RVSVO3Eegd7prC8bGj32TbYVVszl3DhPDAT95Zt8maFRzc1wJ72Vngr4ffFiZ5mcdPySBjJCwcp3yHrnoz58/yZ7aD4zBsG61yHzI0pG9F4miSCJirXXAakEYlExDvr0PTe9P8o7WLC+XbYVfPpXHx7G0ScOtEjOl0xGdNYB+zSE32tB9m3JvP48BDjzg7L2IqxUwEwU+cHj6u9nlqZaFssHVubokrJVZditVRh8PmpkpYmiGmsh9iGWoipq4ao6ipFdHUl3JFFwzAWquzLCoM+aahypDAE7udv7bcw0sJn7s2geX4gMj14Jdu+Y7jZdTDY7Y0AZCcRCXh6L0JNrkMhUdw3G7jYmdBszQyoZgZULQPUc6MjgxUmL/5J0NAI/No6RVB9MySVFykHsVBFnxSRc5W9GFc5ks+BUglDXiCxLuouc++FCyyAqyyADibANz7wl3yHays6oN7DT+5yr5qRo5QKn3mA8Z78kB766PuPOb1Xk1idVw5z/9FR8kdoL/qT8lN5qvK6bI9yGOMAcqBfysWfvizO/OTJYICWQJht2Qaz7SyAyyyAL5kw0rxlJIVvsg/nI74cC7gC3x4Ovg+nYmCyUIRvLKicOC6EySIxTMgEMJ7FgXEpGyawEBhZTi7lKvH3HLaivyBgZrzcD7pLPR5kRJsdcbLStl8kWikG1ArssFvvXxfvdbb9fZ+Oa/v9vvvucFD3/fTQ0YFs/twDLOx5TxZvri87HHqz+dCXxYN+3IFfnj5pmLJfyoOezLD5Hixs/sdPOGMXk3xvlojdKlP8bFOZloaeuBMrxdtKnlEpJB06lWJI0yZT4zzNYx5mcib7ETlOpJq9KgZwB5T9WVzoxbiKcZkApkuEMF6wE1dyqkQMU8WR8LRYBCwrujca+6U4UBvRgxQhL6QjQtJ2q5TuDM5TRP4IYyuHFuRHsqP3ASxU2YuFKQZyONAv8392fKdjcV64c+k3H/rf78vmTU8UCuFpcSSg+HLbZICfmCs6gLBUHocNNLvLKb5fPy8SwlCuACalbLieF6esKDqgHMQ4OHn18WTFD3liGJaG4tI/LgmCewWeP7/rqI/P1IKuuynkLRPOETbjWBzTYs9yjhewtCH5XZv9w7nhisf5EfC4QAi9RwPHTmKJPezaBigqSVOMZwbBQCZHkVhZDAcyku+OZgRO9+eEI2Xmp2t3AHy5DbLizbEXGdaAWpb8iHeKlCd3wUB2uPK5PBK+SPS6uo3lFMmtqBzn1dTCBdlexURmENzFBHNJ9WWwNTX5/H5fqwMzJSLowXizg3mhiqlW5jzc8IZOGeO6qSHFGI1LIRPxO8SqIBFV22VFrEctVEpgMFcwf9DfLg0lrl8mdnt3cwNEVlfB3/NiYCIzSHkzXwL7agogvSJtSmudNvV0jFvDtFwMDzPDZ0dLQ+DZebdZuOoFg02uA5tNtMzR2P/2PFBngpGe1m8OBdp/9I65gSuqeyTEyxPaW0BUXweSrCPfd6Wzx8ayuHA5N2okp/rQzFfn/gBMV9Mg1Pfbw0FdKOh6McHcWOWOebjmCdDJAnfbdS6ofc1TcXk6WrGYEeg6hs6BoMKinwJdLQWjOTwYzxfAMZFTblN5xIORKwLA3rOWof4MU5rDYC5/7lF+BIzmR8CZQ/YNHE993LmVdsAVgachQYNE1iRr7iw7MSRpaYb4tjNAtbHfEuNsIn5eGgXjBQLY+js6qzHD+XPo3A43ZOjiofKd52zKmy4Rwc3UHXdIC5yrpt2qWLghOYuF6eg0dBFFZKB6cZR75bQ8CoZy+XM0CoWaEWd6FP7qBVPntjyzWK9lpv67gwnNXl9Hk4be1feB14auwZvGau2SfK2ToTwGLv/Z9xaqsxz0POC6J3SdfvtHw19uP4uz/Y8/VtS3JPXHCIK7hcEWY5qWkbruZKnLoNPIBqp+qnVAxMvj6bWxlHwplnyWLdZf7PErAUm8lAyl1uuQ/wtXmaOWiiPiDAAAAABJRU5ErkJggg==";
var QODER_P0 = "M23.376 14.458v-4.056c0-2.304-1.003-4.154-2.748-5.075L11.612.574l-.046.086-.045.086c1.68.886 2.644 2.673 2.644 4.902v4.056a7.928 7.928 0 01-.014.454l-.005.061c-.005.081-.01.164-.018.245a4.897 4.897 0 01-.011.1l-.01.076c-.008.068-.015.135-.025.203l-.018.113-.01.058a9.99 9.99 0 01-.098.513l-.007.03a7.209 7.209 0 01-.074.294l-.024.086c-.027.099-.056.197-.087.296l-.027.085a9.592 9.592 0 01-.111.323l-.033.085-.018.046c-.032.082-.064.166-.098.248-.019.048-.04.096-.061.145l-.007.017a6 6 0 01-.084.187c-.024.056-.05.11-.077.165-.03.061-.058.122-.089.182a9.423 9.423 0 01-.176.332c-.03.056-.062.111-.094.167-.031.053-.062.108-.095.16-.033.055-.066.11-.101.164-.033.053-.065.104-.1.155-.034.055-.07.107-.111.169l-.099.144a15.193 15.193 0 01-.34.457c-.04.05-.08.102-.121.151l-.107.128-.007.008a6.987 6.987 0 01-.262.298l-.149.16-.116.12a9.562 9.562 0 01-.204.198l-.03.03-.072.069a9.05 9.05 0 01-.263.235l-.025.022-.029.026-.042.035a11.7 11.7 0 01-.22.18l-.07.055-.018.013a8.904 8.904 0 01-.194.146c-.029.02-.057.042-.086.063a7.7 7.7 0 01-.22.152l-.057.04a8.865 8.865 0 01-.293.185l-.062.037a10.424 10.424 0 01-.307.173l-.037.02-.196.103-.108.052-.012.006a6.196 6.196 0 01-.315.143c-.065.028-.13.054-.196.08l-.035.014-.086.034c-.07.026-.143.05-.215.075l-.039.014-.064.023a8.056 8.056 0 01-.323.097l-.63.173a7.285 7.285 0 01-.33.08l-.07.015c-.053.012-.104.023-.157.032l-.065.011-.085.015a2.332 2.332 0 01-.194.027l-.085.01a4.715 4.715 0 01-.16.018l-.034.003a4.861 4.861 0 01-.246.016h-.033a2.714 2.714 0 01-.155.005h-.106a3.384 3.384 0 01-.225-.007H4.86l-.15-.012-.066-.006a5.586 5.586 0 01-.187-.02l-.04-.005a5.14 5.14 0 01-.219-.035l-.054-.01a6.943 6.943 0 01-.347-.082l-.03-.008-.038-.01a5.034 5.034 0 01-.269-.086l-.063-.023a4.216 4.216 0 01-.188-.073l-.071-.031-.016-.007a4.959 4.959 0 01-.16-.074l-.026-.013a.164.164 0 00-.014-.007l-.671-.351.486.486h.016l8.995 4.742.093.048.03.014.02.01c.056.026.111.052.169.076l.016.008.073.032.195.076.022.008a.718.718 0 01.03.012l.014.004a4.693 4.693 0 00.323.1l.027.007c.073.02.147.038.22.055l.018.004.027.006.066.013.088.016c.075.014.15.026.226.038l.042.004c.064.009.128.016.193.022l.126.012.06.003.05.002.098.005c.046.002.094.002.14.003h.12c.05 0 .1-.002.161-.005h.033l.07-.004a6.17 6.17 0 00.184-.014l.033-.003a.753.753 0 00.058-.005l.108-.012.081-.01.08-.01.129-.021.082-.014.071-.012c.054-.01.107-.021.16-.033l.066-.013.059-.013c.096-.022.192-.046.287-.073l.63-.172a7.354 7.354 0 00.397-.122l.04-.015c.075-.025.149-.051.222-.078.032-.011.062-.024.093-.037l.03-.012c.067-.027.135-.054.2-.082l.128-.056.195-.09.021-.01.102-.05c.068-.034.135-.069.202-.105l.037-.02.073-.038c.08-.044.16-.092.24-.139l.026-.015a8.086 8.086 0 00.322-.2l.065-.045 1.98.902a1.748 1.748 0 002.472-1.59v-7.33l.004.004z";
var QODER_P1 = "M11.617.576a3.904 3.904 0 00-.093-.047c-.016-.009-.033-.016-.05-.024a5.854 5.854 0 00-.166-.077l-.09-.04a4.094 4.094 0 00-.194-.074c-.017-.006-.035-.015-.053-.02l-.013-.005a5.18 5.18 0 00-.277-.088l-.07-.019a4.034 4.034 0 00-.219-.053c-.015-.003-.03-.008-.044-.012L10.253.1l-.057-.011a5.177 5.177 0 00-.225-.036L9.928.047a5.972 5.972 0 00-.191-.022L9.669.02a1.33 1.33 0 00-.058-.005L9.515.009a4.058 4.058 0 00-.111-.005C9.354 0 9.304 0 9.254 0h-.109c-.052 0-.106.004-.16.004L8.884.01A5.32 5.32 0 008.7.022l-.083.006h-.008c-.05.005-.1.013-.15.019l-.12.014c-.056.008-.112.018-.169.028-.037.006-.074.011-.11.018a7.054 7.054 0 00-.572.133l-.63.172c-.111.031-.22.064-.33.1-.037.011-.072.025-.108.037a12.91 12.91 0 00-.345.126c-.067.027-.133.054-.2.083l-.128.055a11.916 11.916 0 00-.318.15 7.376 7.376 0 00-.311.163c-.082.045-.16.092-.24.14a9.424 9.424 0 00-.35.218l-.016.01-.06.04a9.242 9.242 0 00-.51.37 12.54 12.54 0 00-.315.254l-.043.034-.01.007-.045.041c-.09.078-.18.158-.268.24l-.106.101c-.07.067-.139.135-.207.204l-.056.054-.063.067-.153.164-.12.133-.148.17c-.024.03-.049.057-.073.086l-.043.053a5.96 5.96 0 00-.123.155l-.118.151c-.04.053-.08.106-.118.16l-.075.101-.038.056-.107.155-.11.164a9.91 9.91 0 00-.168.265c-.012.02-.023.043-.037.063a12.43 12.43 0 00-.192.335l-.09.168c-.019.034-.04.07-.057.105-.011.022-.02.043-.032.065l-.092.188-.08.167a19.15 19.15 0 00-.083.192c-.017.038-.035.076-.05.115-.008.016-.014.034-.021.051-.035.083-.067.167-.1.253l-.051.134c-.04.11-.077.22-.113.33l-.02.057c0 .002 0 .005-.002.007l-.008.026c-.032.1-.06.2-.09.301l-.023.089c-.027.1-.052.2-.075.301l-.007.03a7.63 7.63 0 00-.057.267l-.008.048c-.015.074-.026.148-.038.223L.082 8.4c-.011.078-.02.156-.029.234-.006.051-.013.103-.017.154a6.57 6.57 0 00-.02.26c-.003.044-.007.086-.009.13-.004.128-.007.257-.007.386v4.056c0 1.478.42 2.741 1.138 3.692A4.75 4.75 0 002.73 18.67l9.015 4.753c-1.656-.874-2.728-2.685-2.73-5.051v-4.056c0-.13.004-.26.01-.39.002-.043.006-.085.01-.128.005-.088.01-.174.019-.261l.017-.155c.01-.077.018-.155.029-.234l.026-.164c.013-.074.025-.15.039-.223.02-.105.04-.21.064-.313l.008-.031c.023-.1.048-.201.075-.301l.023-.088c.028-.1.058-.202.09-.302l.008-.025.021-.063c.036-.11.073-.22.113-.33l.052-.134c.031-.085.065-.169.1-.253.022-.056.047-.111.07-.166a13.856 13.856 0 01.164-.358c.03-.063.06-.126.092-.188l.088-.172a9.22 9.22 0 01.187-.338l.096-.164c.034-.057.069-.112.104-.168l.1-.159a10.49 10.49 0 01.567-.786l.123-.155.116-.139c.05-.057.098-.115.148-.171a14.092 14.092 0 01.272-.297 9.706 9.706 0 01.432-.425c.088-.083.177-.163.268-.241l.054-.048a10.08 10.08 0 01.553-.435l.092-.068c.075-.053.15-.105.226-.156.019-.013.038-.028.06-.04a9.18 9.18 0 01.362-.227c.08-.047.16-.094.241-.139l.11-.058a7.643 7.643 0 01.521-.256l.126-.056a7.509 7.509 0 01.546-.208l.107-.037c.11-.036.22-.069.33-.1l.63-.172c.095-.026.191-.05.287-.072l.097-.02c.062-.014.125-.029.187-.04l.114-.018c.055-.01.11-.02.166-.028.04-.006.08-.01.12-.014.053-.007.105-.014.157-.019l.083-.006c.061-.005.123-.01.184-.013.034-.003.067-.003.101-.004l.16-.006h.11a3.187 3.187 0 01.261.008l.153.01.067.007c.064.006.128.013.192.022l.043.005a5.232 5.232 0 01.281.047l.141.03c.073.016.146.035.218.053l.07.019c.094.026.187.055.278.087l.067.025a4.326 4.326 0 01.449.19l.143.072L11.617.576z";
var CODEX_D = "M6.13671 5.82399V4.30398C6.13671 4.17596 6.18431 4.07991 6.29527 4.01598L9.32406 2.256C9.73637 2.01602 10.228 1.90406 10.7353 1.90406C12.6382 1.90406 13.8434 3.3921 13.8434 4.97604C13.8434 5.088 13.8434 5.21602 13.8274 5.34404L10.6877 3.488C10.4975 3.37605 10.3071 3.37605 10.1168 3.488L6.13671 5.82399ZM13.209 11.7441V8.11195C13.209 7.88789 13.1138 7.72791 12.9236 7.61594L8.94344 5.27995L10.2437 4.5279C10.3547 4.46397 10.4499 4.46397 10.5609 4.5279L13.5896 6.28789C14.4619 6.79996 15.0484 7.88789 15.0484 8.94385C15.0484 10.1598 14.335 11.28 13.209 11.7441ZM5.20114 8.54404L3.90086 7.77608C3.78989 7.71215 3.7423 7.6161 3.7423 7.48808V3.96811C3.7423 2.25615 5.04259 0.960061 6.80278 0.960061C7.46883 0.960061 8.08714 1.18413 8.61056 1.58409L5.48672 3.40816C5.29649 3.52012 5.20129 3.68011 5.20129 3.90418L5.20114 8.54404ZM7.99999 10.176L6.13671 9.12005V6.8801L7.99999 5.82414L9.8631 6.8801V9.12005L7.99999 10.176ZM9.19719 15.0401C8.53113 15.0401 7.91282 14.816 7.3894 14.4161L10.5132 12.5919C10.7034 12.48 10.7987 12.3201 10.7987 12.096V7.45596L12.1149 8.22392C12.2258 8.28785 12.2734 8.3839 12.2734 8.51192V12.0319C12.2734 13.7438 10.9572 15.0401 9.19719 15.0401ZM5.43898 11.4721L2.41018 9.71211C1.53796 9.20003 0.95134 8.11211 0.95134 7.05615C0.95134 5.82414 1.68077 4.72016 2.80657 4.25611V7.9041C2.80657 8.12817 2.90177 8.28815 3.092 8.40012L7.05637 10.72L5.75609 11.4721C5.64513 11.5361 5.54993 11.5361 5.43898 11.4721ZM5.26465 14.0961C3.47278 14.0961 2.15658 12.736 2.15658 11.056C2.15658 10.928 2.17249 10.8 2.18826 10.672L5.3121 12.4961C5.50234 12.608 5.69273 12.608 5.88297 12.4961L9.8631 10.1762V11.6962C9.8631 11.8242 9.8155 11.9202 9.70454 11.9841L6.67574 13.7441C6.26344 13.9841 5.77199 14.0961 5.26465 14.0961ZM9.19719 16C11.1159 16 12.7174 14.624 13.0823 12.8C14.8582 12.3359 16 10.6559 16 8.944C16 7.82396 15.5243 6.73603 14.668 5.95201C14.7473 5.61598 14.7949 5.27995 14.7949 4.94407C14.7949 2.65612 12.9554 0.944002 10.8305 0.944002C10.4025 0.944002 9.99013 1.00794 9.57782 1.15201C8.86416 0.447988 7.88099 0 6.80278 0C4.88403 0 3.28254 1.37593 2.91768 3.19999C1.14173 3.66404 0 5.34404 0 7.056C0 8.17604 0.475669 9.26397 1.33197 10.048C1.25269 10.384 1.20509 10.72 1.20509 11.0559C1.20509 13.3438 3.04456 15.0559 5.16946 15.0559C5.59753 15.0559 6.00984 14.9921 6.42215 14.848C7.13565 15.552 8.11882 16 9.19719 16Z";
var CURSOR_D = "M22.106 5.68L12.5.135a.998.998 0 00-.998 0L1.893 5.68a.84.84 0 00-.419.726v11.186c0 .3.16.577.42.727l9.607 5.547a.999.999 0 00.998 0l9.608-5.547a.84.84 0 00.42-.727V6.407a.84.84 0 00-.42-.726zm-.603 1.176L12.228 22.92c-.063.108-.228.064-.228-.061V12.34a.59.59 0 00-.295-.51l-9.11-5.26c-.107-.062-.063-.228.062-.228h18.55c.264 0 .428.286.296.514z";
var WINDSURF_D = "M23.78 5.004h-.228a2.187 2.187 0 00-2.18 2.196v4.912c0 .98-.804 1.775-1.76 1.775a1.818 1.818 0 01-1.472-.773L13.168 5.95a2.197 2.197 0 00-1.81-.95c-1.134 0-2.154.972-2.154 2.173v4.94c0 .98-.797 1.775-1.76 1.775-.57 0-1.136-.289-1.472-.773L.408 5.098C.282 4.918 0 5.007 0 5.228v4.284c0 .216.066.426.188.604l5.475 7.889c.324.466.8.812 1.351.938 1.377.316 2.645-.754 2.645-2.117V11.89c0-.98.787-1.775 1.76-1.775h.002c.586 0 1.135.288 1.472.773l4.972 7.163a2.15 2.15 0 001.81.95c1.158 0 2.151-.973 2.151-2.173v-4.939c0-.98.787-1.775 1.76-1.775h.194c.122 0 .22-.1.22-.222V5.225a.221.221 0 00-.22-.222z";
var TRAE_D = "M24 20.541H3.428v-3.426H0V3.4h24V20.54zM3.428 17.115h17.144V6.827H3.428v10.288zm8.573-5.196l-2.425 2.424-2.424-2.424 2.424-2.424 2.425 2.424zm6.857-.001l-2.424 2.423-2.425-2.423 2.425-2.425 2.424 2.425z";
var ROO_D = "M20.113 5.5l-.442 1.557a.157.157 0 01-.196.106l-7.414-2.157a.16.16 0 00-.143.028l-7.342 5.74a.159.159 0 01-.074.032l-4.37.656a.154.154 0 00-.132.162l.02.245c.005.078.071.14.152.141l5.074.128.058.002 3.75-1.953a.16.16 0 01.164.01l2.657 1.847a.152.152 0 01.066.125l-.023 2.45c0 .032.01.063.028.089l3.737 5.227c.03.04.077.065.129.065h1.182a.153.153 0 00.14-.224l-2.664-4.919a.15.15 0 01.005-.152l1.389-2.169a.156.156 0 01.062-.055l4.965-2.456a.16.16 0 01.158.01l1.418.921a.16.16 0 00.087.026h1.289c.125 0 .2-.136.13-.237l-3.578-5.29c-.074-.109-.246-.082-.282.044z";
var CB_P0 = "M18.777 1.647c.28-.02.536.114.972.51 1.018.926 2.437 2.828 3.318 4.452l.34.631.482.24.11.06v3.638a5.206 5.206 0 00-5.32-1.23c-.491.166-1.021.471-2.08 1.082l-6.09 3.516c-1.057.61-1.586.916-1.975 1.259a5.208 5.208 0 00-1.493 5.572c.165.49.471 1.02 1.082 2.08l.315.543h-3.26c-.685 0-1.34-.135-1.939-.377-.169-.956-.009-1.789.469-2.335.158-.18.164-.189.13-.493a11.846 11.846 0 01-.057-1.711l.02-.444-.667-1.18C2.1 15.622 1.445 14.078 1.192 12.9c-.133-.647-.125-.934.04-1.146.1-.128.427-.261.822-.334.994-.175 3.162-.017 5.575.41l.25.043.551-.487c.915-.81 1.522-1.264 2.641-1.962 1.167-.73 2.484-1.331 3.967-1.807l.476-.152.261-.688c.937-2.471 1.896-4.293 2.58-4.9.235-.21.25-.22.422-.23z";
var CB_P1 = "M12.139 18.2a1.203 1.203 0 011.642.44l1.296 2.243a1.204 1.204 0 01-2.083 1.203l-1.296-2.243a1.203 1.203 0 01.44-1.644zM18.629 14.452a1.203 1.203 0 011.642.44l1.295 2.244a1.203 1.203 0 11-2.083 1.203l-1.295-2.243a1.203 1.203 0 01.44-1.644z";
var OC_P0 = "M16.877 1.912c.58-.27 1.14-.323 1.616-.037a.317.317 0 01-.326.542c-.227-.136-.547-.153-1.022.068-.352.165-.765.45-1.234.866 2.683 1.17 4.4 3.5 5.148 5.921a6.421 6.421 0 00-.704.184c-.578.016-1.174.204-1.502.735-.338.55-.268 1.276.072 2.069l.005.012.007.014c.523 1.045 1.318 1.91 2.2 2.284-.912 3.274-3.44 6.144-5.972 6.988v2.109h-2.11v-2.11c-1.043.417-2.086.01-2.11 0v2.11h-2.11v-2.11c-2.531-.843-5.061-3.713-5.973-6.987.882-.373 1.678-1.238 2.2-2.284l.007-.014.006-.012c.34-.793.41-1.518.071-2.069-.327-.531-.923-.719-1.503-.735a6.409 6.409 0 00-.704-.183c.749-2.421 2.466-4.751 5.149-5.922-.47-.416-.88-.701-1.234-.866-.474-.221-.794-.204-1.021-.068a.318.318 0 01-.435-.109.317.317 0 01.109-.433c.476-.286 1.036-.233 1.615.037.49.229 1.031.628 1.621 1.182A9.924 9.924 0 0112 2.568c1.199 0 2.284.19 3.256.526.59-.554 1.13-.953 1.62-1.182zM8.835 6.577a1.266 1.266 0 100 2.532 1.266 1.266 0 000-2.532zm6.33 0a1.267 1.267 0 100 2.533 1.267 1.267 0 000-2.533z";
var OC_P1 = "M.395 13.118c-.966-1.932-.163-3.863 2.41-3.365v-.001l.05.01c.084.018.17.038.26.06.033.009.067.017.1.027.084.022.168.048.255.076l.09.027c.528 0 .95.158 1.16.501.212.343.212.87-.105 1.61-.085.17-.178.333-.276.489l-.01.017a4.967 4.967 0 01-.62.791l-.019.02c-1.092 1.117-2.496 1.336-3.295-.262z";
var OC_P2 = "M21.193 9.753c2.574-.5 3.378 1.433 2.411 3.365-.58 1.159-1.476 1.361-2.342.96l-.011-.005a2.419 2.419 0 01-.114-.056l-.019-.01a2.751 2.751 0 01-.115-.067l-.023-.014c-.035-.022-.071-.044-.106-.068l-.05-.035c-.55-.388-1.062-1.007-1.44-1.76-.276-.647-.311-1.132-.174-1.472.176-.439.636-.639 1.23-.639.032-.011.066-.02.099-.03.08-.026.16-.05.238-.072l.117-.03a5.502 5.502 0 01.3-.067z";
function getRootBrandIcon(key) {
  var k = String(key || "").toLowerCase();
  if (k === "preset" || k.startsWith("preset-")) {
    return h3(
      "svg",
      { viewBox: "0 0 24 24", width: 16, height: 16, style: { display: "block" } },
      h3("path", { fill: "currentColor", d: "M12 2a2 2 0 0 1 2 2v1.05A7.002 7.002 0 0 1 20 12v1a3 3 0 0 1-3 3h-1v2a3 3 0 0 1-3 3h-2a3 3 0 0 1-3-3v-2H7a3 3 0 0 1-3-3v-1a7.002 7.002 0 0 1 6-6.95V4a2 2 0 0 1 2-2zm-3 8a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm6 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z" })
    );
  }
  if (k.includes("dsh")) {
    return h3("img", { src: DSH_ICON_B64, width: 16, height: 16, alt: "DSH", style: { width: 16, height: 16, objectFit: "contain", borderRadius: 3, display: "block" } });
  }
  if (k.includes("workbuddy")) {
    return h3("img", { src: WB_ICON_B64, width: 16, height: 16, alt: "WorkBuddy", style: { width: 16, height: 16, objectFit: "contain", borderRadius: 3, display: "block" } });
  }
  if (k.includes("ccswitch") || k.includes("cc-switch")) {
    return h3("img", { src: CCSWITCH_ICON_B64, width: 16, height: 16, alt: "CC Switch", style: { width: 16, height: 16, objectFit: "contain", borderRadius: 3, display: "block" } });
  }
  if (k.includes("qoder") || k.includes("lingma")) {
    return h3(
      "svg",
      { viewBox: "0 0 24 24", width: 16, height: 16, style: { display: "block" } },
      h3("path", { fill: "#2ADB5C", d: QODER_P0 }),
      h3("path", { fill: "#ffffff", d: QODER_P1 })
    );
  }
  if (k.includes("codex")) {
    return h3(
      "svg",
      { viewBox: "0 0 16 16", width: 16, height: 16, style: { display: "block" } },
      h3("path", { fill: "currentColor", d: CODEX_D })
    );
  }
  if (k.includes("cursor")) {
    return h3(
      "svg",
      { viewBox: "0 0 24 24", width: 16, height: 16, style: { display: "block" } },
      h3("path", { fill: "currentColor", fillRule: "evenodd", d: CURSOR_D })
    );
  }
  if (k.includes("claude")) {
    return h3(
      "svg",
      { viewBox: "0 0 24 24", width: 16, height: 16, style: { display: "block" } },
      h3("path", { fill: "#D97757", fillRule: "evenodd", clipRule: "evenodd", d: "M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z" })
    );
  }
  if (k.includes("gemini")) {
    return h3(
      "svg",
      { viewBox: "0 0 24 24", width: 16, height: 16, style: { display: "block" } },
      h3("path", { fill: "#3b82f6", d: "M12 2C12 7.5 7.5 12 2 12c5.5 0 10 4.5 10 10 0-5.5 4.5-10 10-10-5.5 0-10-4.5-10-10z" })
    );
  }
  if (k.includes("opencode")) {
    return h3(
      "svg",
      { viewBox: "0 0 24 24", width: 16, height: 16, style: { display: "block" } },
      h3("path", { fill: "currentColor", d: "M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z" })
    );
  }
  if (k.includes("copilot")) {
    return h3(
      "svg",
      { viewBox: "0 0 24 24", width: 16, height: 16, style: { display: "block" } },
      h3("path", { fill: "currentColor", d: "M12 2a8 8 0 0 0-8 8v4a4 4 0 0 0 4 4h1v2a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2v-2h1a4 4 0 0 0 4-4v-4a8 8 0 0 0-8-8zm-3 8a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm6 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z" })
    );
  }
  if (k.includes("windsurf")) {
    return h3(
      "svg",
      { viewBox: "0 0 24 24", width: 16, height: 16, style: { display: "block" } },
      h3("path", { fill: "#00d084", fillRule: "evenodd", clipRule: "evenodd", d: WINDSURF_D })
    );
  }
  if (k.includes("trae")) {
    return h3(
      "svg",
      { viewBox: "0 0 24 24", width: 16, height: 16, style: { display: "block" } },
      h3("path", { fill: "#32F08C", d: TRAE_D })
    );
  }
  if (k.includes("openclaw") || k.includes("clawdbot")) {
    return h3(
      "svg",
      { viewBox: "0 0 24 24", width: 16, height: 16, style: { display: "block" } },
      h3("path", { fill: "#FF4D4D", fillRule: "evenodd", d: OC_P0 }),
      h3("path", { fill: "#FF4D4D", d: OC_P1 }),
      h3("path", { fill: "#FF4D4D", d: OC_P2 })
    );
  }
  if (k.includes("roo")) {
    return h3(
      "svg",
      { viewBox: "0 0 24 24", width: 16, height: 16, style: { display: "block" } },
      h3("path", { fill: "#eab308", fillRule: "evenodd", d: ROO_D })
    );
  }
  if (k.includes("codebuddy")) {
    return h3(
      "svg",
      { viewBox: "0 0 24 24", width: 16, height: 16, style: { display: "block" } },
      h3("rect", { width: 24, height: 24, rx: 5, fill: "#2EA99D" }),
      h3("path", { fill: "#ffffff", d: CB_P0 }),
      h3("path", { fill: "#ffffff", d: CB_P1 })
    );
  }
  return h3(
    "svg",
    { viewBox: "0 0 24 24", width: 16, height: 16, style: { display: "block" } },
    h3("path", { fill: "#10b981", d: "M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h2a5 5 0 0 1 5 5v1a3 3 0 0 1 1 2.23V17a3 3 0 0 1-3 3h-1.1A6 6 0 0 1 12 22a6 6 0 0 1-4.9-2H6a3 3 0 0 1-3-3v-1.77A3 3 0 0 1 4 13v-1a5 5 0 0 1 5-5h2V5.73A2 2 0 0 1 10 4a2 2 0 0 1 2-2zm-3 10a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm6 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm-6 5a4 4 0 0 0 6 0H9z" })
  );
}
function resolveRepoBrand(url, repo) {
  var raw = (url || repo || "").trim();
  if (!raw) return "GitHub";
  var host = "";
  try {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) {
      host = new URL(raw).hostname.toLowerCase();
    } else if (/^git@[^:]+:/.test(raw)) {
      host = raw.slice(4).split(":")[0].toLowerCase();
    }
  } catch (_) {
    host = "";
  }
  if (host) {
    if (host === "github.com" || host.endsWith(".github.com")) return "GitHub";
    if (host === "gitee.com" || host.endsWith(".gitee.com")) return "Gitee";
    if (host === "gitlab.com" || host.endsWith(".gitlab.com") || host.includes("gitlab")) return "GitLab";
    return "Git";
  }
  var lower = raw.toLowerCase();
  if (lower.startsWith("gitee.com/") || lower.startsWith("gitee:")) return "Gitee";
  if (lower.startsWith("gitlab.com/") || lower.startsWith("gitlab:")) return "GitLab";
  if (lower.startsWith("github.com/") || lower.startsWith("github:")) return "GitHub";
  if (/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(raw)) return "GitHub";
  return "Git";
}
function renderRepoBrandIconByUrl(url, repo) {
  var brand = resolveRepoBrand(url, repo);
  var viewBox = "0 0 16 16";
  var path2 = "M8 0a8 8 0 0 0-2.53 15.59c.4.074.547-.173.547-.385 0-.19-.007-.693-.01-1.36-2.226.484-2.695-1.073-2.695-1.073-.364-.924-.89-1.17-.89-1.17-.726-.496.055-.486.055-.486.803.056 1.225.824 1.225.824.714 1.223 1.872.87 2.328.665.072-.517.28-.87.508-1.07-1.777-.202-3.645-.888-3.645-3.956 0-.874.31-1.588.823-2.148-.083-.202-.357-1.017.078-2.12 0 0 .672-.215 2.2.82A7.65 7.65 0 0 1 8 4.8c.68.003 1.365.092 2.004.27 1.527-1.035 2.197-.82 2.197-.82.437 1.103.162 1.918.08 2.12.513.56.822 1.274.822 2.148 0 3.076-1.872 3.752-3.654 3.95.288.248.544.735.544 1.482 0 1.07-.01 1.932-.01 2.195 0 .214.144.463.55.384A8.001 8.001 0 0 0 8 0Z";
  if (brand === "Gitee") {
    viewBox = "0 0 24 24";
    path2 = "M11.984 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12a12 12 0 0 0 12-12A12 12 0 0 0 12 0zm6.09 5.333c.328 0 .593.266.592.593v1.482a.594.594 0 0 1-.593.592H9.777c-.982 0-1.778.796-1.778 1.778v5.63c0 .327.266.592.593.592h5.63c.982 0 1.778-.796 1.778-1.778v-.296a.593.593 0 0 0-.592-.593h-4.15a.59.59 0 0 1-.592-.592v-1.482a.593.593 0 0 1 .593-.592h6.815c.327 0 .593.265.593.592v3.408a4 4 0 0 1-4 4H5.926a.593.593 0 0 1-.593-.593V9.778a4.444 4.444 0 0 1 4.445-4.444h8.296Z";
  } else if (brand === "GitLab") {
    viewBox = "0 0 24 24";
    path2 = "m23.6 9.593l-.033-.086L20.3.98a.85.85 0 0 0-.336-.405a.875.875 0 0 0-1 .054a.9.9 0 0 0-.29.44L16.47 7.818H7.537L5.333 1.07a.86.86 0 0 0-.29-.441a.875.875 0 0 0-1-.054a.86.86 0 0 0-.336.405L.433 9.502l-.032.086a6.066 6.066 0 0 0 2.012 7.01l.01.009l.03.021l4.977 3.727l2.462 1.863l1.5 1.132a1.01 1.01 0 0 0 1.22 0l1.499-1.132l2.461-1.863l5.006-3.75l.013-.01a6.07 6.07 0 0 0 2.01-7.002";
  } else if (brand === "Git") {
    viewBox = "0 0 24 24";
    path2 = "M23.546 10.93L13.067.452a1.55 1.55 0 0 0-2.188 0L8.708 2.627l2.76 2.76a1.838 1.838 0 0 1 2.327 2.341l2.658 2.66a1.838 1.838 0 0 1 1.9 3.039a1.837 1.837 0 0 1-2.6 0a1.85 1.85 0 0 1-.404-1.996L12.86 8.955v6.525c.176.086.342.203.488.348a1.85 1.85 0 0 1 0 2.6a1.844 1.844 0 0 1-2.609 0a1.834 1.834 0 0 1 0-2.598c.182-.18.387-.316.605-.406V8.835a1.834 1.834 0 0 1-.996-2.41L7.636 3.7L.45 10.881c-.6.605-.6 1.584 0 2.189l10.48 10.477a1.545 1.545 0 0 0 2.186 0l10.43-10.43a1.544 1.544 0 0 0 0-2.187";
  }
  return h3(
    "span",
    { className: "dssm-brand-icon", "aria-hidden": true, title: brand },
    h3(
      "svg",
      { viewBox, width: 16, height: 16, fill: "currentColor", focusable: "false" },
      h3("path", { d: path2 })
    )
  );
}
function currentSessionId(snapshot) {
  if (!snapshot) return void 0;
  var byId = snapshot.byId || {};
  var ids = Array.isArray(snapshot.ids) && snapshot.ids.length ? snapshot.ids : Object.keys(byId);
  for (var i = 0; i < ids.length; i++) {
    var row = byId[ids[i]];
    if (row && row.retainedBy && row.retainedBy.mainView) return ids[i];
  }
  for (var id in byId) {
    if (ids.indexOf(id) !== -1) continue;
    if (byId[id] && byId[id].retainedBy && byId[id].retainedBy.mainView) return id;
  }
}
/*! §2 IO adapters */
function parseApiResponse(response) {
  return response.json().catch(function(error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new ApiFailure({ code: API_ERROR_CODES.nonJson, params: { status: response.status }, message: "non-json response", outcome: "unknown" });
  }).then(function(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiFailure({ code: API_ERROR_CODES.response, message: "Invalid response", outcome: "unknown" });
    const payload = value;
    if (!response.ok || payload.ok === false) throw normalizeApiFailure(payload);
    if (!Object.hasOwn(payload, "data")) throw new ApiFailure({ code: API_ERROR_CODES.response, message: "Missing response data", outcome: "unknown" });
    return payload.data;
  });
}
function callApi(path2, options) {
  return fetch(resolveApiUrl("/api/forge-skills-manager" + path2), options).then(parseApiResponse);
}
function buildUploadPayload(selection) {
  return Promise.all(selection.files.map(function(file) {
    return file.arrayBuffer().then(function(buffer) {
      return { path: uploadFilePath(file), data: bytesToBase64(buffer) };
    });
  })).then(function(entries) {
    return selection.kind === "zip" ? { name: selection.name, zip: entries[0].data } : { name: selection.name, entries };
  });
}
function readDroppedEntry(entry, prefix, output) {
  if (entry.isFile) return new Promise(function(resolve, reject) {
    entry.file(function(file) {
      file._dssmPath = prefix + file.name;
      output.push(file);
      resolve();
    }, reject);
  });
  if (!entry.isDirectory) return Promise.resolve();
  return new Promise(function(resolve, reject) {
    var reader = entry.createReader(), children = [];
    function next() {
      reader.readEntries(function(batch) {
        if (!batch.length) {
          Promise.all(children.map(function(child) {
            return readDroppedEntry(child, prefix + entry.name + "/", output);
          })).then(function() {
            resolve();
          }, reject);
          return;
        }
        children = children.concat(batch);
        next();
      }, reject);
    }
    next();
  });
}
function droppedFiles(dataTransfer) {
  var items = Array.from(dataTransfer && dataTransfer.items || []), entries = items.map(function(item) {
    return item.webkitGetAsEntry && item.webkitGetAsEntry();
  }).filter((entry) => !!entry);
  if (!entries.length) return Promise.resolve(Array.from(dataTransfer && dataTransfer.files || []));
  var files = [];
  return Promise.all(entries.map(function(entry) {
    return readDroppedEntry(entry, "", files);
  })).then(function() {
    return files;
  });
}
function modalFocusable(modal) {
  return Array.prototype.slice.call(modal.querySelectorAll('button:not(:disabled), [href], input:not([type=hidden]):not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])') || []);
}
function trapModalFocus(modal, event) {
  if (event.key !== "Tab") return;
  var focusable = modalFocusable(modal);
  if (!focusable.length) return;
  var active = document.activeElement;
  if (active === modal || !modal.contains(active) || (event.shiftKey ? active === focusable[0] : active === focusable[focusable.length - 1])) {
    event.preventDefault();
    (event.shiftKey ? focusable[focusable.length - 1] : focusable[0]).focus();
  }
}
function recoverModalFocus(modal, active, body) {
  if (modal && active === body) modal.focus();
}
/*! §3 Client runtime ownership */
function translateError(t, payload) {
  const details = failureDetails(payload);
  if (!details.code) return details.message;
  const params = { ...details.params };
  if (params.action) params.action = translateOrFallback(t, "action." + params.action, String(params.action));
  const translated = t(details.code, params);
  if (translated === details.code) return details.message === "Unexpected response" ? details.code : details.message;
  if (params.code && details.code === "error.workspace.unavailable") return translated + (hostLocale() === "zh" || !hostLocale() && translated.includes("\uFF1A") ? "\uFF08" + params.code + "\uFF09" : " (" + params.code + ")");
  return translated;
}
var localeService;
var clientMutations = createClientOperations(callApi);
var SourceSelect = createSourceSelect(react);
var destinationKit = createDestinationKit({ react, SourceSelect, translateError });
var DestinationPicker = destinationKit.DestinationPicker;
var useRepositoryUI = createNacosUI({ react, Modal, Input, Button: import_dsh_client_ui_primitives4.Button, SourceSelect, destination: destinationKit, api: callApi, headers: MUTATION_HEADERS, translateError });
function hostLocale() {
  return localeService?.getLocale?.().active;
}
function formatTrashTime(t, value) {
  return new Date(value).toLocaleString(hostLocale() || t("format.locale"));
}
function summarizeImportResult(t, data) {
  var importedItems = data && data.imported || [];
  var imported = importedItems.map(function(item) {
    return item.name;
  });
  var skipped = (data && data.skipped || []).map(function(item) {
    return item.name;
  });
  var warnings = [];
  importedItems.forEach(function(item) {
    (item.warnings || []).forEach(function(warning) {
      warnings.push(translateError(t, warning));
    });
  });
  var summary;
  if (imported.length && skipped.length) summary = { ok: true, warning: true, imported: true, text: t("result.importPartial", { imported: imported.join(", "), skipped: skipped.join(", ") }) };
  else if (imported.length) summary = { ok: true, warning: false, imported: true, text: t("result.imported", { names: imported.join(", ") }) };
  else if (skipped.length) summary = { ok: false, warning: true, imported: false, text: t("result.importSkipped", { names: skipped.join(", ") }) };
  else summary = { ok: false, warning: false, imported: false, text: t("result.importEmpty") };
  if (warnings.length) {
    summary.warning = true;
    summary.text = t("result.importWarnings", { result: summary.text, warnings: warnings.join(t("format.warningSeparator")) });
  }
  return summary;
}
function resolveT(rawT) {
  if (typeof rawT === "function") return rawT;
  if (localeService && typeof localeService.bind === "function") return localeService.bind(NS);
  return function(key, params) {
    var dict = DICT.zh || {};
    var template = dict[key] || key;
    if (!params) return template;
    var p = params;
    return template.replace(/\{(\w+)\}/g, function(_, name2) {
      return String(p[name2] ?? "{" + name2 + "}");
    });
  };
}
var workspacePickDirectory = null;
function availableDirectoryPicker() {
  var bridge = globalThis.__DSH_DIRECTORY_PICKER__;
  if (bridge && typeof bridge.pick === "function") {
    var bridgePick = bridge.pick.bind(bridge);
    return function() {
      return bridgePick();
    };
  }
  return workspacePickDirectory;
}
/*! §4 Views and component state */
function Modal(props) {
  var bodyRef = react.useRef(null);
  var closeRef = react.useRef(props.onClose);
  closeRef.current = props.onClose;
  react.useLayoutEffect(function() {
    if (typeof document === "undefined") return;
    var panel = bodyRef.current;
    if (panel) recoverModalFocus(panel, document.activeElement, document.body);
  });
  react.useEffect(function() {
    if (typeof document === "undefined") return;
    function onKey(event) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeRef.current();
    }
    document.addEventListener("keydown", onKey, true);
    return function() {
      document.removeEventListener("keydown", onKey, true);
    };
  }, []);
  return h3(import_dsh_client_ui_primitives4.Modal, {
    open: true,
    title: props.title,
    description: props.description,
    footer: props.footer,
    onClose: props.onClose,
    closeLabel: props.closeLabel || "Close",
    className: ["dssm-modal", props.className].filter(Boolean).join(" "),
    contentClassName: ["dssm-modal-content", props.contentClassName].filter(Boolean).join(" ")
  }, props.children ? h3("div", { ref: bodyRef }, props.children) : void 0);
}
function SkillManagerSection(props) {
  var t = resolveT(props && props.t);
  var sessionId = props && props.useSessions ? props.useSessions(currentSessionId) : void 0;
  var scopes = react.useState("user"), filtersState = react.useState({}), expandedState = react.useState({});
  return h3(SkillManagerView, Object.assign({}, props, { t, key: sessionId || "no-session", sessionId, scope: scopes[0], setScope: scopes[1], savedFilters: filtersState[0], setSavedFilters: filtersState[1], expanded: expandedState[0], setExpanded: expandedState[1] }));
}
function SkillManagerView(props) {
  var t = resolveT(props && props.t);
  function sessionApi(path2, options2) {
    var headers = Object.fromEntries(new Headers(options2?.headers).entries());
    if (props.sessionId) headers["x-dsh-skills-session"] = props.sessionId;
    return clientMutations.request(path2, Object.assign({}, options2, { headers }));
  }
  var ss = react.useState({ loading: true, error: null, data: null }), snapshot = ss[0], setSnapshot = ss[1];
  var mutationState = react.useState(clientMutations.getSnapshot()), pendingMutation = mutationState[0];
  react.useEffect(function() {
    return clientMutations.subscribe(function() {
      mutationState[1](clientMutations.getSnapshot());
    });
  }, []);
  var bs = react.useState(false), busy = bs[0] || !!pendingMutation, setBusy = bs[1];
  var scope = props.scope, setScope = props.setScope;
  var expanded = props.expanded, setExpanded = props.setExpanded, savedFilters = props.savedFilters, setSavedFilters = props.setSavedFilters;
  var ms = react.useState(null), modal = ms[0], setModal = ms[1];
  var asState = react.useState(""), addSearch = asState[0], setAddSearch = asState[1];
  var aselState = react.useState({}), addSelection = aselState[0], setAddSelection = aselState[1];
  var rs = react.useState(null), result = rs[0] && rs[0].scope === scope ? rs[0] : null;
  function setResult(value) {
    rs[1](value ? Object.assign({}, value, { scope }) : null);
  }
  react.useEffect(function() {
    if (pendingMutation?.phase === "pending") setModal(null);
  }, [pendingMutation]);
  var fms = react.useState({ root: "dsh", name: "", description: "", body: "" }), form = fms[0], setForm = fms[1];
  var cns = react.useState(""), categoryName = cns[0], setCategoryName = cns[1];
  var snt = react.useState(""), skillNoteText = snt[0], setSkillNoteText = snt[1];
  var cds = react.useState(defaultDestination()), createDestination = cds[0], setCreateDestination = cds[1];
  var ids = react.useState(defaultDestination()), importDestination = ids[0], setImportDestination = ids[1];
  var wss = react.useState([]), workspaceRows = wss[0], setWorkspaceRows = wss[1];
  var wps = react.useState(""), selectedWorkspace = wps[0], setSelectedWorkspace = wps[1];
  var selectedWorkspaceRef = react.useRef("");
  var workspaceListRequest = react.useRef(0);
  var wls = react.useState({ loading: false, error: null }), workspaceList = wls[0], setWorkspaceList = wls[1];
  var wds = react.useState({}), workspaceDetails = wds[0], setWorkspaceDetails = wds[1];
  var us = react.useState(null), upload = us[0], setUpload = us[1];
  var rps = react.useState(""), rootPathValue = rps[0], setRootPathValue = rps[1];
  var rpk = react.useState(false), rootPathPicking = rpk[0], setRootPathPicking = rpk[1];
  var rpe = react.useState(null), rootPathError = rpe[0], setRootPathError = rpe[1];
  var cso = react.useState(false), customSourceOpen = cso[0], setCustomSourceOpen = cso[1];
  var csp = react.useState(""), customSourcePath = csp[0], setCustomSourcePath = csp[1];
  var csl = react.useState(""), customSourceLabel = csl[0], setCustomSourceLabel = csl[1];
  var csr = react.useState(null), customSourceScan = csr[0], setCustomSourceScan = csr[1];
  var csb = react.useState(false), customSourceBusy = csb[0], setCustomSourceBusy = csb[1];
  var cse = react.useState(null), customSourceError = cse[0], setCustomSourceError = cse[1];
  var ds = react.useState(null), detail = ds[0], setDetail = ds[1];
  var dsk = react.useState(null), detailSkill = dsk[0], setDetailSkill = dsk[1];
  var copySt = react.useState("idle"), copyState = copySt[0], setCopyState = copySt[1];
  function copyText(text7) {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      setCopyState("failed");
      return;
    }
    navigator.clipboard.writeText(text7).then(function() {
      setCopyState("copied");
      setTimeout(function() {
        setCopyState("idle");
      }, 1500);
    }).catch(function() {
      setCopyState("failed");
    });
  }
  var inflightRef = react.useRef(false);
  var draggingRef = react.useRef(null);
  var importInputRef = react.useRef(null);
  var folderInputRef = react.useRef(null);
  var pickerOpenRef = react.useRef(false);
  var workspaceRequests = react.useRef({});
  var workspaceEpoch = react.useRef(0);
  react.useEffect(function() {
    return function() {
      workspaceEpoch.current++;
    };
  }, []);
  function refresh(silent) {
    if (!silent) setSnapshot({ loading: true, error: null, data: snapshot.data });
    return sessionApi("/state").then(function(data2) {
      setSnapshot({ loading: false, error: null, data: data2 });
      return data2;
    }).catch(function(error) {
      setSnapshot({ loading: false, error: translateError(t, error), data: null });
    });
  }
  react.useEffect(function() {
    refresh(false);
  }, []);
  async function refreshConfirmed(workspace) {
    const results = await Promise.all([refresh(true), workspace ? loadWorkspaceDetail(workspace) : Promise.resolve(true)]);
    return !!results[0] && !!results[1];
  }
  function post2(path2, body, successKey, successParams, successMessage) {
    if (inflightRef.current || clientMutations.getSnapshot()) return Promise.reject(new ApiFailure({ code: API_ERROR_CODES.busy, message: t("mutation.pending"), outcome: "pending" }));
    inflightRef.current = true;
    setBusy(true);
    setResult(null);
    return sessionApi(path2, { method: "POST", headers: MUTATION_HEADERS, body: JSON.stringify(body || {}) }).then(async function(data2) {
      const workspace = body && typeof body.workspace === "string" ? body.workspace : void 0;
      const fresh = await refreshConfirmed(workspace);
      setResult(fresh ? successMessage ? successMessage(data2) : { ok: true, text: successKey ? t(successKey, successParams || data2 || {}) : t("result.updated") } : { ok: false, warning: true, text: t("mutation.refreshWarning") });
      return data2;
    }).catch(function(error) {
      setResult({ ok: false, warning: !!clientMutations.getSnapshot(), text: clientMutations.getSnapshot() ? t("mutation.pending") : t("error.action", { error: translateError(t, error) }) });
      throw error;
    }).finally(function() {
      inflightRef.current = false;
      setBusy(false);
    });
  }
  async function confirmMutation() {
    setBusy(true);
    try {
      const outcome = await clientMutations.confirm();
      if (outcome.state === "pending") return;
      if (outcome.state === "rejected") {
        setResult({ ok: false, text: translateError(t, outcome.failure) });
        return;
      }
      const fresh = await refreshConfirmed(selectedWorkspace);
      setResult(fresh ? { ok: true, text: t("mutation.confirmed") } : { ok: false, warning: true, text: t("mutation.refreshWarning") });
    } catch (error) {
      setResult({ ok: false, warning: true, text: t("mutation.pending") + " " + translateError(t, error) });
    } finally {
      setBusy(false);
    }
  }
  function openDetail(root4, skill, workspacePath2) {
    setBusy(true);
    setDetail(null);
    setDetailSkill(skill);
    setCopyState("idle");
    setModal("detail");
    sessionApi("/detail", { method: "POST", headers: MUTATION_HEADERS, body: JSON.stringify(workspacePath2 ? { root: root4.key, name: skill.name, workspace: workspacePath2 } : { root: root4.key, name: skill.name }) }).then(setDetail).catch(function(error) {
      setResult({ ok: false, text: t("error.action", { error: translateError(t, error) }) });
      setDetailSkill(null);
      setModal(null);
    }).finally(function() {
      setBusy(false);
    });
  }
  function openRootPath(root4) {
    setRootPathValue(root4.path || "");
    setRootPathPicking(false);
    setRootPathError(null);
    setModal({ type: "root-path", root: root4.key, label: rootDisplayName(t, root4), path: root4.path || "", defaultPath: root4.defaultPath });
  }
  function pickRootPathDirectory() {
    var picker = availableDirectoryPicker();
    if (!picker) {
      setRootPathError(t("rootPath.pickUnavailable"));
      return;
    }
    setRootPathError(null);
    setRootPathPicking(true);
    Promise.resolve().then(picker).then(function(picked) {
      if (typeof picked === "string" && picked.trim()) setRootPathValue(picked.trim());
    }).catch(function(error) {
      setRootPathError(translateError(t, error));
    }).finally(function() {
      setRootPathPicking(false);
    });
  }
  function saveRootPath(value) {
    var target = modal && typeof modal === "object" && modal.type === "root-path" ? modal : null;
    if (!target) return;
    setRootPathError(null);
    post2("/root-path", { key: target.root, path: value }, value === null ? "rootPath.resetDone" : "rootPath.saved", { name: target.label }).then(function() {
      setModal(null);
    }).catch(function(error) {
      setRootPathError(translateError(t, error));
    });
  }
  function openCustomSourceForm() {
    setCustomSourceOpen(true);
    setCustomSourceError(null);
    setCustomSourceScan(null);
  }
  function pickCustomSourceDirectory() {
    var picker = availableDirectoryPicker();
    if (!picker) {
      setCustomSourceError(t("rootPath.pickUnavailable"));
      return;
    }
    setCustomSourceError(null);
    setCustomSourceBusy(true);
    Promise.resolve().then(picker).then(function(picked) {
      if (typeof picked === "string" && picked.trim()) setCustomSourcePath(picked.trim());
    }).catch(function(error) {
      setCustomSourceError(translateError(t, error));
    }).finally(function() {
      setCustomSourceBusy(false);
    });
  }
  function scanCustomSourceDirectory() {
    var target = (customSourcePath || "").trim();
    if (!target) return;
    setCustomSourceBusy(true);
    setCustomSourceError(null);
    sessionApi("/custom-source-scan", { method: "POST", headers: MUTATION_HEADERS, body: JSON.stringify({ path: target }) }).then(function(data2) {
      setCustomSourceScan(data2);
    }).catch(function(error) {
      setCustomSourceScan(null);
      setCustomSourceError(translateError(t, error));
    }).finally(function() {
      setCustomSourceBusy(false);
    });
  }
  function submitCustomSources(list4) {
    var sources = list4.filter(function(item) {
      return item && item.path;
    });
    if (!sources.length || customSourceBusy) return;
    setCustomSourceBusy(true);
    setCustomSourceError(null);
    setResult(null);
    post2("/custom-source-add", { sources }, "customSource.added", { count: sources.length }).then(function(data2) {
      var count = data2 && Array.isArray(data2.added) ? data2.added.length : sources.length;
      return Promise.resolve().then(function() {
        if (!count) setResult({ ok: false, text: t("error.customSource.empty") });
        setCustomSourceScan(null);
        setCustomSourcePath("");
        setCustomSourceLabel("");
        setCustomSourceOpen(false);
      });
    }).catch(function(error) {
      setCustomSourceError(translateError(t, error));
    }).finally(function() {
      setCustomSourceBusy(false);
    });
  }
  function removeCustomSourceEntry(root4) {
    if (busy) return;
    var removedPath = rootPathValue;
    post2("/custom-source-remove", { id: root4 }, "customSource.removed").then(function() {
      return sessionApi("/state").then(function(freshData) {
        setSnapshot({ loading: false, error: null, data: freshData });
        var remaining = (freshData && Array.isArray(freshData.roots) ? freshData.roots : []).filter(function(r) {
          return !r.mutable && r.scope !== "project" && r.kind !== "preset" && r.scope !== "preset" && r.key !== root4;
        });
        var fallback = remaining.find(function(r) {
          return r.custom;
        }) || remaining[0];
        if (fallback) {
          openRootPath(fallback);
        } else {
          setModal(null);
        }
        if (removedPath) {
          setCustomSourceScan(function(prev) {
            if (!prev) return null;
            return Object.assign({}, prev, {
              candidates: prev.candidates.map(function(c) {
                return c.path === removedPath ? Object.assign({}, c, { registered: false }) : c;
              })
            });
          });
        }
      });
    }).catch(function(error) {
      setRootPathError(translateError(t, error));
    });
  }
  function updateForm(key, value) {
    setForm(Object.assign({}, form, { [key]: value }));
  }
  var data = snapshot.data || { roots: [], writeDestinations: [], projects: [], trash: [], warnings: [] }, allRoots = data.roots || [];
  var presetDestinations = allRoots.filter(function(r) {
    return r.kind === "preset" && r.mutable === true;
  }).map(function(r) {
    return {
      key: r.key,
      name: rootDisplayName(t, r),
      path: r.path,
      available: r.exists !== false
    };
  });
  function submitCreate() {
    if (!destinationReady(createDestination, workspaceRows, userDestinations, presetDestinations)) return;
    post2("/create", Object.assign({}, form, { root: void 0 }, destinationPayload(createDestination)), null).then(function(data2) {
      setModal(null);
      setForm({ root: "dsh", name: "", description: "", body: "" });
      setResult({ ok: true, text: t("result.created", { name: data2.name }) + (createDestination.scope === "workspace" ? " \xB7 " + t("dest.createdInWorkspace") : createDestination.scope === "preset" ? " \xB7 " + t("dest.presetNote") : "") });
    }).catch(function() {
    });
  }
  function selectUploadFiles(files) {
    pickerOpenRef.current = false;
    var selected = inspectUploadSelection(files);
    if (!selected) return;
    if (selected.error) {
      setUpload(null);
      setResult({ ok: false, text: translateError(t, selected.error) });
      return;
    }
    setUpload(selected);
    setResult(null);
  }
  function openNativePicker(ref) {
    if (busy || pickerOpenRef.current || !ref.current) return;
    pickerOpenRef.current = true;
    ref.current.value = "";
    function release() {
      setTimeout(function() {
        pickerOpenRef.current = false;
      }, 0);
    }
    window.addEventListener("focus", release, { once: true });
    ref.current.click();
    setTimeout(function() {
      pickerOpenRef.current = false;
    }, 3e4);
  }
  function submitImport() {
    if (!upload || !destinationReady(importDestination, workspaceRows, userDestinations, presetDestinations)) return;
    buildUploadPayload(upload).then(function(payload) {
      return post2("/upload", Object.assign({}, payload, destinationPayload(importDestination)), null, void 0, function(data2) {
        return summarizeImportResult(t, data2);
      });
    }).then(function(data2) {
      if (summarizeImportResult(t, data2).imported) {
        setModal(null);
        setUpload(null);
      }
    }).catch(function() {
    });
  }
  var overridableRoots = allRoots.filter(function(r) {
    return !r.mutable && r.scope !== "project" && r.kind !== "preset" && r.scope !== "preset";
  });
  function openRootPathPicker() {
    if (!overridableRoots.length) return;
    var target = activeSource && overridableRoots.find(function(r) {
      return r.key === activeSource;
    }) || overridableRoots[0];
    openRootPath(target);
  }
  var filterKey = scope === "project" ? "project" : "user", filters = savedFilters[filterKey] || { query: "", source: "", status: "" }, query = filters.query, source = filters.source;
  function updateFilter(key, value) {
    setSavedFilters(function(previous3) {
      return Object.assign({}, previous3, { [filterKey]: Object.assign({}, filters, { [key]: value }) });
    });
  }
  function setQuery(value) {
    updateFilter("query", value);
  }
  function setSource(value) {
    updateFilter("source", value);
  }
  var selectedDetail = workspaceDetails[selectedWorkspace];
  var roots = scope === "trash" ? [] : scope === "project" ? visibleSkillRoots(selectedDetail?.roots || []) : scopeSkillRoots(allRoots);
  var filteredOptionsRoots = roots.filter(function(r) {
    return (r.skills || []).length > 0;
  });
  var activeSource = scope !== "project" && filteredOptionsRoots.some(function(root4) {
    return root4.key === source;
  }) ? source : "";
  function workspacePath(row) {
    return row.registeredPaths[0] || "";
  }
  function selectWorkspace(path2) {
    if (!workspaceRows.some(function(row) {
      return row.available && workspacePath(row) === path2;
    })) return;
    selectedWorkspaceRef.current = path2;
    setSelectedWorkspace(path2);
    if (!workspaceDetails[path2]) loadWorkspaceDetail(path2);
  }
  function loadWorkspaces(readSelected = scope === "project", forceDetail = false) {
    var epoch = workspaceEpoch.current, request = ++workspaceListRequest.current;
    var current = function() {
      return epoch === workspaceEpoch.current && request === workspaceListRequest.current;
    };
    setWorkspaceList({ loading: true, error: null });
    return callApi("/workspaces").then(function(listed) {
      if (!current()) return [];
      var items = listed.items || [];
      setWorkspaceRows(items);
      setWorkspaceList({ loading: false, error: null });
      var selected = items.find(function(row) {
        return row.available && workspacePath(row) === selectedWorkspaceRef.current;
      }) || items.find(function(row) {
        return row.available && workspacePath(row);
      });
      var path2 = selected ? workspacePath(selected) : "";
      selectedWorkspaceRef.current = path2;
      setSelectedWorkspace(path2);
      if (readSelected && path2 && (forceDetail || !workspaceDetails[path2])) loadWorkspaceDetail(path2);
      return items;
    }).catch(function(error) {
      if (!current()) return [];
      setWorkspaceRows([]);
      selectedWorkspaceRef.current = "";
      setSelectedWorkspace("");
      setWorkspaceList({ loading: false, error: translateError(t, error) });
      return [];
    });
  }
  function loadWorkspaceDetail(path2) {
    var epoch = workspaceEpoch.current, request = (workspaceRequests.current[path2] || 0) + 1;
    workspaceRequests.current[path2] = request;
    var current = function() {
      return epoch === workspaceEpoch.current && request === workspaceRequests.current[path2];
    };
    setWorkspaceDetails(function(previous3) {
      return Object.assign({}, previous3, { [path2]: { loading: true, error: null, roots: previous3[path2] ? previous3[path2].roots : [] } });
    });
    return callApi("/workspace-skills", { method: "POST", headers: MUTATION_HEADERS, body: JSON.stringify({ workspace: path2 }) }).then(function(detail2) {
      if (!current()) return;
      setWorkspaceDetails(function(previous3) {
        return Object.assign({}, previous3, { [path2]: { loading: false, error: null, roots: detail2.roots || [] } });
      });
      return detail2;
    }).catch(function(error) {
      if (current()) setWorkspaceDetails(function(previous3) {
        return Object.assign({}, previous3, { [path2]: { loading: false, error: translateError(t, error), roots: [] } });
      });
    });
  }
  function refreshWorkspaceDetails() {
    workspaceEpoch.current++;
    setWorkspaceDetails({});
    return loadWorkspaces(true, true);
  }
  function openCreate() {
    setForm(Object.assign({}, form, { root: "dsh" }));
    setCreateDestination(defaultDestination());
    setModal("create");
    loadWorkspaces();
  }
  function openImport() {
    setResult(null);
    setUpload(null);
    setImportDestination(defaultDestination());
    setModal("import");
    loadWorkspaces();
  }
  var userDestinations = (data.writeDestinations || []).filter(function(item) {
    return item.key === "dsh" || item.key === "agents";
  });
  function trashRestoreBody(item) {
    var projectRoot = item.root && item.root.scope === "project" ? item.root.projectRoot : "";
    var row = projectRoot ? workspaceRows.find(function(candidate) {
      return candidate.projectRoot === projectRoot && candidate.available;
    }) : void 0;
    return row ? { id: item.id, workspace: row.registeredPaths[0] || row.path } : { id: item.id };
  }
  function trashRootLabel(item) {
    if (item.root && item.root.scope === "project") return t("root.projectDsh") + " \xB7 " + (item.root.projectName || item.root.projectRoot);
    if (item.root && (item.root.scope === "preset" || item.root.kind === "preset")) return rootDisplayName(t, item.root);
    return translateOrFallback(t, "root." + (item.root?.localeKey || item.root?.key || "dsh"), item.root?.label || t("root.dsh"));
  }
  function renderRootIcon(key) {
    return h3("span", { className: "dssm-brand-icon", "aria-hidden": true, style: { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 16, height: 16, flexShrink: 0 } }, getRootBrandIcon(key));
  }
  var options = [{
    value: "",
    label: t("filter.all")
  }].concat(filteredOptionsRoots.map(function(root4) {
    return {
      value: root4.key,
      label: t("filter.option", { name: rootDisplayName(t, root4), count: root4.skills.length })
    };
  }));
  function renderLinkedNote(skill) {
    if (skill.linked !== true) return null;
    return h3("div", { className: "dssm-note" }, t("skill.linked"));
  }
  function renderFallback(skill) {
    if (!skill.fallbackTo) return null;
    var target = allRoots.find(function(root4) {
      return root4.key === skill.fallbackTo.root;
    });
    if (!target) return null;
    return h3("div", { className: "dssm-note dssm-fallback" }, t("status.fallback." + skill.fallbackTo.scope, { source: rootDisplayName(t, target) }));
  }
  function renderInvocationBadge(skill) {
    var kind = skillDeclaredInvocationKind(skill);
    if (kind !== "manual") return null;
    return h3("span", {
      className: "dssm-invocation-badge",
      title: t("invocation.manualOnlyTip")
    }, h3(HostTag, {
      tone: "neutral"
    }, t("invocation.manualOnly")));
  }
  function renderTokenBadge(descriptionTokens, bodyTokens, skill) {
    if (typeof descriptionTokens !== "number") return null;
    var descStr = descriptionTokens.toLocaleString(t("format.locale"));
    var bodyStr = typeof bodyTokens === "number" ? bodyTokens.toLocaleString(t("format.locale")) : "0";
    var isShadowed = skill && Boolean(skill.shadowedBy);
    var isExplicitDisabled = skill && (skill.enabled === false || skill.managerOverride === false);
    var declaredKind = skill ? skillDeclaredInvocationKind(skill) : "all";
    var tipKey = isShadowed ? "token.badgeTip.shadowed" : isExplicitDisabled ? "token.badgeTip.disabled" : declaredKind === "manual" ? "token.badgeTip.manualOnly" : declaredKind === "none" ? "token.badgeTip.blocked" : "token.badgeTip";
    return h3("span", {
      className: "dssm-token-badge",
      tabIndex: 0,
      role: "note",
      title: t(tipKey, { description: descStr, body: bodyStr }),
      "aria-label": t(tipKey, { description: descStr, body: bodyStr })
    }, "\u2248" + descStr);
  }
  function renderDetailTokens(descriptionTokens, bodyTokens, skill) {
    if (typeof descriptionTokens !== "number" && typeof bodyTokens !== "number") return null;
    var descStr = typeof descriptionTokens === "number" ? descriptionTokens.toLocaleString(t("format.locale")) : "0";
    var bodyStr = typeof bodyTokens === "number" ? bodyTokens.toLocaleString(t("format.locale")) : "0";
    var isShadowed = skill && Boolean(skill.shadowedBy);
    var isExplicitDisabled = skill && (skill.enabled === false || skill.managerOverride === false);
    var declaredKind = skill ? skillDeclaredInvocationKind(skill) : "all";
    var noteKey = isShadowed ? "token.note.shadowed" : isExplicitDisabled ? "token.note.disabled" : declaredKind === "manual" ? "token.note.manualOnly" : declaredKind === "none" ? "token.note.blocked" : "token.note";
    return h3(
      "div",
      { className: "dssm-detail-tokens" },
      h3("span", { className: "dssm-token-line" }, t("token.detailLine", { description: descStr, body: bodyStr })),
      h3("span", { className: "dssm-token-note" }, t(noteKey))
    );
  }
  function renderDetailPolicy(skill) {
    if (!skill) return null;
    var kind = skillDeclaredInvocationKind(skill);
    var colon = t("format.locale") === "zh-CN" ? "\uFF1A" : ":";
    var text7 = kind === "manual" ? t("detail.policy.manualOnly") : kind === "none" ? t("detail.policy.blocked") : t("detail.policy.all");
    return h3(
      "div",
      { className: "dssm-detail-policy" },
      h3(
        "div",
        { className: "dssm-detail-policy-item" },
        h3("span", { className: "dssm-detail-policy-label" }, t("detail.invocation") + colon),
        h3("span", { className: "dssm-detail-policy-val" }, text7)
      )
    );
  }
  function renderSkillStatusIcon(key, title, cls) {
    var isSuccess = key === "status.enabled";
    var isWarn = key === "status.disabled";
    var isError = key === "status.invalid";
    var color2 = isSuccess ? "var(--dsw-alias-state-success-primary, #51b976)" : isWarn ? "var(--dsw-alias-state-warn-primary, #d49245)" : isError ? "var(--dsw-alias-state-error-primary, #ef7272)" : "var(--dsw-alias-label-tertiary, #a0a0a0)";
    var iconD = isSuccess ? "M8 0a8 8 0 100 16A8 8 0 008 0zm3.28 6.72l-4 4a.75.75 0 01-1.06 0l-2-2a.75.75 0 111.06-1.06L7 9.44l3.47-3.47a.75.75 0 011.06 1.06z" : isWarn ? "M8 0a8 8 0 100 16A8 8 0 008 0zm3 8.75H5a.75.75 0 010-1.5h6a.75.75 0 010 1.5z" : isError ? "M8.982 1.566a1.13 1.13 0 00-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767L8.982 1.566zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 01-1.1 0L7.1 5.995A.905.905 0 018 5zm.002 6a1 1 0 110 2 1 1 0 010-2z" : "M8.28 1.34a.75.75 0 00-.56 0l-6.5 2.5a.75.75 0 000 1.41l6.5 2.5a.75.75 0 00.56 0l6.5-2.5a.75.75 0 000-1.41l-6.5-2.5zm5.97 6.41L8 10.15 1.75 7.75l-.5.19a.75.75 0 000 1.41l6.5 2.5a.75.75 0 00.56 0l6.5-2.5a.75.75 0 000-1.41l-.56-.2zM14.25 11.5L8 13.9 1.75 11.5l-.5.19a.75.75 0 000 1.41l6.5 2.5a.75.75 0 00.56 0l6.5-2.5a.75.75 0 000-1.41l-.56-.19z";
    var tooltip = title || t(key);
    return h3(
      "span",
      {
        className: "dssm-status " + (cls || ""),
        title: tooltip,
        "aria-label": tooltip,
        style: { display: "inline-flex", alignItems: "center", justifyContent: "center", color: color2, width: 20, height: 20, verticalAlign: "middle" }
      },
      h3(
        "svg",
        { viewBox: "0 0 16 16", width: 14, height: 14, fill: "currentColor", "aria-hidden": true },
        h3("path", { d: iconD })
      )
    );
  }
  function renderSkill(root4, skill, workspacePath2) {
    var scoped = function(extra) {
      return workspacePath2 ? Object.assign({}, extra, { workspace: workspacePath2 }) : extra;
    };
    var enabled = isSkillEnabled(skill);
    var showSwitch = root4.toggleable !== false;
    var statusKey = skill.shadowedBy ? "status.shadowed" : skill.loadable === false ? "status.invalid" : enabled ? "status.enabled" : "status.disabled";
    var cls = skill.shadowedBy ? "dssm-shadowed" : enabled ? "dssm-enabled" : "dssm-disabled";
    var showStatus = !showSwitch || !!skill.shadowedBy || skill.loadable === false;
    var menu = [{ value: "detail", label: t("btn.detail") }];
    var categories = filters.group === "repo" ? [] : root4.categories || [];
    var currentCatId = skill.categoryId || "";
    categories.forEach(function(category) {
      if (category.id !== currentCatId) {
        menu.push({ value: "category:" + category.id, label: t("category.assign", { name: category.name }) });
      }
    });
    if (categories.length && currentCatId !== "") {
      menu.push({ value: "category:", label: t("category.assign", { name: t("category.uncategorized") }) });
    }
    menu.push({ value: "note", label: t("skill.editNote") });
    if (root4.mutable && skill.linked !== true) menu.push({ value: "trash", label: t("btn.trash"), danger: true });
    var statusTitle = skill.shadowedBy ? t("status.shadowedBy", { source: function() {
      var winner = allRoots.find(function(item) {
        return item.key === skill.shadowedBy.root;
      });
      return winner ? rootDisplayName(t, winner) : skill.shadowedBy.root;
    }() }) : void 0;
    var skillActions = [
      h3(SourceSelect, { action: true, icon: moreIcon(), label: t("btn.more"), disabled: busy, options: menu, onChange: function(action) {
        if (action === "detail") openDetail(root4, skill, workspacePath2);
        if (action.indexOf("category:") === 0) {
          var categoryId = action.slice("category:".length);
          var category = categories.find(function(item) {
            return item.id === categoryId;
          });
          post2("/category-assign", scoped({ root: root4.key, name: skill.name, category: categoryId }), "category.assigned", { name: skill.name, category: category ? category.name : t("category.uncategorized") });
        }
        if (action === "note") {
          setSkillNoteText(skill.customNote || "");
          setModal({ type: "skill-note", root: root4.key, name: skill.name, note: skill.customNote || "", workspace: workspacePath2 });
        }
        if (action === "trash") setModal({ type: "trash-confirm", root: root4.key, name: skill.name, workspace: workspacePath2 });
      } })
    ];
    skillActions.push(h3("div", { className: "dssm-row-state" }, showStatus ? renderSkillStatusIcon(statusKey, statusTitle, cls) : null, showSwitch ? enableSwitch(enabled, t("skill.toggle") + " " + skill.name, busy || root4.enabled === false || !enabled && skill.loadable === false, function() {
      post2(enabled ? "/disable" : "/enable", scoped({ root: root4.key, name: skill.name }));
    }) : null));
    var skillName = skill.declaredName || skill.name;
    var hasCustomNote = typeof skill.customNote === "string" && skill.customNote.trim().length > 0;
    var description = hasCustomNote ? skill.customNote : skill.description || t("note.missing");
    var canDrag = filters.group !== "repo" && (root4.mutable === true || !!(root4.categories && root4.categories.length));
    var descTitle = hasCustomNote ? skill.description ? `${skill.customNote}
(${t("detail.description")}: ${skill.description})` : skill.customNote : skill.description || void 0;
    return h3(
      "div",
      {
        key: root4.key + ":" + skill.name,
        className: "dssm-skill-row",
        draggable: canDrag,
        onDragStart: filters.group === "repo" ? void 0 : function(e) {
          if (!canDrag) return;
          var dragInfo = { root: root4.key, name: skill.name, currentCategoryId: skill.categoryId || "" };
          draggingRef.current = dragInfo;
          e.dataTransfer.setData("text/plain", JSON.stringify(dragInfo));
          e.dataTransfer.effectAllowed = "move";
          e.currentTarget.classList.add("dragging");
        },
        onDragEnd: filters.group === "repo" ? void 0 : function(e) {
          draggingRef.current = null;
          e.currentTarget.classList.remove("dragging");
          clearDragHighlights(e.currentTarget);
        },
        onDragOver: filters.group === "repo" ? void 0 : function(e) {
          if (!draggingRef.current || draggingRef.current.root !== root4.key || draggingRef.current.name === skill.name) return;
          e.preventDefault();
          e.stopPropagation();
          var rect = e.currentTarget.getBoundingClientRect();
          e.currentTarget.classList.toggle("drop-before", e.clientY < rect.top + rect.height / 2);
          e.currentTarget.classList.toggle("drop-after", e.clientY >= rect.top + rect.height / 2);
        },
        onDragLeave: filters.group === "repo" ? void 0 : function(e) {
          e.currentTarget.classList.remove("drop-before", "drop-after");
        },
        onDrop: filters.group === "repo" ? void 0 : function(e) {
          e.preventDefault();
          e.stopPropagation();
          e.currentTarget.classList.remove("drop-before", "drop-after");
          var dragInfo = draggingRef.current;
          draggingRef.current = null;
          clearDragHighlights(e.currentTarget);
          if (!dragInfo || dragInfo.root !== root4.key || dragInfo.name === skill.name) return;
          var rect = e.currentTarget.getBoundingClientRect();
          post2("/category-move", scoped({ root: root4.key, name: dragInfo.name, category: skill.categoryId || "", targetName: skill.name, position: e.clientY < rect.top + rect.height / 2 ? "before" : "after" }), "category.moved", { name: dragInfo.name });
        }
      },
      canDrag ? h3("div", { className: "dssm-drag-handle", title: t("category.dragTip") }, "\u22EE\u22EE") : null,
      h3("div", { className: "dssm-skill-copy" }, h3("div", { className: "dssm-name" }, skillName, renderInvocationBadge(skill), renderTokenBadge(skill.descriptionTokens, skill.bodyTokens, skill)), h3("div", { className: "dssm-skill-desc" + (hasCustomNote ? " dssm-custom-note" : ""), title: descTitle }, description), renderLinkedNote(skill), renderFallback(skill)),
      h3("div", { className: "dssm-skill-actions" }, skillActions)
    );
  }
  var rows = roots.flatMap(function(root4) {
    return (root4.skills || []).map(function(skill) {
      return { root: root4, skill };
    });
  });
  var filteredRows = rows.filter(function(row) {
    return (!activeSource || row.root.key === activeSource) && (!filters.status || skillStatus(row.skill) === filters.status) && matchSkillQuery(Object.assign({}, row.skill, { rootLabel: rootDisplayName(t, row.root) }), query);
  });
  var summary = countSkillStatuses(rows);
  var enabledDescriptionTokens = sumEnabledDescriptionTokens(rows);
  function sourceExtra(root4, workspacePath2, displayName) {
    var scoped = workspacePath2 ? { root: root4.key, workspace: workspacePath2 } : { root: root4.key };
    var actions = [];
    if (filters.group !== "repo") actions.push(iconButton(t("category.create"), strokeIcon("M8 2.5v11M2.5 8h11"), function() {
      setCategoryName("");
      setModal({ type: "category-create", root: root4.key, workspace: workspacePath2 });
    }, false, busy));
    if (!workspacePath2 && root4.mutable !== true && root4.kind !== "preset" && root4.scope !== "preset") actions.push(iconButton(t("rootPath.edit"), strokeIcon("M2.5 4.5h3l1.3 1.5h6.7v6h-11z"), function() {
      openRootPath(root4);
    }, false, busy));
    if (canToggleSource(root4)) actions.push(h3(SkillSwitch, { on: root4.enabled, disabled: busy, label: t("source.toggle") + " " + displayName, onClick: function() {
      post2(root4.enabled ? "/source-disable" : "/source-enable", scoped);
    } }));
    return h3("span", { className: "dssm-source-actions", onClick: function(event) {
      event.stopPropagation();
    } }, actions);
  }
  function AntdFolderClosed() {
    return h3(
      "svg",
      { viewBox: "0 0 1024 1024", width: 16, height: 16, "aria-hidden": true, focusable: "false", style: { display: "inline-block", verticalAlign: "-2px", flexShrink: 0, marginRight: 6 } },
      h3("path", { fill: "#f59e0b", d: "M880 298.4H521L403.7 186.2a8.15 8.15 0 0 0-5.5-2.2H144c-17.7 0-32 14.3-32 32v592c0 17.7 14.3 32 32 32h736c17.7 0 32-14.3 32-32V330.4c0-17.7-14.3-32-32-32z" })
    );
  }
  function AntdFolderOpen() {
    return h3(
      "svg",
      { viewBox: "0 0 1024 1024", width: 16, height: 16, "aria-hidden": true, focusable: "false", style: { display: "inline-block", verticalAlign: "-2px", flexShrink: 0, marginRight: 6 } },
      h3("path", { fill: "#fde68a", opacity: 0.85, d: "M159 768h612.3l103.4-256H262.3z" }),
      h3("path", { fill: "#f59e0b", d: "M928 444H820V330.4c0-17.7-14.3-32-32-32H473L355.7 186.2a8.15 8.15 0 0 0-5.5-2.2H96c-17.7 0-32 14.3-32 32v592c0 17.7 14.3 32 32 32h698c13 0 24.8-7.9 29.7-20l134-332c1.5-3.8 2.3-7.9 2.3-12 0-17.7-14.3-32-32-32zM136 256h188.5l119.6 114.4H748V444H238c-13 0-24.8 7.9-29.7 20L136 643.2V256zm635.3 512H159l103.3-256h612.4L771.3 768z" })
    );
  }
  function clearDragHighlights(element2) {
    var section = element2.closest(".dssm-section");
    if (!section) return;
    Array.prototype.forEach.call(section.querySelectorAll(".dssm-cat.drag-over, .dssm-skill-row.drop-before, .dssm-skill-row.drop-after"), function(target) {
      target.classList.remove("drag-over", "drop-before", "drop-after");
    });
  }
  function renderCategory(root4, bucket, workspacePath2, keyPrefix, allRootRows) {
    var expansionKey = JSON.stringify(["category", keyPrefix || "", root4.key, bucket.id || "none"]);
    var open = expanded[expansionKey] === void 0 ? !!(query || filters.status) : expanded[expansionKey];
    var counted = bucket.scope || bucket.skills;
    var usable = counted.filter(function(row) {
      return row.skill.loadable !== false;
    });
    var enabledCount = usable.filter(function(row) {
      return isSkillEnabled(row.skill);
    }).length;
    var allOn = usable.length > 0 && enabledCount === usable.length;
    var scoped = function(extra) {
      return workspacePath2 ? Object.assign({}, extra, { workspace: workspacePath2 }) : extra;
    };
    return h3(
      "section",
      {
        key: root4.key + ":" + (bucket.id || "none"),
        className: "dssm-cat",
        "aria-label": bucket.name,
        onDragOver: function(e) {
          e.preventDefault();
          if (draggingRef.current && draggingRef.current.root === root4.key && draggingRef.current.currentCategoryId !== bucket.id) {
            e.currentTarget.classList.add("drag-over");
          } else {
            e.currentTarget.classList.remove("drag-over");
          }
        },
        onDragLeave: function(e) {
          var related = e.relatedTarget;
          if (related && e.currentTarget.contains(related)) return;
          e.currentTarget.classList.remove("drag-over");
        },
        onDrop: function(e) {
          e.preventDefault();
          draggingRef.current = null;
          e.currentTarget.classList.remove("drag-over");
          clearDragHighlights(e.currentTarget);
          try {
            var dragData = JSON.parse(e.dataTransfer.getData("text/plain") || "{}");
            if (dragData && dragData.name && dragData.root === root4.key) {
              if (dragData.currentCategoryId !== bucket.id) {
                post2("/category-assign", scoped({ root: root4.key, name: dragData.name, category: bucket.id }), "category.assigned", { name: dragData.name, category: bucket.name });
              }
            }
          } catch (_err) {
          }
        }
      },
      h3(
        "div",
        { className: "dssm-cat-head" },
        h3(
          "button",
          { type: "button", className: "dssm-cat-main", "aria-expanded": open, onClick: function() {
            setExpanded(function(previous3) {
              var next = {};
              next[expansionKey] = !open;
              return Object.assign({}, previous3, next);
            });
          } },
          h3("span", { className: "dssm-cat-title" }, open ? h3(AntdFolderOpen) : h3(AntdFolderClosed), bucket.name),
          h3("span", { className: "dssm-count" }, t("category.progress", { count: counted.length, enabled: enabledCount, usable: usable.length }))
        ),
        h3(
          "span",
          { className: "dssm-source-actions", onClick: function(event) {
            event.stopPropagation();
          } },
          bucket.locked ? null : iconButton(t("category.addSkills"), strokeIcon("M8 2.5v11M2.5 8h11"), function() {
            var catMap = {};
            (root4.categories || []).forEach(function(c) {
              catMap[c.id] = c.name;
            });
            var sourceList = allRootRows || bucket.scope || bucket.skills;
            var candidates2 = sourceList.filter(function(row) {
              return row.skill.categoryId !== bucket.id;
            }).map(function(row) {
              return {
                name: row.skill.name,
                declaredName: row.skill.declaredName,
                description: row.skill.description,
                currentCatName: row.skill.categoryId && catMap[row.skill.categoryId] || t("category.uncategorized")
              };
            });
            setAddSelection({});
            setAddSearch("");
            setModal({ type: "category-add", root: root4.key, id: bucket.id, name: bucket.name, workspace: workspacePath2, skills: candidates2 });
          }, false, busy),
          bucket.locked ? null : iconButton(t("category.rename"), strokeIcon("M9.2 2.8l4 4L6.2 13.8H2.2v-4z"), function() {
            setCategoryName(bucket.name);
            setModal({ type: "category-rename", root: root4.key, id: bucket.id, name: bucket.name, workspace: workspacePath2 });
          }, false, busy),
          bucket.locked ? null : iconButton(t("category.delete"), strokeIcon("M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.7 8.5h4.6L11 4.5"), function() {
            setModal({ type: "category-delete", root: root4.key, id: bucket.id, name: bucket.name, workspace: workspacePath2 });
          }, true, busy),
          enableSwitch(allOn, t("category.toggle") + " " + bucket.name, busy || root4.enabled === false || usable.length === 0, function() {
            post2(allOn ? "/category-disable" : "/category-enable", scoped({ root: root4.key, category: bucket.id }));
          })
        )
      ),
      open ? bucket.skills.length ? h3("div", { className: "dssm-skill-list" }, bucket.skills.map(function(row) {
        return renderSkill(root4, row.skill, workspacePath2);
      })) : h3("div", { className: "dssm-empty" }, t("category.empty")) : null
    );
  }
  function renderSourceBody(root4, filtered, workspacePath2, keyPrefix, scopeRows) {
    var categories = root4.categories || [];
    var orderRows = function(list4, id) {
      var savedOrder = root4.categoryOrder && root4.categoryOrder[id] || [];
      var ranks = /* @__PURE__ */ Object.create(null);
      savedOrder.forEach(function(name2, index3) {
        ranks[name2] = index3;
      });
      return list4.map(function(row, index3) {
        return { row, index: index3, rank: ranks[row.skill.name] };
      }).sort(function(a, b) {
        if (a.rank !== void 0 && b.rank !== void 0) return a.rank - b.rank;
        if (a.rank !== void 0) return -1;
        if (b.rank !== void 0) return 1;
        return a.index - b.index;
      }).map(function(item) {
        return item.row;
      });
    };
    if (!categories.length) return filtered.length ? h3("div", { className: "dssm-skill-list" }, orderRows(filtered, "").map(function(row) {
      return renderSkill(root4, row.skill, workspacePath2);
    })) : h3("div", { className: "dssm-empty" }, t("empty.source"));
    var known = {};
    var allRows = scopeRows || filtered;
    categories.forEach(function(item) {
      known[item.id] = true;
    });
    var inCategory = function(list4, id) {
      return orderRows(list4.filter(function(row) {
        return id ? row.skill.categoryId === id : !row.skill.categoryId || !known[row.skill.categoryId];
      }), id);
    };
    var buckets = categories.map(function(item) {
      return { id: item.id, name: item.name, locked: false, skills: inCategory(filtered, item.id), scope: inCategory(allRows, item.id) };
    });
    buckets.push({ id: "", name: t("category.uncategorized"), locked: true, skills: inCategory(filtered, ""), scope: inCategory(allRows, "") });
    var searching = !!(query || filters.status);
    return h3("div", null, h3("p", { className: "dssm-note dssm-cat-note" }, t("category.note")), buckets.filter(function(bucket) {
      return !searching || bucket.skills.length;
    }).map(function(bucket) {
      return renderCategory(root4, bucket, workspacePath2, keyPrefix, allRows);
    }));
  }
  function renderRoot(root4, workspacePath2, rowsForRoot, keyPrefix) {
    var scopeRows = (rowsForRoot || rows).filter(function(row) {
      return row.root.key === root4.key;
    });
    var filtered = (rowsForRoot || filteredRows).filter(function(row) {
      return row.root.key === root4.key;
    });
    if (activeSource && root4.key !== activeSource || (query || filters.status) && !filtered.length) return null;
    var expansionKey = JSON.stringify([filterKey, keyPrefix || "", root4.key, query, activeSource, filters.status]);
    var open = expanded[expansionKey] === void 0 ? workspacePath2 ? true : !!(query || activeSource || filters.status) : expanded[expansionKey];
    var displayName = workspacePath2 ? rootDisplayName(t, Object.assign({}, root4, { projectName: void 0 })) : rootDisplayName(t, root4);
    var readonlyRelative = (root4.kind === "preset" || root4.scope === "preset") && root4.native === false && root4.mutable === false;
    return h3(
      "section",
      { key: (keyPrefix || "") + root4.key, className: "dssm-source", "data-source-key": root4.key },
      h3(
        "div",
        { className: "dssm-source-head" },
        h3("button", { type: "button", className: "dssm-source-toggle", "aria-expanded": open, onClick: function() {
          setExpanded(function(previous3) {
            var next = {};
            next[expansionKey] = !open;
            return Object.assign({}, previous3, next);
          });
        } }, foldChevron(h3, open), h3("div", { className: "dssm-source-label" }, renderRootIcon(root4.key), h3("span", { className: "dssm-source-title" }, displayName), h3("span", { className: "dssm-count" }, t(countKey("summary.group", filtered.length), { count: filtered.length })), root4.overridden ? h3("span", { className: "dssm-source-custom" }, t("rootPath.custom")) : readonlyRelative ? h3("span", { className: "dssm-source-custom", title: t("preset.readonlyRelativeTitle") }, t("preset.readonlyRelative")) : null, h3("span", { className: "dssm-source-path", title: root4.overridden ? t("rootPath.overrideTitle", { path: root4.defaultPath || "" }) : readonlyRelative ? t("preset.readonlyRelativeTitle") : root4.path }, root4.path))),
        sourceExtra(root4, workspacePath2, displayName)
      ),
      open ? h3("div", { className: "dssm-source-body", role: "region" }, renderSourceBody(root4, filtered, workspacePath2, keyPrefix, scopeRows)) : null
    );
  }
  function provenanceOfRow(row) {
    return row.skill.provenance || null;
  }
  function safeProvenanceUrl(value) {
    if (!value) return null;
    try {
      var parsed = new URL(value);
      return (parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.hostname ? parsed.href : null;
    } catch (_error) {
      return null;
    }
  }
  function collectProvenanceRoots() {
    var groups = /* @__PURE__ */ Object.create(null);
    var order2 = [];
    filteredRows.forEach(function(row) {
      var rootGroup = groups[row.root.key];
      if (!rootGroup) {
        rootGroup = { key: row.root.key, root: row.root, rows: [], repos: [], hasEvidence: false };
        groups[row.root.key] = rootGroup;
        order2.push(row.root.key);
      }
      rootGroup.rows.push(row);
      var provenance = provenanceOfRow(row);
      var repo = provenance && provenance.repo ? provenance.repo : null;
      var identity = provenance && provenance.identity;
      var repositoryKey = identity || repo;
      var repoKey = repositoryKey ? "repo:" + repositoryKey : "none";
      var repoGroup = null;
      for (var index3 = 0; index3 < rootGroup.repos.length; index3++) {
        if (rootGroup.repos[index3].key === repoKey) {
          repoGroup = rootGroup.repos[index3];
          break;
        }
      }
      if (!repoGroup) {
        repoGroup = { key: repoKey, kind: repositoryKey && provenance ? provenance.kind : "root", repo: repo || identity || null, url: safeProvenanceUrl(provenance && provenance.url), fallback: !repositoryKey, rows: [], categories: [] };
        rootGroup.repos.push(repoGroup);
      }
      repoGroup.rows.push(row);
      if (repositoryKey && provenance) {
        var category = provenance.category || "";
        if (repoGroup.categories.indexOf(category) < 0) repoGroup.categories.push(category);
        rootGroup.hasEvidence = true;
      }
    });
    return order2.map(function(key) {
      var group = groups[key];
      group.repos.sort(function(a, b) {
        if (a.fallback !== b.fallback) return a.fallback ? 1 : -1;
        return String(a.repo || "").localeCompare(String(b.repo || ""));
      });
      return group;
    });
  }
  function categoryLabel(category) {
    return category || t("group.repoRoot");
  }
  function renderProvenanceSkills(rows2, workspacePath2) {
    return h3("div", { className: "dssm-skill-list" }, rows2.map(function(row) {
      return renderSkill(row.root, row.skill, workspacePath2);
    }));
  }
  function provenanceAutoOpen() {
    return !!(query || activeSource || filters.status);
  }
  function renderProvenanceCategory(rootGroup, repoGroup, category, rows2, workspacePath2) {
    var catKey = JSON.stringify(["provcat", filterKey, workspacePath2 || "", rootGroup.key, repoGroup.key, category, query, activeSource, filters.status]);
    var open = expanded[catKey] === void 0 ? provenanceAutoOpen() : expanded[catKey];
    return h3(
      "section",
      { className: "dssm-cat dssm-prov-cat", key: catKey },
      h3(
        "div",
        { className: "dssm-cat-head" },
        h3(
          "button",
          { type: "button", className: "dssm-cat-main", "aria-expanded": open, onClick: function() {
            setExpanded(function(previous3) {
              var next = {};
              next[catKey] = !open;
              return Object.assign({}, previous3, next);
            });
          } },
          foldChevron(h3, open),
          h3("span", { className: "dssm-cat-title" }, categoryLabel(category)),
          h3("span", { className: "dssm-count" }, t(countKey("summary.group", rows2.length), { count: rows2.length }))
        )
      ),
      open ? renderProvenanceSkills(rows2, workspacePath2) : null
    );
  }
  function renderProvenanceRepo(rootGroup, repoGroup, workspacePath2) {
    var expansionKey = JSON.stringify(["provrepo", filterKey, workspacePath2 || "", rootGroup.key, repoGroup.key, query, activeSource, filters.status]);
    var open = expanded[expansionKey] === void 0 ? provenanceAutoOpen() : expanded[expansionKey];
    var label = repoGroup.repo || t("group.unknownSource");
    var categories = repoGroup.categories.slice().sort(function(a, b) {
      if (!a) return 1;
      if (!b) return -1;
      return a.localeCompare(b);
    });
    var body = null;
    if (open) {
      if (!categories.length || categories.length === 1 && !categories[0]) body = renderProvenanceSkills(repoGroup.rows, workspacePath2);
      else body = categories.map(function(category) {
        var rows2 = repoGroup.rows.filter(function(row) {
          var provenance = provenanceOfRow(row);
          return (provenance && provenance.category || "") === category;
        });
        return rows2.length ? renderProvenanceCategory(rootGroup, repoGroup, category, rows2, workspacePath2) : null;
      });
    }
    return h3(
      "section",
      { className: "dssm-cat dssm-prov-repo", key: repoGroup.key },
      h3(
        "div",
        { className: "dssm-cat-head" },
        h3(
          "button",
          { type: "button", className: "dssm-cat-main", "aria-expanded": open, onClick: function() {
            setExpanded(function(previous3) {
              var next = {};
              next[expansionKey] = !open;
              return Object.assign({}, previous3, next);
            });
          } },
          foldChevron(h3, open),
          repoGroup.repo ? renderRepoBrandIconByUrl(repoGroup.url, repoGroup.repo) : null,
          h3("span", { className: "dssm-cat-title" }, label),
          h3("span", { className: "dssm-count" }, t(countKey("summary.group", repoGroup.rows.length), { count: repoGroup.rows.length })),
          h3("span", { className: "dssm-prov-badge", title: t("group.hint") }, t("group.evidence." + repoGroup.kind))
        ),
        repoGroup.url ? h3("span", { className: "dssm-source-actions" }, h3("a", { className: "dssm-icon-action dssm-prov-repo-link", href: repoGroup.url, target: "_blank", rel: "noopener noreferrer", "aria-label": t("group.openRepo", { repo: repoGroup.repo || "" }), title: t("group.openRepo", { repo: repoGroup.repo || "" }), style: { width: 22, minWidth: 22, height: 22, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: "var(--dsw-radius-sm, 8px)" } }, strokeIcon("M12 9.5V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3.5m4-1h3.5m0 0v3.5m0-3.5L7 10"))) : null
      ),
      body
    );
  }
  function renderProvenanceRoot(rootGroup, workspacePath2) {
    var expansionKey = JSON.stringify(["provroot", filterKey, workspacePath2 || "", rootGroup.key, query, activeSource, filters.status]);
    var open = expanded[expansionKey] === void 0 ? !!(workspacePath2 || provenanceAutoOpen()) : expanded[expansionKey];
    var displayName = workspacePath2 ? rootDisplayName(t, Object.assign({}, rootGroup.root, { projectName: void 0 })) : rootDisplayName(t, rootGroup.root);
    var readonlyRelative = (rootGroup.root.kind === "preset" || rootGroup.root.scope === "preset") && rootGroup.root.native === false && rootGroup.root.mutable === false;
    var body = null;
    if (open) {
      body = h3(
        "div",
        { className: "dssm-source-body", role: "region" },
        rootGroup.hasEvidence ? rootGroup.repos.map(function(repoGroup) {
          return renderProvenanceRepo(rootGroup, repoGroup, workspacePath2);
        }) : renderProvenanceSkills(rootGroup.rows, workspacePath2)
      );
    }
    return h3(
      "section",
      { key: rootGroup.key, className: "dssm-source", "data-source-key": rootGroup.key },
      h3(
        "div",
        { className: "dssm-source-head" },
        h3(
          "button",
          { type: "button", className: "dssm-source-toggle", "aria-expanded": open, onClick: function() {
            setExpanded(function(previous3) {
              var next = {};
              next[expansionKey] = !open;
              return Object.assign({}, previous3, next);
            });
          } },
          foldChevron(h3, open),
          h3(
            "div",
            { className: "dssm-source-label" },
            renderRootIcon(rootGroup.root.key),
            h3("span", { className: "dssm-source-title" }, displayName),
            h3("span", { className: "dssm-count" }, t(countKey("summary.group", rootGroup.rows.length), { count: rootGroup.rows.length })),
            readonlyRelative ? h3("span", { className: "dssm-source-custom", title: t("preset.readonlyRelativeTitle") }, t("preset.readonlyRelative")) : null,
            rootGroup.hasEvidence ? null : h3("span", { className: "dssm-prov-badge", title: t("group.noRepo") }, t("group.unknownSource")),
            h3("span", { className: "dssm-source-path", title: readonlyRelative ? t("preset.readonlyRelativeTitle") : rootGroup.root.path }, rootGroup.root.path)
          )
        ),
        sourceExtra(rootGroup.root, workspacePath2, displayName)
      ),
      body
    );
  }
  function renderProvenanceList(workspacePath2) {
    var rootGroups = collectProvenanceRoots();
    if (!rootGroups.length) return h3("div", { className: "dssm-empty" }, query || filters.status ? t("empty.search") : t("empty.source"));
    var reposSeen = /* @__PURE__ */ Object.create(null);
    rootGroups.forEach(function(group) {
      group.repos.forEach(function(repoGroup) {
        if (!repoGroup.fallback) reposSeen[repoGroup.key] = true;
      });
    });
    var repoCount = Object.keys(reposSeen).length;
    var unknownCount = 0;
    rootGroups.forEach(function(group) {
      group.repos.forEach(function(repoGroup) {
        if (repoGroup.fallback) unknownCount += repoGroup.rows.length;
      });
    });
    return h3(
      "div",
      { className: "dssm-sources dssm-provenance" },
      h3("p", { className: "dssm-note dssm-prov-note" }, h3("strong", null, t("group.provenanceCount", { repos: repoCount, unknown: unknownCount })), " ", t("group.hint")),
      rootGroups.map(function(group) {
        return renderProvenanceRoot(group, workspacePath2);
      })
    );
  }
  function renderList() {
    var project = scope === "project", path2 = project ? selectedWorkspace : void 0;
    var body;
    if (filters.group === "repo") body = renderProvenanceList(path2);
    else {
      var groups = roots.map(function(root4) {
        return renderRoot(root4, path2, void 0, path2 ? path2 + "|" : void 0);
      }).filter(Boolean);
      body = groups.length ? groups : h3("div", { className: "dssm-empty" }, query || filters.status ? t("empty.search") : t("empty.source"));
    }
    if (project) {
      if (workspaceList.error) body = h3("div", { className: "dssm-feedback dssm-error", role: "alert" }, t("workspace.listFailed", { error: workspaceList.error }));
      else if (workspaceList.loading || selectedWorkspace && (!selectedDetail || selectedDetail.loading)) body = h3("div", { className: "dssm-empty" }, t("workspace.loading"));
      else if (!selectedWorkspace) body = h3("div", { className: "dssm-empty" }, t(workspaceRows.length ? "workspace.unavailable" : "project.empty"));
      else if (selectedDetail?.error) body = h3("div", { className: "dssm-feedback dssm-error", role: "alert" }, t("workspace.loadFailed", { error: selectedDetail.error }));
      else if (!rows.length && !query && !filters.status) body = h3("div", { className: "dssm-empty" }, t("workspace.noSkills"));
    }
    return h3("div", { key: "sources", id: "dssm-scope-panel", role: "tabpanel", "aria-labelledby": "dssm-tab-" + scope, className: "dssm-sources" }, body);
  }
  function renderTrash() {
    return h3(
      "div",
      { key: "trash", id: "dssm-scope-panel", role: "tabpanel", "aria-labelledby": "dssm-tab-trash", className: "dssm-trash-panel" },
      data.trash.length ? data.trash.map(function(item) {
        return h3(
          "div",
          { key: item.id, className: "dssm-trash-item", role: "group", "aria-label": item.name },
          h3(
            "div",
            { className: "dssm-trash-main" },
            h3("div", { className: "dssm-name" }, item.name),
            h3(
              "div",
              { className: "dssm-trash-meta" },
              h3("time", { dateTime: item.deletedAt }, t("trash.deletedAt", { time: formatTrashTime(t, item.deletedAt) })),
              h3("span", { className: "dssm-trash-source" }, t("trash.source", { source: trashRootLabel(item) }))
            )
          ),
          h3(
            "div",
            { className: "dssm-trash-actions" },
            iconButton(t("btn.restore"), strokeIcon("M3.5 6.5A4.5 4.5 0 1 1 5 11.5M3.5 3.5v3h3"), function() {
              post2("/trash-restore", trashRestoreBody(item), "result.restored", { name: item.name }).catch(function() {
              });
            }, false, busy),
            iconButton(t("btn.delete.forever"), strokeIcon("M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.7 8.5h4.6L11 4.5"), function() {
              setModal({ type: "delete-confirm", id: item.id, name: item.name });
            }, true, busy)
          )
        );
      }) : h3("div", { className: "dssm-empty" }, t("trash.empty"))
    );
  }
  var repositoryUI = useRepositoryUI({
    active: scope === "repositories",
    t,
    onInstalled: async function(target) {
      var state = await refresh(false);
      if (!state) throw new Error("Local skills refresh failed");
      if (target.scope === "workspace") {
        workspaceEpoch.current++;
        setWorkspaceDetails({});
        var projects = await loadWorkspaces(false);
        if (!projects.some(function(row) {
          return row.available && workspacePath(row) === target.workspace;
        }) || !await loadWorkspaceDetail(target.workspace)) throw new Error("Local project skills refresh failed");
      }
    },
    onNavigate: function(target) {
      var nextScope = target.scope === "workspace" ? "project" : "user";
      setSavedFilters(function(previous3) {
        return Object.assign({}, previous3, { [nextScope]: { query: target.name, source: target.scope === "workspace" ? "" : "dsh", status: "", group: "" } });
      });
      setExpanded(function(previous3) {
        var next = Object.assign({}, previous3), prefix = target.scope === "workspace" ? target.workspace + "|" : "";
        Object.keys(next).forEach(function(key) {
          var parts;
          try {
            parts = JSON.parse(key);
          } catch {
            return;
          }
          if (!Array.isArray(parts) || parts[1] !== prefix) return;
          if (parts[0] === nextScope && parts[3] === target.name || parts[0] === "category" && (nextScope === "project" || parts[2] === "dsh")) delete next[key];
        });
        return next;
      });
      if (target.scope === "workspace") {
        selectedWorkspaceRef.current = target.workspace;
        setSelectedWorkspace(target.workspace);
        loadWorkspaces(true, true);
      }
      setScope(nextScope);
    }
  });
  function getTabIcon(tabVal) {
    var d = tabVal === "user" ? "M8 0a8 8 0 100 16A8 8 0 008 0zm6.5 8a6.5 6.5 0 01-.65 2.82L10.3 8.35a.75.75 0 00-1.06 0L8.2 9.4V6.5a.75.75 0 00-.75-.75h-1V4.25a.75.75 0 00-.75-.75h-1a6.47 6.47 0 013.3-1.95v1.2a.75.75 0 00.75.75h1.5a.75.75 0 00.75-.75V2.3A6.52 6.52 0 0114.5 8z" : tabVal === "project" ? "M1.75 2.5h3.44l1.5 1.5h7.56c.966 0 1.75.784 1.75 1.75v7.5a1.75 1.75 0 01-1.75 1.75H1.75A1.75 1.75 0 010 13.25V4.25C0 3.284.784 2.5 1.75 2.5z" : tabVal === "repositories" ? "M8 0a8 8 0 100 16A8 8 0 008 0zm2.93 5.07l-1.5 4.5a.75.75 0 01-.43.43l-4.5 1.5a.375.375 0 01-.47-.47l1.5-4.5a.75.75 0 01.43-.43l4.5-1.5a.375.375 0 01.47.47z" : "M5.5 1.25h5c.4 0 .75.35.75.7V3h2.5c.5 0 .9.4.9.9s-.4.9-.9.9h-.35l-.65 8.1a1.6 1.6 0 0 1-1.6 1.5H4.85a1.6 1.6 0 0 1-1.6-1.5L2.6 4.8H2.25c-.5 0-.9-.4-.9-.9s.4-.9.9-.9H4.75V1.95c0-.4.35-.7.75-.7z";
    return h3(
      "svg",
      { viewBox: "0 0 16 16", width: 14, height: 14, fill: "currentColor", "aria-hidden": true },
      h3("path", { d })
    );
  }
  var tabItems = ["user", "project", "repositories", "trash"].map(function(value) {
    var text7 = t("scope." + value);
    var count = value === "trash" ? (data.trash || []).length : 0;
    var icon = getTabIcon(value);
    return {
      value,
      id: "dssm-tab-" + value,
      panelId: "dssm-scope-panel",
      label: count > 0 ? [icon, text7, h3("span", { className: "dssm-trash-count" }, count)] : [icon, text7]
    };
  });
  var tabs = h3(import_dsh_client_ui_primitives4.SegmentedTabs, { key: "tabs", className: "dssm-scope-tabs", label: t("scope.label"), value: scope, onChange: function(next) {
    setScope(next);
    if (next === "project" || next === "trash") loadWorkspaces(next === "project");
    if (next === "trash") refresh(true);
  }, items: tabItems });
  var statusOptions = [
    { type: "label", label: t("group.label") },
    { value: "group:", label: t("group.bySource") },
    { value: "group:repo", label: t("group.byRepo") },
    { type: "separator" },
    { type: "label", label: t("filter.status") },
    { value: "status:", label: t("filter.statusAll") },
    { value: "status:enabled", label: t("status.enabled") },
    { value: "status:disabled", label: t("status.disabled") },
    { value: "status:shadowed", label: t("status.shadowed") },
    { value: "status:invalid", label: t("status.invalid") }
  ];
  var statusText = filters.status ? t("status." + filters.status) : t("filter.statusAll");
  var statusGroupLabel = filters.group === "repo" ? statusText + " \xB7 " + t("group.byRepo") : statusText;
  function onStatusGroupChange(val) {
    if (val.startsWith("group:")) {
      updateFilter("group", val.slice(6));
    } else if (val.startsWith("status:")) {
      updateFilter("status", val.slice(7));
    }
  }
  var addMenuOptions = [
    { value: "create", label: t("btn.create") + "\u2026" },
    { value: "import", label: t("import.global") + "\u2026" }
  ];
  if (scope === "user") {
    addMenuOptions.push({ value: "root-path", label: t("rootPath.manage") + "\u2026" });
  }
  function onAddAction(actionVal) {
    if (actionVal === "create") openCreate();
    else if (actionVal === "import") openImport();
    else if (actionVal === "root-path") openRootPathPicker();
  }
  var skillControls = [scope === "project" ? null : h3("div", { key: "summary", className: "dssm-summary" }, [["total", "summary.total"], ["enabled", "summary.enabled"], ["disabled", "summary.disabled"], ["invalid", "summary.invalid"]].map(function(item) {
    return h3("div", { key: item[1], className: "dssm-stat" }, h3("strong", null, summary[item[0]]), t(countKey(item[1], summary[item[0]]), { count: summary[item[0]] }).replace(String(summary[item[0]]), ""));
  })), scope === "project" || enabledDescriptionTokens < 1 ? null : h3("div", { key: "token-summary", className: "dssm-token-summary", title: t("token.note") }, h3("span", { className: "dssm-token-badge dssm-token-summary-badge" }, "\u2248" + enabledDescriptionTokens.toLocaleString(t("format.locale"))), h3("span", { className: "dssm-token-summary-text" }, t("token.summaryLabel"))), h3(
    "div",
    { key: "filters", className: "dssm-filters" },
    scope === "project" ? null : h3("div", { className: "dssm-source-filter" }, h3(SourceSelect, { value: activeSource, label: t("filter.source"), options, onChange: setSource })),
    h3("div", { className: "dssm-status-filter" }, h3(SourceSelect, { values: ["group:" + (filters.group || ""), "status:" + (filters.status || "")], label: t("filter.status"), text: statusGroupLabel, options: statusOptions, onChange: onStatusGroupChange })),
    scope === "project" ? h3("div", { className: "dssm-project-filter" }, h3(SourceSelect, { value: selectedWorkspace, label: t("filter.workspace"), disabled: workspaceList.loading || !workspaceRows.length, options: workspaceRows.map(function(row) {
      return { value: workspacePath(row), label: row.name + (!row.available ? " \xB7 " + (row.errorCode === "ENOENT" || row.errorCode === "ENOTDIR" ? t("workspace.missing") : row.errorCode === "EACCES" || row.errorCode === "EPERM" ? t("workspace.unreadable") : t("workspace.unavailable")) : "") + (workspaceRows.filter(function(other) {
        return other.name === row.name;
      }).length > 1 ? " \xB7 " + workspacePath(row) : ""), disabled: !row.available || !workspacePath(row) };
    }), onChange: selectWorkspace })) : null,
    h3(Input, { className: "dssm-search", allowClear: true, value: query, "aria-label": t("search"), placeholder: t("search.placeholder"), onChange: function(e) {
      setQuery(e.target.value);
    } }),
    scope !== "trash" ? h3(
      "div",
      { className: "dssm-filter-actions" },
      filterActionButton(t("btn.refresh"), strokeIcon("M13.5 8A5.5 5.5 0 118 2.5c2.3 0 4.3 1.4 5.1 3.5m.4-3.5v3.5H10"), function() {
        refresh(false);
        if (scope === "project") refreshWorkspaceDetails();
      }, busy || snapshot.loading),
      h3(SourceSelect, {
        action: true,
        icon: strokeIcon("M8 2.5v11M2.5 8h11"),
        label: t("btn.add"),
        disabled: busy,
        options: addMenuOptions,
        onChange: onAddAction
      })
    ) : null
  )];
  var content3 = [h3("style", { key: "css" }, CSS), h3("div", { key: "head-card", className: "dssm-section-card" }, h3("div", { key: "head", className: "dssm-head" }, h3("div", { className: "dssm-title-block" }, h3("div", { className: "dssm-title-row" }, h3("h2", { className: "dssm-title" }, t("title"))), h3("p", { className: "dssm-desc" }, t("desc"))))), tabs].concat(scope === "trash" || scope === "repositories" ? [] : skillControls, [result && modal !== "import" ? h3("div", { key: "result", className: "dssm-feedback" + (result.warning ? " dssm-warning" : result.ok ? "" : " dssm-error") }, result.text) : null], (data.warnings || []).map(function(warning, index3) {
    return h3("div", { key: "warning-" + index3, className: "dssm-feedback dssm-warning", role: "alert" }, translateError(t, warning));
  }), [snapshot.error ? h3("div", { key: "error", className: "dssm-feedback dssm-error" }, snapshot.error) : null, scope === "repositories" ? repositoryUI.content : snapshot.loading && !snapshot.data ? h3("div", { key: "loading", className: "dssm-empty" }, t("loading")) : scope === "trash" ? renderTrash() : renderList()]);
  if (modal === "create") content3.push(h3(Modal, { key: "create", title: t("create.title"), closeLabel: t("btn.close"), onClose: function() {
    setModal(null);
  } }, h3("div", { className: "dssm-form" }, h3(DestinationPicker, { t, value: createDestination, disabled: busy, allowAgents: true, workspaces: workspaceRows, userDestinations, presetDestinations, onChange: function(next) {
    setCreateDestination(Object.assign({}, createDestination, next));
  } }), [["name", "create.name", "create.name.placeholder"], ["description", "create.description", "create.description.placeholder"]].map(function(field) {
    return h3("label", { key: field[0], className: "dssm-field" }, h3("span", { className: "dssm-label" }, t(field[1])), h3(Input, { value: form[field[0]], placeholder: t(field[2]), onChange: function(e) {
      updateForm(field[0], e.target.value);
    } }));
  }), h3("label", { className: "dssm-field" }, h3("span", { className: "dssm-label" }, t("create.body")), h3(Input.TextArea, { rows: 8, value: form.body, placeholder: t("create.body.placeholder"), onChange: function(e) {
    updateForm("body", e.target.value);
  } })), h3("p", { className: "dssm-help" }, t("create.chat.note"))), h3("div", { className: "dssm-modal-actions" }, hostButton(t("btn.cancel"), function() {
    setModal(null);
  }, "outline"), hostButton(t("btn.create.now"), submitCreate, "primary", busy || !form.name.trim() || !form.description.trim() || !form.body.trim() || !destinationReady(createDestination, workspaceRows, userDestinations, presetDestinations)))));
  if (modal === "import") content3.push(h3(
    Modal,
    { key: "import", className: "dssm-modal-import", title: t("import.title"), closeLabel: t("btn.close"), onClose: function() {
      pickerOpenRef.current = false;
      setUpload(null);
      setResult(null);
      setModal(null);
    } },
    h3("input", { ref: importInputRef, className: "dssm-hidden-input", type: "file", accept: ".zip,.md", onChange: function(event) {
      selectUploadFiles(event.target.files);
      event.target.value = "";
    } }),
    h3("input", { ref: folderInputRef, className: "dssm-hidden-input", type: "file", multiple: true, webkitdirectory: "", directory: "", onChange: function(event) {
      selectUploadFiles(event.target.files);
      event.target.value = "";
    } }),
    h3(
      "div",
      { className: "dssm-dropzone", onDragOver: function(event) {
        event.preventDefault();
        event.currentTarget.classList.add("dssm-dropzone-active");
      }, onDragLeave: function(event) {
        event.currentTarget.classList.remove("dssm-dropzone-active");
      }, onDrop: function(event) {
        event.preventDefault();
        event.currentTarget.classList.remove("dssm-dropzone-active");
        droppedFiles(event.dataTransfer).then(selectUploadFiles).catch(function(error) {
          setResult({ ok: false, text: translateError(t, error) });
        });
      } },
      h3("span", { className: "dssm-dropzone-title" }, t("upload.drop.title")),
      h3("span", { className: "dssm-dropzone-copy" }, t("upload.drop.copy")),
      h3("div", { className: "dssm-upload-choices" }, h3("button", { type: "button", className: "dssm-upload-link", disabled: busy, onClick: function(event) {
        event.stopPropagation();
        openNativePicker(folderInputRef);
      } }, t("btn.folder.pick")), h3("span", { className: "dssm-upload-divider" }, "/"), h3("button", { type: "button", className: "dssm-upload-link", disabled: busy, onClick: function(event) {
        event.stopPropagation();
        openNativePicker(importInputRef);
      } }, t("btn.file.pick")))
    ),
    upload ? h3("div", { className: "dssm-file", title: upload.name }, h3("span", { className: "dssm-file-kind", "aria-hidden": "true" }, upload.kind === "zip" ? "ZIP" : upload.kind === "folder" ? "DIR" : "MD"), h3("span", { className: "dssm-file-name" }, upload.name), h3("span", { className: "dssm-file-meta" }, t(countKey("upload.selected", upload.count), { count: upload.count, size: upload.size < 1024 ? upload.size + " B" : Math.ceil(upload.size / 1024) + " KB" })), h3("button", { type: "button", className: "dssm-file-remove", "aria-label": t("upload.remove"), onClick: function() {
      setUpload(null);
    } }, "\xD7")) : null,
    h3(DestinationPicker, { t, value: importDestination, disabled: busy, allowAgents: true, workspaces: workspaceRows, userDestinations, presetDestinations, onChange: function(next) {
      setImportDestination(Object.assign({}, importDestination, next));
    } }),
    result ? h3("div", { className: "dssm-feedback" + (result.warning ? " dssm-warning" : result.ok ? "" : " dssm-error"), role: "alert" }, result.text) : null,
    h3("div", { className: "dssm-upload-requirements" }, h3("div", { className: "dssm-label" }, t("upload.requirements")), h3("ul", null, h3("li", null, t("upload.requirement.skill")), h3("li", null, t("upload.requirement.frontmatter")), h3("li", null, t("upload.requirement.copy")))),
    h3("div", { className: "dssm-modal-actions" }, hostButton(t("btn.cancel"), function() {
      pickerOpenRef.current = false;
      setUpload(null);
      setResult(null);
      setModal(null);
    }, "outline"), hostButton(busy ? t("upload.importing") : t("btn.import.now"), submitImport, "primary", busy || !upload || !destinationReady(importDestination, workspaceRows, userDestinations, presetDestinations)))
  ));
  if (modal && typeof modal === "object" && modal.type === "root-path") {
    var rootPathModal = modal;
    var scanResult = customSourceScan;
    content3.push(h3(
      Modal,
      {
        key: "root-path",
        title: t("rootPath.title", { name: rootPathModal.label }),
        closeLabel: t("btn.close"),
        onClose: function() {
          setModal(null);
          setRootPathError(null);
        }
      },
      h3(
        "div",
        { className: "dssm-form" },
        h3("p", { className: "dssm-note" }, t("rootPath.desc")),
        overridableRoots.length > 0 ? h3(
          "label",
          { className: "dssm-field" },
          h3("span", { className: "dssm-label" }, t("rootPath.source")),
          h3(SourceSelect, {
            value: rootPathModal.root,
            label: t("rootPath.source"),
            disabled: busy,
            options: overridableRoots.map(function(r) {
              return { value: r.key, label: rootDisplayName(t, r) };
            }),
            onChange: function(key) {
              var next = overridableRoots.find(function(r) {
                return r.key === key;
              });
              if (next) openRootPath(next);
            }
          })
        ) : null,
        h3(
          "label",
          { className: "dssm-field" },
          h3("span", { className: "dssm-label" }, t("rootPath.label")),
          h3(Input, { value: rootPathValue, placeholder: t("rootPath.placeholder"), disabled: busy, onChange: function(event) {
            setRootPathValue(event.target.value);
            setRootPathError(null);
          } })
        ),
        h3(
          "div",
          { className: "dssm-root-path-actions" },
          hostButton(t("rootPath.browse"), pickRootPathDirectory, "outline", busy || rootPathPicking),
          rootPathModal.defaultPath ? hostButton(t("rootPath.reset"), function() {
            saveRootPath(null);
          }, "outline", busy) : null,
          rootPathModal.root.indexOf("custom:") === 0 ? hostButton(t("customSource.remove"), function() {
            removeCustomSourceEntry(rootPathModal.root);
          }, "outline", busy) : null
        ),
        h3("p", { className: "dssm-help" }, t("rootPath.defaultHint", { path: rootPathModal.defaultPath || rootPathModal.path })),
        rootPathError ? h3("div", { className: "dssm-feedback dssm-error", role: "alert" }, rootPathError) : null,
        h3(
          "div",
          { className: "dssm-custom-sources" },
          h3(
            "div",
            { className: "dssm-custom-source-head" },
            h3("span", { className: "dssm-label" }, t("customSource.title")),
            hostButton(customSourceOpen ? t("btn.cancel") : t("customSource.add"), function() {
              if (customSourceOpen) {
                setCustomSourceOpen(false);
                setCustomSourceScan(null);
                setCustomSourceError(null);
              } else openCustomSourceForm();
            }, "outline", busy || customSourceBusy)
          ),
          h3("p", { className: "dssm-help" }, t("customSource.desc")),
          customSourceOpen ? h3(
            "div",
            { className: "dssm-form" },
            h3(
              "label",
              { className: "dssm-field" },
              h3("span", { className: "dssm-label" }, t("customSource.label")),
              h3(Input, { value: customSourceLabel, maxLength: 48, placeholder: t("customSource.label.placeholder"), disabled: busy || customSourceBusy, onChange: function(event) {
                setCustomSourceLabel(event.target.value);
              } })
            ),
            h3(
              "label",
              { className: "dssm-field" },
              h3("span", { className: "dssm-label" }, t("customSource.path")),
              h3(Input, { value: customSourcePath, placeholder: t("customSource.path.placeholder"), disabled: busy || customSourceBusy, onChange: function(event) {
                setCustomSourcePath(event.target.value);
                setCustomSourceError(null);
              } })
            ),
            h3(
              "div",
              { className: "dssm-root-path-actions" },
              hostButton(t("rootPath.browse"), pickCustomSourceDirectory, "outline", busy || customSourceBusy),
              hostButton(customSourceBusy ? t("customSource.scanning") : t("customSource.scan"), scanCustomSourceDirectory, "outline", busy || customSourceBusy || !(customSourcePath || "").trim()),
              hostButton(t("customSource.addOne"), function() {
                submitCustomSources([{ label: (customSourceLabel || "").trim(), path: (customSourcePath || "").trim() }]);
              }, "primary", busy || customSourceBusy || !(customSourcePath || "").trim())
            ),
            customSourceError ? h3("div", { className: "dssm-feedback dssm-error", role: "alert" }, customSourceError) : null,
            scanResult ? h3(
              "div",
              { className: "dssm-custom-scan" },
              h3("p", { className: "dssm-help" }, t("customSource.scanResult", { count: scanResult.candidates.length, path: scanResult.root })),
              scanResult.candidates.length ? h3("div", { className: "dssm-root-path-actions" }, hostButton(t("customSource.addAll"), function() {
                submitCustomSources(scanResult.candidates.filter(function(item) {
                  return !item.registered && !item.conflict;
                }).map(function(item) {
                  return { label: item.label, path: item.path, group: item.group };
                }));
              }, "primary", busy || customSourceBusy || !scanResult.candidates.some(function(item) {
                return !item.registered && !item.conflict;
              }))) : null,
              scanResult.candidates.map(function(item, index3) {
                return h3(
                  "div",
                  { key: "candidate-" + index3, className: "dssm-custom-candidate" },
                  h3(
                    "div",
                    { className: "dssm-custom-candidate-text" },
                    h3("span", { className: "dssm-custom-candidate-name" }, item.label),
                    h3("span", { className: "dssm-custom-candidate-meta" }, item.path + " \xB7 " + t(countKey("customSource.skillCount", item.skillCount), { count: item.skillCount }))
                  ),
                  item.registered ? h3("span", { className: "dssm-custom-candidate-state" }, t("customSource.registered")) : item.conflict ? h3("span", { className: "dssm-custom-candidate-state" }, t("customSource.conflict")) : hostButton(t("customSource.addOne"), function() {
                    submitCustomSources([{ label: item.label, path: item.path, group: item.group }]);
                  }, "outline", busy || customSourceBusy)
                );
              })
            ) : null
          ) : null
        )
      ),
      h3(
        "div",
        { className: "dssm-modal-actions" },
        hostButton(t("btn.cancel"), function() {
          setModal(null);
          setRootPathError(null);
        }, "outline"),
        hostButton(t("rootPath.save"), function() {
          saveRootPath((rootPathValue || "").trim());
        }, "primary", busy || !(rootPathValue || "").trim())
      )
    ));
  }
  if (modal === "detail") {
    var currentDetail = detail;
    var detailTitle = currentDetail ? currentDetail.declaredName || currentDetail.name : "";
    content3.push(h3(Modal, { key: "detail", className: "dssm-modal-wide", title: t("detail.title"), closeLabel: t("btn.close"), onClose: function() {
      setCopyState("idle");
      setDetailSkill(null);
      setModal(null);
    } }, currentDetail ? h3("div", { className: "dssm-detail" }, h3("div", { className: "dssm-detail-head" }, h3("div", { className: "dssm-name", title: detailTitle }, detailTitle), currentDetail.body ? h3(import_dsh_client_ui_primitives4.Button, { variant: "outline", size: "sm", "aria-live": "polite", onClick: function() {
      if (currentDetail && currentDetail.body) copyText(currentDetail.body);
    } }, copyState === "copied" ? t("detail.copied") : copyState === "failed" ? t("detail.copyFailed") : t("detail.copyBody")) : null), currentDetail.customNote ? h3("p", { className: "dssm-desc dssm-custom-note", title: t("detail.customNote") }, currentDetail.customNote) : null, currentDetail.description ? h3("p", { className: "dssm-desc" + (currentDetail.customNote ? " dssm-desc-secondary" : "") }, currentDetail.description) : null, h3("div", { className: "dssm-detail-path" }, currentDetail.path), renderDetailTokens(currentDetail.descriptionTokens, currentDetail.bodyTokens, detailSkill), renderDetailPolicy(detailSkill), currentDetail.diagnostics.length ? currentDetail.diagnostics.map(function(item, index3) {
      return h3("div", { key: index3, className: "dssm-diag" }, t(item.code, item.params || {}));
    }) : null, h3(Input.TextArea, { className: "dssm-detail-body", readOnly: true, value: currentDetail.body || "", rows: 16 })) : h3("div", { className: "dssm-empty" }, t("loading"))));
  }
  if (modal && typeof modal === "object" && modal.type === "trash-confirm") content3.push(h3(Modal, { key: "trash-confirm", title: t("confirm.trash.title"), description: t("confirm.trash.desc", { name: modal.name }), closeLabel: t("btn.close"), onClose: function() {
    setModal(null);
  }, footer: h3(React5.Fragment, null, hostButton(t("btn.cancel"), function() {
    setModal(null);
  }, "outline"), hostButton(t("btn.trash"), function() {
    post2("/delete", Object.assign({ root: modal.root, name: modal.name }, modal.workspace ? { workspace: modal.workspace } : {}), "result.trashed", { name: modal.name }).then(function() {
      setModal(null);
    }).catch(function() {
    });
  }, "danger", busy)) }));
  if (modal && typeof modal === "object" && modal.type === "delete-confirm") content3.push(h3(Modal, { key: "delete-confirm", title: t("confirm.delete.title"), description: t("confirm.delete.desc", { name: modal.name }), closeLabel: t("btn.close"), onClose: function() {
    setModal(null);
  }, footer: h3(React5.Fragment, null, hostButton(t("btn.cancel"), function() {
    setModal(null);
  }, "outline"), hostButton(t("btn.delete.forever"), function() {
    post2("/trash-delete", { id: modal.id }, "result.deleted", { name: modal.name }).then(function() {
      setModal(null);
    }).catch(function() {
    });
  }, "danger", busy)) }));
  if (modal && typeof modal === "object" && (modal.type === "category-create" || modal.type === "category-rename")) {
    var renaming = modal.type === "category-rename";
    var categoryModal = modal;
    var nameTrimmed = categoryName.trim();
    var canSubmit = !!nameTrimmed && (!renaming || nameTrimmed !== categoryModal.name);
    var submitCategory = function() {
      if (busy || !canSubmit) return;
      var request = renaming ? post2("/category-rename", { root: categoryModal.root, id: categoryModal.id, name: nameTrimmed, workspace: categoryModal.workspace }, "category.renamed") : post2("/category-create", { root: categoryModal.root, name: nameTrimmed, workspace: categoryModal.workspace }, "category.created", { name: nameTrimmed });
      request.then(function() {
        setModal(null);
      }).catch(function() {
      });
    };
    content3.push(h3(
      Modal,
      { key: modal.type, title: renaming ? t("category.rename") : t("category.create"), closeLabel: t("btn.close"), onClose: function() {
        setModal(null);
      } },
      h3(
        "div",
        { className: "dssm-form" },
        h3("label", { className: "dssm-field" }, h3("span", { className: "dssm-label" }, t("category.name")), h3(Input, { value: categoryName, maxLength: 24, "aria-label": t("category.name"), onChange: function(event) {
          setCategoryName(event.target.value);
        }, onPressEnter: submitCategory })),
        h3("p", { className: "dssm-help" }, t("category.note"))
      ),
      h3(
        "div",
        { className: "dssm-modal-actions" },
        hostButton(t("btn.cancel"), function() {
          setModal(null);
        }, "outline"),
        hostButton(renaming ? t("btn.confirm") : t("category.create"), submitCategory, "primary", busy || !canSubmit)
      )
    ));
  }
  if (modal && typeof modal === "object" && modal.type === "category-add") {
    var addModal = modal;
    var kw = addSearch.trim().toLowerCase();
    var availableList = addModal.skills.filter(function(s) {
      return !kw || s.name.toLowerCase().includes(kw) || s.declaredName && s.declaredName.toLowerCase().includes(kw) || s.description && s.description.toLowerCase().includes(kw);
    });
    var candidateNames = new Set(addModal.skills.map(function(s) {
      return s.name;
    }));
    var chosenCount = Object.keys(addSelection).filter(function(k) {
      return addSelection[k] && candidateNames.has(k);
    }).length;
    content3.push(h3(
      Modal,
      { key: "category-add", title: t("category.selectSkills", { name: addModal.name }), closeLabel: t("btn.close"), onClose: function() {
        setAddSelection({});
        setAddSearch("");
        setModal(null);
      } },
      h3(Input, { placeholder: t("search.placeholder"), value: addSearch, allowClear: true, onChange: function(e) {
        setAddSearch(e.target.value);
      } }),
      h3(
        "div",
        { className: "dssm-batch-list" },
        availableList.length ? availableList.map(function(item) {
          var isChecked = !!addSelection[item.name];
          return h3(
            "div",
            { key: item.name, className: "dssm-batch-item" + (isChecked ? " selected" : ""), onClick: function() {
              var next = Object.assign({}, addSelection);
              if (isChecked) delete next[item.name];
              else next[item.name] = true;
              setAddSelection(next);
            } },
            // 点击由整行 onClick 处理，复选框自身只反映状态，避免重复切换。
            h3(DisplayCheckbox, { className: "dssm-batch-check", checked: isChecked, label: item.declaredName || item.name, onChange: function() {
            } }),
            h3(
              "div",
              { className: "dssm-batch-info" },
              h3(
                "div",
                { className: "dssm-batch-name-row" },
                h3("span", { className: "dssm-batch-name" }, item.declaredName || item.name),
                item.currentCatName ? h3("span", { className: "dssm-batch-cat-tag" }, item.currentCatName) : null
              ),
              item.description ? h3("div", { className: "dssm-batch-desc", title: item.description }, item.description) : null
            )
          );
        }) : h3("div", { className: "dssm-empty" }, t("category.noAvailableSkills"))
      ),
      h3(
        "div",
        { className: "dssm-modal-actions" },
        hostButton(t("btn.cancel"), function() {
          setAddSelection({});
          setAddSearch("");
          setModal(null);
        }, "outline"),
        hostButton(t("category.addSkills") + (chosenCount ? " (" + chosenCount + ")" : ""), function() {
          var names = Object.keys(addSelection).filter(function(k) {
            return addSelection[k] && candidateNames.has(k);
          });
          if (!names.length) {
            setAddSelection({});
            setAddSearch("");
            setModal(null);
            return;
          }
          if (inflightRef.current) return;
          var scoped = function(extra) {
            return addModal.workspace ? Object.assign({}, extra, { workspace: addModal.workspace }) : extra;
          };
          inflightRef.current = true;
          setBusy(true);
          setAddSelection({});
          setAddSearch("");
          setModal(null);
          names.reduce(function(p, name2) {
            return p.then(function() {
              return sessionApi("/category-assign", { method: "POST", headers: MUTATION_HEADERS, body: JSON.stringify(scoped({ root: addModal.root, name: name2, category: addModal.id })) });
            });
          }, Promise.resolve()).then(async function() {
            const fresh = await refreshConfirmed(addModal.workspace);
            setResult(fresh ? { ok: true, text: t("category.batchAssigned", { count: names.length, category: addModal.name }) } : { ok: false, warning: true, text: t("mutation.refreshWarning") });
          }).catch(async function(err) {
            if (!clientMutations.getSnapshot()) await refreshConfirmed(addModal.workspace);
            setResult({ ok: false, text: translateError(t, err) });
          }).finally(function() {
            inflightRef.current = false;
            setBusy(false);
          });
        }, "primary", busy || !chosenCount)
      )
    ));
  }
  if (modal && typeof modal === "object" && modal.type === "skill-note") {
    var noteModal = modal;
    var noteTrimmed = skillNoteText.trim();
    var isChanged = noteTrimmed !== (noteModal.note || "");
    var submitSkillNote = function() {
      if (busy || !isChanged) return;
      var scopedPayload = noteModal.workspace ? { root: noteModal.root, name: noteModal.name, note: noteTrimmed, workspace: noteModal.workspace } : { root: noteModal.root, name: noteModal.name, note: noteTrimmed };
      post2("/skill-note", scopedPayload, noteTrimmed ? "note.updated" : "note.cleared", { name: noteModal.name }).then(function() {
        setModal(null);
      }).catch(function() {
      });
    };
    content3.push(h3(
      Modal,
      { key: "skill-note", title: t("note.title"), closeLabel: t("btn.close"), onClose: function() {
        setModal(null);
      } },
      h3(
        "div",
        { className: "dssm-form" },
        h3(
          "label",
          { className: "dssm-field" },
          h3("span", { className: "dssm-label" }, t("note.label")),
          h3(Input.TextArea, {
            value: skillNoteText,
            maxLength: 500,
            rows: 4,
            placeholder: t("note.placeholder"),
            "aria-label": t("note.label"),
            onChange: function(event) {
              setSkillNoteText(event.target.value);
            }
          })
        ),
        h3("p", { className: "dssm-help" }, t("note.help"))
      ),
      h3(
        "div",
        { className: "dssm-modal-actions" },
        hostButton(t("btn.cancel"), function() {
          setModal(null);
        }, "outline"),
        noteModal.note ? hostButton(t("note.clear"), function() {
          setSkillNoteText("");
        }, "outline", busy) : null,
        hostButton(t("btn.confirm"), submitSkillNote, "primary", busy || !isChanged)
      )
    ));
  }
  if (modal && typeof modal === "object" && modal.type === "category-delete") content3.push(h3(Modal, { key: "category-delete", title: t("confirm.category.title"), description: t("confirm.category.desc", { name: modal.name }), closeLabel: t("btn.close"), onClose: function() {
    setModal(null);
  }, footer: h3(React5.Fragment, null, hostButton(t("btn.cancel"), function() {
    setModal(null);
  }, "outline"), hostButton(t("category.delete"), function() {
    post2("/category-delete", { root: modal.root, id: modal.id, workspace: modal.workspace }, "category.deleted", { name: modal.name }).then(function() {
      setModal(null);
    }).catch(function() {
    });
  }, "danger", busy)) }));
  if (pendingMutation) content3.unshift(h3("div", { key: "pending-operation", className: "dssm-feedback dssm-warning", role: "alert" }, t("mutation.pending"), pendingMutation.phase === "pending" ? hostButton(t("mutation.check"), function() {
    void confirmMutation();
  }, "outline", bs[0]) : null));
  return h3("section", { className: "dssm-section" }, content3);
}
/*! §5 Host registration and exports */
var inject = ["slots", "locale"];
function apply(ctx) {
  localeService = ctx.locale;
  if (typeof ctx.inject === "function") {
    try {
      ctx.inject(["uiWorkspace"], function(scoped) {
        var workspace = scoped.uiWorkspace;
        if (workspace && typeof workspace.pickDirectory === "function") {
          var pickDirectory = workspace.pickDirectory.bind(workspace);
          workspacePickDirectory = function() {
            return pickDirectory();
          };
        }
      });
    } catch (_error) {
    }
  }
  ctx.effect(function() {
    return ctx.locale.register(NS, DICT);
  });
  var sidebarController;
  installSettingsNavIcon(ctx, function() {
    return ctx.locale.bind(NS)("title");
  });
  let offSettingsSection = null;
  let offSettingsNavIcon = null;
  let settingsSectionSupported = false;
  let settingsNavIconSupported = false;
  const mountSettingsSection = () => {
    if (!settingsSectionSupported || offSettingsSection) return;
    if (sidebarController && !sidebarController.isSettingsSectionEnabled()) return;
    try {
      const unreg = ctx.slots.register({ name: "settings.section", id: "skills-manager", order: 25, label: function() {
        return ctx.locale.bind(NS)("title");
      }, icon: "skill", locale: NS }, SkillManagerSection);
      offSettingsSection = typeof unreg === "function" ? unreg : () => {
      };
    } catch (reason) {
      console.warn("skills-manager: register settings.section failed:", reason);
      offSettingsSection = null;
    }
  };
  const unmountSettingsSection = () => {
    if (offSettingsSection) {
      try {
        offSettingsSection();
      } catch {
      }
      offSettingsSection = null;
    }
  };
  const registerSettingsNavIcon = () => {
    if (offSettingsNavIcon) return true;
    try {
      const unreg = ctx.slots.register({
        name: "settings.section.icon",
        id: "skills-manager",
        locale: NS
      }, SkillsNavIcon);
      offSettingsNavIcon = typeof unreg === "function" ? unreg : () => {
      };
      return true;
    } catch (reason) {
      console.warn("skills-manager: register settings.section.icon failed:", reason);
      offSettingsNavIcon = null;
      return false;
    }
  };
  const mountSettingsNavIcon = () => {
    if (!settingsNavIconSupported) return;
    if (sidebarController && !sidebarController.isSettingsSectionEnabled()) return;
    registerSettingsNavIcon();
  };
  const unmountSettingsNavIcon = () => {
    const unreg = offSettingsNavIcon;
    offSettingsNavIcon = null;
    if (!unreg) return;
    try {
      unreg();
    } catch {
    }
  };
  const syncSettingsSection = () => {
    if (sidebarController?.isSettingsSectionEnabled?.() ?? true) {
      mountSettingsSection();
      mountSettingsNavIcon();
    } else {
      unmountSettingsSection();
      unmountSettingsNavIcon();
    }
  };
  if (typeof ctx.slots?.inject === "function") {
    try {
      ctx.slots.inject("settings.section.icon", function() {
        settingsNavIconSupported = true;
        const releaseDeclaration = function() {
          settingsNavIconSupported = false;
          unmountSettingsNavIcon();
        };
        if (sidebarController && !sidebarController.isSettingsSectionEnabled()) return releaseDeclaration;
        if (!registerSettingsNavIcon()) return releaseDeclaration;
        return releaseDeclaration;
      });
    } catch (reason) {
      console.warn("skills-manager: inject settings.section.icon failed:", reason);
    }
  }
  ctx.slots.inject("settings.section", function() {
    settingsSectionSupported = true;
    try {
      if (sidebarController && !sidebarController.isSettingsSectionEnabled()) {
        return function() {
          settingsSectionSupported = false;
          unmountSettingsSection();
        };
      }
      const unreg = ctx.slots.register({ name: "settings.section", id: "skills-manager", order: 25, label: function() {
        return ctx.locale.bind(NS)("title");
      }, icon: "skill", locale: NS }, SkillManagerSection);
      offSettingsSection = typeof unreg === "function" ? unreg : () => {
      };
      return unreg;
    } catch (reason) {
      console.warn("skills-manager: register settings.section failed:", reason);
      return function() {
        settingsSectionSupported = false;
      };
    }
  });
  sidebarController = setupSidebarEntry(ctx, {
    callApi: clientMutations.request,
    operations: clientMutations,
    headers: MUTATION_HEADERS,
    renderPanel: function(ownerProps) {
      return h3(SkillManagerSection, Object.assign({ t: ctx.locale.bind(NS) }, ownerProps));
    },
    ns: NS,
    onLocationChange: function() {
      syncSettingsSection();
    }
  });
  ctx.effect(function() {
    return function() {
      if (sidebarController && typeof sidebarController.destroy === "function") {
        sidebarController.destroy();
        sidebarController = void 0;
      }
      unmountSettingsNavIcon();
      unmountSettingsSection();
    };
  }, "skills-manager: sidebar entry cleanup");
}
module.exports.formatTrashTime = formatTrashTime;
module.exports.DICT = DICT;
module.exports.translateError = translateError;
module.exports.parseApiResponse = parseApiResponse;
module.exports.resolveApiUrl = resolveApiUrl;
module.exports.resolveRepoBrand = resolveRepoBrand;
module.exports.skillDeclaredInvocationKind = skillDeclaredInvocationKind;
module.exports.isSkillEnabled = isSkillEnabled;
module.exports.countKey = countKey;
module.exports.rootDisplayName = rootDisplayName;
module.exports.summarizeImportResult = summarizeImportResult;
module.exports.normalizeSkillQuery = normalizeSkillQuery;
module.exports.matchSkillQuery = matchSkillQuery;
module.exports.filterSkills = filterSkills;
module.exports.visibleSkillRoots = visibleSkillRoots;
module.exports.scopeSkillRoots = scopeSkillRoots;
module.exports.skillStatus = skillStatus;
module.exports.countSkillStatuses = countSkillStatuses;
module.exports.sumEnabledDescriptionTokens = sumEnabledDescriptionTokens;
module.exports.currentSessionId = currentSessionId;
module.exports.canToggleSource = canToggleSource;
module.exports.recoverModalFocus = recoverModalFocus;
module.exports.trapModalFocus = trapModalFocus;
module.exports.inspectUploadSelection = inspectUploadSelection;
module.exports.setupSidebarEntry = setupSidebarEntry;
module.exports.apply = apply;
module.exports.inject = inject;
return module.exports;
} });
