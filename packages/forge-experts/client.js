window.__ModuleLoader__.load({
  id: '@heluo/forge-experts',
  factory(require) {
    // 分区索引（P1 单 bundle 边界锚点：纯函数与常量 ← IO 边界 ← 状态投影 ← 视图与出口）
    // §1 常量与文案 / §2 唯一错误码解包 / §3 同源 HTTP 与 SSE / §4 状态派生 / §5 管理页视图 / §6 出口

    // §1 常量与文案
    const React = require('react');
    const h = React.createElement;
    const API_BASE = '/api/forge-experts';
    const EDIT_TOKEN_HEADER = 'x-forge-experts-edit-token';
    const REQUEST_HEADERS = Object.freeze({
      'x-forge-experts-request': '1',
      'content-type': 'application/json',
    });

    const ACCEPTING_LABELS = Object.freeze(Object.assign(Object.create(null), {
      accepting: '可接单',
      paused: '暂不接单',
      unavailable: '暂不可用',
    }));

    const TASK_STATUS_LABELS = Object.freeze(Object.assign(Object.create(null), {
      accepted: '已受理（尚未完成）',
      queued: '排队中（尚未完成）',
      running: '执行中',
      waiting_user: '等待补充输入',
      completed: '已完成',
      succeeded: '已完成',
      failed: '执行失败',
      cancelling: '取消请求已提交',
      cancelled: '已取消',
      pending_delivery: '受理状态未知（请对账）',
      unknown: '受理状态未知（请对账）',
      not_found: '任务不可访问',
    }));

    const TERMINAL_TASK_STATUSES = new Set(['completed', 'succeeded', 'failed', 'cancelled', 'not_found']);

    const ERROR_NOTICE = Object.freeze(Object.assign(Object.create(null), {
      EXPERT_MANAGEMENT_DISABLED: '专家智能体管理入口当前未开放。',
      EXPERT_MENTIONS_DISABLED: '专家 @ 候选投影当前未开放。',
      EXPERT_DISPATCH_DISABLED: '专家任务委派入口当前未开放。',
      EXPERT_RATE_LIMITED: '当前专家确认请求过多，请稍后重试，草稿已保留。',
      EXPERT_UNAUTHENTICATED: '请先登录企业账号后再查看专家目录。',
      EXPERT_AUTH_INVALID: '企业登录状态无效，请重新登录。',
      EXPERT_AUTH_REVOKED: '企业授权已撤销，请重新登录。',
      EXPERT_ORG_FORBIDDEN: '当前账号无权访问所选组织的专家目录。',
      EXPERT_CALL_FORBIDDEN: '当前账号仅具备查看权限，无法启停或委派该专家。',
      EXPERT_POLICY_DENIED: '当前外发委派已被企业策略拒绝，草稿已保留。',
      EXPERT_POLICY_CONFIRMATION_REQUIRED: '当前委派需要人工确认后方可发送，草稿已保留。',
      EXPERT_NOT_FOUND: '未找到该专家或当前无权访问。',
      EXPERT_TASK_NOT_FOUND: '未找到该专家任务或当前无权查看。',
      EXPERT_SCOPE_MISMATCH: '账号或组织范围已变化，正在刷新目录。',
      EXPERT_SCOPE_UNVERIFIED: '当前会话委派范围尚未确认，已暂停专家候选。',
      EXPERT_SELECTION_INVALID: '专家选择已失效或草稿已变更，请重新选择专家后再发送。',
      EXPERT_NOT_ACCEPTING: '该专家当前暂不接单，已保留您的草稿。',
      EXPERT_IDEMPOTENCY_CONFLICT: '同一请求标识对应了不同的任务内容，请核对原任务状态。',
      EXPERT_TASK_STATE_CONFLICT: '任务状态已变更，正在同步服务端最新状态。',
      EXPERT_CURSOR_STALE: '目录版本已更新，请重新加载列表。',
      EXPERT_EDIT_TOKEN_INVALID: '页面状态已过期，请刷新后重试。',
      EXPERT_EDIT_TOKEN_EXPIRED: '操作凭证已过期，请刷新后重试。',
      EXPERT_REVISION_CONFLICT: '该专家状态已在其他窗口更新，请核对最新状态。',
      EXPERT_DIRECTORY_UNAVAILABLE: '专家目录服务暂不可达，已保留您原有的个人设置。',
      EXPERT_STORAGE_UNAVAILABLE: '本地偏好存储暂不可用，请稍后重试。',
      EXPERT_PREF_SAVE_UNKNOWN: '保存结果尚未确认，正在回读服务端最新状态，请勿重复点击。',
      EXPERT_ISOLATION_UNVERIFIED: '目标运行环境隔离尚未验证，已暂停专家委派。',
      EXPERT_ACCEPTANCE_UNKNOWN: '任务受理结果暂未确认，请通过原请求号对账，切勿重复发送。',
      EXPERT_REQUEST_FAILED: '操作未完成，请稍后重试。',
    }));

    // §2 唯一错误码解包（P5：全文件唯一读取口）
    function resultCode(result) {
      return result?.body?.error?.code ?? 'EXPERT_REQUEST_FAILED';
    }

    function resultNotice(result) {
      return ERROR_NOTICE[resultCode(result)] ?? ERROR_NOTICE.EXPERT_REQUEST_FAILED;
    }

    // §3 同源 HTTP 与 SSE（P7：只读投影与经 Host 提交，绝不反向回写配置）
    async function readJson(response) {
      try {
        return await response.json();
      } catch {
        return null;
      }
    }

    async function fetchCatalog({ view = 'callable', query = '', cursor = null, signal } = {}) {
      const params = new URLSearchParams({ view });
      if (query.trim()) params.set('query', query.trim());
      if (cursor) params.set('cursor', cursor);
      const response = await fetch(`${API_BASE}/catalog?${params.toString()}`, signal ? { signal } : undefined);
      return { ok: response.ok, status: response.status, body: await readJson(response) };
    }

    async function fetchMentions({ sessionId, query = '' }) {
      const params = new URLSearchParams({ sessionId });
      if (query.trim()) params.set('query', query.trim());
      const response = await fetch(`${API_BASE}/mentions?${params.toString()}`);
      return { ok: response.ok, status: response.status, body: await readJson(response) };
    }

    async function putPreference(expertId, { enabled, editToken }) {
      const response = await fetch(`${API_BASE}/preferences/${encodeURIComponent(expertId)}`, {
        method: 'PUT',
        headers: REQUEST_HEADERS,
        body: JSON.stringify({ enabled, editToken }),
      });
      return { ok: response.ok, status: response.status, body: await readJson(response) };
    }

    async function reconcilePreference(expertId, editToken) {
      const init = editToken ? { headers: { [EDIT_TOKEN_HEADER]: editToken } } : undefined;
      const response = await fetch(`${API_BASE}/preferences/${encodeURIComponent(expertId)}`, init);
      return { ok: response.ok, status: response.status, body: await readJson(response) };
    }

    async function requestJson(method, path, body) {
      const init = body === undefined
        ? { method }
        : { method, headers: REQUEST_HEADERS, body: JSON.stringify(body) };
      const response = await fetch(`${API_BASE}${path}`, init);
      return { ok: response.ok, status: response.status, body: await readJson(response) };
    }

    function postSelectionPrepare(payload) {
      return requestJson('POST', '/selections', payload);
    }

    function fetchTaskStatus(taskId) {
      return requestJson('GET', `/tasks/${encodeURIComponent(taskId)}`);
    }

    function fetchTaskResult(taskId) {
      return requestJson('GET', `/tasks/${encodeURIComponent(taskId)}/result`);
    }

    function reconcileTaskByRequest(requestId) {
      return requestJson('GET', `/tasks/by-request/${encodeURIComponent(requestId)}`);
    }

    function postReconcilePending() {
      return requestJson('POST', '/tasks/reconcile', {});
    }

    function fetchRecentFinalizedTurns() {
      return requestJson('GET', '/turns/finalized');
    }

    function generateClientRequestId() {
      if (typeof globalThis !== 'undefined' && globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
        return `fexp-fu-${globalThis.crypto.randomUUID()}`;
      }
      return `fexp-fu-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }

    function postTaskFollowup(taskId, { taskText, reuseRefs = [], requestId = null }) {
      return requestJson('POST', `/tasks/${encodeURIComponent(taskId)}/followups`, {
        taskText,
        ...(Array.isArray(reuseRefs) && reuseRefs.length > 0 ? { reuseRefs } : {}),
        ...(typeof requestId === 'string' && requestId.trim() ? { requestId: requestId.trim() } : {}),
      });
    }

    function postTaskCancel(taskId) {
      return requestJson('POST', `/tasks/${encodeURIComponent(taskId)}/cancel`, {});
    }

    function openEventStream(onMessage, onError) {
      if (typeof window === 'undefined' || typeof window.EventSource !== 'function') return () => {};
      const source = new window.EventSource(`${API_BASE}/events`);
      source.onmessage = (event) => {
        let payload;
        try { payload = JSON.parse(event.data); } catch { return; }
        if (!payload || typeof payload !== 'object') return;
        onMessage(payload);
      };
      if (typeof onError === 'function') {
        source.onerror = () => onError();
      }
      return () => {
        try { source.close(); } catch { /* closing */ }
      };
    }

    // §4 状态派生
    function deriveRowStatus(item) {
      const pref = item?.preference;
      const accepting = item?.availability?.acceptingTasks ?? 'unknown';
      const pending = pref?.pending === true;
      const enabled = pref?.enabled === true;
      return {
        callable: item?.access?.callableInOrg === true,
        pending,
        enabled,
        acceptingLabel: ACCEPTING_LABELS[accepting] ?? '接单状态未知',
      };
    }

    function formatSummaryText(summary) {
      if (summary?.disclosureState === 'available') {
        return summary.responsibility ?? '已获准披露能力摘要';
      }
      return '能力与权限摘要暂不可披露或未提供';
    }

    function formatActionLabel(busy, enabled) {
      if (busy) return '待确认…';
      return enabled ? '停用' : '启用';
    }

    function filterAuthorizedCardItems(items) {
      if (!Array.isArray(items)) return [];
      return items.filter((item) => Boolean(item) && typeof item === 'object' && !Array.isArray(item) && item.authorized === true);
    }

    function normalizeCardId(value) {
      return typeof value === 'string' ? value.trim() || null : null;
    }

    function deriveTaskCardModel(task) {
      const status = typeof task?.status === 'string' && TASK_STATUS_LABELS[task.status]
        ? task.status
        : 'unknown';
      const taskId = normalizeCardId(task?.taskId);
      const requestId = normalizeCardId(task?.requestId);
      const isTerminal = TERMINAL_TASK_STATUSES.has(status);
      const isCompleted = status === 'completed' || status === 'succeeded';
      const isWaitingUser = status === 'waiting_user';
      const isUnknown = status === 'unknown' || status === 'pending_delivery';
      const isCancelled = status === 'cancelled' || status === 'cancelling' || task?.cancelRequested === true;
      const authorizedSources = filterAuthorizedCardItems(task?.sources);
      const authorizedArtifacts = filterAuthorizedCardItems(task?.artifacts);
      const waitingNotice = isWaitingUser
        ? (task?.waitingUserNotice?.message ?? '该任务正在等待您的补充输入（只读提示），请显式发送追问后继续。')
        : null;
      const cancellationNotice = isCancelled
        ? '取消请求已提交；专家已经执行的外部动作不会被自动撤销。'
        : null;
      return {
        taskId,
        requestId,
        expertName: typeof task?.expertName === 'string' && task.expertName.trim() ? task.expertName.trim() : (task?.expertId ?? '专家智能体'),
        status,
        statusLabel: TASK_STATUS_LABELS[status] ?? TASK_STATUS_LABELS.unknown,
        completed: isCompleted,
        isTerminal,
        isUnknown,
        isWaitingUser,
        cancelRequested: isCancelled,
        canReconcile: Boolean(requestId && (isUnknown || !taskId)),
        showReconcileAction: Boolean(requestId && (isUnknown || !taskId)),
        canRefresh: Boolean(taskId && !isUnknown),
        showFollowupInput: Boolean(isWaitingUser && taskId),
        canCancel: Boolean(taskId && !isTerminal && !isCancelled),
        showCancelAction: Boolean(taskId && !isTerminal && !isCancelled),
        runId: typeof task?.runId === 'string' ? task.runId : null,
        runGeneration: Number.isInteger(task?.runGeneration) ? task.runGeneration : null,
        resultVersion: Number.isInteger(task?.resultVersion) ? task.resultVersion : null,
        waitingNotice,
        waitingUserNotice: waitingNotice,
        cancellationNotice,
        rawResultCollapsedDefault: true,
        rawResult: typeof task?.rawResult === 'string' && task.rawResult.length > 0 ? task.rawResult : null,
        summary: typeof task?.summary === 'string' && task.summary.length > 0 ? task.summary : null,
        result: task?.result ?? null,
        sources: authorizedSources,
        artifacts: authorizedArtifacts,
        authorizedSources,
        authorizedArtifacts,
      };
    }

    // §5 管理页与异步任务状态/恢复卡片视图（#246 / #247）
    function pickTaskFields(body, keys) {
      if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
      const picked = {};
      for (const key of keys) {
        if (body[key] !== undefined) picked[key] = body[key];
      }
      return picked;
    }

    function pickTaskResultFields(body) {
      return pickTaskFields(body, ['summary', 'rawResult', 'result', 'sources', 'artifacts', 'runId', 'runGeneration', 'resultVersion', 'waitingUserNotice']);
    }

    function pickTaskReconcileFields(body, prev) {
      const picked = pickTaskFields(body, ['status', 'runId', 'runGeneration', 'resultVersion', 'acceptedAt', 'waitingUserNotice', 'summary', 'rawResult', 'result', 'sources', 'artifacts']);
      // Preserve existing authoritative taskId/requestId; only adopt taskId when previously unknown.
      const taskId = normalizeCardId(body?.taskId);
      if (!normalizeCardId(prev?.taskId) && taskId) picked.taskId = taskId;
      return picked;
    }

    function pickTaskMutationFields(body) {
      return pickTaskFields(body, ['status', 'runId', 'runGeneration', 'resultVersion', 'cancelRequested', 'waitingUserNotice', 'summary']);
    }

    function isStaleGeneration(prev, patch) {
      const prevGen = Number.isInteger(prev?.runGeneration) ? prev.runGeneration : null;
      const nextGen = Number.isInteger(patch?.runGeneration) ? patch.runGeneration : null;
      return prevGen !== null && nextGen !== null && nextGen < prevGen;
    }

    function advancesTaskGeneration(prev, patch) {
      return Number.isInteger(prev?.runGeneration) && Number.isInteger(patch?.runGeneration)
        && patch.runGeneration > prev.runGeneration;
    }

    function sameCardTask(left, right) {
      const leftTaskId = normalizeCardId(left?.taskId);
      const rightTaskId = normalizeCardId(right?.taskId);
      if (leftTaskId && rightTaskId) return leftTaskId === rightTaskId;
      const requestId = normalizeCardId(left?.requestId);
      return Boolean(requestId && requestId === normalizeCardId(right?.requestId));
    }

    function mergeTaskGeneration(prev, patch, { resetPreviousResult = false } = {}) {
      if (isStaleGeneration(prev, patch)) return prev;
      const generationChanged = advancesTaskGeneration(prev, patch);
      const base = { ...(prev ?? {}) };
      if (resetPreviousResult || generationChanged) {
        base.summary = null;
        base.rawResult = null;
        base.result = null;
        base.sources = [];
        base.artifacts = [];
        base.waitingUserNotice = null;
      }
      return { ...base, ...patch };
    }

    const taskReconciledListeners = new Set();
    function notifyTaskReconciled(entry) {
      if (!entry || typeof entry !== 'object') return;
      for (const listener of taskReconciledListeners) {
        try { listener(entry); } catch { /* best effort */ }
      }
    }

    function ExpertTaskStatusCard(props = {}) {
      const initial = props.initialTask ?? props.task ?? null;
      const [task, setTask] = React.useState(initial);
      const initialRef = React.useRef(initial);
      const [rawExpanded, setRawExpanded] = React.useState(false);
      const [followupText, setFollowupText] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState(null);
      const pendingFollowupBackupRef = React.useRef(null);
      const taskRef = React.useRef(initial);
      const operationRef = React.useRef(null);
      const reconcileVersionRef = React.useRef(0);
      const resultAccessDeniedRef = React.useRef(false);
      const switchedTask = initial !== initialRef.current
        && !sameCardTask(initialRef.current, initial)
        && !sameCardTask(taskRef.current, initial);
      const model = deriveTaskCardModel(switchedTask ? initial : task);
      const activeRequestId = model.requestId;
      const showRaw = rawExpanded && !switchedTask;

      // Keep the latest committed card data available to async callbacks before React renders it.
      function updateTask(next) {
        const visible = next && resultAccessDeniedRef.current
          ? mergeTaskGeneration(next, {}, { resetPreviousResult: true })
          : next;
        taskRef.current = visible;
        setTask(visible);
      }

      function beginOperation() {
        if (switchedTask || operationRef.current) return null;
        const operation = {
          task: taskRef.current,
          taskId: model.taskId,
          requestId: model.requestId,
          reconcileVersion: reconcileVersionRef.current,
        };
        operationRef.current = operation;
        setBusy(true);
        setNotice(null);
        return operation;
      }

      function isCurrentOperation(operation) {
        const current = taskRef.current;
        return operationRef.current === operation
          && normalizeCardId(current?.requestId) === operation.requestId
          && (!operation.taskId || normalizeCardId(current?.taskId) === operation.taskId);
      }

      function finishOperation(operation) {
        if (operationRef.current !== operation) return;
        operationRef.current = null;
        setBusy(false);
      }

      function isSupersededRead(operation, patch) {
        const current = taskRef.current;
        return isStaleGeneration(current, patch)
          || (operation.reconcileVersion !== reconcileVersionRef.current && !advancesTaskGeneration(current, patch));
      }

      function clearDeniedResult(response) {
        if (response?.status !== 401 && response?.status !== 403) return false;
        resultAccessDeniedRef.current = true;
        updateTask(taskRef.current);
        setRawExpanded(false);
        setNotice(resultNotice(response));
        return true;
      }

      function applyNotFound(requestId) {
        const backup = pendingFollowupBackupRef.current;
        if (backup?.followupRequestId === requestId) {
          pendingFollowupBackupRef.current = null;
          updateTask(backup.task);
          setNotice('已确认本次追问未被远端受理，已恢复原任务状态与追问草稿，可手动重新发送。');
          return true;
        }

        const current = taskRef.current;
        if (current?.status === 'not_found') return false;
        if (normalizeCardId(current?.taskId) && current.status !== 'unknown' && current.status !== 'pending_delivery') return false;
        updateTask(mergeTaskGeneration(current, { status: 'not_found' }, { resetPreviousResult: true }));
        setRawExpanded(false);
        setNotice(ERROR_NOTICE.EXPERT_TASK_NOT_FOUND);
        return true;
      }

      React.useEffect(() => {
        if (initial === initialRef.current) return;
        initialRef.current = initial;
        if (switchedTask) {
          operationRef.current = null;
          resultAccessDeniedRef.current = false;
          pendingFollowupBackupRef.current = null;
          updateTask(initial);
          setBusy(false);
          setFollowupText('');
          setRawExpanded(false);
          setNotice(null);
        } else if (!pendingFollowupBackupRef.current
          && (taskRef.current?.status !== 'not_found' || (initial?.status !== 'unknown' && initial?.status !== 'pending_delivery'))) {
          updateTask(mergeTaskGeneration(taskRef.current, initial));
        }
      }, [initial]);

      React.useEffect(() => {
        if (!activeRequestId) return undefined;
        const onReconciled = (entry) => {
          const current = taskRef.current;
          if (entry?.requestId !== activeRequestId || normalizeCardId(current?.requestId) !== activeRequestId) return;
          if (entry.notFound === true) {
            if (applyNotFound(activeRequestId)) reconcileVersionRef.current += 1;
            return;
          }
          if (isStaleGeneration(current, entry)) return;
          const patch = pickTaskReconcileFields(entry, current);
          const backup = pendingFollowupBackupRef.current;
          const acceptedFollowup = backup?.followupRequestId === activeRequestId;
          // The Host can announce the same projection in both SSE and the batch reply.
          if (!acceptedFollowup && Object.entries(patch).every(([key, value]) => Object.is(current[key], value))) return;
          reconcileVersionRef.current += 1;
          if (acceptedFollowup) {
            pendingFollowupBackupRef.current = null;
            setFollowupText((curr) => (curr === backup.submittedText ? '' : curr));
          }
          setRawExpanded(false);
          updateTask(mergeTaskGeneration(current, patch));
          setNotice('已按原请求号完成权威状态对账。');
        };
        taskReconciledListeners.add(onReconciled);
        return () => {
          taskReconciledListeners.delete(onReconciled);
        };
      }, [activeRequestId]);

      const handleReconcile = async () => {
        if (!model.canReconcile) return;
        const operation = beginOperation();
        if (!operation) return;
        try {
          const res = await reconcileTaskByRequest(model.requestId);
          if (!isCurrentOperation(operation) || isSupersededRead(operation, res.body)) return;
          if (!res.ok) {
            if (resultCode(res) !== 'EXPERT_TASK_NOT_FOUND' || !applyNotFound(model.requestId)) {
              setNotice(resultNotice(res));
            }
            return;
          }
          const current = taskRef.current;
          const currentTaskId = normalizeCardId(current?.taskId);
          const returnedTaskId = normalizeCardId(res.body?.taskId);
          if (currentTaskId && returnedTaskId && currentTaskId !== returnedTaskId) return;

          if (pendingFollowupBackupRef.current?.followupRequestId === model.requestId) {
            const acceptedText = pendingFollowupBackupRef.current.submittedText;
            pendingFollowupBackupRef.current = null;
            setFollowupText((curr) => (curr === acceptedText ? '' : curr));
          }
          setRawExpanded(false);
          updateTask(mergeTaskGeneration(current, pickTaskReconcileFields(res.body, current)));
          setNotice('已按原请求号完成权威状态对账。');
        } catch {
          if (isCurrentOperation(operation)) setNotice(ERROR_NOTICE.EXPERT_ACCEPTANCE_UNKNOWN);
        } finally {
          finishOperation(operation);
        }
      };

      const handleRefresh = async () => {
        if (!model.canRefresh) return;
        const operation = beginOperation();
        if (!operation) return;
        const targetTaskId = model.taskId;
        try {
          const statusRes = await fetchTaskStatus(targetTaskId);
          if (!isCurrentOperation(operation) || clearDeniedResult(statusRes)) return;
          if (!statusRes.ok) {
            setNotice(resultNotice(statusRes));
            return;
          }
          const statusPatch = pickTaskMutationFields(statusRes.body);
          let finalPatch = statusPatch;
          let resetPreviousResult = false;
          let readAuthorizedResult = false;
          const candidateStatus = statusPatch.status ?? taskRef.current?.status;
          if (candidateStatus === 'completed' || candidateStatus === 'succeeded' || candidateStatus === 'waiting_user') {
            const resultRes = await fetchTaskResult(targetTaskId).catch(() => null);
            if (!isCurrentOperation(operation) || clearDeniedResult(resultRes)) return;
            if (resultRes?.ok && resultRes.body) {
              const statusGen = Number.isInteger(statusPatch.runGeneration) ? statusPatch.runGeneration : null;
              const resultGen = Number.isInteger(resultRes.body.runGeneration) ? resultRes.body.runGeneration : null;
              if (statusGen !== null && resultGen !== null && resultGen !== statusGen) {
                // Generation advanced between /tasks/:id and /tasks/:id/result: re-read authoritative status instead of mixing snapshots.
                const retryStatus = await fetchTaskStatus(targetTaskId).catch(() => null);
                if (!isCurrentOperation(operation) || clearDeniedResult(retryStatus)) return;
                if (retryStatus?.ok && retryStatus.body) {
                  finalPatch = pickTaskMutationFields(retryStatus.body);
                  resetPreviousResult = true;
                } else {
                  setNotice(ERROR_NOTICE.EXPERT_TASK_STATE_CONFLICT);
                  return;
                }
              } else {
                // Only merge allowlisted presentation fields so /result never clobbers authoritative status/taskId.
                finalPatch = { ...statusPatch, ...pickTaskResultFields(resultRes.body) };
                readAuthorizedResult = true;
              }
            }
          }
          if (pendingFollowupBackupRef.current || isSupersededRead(operation, finalPatch)) return;
          const current = taskRef.current;
          if (advancesTaskGeneration(current, finalPatch)) setRawExpanded(false);
          if (readAuthorizedResult) resultAccessDeniedRef.current = false;
          updateTask(mergeTaskGeneration(current, finalPatch, { resetPreviousResult }));
        } catch {
          if (isCurrentOperation(operation)) setNotice(ERROR_NOTICE.EXPERT_DIRECTORY_UNAVAILABLE);
        } finally {
          finishOperation(operation);
        }
      };

      const handleFollowup = async () => {
        if (!model.showFollowupInput || !followupText.trim()) return;
        const operation = beginOperation();
        if (!operation) return;
        const submittedText = followupText;
        const followupRequestId = generateClientRequestId();
        const markFollowupUnknown = (requestId) => {
          pendingFollowupBackupRef.current = { task: operation.task, followupRequestId: requestId, submittedText };
          updateTask({ ...taskRef.current, status: 'unknown', requestId });
        };
        try {
          const res = await postTaskFollowup(model.taskId, { taskText: submittedText, requestId: followupRequestId });
          if (!isCurrentOperation(operation)) return;
          if (!res.ok) {
            if (resultCode(res) === 'EXPERT_ACCEPTANCE_UNKNOWN') {
              const pendingReqId = typeof res?.body?.error?.details?.requestId === 'string' && res.body.error.details.requestId.trim()
                ? res.body.error.details.requestId.trim()
                : followupRequestId;
              markFollowupUnknown(pendingReqId);
            }
            setNotice(resultNotice(res));
            return;
          }
          pendingFollowupBackupRef.current = null;
          setFollowupText((curr) => (curr === submittedText ? '' : curr));
          setRawExpanded(false);
          updateTask(mergeTaskGeneration(taskRef.current, { ...pickTaskMutationFields(res.body), requestId: followupRequestId }, { resetPreviousResult: true }));
        } catch {
          if (!isCurrentOperation(operation)) return;
          markFollowupUnknown(followupRequestId);
          setNotice(ERROR_NOTICE.EXPERT_ACCEPTANCE_UNKNOWN);
        } finally {
          finishOperation(operation);
        }
      };

      const handleCancel = async () => {
        if (!model.canCancel) return;
        const operation = beginOperation();
        if (!operation) return;
        try {
          const res = await postTaskCancel(model.taskId);
          if (!isCurrentOperation(operation)) return;
          if (!res.ok) {
            setNotice(resultNotice(res));
            return;
          }
          const patch = pickTaskMutationFields(res.body);
          updateTask(mergeTaskGeneration(taskRef.current, patch));
          const nextStatus = patch.status ?? taskRef.current?.status;
          if (nextStatus === 'cancelling' || nextStatus === 'cancelled' || patch.cancelRequested === true) {
            setNotice('取消请求已提交；专家已经执行的外部动作不会被自动撤销。');
          } else {
            setNotice('已同步服务端最新任务状态。');
          }
        } catch {
          if (isCurrentOperation(operation)) setNotice(ERROR_NOTICE.EXPERT_REQUEST_FAILED);
        } finally {
          finishOperation(operation);
        }
      };

      return h('div', {
        className: 'fexp-task-card',
        'data-testid': 'fexp-task-card',
        'data-task-status': model.status,
      },
        h('div', { className: 'fexp-task-card-header' },
          h('strong', null, model.expertName),
          h('span', { 'data-testid': 'fexp-task-status-badge' }, model.statusLabel),
        ),
        h('div', { className: 'fexp-task-card-meta' },
          model.taskId ? h('span', null, `任务号：${model.taskId}`) : null,
          model.requestId ? h('span', null, `请求号：${model.requestId}`) : null,
          model.runGeneration !== null ? h('span', null, `代次：g${model.runGeneration}`) : null,
        ),
        model.summary ? h('div', { 'data-testid': 'fexp-task-summary' }, model.summary) : null,
        model.waitingNotice ? h('div', { role: 'status', 'data-testid': 'fexp-task-waiting-notice' }, model.waitingNotice) : null,
        model.cancellationNotice ? h('div', { role: 'status', 'data-testid': 'fexp-task-cancel-notice' }, model.cancellationNotice) : null,
        !switchedTask && notice ? h('div', { role: 'status', 'data-testid': 'fexp-task-notice' }, notice) : null,
        model.result !== null ? h('div', { 'data-testid': 'fexp-task-result' }, typeof model.result === 'string' ? model.result : JSON.stringify(model.result)) : null,
        model.sources.length > 0 ? h('ul', { 'data-testid': 'fexp-task-sources' },
          ...model.sources.map((src, idx) => h('li', { key: src?.id ?? idx }, src?.title ?? src?.uri ?? '已授权来源')),
        ) : null,
        model.artifacts.length > 0 ? h('ul', { 'data-testid': 'fexp-task-artifacts' },
          ...model.artifacts.map((art, idx) => h('li', { key: art?.id ?? idx }, art?.label ?? art?.name ?? art?.id ?? '产物')),
        ) : null,
        model.rawResult ? h('div', { 'data-testid': 'fexp-raw-drawer' },
          h('button', {
            type: 'button',
            'data-testid': 'fexp-raw-toggle',
            'aria-expanded': showRaw,
            onClick: () => setRawExpanded((prev) => !prev),
          }, showRaw ? '收起专家原文' : '展开专家原文'),
          showRaw ? h('pre', { 'data-testid': 'fexp-raw-content' }, model.rawResult) : null,
        ) : null,
        model.showFollowupInput ? h('div', { 'data-testid': 'fexp-followup-box' },
          h('input', { type: 'text', value: switchedTask ? '' : followupText, disabled: busy, placeholder: '输入补充说明…', onChange: (e) => setFollowupText(e.target.value) }),
          h('button', { type: 'button', disabled: busy, 'data-testid': 'fexp-followup-btn', onClick: handleFollowup }, '发送追问'),
        ) : null,
        h('div', { className: 'fexp-task-card-actions' },
          model.canReconcile ? h('button', { type: 'button', disabled: busy, 'data-testid': 'fexp-task-reconcile', onClick: handleReconcile }, '按原请求号对账') : null,
          model.canRefresh ? h('button', { type: 'button', disabled: busy, 'data-testid': 'fexp-task-refresh', onClick: handleRefresh }, '刷新状态') : null,
          model.canCancel ? h('button', { type: 'button', disabled: busy, 'data-testid': 'fexp-task-cancel', onClick: handleCancel }, '请求取消') : null,
        ),
      );
    }

    function ExpertsManagementPanel(props = {}) {
      const dispatchEnabled = props?.dispatchEnabled === true;
      const [view, setView] = React.useState('callable');
      const [query, setQuery] = React.useState('');
      const [state, setState] = React.useState({
        phase: 'loading',
        items: [],
        completeness: 'unknown',
        scopeEpoch: 0,
        viewVersion: 0,
        notice: null,
        savingIds: {},
      });
      const requestSeq = React.useRef(0);

      const load = React.useCallback(async (nextView = view, nextQuery = query) => {
        const seq = ++requestSeq.current;
        setState((prev) => ({ ...prev, phase: prev.items.length ? 'ready' : 'loading', notice: null }));
        try {
          const result = await fetchCatalog({ view: nextView, query: nextQuery });
          if (seq !== requestSeq.current) return;
          if (!result.ok) {
            setState((prev) => ({ ...prev, phase: 'error', items: [], notice: resultNotice(result) }));
            return;
          }
          setState((prev) => ({
            ...prev,
            phase: 'ready',
            items: Array.isArray(result.body?.items) ? result.body.items : [],
            completeness: result.body?.completeness ?? 'unknown',
            scopeEpoch: result.body?.scopeEpoch ?? prev.scopeEpoch,
            viewVersion: result.body?.viewVersion ?? prev.viewVersion,
            notice: result.body?.completeness && result.body.completeness !== 'complete'
              ? '当前目录覆盖范围不完整，展示结果仅反映已返回部分。'
              : null,
          }));
        } catch {
          if (seq !== requestSeq.current) return;
          setState((prev) => ({ ...prev, phase: 'error', notice: ERROR_NOTICE.EXPERT_DIRECTORY_UNAVAILABLE }));
        }
      }, [view, query]);

      // Latest view/query for the stream callback: an SSE frame must refresh the
      // current query without re-subscribing the stream on every keystroke.
      const viewRef = React.useRef(view);
      const queryRef = React.useRef(query);
      viewRef.current = view;
      queryRef.current = query;

      React.useEffect(() => {
        // Typing filters the loaded snapshot immediately (§3.3); the directory
        // query is debounced so one keystroke never becomes one remote read.
        const timer = setTimeout(() => { load(view, query); }, query ? 250 : 0);
        return () => clearTimeout(timer);
      }, [view, query, load]);

      React.useEffect(() => openEventStream((payload) => {
        if (payload.type === 'ready' || payload.type === 'scope-changed' || payload.type === 'catalog-invalidated' || payload.type === 'preference-updated') {
          load(viewRef.current, queryRef.current);
        }
      }), []);

      const toggleExpert = async (item) => {
        const pref = item?.preference;
        if (!item?.access?.callableInOrg || !pref?.editToken || state.savingIds[item.expertId]) return;
        const nextEnabled = !pref.enabled;
        setState((prev) => ({ ...prev, savingIds: { ...prev.savingIds, [item.expertId]: true }, notice: null }));
        try {
          const result = await putPreference(item.expertId, { enabled: nextEnabled, editToken: pref.editToken });
          if (!result.ok) {
            const code = resultCode(result);
            setState((prev) => ({ ...prev, notice: resultNotice(result) }));
            if (code === 'EXPERT_PREF_SAVE_UNKNOWN') {
              // Same edit token: the Host answers saved / not_executed / pending.
              const settled = await reconcilePreference(item.expertId, pref.editToken).catch(() => null);
              const settlement = settled?.body?.settlement;
              if (settlement === 'saved') {
                setState((prev) => ({ ...prev, notice: '服务端已确认保存，已回读最新状态。' }));
              } else if (settlement === 'not_executed') {
                setState((prev) => ({ ...prev, notice: '该次保存未执行，已保持上次确认的启用状态。' }));
              }
            }
            await load(view, query);
            return;
          }
          await load(view, query);
        } catch {
          setState((prev) => ({ ...prev, notice: ERROR_NOTICE.EXPERT_PREF_SAVE_UNKNOWN }));
          await reconcilePreference(item.expertId, pref.editToken).catch(() => {});
          await load(view, query);
        } finally {
          setState((prev) => {
            const next = { ...prev.savingIds };
            delete next[item.expertId];
            return { ...prev, savingIds: next };
          });
        }
      };

      let listBody;
      if (state.phase === 'loading') {
        listBody = h('div', { 'data-testid': 'fexp-loading' }, '正在加载专家目录…');
      } else if (state.items.length === 0) {
        const emptyText = view === 'callable' ? '暂无可调用专家。' : '暂无可见专家。';
        listBody = h('div', { 'data-testid': 'fexp-empty' }, emptyText);
      } else {
        listBody = h('ul', { className: 'fexp-list' },
          ...state.items.map((item) => {
            const row = deriveRowStatus(item);
            const busy = Boolean(state.savingIds[item.expertId]) || row.pending;
            const actionNode = row.callable
              ? h('button', {
                type: 'button',
                disabled: busy || !item.preference?.editToken,
                onClick: () => toggleExpert(item),
              }, formatActionLabel(busy, row.enabled))
              : h('span', null, '仅可查看');
            return h('li', { key: item.expertId, 'data-expert-id': item.expertId },
              h('div', null,
                h('strong', null, item.displayName),
                item.disambiguation ? h('span', null, ` · ${item.disambiguation}`) : null,
                h('span', null, ` (${row.acceptingLabel})`),
              ),
              h('div', null, formatSummaryText(item.summary)),
              actionNode,
            );
          }),
        );
      }

      return h('div', { className: 'forge-experts-ui', 'data-testid': 'forge-experts-panel' },
        h('div', { className: 'fexp-header' },
          h('h2', null, '专家智能体'),
          h('p', { 'data-testid': 'fexp-dispatch-notice' }, dispatchEnabled
            ? '聊天 @ 专家委派已开放，可在此维护个人启用列表；未启用的专家不会出现在聊天 @ 候选中。'
            : '聊天 @ 专家委派尚未开放，当前可在管理页提前维护个人启用列表。'),
        ),
        h('div', { className: 'fexp-toolbar' },
          h('button', { type: 'button', onClick: () => setView('callable'), 'aria-pressed': view === 'callable' }, '可调用'),
          h('button', { type: 'button', onClick: () => setView('directory'), 'aria-pressed': view === 'directory' }, '专家目录'),
          h('input', {
            type: 'search',
            value: query,
            placeholder: '搜索专家名称或职责…',
            'aria-label': '搜索专家',
            onChange: (event) => setQuery(event.target.value),
          }),
        ),
        state.notice ? h('div', { role: 'status', 'data-testid': 'fexp-notice' }, state.notice) : null,
        listBody,
      );
    }

    // §6 出口（管理包默认只注册设置页；隔离预览仅挂载候选组，dispatchEnabled 开放生产 @ 选择绑定与草稿保护）
    function createReconcileTrigger() {
      const RECONCILE_COOLDOWN_MS = 5_000;
      let reconcileInFlight = false;
      let lastReconcileAt = 0;
      let trailingTimer = null;
      let queuedWhileInFlight = false;
      let disposed = false;

      const runNow = () => {
        if (disposed || reconcileInFlight) return;
        reconcileInFlight = true;
        lastReconcileAt = Date.now();
        // 启动/重连后按原 requestId 对账未终态任务，绝不盲目重发（#247）；加在途去重、冷却与合并补跑，失败时重置冷却以允许下次重连重试。
        postReconcilePending().then((res) => {
          if (res && !res.ok) {
            lastReconcileAt = 0;
            if (typeof console !== 'undefined') {
              console.warn('[forge-experts] pending task reconciliation failed:', resultCode(res));
            }
            return;
          }
          if (Array.isArray(res?.body?.reconciled)) {
            for (const entry of res.body.reconciled) {
              notifyTaskReconciled(entry);
            }
          }
          if (Array.isArray(res?.body?.notFound)) {
            for (const requestId of res.body.notFound) {
              if (typeof requestId === 'string' && requestId.trim()) {
                notifyTaskReconciled({ requestId: requestId.trim(), notFound: true });
              }
            }
          }
        }).catch(() => {
          lastReconcileAt = 0;
          if (typeof console !== 'undefined') {
            console.warn('[forge-experts] pending task reconciliation failed');
          }
        }).finally(() => {
          reconcileInFlight = false;
          if (!disposed && queuedWhileInFlight) {
            queuedWhileInFlight = false;
            trigger();
          }
        });
      };

      const trigger = () => {
        if (disposed) return;
        if (reconcileInFlight) {
          queuedWhileInFlight = true;
          return;
        }
        const nowMs = Date.now();
        const elapsed = lastReconcileAt === 0 ? RECONCILE_COOLDOWN_MS : (nowMs - lastReconcileAt);
        if (elapsed < RECONCILE_COOLDOWN_MS) {
          if (!trailingTimer) {
            trailingTimer = setTimeout(() => {
              trailingTimer = null;
              runNow();
            }, RECONCILE_COOLDOWN_MS - elapsed);
          }
          return;
        }
        if (trailingTimer) {
          clearTimeout(trailingTimer);
          trailingTimer = null;
        }
        runNow();
      };

      const dispose = () => {
        disposed = true;
        queuedWhileInFlight = false;
        if (trailingTimer) {
          clearTimeout(trailingTimer);
          trailingTimer = null;
        }
      };

      return { trigger, dispose };
    }

    // 存量任务恢复流（§9.2）：即使停用新委派（dispatchEnabled: false），重连 ready 后仍自动按原 requestId 对账并通知卡片，不开放新委派。
    function mountTaskReconcileStream() {
      const reconciler = createReconcileTrigger();
      const closeStream = openEventStream((payload) => {
        if (payload.type === 'ready') {
          reconciler.trigger();
          return;
        }
        if (payload.type === 'task-reconciled') {
          notifyTaskReconciled(payload);
        }
      });
      return () => {
        closeStream();
        reconciler.dispose();
      };
    }

    function mountMentionsSource(ctx, { enableSelectionBinding }) {
      const triggers = typeof ctx.get === 'function' ? ctx.get('inputTriggers') : ctx.inputTriggers;
      if (!triggers || typeof triggers.registerSource !== 'function') return () => {};

      let unregister = null;
      let generation = 0;
      let activeEpoch = 0;
      let activeVersion = 0;
      const MAX_PENDING_DRAFTS = 32;
      // Hoisted to mountMentionsSource closure so SSE reconnect/invalidation never drops buffered user drafts (#245/#246).
      const pendingDrafts = new Map();
      const pendingRecoveries = [];
      let draftRecoveryListener = null;
      const reconciler = createReconcileTrigger();
      const triggerReconcile = reconciler.trigger;

      const rememberPendingDraft = (sessionKey, draft) => {
        pendingDrafts.delete(sessionKey);
        pendingDrafts.set(sessionKey, draft);
        while (pendingDrafts.size > MAX_PENDING_DRAFTS) {
          const oldest = pendingDrafts.keys().next().value;
          if (oldest === undefined) break;
          pendingDrafts.delete(oldest);
        }
      };

      const dropGroup = () => {
        generation += 1;
        activeEpoch = 0;
        activeVersion = 0;
        if (typeof unregister === 'function') {
          const fn = unregister;
          unregister = null;
          try { fn(); } catch { /* best effort */ }
        }
      };

      const registerGroup = () => {
        if (unregister) return;
        const mountedGen = ++generation;
        const sourceSpec = {
          id: 'forge-experts-mentions',
          trigger: '@',
          label: '专家智能体',
          async query(text, queryCtx) {
            const sessionId = typeof queryCtx?.sessionId === 'string' ? queryCtx.sessionId : '';
            if (!sessionId) return [];
            const result = await fetchMentions({ sessionId, query: typeof text === 'string' ? text : '' });
            if (mountedGen !== generation || !result.ok) return [];
            activeEpoch = result.body?.scopeEpoch ?? activeEpoch;
            activeVersion = result.body?.viewVersion ?? activeVersion;
            const list = Array.isArray(result.body?.candidates) ? result.body.candidates : [];
            const nameCounts = Object.create(null);
            for (const item of list) {
              if (typeof item?.displayName === 'string') {
                nameCounts[item.displayName] = (nameCounts[item.displayName] ?? 0) + 1;
              }
            }
            return list.map((item) => {
              const duplicateName = typeof item?.displayName === 'string' && nameCounts[item.displayName] > 1;
              const suffix = item.disambiguation
                ? item.disambiguation
                : (duplicateName ? (item.responsibility || item.expertId) : '');
              return {
                id: item.expertId,
                label: suffix ? `${item.displayName} · ${suffix}` : item.displayName,
                description: item.responsibility ?? '',
                expertId: item.expertId,
                scopeEpoch: item.scopeEpoch,
                viewVersion: item.viewVersion,
              };
            });
          },
          onPick(picked) {
            if (!picked || picked.scopeEpoch !== activeEpoch || picked.viewVersion !== activeVersion) {
              return { accepted: false, reason: 'EXPERT_SCOPE_MISMATCH' };
            }
            return { accepted: true, expertId: picked.expertId, scopeEpoch: picked.scopeEpoch, viewVersion: picked.viewVersion };
          },
        };

        if (enableSelectionBinding) {
          // 生产 @ 选择绑定：仅在用户显式点选且未失效时向 Host 申请单次 selectionToken；
          // 任何失效、撤权或网络异常均保留草稿并给出明确提示，不静默发送（#245 / #246）。
          sourceSpec.onDraftRecovery = (listener) => {
            draftRecoveryListener = typeof listener === 'function' ? listener : null;
            if (typeof draftRecoveryListener === 'function' && pendingRecoveries.length > 0) {
              for (const event of pendingRecoveries.splice(0)) {
                try { draftRecoveryListener(event); } catch { /* best effort */ }
              }
            }
            return () => {
              if (draftRecoveryListener === listener) draftRecoveryListener = null;
            };
          };
          sourceSpec.prepareSubmit = async ({ picked, sessionId, taskText, draftVersion, reuseRefs = [] } = {}) => {
            const draft = { taskText: typeof taskText === 'string' ? taskText : '', draftVersion: draftVersion ?? null, reuseRefs: Array.isArray(reuseRefs) ? [...reuseRefs] : [] };
            if (!picked || picked.scopeEpoch !== activeEpoch || picked.viewVersion !== activeVersion || !picked.expertId) {
              return {
                ok: false,
                code: 'EXPERT_SELECTION_INVALID',
                preserveDraft: true,
                draft,
                notice: ERROR_NOTICE.EXPERT_SELECTION_INVALID,
              };
            }
            try {
              const result = await postSelectionPrepare({
                expertId: picked.expertId,
                sessionId,
                scopeEpoch: picked.scopeEpoch,
                viewVersion: picked.viewVersion,
                taskText: draft.taskText,
                ...(Number.isInteger(draft.draftVersion) ? { draftVersion: draft.draftVersion } : {}),
                ...(draft.reuseRefs.length > 0 ? { reuseRefs: draft.reuseRefs } : {}),
              });
              if (!result.ok || !result.body?.selectionToken) {
                return {
                  ok: false,
                  code: resultCode(result),
                  preserveDraft: true,
                  draft,
                  notice: resultNotice(result),
                };
              }
              if (typeof sessionId === 'string' && sessionId.trim()) {
                const cleanSession = sessionId.trim();
                const digestKey = typeof result.body.draftDigest === 'string' && result.body.draftDigest.trim()
                  ? `${cleanSession}:${result.body.draftDigest.trim()}`
                  : null;
                if (digestKey) rememberPendingDraft(digestKey, draft);
                rememberPendingDraft(cleanSession, draft);
              }
              return {
                ok: true,
                selectionToken: result.body.selectionToken,
                expertId: result.body.expertId,
                sessionId: result.body.sessionId,
                draftDigest: result.body.draftDigest,
                expiresAt: result.body.expiresAt,
                preserveDraft: false,
              };
            } catch {
              return {
                ok: false,
                code: 'EXPERT_DIRECTORY_UNAVAILABLE',
                preserveDraft: true,
                draft,
                notice: ERROR_NOTICE.EXPERT_DIRECTORY_UNAVAILABLE,
              };
            }
          };
        }

        unregister = triggers.registerSource(sourceSpec);
        return { pendingDrafts, getRecoveryListener: () => draftRecoveryListener };
      };

      let activeHooks = registerGroup();
      const handleTurnFinalized = (payload, { requireBufferedMatch = false } = {}) => {
        const sessionKey = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : '';
        const digest = typeof payload?.draftDigest === 'string' && payload.draftDigest.trim() ? payload.draftDigest.trim() : null;
        const exactKey = sessionKey && digest ? `${sessionKey}:${digest}` : null;
        let recoveredDraft = null;
        if (exactKey) {
          if (pendingDrafts.has(exactKey)) {
            recoveredDraft = pendingDrafts.get(exactKey);
            pendingDrafts.delete(exactKey);
            if (pendingDrafts.get(sessionKey) === recoveredDraft) pendingDrafts.delete(sessionKey);
          }
        } else if (sessionKey && pendingDrafts.has(sessionKey)) {
          recoveredDraft = pendingDrafts.get(sessionKey);
          pendingDrafts.delete(sessionKey);
        }
        if (requireBufferedMatch && !recoveredDraft) return;
        if (payload?.preserveDraft !== true) return;
        const notice = typeof payload.notice === 'string' && payload.notice
          ? payload.notice
          : (ERROR_NOTICE[payload.code] ?? ERROR_NOTICE.EXPERT_SELECTION_INVALID);
        const recoveryEvent = {
          sessionId: sessionKey || null,
          expertId: payload.expertId ?? null,
          status: payload.status ?? 'failed',
          code: payload.code ?? null,
          preserveDraft: true,
          draft: recoveredDraft,
          notice,
        };
        const listener = activeHooks?.getRecoveryListener?.() ?? draftRecoveryListener;
        if (typeof listener === 'function') {
          try { listener(recoveryEvent); } catch { /* best effort */ }
        } else {
          pendingRecoveries.push(recoveryEvent);
          while (pendingRecoveries.length > MAX_PENDING_DRAFTS) pendingRecoveries.shift();
        }
      };

      const closeStream = openEventStream(
        (payload) => {
          if (payload.type === 'ready') {
            activeHooks = registerGroup() ?? activeHooks;
            if (enableSelectionBinding) {
              triggerReconcile();
              if (pendingDrafts.size > 0) {
                fetchRecentFinalizedTurns().then((res) => {
                  if (!res?.ok || !Array.isArray(res.body?.items)) return;
                  for (const item of res.body.items) {
                    handleTurnFinalized(item, { requireBufferedMatch: true });
                  }
                }).catch(() => {});
              }
            }
            return;
          }
          if (payload.type === 'task-reconciled') {
            notifyTaskReconciled(payload);
            return;
          }
          if (payload.type === 'turn-finalized' && enableSelectionBinding) {
            handleTurnFinalized(payload);
            return;
          }
          if (payload.type === 'scope-changed' || payload.type === 'preference-updated' || payload.type === 'mentions-invalidated') {
            dropGroup();
            activeHooks = registerGroup() ?? activeHooks;
          }
        },
        () => {
          // SSE 断开时立即撤下旧专家组，待重连 ready 后恢复，防止过期候选留驻已开菜单。
          dropGroup();
        },
      );

      return () => {
        closeStream();
        reconciler.dispose();
        pendingDrafts.clear();
        pendingRecoveries.length = 0;
        draftRecoveryListener = null;
        dropGroup();
      };
    }

    function mountIsolatedMentionsSource(ctx) {
      return mountMentionsSource(ctx, { enableSelectionBinding: false });
    }

    function mountProductionMentionsSource(ctx) {
      return mountMentionsSource(ctx, { enableSelectionBinding: true });
    }

    return {
      inject: ['slots'],
      deriveTaskCardModel,
      // Compatibility alias retained for existing callers and tests.
      deriveTaskCardState: deriveTaskCardModel,
      ExpertTaskStatusCard,
      apply(ctx, options = {}) {
        const disposers = [];
        if (ctx.slots && typeof ctx.slots.inject === 'function') {
          const dispatchEnabled = options?.dispatchEnabled === true;
          const BoundManagementPanel = (props) => h(ExpertsManagementPanel, { ...(props ?? {}), dispatchEnabled });
          const disposeSection = ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section',
            id: 'forge-experts',
            order: 25,
            label: () => '专家智能体',
          }, BoundManagementPanel));
          if (typeof disposeSection === 'function') disposers.push(disposeSection);

          // 异步任务状态与恢复卡片（#247）：按 §9.2 即使停用新委派也保持存量任务权威回查、对账与取消可用。
          const disposeTaskCard = ctx.slots.inject('chat.taskCard', () => ctx.slots.register({
            name: 'chat.taskCard',
            id: 'forge-experts-task-card',
            order: 25,
            label: () => '专家任务状态',
          }, ExpertTaskStatusCard));
          if (typeof disposeTaskCard === 'function') disposers.push(disposeTaskCard);
        }
        if (options?.isolatedMentionsPreview === true) {
          disposers.push(mountIsolatedMentionsSource(ctx));
        } else if (options?.dispatchEnabled === true) {
          disposers.push(mountProductionMentionsSource(ctx));
        } else {
          disposers.push(mountTaskReconcileStream());
        }
        // Cordis collects cleanup through `ctx.effect`; it never emits a
        // `dispose` event, so registering one leaks every slot subscription.
        ctx.effect?.(() => () => {
          for (const dispose of disposers.splice(0)) {
            try { dispose(); } catch { /* best effort */ }
          }
        });
      },
    };
  },
});
