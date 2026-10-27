/**
 * #25/#26 target-host wiring probe (model-free).
 *
 * Mounted after `@heluo/forge-policy` and `@heluo/forge-devops` in a throwaway
 * patch layer. Provides the `devopsReader` port from two fixed native CLI
 * executables (DOP + gh fixture paths via environment), then dispatches the
 * four read-only model tools through the host's own tool pipeline and checks
 * the policy gate, audit barrier, and host bindings from the tool results.
 *
 * No model call, no network, no profile mutation: the only writes are the
 * JSON report at `DSH_READ_PROBE_OUT` and the fixture call log (if selected).
 */
import { writeFileSync } from 'node:fs';
import { createHostReader } from '../../packages/forge-devops/src/host-readers.mjs';

export const name = 'read-host-probe';
export const inject = ['tools'];

const TARGETS = Object.freeze({
  changeA: 'ARD123456',
  changeB: 'ARD222222',
  repo: `${process.env.DSH_READ_PROBE_HOST ?? 'gitee.corp.example'}/demo/repo`,
});

export function apply(ctx) {
  const out = process.env.DSH_READ_PROBE_OUT;
  const dop = process.env.DSH_READ_PROBE_DOP;
  const gh = process.env.DSH_READ_PROBE_GH;
  const host = process.env.DSH_READ_PROBE_HOST;
  const finish = (report) => {
    if (typeof out === 'string' && out.length > 0) {
      writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { flag: 'w', mode: 0o600 });
    }
  };
  if (!out || !dop || !gh || !host) {
    finish({ probe: 'read-host', ok: false, error: 'probe environment is incomplete' });
    return () => {};
  }

  const main = async () => {
    const startedAt = Date.now();
    const checks = [];
    const step = async (id, run) => {
      try {
        const detail = await run();
        const ok = detail === true || detail?.ok === true;
        // Keep the tool payload (synthetic fixture facts only) for diagnosis.
        const record = detail !== null && typeof detail === 'object' ? detail : { value: detail };
        checks.push({ id, ok, detail: JSON.parse(JSON.stringify(record).slice(0, 2000)) });
      } catch (error) {
        checks.push({ id, ok: false, detail: { threw: String(error?.message ?? error) } });
      }
    };
    try {
      ctx.provide('devopsReader', createHostReader({
        dopOptions: { executable: dop, env: {} },
        ghOptions: { executable: gh, allowedHost: host, env: {} },
      }));
    } catch (error) {
      finish({ probe: 'read-host', ok: false, error: `reader mount failed: ${String(error?.message ?? error)}` });
      return;
    }

    const signal = new AbortController().signal;
    let seq = 0;
    const call = async (toolName, target) => {
      seq += 1;
      const result = await ctx.tools.execute({ callId: `read-probe-${seq}`, name: toolName, arguments: { target }, signal });
      const text = Array.isArray(result?.content)
        ? result.content.map((part) => part?.text ?? '').join(' ')
        : '';
      // The host applies the tool's output.render wrapper, so the business
      // payload may sit one JSON layer inside an outer { content: [...] }.
      const unwrap = (value, depth = 0) => {
        if (depth < 2 && value !== null && typeof value === 'object' && !Array.isArray(value)
          && Array.isArray(value.content) && typeof value.content[0]?.text === 'string') {
          try { return unwrap(JSON.parse(value.content[0].text), depth + 1); } catch { return value; }
        }
        return value;
      };
      let payload;
      try { payload = unwrap(JSON.parse(text)); } catch { payload = { ok: false, unparsed: text.slice(0, 200) }; }
      return { result, payload };
    };

    await step('change-first-has-no-release', async () => {
      const { payload } = await call('forge_devops_change_read', TARGETS.changeA);
      return { ok: payload?.ok === true && payload?.result?.facts?.release === null && payload?.result?.facts?.acceptance?.length === 2, payload };
    });
    await step('change-second-selects-first-non-null-release', async () => {
      const { payload } = await call('forge_devops_change_read', TARGETS.changeB);
      return { ok: payload?.ok === true && payload?.result?.facts?.release?.number === 'R20260620002' };
    });
    await step('repository-read-binds-explicit-host', async () => {
      const { payload } = await call('forge_devops_repository_read', TARGETS.repo);
      return { ok: payload?.ok === true && payload?.result?.facts?.defaultBranch === 'main' && payload?.result?.facts?.provenance?.kind === 'fixture' };
    });
    await step('issue-read-traces-same-repo-closing-pr', async () => {
      const { payload } = await call('forge_devops_issue_read', `${TARGETS.repo}#2`);
      return { ok: payload?.ok === true && JSON.stringify(payload?.result?.facts?.closingPullRequests ?? null) === JSON.stringify([{ number: 3, url: `https://${TARGETS.repo}/pull/3` }]) };
    });
    await step('issue-read-open-has-no-closing-pr', async () => {
      const { payload } = await call('forge_devops_issue_read', `${TARGETS.repo}#4`);
      return { ok: payload?.ok === true && Array.isArray(payload?.result?.facts?.closingPullRequests) && payload.result.facts.closingPullRequests.length === 0 };
    });
    await step('pr-read-requires-revision', async () => {
      const { payload } = await call('forge_devops_pr_read', `${TARGETS.repo}#3`);
      return { ok: payload?.ok === true && /^[a-f0-9]{40}$/.test(payload?.result?.facts?.headRefOid ?? '') };
    });
    await step('cross-host-issue-refused', async () => {
      const { payload } = await call('forge_devops_issue_read', 'github.com/other/repo#2');
      return { ok: payload?.ok === false };
    });
    await step('no-write-tools-visible', async () => {
      const names = ['forge_devops_issue_create', 'forge_devops_pr_merge', 'forge_devops_change_update'];
      const visible = names.filter((toolName) => {
        try { return ctx.tools.get(toolName) !== undefined; } catch { return true; }
      });
      return { ok: visible.length === 0, visible };
    });
    await step('audit-covers-every-read', async () => {
      const policy = typeof ctx.get === 'function' ? ctx.get('policy') : undefined;
      const records = typeof policy?.auditRecords === 'function' ? policy.auditRecords() : [];
      const gaps = typeof policy?.auditGaps === 'function' ? policy.auditGaps() : ['unavailable'];
      return { ok: Array.isArray(records) && records.length >= 7 && Array.isArray(gaps) && gaps.length === 0, records: records.length, gaps };
    });

    finish({ probe: 'read-host', ok: checks.every((check) => check.ok), host, checks, elapsedMs: Date.now() - startedAt });
  };
  main().catch((error) => finish({ probe: 'read-host', ok: false, error: String(error?.message ?? error) }));
  return () => {};
}
