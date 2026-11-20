// OCR PR helper derived from repo-review packages/action.
// This workflow preserves argument boundaries, redacts reports and edits its bot comment in place.

// ../shared/src/report.ts
var SEVERITY_ICON = {
  critical: "\u{1F534}",
  high: "\u{1F7E0}",
  medium: "\u{1F7E1}",
  low: "\u{1F535}"
};
var PR_COMMENT_MAX_BODY = 6e4;
var PR_COMMENT_TAIL_RESERVE = 600;
function clampCommentBody(body, hint) {
  if (body.length <= PR_COMMENT_MAX_BODY) return body;
  return `${body.slice(0, PR_COMMENT_MAX_BODY - 120)}

> \u26A0\uFE0F \u5185\u5BB9\u8D85\u957F\u5DF2\u622A\u65AD\uFF0C${hint}`;
}
function fence(code, lang = "") {
  const marker = code.includes("````") ? "`````" : "````";
  return `${marker}${lang}
${code}
${marker}`;
}
var ACTION_COMMENT_MARKER = "<!-- ocr-pr-review -->";
function buildScanResultCommentMarkdown(result, opts) {
  const out = [ACTION_COMMENT_MARKER, "## \u{1F916} OCR Code Review", ""];
  const status = String(result.status || "unknown");
  const ok = status === "success" || status === "complete";
  out.push(ok ? `\u2705 \`${status}\`` : `\u26A0\uFE0F \`${status}\``);
  if (result.message && !ok) out.push("", `> ${result.message}`);
  if (Array.isArray(result.warnings)) {
    for (const w of result.warnings.slice(0, 5)) out.push(`> \u26A0\uFE0F ${w?.message ?? w}`);
  }
  const seen = /* @__PURE__ */ new Set();
  const comments = (Array.isArray(result.comments) ? result.comments : []).filter((c) => {
    const key = `${c.path}:${c.start_line ?? c.end_line ?? 0}:${c.content}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const s = result.summary || {};
  const model = result.llm?.model ? `\`${result.llm.model}\`` : "-";
  out.push(
    "",
    "| \u8BC4\u5BA1\u6587\u4EF6 | \u53D1\u73B0\u95EE\u9898 | Token \u6D88\u8017 | \u8017\u65F6 | \u6A21\u578B |",
    "|---:|---:|---:|---:|---|",
    `| ${s.files_reviewed ?? "-"} | ${comments.length} | ${s.total_tokens ?? "-"} | ${s.elapsed ?? "-"} | ${model} |`
  );
  const repo = opts.repo;
  const sha = opts.headSha;
  const fileLink = (c) => {
    const seg = encodeURI(String(c.path ?? ""));
    let anchor = "";
    if (c.start_line && c.end_line && c.start_line !== c.end_line) anchor = `#L${c.start_line}-L${c.end_line}`;
    else if (c.start_line) anchor = `#L${c.start_line}`;
    const label = c.start_line ? `${c.path}:${c.start_line}` : String(c.path ?? "");
    return `[\`${label}\`](https://github.com/${repo}/blob/${sha}/${seg}${anchor})`;
  };
  const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
  const sorted = [...comments].sort(
    (a, b) => (SEV_ORDER[a.severity ?? ""] ?? 9) - (SEV_ORDER[b.severity ?? ""] ?? 9) || String(a.path).localeCompare(String(b.path))
  );
  const findingBlock = (c) => {
    const sev = SEV_ORDER[c.severity ?? ""] !== void 0 ? c.severity : "info";
    const icon = SEVERITY_ICON[sev] ?? "\u26AA";
    const lines = ["", `### ${icon} ${String(sev).toUpperCase()} \xB7 ${fileLink(c)}`, "", String(c.content || "").trim()];
    if (c.category) lines.push("", `\`category: ${c.category}\``);
    if (c.suggestion_code) {
      lines.push("", fence(
        String(c.suggestion_code).split("\n").map((l) => `+ ${l}`).join("\n"),
        "diff"
      ));
    }
    return lines.join("\n");
  };
  let body = out.join("\n");
  let shown = 0;
  for (const c of sorted) {
    const next = body + "\n" + findingBlock(c);
    if (next.length > PR_COMMENT_MAX_BODY - PR_COMMENT_TAIL_RESERVE) break;
    body = next;
    shown++;
  }
  const omitted = sorted.length - shown;
  if (sorted.length === 0) {
    if (ok) body += "\n\n\u2705 \u672A\u53D1\u73B0\u95EE\u9898\u3002";
  } else if (shown === 0) {
    body += "\n\n> \u26A0\uFE0F \u5355\u6761\u53D1\u73B0\u5373\u8D85\u51FA\u8BC4\u8BBA\u957F\u5EA6\u9650\u5236\uFF0C\u8BF7\u4E0B\u8F7D artifact `result.json` \u67E5\u770B\u5B8C\u6574\u62A5\u544A\u3002";
  }
  if (omitted > 0) {
    body += `

> \u{1F4C4} \u8FD8\u6709 ${omitted} \u6761\u53D1\u73B0\u672A\u5C55\u793A\uFF08\u8BC4\u8BBA\u957F\u5EA6\u9650\u5236\uFF09\uFF0C\u5B8C\u6574\u7ED3\u679C\u8BF7\u4E0B\u8F7D artifact \`result.json\`\u3002`;
  }
  if (result.project_summary) {
    body += `

<details>
<summary>\u{1F4CA} \u9879\u76EE\u7EA7\u603B\u7ED3</summary>

${String(result.project_summary).trim()}

</details>`;
  }
  const runLink = opts.runUrl ? `[run \u65E5\u5FD7](${opts.runUrl}) \xB7 ` : "";
  const ver = opts.ocrVersion ? ` v${opts.ocrVersion}` : "";
  body += `

---
\u{1F916} open-code-review${ver} \xB7 ${runLink}\u5B8C\u6574 JSON \u62A5\u544A\u89C1\u672C\u6B21 run \u7684 artifact`;
  return clampCommentBody(body, "\u5B8C\u6574\u7ED3\u679C\u8BF7\u4E0B\u8F7D artifact `result.json`\u3002");
}

// ../shared/src/excludes.ts
var DEFAULT_EXCLUDE_PATTERNS = [
  // 隐藏文件与目录（ocr 非 git 遍历只排 .env 等密钥路径，.config/、.github/、.eslintrc 等会进评审集）
  "**/.*",
  "**/.*/**",
  // 测试目录与 fixture（含端到端）
  "**/tests/**",
  "**/test/**",
  "**/spec/**",
  "**/specs/**",
  "**/testdata/**",
  "**/fixtures/**",
  "**/__mocks__/**",
  "**/conftest.py",
  "**/e2e/**",
  "**/cypress/**",
  "**/testing/**",
  // 文档目录（.md 已被 ocr 原生排除，这里补目录下的代码文件）
  "**/docs/**",
  "**/doc/**",
  // 示例 / 演示
  "**/examples/**",
  "**/example/**",
  "**/demos/**",
  "**/demo/**",
  "**/samples/**",
  // 第三方代码
  "**/third_party/**",
  // 脚本与基准
  "**/scripts/**",
  "**/benchmarks/**",
  "**/benchmark/**",
  "**/benches/**"
];
var DEFAULT_EXCLUDES = DEFAULT_EXCLUDE_PATTERNS.join(",");

// src/args.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
var EXCLUDES_DEFAULT_SENTINEL = "__DEFAULT__";
function excludeAndRuleArgs() {
  const args = [];
  const excludes = process.env.OCR_EXCLUDES ?? EXCLUDES_DEFAULT_SENTINEL;
  if (excludes === EXCLUDES_DEFAULT_SENTINEL) args.push("--exclude", DEFAULT_EXCLUDES);
  else if (excludes && excludes !== "__NONE__") args.push("--exclude", excludes);
  const ruleFile = process.env.OCR_RULE_FILE;
  if (ruleFile) args.push("--rule", ruleFile);
  return args;
}
function reviewOnlyArgs() {
  const args = [];
  if ((process.env.OCR_NO_PLAN ?? "1") === "1") args.push("--effort", "low");
  const budget = Number(process.env.OCR_MAX_TOKENS_BUDGET ?? 2e6);
  if (Number.isFinite(budget) && budget > 0) args.push("--max-tokens-budget", String(budget));
  return args;
}
function writeLanguageConfig() {
  const language = process.env.OCR_OUTPUT_LANGUAGE ?? "\u4E2D\u6587";
  if (!language) return;
  const dir = path.join(homedir(), ".opencodereview");
  const file = path.join(dir, "config.json");
  let existing = { llm: {} };
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      existing = typeof parsed === "object" && parsed !== null ? parsed : { llm: {} };
    } catch {
    }
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify({ ...existing, llm: existing.llm ?? {}, language }, null, 2), "utf8");
}
function buildArgs(mode) {
  if (mode === "preview") return excludeAndRuleArgs();
  return [...excludeAndRuleArgs(), ...reviewOnlyArgs()];
}

function sanitizeReport(input, output) {
  const secretValues = [process.env.OCR_LLM_TOKEN, process.env.OCR_LLM_URL].filter(Boolean);
  let report;
  try {
    report = JSON.parse(readFileSync(input, "utf8"));
  } catch {
    throw new Error("Unable to read the OCR JSON report");
  }
  const redact = (_key, value) => typeof value === "string"
    ? secretValues.reduce((text, secret) => text.replaceAll(secret, "[redacted]"), value)
    : value;
  writeFileSync(output, `${JSON.stringify(report, redact, 2)}\n`, "utf8");
}

// src/comment.ts
import { readFileSync as readFileSync2 } from "node:fs";
var GITHUB_API = "https://api.github.com";
function buildFailureComment(runUrl) {
  const link = runUrl ? `\u8BF7\u67E5\u770B [run \u65E5\u5FD7](${runUrl})\u3002` : "\u8BF7\u67E5\u770B run \u65E5\u5FD7\u3002";
  return [ACTION_COMMENT_MARKER, "## \u{1F916} OCR Code Review", "", `\u274C \u8BC4\u5BA1\u5931\u8D25\uFF0C\u672A\u4EA7\u51FA\u7ED3\u679C\u6587\u4EF6\u3002${link}`].join("\n");
}
function buildRenderFailureComment(result) {
  const status = String(result.status || "unknown");
  const message = result.message ? `

> ${result.message}` : "";
  return [
    ACTION_COMMENT_MARKER,
    "## \u{1F916} OCR Code Review",
    "",
    `\u26A0\uFE0F \u8BC4\u5BA1\u7ED3\u679C\u6E32\u67D3\u5931\u8D25\uFF08\u539F\u59CB status \`${status}\`\uFF09\uFF0C\u5B8C\u6574\u7ED3\u679C\u8BF7\u4E0B\u8F7D artifact \`result.json\`\u3002${message}`
  ].join("\n");
}
function errText(err) {
  return err instanceof Error ? err.message : String(err);
}
async function ghApi(pathname, init, token) {
  const res = await fetch(`${GITHUB_API}${pathname}`, {
    ...init,
    signal: AbortSignal.timeout(15000),
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "repo-review-action",
      ...init.headers ?? {}
    }
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 500);
    throw new Error(`GitHub API ${res.status} ${pathname}: ${text}`);
  }
  if (res.status === 204) return null;
  return res.json();
}
async function upsertComment(opts) {
  let body;
  try {
    const result = JSON.parse(readFileSync2(opts.resultPath, "utf8"));
    try {
      body = buildScanResultCommentMarkdown(result, {
        repo: opts.repo,
        headSha: opts.headSha,
        runUrl: opts.runUrl,
        ocrVersion: opts.ocrVersion
      });
    } catch (err) {
      process.stderr.write(`\u6E32\u67D3\u8BC4\u5BA1\u7ED3\u679C\u5931\u8D25\uFF1A${errText(err)}
`);
      body = buildRenderFailureComment(result);
    }
  } catch (err) {
    process.stderr.write(`\u8BFB\u53D6\u8BC4\u5BA1\u7ED3\u679C\u5931\u8D25\uFF1A${errText(err)}
`);
    body = buildFailureComment(opts.runUrl);
  }
  if (opts.dryRun) {
    process.stdout.write(`${body}
`);
    return "(dry-run)";
  }
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error("\u7F3A\u5C11 GH_TOKEN \u73AF\u5883\u53D8\u91CF\uFF08\u8BC4\u8BBA\u56DE\u5199\u9700\u8981\uFF09");
  const prPath = `/repos/${opts.repo}/pulls/${opts.pr}`;
  const commentsPath = `/repos/${opts.repo}/issues/${opts.pr}/comments`;
  let existing;
  for (let page = 1; page <= 20; page++) {
    const comments = await ghApi(`${commentsPath}?per_page=100&page=${page}`, {}, token);
    existing = comments.find(
      (comment) => comment.user?.login === "github-actions[bot]" && comment.body?.startsWith(`${ACTION_COMMENT_MARKER}\n`)
    );
    if (existing || comments.length < 100) break;
  }
  const pr = await ghApi(prPath, {}, token);
  if (pr.state !== "open" || pr.head?.sha !== opts.headSha) return undefined;

  const path = existing ? `/repos/${opts.repo}/issues/comments/${existing.id}` : commentsPath;
  const saved = await ghApi(path, { method: existing ? "PATCH" : "POST", body: JSON.stringify({ body }) }, token);
  return saved.html_url ?? "";
}
var PREVIEW_STATUS_LABEL = {
  added: "\u65B0\u589E",
  modified: "\u4FEE\u6539",
  deleted: "\u5220\u9664",
  renamed: "\u91CD\u547D\u540D",
  binary: "\u4E8C\u8FDB\u5236"
};
function previewSummary(resultPath) {
  let p;
  try {
    p = JSON.parse(readFileSync2(resultPath, "utf8"));
  } catch (err) {
    return `> \u26A0\uFE0F preview \u7ED3\u679C\u89E3\u6790\u5931\u8D25\uFF1A${err instanceof Error ? err.message : String(err)}`;
  }
  const ins = p.total_insertions ?? 0;
  const del = p.total_deletions ?? 0;
  let line = `**OCR preview**\uFF1A\u5171 ${p.total_files ?? "-"} \u4E2A\u6587\u4EF6\uFF0C\u53EF\u8BC4\u5BA1 ${p.reviewable_count ?? "-"}\uFF08\u6392\u9664 ${p.excluded_count ?? 0}\uFF09\uFF0C\u6539\u52A8 +${ins}/-${del} \u884C`;
  if (Array.isArray(p.files) && p.files.length > 0) {
    const counts = /* @__PURE__ */ new Map();
    for (const f of p.files) {
      if (!f.status) continue;
      counts.set(f.status, (counts.get(f.status) ?? 0) + 1);
    }
    const parts = [...counts.entries()].map(([st, n]) => `${PREVIEW_STATUS_LABEL[st] ?? st} ${n}`).join(" \xB7 ");
    if (parts) line += `\uFF08${parts}\uFF09`;
  }
  return line;
}

// src/cli.ts
var USAGE = `\u7528\u6CD5\uFF1A
  ocr-pr.mjs args [--mode review|preview] [--null]
  ocr-pr.mjs preview-summary <result.json>
  ocr-pr.mjs sanitize-report <raw.json> <result.json>
  ocr-pr.mjs comment --result <result.json> --repo <owner/repo> --pr <n> --sha <headSha> [--run-url <url>] [--ocr-version <v>] [--dry-run]
\u73AF\u5883\u53D8\u91CF\uFF1AOCR_NO_PLAN / OCR_MAX_TOKENS_BUDGET / OCR_EXCLUDES / OCR_RULE_FILE / OCR_OUTPUT_LANGUAGE / GH_TOKEN`;
function parseFlag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : void 0;
}
async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "args") {
    const mode = parseFlag(rest, "--mode") ?? "review";
    if (mode !== "review" && mode !== "preview") throw new Error(`--mode \u4EC5\u652F\u6301 review|preview\uFF0C\u6536\u5230 ${mode}`);
    writeLanguageConfig();
    const args = buildArgs(mode);
    if (rest.includes("--null")) {
      for (const arg of args) process.stdout.write(`${arg}\0`);
      return;
    }
    process.stdout.write(`${args.join(" ")}
`);
    return;
  }
  if (cmd === "sanitize-report") {
    const [input, output] = rest;
    if (!input || !output) throw new Error(USAGE);
    sanitizeReport(input, output);
    return;
  }
  if (cmd === "preview-summary") {
    const file = rest[0];
    if (!file) throw new Error("preview-summary \u9700\u8981 result.json \u8DEF\u5F84\u53C2\u6570");
    process.stdout.write(`${previewSummary(file)}
`);
    return;
  }
  if (cmd === "comment") {
    const resultPath = parseFlag(rest, "--result");
    const repo = parseFlag(rest, "--repo");
    const pr = Number(parseFlag(rest, "--pr"));
    const sha = parseFlag(rest, "--sha");
    if (!resultPath || !repo || !pr || !sha) throw new Error(`comment \u53C2\u6570\u4E0D\u5168
${USAGE}`);
    const url = await upsertComment({
      resultPath,
      repo,
      pr,
      headSha: sha,
      runUrl: parseFlag(rest, "--run-url"),
      ocrVersion: parseFlag(rest, "--ocr-version"),
      dryRun: rest.includes("--dry-run")
    });
    if (url === undefined) {
      process.stdout.write("PR 已更新或关闭，跳过评论。\n");
      return;
    }
    process.stdout.write(`\u8BC4\u8BBA\u5DF2\u53D1\u5E03\uFF1A${url || "(\u672A\u8FD4\u56DE\u94FE\u63A5)"}
`);
    return;
  }
  throw new Error(`\u672A\u77E5\u5B50\u547D\u4EE4\uFF1A${cmd ?? "(\u7A7A)"}
${USAGE}`);
}
main().catch((err) => {
  process.stderr.write(`\u2717 ${err instanceof Error ? err.message : String(err)}
`);
  process.exit(1);
});
