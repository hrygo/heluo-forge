import * as React from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ModalProps, SourceSelectProps, Translate } from "./client-types.js";
import type { WorkspaceRow } from "./core.js";
import type { DestinationValue, UserDestination } from "./destination-types.js";
import type { NacosDetail, NacosSkill } from "./nacos.js";

const h = React.createElement;
const markdownPlugins = [remarkGfm];

/** Skill documents are data: no HTML, images, executable protocols or file links. */
export function skillDocumentUrl(url: string) {
  try { const parsed = new URL(url); return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : undefined; }
  catch { return undefined; }
}

export function SkillDocument({ body }: { body: string }) {
  return h("div", { className: "dssm-nacos-markdown" }, h(Markdown, {
    remarkPlugins: markdownPlugins, skipHtml: true, disallowedElements: ["img"], urlTransform: skillDocumentUrl,
    components: {
      a: ({ href, children }) => href ? h("a", { href, target: "_blank", rel: "noopener noreferrer" }, children) : h("span", null, children),
      table: ({ children }) => h("div", { className: "dssm-nacos-table" }, h("table", null, children)),
    }, children: body,
  }));
}

interface Props {
  Modal: React.ComponentType<ModalProps>;
  Button: React.ComponentType<any>;
  SourceSelect: React.ComponentType<SourceSelectProps>;
  t: Translate;
  selected: NacosSkill;
  detail: NacosDetail | null;
  loading: boolean;
  error: string | null;
  installing: boolean;
  uncertain: boolean;
  target: DestinationValue;
  workspaces: WorkspaceRow[];
  roots: UserDestination[];
  ready: boolean;
  onTarget: (value: DestinationValue) => void;
  onRetry: () => void;
  onInstall: () => void;
  onClose: () => void;
  onCancel: () => void;
}

export function NacosDetailDialog(props: Props) {
  const { Modal, Button, SourceSelect, t, selected, detail, loading, error, installing, uncertain, target, workspaces, roots } = props;
  const project = target.scope === "workspace";
  const chosen = workspaces.find(row => row.registeredPaths[0] === target.workspace);
  const projectPath = chosen?.projectRoot || chosen?.path;
  const path = project
    ? chosen?.available && projectPath ? projectPath.replace(/[\\/]+$/, "") + (projectPath.includes("\\") ? "\\.dsh\\skills" : "/.dsh/skills") : ""
    : roots.find(root => root.key === "dsh")?.path || "";
  return h(Modal, {
    title: selected.name, className: "dssm-nacos-dialog", contentClassName: "dssm-nacos-dialog-content",
    closeLabel: t("btn.close"), onClose: props.onClose,
    footer: h("div", { className: "dssm-nacos-footer" },
      h("span", { className: "dssm-nacos-note" }, t("nacos.enableHint")),
      h("div", { className: "dssm-nacos-actions" },
        h(Button, { variant: "outline", size: "sm", onClick: installing ? props.onCancel : props.onClose }, t(installing ? "btn.cancel" : "btn.close")),
        h(Button, { variant: "primary", size: "sm", disabled: !detail || loading || installing || uncertain || !props.ready, onClick: props.onInstall }, t(installing ? "nacos.downloading" : "nacos.download")))),
  },
  h("div", { className: "dssm-nacos-detail" },
    h("div", { className: "dssm-nacos-overview" },
      h("span", { className: "dssm-nacos-version" }, t("nacos.version", { version: selected.version })),
      h("p", null, selected.description || t("nacos.noDescription"))),
    loading ? h("div", { className: "dssm-nacos-state", role: "status" }, t("nacos.detailLoading")) : null,
    error ? h("div", { className: "dssm-nacos-notice is-error", role: "alert" },
      h("span", null, error), !detail && !loading ? h(Button, { variant: "outline", size: "sm", onClick: props.onRetry }, t("nacos.retry")) : null) : null,
    detail ? h(React.Fragment, null,
      h(SkillDocument, { body: detail.body }),
      h("details", { className: "dssm-nacos-resources" },
        h("summary", null, t("nacos.files", { count: detail.files.length })),
        h("ul", null, detail.files.map(file => h("li", { key: file }, h("code", null, file))))),
      h("section", { className: "dssm-nacos-destination", "aria-label": t("nacos.choose") },
        h("h3", null, t("nacos.choose")),
        h("div", { className: "dssm-nacos-scope", role: "group", "aria-label": t("nacos.choose") },
          (["user", "workspace"] as const).map(scope => h(Button, {
            key: scope, size: "sm", variant: target.scope === scope ? "primary" : "outline",
            "aria-pressed": target.scope === scope, disabled: installing,
            onClick: () => props.onTarget({ ...target, scope, location: "dsh", workspace: "", presetKey: "" }),
          }, t(scope === "user" ? "nacos.global" : "nacos.project")))),
        project ? h("div", { className: "dssm-nacos-project" },
          h("span", { className: "dssm-label" }, t("nacos.chooseProject")),
          h(SourceSelect, {
            label: t("nacos.chooseProject"), value: target.workspace, disabled: installing || !workspaces.length,
            options: workspaces.map(row => ({ value: row.registeredPaths[0] || "", label: row.name + (!row.available ? " · " + t("nacos.projectUnavailable") : ""), disabled: !row.available || !row.registeredPaths[0] })),
            onChange: value => { if (!installing && workspaces.some(row => row.available && row.registeredPaths[0] === value)) props.onTarget({ ...target, workspace: value }); },
          }),
          h("p", { className: "dssm-nacos-note" }, t(workspaces.length ? "nacos.projectHint" : "nacos.noProjects")))
          : h("p", { className: "dssm-nacos-note" }, t(roots.some(root => root.key === "dsh" && root.available) ? "nacos.globalHint" : "nacos.globalUnavailable")),
        path ? h("details", { className: "dssm-nacos-path" }, h("summary", null, t("nacos.path")), h("code", null, path)) : null,
        h("p", { className: "dssm-nacos-note" }, t("nacos.localOnly"))),
      installing ? h("p", { className: "dssm-nacos-note", role: "status" }, t("nacos.cancelHint")) : null) : null));
}
