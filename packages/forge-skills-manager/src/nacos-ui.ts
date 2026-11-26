import type * as React from "react";
import type { ApiCall, ModalProps, SourceSelectProps, Translate } from "./client-types.js";
import type { WorkspaceRow } from "./core.js";
import type { DestinationKit, DestinationValue, UserDestination } from "./destination-types.js";
import type { NacosDetail, NacosPage, NacosSkill } from "./nacos.js";
import { NacosDetailDialog } from "./nacos-detail.js";
import { nacosCss } from "./nacos-styles.js";
import { decodeOperationOutcome, isConfirmedRejection, isInstallReceipt } from "./api-errors.js";

export const nacosLocales = {
  zh: {
    "scope.repositories": "发现技能",
    "nacos.title": "企业技能库", "nacos.subtitle": "发现适合工作的技能",
    "nacos.search": "按技能名称搜索", "nacos.searchAction": "搜索", "nacos.clear": "清空搜索", "nacos.retry": "重试",

    "nacos.enableHint": "下载后需手动启用", "nacos.localOnly": "本地修改不会上传到企业技能库。",
    "nacos.unconfigured": "企业技能库尚未配置，请联系维护人员。全局、项目和本地 Agent 技能仍可正常管理。",
    "nacos.unconfiguredTitle": "企业技能库尚未配置", "nacos.failedTitle": "暂时无法读取企业技能库",
    "nacos.emptyTitle": "本页暂无可下载技能", "nacos.empty": "本页没有已上线技能，可稍后刷新或浏览其他页面。",
    "nacos.noResults": "没有找到匹配的技能", "nacos.noResultsHint": "请尝试其他技能名称，或清空搜索。",
    "nacos.noDescription": "暂无用途说明", "nacos.count": "本页 {count} 项", "nacos.resultsFor": "名称包含“{query}” · 本页 {count} 项",
    "nacos.sortDownloads": "按下载次数排序", "nacos.namespace": "命名空间：{namespace}", "nacos.downloadCount": "{count} 次下载",
    "nacos.downloadCountHint": "Nacos 资源下载统计，包含详情读取，不代表安装人数。",
    "nacos.loading": "正在读取企业技能库…", "nacos.refreshing": "正在刷新，暂时显示上次结果…", "nacos.detailLoading": "正在读取技能说明与完整资源…",
    "nacos.download": "下载到本地", "nacos.downloading": "正在下载…",
    "nacos.downloaded": "已下载", "nacos.modified": "已下载 · 本地已修改", "nacos.installPending": "下载待确认", "nacos.installUnavailable": "下载状态暂不可核验，请检查本地技能后刷新。", "nacos.projectCopies": "项目技能（{count}）",
    "nacos.checkResult": "核对下载结果", "nacos.pending": "下载结果尚待确认，请核对结果或到本地技能页查看，勿重复下载。",
    "nacos.confirmed": "已确认 {name} 已下载，请在本地技能页查看当前启用状态。",
    "nacos.confirmedRefreshWarning": "已确认技能已下载，但本地列表刷新失败。请刷新技能页查看当前启用状态，勿重复下载。",
    "nacos.done": "已下载 {name}，当前为禁用状态。", "nacos.refreshWarning": "技能已下载且保持禁用，但本地列表刷新失败。请刷新技能页，勿重复下载。",
    "nacos.openGlobal": "前往全局技能", "nacos.openProject": "前往项目技能",
    "nacos.version": "版本 {version}", "nacos.previous": "上一页", "nacos.next": "下一页", "nacos.page": "第 {page} 页",
    "nacos.files": "完整资源（{count} 个文件）", "nacos.choose": "下载位置", "nacos.path": "查看本地保存路径",
    "nacos.global": "全局技能", "nacos.project": "项目技能", "nacos.chooseProject": "选择项目",
    "nacos.globalHint": "保存到当前用户的 DSH 全局技能，供各个项目按需使用。", "nacos.globalUnavailable": "全局技能目录暂不可用，请刷新详情或选择项目。",
    "nacos.projectHint": "只在所选项目中使用，文件可能随项目提交到仓库。", "nacos.noProjects": "暂无已登记项目。请先在侧栏添加工作区，或选择全局技能。", "nacos.projectUnavailable": "目录不可用",
    "nacos.cancelHint": "取消只中止尚未提交的下载；若本地写入已开始，请到技能页确认结果。",
    "error.nacos.query": "搜索条件、技能名称或版本无效。", "error.nacos.config": "企业技能库配置不完整或不安全，请联系维护人员。",
    "error.nacos.unconfigured": "企业技能库尚未配置，请联系维护人员。", "error.nacos.auth": "企业技能库暂时无法访问，请联系维护人员检查访问权限。",
    "error.nacos.timeout": "企业技能库请求超时，请重试。", "error.nacos.cancelled": "下载请求已取消；请到技能页确认是否已完成本地写入。",
    "error.nacos.notFound": "该技能版本已不可用，请刷新企业技能库。", "error.nacos.response": "企业技能库响应格式不兼容，请联系维护人员。",
    "error.nacos.package": "技能 ZIP 包无效、内容不匹配或大小超限。", "error.nacos.size": "企业技能库响应超出大小限制。", "error.nacos.unavailable": "企业技能库连接失败，请检查网络或稍后重试。",
  },
  en: {
    "scope.repositories": "Discover skills",
    "nacos.title": "Enterprise skills", "nacos.subtitle": "Discover skills for your work",
    "nacos.search": "Search by skill name", "nacos.searchAction": "Search", "nacos.clear": "Clear search", "nacos.retry": "Retry",

    "nacos.enableHint": "Enable manually after downloading", "nacos.localOnly": "Local changes are never uploaded to the enterprise library.",
    "nacos.unconfigured": "The enterprise library is not configured. Contact your administrator. Global, project and local Agent skills remain available.",
    "nacos.unconfiguredTitle": "Enterprise library not configured", "nacos.failedTitle": "Could not load enterprise skills",
    "nacos.emptyTitle": "No downloads on this page", "nacos.empty": "No published skills on this page. Refresh later or try another page.",
    "nacos.noResults": "No matching skills", "nacos.noResultsHint": "Try another skill name or clear your search.",
    "nacos.noDescription": "No description available", "nacos.count": "{count} on this page", "nacos.resultsFor": "Names containing “{query}” · {count} on this page",
    "nacos.sortDownloads": "Most downloaded first", "nacos.namespace": "Namespace: {namespace}", "nacos.downloadCount": "{count} downloads",
    "nacos.downloadCountHint": "Nacos resource downloads, including detail views; not the number of people who installed this skill.",
    "nacos.loading": "Loading enterprise skills…", "nacos.refreshing": "Refreshing; showing previous results…", "nacos.detailLoading": "Loading skill instructions and complete resources…",
    "nacos.download": "Download locally", "nacos.downloading": "Downloading…",
    "nacos.downloaded": "Downloaded", "nacos.modified": "Downloaded · Modified locally", "nacos.installPending": "Download awaiting confirmation", "nacos.installUnavailable": "Download status unavailable. Check local skills and refresh.", "nacos.projectCopies": "Projects ({count})",
    "nacos.checkResult": "Check download result", "nacos.pending": "The download result is unconfirmed. Check its status or local skills; do not download again.",
    "nacos.confirmed": "Confirmed that {name} was downloaded. Check its current enabled state in local skills.",
    "nacos.confirmedRefreshWarning": "The download is confirmed, but local skills could not refresh. Refresh to check the current enabled state; do not download again.",
    "nacos.done": "Downloaded {name}, disabled.", "nacos.refreshWarning": "Downloaded and disabled, but the local list could not refresh. Refresh the skills page; do not download again.",
    "nacos.openGlobal": "Go to global skills", "nacos.openProject": "Go to project skills",
    "nacos.version": "Version {version}", "nacos.previous": "Previous", "nacos.next": "Next", "nacos.page": "Page {page}",
    "nacos.files": "Complete resources ({count} files)", "nacos.choose": "Download destination", "nacos.path": "Show local save path",
    "nacos.global": "Global skills", "nacos.project": "Project skills", "nacos.chooseProject": "Select a project",
    "nacos.globalHint": "Save to your DSH global skills for use across projects.", "nacos.globalUnavailable": "Global skills are unavailable. Reload the details or choose a project.",
    "nacos.projectHint": "Available in this project only. Files may be committed with the project.", "nacos.noProjects": "No registered projects. Add a workspace in the sidebar or choose global skills.", "nacos.projectUnavailable": "Directory unavailable",
    "nacos.cancelHint": "Cancellation stops uncommitted downloads. If a local write has started, check the skills page for its result.",
    "error.nacos.query": "Invalid query, skill name or version.", "error.nacos.config": "The enterprise library configuration is incomplete or unsafe.",
    "error.nacos.unconfigured": "The enterprise library is not configured.", "error.nacos.auth": "The enterprise library is unavailable. Ask your administrator to check access permissions.",
    "error.nacos.timeout": "Enterprise library request timed out.", "error.nacos.cancelled": "Request cancelled. Check local skills in case the download was committed.",
    "error.nacos.notFound": "This skill version is unavailable. Refresh the enterprise library.", "error.nacos.response": "Incompatible enterprise library response.",
    "error.nacos.package": "Invalid, mismatched, unsafe or oversized skill archive.", "error.nacos.size": "Enterprise library response exceeds the size limit.", "error.nacos.unavailable": "Could not connect to the enterprise library. Try again later.",
  },
};

interface Dependencies {
  react: typeof React;
  Modal: React.ComponentType<ModalProps>;
  Input: React.ComponentType<any>;
  Button: React.ComponentType<any>;
  SourceSelect: React.ComponentType<SourceSelectProps>;
  destination: DestinationKit;
  api: ApiCall;
  headers: Record<string, string>;
  translateError: (t: Translate, error: unknown) => string;
}
export interface NacosInstalled { name: string; scope: "user" | "workspace"; workspace: string }
interface Options { active: boolean; t: Translate; onInstalled?: (target: NacosInstalled) => unknown; onNavigate?: (target: NacosInstalled) => void }

export function createNacosUI({ react, Modal, Input, Button, SourceSelect, destination, api, headers, translateError }: Dependencies) {
  const h = react.createElement;
  const pendingDownloads = new Map<string, { id: string; target: NacosInstalled }>();
  const { defaultDestination, destinationPayload, destinationReady } = destination;
  const icon = (path: string, size = 16) => h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, h("path", { d: path }));
  return function useNacosUI({ active, t, onInstalled, onNavigate }: Options) {
    const [query, setQuery] = react.useState("");
    const [requested, setRequested] = react.useState({ query: "", page: 1, revision: 0 });
    const [listing, setListing] = react.useState<{ data: NacosPage; query: string } | null>(null);
    const [listLoading, setListLoading] = react.useState(true);
    const [listError, setListError] = react.useState<string | null>(null);
    const [notice, setNotice] = react.useState<{ text: string; target: NacosInstalled; warning?: boolean } | null>(null);
    const [selected, setSelected] = react.useState<NacosSkill | null>(null);
    const [detail, setDetail] = react.useState<NacosDetail | null>(null);
    const [detailLoading, setDetailLoading] = react.useState(false);
    const [detailError, setDetailError] = react.useState<string | null>(null);
    const [detailRevision, setDetailRevision] = react.useState(0);
    const [target, setTarget] = react.useState<DestinationValue>(defaultDestination);
    const [workspaces, setWorkspaces] = react.useState<WorkspaceRow[]>([]);
    const [roots, setRoots] = react.useState<UserDestination[]>([]);
    const [installing, setInstalling] = react.useState(false);
    const [, setOperationRevision] = react.useState(0);
    const [checking, setChecking] = react.useState(false);
    const listEpoch = react.useRef(0);
    const detailEpoch = react.useRef(0);
    const operation = react.useRef<AbortController | null>(null);
    const mounted = react.useRef(true);
    const page = listing?.data;
    const downloadKey = JSON.stringify([selected?.name, selected?.version, target.scope, target.workspace]);
    const pendingDownload = pendingDownloads.get(downloadKey);
    const uncertain = !!pendingDownload && !installing;
    const chosenWorkspace = workspaces.find(row => row.registeredPaths[0] === target.workspace);
    const workspacePath = chosenWorkspace?.projectRoot || chosenWorkspace?.path;
    const samePath = (left: string, right: string) => /^[A-Za-z]:|^\\\\/.test(left)
      ? left.replace(/\\/g, "/").toLowerCase() === right.replace(/\\/g, "/").toLowerCase() : left === right;
    const installation = detail?.installations?.find(item => target.scope === "workspace"
      ? !!item.workspace && !!workspacePath && samePath(item.workspace, workspacePath) : item.workspace === undefined);
    const installed = installation?.state === "downloaded" || installation?.state === "modified";
    const statusKey = (value: NonNullable<NacosSkill["installations"]>[number]["state"]) =>
      value === "downloaded" ? "nacos.downloaded" : value === "modified" ? "nacos.modified" : value === "pending" ? "nacos.installPending" : "nacos.installUnavailable";

    function downloadBadges(item: NacosSkill) {
      const groups = new Map<string, { state: NonNullable<NacosSkill["installations"]>[number]["state"]; project: boolean; count: number }>();
      for (const entry of item.installations || []) {
        const project = entry.workspace !== undefined;
        const key = JSON.stringify([entry.state, project]);
        const group = groups.get(key);
        if (group) group.count++;
        else groups.set(key, { state: entry.state, project, count: 1 });
      }
      return groups.size ? h("div", { className: "dssm-nacos-installations", role: "status" }, [...groups].map(([key, group]) =>
        h("span", { key, className: "dssm-nacos-installation" }, t(statusKey(group.state)) + " · " + t(group.project ? "nacos.projectCopies" : "nacos.global", { count: group.count })))) : null;
    }

    async function complete(result: { name: string }, installedTarget: NacosInstalled, reconciled = false) {
      setSelected(null); setDetail(null);
      const completed = { ...installedTarget, name: result.name };
      setNotice({ text: t(reconciled ? "nacos.confirmed" : "nacos.done", { name: result.name }), target: completed });
      setRequested(previous => ({ ...previous, revision: previous.revision + 1 }));
      try { await onInstalled?.(completed); }
      catch { if (mounted.current) setNotice({ text: t(reconciled ? "nacos.confirmedRefreshWarning" : "nacos.refreshWarning"), target: completed, warning: true }); }
    }
    async function checkResult() {
      if (!pendingDownload || checking) return;
      const epoch = detailEpoch.current;
      setChecking(true);
      try {
        const outcome = decodeOperationOutcome(await api(`/nacos/install-status?operationId=${encodeURIComponent(pendingDownload.id)}`), (result): result is { name: string; root: string } => isInstallReceipt(result) && result.name === pendingDownload.target.name);
        if (outcome.state === "pending") {
          if (mounted.current && detailEpoch.current === epoch) setDetailError(t("nacos.pending"));
          return;
        }
        pendingDownloads.delete(downloadKey);
        if (!mounted.current || detailEpoch.current !== epoch) return;
        setOperationRevision(previous => previous + 1);
        if (outcome.state === "succeeded") await complete(outcome.result, pendingDownload.target, true);
        else setDetailError(translateError(t, outcome.failure));
      } catch { if (mounted.current && detailEpoch.current === epoch) setDetailError(t("nacos.pending")); }
      finally { if (mounted.current) setChecking(false); }
    }

    react.useEffect(() => {
      if (!active) return;
      const controller = new AbortController();
      const epoch = ++listEpoch.current;
      setListLoading(true); setListError(null);
      api(`/nacos/list?q=${encodeURIComponent(requested.query)}&page=${requested.page}`, { signal: controller.signal }).then(data => {
        if (epoch === listEpoch.current && !controller.signal.aborted) setListing({ data, query: requested.query });
      }).catch(error => {
        if (epoch === listEpoch.current && !controller.signal.aborted) setListError(translateError(t, error));
      }).finally(() => { if (epoch === listEpoch.current && !controller.signal.aborted) setListLoading(false); });
      return () => { listEpoch.current++; controller.abort(); };
    }, [active, requested]);

    react.useEffect(() => {
      if (!selected || !active) return;
      const controller = new AbortController();
      const epoch = ++detailEpoch.current;
      setDetail(null); setRoots([]); setWorkspaces([]); setDetailLoading(true); setDetailError(null);
      Promise.all([
        api("/nacos/detail", { method: "POST", headers, body: JSON.stringify({ skillName: selected.name, version: selected.version }), signal: controller.signal }),
        api("/workspaces", { signal: controller.signal }), api("/state", { signal: controller.signal }),
      ]).then(([value, projects, local]) => {
        if (epoch !== detailEpoch.current || controller.signal.aborted) return;
        setDetail(value); setWorkspaces(projects.items);
        setRoots(local.roots.filter(root => root.key === "dsh").map(root => ({ key: "dsh", path: root.path, label: "DSH", available: root.mutable !== false })));
      }).catch(error => { if (epoch === detailEpoch.current && !controller.signal.aborted) setDetailError(translateError(t, error)); })
        .finally(() => { if (epoch === detailEpoch.current && !controller.signal.aborted) setDetailLoading(false); });
      return () => { detailEpoch.current++; controller.abort(); };
    }, [selected, active, detailRevision]);

    react.useEffect(() => { if (!active) operation.current?.abort(); }, [active]);
    react.useEffect(() => { mounted.current = true; return () => { mounted.current = false; operation.current?.abort(); }; }, []);

    async function install() {
      // A ref closes the same-event-turn gap before React publishes installing=true.
      if (!selected || !detail || operation.current || uncertain || installation || !destinationReady(target, workspaces, roots)) return;
      const controller = new AbortController();
      const installedTarget: NacosInstalled = { name: selected.name, scope: target.scope === "workspace" ? "workspace" : "user", workspace: target.workspace };
      const operationId = crypto.randomUUID();
      pendingDownloads.set(downloadKey, { id: operationId, target: installedTarget });
      operation.current = controller; setInstalling(true); setDetailError(null);
      try {
        const result = await api("/nacos/install", { method: "POST", headers, body: JSON.stringify({ skillName: selected.name, version: selected.version, ...destinationPayload(target), operationId }), signal: controller.signal });
        if (!isInstallReceipt(result) || result.name !== installedTarget.name) {
          if (mounted.current) setDetailError(t("nacos.pending"));
          return;
        }
        if (!controller.signal.aborted) pendingDownloads.delete(downloadKey);
        if (!mounted.current) return;
        // An aborted transport may resolve after the Host commits. Never infer success.
        if (controller.signal.aborted) { setDetailError(t("error.nacos.cancelled")); return; }
        await complete(result, installedTarget);
      } catch (error) {
        if (isConfirmedRejection(error)) pendingDownloads.delete(downloadKey);
        if (mounted.current) {
          setDetailError(controller.signal.aborted ? t("error.nacos.cancelled") : translateError(t, error));
        }
      } finally {
        operation.current = null;
        if (mounted.current) setInstalling(false);
      }
    }
    function close() { if (!operation.current) { detailEpoch.current++; setSelected(null); setDetail(null); } }
    function open(item: NacosSkill) {
      if (operation.current) return;
      setDetail(null); setDetailError(null); setDetailLoading(true); setTarget(defaultDestination()); setSelected(item);
    }
    function search(value = query) {
      setQuery(value);
      setRequested(previous => ({ query: value.trim(), page: 1, revision: previous.revision + 1 }));
    }
    function refresh() { setRequested(previous => ({ ...previous, revision: previous.revision + 1 })); }
    const button = (key: string, onClick: () => void, disabled = false) => h(Button, { variant: "outline", size: "sm", onClick, disabled }, t(key));
    const state = (title: string, text: string, action?: React.ReactNode) => h("div", { className: "dssm-nacos-state", role: "status" },
      h("span", { className: "dssm-nacos-icon" }, icon("M4 5h6l2 2h8v12H4z")), h("strong", null, t(title)), h("p", null, text), action);

    const content = h("div", { key: "nacos", id: "dssm-scope-panel", role: "tabpanel", "aria-labelledby": "dssm-tab-repositories", className: "dssm-nacos" },
      h("style", null, nacosCss),
      h("div", { className: "dssm-nacos-heading" }, h("div", null, h("h3", null, t("nacos.title")), h("p", { className: "dssm-nacos-subtitle" }, t("nacos.subtitle")))),
      h("form", { className: "dssm-nacos-tools", onSubmit: (event: React.FormEvent) => { event.preventDefault(); if (!operation.current) search(); } },
        h("div", { className: "dssm-nacos-search" },
          h(Input, { value: query, maxLength: 100, placeholder: t("nacos.search"), "aria-label": t("nacos.search"), disabled: installing, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setQuery(event.target.value) }),
          query || requested.query ? h(Button, { variant: "ghost", size: "sm", type: "button", "aria-label": t("nacos.clear"), disabled: installing, onClick: () => search("") }, icon("M6 6l12 12M18 6 6 18")) : null),
        h(Button, { variant: "outline", size: "sm", type: "submit", disabled: installing }, t("nacos.searchAction")),
        h(Button, { variant: "ghost", size: "sm", type: "button", "aria-label": t("btn.refresh"), title: t("btn.refresh"), disabled: listLoading || installing, onClick: refresh }, icon("M20 7v5h-5M4 17v-5h5M5.5 7a7 7 0 0 1 12-1L20 9M4 15l2.5 3a7 7 0 0 0 12-1"))),
      notice ? h("div", { className: "dssm-nacos-notice" + (notice.warning ? " is-warning" : ""), role: "status" },
        h("span", null, notice.text), onNavigate ? button(notice.target.scope === "workspace" ? "nacos.openProject" : "nacos.openGlobal", () => onNavigate(notice.target), installing) : null) : null,
      listError ? page ? h("div", { className: "dssm-nacos-notice is-error", role: "alert" }, h("span", null, listError), button("nacos.retry", refresh, listLoading))
        : state("nacos.failedTitle", listError, button("nacos.retry", refresh, listLoading)) : null,
      listLoading && !page ? h("div", { role: "status", "aria-label": t("nacos.loading"), className: "dssm-nacos-grid" },
        [0, 1, 2].map(key => h("div", { key, className: "dssm-nacos-card dssm-nacos-skeleton", "aria-hidden": true }, h("span"), h("span"), h("span")))) : null,
      page?.configured === false ? state("nacos.unconfiguredTitle", t("nacos.unconfigured"), button("nacos.retry", refresh, listLoading)) : null,
      page?.configured ? h(react.Fragment, null,
        h("div", { className: "dssm-nacos-summary" },
          h("p", { className: "dssm-nacos-count", role: "status", "aria-live": "polite" },
            t(listing?.query ? "nacos.resultsFor" : "nacos.count", { count: page.items.length, query: listing?.query }), listLoading ? " · " + t("nacos.refreshing") : ""),
          h("span", { className: "dssm-nacos-sort" }, t("nacos.sortDownloads"))),
        !page.items.length && !listLoading ? state(listing?.query && !page.total ? "nacos.noResults" : "nacos.emptyTitle", t(listing?.query && !page.total ? "nacos.noResultsHint" : "nacos.empty"),
          listing?.query ? button("nacos.clear", () => search(""), installing) : button("btn.refresh", refresh, installing)) : null,
        h("div", { className: "dssm-nacos-grid", "aria-busy": listLoading }, page.items.map(item => h("article", { className: "dssm-nacos-card", key: item.name + ":" + item.version },
          h("div", { className: "dssm-nacos-card-head" },
            h("span", { className: "dssm-nacos-icon" }, icon("M14 3H6v18h12V7zM14 3v5h5M9 12h6M9 16h4")),
            h("h4", null, item.name), h("span", { className: "dssm-nacos-version" }, t("nacos.version", { version: item.version }))),
          h("p", { className: "dssm-nacos-description" }, item.description || t("nacos.noDescription")),
          downloadBadges(item),
          h("div", { className: "dssm-nacos-card-actions" },
            h("div", { className: "dssm-nacos-meta" },
              item.namespaceId ? h("span", { className: "dssm-nacos-namespace", title: t("nacos.namespace", { namespace: item.namespaceId }), "aria-label": t("nacos.namespace", { namespace: item.namespaceId }) },
                icon("M4 5h6l2 2h8v12H4z", 14), h("span", null, item.namespaceId)) : null,
              item.downloadCount !== undefined ? h("span", { className: "dssm-nacos-downloads", title: t("nacos.downloadCountHint"), "aria-label": t("nacos.downloadCount", { count: item.downloadCount }) + ". " + t("nacos.downloadCountHint") },
                icon("M12 3v12m-5-5 5 5 5-5M5 16v5h14v-5", 14), t("nacos.downloadCount", { count: item.downloadCount.toLocaleString() })) : null),
            h(Button, { variant: "outline", size: "sm", disabled: installing, onClick: () => open(item) }, t("btn.detail")))))),
        page.page > 1 || page.total > page.pageSize ? h("nav", { className: "dssm-nacos-pagination", "aria-label": t("nacos.page", { page: page.page }) },
          button("nacos.previous", () => setRequested(previous => ({ ...previous, query: listing!.query, page: page.page - 1 })), listLoading || installing || page.page <= 1),
          h("span", null, t("nacos.page", { page: page.page })),
          button("nacos.next", () => setRequested(previous => ({ ...previous, query: listing!.query, page: page.page + 1 })), listLoading || installing || page.page * page.pageSize >= page.total)) : null) : null,
      selected && active ? h(NacosDetailDialog, {
        Modal, Button, SourceSelect, t, selected, detail, loading: detailLoading, error: detailError, installing, uncertain, checking,
        target, workspaces, roots, ready: destinationReady(target, workspaces, roots) && !installation, onTarget: setTarget,
        installed, installationStatus: installation ? t(statusKey(installation.state)) : null,
        onNavigate: installed && onNavigate ? () => onNavigate({ name: selected.name, scope: target.scope === "workspace" ? "workspace" : "user", workspace: target.workspace }) : undefined,
        onInstall: install, onClose: close, onCancel: () => operation.current?.abort(), onRetry: () => setDetailRevision(previous => previous + 1), onCheck: checkResult,
      }) : null);
    return { content, actions: null };
  };
}
